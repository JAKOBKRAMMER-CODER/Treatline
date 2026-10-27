const initials = n => n.split(' ').map(p=>p[0]).join('').slice(0,2).toUpperCase();
const escapeHtml = str => { const d = document.createElement('div'); d.textContent = str; return d.innerHTML; };
const fmtTime = iso => new Date(iso).toLocaleTimeString([], { hour:'numeric', minute:'2-digit' });

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let me = null; // { id, username, email }
let conversations = [];
let activeConvoId = null;
let activeIsGroup = false;
let activeMembers = []; // [{id, username}] for the open conversation
let readTimes = new Map(); // user_id -> last_read_at (ms) for members of the open conversation
let onlineUsers = new Set();
let typingSendThrottle = 0;

let messageChannel, reactionChannel, presenceChannel, typingChannel, memberChannel, signalChannel;

let recorder = null;
let recordedChunks = [];
let recordingStart = 0;
let recordingTimer = null;

// ---------- Auth screen wiring ----------

document.querySelectorAll('.tab-btn').forEach(btn=>{
  btn.addEventListener('click', ()=>{
    document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    document.getElementById('login-form').classList.toggle('hidden', tab!=='login');
    document.getElementById('signup-form').classList.toggle('hidden', tab!=='signup');
  });
});

document.getElementById('login-form').addEventListener('submit', async e=>{
  e.preventDefault();
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-password').value;
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';

  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) { errEl.textContent = translateError(error.message); return; }
  await afterLogin(data.user);
});

document.getElementById('signup-form').addEventListener('submit', async e=>{
  e.preventDefault();
  const username = document.getElementById('signup-username').value.trim();
  const email = document.getElementById('signup-email').value.trim();
  const password = document.getElementById('signup-password').value;
  const errEl = document.getElementById('signup-error');
  errEl.textContent = '';

  if (username.length < 2) { errEl.textContent = 'Username must be at least 2 characters'; return; }

  const { data, error } = await sb.auth.signUp({ email, password });
  if (error) { errEl.textContent = translateError(error.message); return; }

  if (!data.user) {
    errEl.textContent = 'Check your email to confirm your account, then log in.';
    return;
  }

  const { error: profileError } = await sb.from('profiles').insert({
    id: data.user.id, username
  });
  if (profileError) {
    errEl.textContent = profileError.message.includes('duplicate')
      ? 'That username is already taken'
      : profileError.message;
    return;
  }

  await afterLogin(data.user, username);
});

document.getElementById('logout-btn').addEventListener('click', async ()=>{
  await setPresence(false);
  [messageChannel, reactionChannel, presenceChannel, typingChannel, memberChannel, signalChannel].forEach(c=> c && sb.removeChannel(c));
  await sb.auth.signOut();
  location.reload();
});

function translateError(msg) {
  if (msg.includes('Invalid login credentials')) return 'Wrong email or password';
  if (msg.includes('already registered')) return 'That email is already registered';
  if (msg.includes('Password should be')) return 'Password must be at least 6 characters';
  return msg;
}

// ---------- Bootstrap ----------

async function tryResume() {
  const { data: { session } } = await sb.auth.getSession();
  if (session?.user) {
    await afterLogin(session.user);
  } else {
    document.getElementById('auth-screen').classList.remove('hidden');
  }
}

async function afterLogin(user, knownUsername) {
  let username = knownUsername;
  if (!username) {
    const { data: profile } = await sb.from('profiles').select('username').eq('id', user.id).single();
    username = profile?.username || user.email;
  }
  me = { id: user.id, username, email: user.email };

  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('me-username').textContent = '@' + me.username;

  await setPresence(true);
  window.addEventListener('beforeunload', ()=> setPresence(false));

  subscribeRealtime();
  loadConversations();
  onLoggedInHome();
  initNotifications();
  maybeShowNotificationPrompt();
  loadBackgrounds();

  const params = new URLSearchParams(location.search);
  const inviteCode = params.get('invite');
  if (inviteCode) await joinViaInvite(inviteCode);
}

function maybeShowNotificationPrompt() {
  if (!('Notification' in window)) return;
  if (Notification.permission !== 'default') return; // already decided, don't ask again
  const banner = document.getElementById('notification-prompt');
  banner.classList.remove('hidden');
}

// ---------- Presence ----------

async function setPresence(online) {
  if (!me) return;
  await sb.from('presence').upsert({ user_id: me.id, online, last_seen: new Date().toISOString() });
}

setInterval(()=>{ if (me) setPresence(true); }, 25000); // heartbeat

// ---------- Realtime subscriptions ----------

function subscribeRealtime() {
  messageChannel = sb.channel('messages-listen')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, p => handleIncomingMessage(p.new))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages' }, p => handleUpdatedMessage(p.new))
    .subscribe();

  reactionChannel = sb.channel('reactions-listen')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'message_reactions' }, () => {
      if (activeConvoId) refreshReactionsForActiveConvo();
    })
    .subscribe();

  presenceChannel = sb.channel('presence-listen')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'presence' }, p => {
      const row = p.new;
      if (!row) return;
      if (row.online) onlineUsers.add(row.user_id); else onlineUsers.delete(row.user_id);
      renderConversations();
      updateChatHeadStatus();
    })
    .subscribe();

  typingChannel = sb.channel('typing-listen')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'typing_status' }, () => {
      if (activeConvoId) refreshTypingIndicator();
    })
    .subscribe();

  memberChannel = sb.channel('members-listen')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'conversation_members' }, p => {
      if (p.new.user_id === me.id) loadConversations();
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'conversation_members' }, p => {
      const row = p.new;
      if (!row || row.conversation_id !== activeConvoId) return;
      readTimes.set(row.user_id, row.last_read_at ? new Date(row.last_read_at).getTime() : 0);
      updateAllTicks();
    })
    .subscribe();

  signalChannel = sb.channel('call-signals-listen')
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'call_signals', filter: `to_user=eq.${me.id}` },
      p => onCallSignalRow(p.new))
    .subscribe();
  cleanupOldCallSignals();

  sb.from('presence').select('user_id, online').eq('online', true).then(({ data })=>{
    (data||[]).forEach(r => onlineUsers.add(r.user_id));
    renderConversations();
  });
}

function handleIncomingMessage(msg) {
  if (msg.conversation_id === activeConvoId) {
    appendBubble(msg);
    scrollToBottom();
    if (msg.sender_id !== me.id) markRead(msg.conversation_id);
  }

  if (msg.sender_id !== me.id) {
    const convo = conversations.find(c => c.conversation_id === msg.conversation_id);
    maybeNotify(msg, convo ? convo.title : null);
  }

  loadConversations();
}

function handleUpdatedMessage(msg) {
  const el = document.querySelector(`[data-msg-id="${msg.id}"]`);
  if (el) fillBubble(el, msg);
  if (msg.conversation_id === activeConvoId) loadConversations();
}

// ---------- Conversations list ----------

async function loadConversations() {
  const { data: memberRows } = await sb
    .from('conversation_members').select('conversation_id').eq('user_id', me.id);

  const convoIds = (memberRows || []).map(r => r.conversation_id);
  if (convoIds.length === 0) { conversations = []; renderConversations(); return; }

  const { data: convos } = await sb
    .from('conversations').select('id, is_group, group_name, user_a, user_b, created_by')
    .in('id', convoIds);

  const enriched = await Promise.all((convos||[]).map(async c=>{
    let title, avatarLabel, otherId = null;

    if (c.is_group) {
      title = c.group_name || 'Group chat';
      avatarLabel = '👥';
    } else {
      otherId = c.user_a === me.id ? c.user_b : c.user_a;
      const { data: profile } = await sb.from('profiles').select('username').eq('id', otherId).single();
      title = profile?.username || '(unknown)';
      avatarLabel = initials(title);
    }

    const { data: lastMsgs } = await sb
      .from('messages').select('text, created_at, attachment_type, deleted')
      .eq('conversation_id', c.id).order('created_at', { ascending:false }).limit(1);
    const { count: unread } = await sb
      .from('messages').select('id', { count:'exact', head:true })
      .eq('conversation_id', c.id).eq('read', false).neq('sender_id', me.id);

    const last = lastMsgs?.[0];
    let preview = 'Say hello';
    if (last) {
      if (last.deleted) preview = 'Message deleted';
      else if (last.attachment_type === 'image') preview = '📷 Photo';
      else if (last.attachment_type === 'voice') preview = '🎤 Voice message';
      else if (last.attachment_type === 'file') preview = '📎 File';
      else preview = last.text;
    }

    return {
      conversation_id: c.id,
      is_group: c.is_group,
      title, avatarLabel, other_id: otherId,
      last_text: preview,
      last_at: last?.created_at || null,
      unread: unread || 0,
    };
  }));

  enriched.sort((a,b)=> new Date(b.last_at||0) - new Date(a.last_at||0));
  conversations = enriched;
  renderConversations();
}

function renderConversations() {
  const el = document.getElementById('contacts');
  el.innerHTML = '';
  conversations.forEach(c=>{
    const div = document.createElement('div');
    div.className = 'contact' + (c.conversation_id === activeConvoId ? ' active' : '');
    const online = !c.is_group && onlineUsers.has(c.other_id);
    div.innerHTML = `
      <div class="avatar">${c.avatarLabel}${!c.is_group ? `<span class="presence ${online?'online':''}"></span>` : ''}</div>
      <div class="contact-meta">
        <div class="contact-name">${escapeHtml(c.title)}</div>
        <div class="contact-preview">${escapeHtml(c.last_text)}</div>
      </div>
      ${c.unread > 0 ? `<div class="unread-badge">${c.unread}</div>` : `<div class="contact-time">${c.last_at ? fmtTime(c.last_at) : ''}</div>`}
    `;
    div.addEventListener('click', ()=> openConversation(c.conversation_id, c.is_group, c.other_id, c.title));
    el.appendChild(div);
  });
}

// ---------- User search / start new 1:1 chat ----------

const searchInput = document.getElementById('user-search');
let searchDebounce = null;
searchInput.addEventListener('input', ()=>{
  clearTimeout(searchDebounce);
  const q = searchInput.value.trim();
  const resultsEl = document.getElementById('user-results');
  if (!q) { resultsEl.innerHTML = ''; return; }
  searchDebounce = setTimeout(async ()=>{
    const { data: users } = await sb
      .from('profiles').select('id, username')
      .ilike('username', `%${q}%`).neq('id', me.id).limit(20);
    resultsEl.innerHTML = '';
    (users || []).forEach(u=>{
      const div = document.createElement('div');
      div.className = 'user-result';
      div.innerHTML = `<div class="avatar" style="width:26px;height:26px;font-size:11px;">${initials(u.username)}</div>@${escapeHtml(u.username)}`;
      div.addEventListener('click', async ()=>{
        const convoId = await startOrFindConversation(u.id);
        searchInput.value = '';
        resultsEl.innerHTML = '';
        await loadConversations();
        openConversation(convoId, false, u.id, u.username);
      });
      resultsEl.appendChild(div);
    });
  }, 250);
});

document.addEventListener('click', e=>{
  if (!document.getElementById('new-chat-box').contains(e.target)) {
    document.getElementById('user-results').innerHTML = '';
  }
});

