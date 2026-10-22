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

// hCaptcha callbacks (wired via data-callback / data-expired-callback on the widget)
let hcaptchaToken = null;
function onHcaptchaSuccess(token) { hcaptchaToken = token; }
function onHcaptchaExpired() { hcaptchaToken = null; }
window.onHcaptchaSuccess = onHcaptchaSuccess;
window.onHcaptchaExpired = onHcaptchaExpired;

async function verifyCaptchaToken(token) {
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/verify-captcha`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'apikey': SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ token }),
    });
    const data = await res.json();
    return !!data.success;
  } catch {
    return false;
  }
}

document.getElementById('signup-form').addEventListener('submit', async e=>{
  e.preventDefault();
  const username = document.getElementById('signup-username').value.trim();
  const email = document.getElementById('signup-email').value.trim();
  const password = document.getElementById('signup-password').value;
  const errEl = document.getElementById('signup-error');
  errEl.textContent = '';

  if (username.length < 2) { errEl.textContent = 'Username must be at least 2 characters'; return; }

  if (!hcaptchaToken) {
    errEl.textContent = 'Please complete the captcha';
    return;
  }

  const captchaOk = await verifyCaptchaToken(hcaptchaToken);
  if (window.hcaptcha) window.hcaptcha.reset(); // tokens are one-time use — always reset after checking
  hcaptchaToken = null;
  if (!captchaOk) {
    errEl.textContent = 'Captcha verification failed, please try again';
    return;
  }

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
  initNotifications();
  maybeShowNotificationPrompt();

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
  scrollToBottom();
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
  const actions = (!msg.deleted && msg.sender_id === me.id) ? `
    <div class="msg-actions">
      ${msg.attachment_type ? '' : `<button class="msg-action-btn" data-action="edit">✎</button>`}
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
    if (!confirm('Delete this message?')) return;
    await sb.from('messages').update({ deleted:true, text:null, attachment_url:null }).eq('id', msg.id);
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

// ---------- Mobile navigation ----------

document.getElementById('back-to-list-btn').addEventListener('click', ()=>{
  document.getElementById('app').classList.remove('mobile-chat-open');
});

tryResume();
