// Pazhampori chat: the page itself. Reads state from a backend (Supabase or
// demo) and draws it. All text from people is inserted with textContent.
(function () {
  const PZ = window.PZ;
  const cfg = window.PZ_CONFIG || {};
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  };

  const ICON_COLORS = { '#': '#f08a24', '*': '#29b6d6', '♬': '#4aa3ff', '@': '#4aa3ff', '?': '#a066ff',
    '♥': '#ff3355', '!': '#ff9b2a', '~': '#12c08a', '$': '#e6c200', '%': '#e0338f' };
  const ICONS = Object.keys(ICON_COLORS);
  const NAME_COLORS = ['#e0338f', '#8a2be2', '#1e6fe0', '#12a07a', '#e0661a', '#1ba3bd', '#b8860b', '#c2187a', '#5c9e1e', '#e6c200'];

  let backend = null;
  let entered = false;
  const st = {
    meId: null,
    profiles: new Map(),
    rooms: new Map(),
    members: new Map(),          // roomId -> Set(userId)
    requests: new Map(),         // id -> friend request
    settings: Object.assign({}, PZ.DEFAULT_SETTINGS),
    presence: {},
    presenceSynced: false,
    current: null,
    msgs: new Map(),             // roomId -> messages (loaded rooms only)
    local: new Map(),            // roomId -> local-only lines ("signed on")
    unread: new Map(),
    peopleTab: 'all',
    search: '',
    lag: null,
    conn: 'trying',
    typing: false,
    typingTimer: null,
    lastActive: Date.now(),
    pendingFile: null
  };

  // ---------------------------------------------------------------- helpers
  const me = () => st.profiles.get(st.meId);
  const room = () => st.rooms.get(st.current);
  const globalRoom = () => [...st.rooms.values()].find((r) => r.kind === 'global');
  const isMemberOf = (roomId) => {
    const r = st.rooms.get(roomId);
    if (!r) return false;
    if (r.kind === 'global') return true;
    const s = st.members.get(roomId);
    return !!(s && s.has(st.meId));
  };
  const memberCount = (r) => r.kind === 'global' ? st.profiles.size : (st.members.get(r.id) || new Set()).size;
  const nameOf = (id) => { const p = st.profiles.get(id); return p ? p.username : 'someone'; };
  const colorOf = (id) => { const p = st.profiles.get(id); return p && /^#[0-9a-f]{6}$/i.test(p.color) ? p.color : '#9a9a9a'; };
  const fmtTime = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const fmtNum = (n) => Number(n || 0).toLocaleString('en-US');
  const secsLeft = (t) => t ? Math.max(0, Math.ceil((Date.parse(t) - Date.now()) / 1000)) : 0;
  const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  const hostFor = (id) => { let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) % 97; return `dialup-${h + 2}.pazhampori.net`; };

  function dmPartner(r) {
    const s = st.members.get(r.id);
    if (s) for (const u of s) if (u !== st.meId) return u;
    if (r.dm_key) return r.dm_key.split(':').find((x) => x !== st.meId) || null;
    return null;
  }
  function dmRoomWith(userId) {
    for (const r of st.rooms.values()) if (r.kind === 'dm' && dmPartner(r) === userId) return r;
    return null;
  }
  function relation(userId) {
    for (const r of st.requests.values()) {
      const pair = (r.from_user === st.meId && r.to_user === userId) || (r.from_user === userId && r.to_user === st.meId);
      if (!pair) continue;
      if (r.status === 'accepted') return { kind: 'friends', req: r };
      if (r.status === 'pending') return { kind: r.to_user === st.meId ? 'incoming' : 'outgoing', req: r };
      return { kind: 'none', req: r };
    }
    return { kind: 'none' };
  }
  function presenceOf(id) {
    const p = st.presence[id];
    if (!p) return { state: 'offline' };
    const idleMin = p.active_at ? Math.max(0, Math.floor((Date.now() - p.active_at) / 60000)) : 0;
    if (p.typing) return { state: 'typing', idleMin: 0, p };
    if (p.away) return { state: 'away', idleMin, p };
    return { state: 'online', idleMin, p };
  }
  const onlineIds = () => Object.keys(st.presence).filter((id) => st.profiles.has(id));

  function limits() {
    const r = room();
    const dm = r && r.kind === 'dm';
    return {
      dm,
      words: dm ? st.settings.max_words_friends : st.settings.max_words_public,
      chars: dm ? st.settings.max_chars_friends : st.settings.max_chars_public
    };
  }

  function note(text, kind) {
    const n = $('composer-note');
    n.textContent = text || '';
    n.className = 'composer-note' + (kind ? ' is-' + kind : '');
  }

  // ---------------------------------------------------------------- rooms
  function roomLabel(r) {
    if (r.kind === 'global') return 'Global chat';
    if (r.kind === 'dm') return '@' + nameOf(dmPartner(r));
    return r.name;
  }

  function renderRooms() {
    const list = $('room-list');
    list.textContent = '';
    const q = st.search.trim().toLowerCase();
    const match = (r) => !q || roomLabel(r).toLowerCase().includes(q);
    const all = [...st.rooms.values()];
    const g = all.find((r) => r.kind === 'global');
    const groups = all.filter((r) => r.kind === 'group').sort((a, b) => a.name.localeCompare(b.name));
    const fav = groups.filter((r) => isMemberOf(r.id) && match(r));
    const exp = groups.filter((r) => !isMemberOf(r.id) && match(r));

    if (g && match(g)) list.append(roomItem(g));
    if (fav.length) { list.append(el('div', 'room-section', 'FAVORITES')); fav.forEach((r) => list.append(roomItem(r))); }
    if (exp.length) { list.append(el('div', 'room-section', 'EXPLORE')); exp.forEach((r) => list.append(roomItem(r))); }
    if (!list.children.length) list.append(el('p', 'room-empty', q ? 'No rooms match.' : 'No rooms yet.'));
  }

  function roomItem(r) {
    const b = el('button', 'room-item');
    b.type = 'button';
    b.dataset.room = r.id;
    if (r.id === st.current) b.classList.add('is-current');
    const joined = isMemberOf(r.id);
    if (!joined) b.classList.add('is-unjoined');
    let icon;
    if (r.kind === 'global') {
      icon = el('span', 'room-icon room-icon-globe');
      icon.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.3" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M1.8 8h12.4M8 1.7c2 2 2 10.6 0 12.6M8 1.7c-2 2-2 10.6 0 12.6" fill="none" stroke="currentColor" stroke-width="1.2"/></svg>';
    } else {
      icon = el('span', 'room-icon', r.icon);
      icon.style.color = ICON_COLORS[r.icon] || '#f08a24';
    }
    const name = el('span', 'room-name', roomLabel(r));
    const unread = st.unread.get(r.id) || 0;
    const count = el('span', 'room-count' + (unread ? ' is-unread' : ''), unread ? String(unread) : String(memberCount(r)));
    count.title = unread ? `${unread} new` : `${memberCount(r)} members`;
    b.append(icon, name, count);
    b.title = joined ? roomLabel(r) : `${roomLabel(r)}: double-click to join`;
    b.addEventListener('click', () => { openRoom(r.id); closeOverlays(); });
    b.addEventListener('dblclick', () => { if (!joined) joinRoom(r.id); });
    return b;
  }

  function flashRoom(roomId) {
    const b = document.querySelector(`.room-item[data-room="${CSS.escape(roomId)}"]`);
    if (!b) return;
    b.classList.remove('flash'); void b.offsetWidth; b.classList.add('flash');
  }

  // ---------------------------------------------------------------- chat
  async function openRoom(roomId) {
    if (!st.rooms.has(roomId)) return;
    st.current = roomId;
    st.unread.delete(roomId);
    note('');
    renderRooms(); renderHead(); renderComposer(); renderPeople();
    const joined = isMemberOf(roomId);
    $('join-prompt').hidden = joined;
    $('composer').hidden = !joined;
    const r = room();
    if (!joined) {
      $('join-prompt-text').textContent = `You're not in #${r.name} yet. Join to read and post.`;
      $('messages').textContent = '';
      $('messages').append(el('p', 'empty-note', `#${r.name} has ${memberCount(r)} member${memberCount(r) === 1 ? '' : 's'}.`));
      pushPresence();
      return;
    }
    if (!st.msgs.has(roomId)) {
      $('messages').textContent = '';
      $('messages').append(el('p', 'empty-note', 'Dialing in…'));
      try {
        const rows = await backend.loadMessages(roomId);
        const had = st.msgs.get(roomId) || [];
        const ids = new Set(rows.map((m) => m.id));
        st.msgs.set(roomId, rows.concat(had.filter((m) => !ids.has(m.id))));
      } catch (e) {
        if (st.current === roomId) { $('messages').textContent = ''; $('messages').append(el('p', 'empty-note', PZ.friendlyError(e))); }
        return;
      }
    }
    if (st.current === roomId) { renderMessages(); $('msg-input').focus({ preventScroll: true }); }
    pushPresence();
  }

  function renderHead() {
    const r = room();
    if (!r) return;
    $('room-title').textContent = r.kind === 'global' ? 'Global Chat' : r.kind === 'dm' ? '@' + nameOf(dmPartner(r)) : '#' + r.name;
    const online = onlineIds();
    const stack = $('avatar-stack');
    stack.textContent = '';
    online.slice(0, 3).forEach((id) => stack.append(avatar(id, 'avatar-sm')));
    $('online-count').textContent = `${online.length} ${online.length === 1 ? 'person is' : 'people are'} online`;
    const msgs = st.msgs.get(r.id) || [];
    const d = new Date();
    const date = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${String(d.getFullYear()).slice(2)}`;
    const count = msgs.filter((m) => m.kind !== 'system').length;
    if (r.kind === 'dm') {
      $('conv-label').textContent = `Private chat with ${nameOf(dmPartner(r))}`;
      $('conv-meta').textContent = `${date} • ${st.settings.max_words_friends} words max • no images`;
    } else {
      $('conv-label').textContent = 'Live conversation';
      $('conv-meta').textContent = `${date} • ${count} message${count === 1 ? '' : 's'}`;
    }
  }

  function avatar(id, cls) {
    const a = el('span', 'avatar ' + (cls || ''), (nameOf(id)[0] || '?').toUpperCase());
    a.style.background = colorOf(id);
    a.setAttribute('aria-hidden', 'true');
    return a;
  }

  function systemText(m, r) {
    const who = nameOf(m.user_id);
    if (m.body === 'WIPE') return `*** ${fmtNum(st.settings.wipe_at_words)} words reached. Global chat and every group start over from a blank page. ***`;
    if (m.body === 'CREATED') return `★ ${who} created #${r ? r.name : 'this room'}`;
    if (m.body === 'JOINED') return `★ ${who} has entered #${r ? r.name : 'this room'} from ${hostFor(m.user_id)}`;
    return `★ ${m.body}`;
  }

  function messageRow(m, flash) {
    const r = st.rooms.get(m.room_id);
    if (m.kind === 'system' || m.kind === 'local') {
      const s = el('div', 'sys' + (m.body === 'WIPE' ? ' sys-wipe' : ''), m.kind === 'local' ? m.body : systemText(m, r));
      return s;
    }
    const p = st.profiles.get(m.user_id);
    const row = el('div', 'msg');
    if (p && p.is_admin) row.classList.add('is-op');
    if (flash) row.classList.add('flash');
    const who = el('div', 'who');
    const name = el('span', 'name', p ? p.username : 'someone');
    name.style.color = colorOf(m.user_id);
    const words = m.word_count || 0;
    const meta = el('span', 'meta', `${fmtTime(m.created_at)} | ${m.kind === 'image' ? 'image' + (words ? ` + ${words} word${words === 1 ? '' : 's'}` : '') : `${words} word${words === 1 ? '' : 's'}`}`);
    who.append(name, meta);
    const body = el('div', 'body');
    if (m.kind === 'image' && m.image_path) {
      const img = el('img', 'chat-img');
      img.alt = `Image from ${p ? p.username : 'someone'}`;
      img.loading = 'lazy';
      backend.imageUrl(m.image_path).then((u) => { img.src = u; }).catch(() => { img.replaceWith(el('span', 'img-missing', '[image unavailable]')); });
      body.append(img);
      if (m.body) body.append(el('div', 'caption', m.body));
    } else {
      body.textContent = m.body;
    }
    row.append(who, body);
    return row;
  }

  function combined(roomId) {
    const msgs = st.msgs.get(roomId) || [];
    const loc = st.local.get(roomId) || [];
    if (!loc.length) return msgs;
    return msgs.concat(loc).sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  }

  function renderMessages() {
    const box = $('messages');
    box.textContent = '';
    const list = combined(st.current);
    if (!list.length) box.append(el('p', 'empty-note', 'No messages yet. Say hi.'));
    list.forEach((m) => box.append(messageRow(m, false)));
    box.scrollTop = box.scrollHeight;
    renderHead();
  }

  function appendRow(m, flash) {
    const box = $('messages');
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
    const empty = box.querySelector('.empty-note');
    if (empty) empty.remove();
    box.append(messageRow(m, flash));
    if (nearBottom || m.user_id === st.meId) box.scrollTop = box.scrollHeight;
  }

  function addMessage(m) {
    const r = st.rooms.get(m.room_id);
    if (m.kind === 'system' && m.body === 'WIPE') return handleWipe(m);
    if (st.msgs.has(m.room_id)) {
      const list = st.msgs.get(m.room_id);
      if (list.some((x) => x.id === m.id)) return;
      list.push(m);
      if (list.length > 400) list.splice(0, list.length - 400);
      if (m.room_id === st.current) { appendRow(m, m.user_id !== st.meId); renderHead(); return; }
    }
    if (r && isMemberOf(r.id) && m.user_id !== st.meId && m.room_id !== st.current && m.kind !== 'system') {
      st.unread.set(m.room_id, (st.unread.get(m.room_id) || 0) + 1);
      if (r.kind === 'dm') renderPeople();
      renderRooms();
      flashRoom(m.room_id);
    }
  }

  function handleWipe(m) {
    for (const [id, list] of st.msgs) {
      const r = st.rooms.get(id);
      if (r && r.kind !== 'dm') list.length = 0;
    }
    for (const id of [...st.unread.keys()]) { const r = st.rooms.get(id); if (r && r.kind !== 'dm') st.unread.delete(id); }
    const g = globalRoom();
    if (g && st.msgs.has(g.id)) st.msgs.get(g.id).push(m);
    st.settings.total_words = 0;
    const r = room();
    if (r && r.kind !== 'dm') renderMessages();
    renderRooms(); renderStatus();
  }

  // ---------------------------------------------------------------- composer
  function lockState() {
    const p = me();
    if (!p) return null;
    const img = secsLeft(p.image_locked_until);
    const spam = secsLeft(p.muted_until);
    if (img >= spam && img > 0) return { kind: 'image', secs: img };
    if (spam > 0) return { kind: 'spam', secs: spam };
    return null;
  }

  function renderComposer() {
    const input = $('msg-input');
    const lim = limits();
    const words = PZ.countWords(input.value);
    const wc = $('word-count');
    wc.textContent = `${words}/${lim.words}`;
    wc.classList.toggle('is-over', words > lim.words || input.value.trim().length > lim.chars);
    $('img-btn').hidden = lim.dm;
    const lock = lockState();
    const locked = !!lock;
    input.disabled = locked;
    $('btn-send').disabled = locked;
    $('img-input').disabled = locked;
    $('img-btn').classList.toggle('is-disabled', locked);
    if (lock) {
      input.placeholder = lock.kind === 'image'
        ? `Image cooldown: ${mmss(lock.secs)} until you can send again`
        : `Flood control: wait ${mmss(lock.secs)}`;
    } else {
      input.placeholder = lim.dm ? `message ${nameOf(dmPartner(room()))}…` : 'say something…';
    }
    const n = $('composer-note');
    if (!lock && !n.classList.contains('is-error') && !n.classList.contains('is-ok')) {
      note(lim.dm
        ? 'Friend chat: longer messages, no images.'
        : `Rules: ${st.settings.max_words_public} words per message • ${st.settings.spam_count} messages a minute max • sending an image locks you for ${Math.round(st.settings.image_lock_seconds / 60)} min`);
    }
  }

  async function send(file) {
    const r = room();
    if (!r) return;
    const input = $('msg-input');
    const text = input.value.trim();
    const lim = limits();
    const words = PZ.countWords(text);
    if (!file && !words) return;
    if (words > lim.words) return note(`That's ${words} words. This room allows ${lim.words}.`, 'error');
    if (text.length > lim.chars) return note(`That's ${text.length} characters. This room allows ${lim.chars}.`, 'error');
    const lock = lockState();
    if (lock) return note(PZ.ERRORS[lock.kind === 'image' ? 'IMAGE_LOCKED' : 'SPAM_WAIT'], 'error');
    $('btn-send').disabled = true;
    try {
      const res = await backend.sendMessage(r.id, text, file || null);
      input.value = '';
      autosize();
      stopTyping();
      note('');
      if (res.wiped) {
        const g = globalRoom();
        handleWipe({ id: 'wipe-' + res.id, room_id: g && g.id, user_id: null, kind: 'system', body: 'WIPE', created_at: new Date().toISOString() });
      } else {
        addMessage({ id: res.id, room_id: r.id, user_id: st.meId, kind: file ? 'image' : 'text', body: text,
          image_path: res.path || null, word_count: words, created_at: new Date().toISOString() });
        if (r.kind !== 'dm') st.settings.total_words = Number(st.settings.total_words) + words;
      }
      renderStatus();
      markActive();
    } catch (e) {
      note(PZ.friendlyError(e), 'error');
    } finally {
      renderComposer();
      if (!lockState()) input.focus({ preventScroll: true });
    }
  }

  function autosize() {
    const t = $('msg-input');
    t.style.height = 'auto';
    t.style.height = Math.min(t.scrollHeight, 140) + 'px';
  }

  function startTyping() {
    if (!st.typing) { st.typing = true; pushPresence(); }
    clearTimeout(st.typingTimer);
    st.typingTimer = setTimeout(stopTyping, 3000);
  }
  function stopTyping() {
    clearTimeout(st.typingTimer);
    if (st.typing) { st.typing = false; pushPresence(); }
  }

  function renderTyping() {
    const names = Object.values(st.presence)
      .filter((p) => p && p.typing && p.room_id === st.current && p.user_id !== st.meId && st.profiles.has(p.user_id))
      .map((p) => nameOf(p.user_id));
    const bar = $('typing-bar');
    bar.classList.toggle('is-idle', !names.length);
    $('typing-text').textContent = !names.length ? 'nobody is typing'
      : names.length === 1 ? `${names[0]} is typing`
      : names.length === 2 ? `${names[0]} and ${names[1]} are typing`
      : `${names.length} people are typing`;
  }

  // ---------------------------------------------------------------- people
  function renderPeople() {
    const list = $('people-list');
    list.textContent = '';
    const ids = [...st.profiles.keys()];
    const incoming = [...st.requests.values()].filter((r) => r.status === 'pending' && r.to_user === st.meId && st.profiles.has(r.from_user));
    const rank = { typing: 0, online: 0, away: 1, offline: 2 };
    const byPresence = (a, b) => (rank[presenceOf(a).state] - rank[presenceOf(b).state]) || nameOf(a).localeCompare(nameOf(b));
    const ops = ids.filter((id) => st.profiles.get(id).is_admin).sort(byPresence);

    let dmUnread = 0;
    for (const r of st.rooms.values()) if (r.kind === 'dm') dmUnread += st.unread.get(r.id) || 0;
    const fb = $('friends-badge');
    const badgeCount = incoming.length + dmUnread;
    fb.hidden = !badgeCount; fb.textContent = String(badgeCount);
    const pb = $('people-badge');
    pb.hidden = !badgeCount; pb.textContent = String(badgeCount);

    ops.forEach((id) => list.append(personRow(id)));
    if (st.peopleTab === 'all') {
      ids.filter((id) => !st.profiles.get(id).is_admin).sort(byPresence).forEach((id) => list.append(personRow(id)));
    } else {
      if (incoming.length) {
        const banner = el('div', 'req-banner');
        banner.append(el('span', null, 'New friend requests'), el('span', 'req-count', String(incoming.length).padStart(2, '0')));
        list.append(banner);
        incoming.forEach((r) => list.append(personRow(r.from_user, r)));
      }
      const friends = ids.filter((id) => !st.profiles.get(id).is_admin && relation(id).kind === 'friends').sort(byPresence);
      friends.forEach((id) => list.append(personRow(id)));
      if (!friends.length && !incoming.length) {
        list.append(el('p', 'people-empty', 'No friends yet. Press "+ Add Friend" next to someone in ALL. They have to accept before you can chat.'));
      }
    }
  }

  function personRow(id, incomingReq) {
    const p = st.profiles.get(id);
    const pr = presenceOf(id);
    const rel = id === st.meId ? { kind: 'me' } : relation(id);
    const row = el('div', 'person' + (p.is_admin ? ' is-op' : '') + (pr.state === 'offline' ? ' is-offline' : ''));
    const av = avatar(id, 'avatar-lg');
    const info = el('div', 'person-info');
    const top = el('div', 'person-top');
    const name = el('span', 'person-name', p.username);
    name.style.color = colorOf(id);
    top.append(name);
    if (p.is_admin) top.append(el('span', 'op-tag', '[OP]'));
    if (id === st.meId) top.append(el('span', 'you-tag', '(you)'));
    const status = el('div', 'person-status is-' + pr.state,
      pr.state === 'typing' ? '● typing...' : pr.state === 'online' ? (p.is_admin ? '● moderating' : '● online') : pr.state === 'away' ? '○ away' : 'offline');
    const bits = [p.modem === 'T1' ? 'T1 line' : p.modem];
    if (p.status_text) bits.push(p.status_text);
    if (pr.state !== 'offline') bits.push(`${pr.idleMin} min idle`);
    const meta = el('div', 'person-meta', bits.join(' • '));
    info.append(top, status, meta);
    row.append(av, info);

    const act = el('div', 'person-act');
    if (incomingReq) {
      const acc = el('button', 'btn btn-sm', '✓ Accept');
      acc.type = 'button';
      acc.addEventListener('click', () => respond(incomingReq.id, true));
      const dec = el('button', 'btn btn-sm btn-dark', '✕');
      dec.type = 'button';
      dec.title = 'Decline';
      dec.setAttribute('aria-label', `Decline ${p.username}`);
      dec.addEventListener('click', () => respond(incomingReq.id, false));
      act.append(acc, dec);
    } else if (rel.kind === 'friends') {
      const dm = dmRoomWith(id);
      const unread = dm ? st.unread.get(dm.id) || 0 : 0;
      const chat = el('button', 'btn btn-sm' + (unread ? ' has-unread' : ' btn-dark'), unread ? `Chat (${unread})` : 'Chat');
      chat.type = 'button';
      chat.addEventListener('click', () => { if (dm) { openRoom(dm.id); closeOverlays(); } });
      act.append(chat);
    } else if (rel.kind === 'outgoing') {
      const b = el('button', 'btn btn-sm btn-dark', 'Requested');
      b.type = 'button'; b.disabled = true;
      act.append(b);
    } else if (rel.kind !== 'me') {
      const add = el('button', 'btn btn-sm', '+ Add Friend');
      add.type = 'button';
      add.addEventListener('click', () => addFriend(id, add));
      act.append(add);
    }
    if (act.children.length) row.append(act);
    return row;
  }

  async function addFriend(id, btn) {
    btn.disabled = true;
    try {
      const res = await backend.sendFriendRequest(id);
      if (res === 'SENT' || res === 'ALREADY_SENT') {
        st.requests.set('local-' + id, { id: 'local-' + id, from_user: st.meId, to_user: id, status: 'pending' });
      }
      if (res === 'ACCEPTED') await refreshSocial();
      renderPeople();
    } catch (e) { btn.disabled = false; note(PZ.friendlyError(e), 'error'); }
  }

  async function respond(reqId, accept) {
    try {
      const roomId = await backend.respondFriendRequest(reqId, accept);
      const r = st.requests.get(reqId);
      if (r) r.status = accept ? 'accepted' : 'declined';
      if (accept) await refreshSocial();
      renderPeople();
      if (roomId && st.rooms.has(roomId)) note(`You're friends with ${nameOf(r && r.from_user)} now. Press Chat to talk.`, 'ok');
    } catch (e) { note(PZ.friendlyError(e), 'error'); }
  }

  // Friend changes create rooms and memberships; reload them in one go.
  async function refreshSocial() {
    try {
      const d = await backend.loadAll();
      d.rooms.forEach((r) => st.rooms.set(r.id, r));
      st.members.clear();
      d.memberships.forEach((m) => addMember(m.room_id, m.user_id));
      st.requests.clear();
      d.friendRequests.forEach((r) => st.requests.set(r.id, r));
      renderRooms();
    } catch (_) { /* next realtime event will catch up */ }
  }

  function addMember(roomId, userId) {
    if (!st.members.has(roomId)) st.members.set(roomId, new Set());
    st.members.get(roomId).add(userId);
  }

  // ---------------------------------------------------------------- presence
  function pushPresence() {
    if (!backend || !st.meId) return;
    const idleMs = Date.now() - st.lastActive;
    backend.setPresence({
      user_id: st.meId,
      room_id: st.current,
      typing: st.typing,
      away: document.hidden || idleMs > 10 * 60000,
      active_at: st.lastActive
    });
  }
  let lastPush = 0;
  function markActive() {
    const wasAway = Date.now() - st.lastActive > 10 * 60000;
    st.lastActive = Date.now();
    if (wasAway || Date.now() - lastPush > 60000) { lastPush = Date.now(); pushPresence(); }
  }

  function onPresence(state) {
    const before = new Set(Object.keys(st.presence));
    st.presence = state;
    if (st.presenceSynced) {
      const g = globalRoom();
      for (const id of Object.keys(state)) {
        if (!before.has(id) && id !== st.meId && st.profiles.has(id) && g) {
          const line = { id: 'l' + Math.random(), kind: 'local', room_id: g.id,
            body: `★ ${nameOf(id)} has signed on from ${hostFor(id)}`, created_at: new Date().toISOString() };
          if (!st.local.has(g.id)) st.local.set(g.id, []);
          const arr = st.local.get(g.id);
          arr.push(line);
          if (arr.length > 30) arr.shift();
          if (st.current === g.id) appendRow(line, false);
        }
      }
    } else {
      setTimeout(() => { st.presenceSynced = true; }, 3000);
    }
    renderPeople(); renderTyping(); renderHead();
  }

  // ---------------------------------------------------------------- status
  function renderStatus() {
    const p = me();
    const up = st.conn === 'up';
    const conn = $('conn');
    conn.classList.toggle('is-down', !up);
    $('conn-text').textContent = up ? `CONNECTED • ${p ? p.modem : '56k'}` : st.conn === 'down' ? 'NO CARRIER' : 'CONNECTING…';
    $('sb-conn').textContent = `${backend.mode === 'demo' ? 'DEMO MODE • ' : 'Secure-ish connection to '}${backend.host}` +
      (st.lag !== null ? ` • Lag ${(st.lag / 1000).toFixed(1)} sec` : '');
    $('sb-words').textContent = `${fmtNum(st.settings.total_words)} / ${fmtNum(st.settings.wipe_at_words)} words`;
    const you = $('sb-you');
    you.hidden = !p;
    if (p) you.textContent = `you: ${p.username}`;
  }

  async function ping() {
    try {
      const r = await backend.ping();
      st.lag = r.ms;
      st.settings.total_words = r.totalWords;
    } catch (_) { st.lag = null; }
    renderStatus();
  }

  // ---------------------------------------------------------------- actions
  async function joinRoom(roomId) {
    try {
      await backend.joinRoom(roomId);
      addMember(roomId, st.meId);
      st.msgs.delete(roomId);
      await openRoom(roomId);
    } catch (e) { note(PZ.friendlyError(e), 'error'); }
  }

  function closeOverlays() {
    document.body.classList.remove('show-rooms', 'show-people');
  }

  function openJoinDialog() {
    const list = $('join-list');
    list.textContent = '';
    const groups = [...st.rooms.values()].filter((r) => r.kind === 'group' && !isMemberOf(r.id)).sort((a, b) => a.name.localeCompare(b.name));
    if (!groups.length) list.append(el('p', null, "You're already in every group. Make a new one with Create group."));
    groups.forEach((r) => {
      const row = el('div', 'join-row');
      const icon = el('span', 'room-icon', r.icon);
      icon.style.color = ICON_COLORS[r.icon] || '#f08a24';
      const b = el('button', 'btn btn-sm', 'Join');
      b.type = 'button';
      b.addEventListener('click', async () => { $('dlg-join').close(); await joinRoom(r.id); });
      row.append(icon, el('span', 'join-name', r.name), el('span', 'join-count', `${memberCount(r)} members`), b);
      list.append(row);
    });
    $('dlg-join').showModal();
  }

  async function openInviteDialog() {
    $('invite-code').textContent = '…';
    $('invite-error').hidden = true;
    $('dlg-invite').showModal();
    try {
      $('invite-code').textContent = await backend.createInvite();
    } catch (e) {
      $('invite-code').textContent = '—';
      $('invite-error').textContent = PZ.friendlyError(e);
      $('invite-error').hidden = false;
    }
  }

  function openCreateDialog() {
    $('create-name').value = '';
    $('create-error').hidden = true;
    const fs = $('create-icons');
    fs.querySelectorAll('label').forEach((n) => n.remove());
    ICONS.forEach((ic, i) => {
      const l = el('label', 'icon-opt');
      const inp = el('input');
      inp.type = 'radio'; inp.name = 'icon'; inp.value = ic; inp.checked = i === 0;
      const s = el('span', null, ic);
      s.style.color = ICON_COLORS[ic];
      l.append(inp, s);
      fs.append(l);
    });
    $('dlg-create').showModal();
    $('create-name').focus();
  }

  function openProfileDialog() {
    const p = me();
    if (!p) return;
    $('prof-username').value = p.username;
    $('prof-status').value = p.status_text || '';
    $('prof-modem').value = p.modem;
    $('prof-error').hidden = true;
    const fs = $('prof-colors');
    fs.querySelectorAll('label').forEach((n) => n.remove());
    const colors = NAME_COLORS.includes(p.color) ? NAME_COLORS : [p.color].concat(NAME_COLORS);
    colors.forEach((c) => {
      const l = el('label', 'color-opt');
      const inp = el('input');
      inp.type = 'radio'; inp.name = 'color'; inp.value = c; inp.checked = c === p.color;
      const s = el('span');
      s.style.background = c;
      l.title = c;
      l.append(inp, s);
      fs.append(l);
    });
    $('dlg-profile').showModal();
  }

  // ---------------------------------------------------------------- sign on
  let authMode = 'signin';
  function setAuthMode(mode) {
    authMode = mode;
    $('tab-signin').classList.toggle('is-active', mode === 'signin');
    $('tab-signup').classList.toggle('is-active', mode === 'signup');
    $('tab-signin').setAttribute('aria-selected', String(mode === 'signin'));
    $('tab-signup').setAttribute('aria-selected', String(mode === 'signup'));
    document.querySelectorAll('.only-signup').forEach((n) => { n.hidden = mode !== 'signup'; });
    $('auth-password').autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
    $('auth-submit').textContent = mode === 'signup' ? 'Create account' : 'Sign on';
    $('auth-error').hidden = true;
  }

  function showSignOn(message) {
    entered = false;
    $('toolbar').hidden = true;
    $('main').hidden = true;
    $('signon').hidden = false;
    $('sb-you').hidden = true;
    $('sb-conn').textContent = backend.mode === 'demo' ? 'Demo mode: any email and password will do.' : 'Not connected';
    $('sb-words').textContent = '';
    if (message) { $('auth-error').textContent = message; $('auth-error').hidden = false; }
  }

  async function submitAuth(ev) {
    ev.preventDefault();
    const email = $('auth-email').value.trim();
    const password = $('auth-password').value;
    const err = $('auth-error');
    err.hidden = true;
    if (!email || !password) { err.textContent = 'Enter your email and password.'; err.hidden = false; return; }
    const btn = $('auth-submit');
    btn.disabled = true;
    $('modem-line').textContent = 'ATDT 555-0199 … dialing …';
    try {
      let id;
      if (authMode === 'signup') {
        id = await backend.signUp({ email, password, username: $('auth-username').value.trim(), code: $('auth-code').value.trim() });
      } else {
        id = await backend.signIn(email, password);
      }
      await enterChat(id);
    } catch (e) {
      err.textContent = e.code === 'CONFIRM_EMAIL' ? e.message : PZ.friendlyError(e);
      err.hidden = false;
      $('modem-line').textContent = 'NO CARRIER';
    } finally {
      btn.disabled = false;
    }
  }

  // ---------------------------------------------------------------- boot
  async function enterChat(id) {
    if (entered && st.meId === id) return;
    entered = true;
    st.meId = id;
    let d;
    try { d = await backend.loadAll(); } catch (e) { entered = false; return showSignOn(PZ.friendlyError(e)); }
    st.profiles.clear(); d.profiles.forEach((p) => st.profiles.set(p.id, p));
    if (!st.profiles.has(id)) {
      entered = false;
      await backend.signOut();
      return showSignOn('This account has no screen name. Sign up again with an invite code.');
    }
    st.rooms.clear(); d.rooms.forEach((r) => st.rooms.set(r.id, r));
    st.members.clear(); d.memberships.forEach((m) => addMember(m.room_id, m.user_id));
    st.requests.clear(); d.friendRequests.forEach((r) => st.requests.set(r.id, r));
    st.settings = Object.assign({}, PZ.DEFAULT_SETTINGS, d.settings);
    st.msgs.clear(); st.unread.clear(); st.local.clear();

    $('signon').hidden = true;
    $('toolbar').hidden = false;
    $('main').hidden = false;
    renderStatus();
    const g = globalRoom();
    backend.subscribe({
      message: addMessage,
      profile: (p) => { st.profiles.set(p.id, Object.assign(st.profiles.get(p.id) || {}, p)); renderPeople(); renderStatus(); if (p.id === st.meId) renderComposer(); },
      room: (r) => { st.rooms.set(r.id, r); renderRooms(); renderPeople(); },
      membership: (op, m) => {
        if (op === 'add') addMember(m.room_id, m.user_id);
        else if (st.members.has(m.room_id)) st.members.get(m.room_id).delete(m.user_id);
        renderRooms();
      },
      friendRequest: (r) => {
        for (const [k, v] of st.requests) if (String(k).startsWith('local-') && v.to_user === r.to_user && v.from_user === r.from_user) st.requests.delete(k);
        st.requests.set(r.id, r);
        if (r.status === 'accepted') refreshSocial().then(renderPeople);
        renderPeople();
      },
      settings: (s) => { st.settings = Object.assign(st.settings, s); renderStatus(); renderComposer(); },
      presence: onPresence,
      connection: (c) => { st.conn = c; renderStatus(); }
    });
    if (g) await openRoom(g.id);
    pushPresence();
    ping();
  }

  function wire() {
    $('tab-signin').addEventListener('click', () => setAuthMode('signin'));
    $('tab-signup').addEventListener('click', () => setAuthMode('signup'));
    $('form-auth').addEventListener('submit', submitAuth);

    $('btn-join').addEventListener('click', openJoinDialog);
    $('btn-invite').addEventListener('click', openInviteDialog);
    $('btn-create').addEventListener('click', openCreateDialog);
    $('btn-join-here').addEventListener('click', () => joinRoom(st.current));
    $('btn-show-rooms').addEventListener('click', () => { document.body.classList.remove('show-people'); document.body.classList.toggle('show-rooms'); });
    $('btn-show-people').addEventListener('click', () => { document.body.classList.remove('show-rooms'); document.body.classList.toggle('show-people'); });
    $('btn-close-people').addEventListener('click', closeOverlays);
    $('btn-collapse-rooms').addEventListener('click', () => {
      if (window.matchMedia('(max-width: 960px)').matches) return closeOverlays();
      document.body.classList.toggle('rooms-collapsed');
    });
    $('room-search').addEventListener('input', (e) => { st.search = e.target.value; renderRooms(); });

    $('ptab-all').addEventListener('click', () => setPeopleTab('all'));
    $('ptab-friends').addEventListener('click', () => setPeopleTab('friends'));

    const input = $('msg-input');
    input.addEventListener('input', () => { autosize(); note(''); renderComposer(); if (input.value.trim()) startTyping(); else stopTyping(); markActive(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    });
    $('composer').addEventListener('submit', (e) => { e.preventDefault(); send(); });

    $('img-input').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!f) return;
      if (lockState()) return note(PZ.ERRORS.IMAGE_LOCKED, 'error');
      if (!/^image\/(png|jpeg|gif|webp)$/.test(f.type)) return note('Only PNG, JPEG, GIF or WebP images.', 'error');
      if (f.size > 5 * 1024 * 1024) return note('That image is too big (5 MB max).', 'error');
      const words = PZ.countWords(input.value);
      if (words > limits().words) return note(`Your caption has ${words} words. The limit is ${limits().words}.`, 'error');
      st.pendingFile = f;
      const prev = $('img-preview');
      if (prev.dataset.url) URL.revokeObjectURL(prev.dataset.url);
      prev.dataset.url = URL.createObjectURL(f);
      prev.src = prev.dataset.url;
      const mins = Math.round(st.settings.image_lock_seconds / 60);
      $('img-warning').textContent = `After sending an image you can't send anything for ${mins} minutes.` +
        (words ? ` Your typed text (${words} word${words === 1 ? '' : 's'}) goes with it as a caption.` : '');
      $('dlg-image').returnValue = '';
      $('dlg-image').showModal();
    });
    $('dlg-image').addEventListener('close', () => {
      const f = st.pendingFile;
      st.pendingFile = null;
      if ($('dlg-image').returnValue === 'send' && f) send(f);
    });

    $('form-create').addEventListener('submit', async (e) => {
      if (e.submitter && e.submitter.value === 'cancel') return;
      e.preventDefault();
      const name = $('create-name').value.trim().toLowerCase();
      const icon = (document.querySelector('#create-icons input:checked') || {}).value || '#';
      $('create-submit').disabled = true;
      try {
        const id = await backend.createGroup(name, icon);
        $('dlg-create').close();
        await refreshSocial();
        st.msgs.delete(id);
        await openRoom(id);
      } catch (err) {
        $('create-error').textContent = PZ.friendlyError(err);
        $('create-error').hidden = false;
      } finally { $('create-submit').disabled = false; }
    });

    $('invite-copy').addEventListener('click', async () => {
      const code = $('invite-code').textContent;
      try { await navigator.clipboard.writeText(code); $('invite-copy').textContent = 'Copied'; }
      catch (_) {
        const r = document.createRange(); r.selectNodeContents($('invite-code'));
        const s = getSelection(); s.removeAllRanges(); s.addRange(r);
        $('invite-copy').textContent = 'Press Ctrl+C';
      }
      setTimeout(() => { $('invite-copy').textContent = 'Copy code'; }, 2000);
    });

    $('sb-you').addEventListener('click', openProfileDialog);
    $('form-profile').addEventListener('submit', async (e) => {
      if (!e.submitter || e.submitter.value !== 'save') return;
      e.preventDefault();
      const patch = {
        username: $('prof-username').value.trim(),
        status_text: $('prof-status').value.trim().slice(0, 40),
        modem: $('prof-modem').value,
        color: (document.querySelector('#prof-colors input:checked') || {}).value || me().color
      };
      try {
        await backend.updateProfile(patch);
        Object.assign(me(), patch);
        $('dlg-profile').close();
        renderPeople(); renderStatus(); if (st.msgs.has(st.current)) renderMessages();
      } catch (err) {
        $('prof-error').textContent = PZ.friendlyError(err);
        $('prof-error').hidden = false;
      }
    });
    $('btn-signout').addEventListener('click', async () => {
      $('dlg-profile').close();
      await backend.signOut();
      location.reload();
    });

    document.addEventListener('visibilitychange', () => { if (!document.hidden) st.lastActive = Date.now(); pushPresence(); });
    document.addEventListener('pointerdown', markActive, { passive: true });

    setInterval(() => { if (entered) { renderComposer(); } }, 1000);
    setInterval(() => { if (entered) { pushPresence(); renderPeople(); } }, 60000);
    setInterval(() => { if (entered) ping(); }, 30000);
  }

  function setPeopleTab(tab) {
    st.peopleTab = tab;
    $('ptab-all').classList.toggle('is-active', tab === 'all');
    $('ptab-friends').classList.toggle('is-active', tab === 'friends');
    $('ptab-all').setAttribute('aria-selected', String(tab === 'all'));
    $('ptab-friends').setAttribute('aria-selected', String(tab === 'friends'));
    renderPeople();
  }

  async function start() {
    wire();
    setAuthMode('signin');
    const live = cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY;
    if (live && !window.supabase) {
      backend = PZ.createDemoBackend();
      return showSignOn('Could not load the Supabase library. Check your internet connection and reload.');
    }
    backend = live ? PZ.createSupabaseBackend(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : PZ.createDemoBackend();
    document.body.classList.toggle('is-demo', backend.mode === 'demo');
    backend.onAuthChange((id) => { if (id) enterChat(id); else if (entered) location.reload(); });
    const id = await backend.currentUserId();
    if (id) await enterChat(id); else showSignOn();
  }

  start();
})();