async function startOrFindConversation(otherId) {
  const [a, b] = me.id < otherId ? [me.id, otherId] : [otherId, me.id];

  const { data: existing } = await sb
    .from('conversations').select('id')
    .eq('user_a', a).eq('user_b', b).maybeSingle();

  if (existing) return existing.id;

  const { data: created, error } = await sb
    .from('conversations').insert({ user_a: a, user_b: b, created_by: me.id }).select('id').single();

  let convoId;
  if (error) {
    const { data: retry } = await sb
      .from('conversations').select('id').eq('user_a', a).eq('user_b', b).single();
    convoId = retry.id;
  } else {
    convoId = created.id;
  }

  await sb.from('conversation_members').insert([
    { conversation_id: convoId, user_id: a },
    { conversation_id: convoId, user_id: b },
  ]);

  return convoId;
}

// ---------- Group creation ----------

const newGroupBtn = document.getElementById('new-group-btn');
const groupPanel = document.getElementById('new-group-panel');
const groupNameInput = document.getElementById('group-name-input');
const groupMemberSearch = document.getElementById('group-member-search');
const groupMemberResults = document.getElementById('group-member-results');
const groupSelectedList = document.getElementById('group-selected-members');
const createGroupBtn = document.getElementById('create-group-btn');
let groupSelectedUsers = [];

newGroupBtn.addEventListener('click', ()=>{
  groupPanel.classList.remove('hidden');
  groupNameInput.value = '';
  groupMemberSearch.value = '';
  groupSelectedUsers = [];
  renderGroupSelected();
  groupNameInput.focus();
});
document.getElementById('close-new-group').addEventListener('click', ()=> groupPanel.classList.add('hidden'));

let groupSearchDebounce = null;
groupMemberSearch.addEventListener('input', ()=>{
  clearTimeout(groupSearchDebounce);
  const q = groupMemberSearch.value.trim();
  if (!q) { groupMemberResults.innerHTML = ''; return; }
  groupSearchDebounce = setTimeout(async ()=>{
    const { data: users } = await sb
      .from('profiles').select('id, username')
      .ilike('username', `%${q}%`).neq('id', me.id).limit(15);
    groupMemberResults.innerHTML = '';
    (users||[]).filter(u=> !groupSelectedUsers.some(s=>s.id===u.id)).forEach(u=>{
      const div = document.createElement('div');
      div.className = 'user-result';
      div.innerHTML = `<div class="avatar" style="width:26px;height:26px;font-size:11px;">${initials(u.username)}</div>@${escapeHtml(u.username)}`;
      div.addEventListener('click', ()=>{
        groupSelectedUsers.push(u);
        renderGroupSelected();
        groupMemberSearch.value = '';
        groupMemberResults.innerHTML = '';
      });
      groupMemberResults.appendChild(div);
    });
  }, 250);
});

function renderGroupSelected() {
  groupSelectedList.innerHTML = '';
  groupSelectedUsers.forEach(u=>{
    const chip = document.createElement('span');
    chip.className = 'member-chip';
    chip.innerHTML = `@${escapeHtml(u.username)} <button aria-label="Remove">×</button>`;
    chip.querySelector('button').addEventListener('click', ()=>{
      groupSelectedUsers = groupSelectedUsers.filter(x=>x.id!==u.id);
      renderGroupSelected();
    });
    groupSelectedList.appendChild(chip);
  });
}

createGroupBtn.addEventListener('click', async ()=>{
  const name = groupNameInput.value.trim();
  if (!name) { groupNameInput.focus(); return; }
  if (groupSelectedUsers.length === 0) { groupMemberSearch.focus(); return; }

  const { data: convo, error } = await sb
    .from('conversations')
    .insert({ is_group: true, group_name: name, created_by: me.id })
    .select('id').single();

  if (error) { alert('Could not create group: ' + error.message); return; }

  const members = [me.id, ...groupSelectedUsers.map(u=>u.id)];
  await sb.from('conversation_members').insert(
    members.map(uid => ({ conversation_id: convo.id, user_id: uid }))
  );

  groupPanel.classList.add('hidden');
  await loadConversations();
  openConversation(convo.id, true, null, name);
});

// ---------- Invite links ----------

async function generateInviteLink() {
  const { data, error } = await sb
    .from('group_invites')
    .insert({ conversation_id: activeConvoId, created_by: me.id })
    .select('code').single();
  if (error) { alert('Could not create invite: ' + error.message); return; }
  const link = `${location.origin}${location.pathname}?invite=${data.code}`;
  await navigator.clipboard.writeText(link).catch(()=>{});
  alert('Invite link copied to clipboard:\n' + link);
}

async function joinViaInvite(code) {
  const { data: invite } = await sb.from('group_invites').select('conversation_id').eq('code', code).single();
  if (!invite) { alert('This invite link is invalid or expired.'); return; }

  await sb.from('conversation_members')
    .upsert({ conversation_id: invite.conversation_id, user_id: me.id }, { onConflict: 'conversation_id,user_id' });

  history.replaceState(null, '', location.pathname);
  await loadConversations();
  const convo = conversations.find(c=>c.conversation_id === invite.conversation_id);
  if (convo) openConversation(convo.conversation_id, true, null, convo.title);
}

// ---------- Active conversation ----------

async function openConversation(conversationId, isGroup, otherId, title) {
  activeConvoId = conversationId;
  activeIsGroup = isGroup;

  document.getElementById('empty-state').classList.add('hidden');
  document.getElementById('chat-active').classList.remove('hidden');
  document.getElementById('chat-head-name').textContent = isGroup ? title : '@' + title;
  document.getElementById('chat-head-avatar').textContent = isGroup ? '👥' : initials(title);
  document.getElementById('group-invite-btn').classList.toggle('hidden', !isGroup);
  document.getElementById('call-audio-btn').classList.toggle('hidden', isGroup);
  document.getElementById('call-video-btn').classList.toggle('hidden', isGroup);
  document.getElementById('app').classList.add('mobile-chat-open');
  applyChatBackground();

  const { data: memberRows } = await sb
    .from('conversation_members').select('user_id, last_read_at').eq('conversation_id', conversationId);
  readTimes = new Map((memberRows||[]).map(r => [r.user_id, r.last_read_at ? new Date(r.last_read_at).getTime() : 0]));
  const memberIds = (memberRows||[]).map(r => r.user_id);
  const { data: memberProfiles } = await sb.from('profiles').select('id, username').in('id', memberIds);
  activeMembers = memberProfiles || [];
  if (isGroup) {
    document.getElementById('chat-head-status').textContent = `${activeMembers.length} members`;
  }

  renderConversations();
  updateChatHeadStatus();

  const { data: msgs } = await sb
    .from('messages').select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending:true });

  const container = document.getElementById('messages');
  container.innerHTML = '';
  (msgs || []).forEach(appendBubble);
  jumpToLatest();
  await refreshReactionsForActiveConvo();

  markRead(conversationId);
  loadConversations();
}

function updateChatHeadStatus() {
  if (activeIsGroup) return;
  const c = conversations.find(x=>x.conversation_id===activeConvoId);
  if (!c) return;
  const online = onlineUsers.has(c.other_id);
  document.getElementById('chat-head-status').textContent = online ? 'online' : 'offline';
}

async function markRead(conversationId) {
  await sb.from('messages')
    .update({ read:true })
    .eq('conversation_id', conversationId)
    .neq('sender_id', me.id)
    .eq('read', false);

  // Read receipts: record "I have read everything up to now" (server time).
  const { error } = await sb.rpc('mark_conversation_read', { p_conversation_id: conversationId });
  if (error) console.error('mark_conversation_read failed (did you run schema_v3.sql?):', error.message);
}

// ---------- Read receipts (ticks) ----------

// 'sent'  -> nobody has read it yet        (✓)
// 'some'  -> some members read it (groups) (✓✓ white)
// 'all'   -> everyone else has read it     (✓✓ blue)
function tickState(createdIso) {
  const created = new Date(createdIso).getTime();
  let total = 0, readCount = 0;
  readTimes.forEach((t, uid) => {
    if (uid === me.id) return;
    total++;
    if (t >= created) readCount++;
  });
  if (total === 0 || readCount === 0) return 'sent';
  return readCount === total ? 'all' : 'some';
}

function updateAllTicks() {
  document.querySelectorAll('.ticks[data-created]').forEach(el => {
    const st = tickState(el.dataset.created);
    el.className = 'ticks ticks-' + st;
    el.textContent = st === 'sent' ? '✓' : '✓✓';
  });
}

function showReadBy(msg, anchorEl) {
  const old = document.getElementById('readby-popup');
  if (old) old.remove();

  const created = new Date(msg.created_at).getTime();
  const readers = [], waiting = [];
  readTimes.forEach((t, uid) => {
    if (uid === me.id) return;
    const name = activeMembers.find(m => m.id === uid)?.username || '?';
    (t >= created ? readers : waiting).push(name);
  });

  const popup = document.createElement('div');
  popup.id = 'readby-popup';
  popup.className = 'readby-popup';
  const list = (names) => names.map(n => `<div class="readby-name">@${escapeHtml(n)}</div>`).join('');
  popup.innerHTML = `
    <div class="readby-title">Read by</div>
    ${readers.length ? list(readers) : '<div class="readby-empty">Nobody yet</div>'}
    ${waiting.length ? `<div class="readby-title readby-title-2">Not read yet</div>${list(waiting)}` : ''}
  `;
  document.body.appendChild(popup);

  const rect = anchorEl.getBoundingClientRect();
  const popupRect = popup.getBoundingClientRect();
  const top = Math.max(8, rect.top - popupRect.height - 8);
  const left = Math.min(Math.max(8, rect.right - popupRect.width), window.innerWidth - popupRect.width - 8);
  popup.style.top = top + 'px';
  popup.style.left = left + 'px';

  setTimeout(() => {
    document.addEventListener('click', function closeOnce(e) {
      if (!popup.contains(e.target)) {
        popup.remove();
        document.removeEventListener('click', closeOnce);
      }
    });
  }, 0);
}

// ---------- Message rendering ----------

function appendBubble(msg) {
  const row = document.createElement('div');
  row.className = 'msg-row ' + (msg.sender_id === me.id ? 'me' : 'them');
  row.dataset.msgId = msg.id;
  row.dataset.senderId = msg.sender_id;
  document.getElementById('messages').appendChild(row);
  fillBubble(row, msg);
}

async function fillBubble(row, msg) {
  let senderLabel = '';
  if (activeIsGroup && msg.sender_id !== me.id) {
    const p = activeMembers.find(m=>m.id===msg.sender_id);
    senderLabel = `<div class="msg-sender">${escapeHtml(p?.username || '?')}</div>`;
  }

  const bubbleInner = msg.deleted ? buildDeletedContent() : await buildContent(msg);
  const editedTag = (msg.edited_at && !msg.deleted) ? ` <span class="edited-tag">(edited)</span>` : '';
  const canDelete = !msg.deleted && (msg.sender_id === me.id || isAdmin);
  const actions = (canDelete) ? `
    <div class="msg-actions">
      ${msg.attachment_type || msg.sender_id !== me.id ? '' : `<button class="msg-action-btn" data-action="edit">✎</button>`}
      <button class="msg-action-btn" data-action="delete">🗑</button>
    </div>` : '';
  const reactBtn = !msg.deleted ? `<button class="msg-action-btn react-btn" data-action="react">☺</button>` : '';

  let ticksHtml = '';
  if (!msg.deleted && msg.sender_id === me.id) {
    const st = tickState(msg.created_at);
    ticksHtml = `<span class="ticks ticks-${st}" data-created="${msg.created_at}" title="Who has read this?">${st === 'sent' ? '✓' : '✓✓'}</span>`;
  }

  row.innerHTML = `
    <div>
      ${senderLabel}
      <div class="bubble">
        ${bubbleInner}
        <span class="msg-meta"><span class="msg-time">${fmtTime(msg.created_at)}</span>${editedTag}${ticksHtml}</span>
      </div>
      <div class="reactions-row" data-reactions-for="${msg.id}"></div>
      <div class="bubble-toolbar">${reactBtn}${actions}</div>
    </div>
  `;

  row.querySelectorAll('.msg-action-btn').forEach(btn=>{
    btn.addEventListener('click', ()=> handleMsgAction(btn.dataset.action, msg));
  });

  const ticksEl = row.querySelector('.ticks');
  if (ticksEl) ticksEl.addEventListener('click', e => { e.stopPropagation(); showReadBy(msg, ticksEl); });
}

