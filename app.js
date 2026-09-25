const initials = n => n.split(' ').map(p=>p[0]).join('').slice(0,2).toUpperCase();
const escapeHtml = str => { const d = document.createElement('div'); d.textContent = str; return d.innerHTML; };
const fmtTime = iso => new Date(iso).toLocaleTimeString([], { hour:'numeric', minute:'2-digit' });

const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

let me = null; // { id, username, email }
let conversations = [];
let activeConvoId = null;
let activeOtherId = null;
let messageChannel = null;

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

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
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

  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) { errEl.textContent = translateError(error.message); return; }

  if (!data.user) {
    errEl.textContent = 'Check your email to confirm your account, then log in.';
    return;
  }

  const { error: profileError } = await supabase.from('profiles').insert({
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
  if (messageChannel) supabase.removeChannel(messageChannel);
  await supabase.auth.signOut();
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
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.user) {
    await afterLogin(session.user);
  } else {
    document.getElementById('auth-screen').classList.remove('hidden');
  }
}

async function afterLogin(user, knownUsername) {
  let username = knownUsername;
  if (!username) {
    const { data: profile } = await supabase.from('profiles').select('username').eq('id', user.id).single();
    username = profile?.username || user.email;
  }
  me = { id: user.id, username, email: user.email };

  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('me-username').textContent = '@' + me.username;

  subscribeToMessages();
  loadConversations();
}

// ---------- Realtime subscription ----------

function subscribeToMessages() {
  messageChannel = supabase
    .channel('messages-listen')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, payload=>{
      handleIncomingMessage(payload.new);
    })
    .subscribe();
}

function handleIncomingMessage(msg) {
  const involvesMe = conversations.some(c => c.conversation_id === msg.conversation_id) || msg.sender_id === me.id;
  if (msg.conversation_id === activeConvoId) {
    appendBubble(msg);
    scrollToBottom();
    if (msg.sender_id !== me.id) markRead(msg.conversation_id);
  }
  loadConversations();
}

// ---------- Conversations list ----------

async function loadConversations() {
  const { data: convos, error } = await supabase
    .from('conversations')
    .select('id, user_a, user_b')
    .or(`user_a.eq.${me.id},user_b.eq.${me.id}`);

  if (error || !convos) { conversations = []; renderConversations(); return; }

  const enriched = await Promise.all(convos.map(async c=>{
    const otherId = c.user_a === me.id ? c.user_b : c.user_a;
    const { data: profile } = await supabase.from('profiles').select('username').eq('id', otherId).single();
    const { data: lastMsgs } = await supabase
      .from('messages').select('text, created_at')
      .eq('conversation_id', c.id).order('created_at', { ascending:false }).limit(1);
    const { count: unread } = await supabase
      .from('messages').select('id', { count:'exact', head:true })
      .eq('conversation_id', c.id).eq('read', false).neq('sender_id', me.id);

    return {
      conversation_id: c.id,
      other_id: otherId,
      other_username: profile?.username || '(unknown)',
      last_text: lastMsgs?.[0]?.text || null,
      last_at: lastMsgs?.[0]?.created_at || null,
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
    div.innerHTML = `
      <div class="avatar">${initials(c.other_username)}</div>
      <div class="contact-meta">
        <div class="contact-name">${escapeHtml(c.other_username)}</div>
        <div class="contact-preview">${c.last_text ? escapeHtml(c.last_text) : 'Say hello'}</div>
      </div>
      ${c.unread > 0 ? `<div class="unread-badge">${c.unread}</div>` : `<div class="contact-time">${c.last_at ? fmtTime(c.last_at) : ''}</div>`}
    `;
    div.addEventListener('click', ()=> openConversation(c.conversation_id, c.other_id, c.other_username));
    el.appendChild(div);
  });
}

// ---------- User search / start new chat ----------

const searchInput = document.getElementById('user-search');
let searchDebounce = null;
searchInput.addEventListener('input', ()=>{
  clearTimeout(searchDebounce);
  const q = searchInput.value.trim();
  const resultsEl = document.getElementById('user-results');
  if (!q) { resultsEl.innerHTML = ''; return; }
  searchDebounce = setTimeout(async ()=>{
    const { data: users } = await supabase
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
        openConversation(convoId, u.id, u.username);
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

  const { data: existing } = await supabase
    .from('conversations').select('id')
    .eq('user_a', a).eq('user_b', b).maybeSingle();

  if (existing) return existing.id;

  const { data: created, error } = await supabase
    .from('conversations').insert({ user_a: a, user_b: b }).select('id').single();

  if (error) {
    // race condition: someone else created it between our check and insert
    const { data: retry } = await supabase
      .from('conversations').select('id').eq('user_a', a).eq('user_b', b).single();
    return retry.id;
  }
  return created.id;
}

// ---------- Active conversation ----------

async function openConversation(conversationId, otherId, otherUsername) {
  activeConvoId = conversationId;
  activeOtherId = otherId;

  document.getElementById('empty-state').classList.add('hidden');
  document.getElementById('chat-active').classList.remove('hidden');
  document.getElementById('chat-head-name').textContent = '@' + otherUsername;
  document.getElementById('chat-head-avatar').textContent = initials(otherUsername);

  renderConversations();

  const { data: msgs } = await supabase
    .from('messages').select('*')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending:true });

  const container = document.getElementById('messages');
  container.innerHTML = '';
  (msgs || []).forEach(appendBubble);
  scrollToBottom();

  markRead(conversationId);
  loadConversations();
}

async function markRead(conversationId) {
  await supabase.from('messages')
    .update({ read:true })
    .eq('conversation_id', conversationId)
    .neq('sender_id', me.id)
    .eq('read', false);
}

function appendBubble(msg) {
  const row = document.createElement('div');
  row.className = 'msg-row ' + (msg.sender_id === me.id ? 'me' : 'them');
  row.innerHTML = `
    <div>
      <div class="bubble">${escapeHtml(msg.text)}</div>
      <div class="msg-time">${fmtTime(msg.created_at)}</div>
    </div>
  `;
  document.getElementById('messages').appendChild(row);
}

function scrollToBottom() {
  const el = document.getElementById('messages');
  el.scrollTop = el.scrollHeight;
}

// ---------- Composer ----------

const input = document.getElementById('msg-input');
const sendBtn = document.getElementById('send-btn');

async function send() {
  const text = input.value.trim();
  if (!text || !activeConvoId) return;
  input.value = '';
  input.style.height = 'auto';

  const { error } = await supabase.from('messages').insert({
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
});

tryResume();
