const initials = n => n.split(' ').map(p=>p[0]).join('').slice(0,2).toUpperCase();
const escapeHtml = str => { const d = document.createElement('div'); d.textContent = str; return d.innerHTML; };
const fmtTime = iso => new Date(iso).toLocaleTimeString([], { hour:'numeric', minute:'2-digit' });

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let me = null; // { id, username, email }
let conversations = [];
let activeConvoId = null;
let activeIsGroup = false;
let activeMembers = []; // [{id, username}] for the open conversation
let onlineUsers = new Set();
let typingSendThrottle = 0;

let messageChannel, reactionChannel, presenceChannel, typingChannel, memberChannel;

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
  [messageChannel, reactionChannel, presenceChannel, typingChannel, memberChannel].forEach(c=> c && sb.removeChannel(c));
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

  const params = new URLSearchParams(location.search);
  const inviteCode = params.get('invite');
  if (inviteCode) await joinViaInvite(inviteCode);
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
    .subscribe();

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

  if (isGroup) {
    const { data: memberRows } = await sb
      .from('conversation_members').select('user_id').eq('conversation_id', conversationId);
    const ids = (memberRows||[]).map(r=>r.user_id);
    const { data: profiles } = await sb.from('profiles').select('id, username').in('id', ids);
    activeMembers = profiles || [];
    document.getElementById('chat-head-status').textContent = `${activeMembers.length} members`;
  } else {
    activeMembers = [];
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

  row.innerHTML = `
    <div>
      ${senderLabel}
      <div class="bubble">
        ${bubbleInner}
        <span class="msg-meta"><span class="msg-time">${fmtTime(msg.created_at)}</span>${editedTag}</span>
      </div>
      <div class="reactions-row" data-reactions-for="${msg.id}"></div>
      <div class="bubble-toolbar">${reactBtn}${actions}</div>
    </div>
  `;

  row.querySelectorAll('.msg-action-btn').forEach(btn=>{
    btn.addEventListener('click', ()=> handleMsgAction(btn.dataset.action, msg));
  });
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

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio:true });
    recorder = new MediaRecorder(stream);
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
  } catch {
    alert('Microphone access is needed to record a voice message.');
  }
}

function stopRecording(send) {
  if (!recorder) return;
  clearInterval(recordingTimer);
  voiceRecordingUI.classList.add('hidden');
  voiceBtn.classList.remove('recording');
  const durationSec = Math.round((Date.now()-recordingStart)/1000);

  recorder.onstop = async () => {
    if (send && recordedChunks.length > 0 && activeConvoId) {
      const blob = new Blob(recordedChunks, { type:'audio/webm' });
      const file = new File([blob], `voice_${Date.now()}.webm`, { type:'audio/webm' });
      const path = `${activeConvoId}/${file.name}`;
      const { error: upErr } = await sb.storage.from('attachments').upload(path, file);
      if (upErr) { alert('Upload failed: ' + upErr.message); return; }
      const { data: urlData } = sb.storage.from('attachments').getPublicUrl(path);
      await sb.from('messages').insert({
        conversation_id: activeConvoId,
        sender_id: me.id,
        attachment_url: urlData.publicUrl,
        attachment_type: 'voice',
        attachment_duration_sec: durationSec,
      });
    }
  };
  recorder.stop();
}

// ---------- Group invite button ----------

document.getElementById('group-invite-btn').addEventListener('click', generateInviteLink);

tryResume();