function buildDeletedContent() {
  return `<span class="deleted-text">Message deleted</span>`;
}

async function buildContent(msg) {
  if (msg.attachment_type === 'image') {
    return `<img class="msg-image" src="${escapeHtml(msg.attachment_url)}" alt="attachment" loading="lazy">`;
  }
  if (msg.attachment_type === 'voice') {
    return `<audio controls src="${escapeHtml(msg.attachment_url)}" class="msg-audio"></audio>`;
  }
  if (msg.attachment_type === 'file') {
    return `<a class="msg-file" href="${escapeHtml(msg.attachment_url)}" target="_blank" rel="noopener">📎 ${escapeHtml(msg.attachment_name || 'File')}</a>`;
  }
  return escapeHtml(msg.text || '');
}

async function handleMsgAction(action, msg) {
  if (action === 'delete') {
    const who = msg.sender_id === me.id ? '' : ' (als Admin)';
    if (!confirm('Diese Nachricht löschen' + who + '?')) return;
    await deleteMessageById(msg.id);
  }
  if (action === 'edit') {
    const newText = prompt('Edit message:', msg.text || '');
    if (newText === null || !newText.trim()) return;
    await sb.from('messages').update({ text:newText.trim(), edited_at:new Date().toISOString() }).eq('id', msg.id);
  }
  if (action === 'react') {
    openReactionPicker(msg.id);
  }
}

// ---------- Reactions ----------

const REACTION_EMOJIS = ['👍','❤️','😂','😮','😢','🙏'];

function openReactionPicker(messageId) {
  const existing = document.getElementById('reaction-picker-popup');
  if (existing) existing.remove();

  const popup = document.createElement('div');
  popup.id = 'reaction-picker-popup';
  popup.className = 'reaction-picker-popup';
  REACTION_EMOJIS.forEach(e=>{
    const btn = document.createElement('button');
    btn.textContent = e;
    btn.addEventListener('click', async ()=>{
      await sb.from('message_reactions').upsert(
        { message_id: messageId, user_id: me.id, emoji: e },
        { onConflict: 'message_id,user_id,emoji' }
      );
      popup.remove();
    });
    popup.appendChild(btn);
  });
  document.body.appendChild(popup);

  const trigger = document.querySelector(`[data-msg-id="${messageId}"] .react-btn`);
  const rect = trigger.getBoundingClientRect();
  popup.style.top = (rect.top - 46 + window.scrollY) + 'px';
  popup.style.left = rect.left + 'px';

  setTimeout(()=>{
    document.addEventListener('click', function closeOnce(e){
      if (!popup.contains(e.target) && e.target !== trigger) {
        popup.remove();
        document.removeEventListener('click', closeOnce);
      }
    });
  }, 0);
}

async function refreshReactionsForActiveConvo() {
  const { data: msgs } = await sb.from('messages').select('id').eq('conversation_id', activeConvoId);
  const ids = (msgs||[]).map(m=>m.id);
  if (ids.length === 0) return;

  const { data: reactions } = await sb.from('message_reactions').select('message_id, user_id, emoji').in('message_id', ids);
  const grouped = {};
  (reactions||[]).forEach(r=>{
    grouped[r.message_id] = grouped[r.message_id] || {};
    grouped[r.message_id][r.emoji] = grouped[r.message_id][r.emoji] || [];
    grouped[r.message_id][r.emoji].push(r.user_id);
  });

  document.querySelectorAll('[data-reactions-for]').forEach(el=>{
    const msgId = el.dataset.reactionsFor;
    const emojiMap = grouped[msgId];
    el.innerHTML = '';
    if (!emojiMap) return;
    Object.entries(emojiMap).forEach(([emoji, userIds])=>{
      const chip = document.createElement('button');
      chip.className = 'reaction-chip' + (userIds.includes(me.id) ? ' mine' : '');
      chip.textContent = `${emoji} ${userIds.length}`;
      chip.addEventListener('click', async ()=>{
        if (userIds.includes(me.id)) {
          await sb.from('message_reactions').delete().eq('message_id', msgId).eq('user_id', me.id).eq('emoji', emoji);
        } else {
          await sb.from('message_reactions').upsert(
            { message_id: msgId, user_id: me.id, emoji }, { onConflict: 'message_id,user_id,emoji' }
          );
        }
      });
      el.appendChild(chip);
    });
  });
}

function scrollToBottom() {
  const el = document.getElementById('messages');
  el.scrollTop = el.scrollHeight;
}

// ---------- Composer: text ----------

const input = document.getElementById('msg-input');
const sendBtn = document.getElementById('send-btn');

async function send() {
  const text = input.value.trim();
  if (!text || !activeConvoId) return;
  input.value = '';
  input.style.height = 'auto';
  clearTyping();

  const { error } = await sb.from('messages').insert({
    conversation_id: activeConvoId,
    sender_id: me.id,
    text
  });
  if (error) console.error(error);
}

sendBtn.addEventListener('click', send);
input.addEventListener('keydown', e=>{
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});
input.addEventListener('input', ()=>{
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  sendTypingPing();
});

// ---------- Typing indicator ----------

function sendTypingPing() {
  if (!activeConvoId) return;
  const now = Date.now();
  if (now - typingSendThrottle < 2000) return;
  typingSendThrottle = now;
  sb.from('typing_status').upsert(
    { conversation_id: activeConvoId, user_id: me.id, updated_at: new Date().toISOString() },
    { onConflict: 'conversation_id,user_id' }
  ).then(()=>{});
}

function clearTyping() {
  if (!activeConvoId) return;
  sb.from('typing_status').delete().eq('conversation_id', activeConvoId).eq('user_id', me.id).then(()=>{});
}

async function refreshTypingIndicator() {
  if (!activeConvoId) return;
  const { data } = await sb.from('typing_status')
    .select('user_id, updated_at')
    .eq('conversation_id', activeConvoId)
    .neq('user_id', me.id);

  const fresh = (data||[]).filter(r => Date.now() - new Date(r.updated_at).getTime() < 4000);
  const el = document.getElementById('typing-indicator');
  if (fresh.length === 0) { el.classList.add('hidden'); return; }

  const names = await Promise.all(fresh.map(async r=>{
    const p = activeMembers.find(m=>m.id===r.user_id);
    if (p) return p.username;
    const { data: prof } = await sb.from('profiles').select('username').eq('id', r.user_id).single();
    return prof?.username || 'Someone';
  }));

  el.textContent = names.join(', ') + (names.length>1 ? ' are typing…' : ' is typing…');
  el.classList.remove('hidden');
}

setInterval(()=>{ if (activeConvoId) refreshTypingIndicator(); }, 2000);

// ---------- Attachments: images & files ----------

const attachBtn = document.getElementById('attach-btn');
const fileInput = document.getElementById('file-input');

attachBtn.addEventListener('click', ()=> fileInput.click());
fileInput.addEventListener('change', async ()=>{
  const file = fileInput.files[0];
  fileInput.value = '';
  if (!file || !activeConvoId) return;
  await uploadAndSend(file, file.type.startsWith('image/') ? 'image' : 'file');
});

async function uploadAndSend(file, kind) {
  const path = `${activeConvoId}/${Date.now()}_${file.name}`;
  const { error: upErr } = await sb.storage.from('attachments').upload(path, file);
  if (upErr) { alert('Upload failed: ' + upErr.message); return; }

  const { data: urlData } = sb.storage.from('attachments').getPublicUrl(path);

  await sb.from('messages').insert({
    conversation_id: activeConvoId,
    sender_id: me.id,
    attachment_url: urlData.publicUrl,
    attachment_type: kind,
    attachment_name: file.name,
  });
}

// ---------- Voice messages ----------

const voiceBtn = document.getElementById('voice-btn');
const voiceRecordingUI = document.getElementById('voice-recording-ui');
const voiceTimer = document.getElementById('voice-timer');

voiceBtn.addEventListener('click', async ()=>{
  if (recorder && recorder.state === 'recording') { stopRecording(true); return; }
  await startRecording();
});
document.getElementById('voice-cancel').addEventListener('click', ()=> stopRecording(false));

// Pick a mimeType the browser actually supports for MediaRecorder.
// Safari/iOS doesn't support audio/webm at all, only audio/mp4 — if we
// hardcode webm, Safari either throws on `new MediaRecorder(...)` or
// silently records something that doesn't match the file extension/type
// we later tell Supabase and the <audio> tag about.
function pickRecordingMimeType() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
    'audio/ogg;codecs=opus',
  ];
  for (const type of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }
  return ''; // let the browser choose its own default as a last resort
}

let recordingMimeType = '';

async function startRecording() {
  if (!window.MediaRecorder) {
    alert('Voice messages aren\'t supported in this browser.');
    return;
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert('Microphone access isn\'t available. On iPhone this requires Safari (not an in-app browser like Instagram/TikTok) and a secure https page.');
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio:true });
    recordingMimeType = pickRecordingMimeType();

    try {
      recorder = recordingMimeType
        ? new MediaRecorder(stream, { mimeType: recordingMimeType })
        : new MediaRecorder(stream);
    } catch (recorderErr) {
      stream.getTracks().forEach(t=>t.stop());
      alert('Could not start recording: ' + recorderErr.message);
      return;
    }

    recordedChunks = [];
    recorder.ondataavailable = e => { if (e.data.size>0) recordedChunks.push(e.data); };
    recorder.onstop = () => { stream.getTracks().forEach(t=>t.stop()); };
    recorder.start();
    recordingStart = Date.now();
    voiceRecordingUI.classList.remove('hidden');
    voiceBtn.classList.add('recording');
    recordingTimer = setInterval(()=>{
      const sec = Math.floor((Date.now()-recordingStart)/1000);
      voiceTimer.textContent = `${String(Math.floor(sec/60)).padStart(2,'0')}:${String(sec%60).padStart(2,'0')}`;
    }, 250);
  } catch (err) {
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      alert('Microphone permission was denied. Check your browser/site settings and allow microphone access for this page.');
    } else if (err.name === 'NotFoundError') {
      alert('No microphone was found on this device.');
    } else if (location.protocol !== 'https:' && location.hostname !== 'localhost') {
      alert('Voice messages need a secure (https) page to access the microphone. This page is not loaded over https.');
    } else {
      alert('Could not access the microphone: ' + (err.message || err.name || 'unknown error'));
    }
  }
}

function stopRecording(send) {
  if (!recorder) return;
  clearInterval(recordingTimer);
  voiceRecordingUI.classList.add('hidden');
  voiceBtn.classList.remove('recording');
  const durationSec = Math.round((Date.now()-recordingStart)/1000);

  recorder.onstop = async () => {
    recorder.stream?.getTracks?.().forEach(t=>t.stop());
    if (send && recordedChunks.length > 0 && activeConvoId) {
      // Use the mimeType the recorder actually produced, not an assumed one,
      // so the file extension/content-type/playback all agree.
      const actualType = recorder.mimeType || recordingMimeType || 'audio/webm';
      const ext = actualType.includes('mp4') ? 'm4a' : actualType.includes('ogg') ? 'ogg' : 'webm';

      const blob = new Blob(recordedChunks, { type: actualType });
      const file = new File([blob], `voice_${Date.now()}.${ext}`, { type: actualType });
      const path = `${activeConvoId}/${file.name}`;

      const { error: upErr } = await sb.storage.from('attachments').upload(path, file, {
        contentType: actualType,
      });
      if (upErr) { alert('Upload failed: ' + upErr.message); return; }

      const { data: urlData } = sb.storage.from('attachments').getPublicUrl(path);
      const { error: insertErr } = await sb.from('messages').insert({
        conversation_id: activeConvoId,
        sender_id: me.id,
        attachment_url: urlData.publicUrl,
        attachment_type: 'voice',
        attachment_duration_sec: durationSec,
      });
      if (insertErr) alert('Could not send voice message: ' + insertErr.message);
    }
  };
  recorder.stop();
}

// ---------- Group invite button ----------

document.getElementById('group-invite-btn').addEventListener('click', generateInviteLink);

// ---------- Dark mode ----------

const THEME_KEY = 'threadline_theme';
const themeToggleBtn = document.getElementById('theme-toggle-btn');

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  themeToggleBtn.textContent = theme === 'dark' ? '☀️' : '🌙';
  localStorage.setItem(THEME_KEY, theme);
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved) { applyTheme(saved); return; }
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(prefersDark ? 'dark' : 'light');
}

themeToggleBtn.addEventListener('click', ()=>{
  const current = document.documentElement.getAttribute('data-theme');
  applyTheme(current === 'dark' ? 'light' : 'dark');
});

initTheme();

// ---------- Message search ----------

const messageSearchInput = document.getElementById('message-search-input');
const messageSearchResults = document.getElementById('message-search-results');
let messageSearchDebounce = null;

messageSearchInput.addEventListener('input', ()=>{
  clearTimeout(messageSearchDebounce);
  const q = messageSearchInput.value.trim();
  if (!q) { messageSearchResults.innerHTML = ''; messageSearchResults.classList.remove('visible'); return; }
  messageSearchDebounce = setTimeout(()=> runMessageSearch(q), 300);
});

document.addEventListener('click', e=>{
  if (!document.getElementById('search-messages-box').contains(e.target)) {
    messageSearchResults.classList.remove('visible');
  }
});

async function runMessageSearch(query) {
  if (!me) return;

  // Only search within conversations the user is a member of (RLS also enforces this).
  const { data: memberRows } = await sb
    .from('conversation_members').select('conversation_id').eq('user_id', me.id);
  const convoIds = (memberRows || []).map(r => r.conversation_id);
  if (convoIds.length === 0) { renderMessageSearchResults([], query); return; }

  const { data: hits } = await sb
    .from('messages')
    .select('id, conversation_id, sender_id, text, created_at')
    .in('conversation_id', convoIds)
    .eq('deleted', false)
    .ilike('text', `%${query}%`)
    .order('created_at', { ascending:false })
    .limit(25);

  renderMessageSearchResults(hits || [], query);
}

function highlightMatch(text, query) {
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return escapeHtml(text);
  const before = escapeHtml(text.slice(0, idx));
  const match = escapeHtml(text.slice(idx, idx + query.length));
  const after = escapeHtml(text.slice(idx + query.length));
  return `${before}<mark>${match}</mark>${after}`;
}

async function renderMessageSearchResults(hits, query) {
  messageSearchResults.innerHTML = '';
  messageSearchResults.classList.toggle('visible', hits.length > 0 || query.length > 0);

  if (hits.length === 0) {
    messageSearchResults.innerHTML = `<div class="search-empty">No messages found</div>`;
    return;
  }

  for (const hit of hits) {
    const convo = conversations.find(c => c.conversation_id === hit.conversation_id);
    const title = convo ? convo.title : 'Conversation';
    const div = document.createElement('div');
    div.className = 'search-result-item';
    div.innerHTML = `
      <div class="search-result-title">${escapeHtml(title)}</div>
      <div class="search-result-snippet">${highlightMatch(hit.text || '', query)}</div>
      <div class="search-result-time">${fmtTime(hit.created_at)}</div>
    `;
    div.addEventListener('click', ()=>{
      messageSearchInput.value = '';
      messageSearchResults.innerHTML = '';
      messageSearchResults.classList.remove('visible');
      if (convo) openConversation(convo.conversation_id, convo.is_group, convo.other_id, convo.title);
    });
    messageSearchResults.appendChild(div);
  }
}

// ---------- Browser notifications ----------

let notificationsEnabled = false;

async function initNotifications() {
  if (!('Notification' in window)) return;
  if (Notification.permission === 'granted') {
    notificationsEnabled = true;
  } else if (Notification.permission !== 'denied') {
    // Ask once, politely, after the user is already in the app (not on page load cold).
  }
}

function requestNotificationPermission() {
  if (!('Notification' in window)) return;
  Notification.requestPermission().then(perm => {
    notificationsEnabled = perm === 'granted';
  });
}

document.getElementById('notif-allow-btn').addEventListener('click', ()=>{
  requestNotificationPermission();
  document.getElementById('notification-prompt').classList.add('hidden');
});
document.getElementById('notif-dismiss-btn').addEventListener('click', ()=>{
  document.getElementById('notification-prompt').classList.add('hidden');
});

function maybeNotify(msg, conversationTitle) {
  if (!notificationsEnabled) return;
  if (document.visibilityState === 'visible' && msg.conversation_id === activeConvoId) return; // already looking at it
  if (msg.sender_id === me.id) return;

  let body;
  if (msg.attachment_type === 'image') body = '📷 Photo';
  else if (msg.attachment_type === 'voice') body = '🎤 Voice message';
  else if (msg.attachment_type === 'file') body = '📎 File';
  else body = msg.text || '';

  const notif = new Notification(conversationTitle || 'New message', {
    body,
    icon: undefined,
    tag: 'threadline-' + msg.conversation_id,
  });
  notif.onclick = () => {
    window.focus();
    const convo = conversations.find(c => c.conversation_id === msg.conversation_id);
    if (convo) openConversation(convo.conversation_id, convo.is_group, convo.other_id, convo.title);
    notif.close();
  };
}

// ---------- Voice & video calls (WebRTC; signaling through the call_signals table) ----------
//
// Audio/video goes directly between the two devices (peer-to-peer). Supabase only carries the
// short setup messages (offer / answer / network candidates / hang-up) via call_signals, which
// is protected by row-level security, so nobody can fake a call "from" someone else.
// Limits: 1:1 only (no group calls); on strict networks a TURN server may be needed (see README).

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  ...((typeof TURN_SERVERS !== 'undefined' && Array.isArray(TURN_SERVERS)) ? TURN_SERVERS : []),
];

let call = null;                       // the one active/ringing call, or null
let signalQueue = Promise.resolve();   // incoming signals are handled strictly in order
let sendChain = Promise.resolve();     // outgoing signals are inserted strictly in order

const fmtDuration = sec => {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

function newCall(fields) {
  return Object.assign({
    state: 'ringing',        // ringing -> connecting -> connected
    pc: null, localStream: null,
    pendingIce: [], remoteDescSet: false,
    timeout: null, disconnectTimer: null, timer: null,
    connectedAt: null, offerSdp: null, accepting: false,
  }, fields);
}

// ----- signaling -----

function sendSignal(type, payload = null, target = null) {
  const c = target || call;
  if (!c) return Promise.resolve();
  const row = {
    call_id: c.id, conversation_id: c.conversationId,
    from_user: me.id, to_user: c.peerId, type, payload,
  };
  sendChain = sendChain
    .then(() => sb.from('call_signals').insert(row))
    .then(res => { if (res && res.error) console.error('Call signal failed (' + type + '):', res.error.message); })
    .catch(e => console.error('Call signal error:', e));
  return sendChain;
}

function cleanupOldCallSignals() {
  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  sb.from('call_signals').delete().lt('created_at', cutoff).then(() => {});
}

function onCallSignalRow(row) {
  signalQueue = signalQueue
    .then(() => handleCallSignal(row))
    .catch(e => console.error('Call signal handling error:', e));
}

async function handleCallSignal(sig) {
  if (sig.type === 'offer') { await handleIncomingOffer(sig); return; }
  if (!call || call.id !== sig.call_id) return; // stale or unknown call

  switch (sig.type) {
    case 'answer': {
      if (call.role !== 'caller' || call.remoteDescSet || !sig.payload) return;
      clearTimeout(call.timeout);
      call.state = 'connecting';
      setCallStatus('Connecting…');
      await call.pc.setRemoteDescription({ type: 'answer', sdp: sig.payload.sdp });
      call.remoteDescSet = true;
      await flushPendingIce();
      break;
    }
    case 'ice': {
      if (!sig.payload) return;
      if (call.remoteDescSet && call.pc) {
        try { await call.pc.addIceCandidate(sig.payload); } catch (e) { console.warn('addIceCandidate failed', e); }
      } else {
        call.pendingIce.push(sig.payload);
      }
      break;
    }
    case 'hangup':  endCall({ reason: 'remote-hangup', notifyPeer: false }); break;
    case 'decline': endCall({ reason: 'declined', notifyPeer: false }); break;
    case 'busy':    endCall({ reason: 'busy', notifyPeer: false }); break;
  }
}

async function flushPendingIce() {
  const c = call;
  if (!c || !c.pc) return;
  const list = c.pendingIce.splice(0);
  for (const cand of list) {
    try { await c.pc.addIceCandidate(cand); } catch (e) { console.warn('addIceCandidate failed', e); }
  }
}

// ----- media + peer connection -----

async function getCallMedia(video) {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
      video: video ? { facingMode: 'user' } : false,
    });
  } catch (err) {
    const what = video ? 'camera and microphone' : 'microphone';
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      alert(`Access to the ${what} was denied. Allow it in your browser's site settings and try again.`);
    } else if (err.name === 'NotFoundError' || err.name === 'OverconstrainedError') {
      alert(`No ${what} was found on this device.`);
    } else if (err.name === 'NotReadableError') {
      alert(`The ${what} is already in use by another app.`);
    } else {
      alert(`Could not access the ${what}: ` + (err.message || err.name));
    }
    return null;
  }
}

function setupPeerConnection() {
  const c = call;
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  c.pc = pc;
  c.localStream.getTracks().forEach(t => pc.addTrack(t, c.localStream));

  pc.ontrack = e => {
    if (call !== c) return;
    const rv = document.getElementById('remote-video');
    rv.srcObject = e.streams[0];
    const p = rv.play && rv.play();
    if (p && p.catch) p.catch(() => {});
  };

  pc.onicecandidate = e => {
    if (e.candidate && call === c) sendSignal('ice', e.candidate.toJSON());
  };

  pc.onconnectionstatechange = () => {
    if (call !== c) return;
    const st = pc.connectionState;
    if (st === 'connected') {
      clearTimeout(c.disconnectTimer);
      if (!c.connectedAt) {
        c.connectedAt = Date.now();
        c.state = 'connected';
        document.getElementById('call-overlay').classList.add('connected');
        c.timer = setInterval(() => {
          if (call === c) setCallStatus(fmtDuration(Math.round((Date.now() - c.connectedAt) / 1000)));
        }, 500);
      }
      setCallStatus(fmtDuration(Math.round((Date.now() - c.connectedAt) / 1000)));
    } else if (st === 'disconnected') {
      setCallStatus('Reconnecting…');
      clearTimeout(c.disconnectTimer);
      c.disconnectTimer = setTimeout(() => {
        if (call === c && pc.connectionState !== 'connected') endCall({ reason: 'failed' });
      }, 8000);
    } else if (st === 'failed') {
      endCall({ reason: 'failed' });
    }
  };
}

// ----- starting / answering -----

async function startCall(video) {
  if (call) { alert('You are already in a call.'); return; }
  if (!activeConvoId || activeIsGroup) return;
  const convo = conversations.find(c => c.conversation_id === activeConvoId);
  if (!convo || !convo.other_id) return;
  if (!window.RTCPeerConnection || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert('Calls need a modern browser and a secure (https) page.');
    return;
  }

  const stream = await getCallMedia(video);
  if (!stream) return;
  if (call) { stream.getTracks().forEach(t => t.stop()); return; } // another call started meanwhile

  call = newCall({
    id: crypto.randomUUID(), conversationId: convo.conversation_id,
    peerId: convo.other_id, peerName: convo.title, video, role: 'caller',
  });
  call.localStream = stream;
  showCallUI('Calling…');
  setupPeerConnection();

  const c = call;
  try {
    const offer = await c.pc.createOffer();
    await c.pc.setLocalDescription(offer);
    if (call !== c) return;
    sendSignal('offer', { sdp: c.pc.localDescription.sdp, video });
  } catch (e) {
    endCall({ reason: 'error', notifyPeer: false });
    alert('Could not start the call: ' + e.message);
    return;
  }
  c.timeout = setTimeout(() => { if (call === c && c.state === 'ringing') endCall({ reason: 'noanswer' }); }, 45000);
}

async function handleIncomingOffer(sig) {
  if (!sig.payload || !sig.payload.sdp) return;
  const busyReply = () => sendSignal('busy', null, {
    id: sig.call_id, conversationId: sig.conversation_id, peerId: sig.from_user,
  });
  if (call) { busyReply(); return; }

  const { data: prof } = await sb.from('profiles').select('username').eq('id', sig.from_user).single();
  if (call) { busyReply(); return; } // something else started while we were looking up the name

  const name = prof ? prof.username : 'Someone';
  const c = call = newCall({
    id: sig.call_id, conversationId: sig.conversation_id, peerId: sig.from_user,
    peerName: name, video: !!sig.payload.video, role: 'callee',
  });
  c.offerSdp = sig.payload.sdp;

  document.getElementById('incoming-avatar').textContent = initials(name);
  document.getElementById('incoming-name').textContent = '@' + name;
  document.getElementById('incoming-type').textContent = c.video ? 'Incoming video call…' : 'Incoming voice call…';
  document.getElementById('incoming-call').classList.remove('hidden');
  startRingtone();

  if (typeof notificationsEnabled !== 'undefined' && notificationsEnabled && document.visibilityState !== 'visible') {
    try {
      const n = new Notification(c.video ? 'Incoming video call' : 'Incoming voice call', { body: '@' + name, tag: 'threadline-call' });
      n.onclick = () => { window.focus(); n.close(); };
    } catch {}
  }

  c.timeout = setTimeout(() => {
    if (call === c && c.state === 'ringing') endCall({ reason: 'missed', notifyPeer: false });
  }, 50000);
}

async function acceptCall() {
  const c = call;
  if (!c || c.role !== 'callee' || c.state !== 'ringing' || c.accepting) return;
  c.accepting = true;
  stopRingtone();
  clearTimeout(c.timeout);

  const stream = await getCallMedia(c.video);
  if (call !== c) { if (stream) stream.getTracks().forEach(t => t.stop()); return; } // caller hung up meanwhile
  if (!stream) { endCall({ reason: 'declined' }); return; } // state is still 'ringing' -> sends "decline"

  c.localStream = stream;
  c.state = 'connecting';
  showCallUI('Connecting…');
  setupPeerConnection();
  try {
    await c.pc.setRemoteDescription({ type: 'offer', sdp: c.offerSdp });
    c.remoteDescSet = true;
    await flushPendingIce();
    const answer = await c.pc.createAnswer();
    await c.pc.setLocalDescription(answer);
    if (call !== c) return;
    sendSignal('answer', { sdp: c.pc.localDescription.sdp });
  } catch (e) {
    endCall({ reason: 'error' });
    alert('Could not answer the call: ' + e.message);
  }
}

// ----- ending -----

function endCall({ reason = 'hangup', notifyPeer = true } = {}) {
  const c = call;
  if (!c) return;
  call = null; // clear first so late callbacks see "no call" and stop

  clearTimeout(c.timeout);
  clearTimeout(c.disconnectTimer);
  clearInterval(c.timer);
  stopRingtone();

  if (notifyPeer) {
    const type = (c.role === 'callee' && c.state === 'ringing') ? 'decline' : 'hangup';
    sendSignal(type, null, c);
  }

  try { if (c.pc) c.pc.close(); } catch {}
  if (c.localStream) c.localStream.getTracks().forEach(t => t.stop());

  const rv = document.getElementById('remote-video');
  const lv = document.getElementById('local-video');
  rv.srcObject = null; lv.srcObject = null;
  document.getElementById('call-overlay').classList.add('hidden');
  document.getElementById('call-overlay').classList.remove('connected');
  document.getElementById('incoming-call').classList.add('hidden');

  const name = '@' + c.peerName;
  const toast = {
    'declined': `${name} declined the call`,
    'busy': `${name} is busy`,
    'noanswer': `${name} didn't answer`,
    'failed': 'Connection failed. Your network may block direct calls (a TURN server may be needed).',
    'remote-hangup': (c.role === 'callee' && c.state === 'ringing') ? `Missed call from ${name}` : 'Call ended',
    'missed': `Missed call from ${name}`,
  }[reason];
  if (toast) showCallToast(toast);

  // The caller writes one line into the chat so both sides see what happened.
  if (c.role === 'caller' && reason !== 'error') logCallToChat(c);

  // Remove this call's signal rows shortly after (gives the other side time to receive hang-up).
  setTimeout(() => { sb.from('call_signals').delete().eq('call_id', c.id).then(() => {}); }, 6000);
}

function logCallToChat(c) {
  const icon = c.video ? '📹' : '📞';
  let text;
  if (c.connectedAt) {
    const sec = Math.round((Date.now() - c.connectedAt) / 1000);
    text = `${icon} ${c.video ? 'Video' : 'Voice'} call · ${fmtDuration(sec)}`;
  } else {
    text = `${icon} Missed ${c.video ? 'video' : 'voice'} call`;
  }
  sb.from('messages').insert({ conversation_id: c.conversationId, sender_id: me.id, text })
    .then(res => { if (res && res.error) console.error('Could not log call:', res.error.message); });
}

// ----- UI helpers -----

function showCallUI(status) {
  const c = call;
  document.getElementById('incoming-call').classList.add('hidden');
  const ov = document.getElementById('call-overlay');
  ov.classList.remove('hidden', 'connected');
  ov.classList.toggle('audio-only', !c.video);
  document.getElementById('call-peer-name').textContent = '@' + c.peerName;
  document.getElementById('call-peer-avatar').textContent = initials(c.peerName);
  document.getElementById('local-video').srcObject = c.localStream;

  const mic = document.getElementById('call-mic-btn');
  mic.textContent = '🎤'; mic.classList.remove('off');
  const cam = document.getElementById('call-cam-btn');
  cam.textContent = '📷'; cam.classList.remove('off');
  cam.classList.toggle('hidden', !c.video);
  setCallStatus(status);
}

function setCallStatus(text) {
  document.getElementById('call-status').textContent = text;
}

let callToastTimer = null;
function showCallToast(text) {
  const el = document.getElementById('call-toast');
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(callToastTimer);
  callToastTimer = setTimeout(() => el.classList.add('hidden'), 4500);
}

// ----- ringtone (simple beeps; may stay silent if the browser blocks audio before any interaction) -----

let ringCtx = null, ringTimer = null;
function startRingtone() {
  try {
    ringCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (ringCtx.resume) ringCtx.resume();
    const beep = () => {
      if (!ringCtx) return;
      const t0 = ringCtx.currentTime;
      const o = ringCtx.createOscillator(), g = ringCtx.createGain();
      o.type = 'sine'; o.frequency.value = 440;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.15, t0 + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.6);
      o.connect(g); g.connect(ringCtx.destination);
      o.start(t0); o.stop(t0 + 0.65);
    };
    beep();
    ringTimer = setInterval(beep, 2000);
    if (navigator.vibrate) navigator.vibrate([400, 200, 400]);
  } catch {}
}
function stopRingtone() {
  clearInterval(ringTimer); ringTimer = null;
  try { if (ringCtx) ringCtx.close(); } catch {}
  ringCtx = null;
  if (navigator.vibrate) navigator.vibrate(0);
}

// ----- button wiring -----

document.getElementById('call-audio-btn').addEventListener('click', () => startCall(false));
document.getElementById('call-video-btn').addEventListener('click', () => startCall(true));
document.getElementById('incoming-accept').addEventListener('click', acceptCall);
document.getElementById('incoming-decline').addEventListener('click', () => endCall({ reason: 'declined' }));
document.getElementById('call-hangup-btn').addEventListener('click', () => endCall({ reason: 'hangup' }));

document.getElementById('call-mic-btn').addEventListener('click', e => {
  if (!call || !call.localStream) return;
  const track = call.localStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  e.currentTarget.textContent = track.enabled ? '🎤' : '🔇';
  e.currentTarget.classList.toggle('off', !track.enabled);
});

document.getElementById('call-cam-btn').addEventListener('click', e => {
  if (!call || !call.localStream) return;
  const track = call.localStream.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  e.currentTarget.textContent = track.enabled ? '📷' : '🚫';
  e.currentTarget.classList.toggle('off', !track.enabled);
});

window.addEventListener('beforeunload', () => {
  if (call && call.pc) { try { call.pc.close(); } catch {} }
});

// ---------- Settings: chat backgrounds (gradients, colors, images) ----------
//
// Every user can set a background for ALL chats ("default") and override it for single chats.
// Settings live in the chat_backgrounds table (own rows only), uploaded images in the
// "backgrounds" storage bucket (own folder only). Only validated values (hex colors, clamped
// numbers, URLs from our own storage) are ever turned into CSS, so stored data can't inject styles.

const BG_PRESETS = [
  { name: 'Sunset',   angle: 135, stops: ['#ff9966', '#ff5e62'] },
  { name: 'Ocean',    angle: 160, stops: ['#2193b0', '#6dd5ed'] },
  { name: 'Forest',   angle: 135, stops: ['#134e5e', '#71b280'] },
  { name: 'Lavender', angle: 135, stops: ['#a18cd1', '#fbc2eb'] },
  { name: 'Midnight', angle: 160, stops: ['#0f2027', '#203a43', '#2c5364'] },
  { name: 'Peach',    angle: 135, stops: ['#ffecd2', '#fcb69f'] },
  { name: 'Mint',     angle: 135, stops: ['#d4fc79', '#96e6a1'] },
  { name: 'Aurora',   angle: 135, stops: ['#00c9ff', '#92fe9d'] },
  { name: 'Rose',     angle: 135, stops: ['#f093fb', '#f5576c'] },
  { name: 'Slate',    angle: 135, stops: ['#bdc3c7', '#2c3e50'] },
  { name: 'Dusk',     angle: 150, stops: ['#2c3e50', '#fd746c'] },
  { name: 'Sand',     angle: 135, stops: ['#e6dccb', '#c9b79c'] },
];

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const bgSettings = new Map();   // 'default' | '<conversationId>' -> { kind, config }
let bgScope = 'default';        // which scope the settings window is editing
let bgWork = null;              // working copy shown in the settings window
let bgPendingBlob = null;       // newly chosen image, uploaded on Save
let bgPendingUrl = null;        // object URL for previewing that image
let bgSaving = false;

const clampNum = (v, min, max, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

function isSafeImageUrl(u, allowBlob = false) {
  if (typeof u !== 'string' || u.length > 600 || /["'()\\\s<>]/.test(u)) return false;
  if (allowBlob && u.startsWith('blob:')) return true;
  return u.startsWith(SUPABASE_URL + '/storage/v1/object/public/backgrounds/');
}

// Paints a background into a layer element. Returns true if something was painted.
function paintBgLayer(layer, bg, opts = {}) {
  layer.style.backgroundImage = '';
  layer.style.backgroundColor = '';
  layer.style.backgroundSize = '';
  layer.style.backgroundPosition = '';
  layer.style.filter = '';
  layer.style.inset = '0';
  if (!bg || bg.kind === 'none') return false;
  const c = bg.config || {};

  if (bg.kind === 'gradient') {
    const stops = (Array.isArray(c.stops) ? c.stops : []).filter(x => HEX_COLOR.test(x)).slice(0, 3);
    if (stops.length < 2) return false;
    layer.style.backgroundImage = `linear-gradient(${clampNum(c.angle, 0, 360, 135)}deg, ${stops.join(', ')})`;
    return true;
  }
  if (bg.kind === 'color') {
    if (!HEX_COLOR.test(c.color)) return false;
    layer.style.backgroundColor = c.color;
    return true;
  }
  if (bg.kind === 'image') {
    if (!isSafeImageUrl(c.url, !!opts.allowBlob)) return false;
    const dim = clampNum(c.dim, 0, 70, 0) / 100;
    const blur = clampNum(c.blur, 0, 12, 0);
    layer.style.backgroundImage = `linear-gradient(rgba(0,0,0,${dim}), rgba(0,0,0,${dim})), url("${c.url}")`;
    layer.style.backgroundSize = 'cover';
    layer.style.backgroundPosition = 'center';
    if (blur > 0) {
      layer.style.filter = `blur(${blur}px)`;
      layer.style.inset = `-${blur * 2}px`; // grow the layer so blurred edges don't show
    }
    return true;
  }
  return false;
}

// A chat's own setting wins over the default; no setting at all means no background.
function effectiveBackground(conversationId) {
  return bgSettings.get(String(conversationId)) || bgSettings.get('default') || null;
}

function applyChatBackground() {
  const wrap = document.getElementById('messages-wrap');
  const layer = document.getElementById('chat-bg');
  const painted = paintBgLayer(layer, activeConvoId ? effectiveBackground(activeConvoId) : null);
  wrap.classList.toggle('has-bg', painted);
}

async function loadBackgrounds() {
  const { data, error } = await sb.from('chat_backgrounds').select('scope_key, kind, config').eq('user_id', me.id);
  if (error) { console.warn('Chat backgrounds unavailable (run schema_v5.sql?):', error.message); return; }
  bgSettings.clear();
  (data || []).forEach(r => bgSettings.set(r.scope_key, { kind: r.kind, config: r.config || {} }));
  applyChatBackground();
}

// ----- settings window -----

const scopeKeyNow = () => (bgScope === 'chat' ? String(activeConvoId) : 'default');

function freshWork() {
  return {
    kind: 'none',
    gradient: { angle: 135, stops: [...BG_PRESETS[0].stops, BG_PRESETS[0].stops[1]], useThird: false },
    color: '#2f6f5e',
    image: { url: null, path: null, dim: 15, blur: 0 },
  };
}

function initWorkFrom(src) {
  if (bgPendingUrl) { try { URL.revokeObjectURL(bgPendingUrl); } catch {} }
  bgPendingBlob = null; bgPendingUrl = null;
  bgWork = freshWork();
  if (!src) return;
  const c = src.config || {};
  bgWork.kind = src.kind;
  if (src.kind === 'gradient') {
    const stops = (Array.isArray(c.stops) ? c.stops : []).filter(x => HEX_COLOR.test(x)).slice(0, 3);
    if (stops.length >= 2) {
      bgWork.gradient = {
        angle: clampNum(c.angle, 0, 360, 135),
        stops: [stops[0], stops[1], stops[2] || stops[1]],
        useThird: stops.length === 3,
      };
    }
  } else if (src.kind === 'color' && HEX_COLOR.test(c.color)) {
    bgWork.color = c.color;
  } else if (src.kind === 'image') {
    bgWork.image = {
      url: typeof c.url === 'string' ? c.url : null,
      path: typeof c.path === 'string' ? c.path : null,
      dim: clampNum(c.dim, 0, 70, 15),
      blur: clampNum(c.blur, 0, 12, 0),
    };
  }
}

function currentGradientStops() {
  const g = bgWork.gradient;
  return g.useThird ? [g.stops[0], g.stops[1], g.stops[2]] : [g.stops[0], g.stops[1]];
}

// What the working copy would look like if saved (image previews may use the local blob).
function buildBgFromWork() {
  if (bgWork.kind === 'gradient') {
    return { kind: 'gradient', config: { angle: bgWork.gradient.angle, stops: currentGradientStops() } };
  }
  if (bgWork.kind === 'color') return { kind: 'color', config: { color: bgWork.color } };
  if (bgWork.kind === 'image') {
    return { kind: 'image', config: {
      url: bgPendingUrl || bgWork.image.url, dim: bgWork.image.dim, blur: bgWork.image.blur,
    } };
  }
  return { kind: 'none', config: {} };
}

function refreshPreview() {
  paintBgLayer(document.getElementById('bg-preview-layer'), buildBgFromWork(), { allowBlob: true });
}

function renderSettingsControls() {
  document.querySelectorAll('#bg-kind-tabs button').forEach(b => b.classList.toggle('active', b.dataset.kind === bgWork.kind));
  ['gradient', 'color', 'image', 'none'].forEach(k =>
    document.getElementById('bg-panel-' + k).classList.toggle('hidden', bgWork.kind !== k));

  const g = bgWork.gradient;
  document.getElementById('bg-c1').value = g.stops[0];
  document.getElementById('bg-c2').value = g.stops[1];
  document.getElementById('bg-c3').value = g.stops[2];
  document.getElementById('bg-c3').disabled = !g.useThird;
  document.getElementById('bg-c3-on').checked = g.useThird;
  document.getElementById('bg-angle').value = g.angle;
  document.getElementById('bg-angle-val').textContent = g.angle + '°';
  document.getElementById('bg-solid').value = bgWork.color;
  document.getElementById('bg-dim').value = bgWork.image.dim;
  document.getElementById('bg-dim-val').textContent = bgWork.image.dim + '%';
  document.getElementById('bg-blur').value = bgWork.image.blur;
  document.getElementById('bg-blur-val').textContent = bgWork.image.blur + ' px';
  document.getElementById('bg-image-info').textContent = bgPendingBlob
    ? `New image ready (${Math.round(bgPendingBlob.size / 1024)} KB)`
    : (bgWork.image.url ? 'Current image kept' : 'No image chosen yet');

  const eff = currentGradientStops().join(',').toLowerCase();
  document.querySelectorAll('#bg-presets .bg-swatch').forEach(b => {
    const pr = BG_PRESETS[Number(b.dataset.index)];
    b.classList.toggle('selected', bgWork.kind === 'gradient' && pr.angle === g.angle && pr.stops.join(',') === eff);
  });
  refreshPreview();
}

function setBgScope(scope) {
  bgScope = scope;
  document.getElementById('bg-scope-default').classList.toggle('active', scope === 'default');
  document.getElementById('bg-scope-chat').classList.toggle('active', scope === 'chat');
  const convo = conversations.find(c => c.conversation_id === activeConvoId);
  document.getElementById('bg-scope-hint').textContent = scope === 'chat'
    ? `Only for the chat with “${convo ? convo.title : 'this chat'}”. Overrides your default.`
    : 'Used for every chat that has no background of its own.';

  const own = bgSettings.get(scopeKeyNow());
  initWorkFrom(own || (scope === 'chat' ? bgSettings.get('default') : null));

  const resetBtn = document.getElementById('bg-reset-btn');
  resetBtn.textContent = scope === 'chat' ? 'Use default' : 'Remove background';
  resetBtn.disabled = !own;
  renderSettingsControls();
}

function openSettings() {
  const hasChat = !!activeConvoId;
  document.getElementById('bg-scope-chat').classList.toggle('hidden', !hasChat);
  setBgScope(hasChat ? 'chat' : 'default');
  document.getElementById('settings-modal').classList.remove('hidden');
}

function closeSettings() {
  document.getElementById('settings-modal').classList.add('hidden');
  if (bgPendingUrl) { try { URL.revokeObjectURL(bgPendingUrl); } catch {} }
  bgPendingBlob = null; bgPendingUrl = null;
}

// ----- image handling -----

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('This image could not be read. Try a JPG, PNG or WebP file.')); };
    img.src = url;
  });
}

// Shrinks and compresses a chosen image so uploads stay small and chats load fast.
async function fileToJpegBlob(file, maxDim = 1600, quality = 0.82) {
  const img = await loadImageFromFile(file);
  const scale = Math.min(1, maxDim / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const g = canvas.getContext('2d');
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, w, h); // transparent PNGs become white, not black
  g.drawImage(img, 0, 0, w, h);
  return new Promise((resolve, reject) =>
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('The image could not be processed.'))), 'image/jpeg', quality));
}

function removeBgFileIfUnused(path) {
  if (!path || typeof path !== 'string' || !path.startsWith(me.id + '/')) return;
  for (const v of bgSettings.values()) if (v.config && v.config.path === path) return; // still used by another scope
  sb.storage.from('backgrounds').remove([path]).then(() => {});
}

// ----- save / reset -----

function setSaveState(busy) {
  const b = document.getElementById('bg-save-btn');
  b.disabled = busy;
  b.textContent = busy ? 'Saving…' : 'Save';
}

async function saveBackground() {
  if (bgSaving || !bgWork) return;
  if (bgScope === 'chat' && !activeConvoId) return;
  const key = scopeKeyNow();
  const bg = buildBgFromWork();
  const previous = bgSettings.get(key);
  let config = bg.config;
  let uploadedPath = null;

  bgSaving = true; setSaveState(true);
  try {
    if (bg.kind === 'image') {
      const dim = bgWork.image.dim, blur = bgWork.image.blur;
      if (bgPendingBlob) {
        const path = `${me.id}/${Date.now()}.jpg`;
        const up = await sb.storage.from('backgrounds').upload(path, bgPendingBlob, { contentType: 'image/jpeg' });
        if (up.error) throw new Error('Upload failed: ' + up.error.message);
        uploadedPath = path;
        const pub = sb.storage.from('backgrounds').getPublicUrl(path);
        config = { url: pub.data.publicUrl, path, dim, blur };
      } else if (bgWork.image.url) {
        config = { url: bgWork.image.url, path: bgWork.image.path, dim, blur };
      } else {
        throw new Error('Please choose an image first.');
      }
    }

    const { error } = await sb.from('chat_backgrounds').upsert(
      { user_id: me.id, scope_key: key, kind: bg.kind, config, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,scope_key' }
    );
    if (error) throw new Error(error.message + ' (did you run schema_v5.sql?)');
    uploadedPath = null; // saved successfully, keep the file

    bgSettings.set(key, { kind: bg.kind, config });
    if (previous && previous.config && previous.config.path && previous.config.path !== config.path) {
      removeBgFileIfUnused(previous.config.path);
    }
    applyChatBackground();
    closeSettings();
    showCallToast('Background saved');
  } catch (e) {
    if (uploadedPath) sb.storage.from('backgrounds').remove([uploadedPath]).then(() => {}); // don't leave orphans
    alert(e.message || String(e));
  } finally {
    bgSaving = false; setSaveState(false);
  }
}

async function resetBackground() {
  if (bgSaving) return;
  const key = scopeKeyNow();
  const previous = bgSettings.get(key);
  if (!previous) return;
  const { error } = await sb.from('chat_backgrounds').delete().eq('user_id', me.id).eq('scope_key', key);
  if (error) { alert(error.message); return; }
  bgSettings.delete(key);
  if (previous.config && previous.config.path) removeBgFileIfUnused(previous.config.path);
  applyChatBackground();
  closeSettings();
  showCallToast(bgScope === 'chat' ? 'Using your default background' : 'Background removed');
}

// ----- wiring -----

(function wireSettings() {
  const $ = id => document.getElementById(id);

  // preset swatches
  const presetBox = $('bg-presets');
  BG_PRESETS.forEach((pr, i) => {
    const b = document.createElement('button');
    b.className = 'bg-swatch';
    b.dataset.index = String(i);
    b.title = pr.name;
    b.setAttribute('aria-label', pr.name + ' gradient');
    b.style.backgroundImage = `linear-gradient(${pr.angle}deg, ${pr.stops.join(', ')})`;
    b.addEventListener('click', () => {
      bgWork.kind = 'gradient';
      bgWork.gradient = {
        angle: pr.angle,
        stops: [pr.stops[0], pr.stops[1], pr.stops[2] || pr.stops[1]],
        useThird: pr.stops.length === 3,
      };
      renderSettingsControls();
    });
    presetBox.appendChild(b);
  });

  $('settings-btn').addEventListener('click', openSettings);
  $('settings-close').addEventListener('click', closeSettings);
  $('bg-cancel-btn').addEventListener('click', closeSettings);
  $('settings-modal').addEventListener('click', e => { if (e.target === $('settings-modal')) closeSettings(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('settings-modal').classList.contains('hidden')) closeSettings();
  });

  $('bg-scope-default').addEventListener('click', () => setBgScope('default'));
  $('bg-scope-chat').addEventListener('click', () => { if (activeConvoId) setBgScope('chat'); });

  document.querySelectorAll('#bg-kind-tabs button').forEach(b =>
    b.addEventListener('click', () => { bgWork.kind = b.dataset.kind; renderSettingsControls(); }));

  [['bg-c1', 0], ['bg-c2', 1], ['bg-c3', 2]].forEach(([id, idx]) =>
    $(id).addEventListener('input', e => { bgWork.gradient.stops[idx] = e.target.value; bgWork.kind = 'gradient'; renderSettingsControls(); }));
  $('bg-c3-on').addEventListener('change', e => { bgWork.gradient.useThird = e.target.checked; renderSettingsControls(); });
  $('bg-angle').addEventListener('input', e => { bgWork.gradient.angle = clampNum(e.target.value, 0, 360, 135); renderSettingsControls(); });
  $('bg-solid').addEventListener('input', e => { bgWork.color = e.target.value; renderSettingsControls(); });
  $('bg-dim').addEventListener('input', e => { bgWork.image.dim = clampNum(e.target.value, 0, 70, 15); renderSettingsControls(); });
  $('bg-blur').addEventListener('input', e => { bgWork.image.blur = clampNum(e.target.value, 0, 12, 0); renderSettingsControls(); });

  $('bg-image-pick').addEventListener('click', () => $('bg-image-input').click());
  $('bg-image-input').addEventListener('change', async e => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) { alert('Please choose an image file.'); return; }
    if (file.size > 25 * 1024 * 1024) { alert('That image is too large (max 25 MB).'); return; }
    $('bg-image-info').textContent = 'Preparing image…';
    try {
      const blob = await fileToJpegBlob(file);
      if (bgPendingUrl) { try { URL.revokeObjectURL(bgPendingUrl); } catch {} }
      bgPendingBlob = blob;
      bgPendingUrl = URL.createObjectURL(blob);
      bgWork.kind = 'image';
      renderSettingsControls();
    } catch (err) {
      alert(err.message || String(err));
      renderSettingsControls();
    }
  });

  $('bg-save-btn').addEventListener('click', saveBackground);
  $('bg-reset-btn').addEventListener('click', resetBackground);
})();

// ---------- v10: Startbildschirm, Befehle, Admin, letzte Nachricht ----------

// Apps: id, label, icon, Platzhalter-Text. Echte Funktionen werden später angebaut.
const APP_TILES = [
  { cmd: 'call',          label: 'Call',          icon: '📞', desc: 'Anrufe starten (in jedem 1:1-Chat verfügbar).' },
  { cmd: 'message',       label: 'Message',       icon: '💬', desc: 'Zu deinen Chats wechseln.', action: 'chats' },
  { cmd: 'musik',         label: 'Musik',         icon: '🎵', desc: 'Musik-Funktion folgt.' },
  { cmd: 'video',         label: 'Video',         icon: '🎬', desc: 'Video-Funktion folgt.' },
  { cmd: 'ai',            label: 'AI',            icon: '✨', desc: 'KI-Funktion folgt.' },
  { cmd: 'mail',          label: 'Mail',          icon: '✉️', desc: 'Mail-Funktion folgt.' },
  { cmd: 'authenticator', label: 'Authenticator', icon: '🔐', desc: 'Authenticator folgt.' },
  { cmd: 'gne',           label: 'GNE',           icon: '🧭', desc: 'GNE folgt.' },
  { cmd: 'maps',          label: 'Maps',          icon: '🗺️', desc: 'Karten-Funktion folgt.' },
  { cmd: 'home',          label: 'Home',          icon: '🏠', desc: 'Smart-Home-Funktion folgt.' },
  { cmd: 'apps',          label: 'Apps',          icon: '🧩', desc: 'Übersicht aller Apps.', action: 'apps' },
  { cmd: 'social',        label: 'Social',        icon: '👥', desc: 'Social-Funktion folgt.' },
];

let isAdmin = false;
let homeShownOnce = false;

// ----- Startbildschirm -----

function renderHomeTiles() {
  const box = document.getElementById('home-tiles');
  box.innerHTML = '';
  APP_TILES.forEach(t => {
    const b = document.createElement('button');
    b.className = 'home-tile';
    b.innerHTML = `<span class="home-tile-icon">${t.icon}</span><span class="home-tile-label">${t.label}</span>`;
    b.addEventListener('click', () => runCommand(t.cmd));
    box.appendChild(b);
  });
}

function showHome() {
  document.getElementById('app').classList.add('hidden');
  document.getElementById('app-page').classList.add('hidden');
  document.getElementById('home-screen').classList.remove('hidden');
}

function showChatsApp() {
  document.getElementById('home-screen').classList.add('hidden');
  document.getElementById('app-page').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
}

document.getElementById('home-open-chats').addEventListener('click', showChatsApp);

// ----- Befehle: ausführen (Kacheln und Eingabe nutzen dieselbe Stelle) -----

function runCommand(cmdRaw) {
  const cmd = String(cmdRaw || '').replace(/^\//, '').trim().toLowerCase();
  const tile = APP_TILES.find(t => t.cmd === cmd);
  if (!tile) return false;

  if (tile.action === 'apps') { showHome(); return true; }
  if (tile.action === 'chats') { showChatsApp(); return true; }
  if (cmd === 'call') { showChatsApp(); showCallHint(); return true; }
  if (cmd === 'authenticator') { showAppPageShell(); openAuthenticator(); return true; }
  if (cmd === 'social') { showAppPageShell(); openSocial(); return true; }
  openAppPage(tile);
  return true;
}

// Zeigt die App-Seite (Kopf + Körper), ohne Platzhalter-Text.
function showAppPageShell() {
  document.getElementById('home-screen').classList.add('hidden');
  document.getElementById('app').classList.add('hidden');
  document.getElementById('app-page').classList.remove('hidden');
}

function showCallHint() {
  showCallToast('Öffne einen 1:1-Chat und tippe auf 📞 oder 🎥 im Kopf.');
}

function openAppPage(tile) {
  document.getElementById('home-screen').classList.add('hidden');
  document.getElementById('app').classList.add('hidden');
  document.getElementById('app-page').classList.remove('hidden');
  document.getElementById('app-page-title').textContent = tile.label;
  document.getElementById('app-page-body').innerHTML =
    `<div class="app-page-card"><div class="app-page-icon">${tile.icon}</div>` +
    `<p>${escapeHtml(tile.desc)}</p>` +
    `<p class="app-page-hint">Tippe unten im Chat auf <b>/${escapeHtml(tile.cmd)}</b> oder nutze die Kachel im Startbildschirm.</p></div>`;
}

document.getElementById('app-page-back').addEventListener('click', showHome);

// ----- Befehls-Vorschlag, wenn man "/" in die Eingabe tippt -----

const cmdSuggest = document.getElementById('cmd-suggest');
input.addEventListener('input', () => {
  const v = input.value;
  if (!v.startsWith('/')) { cmdSuggest.classList.add('hidden'); return; }
  const q = v.slice(1).toLowerCase();
  const matches = APP_TILES.filter(t => t.cmd.startsWith(q));
  cmdSuggest.innerHTML = '';
  matches.forEach(t => {
    const b = document.createElement('button');
    b.className = 'cmd-item';
    b.textContent = `${t.icon} /${t.cmd}`;
    b.addEventListener('mousedown', e => e.preventDefault()); // keep focus in the input
    b.addEventListener('click', () => {
      input.value = '';
      cmdSuggest.classList.add('hidden');
      runCommand(t.cmd);
    });
    cmdSuggest.appendChild(b);
  });
  cmdSuggest.classList.toggle('hidden', matches.length === 0);
});

// Enter mit "/befehl" ausführen, bevor die Nachricht gesendet wird.
// (Wird vor dem normalen send-Handler geprüft.)
input.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.shiftKey) return;
  const v = input.value.trim();
  if (!v.startsWith('/')) return;
  const cmd = v.slice(1).toLowerCase();
  if (APP_TILES.some(t => t.cmd === cmd)) {
    e.preventDefault();
    e.stopImmediatePropagation();
    input.value = '';
    cmdSuggest.classList.add('hidden');
    runCommand(cmd);
  }
}, true);

// ----- Admin: Rechte prüfen, Löschen für Admin sichtbar machen -----

async function loadAdminFlag() {
  const { data } = await sb.from('profiles').select('is_admin').eq('id', me.id).single();
  isAdmin = !!(data && data.is_admin);
}

// Löscht eine Nachricht als "gelöscht" markiert (für alle sichtbar).
async function deleteMessageById(msgId) {
  const { error } = await sb.from('messages')
    .update({ deleted: true, text: null, attachment_url: null })
    .eq('id', msgId);
  if (error) alert('Löschen fehlgeschlagen: ' + error.message);
}

// ----- Letzte Nachricht beim Öffnen automatisch anzeigen -----

// Beim Öffnen eines Chats wird die Nachrichtenliste ganz nach unten gescrollt,
// damit die zuletzt geschriebene Nachricht sichtbar ist (nicht ganz oben).
function jumpToLatest() {
  const el = document.getElementById('messages');
  el.scrollTop = el.scrollHeight;
  requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
  setTimeout(() => { el.scrollTop = el.scrollHeight; }, 120);
}

// Startbildschirm nach Login: wird von afterLogin() aufgerufen (siehe Einbau unten).
async function onLoggedInHome() {
  await loadAdminFlag();
  renderHomeTiles();
  if (!homeShownOnce) {
    homeShownOnce = true;
    showHome();
  }
}

// ---------- v11: Authenticator (TOTP) und Social ----------

// ----- Authenticator -----
// Geheime Schlüssel bleiben nur im Browser (localStorage des Geräts), nie in der Datenbank.

const AUTH_KEY = 'threadline_totp_accounts';

function b32decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = String(input || '').toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) throw new Error('Ungültiger Schlüssel (nur A–Z und 2–7 erlaubt).');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (out.length === 0) throw new Error('Der Schlüssel ist leer.');
  return new Uint8Array(out);
}

async function totpCode(secretB32, digits = 6, period = 30, nowMs = Date.now()) {
  const keyBytes = b32decode(secretB32);
  const counter = Math.floor(nowMs / 1000 / period);
  const buf = new ArrayBuffer(8);
  const view = new DataView(buf);
  // 64-bit big-endian counter (high word 0 is fine until year 2100+)
  view.setUint32(0, Math.floor(counter / 0x100000000));
  view.setUint32(4, counter >>> 0);
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf));
  const offset = sig[sig.length - 1] & 0x0f;
  const bin = ((sig[offset] & 0x7f) << 24) | (sig[offset + 1] << 16) | (sig[offset + 2] << 8) | sig[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

function loadAuthAccounts() {
  try { return JSON.parse(localStorage.getItem(AUTH_KEY) || '[]'); } catch { return []; }
}
function saveAuthAccounts(list) {
  localStorage.setItem(AUTH_KEY, JSON.stringify(list));
}

function openAuthenticator() {
  renderAuthPage();
}

function renderAuthPage() {
  const body = document.getElementById('app-page-body');
  document.getElementById('app-page-title').textContent = 'Authenticator';
  body.innerHTML = `
    <div class="feature-wrap">
      <p class="feature-hint">Hier speicherst du die Einrichtungsschlüssel deiner Zwei-Faktor-Konten. Die Codes entstehen nur auf diesem Gerät.</p>
      <div class="feature-form">
        <input id="auth-name" type="text" placeholder="Name (z. B. GitHub)" maxlength="40">
        <input id="auth-secret" type="text" placeholder="Einrichtungsschlüssel (Base32)" autocomplete="off" spellcheck="false">
        <button id="auth-add" class="feature-btn">Konto hinzufügen</button>
      </div>
      <div id="auth-list"></div>
      <p class="feature-hint feature-warn">Achtung: Die Schlüssel liegen in diesem Browser. Lösche sie nicht ohne Sicherung, sonst verlierst du den Zugang.</p>
    </div>`;
  document.getElementById('auth-add').addEventListener('click', addAuthAccount);
  renderAuthList();
}

async function renderAuthList() {
  const list = document.getElementById('auth-list');
  if (!list) return;
  const accounts = loadAuthAccounts();
  if (accounts.length === 0) { list.innerHTML = '<p class="feature-hint">Noch keine Konten.</p>'; return; }
  list.innerHTML = '';
  for (const acc of accounts) {
    const row = document.createElement('div');
    row.className = 'auth-row';
    row.innerHTML = `
      <div class="auth-meta"><div class="auth-name">${escapeHtml(acc.name)}</div>
      <div class="auth-code" data-id="${escapeHtml(acc.id)}">------</div></div>
      <div class="auth-side"><div class="auth-ring"></div>
      <button class="auth-del" aria-label="Konto löschen">🗑</button></div>`;
    row.querySelector('.auth-del').addEventListener('click', () => {
      if (!confirm(`„${acc.name}“ wirklich löschen? Ohne Schlüssel-Sicherung verlierst du den Zugang.`)) return;
      saveAuthAccounts(loadAuthAccounts().filter(a => a.id !== acc.id));
      renderAuthList();
    });
    list.appendChild(row);
  }
  refreshAuthCodes();
}

async function refreshAuthCodes() {
  const accounts = loadAuthAccounts();
  for (const acc of accounts) {
    const el = document.querySelector(`.auth-code[data-id="${CSS.escape(acc.id)}"]`);
    if (!el) continue;
    try {
      const code = await totpCode(acc.secret);
      el.textContent = code.slice(0, 3) + ' ' + code.slice(3);
    } catch { el.textContent = 'Fehler'; }
  }
  const left = 30 - (Math.floor(Date.now() / 1000) % 30);
  document.querySelectorAll('.auth-ring').forEach(r => r.textContent = left + 's');
}

async function addAuthAccount() {
  const name = document.getElementById('auth-name').value.trim();
  const secret = document.getElementById('auth-secret').value.trim();
  if (!name) { alert('Bitte einen Namen eingeben.'); return; }
  try {
    b32decode(secret);
    await totpCode(secret); // test that it produces a code
  } catch (e) { alert(e.message || 'Ungültiger Schlüssel.'); return; }
  const list = loadAuthAccounts();
  list.push({ id: 'a' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, secret: secret.replace(/\s/g, '').toUpperCase() });
  saveAuthAccounts(list);
  renderAuthPage();
}

setInterval(() => {
  if (document.getElementById('auth-list')) refreshAuthCodes();
}, 1000);

// ----- Social -----

async function openSocial() {
  const body = document.getElementById('app-page-body');
  document.getElementById('app-page-title').textContent = 'Social';
  body.innerHTML = '<div class="feature-wrap"><p class="feature-hint">Lädt…</p></div>';

  const { data: prof } = await sb.from('profiles').select('username, display_name, bio').eq('id', me.id).single();
  const { data: rels } = await sb.from('friendships')
    .select('id, requester_id, addressee_id, status')
    .or(`requester_id.eq.${me.id},addressee_id.eq.${me.id}`);
  const otherIds = [...new Set((rels || []).map(r => r.requester_id === me.id ? r.addressee_id : r.requester_id))];
  const { data: others } = otherIds.length
    ? await sb.from('profiles').select('id, username, display_name').in('id', otherIds)
    : { data: [] };
  const name = id => { const p = (others || []).find(o => o.id === id); return p ? (p.display_name || p.username) : '?'; };

  const accepted = (rels || []).filter(r => r.status === 'accepted');
  const incoming = (rels || []).filter(r => r.status === 'pending' && r.addressee_id === me.id);
  const outgoing = (rels || []).filter(r => r.status === 'pending' && r.requester_id === me.id);

  body.innerHTML = `
    <div class="feature-wrap">
      <div class="social-profile">
        <div class="avatar social-avatar">${initials(prof?.display_name || prof?.username || '?')}</div>
        <div>
          <div class="social-name">${escapeHtml(prof?.display_name || prof?.username || '')}</div>
          <div class="feature-hint">@${escapeHtml(prof?.username || '')}</div>
        </div>
      </div>
      <p class="social-bio">${escapeHtml(prof?.bio || 'Noch keine Beschreibung.')}</p>
      <div class="feature-form">
        <input id="soc-display" type="text" placeholder="Anzeigename" maxlength="40" value="${escapeHtml(prof?.display_name || '')}">
        <textarea id="soc-bio" rows="2" placeholder="Über mich" maxlength="200">${escapeHtml(prof?.bio || '')}</textarea>
        <button id="soc-save" class="feature-btn">Profil speichern</button>
      </div>

      <h3 class="feature-h">Kontakt hinzufügen</h3>
      <div class="feature-form">
        <input id="soc-find" type="text" placeholder="Benutzername suchen…">
        <div id="soc-find-results"></div>
      </div>

      ${incoming.length ? `<h3 class="feature-h">Anfragen</h3>` + incoming.map(r =>
        `<div class="soc-row"><span>${escapeHtml(name(r.requester_id))}</span>
         <button class="feature-btn small" data-accept="${r.id}">Annehmen</button>
         <button class="feature-btn small ghost" data-decline="${r.id}">Ablehnen</button></div>`).join('') : ''}

      ${outgoing.length ? `<h3 class="feature-h">Gesendet</h3>` + outgoing.map(r =>
        `<div class="soc-row"><span>${escapeHtml(name(r.addressee_id))} <i class="feature-hint">wartet</i></span>
         <button class="feature-btn small ghost" data-remove="${r.id}">Zurückziehen</button></div>`).join('') : ''}

      <h3 class="feature-h">Kontakte (${accepted.length})</h3>
      ${accepted.length ? accepted.map(r => {
        const other = r.requester_id === me.id ? r.addressee_id : r.requester_id;
        return `<div class="soc-row"><span>${escapeHtml(name(other))}</span>
          <button class="feature-btn small" data-chat="${other}">Chat</button>
          <button class="feature-btn small ghost" data-remove="${r.id}">Entfernen</button></div>`;
      }).join('') : '<p class="feature-hint">Noch keine Kontakte.</p>'}
    </div>`;

  wireSocial();
}

function wireSocial() {
  document.getElementById('soc-save').addEventListener('click', async () => {
    const display_name = document.getElementById('soc-display').value.trim().slice(0, 40);
    const bio = document.getElementById('soc-bio').value.trim().slice(0, 200);
    const { error } = await sb.from('profiles').update({ display_name: display_name || null, bio: bio || null }).eq('id', me.id);
    if (error) { alert('Speichern fehlgeschlagen: ' + error.message); return; }
    openSocial();
  });

  let t = null;
  document.getElementById('soc-find').addEventListener('input', e => {
    clearTimeout(t);
    const q = e.target.value.trim();
    const box = document.getElementById('soc-find-results');
    if (!q) { box.innerHTML = ''; return; }
    t = setTimeout(async () => {
      const { data: users } = await sb.from('profiles').select('id, username, display_name')
        .ilike('username', `%${q}%`).neq('id', me.id).limit(10);
      box.innerHTML = '';
      (users || []).forEach(u => {
        const row = document.createElement('div');
        row.className = 'soc-row';
        row.innerHTML = `<span>@${escapeHtml(u.username)}</span><button class="feature-btn small">Hinzufügen</button>`;
        row.querySelector('button').addEventListener('click', async () => {
          const { error } = await sb.from('friendships').insert({ requester_id: me.id, addressee_id: u.id, status: 'pending' });
          if (error) { alert(error.message.includes('duplicate') ? 'Schon angefragt oder befreundet.' : error.message); return; }
          openSocial();
        });
        box.appendChild(row);
      });
      if (!users || users.length === 0) box.innerHTML = '<p class="feature-hint">Niemand gefunden.</p>';
    }, 250);
  });

  document.querySelectorAll('[data-accept]').forEach(b => b.addEventListener('click', async () => {
    await sb.from('friendships').update({ status: 'accepted' }).eq('id', b.dataset.accept);
    openSocial();
  }));
  document.querySelectorAll('[data-decline],[data-remove]').forEach(b => b.addEventListener('click', async () => {
    const id = b.dataset.decline || b.dataset.remove;
    if (!confirm('Wirklich?')) return;
    await sb.from('friendships').delete().eq('id', id);
    openSocial();
  }));
  document.querySelectorAll('[data-chat]').forEach(b => b.addEventListener('click', async () => {
    const otherId = b.dataset.chat;
    const { data: prof } = await sb.from('profiles').select('username').eq('id', otherId).single();
    const convoId = await startOrFindConversation(otherId);
    await loadConversations();
    showChatsApp();
    openConversation(convoId, false, otherId, prof?.username || '?');
  }));
}


// ---------- Mobile navigation ----------

document.getElementById('back-to-list-btn').addEventListener('click', ()=>{
  document.getElementById('app').classList.remove('mobile-chat-open');
});

tryResume();
