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
    roomReqs: new Map(),         // "roomId|userId" -> locked-group invite or request
    invites: [],                 // my live invite links
    settings: Object.assign({}, PZ.DEFAULT_SETTINGS),
    presence: {},
    presenceSynced: false,
    current: null,
    msgs: new Map(),             // roomId -> messages (loaded rooms only)
    local: new Map(),            // roomId -> local-only lines ("signed on")
    unread: new Map(),
    peopleTab: 'all',
    reactions: new Map(),   // message id -> Map(user id -> 'perfect' | 'stinky')
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
  const amAdmin = () => { const p = me(); return !!(p && p.is_admin && !p.banned_at); };
  const reqKey = (roomId, userId) => roomId + '|' + userId;
  const myRoomReq = (roomId) => st.roomReqs.get(reqKey(roomId, st.meId));
  const pendingRequests = (roomId) => [...st.roomReqs.values()].filter((q) => q.room_id === roomId && q.kind === 'request');
  const LOCK_SVG = '<svg viewBox="0 0 12 14" aria-hidden="true"><rect x="1.5" y="6" width="9" height="7" fill="currentColor"/><path d="M3.6 6V4.2a2.4 2.4 0 0 1 4.8 0V6" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
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

  // A short message under the text box (an error, or something that worked).
  // Hidden when there's nothing to say.
  function note(text, kind) {
    const n = $('composer-note');
    n.textContent = text || '';
    n.className = 'composer-note' + (kind ? ' is-' + kind : '');
    n.hidden = !text;
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
    if (r.locked) {
      const lock = el('span', 'room-lock');
      lock.innerHTML = LOCK_SVG;
      lock.title = 'Locked group';
      name.append(lock);
    }
    const unread = st.unread.get(r.id) || 0;
    const waiting = r.locked && amAdmin() ? pendingRequests(r.id).length : 0;
    const mine = !joined && myRoomReq(r.id);
    let count;
    if (unread) count = el('span', 'room-count is-unread', String(unread));
    else if (waiting) count = el('span', 'room-count is-waiting', `${waiting}?`);
    else if (mine && mine.kind === 'invite') count = el('span', 'room-count is-invited', 'invited');
    else count = el('span', 'room-count', String(memberCount(r)));
    count.title = unread ? `${unread} new` : waiting ? `${waiting} waiting to get in` : mine ? 'An admin invited you' : `${memberCount(r)} members`;
    b.append(icon, name, count);
    b.title = joined ? roomLabel(r) : r.locked ? `${roomLabel(r)}: locked group` : `${roomLabel(r)}: double-click to join`;
    b.addEventListener('click', () => { openRoom(r.id); closeOverlays(); });
    b.addEventListener('dblclick', () => { if (!joined && (!r.locked || amAdmin() || (mine && mine.kind === 'invite'))) joinRoom(r.id); });
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
    renderRooms(); renderHead(); renderComposer(); renderPeople(); renderTyping();
    const joined = isMemberOf(roomId);
    $('composer').hidden = !joined;
    renderJoinPrompt();
    renderRequestsBar();
    const r = room();
    if (!joined) {
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
        try {
          const list = await backend.loadReactions(rows.filter((m) => m.kind !== 'system').map((m) => m.id));
          list.forEach((x) => setLocalReaction(x.message_id, x.user_id, x.kind));
        } catch (_) { /* messages still show without reactions */ }
      } catch (e) {
        if (st.current === roomId) { $('messages').textContent = ''; $('messages').append(el('p', 'empty-note', PZ.friendlyError(e))); }
        return;
      }
    }
    // Don't pop the phone keyboard just because a room opened.
    if (st.current === roomId) { renderMessages(); if (!isPhone()) $('msg-input').focus({ preventScroll: true }); }
    pushPresence();
  }

  function renderHead() {
    const r = room();
    if (!r) return;
    $('room-title').textContent = r.kind === 'global' ? 'Global Chat' : r.kind === 'dm' ? '@' + nameOf(dmPartner(r)) : '#' + r.name;
    const lockBtn = $('btn-lock-toggle');
    lockBtn.hidden = !(r.kind === 'group' && amAdmin());
    lockBtn.querySelector('.lock-label').textContent = r.locked ? 'Unlock group' : 'Lock group';
    lockBtn.setAttribute('aria-label', r.locked ? 'Unlock group' : 'Lock group');
    lockBtn.title = r.locked ? 'Unlock: let anyone join this group' : 'Lock: only people an admin lets in can join';
    const coolBtn = $('btn-cooldown-toggle');
    const coolOn = cooldownsIn(r);
    if (coolBtn) {  // missing only if the browser is still holding an older page
      coolBtn.hidden = !(r.kind === 'group' && amAdmin());
      coolBtn.classList.toggle('is-off', !coolOn);
      coolBtn.querySelector('.cool-label').textContent = coolOn ? 'Cooldowns off' : 'Cooldowns on';
      coolBtn.setAttribute('aria-label', coolOn ? 'Switch cooldowns off in this group' : 'Switch cooldowns back on in this group');
      coolBtn.title = coolOn
        ? 'Switch off the image cooldown and flood control in this group'
        : 'Cooldowns are off here. Switch the image cooldown and flood control back on';
    }
    const here = groupMembersHere();
    const online = onlineIds().filter((id) => !here || here.has(id));
    const stack = $('avatar-stack');
    stack.textContent = '';
    online.slice(0, 3).forEach((id) => stack.append(avatar(id, 'avatar-sm')));
    // Full wording like the design; shortened only if it would squeeze the room name.
    const oc = $('online-count');
    oc.textContent = `${online.length} ${online.length === 1 ? 'person is' : 'people are'} online`;
    const h2 = $('room-title');
    if (window.matchMedia('(max-width: 560px)').matches && h2.scrollWidth > h2.clientWidth) oc.textContent = `${online.length} online`;
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
    const target = nameOf(m.target_id);
    if (m.body === 'PROMOTED') return `*** ${who} sets mode +o ${target} (now an admin)`;
    if (m.body === 'DEMOTED') return m.user_id === m.target_id
      ? `*** ${who} sets mode -o ${target} (stepped down)`
      : `*** ${who} sets mode -o ${target} (now a regular)`;
    if (m.body === 'BANNED') return `*** ${target} was banned by ${who}`;
    if (m.body === 'UNBANNED') return `*** ${target} was unbanned by ${who}`;
    if (m.body === 'LOCKED') return `*** ${who} locked #${r ? r.name : 'this group'}: invite only from now on`;
    if (m.body === 'UNLOCKED') return `*** ${who} unlocked #${r ? r.name : 'this group'}: anyone can join`;
    if (m.body === 'COOLDOWNS_OFF') return `*** ${who} switched off cooldowns in #${r ? r.name : 'this group'}: no image or flood waits here`;
    if (m.body === 'COOLDOWNS_ON') return `*** ${who} switched cooldowns back on in #${r ? r.name : 'this group'}`;
    return `★ ${m.body}`;
  }

  function messageRow(m, flash) {
    const r = st.rooms.get(m.room_id);
    if (m.kind === 'system' || m.kind === 'local') {
      const mode = { PROMOTED: ' sys-mode', DEMOTED: ' sys-mode', BANNED: ' sys-ban', UNBANNED: ' sys-mode', LOCKED: ' sys-mode', UNLOCKED: ' sys-mode', COOLDOWNS_OFF: ' sys-mode', COOLDOWNS_ON: ' sys-mode', WIPE: ' sys-wipe' }[m.body] || '';
      return el('div', 'sys' + (m.kind === 'local' ? '' : mode), m.kind === 'local' ? m.body : systemText(m, r));
    }
    const p = st.profiles.get(m.user_id);
    const row = el('div', 'msg');
    if (p && p.is_admin && !p.banned_at) row.classList.add('is-op');
    if (flash) row.classList.add('flash');
    const who = el('div', 'who');
    let name;
    if (p) {
      name = el('button', 'name', p.username);
      name.type = 'button';
      name.title = m.user_id === st.meId ? 'You' : `${p.username}: add friend, profile`;
      name.addEventListener('click', () => openPerson(m.user_id));
    } else {
      name = el('span', 'name', 'someone');
    }
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
    if (typeof m.id === 'number') {
      row.dataset.mid = String(m.id);
      row.append(el('div', 'reacts'), reactionPicker(m.id));
      fillReacts(row, m.id);
      // Phones have no hover: tap a message to show the reaction buttons.
      row.addEventListener('click', (e) => {
        if (HOVER.matches || e.target.closest('button, a, img')) return;
        const on = !row.classList.contains('is-picking');
        document.querySelectorAll('.msg.is-picking').forEach((x) => x.classList.remove('is-picking'));
        row.classList.toggle('is-picking', on);
      });
    }
    return row;
  }

  // ---------------------------------------------------------------- reactions
  const REACTIONS = [
    { kind: 'perfect', label: 'Perfect pazhampori', src: 'assets/react-perfect.png' },
    { kind: 'stinky', label: 'Stinky kayappam', src: 'assets/react-stinky.png' }
  ];
  const HOVER = window.matchMedia('(hover: hover)');

  function setLocalReaction(messageId, userId, kind) {
    let m = st.reactions.get(messageId);
    if (!m) { m = new Map(); st.reactions.set(messageId, m); }
    if (kind) m.set(userId, kind); else m.delete(userId);
    if (!m.size) st.reactions.delete(messageId);
  }
  const myReaction = (messageId) => (st.reactions.get(messageId) || new Map()).get(st.meId) || null;

  function reactIcon(r, size) {
    const img = el('img', 'react-ico');
    img.src = r.src; img.alt = ''; img.width = size; img.height = size;
    return img;
  }

  function reactionPicker(messageId) {
    const pick = el('div', 'react-pick');
    REACTIONS.forEach((r) => {
      const b = el('button', 'react-opt');
      b.type = 'button';
      b.dataset.kind = r.kind;
      b.title = r.label;
      b.setAttribute('aria-label', `React: ${r.label}`);
      b.append(reactIcon(r, 26));
      b.addEventListener('click', (e) => { e.stopPropagation(); toggleReaction(messageId, r.kind); });
      pick.append(b);
    });
    return pick;
  }

  // Counts under a message, and which button is yours.
  function fillReacts(row, messageId) {
    const box = row.querySelector('.reacts');
    if (!box) return;
    box.textContent = '';
    const who = st.reactions.get(messageId) || new Map();
    const mine = who.get(st.meId) || null;
    REACTIONS.forEach((r) => {
      const ids = [...who].filter(([, k]) => k === r.kind).map(([u]) => u);
      if (!ids.length) return;
      const chip = el('button', 'react-chip' + (mine === r.kind ? ' is-mine' : ''));
      chip.type = 'button';
      const names = ids.map((u) => (u === st.meId ? 'you' : nameOf(u)));
      chip.title = `${r.label}: ${names.slice(0, 12).join(', ')}${names.length > 12 ? ` and ${names.length - 12} more` : ''}`;
      chip.setAttribute('aria-label', `${ids.length} ${r.label}. ${mine === r.kind ? 'Tap to take yours back.' : 'Tap to add yours.'}`);
      chip.append(reactIcon(r, 22), el('span', 'react-n', String(ids.length)));
      chip.addEventListener('click', (e) => { e.stopPropagation(); toggleReaction(messageId, r.kind); });
      box.append(chip);
    });
    row.querySelectorAll('.react-opt').forEach((b) => b.classList.toggle('is-mine', b.dataset.kind === mine));
  }

  function refreshReacts(messageId) {
    const row = $('messages').querySelector(`.msg[data-mid="${messageId}"]`);
    if (row) fillReacts(row, messageId);
  }

  // Same reaction again takes it back; the other one switches.
  async function toggleReaction(messageId, kind) {
    const before = myReaction(messageId);
    const next = before === kind ? null : kind;
    setLocalReaction(messageId, st.meId, next);
    refreshReacts(messageId);
    document.querySelectorAll('.msg.is-picking').forEach((x) => x.classList.remove('is-picking'));
    try { await backend.setReaction(messageId, next); }
    catch (e) {
      setLocalReaction(messageId, st.meId, before);
      refreshReacts(messageId);
      note(PZ.friendlyError(e), 'error');
    }
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
      if (r && r.kind !== 'dm') { list.forEach((x) => st.reactions.delete(x.id)); list.length = 0; }
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
  // "2 minutes", "1 minute" or "90 seconds", from the live setting.
  function imageLockText() {
    const s = Number(st.settings.image_lock_seconds) || 0;
    if (s % 60 === 0) return s === 60 ? '1 minute' : `${s / 60} minutes`;
    return `${s} seconds`;
  }

  // The image cooldown and flood control apply in Global chat and in groups
  // unless an admin switched them off. Never in friend chats.
  function cooldownsIn(r) {
    return !!r && (r.kind === 'global' || (r.kind === 'group' && r.cooldowns !== false));
  }

  // Your lock, if any, in the room you're looking at.
  function lockState() {
    const p = me();
    if (!p || !cooldownsIn(room())) return null;
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
    $('img-btn').title = `Send an image (locks you for ${imageLockText()})`;
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
      if (PZ.errorCode(e) === 'BANNED') return showBanned();
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
    // The bar only shows while someone else is typing in this room.
    const bar = $('typing-bar');
    const show = names.length > 0;
    if (show) {
      $('typing-text').textContent = names.length === 1 ? `${names[0]} is typing`
        : names.length === 2 ? `${names[0]} and ${names[1]} are typing`
        : `${names.length} people are typing`;
    }
    if (bar.hidden === !show) return;
    // Showing or hiding the bar changes the height of the message list. If you
    // were reading the newest messages, keep them in view.
    const box = $('messages');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
    bar.hidden = !show;
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  // ---------------------------------------------------------------- people
  // Inside a group, "people here" means the group's members. In Global chat
  // and friend chats it means everyone in Pazhampori chat.
  function groupMembersHere() {
    const r = room();
    return r && r.kind === 'group' ? (st.members.get(r.id) || new Set()) : null;
  }

  function renderPeople() {
    const list = $('people-list');
    list.textContent = '';
    const everyone = [...st.profiles.keys()];
    const here = groupMembersHere();
    const ids = st.peopleTab === 'all' && here ? everyone.filter((id) => here.has(id)) : everyone;
    const incoming = [...st.requests.values()].filter((r) => r.status === 'pending' && r.to_user === st.meId && st.profiles.has(r.from_user));
    const rank = { typing: 0, online: 0, away: 1, offline: 2 };
    const banned = (id) => !!st.profiles.get(id).banned_at;
    const isOp = (id) => st.profiles.get(id).is_admin && !banned(id);
    const byPresence = (a, b) => (banned(a) - banned(b)) || (rank[presenceOf(a).state] - rank[presenceOf(b).state]) || nameOf(a).localeCompare(nameOf(b));
    const ops = ids.filter(isOp).sort((a, b) => (st.profiles.get(b).is_owner - st.profiles.get(a).is_owner) || byPresence(a, b));

    let dmUnread = 0;
    for (const r of st.rooms.values()) if (r.kind === 'dm') dmUnread += st.unread.get(r.id) || 0;
    const fb = $('friends-badge');
    const badgeCount = incoming.length + dmUnread;
    fb.hidden = !badgeCount; fb.textContent = String(badgeCount);
    const pb = $('people-badge');
    pb.hidden = !badgeCount; pb.textContent = String(badgeCount);

    if (st.peopleTab === 'all' && here) {
      const r = room();
      list.append(el('div', 'people-scope', `#${r.name}: ${ids.length} member${ids.length === 1 ? '' : 's'}`));
    }
    ops.forEach((id) => list.append(personRow(id)));
    if (st.peopleTab === 'all') {
      ids.filter((id) => !isOp(id)).sort(byPresence).forEach((id) => list.append(personRow(id)));
    } else {
      if (incoming.length) {
        const banner = el('div', 'req-banner');
        banner.append(el('span', null, 'New friend requests'), el('span', 'req-count', String(incoming.length).padStart(2, '0')));
        list.append(banner);
        incoming.forEach((r) => list.append(personRow(r.from_user, r)));
      }
      const friends = ids.filter((id) => !isOp(id) && relation(id).kind === 'friends').sort(byPresence);
      friends.forEach((id) => list.append(personRow(id)));
      if (!friends.length && !incoming.length) {
        list.append(el('p', 'people-empty', 'No friends yet. Press "+ Add Friend" next to someone in ALL. They have to accept before you can chat.'));
      }
    }
  }

  function statusLine(id) {
    const p = st.profiles.get(id);
    const pr = presenceOf(id);
    if (p.banned_at) return el('span', 'person-status is-banned', '✕ banned');
    return el('span', 'person-status is-' + pr.state,
      pr.state === 'typing' ? '● typing...' : pr.state === 'online' ? (p.is_admin ? '● moderating' : '● online') : pr.state === 'away' ? '○ away' : 'offline');
  }

  function metaLine(id) {
    const p = st.profiles.get(id);
    const pr = presenceOf(id);
    const bits = [p.modem === 'T1' ? 'T1 line' : p.modem];
    if (p.status_text) bits.push(p.status_text);
    if (pr.state !== 'offline' && !p.banned_at) bits.push(`${pr.idleMin} min idle`);
    return bits.join(' • ');
  }

  function tagEls(id) {
    const p = st.profiles.get(id);
    const out = [];
    if (p.banned_at) out.push(el('span', 'ban-tag', '[BANNED]'));
    else if (p.is_admin) { const t = el('span', 'op-tag', '[OP]'); if (p.is_owner) t.title = 'Founder'; out.push(t); }
    if (id === st.meId) out.push(el('span', 'you-tag', '(you)'));
    return out;
  }

  function personRow(id, incomingReq) {
    const p = st.profiles.get(id);
    const pr = presenceOf(id);
    const rel = id === st.meId ? { kind: 'me' } : relation(id);
    const row = el('div', 'person' + (p.is_admin && !p.banned_at ? ' is-op' : '') +
      (pr.state === 'offline' ? ' is-offline' : '') + (p.banned_at ? ' is-banned' : ''));
    const main = el('button', 'person-main');
    main.type = 'button';
    main.title = `${p.username}: profile${id === st.meId ? '' : ', friend'}${me() && me().is_admin ? ', admin tools' : ''}`;
    main.addEventListener('click', () => openPerson(id));
    const av = avatar(id, 'avatar-lg');
    const info = el('span', 'person-info');
    const top = el('span', 'person-top');
    const name = el('span', 'person-name', p.username);
    name.style.color = colorOf(id);
    top.append(name, ...tagEls(id));
    info.append(top, statusLine(id), el('span', 'person-meta', metaLine(id)));
    main.append(av, info);
    row.append(main);

    const act = el('div', 'person-act');
    if (p.banned_at) {
      // no friend actions for banned people
    } else if (incomingReq) {
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

  async function addFriend(id, btn, rethrow) {
    if (btn) btn.disabled = true;
    try {
      const res = await backend.sendFriendRequest(id);
      if (res === 'SENT' || res === 'ALREADY_SENT') {
        st.requests.set('local-' + id, { id: 'local-' + id, from_user: st.meId, to_user: id, status: 'pending' });
      }
      if (res === 'ACCEPTED') await refreshSocial();
      renderPeople();
    } catch (e) {
      if (btn) btn.disabled = false;
      if (rethrow) throw e;
      note(PZ.friendlyError(e), 'error');
    }
  }

  async function respond(reqId, accept, rethrow) {
    try {
      const roomId = await backend.respondFriendRequest(reqId, accept);
      const r = st.requests.get(reqId);
      if (r) r.status = accept ? 'accepted' : 'declined';
      if (accept) await refreshSocial();
      renderPeople();
      if (roomId && st.rooms.has(roomId)) note(`You're friends with ${nameOf(r && r.from_user)} now. Press Chat to talk.`, 'ok');
    } catch (e) {
      if (rethrow) throw e;
      note(PZ.friendlyError(e), 'error');
    }
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

  // ---------------------------------------------------------------- member card
  function openPerson(id) {
    if (!st.profiles.has(id)) return;
    st.cardId = id;
    st.cardConfirm = null;
    st.cardNote = '';
    $('pc-error').hidden = true;
    renderPersonCard();
    const d = $('dlg-person');
    if (!d.open) d.showModal();
  }

  function cardButton(label, cls, onClick) {
    const b = el('button', 'btn btn-sm ' + (cls || ''), label);
    b.type = 'button';
    b.addEventListener('click', onClick);
    return b;
  }

  async function cardAction(fn) {
    $('pc-error').hidden = true;
    $('dlg-person').querySelectorAll('.pc-actions button').forEach((b) => { b.disabled = true; });
    try { await fn(); }
    catch (e) { $('pc-error').textContent = PZ.friendlyError(e); $('pc-error').hidden = false; }
    st.cardConfirm = null;
    renderPeople();
    renderPersonCard();
  }

  function renderPersonCard() {
    const d = $('dlg-person');
    const id = st.cardId;
    const p = id && st.profiles.get(id);
    if (!p) { if (d.open) d.close(); return; }
    const mine = me();
    const isMe = id === st.meId;
    const first = p.username[0] ? p.username[0].toUpperCase() : '?';

    const av = $('pc-avatar');
    av.textContent = first;
    av.style.background = colorOf(id);
    $('pc-name').textContent = p.username;
    $('pc-name').style.color = colorOf(id);
    const tags = $('pc-tags');
    tags.textContent = '';
    tags.append(...tagEls(id));
    const st1 = $('pc-status');
    st1.textContent = '';
    st1.append(statusLine(id));
    $('pc-meta').textContent = metaLine(id);

    // Friendship
    const acts = $('pc-actions');
    acts.textContent = '';
    const rel = $('pc-rel');
    if (isMe) {
      rel.textContent = p.is_owner ? 'This is you, the founder of this chatroom.' : 'This is you.';
      acts.append(cardButton('Edit profile', 'btn-dark', () => { $('dlg-person').close(); openProfileDialog(); }));
    } else if (p.banned_at) {
      rel.textContent = "Banned. They can't read or post until an admin unbans them.";
    } else {
      const r = relation(id);
      if (r.kind === 'friends') {
        rel.textContent = "You're friends.";
        const dm = dmRoomWith(id);
        acts.append(cardButton('Open chat', '', () => { $('dlg-person').close(); if (dm) { openRoom(dm.id); closeOverlays(); } }));
      } else if (r.kind === 'incoming') {
        rel.textContent = `${p.username} sent you a friend request.`;
        acts.append(
          cardButton('✓ Accept', '', () => cardAction(() => respond(r.req.id, true, true))),
          cardButton('Decline', 'btn-dark', () => cardAction(() => respond(r.req.id, false, true))));
      } else if (r.kind === 'outgoing') {
        rel.textContent = `Friend request sent. Waiting for ${p.username} to accept.`;
      } else {
        rel.textContent = 'Friends get a private chat with longer messages. They have to accept your request first.';
        acts.append(cardButton('+ Add Friend', '', () => cardAction(() => addFriend(id, null, true))));
      }
    }

    // Admin tools
    const box = $('pc-admin');
    const amAdmin = !!(mine && mine.is_admin && !mine.banned_at);
    box.hidden = !amAdmin;
    if (!amAdmin) return;
    const aa = $('pc-admin-actions');
    aa.textContent = '';
    const hint = $('pc-admin-hint');
    hint.textContent = '';
    if (p.is_owner) {
      hint.textContent = isMe ? "You're the founder. Nobody can demote or ban you." : 'The founder. Nobody can demote or ban them.';
    } else if (isMe) {
      if (st.cardConfirm === 'stepdown') {
        hint.textContent = "Step down to regular? Only another admin can make you an admin again.";
        aa.append(cardButton('Cancel', 'btn-dark', () => { st.cardConfirm = null; renderPersonCard(); }),
          cardButton('Yes, step down', 'btn-danger', () => cardAction(() => setAdmin(id, false))));
      } else {
        aa.append(cardButton('Step down to regular', 'btn-dark', () => { st.cardConfirm = 'stepdown'; renderPersonCard(); }));
      }
    } else if (st.cardConfirm === 'ban') {
      hint.textContent = `Ban ${p.username}? They lose access right away. Everyone will see it in Global chat.`;
      aa.append(cardButton('Cancel', 'btn-dark', () => { st.cardConfirm = null; renderPersonCard(); }),
        cardButton('Yes, ban', 'btn-danger', () => cardAction(() => banUser(id, true))));
    } else if (st.cardConfirm === 'promote') {
      hint.textContent = `Make ${p.username} an admin of all of Pazhampori chat? They'll be able to ban people, promote others and lock any group. Everyone will see it in Global chat.`;
      aa.append(cardButton('Cancel', 'btn-dark', () => { st.cardConfirm = null; renderPersonCard(); }),
        cardButton('Yes, make admin', '', () => cardAction(() => setAdmin(id, true))));
    } else if (p.banned_at) {
      aa.append(cardButton('Unban', '', () => cardAction(() => banUser(id, false))));
    } else {
      aa.append(p.is_admin
        ? cardButton('Make regular', 'btn-dark', () => cardAction(() => setAdmin(id, false)))
        : cardButton('Make chat admin', '', () => { st.cardConfirm = 'promote'; renderPersonCard(); }));
      const ban = cardButton('Ban', 'btn-danger', () => { st.cardConfirm = 'ban'; renderPersonCard(); });
      if (p.is_admin) { ban.disabled = true; hint.textContent = 'Make them a regular first if you need to ban them.'; }
      aa.append(ban);
    }

    // Invite them into a group they aren't in yet (open or locked).
    const li = $('pc-lock-invite');
    const groups = isMe || p.banned_at ? [] : [...st.rooms.values()]
      .filter((r) => r.kind === 'group' && !(st.members.get(r.id) || new Set()).has(id))
      .sort((a, b) => a.name.localeCompare(b.name));
    li.hidden = !groups.length;
    const sel = $('pc-lock-select');
    const keep = sel.value;
    sel.textContent = '';
    groups.forEach((r) => {
      const q = st.roomReqs.get(reqKey(r.id, id));
      const o = el('option', null, '#' + r.name + (r.locked ? ' (locked)' : '') +
        (q ? (q.kind === 'invite' ? ' (invited)' : ' (asked to join)') : ''));
      o.value = r.id;
      sel.append(o);
    });
    if (groups.some((r) => r.id === keep)) sel.value = keep;
    if (st.cardNote && !hint.textContent) hint.textContent = st.cardNote;
  }

  async function inviteToLockedGroup() {
    const roomId = $('pc-lock-select').value;
    const id = st.cardId;
    const r = st.rooms.get(roomId);
    if (!roomId || !id || !r) return;
    await cardAction(async () => {
      const res = await backend.inviteToGroup(roomId, id);
      if (res === 'ADDED') addMember(roomId, id);
      else if (res === 'INVITED') st.roomReqs.set(reqKey(roomId, id), { room_id: roomId, user_id: id, kind: 'invite', by_user: st.meId });
      renderRooms();
    });
    const p = st.profiles.get(id);
    st.cardNote = `${p ? p.username : 'They'} ${st.members.get(roomId) && st.members.get(roomId).has(id) ? 'is now in' : 'has been invited to'} #${r.name}.`;
    renderPersonCard();
  }

  async function setAdmin(id, admin) {
    await backend.setAdmin(id, admin);
    const p = st.profiles.get(id);
    if (p) p.is_admin = admin;
  }

  async function banUser(id, ban) {
    await backend.banUser(id, ban);
    const p = st.profiles.get(id);
    if (p) p.banned_at = ban ? new Date().toISOString() : null;
    if (ban) {
      for (const [k, r] of st.requests) if (r.status === 'pending' && (r.from_user === id || r.to_user === id)) st.requests.delete(k);
    }
  }

  function showBanned() {
    entered = false;
    ['toolbar', 'main', 'signon'].forEach((x) => { $(x).hidden = true; });
    document.querySelectorAll('dialog[open]').forEach((d) => d.close());
    $('banned').hidden = false;
    $('sb-conn').textContent = 'NO CARRIER';
    $('sb-words').textContent = '';
    $('sb-you').hidden = true;
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
    const compact = (n) => n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.floor(n / 1e3)}k` : String(n);
    $('sb-words').textContent = window.matchMedia('(max-width: 560px)').matches
      ? `${compact(Number(st.settings.total_words))}/${compact(Number(st.settings.wipe_at_words))} words`
      : `${fmtNum(st.settings.total_words)} / ${fmtNum(st.settings.wipe_at_words)} words`;
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
      st.roomReqs.delete(reqKey(roomId, st.meId));
      st.msgs.delete(roomId);
      await openRoom(roomId);
    } catch (e) { note(PZ.friendlyError(e), 'error'); renderJoinPrompt(); }
  }

  // The bar shown instead of the composer when you're not in a group.
  function renderJoinPrompt() {
    const r = room();
    const box = $('join-prompt');
    if (!r || r.kind !== 'group' || isMemberOf(r.id)) { box.hidden = true; return; }
    box.hidden = false;
    const btn = $('btn-join-here');
    const alt = $('btn-join-alt');
    const text = $('join-prompt-text');
    const q = myRoomReq(r.id);
    btn.disabled = false;
    btn.className = 'btn';
    alt.hidden = true;
    if (!r.locked && q && q.kind === 'invite') {
      text.textContent = `An admin invited you to #${r.name}.`;
      btn.textContent = 'Join room'; btn.dataset.action = 'join';
      alt.hidden = false; alt.textContent = 'Decline'; alt.dataset.action = 'dismiss';
    } else if (!r.locked) {
      text.textContent = `You're not in #${r.name} yet. Join to read and post.`;
      btn.textContent = 'Join room'; btn.dataset.action = 'join';
    } else if (amAdmin()) {
      text.textContent = `#${r.name} is locked. As an admin you can walk right in.`;
      btn.textContent = 'Join room'; btn.dataset.action = 'join';
    } else if (q && q.kind === 'invite') {
      text.textContent = `An admin invited you to #${r.name}.`;
      btn.textContent = 'Join room'; btn.dataset.action = 'join';
      alt.hidden = false; alt.textContent = 'Decline'; alt.dataset.action = 'dismiss';
    } else if (q) {
      text.textContent = `You asked to join #${r.name}. An admin will let you in.`;
      btn.textContent = 'Withdraw request'; btn.dataset.action = 'dismiss'; btn.className = 'btn btn-dark';
    } else {
      text.textContent = `#${r.name} is locked. Ask to join and an admin will decide.`;
      btn.textContent = 'Ask to join'; btn.dataset.action = 'request';
    }
  }

  async function joinPromptAction(action) {
    const r = room();
    if (!r) return;
    $('btn-join-here').disabled = true;
    try {
      if (action === 'join') return await joinRoom(r.id);
      if (action === 'request') {
        const res = await backend.requestToJoin(r.id);
        if (res === 'JOINED' || res === 'ALREADY_IN') return await joinRoom(r.id);
        st.roomReqs.set(reqKey(r.id, st.meId), { room_id: r.id, user_id: st.meId, kind: 'request', by_user: st.meId });
        note(`Request sent. You'll be let into #${r.name} when an admin says yes.`, 'ok');
      }
      if (action === 'dismiss') {
        await backend.dismissRoomRequest(r.id);
        st.roomReqs.delete(reqKey(r.id, st.meId));
      }
    } catch (e) { note(PZ.friendlyError(e), 'error'); }
    renderJoinPrompt(); renderRooms();
  }

  // Admins inside a locked group see who is waiting to get in.
  function renderRequestsBar() {
    const bar = $('requests-bar');
    const r = room();
    const list = r && r.locked && amAdmin() && isMemberOf(r.id) ? pendingRequests(r.id).filter((q) => st.profiles.has(q.user_id)) : [];
    bar.hidden = !list.length;
    bar.textContent = '';
    if (!list.length) return;
    bar.append(el('span', 'rq-label', `${list.length} waiting to get in:`));
    list.forEach((q) => {
      const chip = el('span', 'rq-chip');
      const name = el('button', 'rq-name', nameOf(q.user_id));
      name.type = 'button';
      name.style.color = colorOf(q.user_id);
      name.addEventListener('click', () => openPerson(q.user_id));
      const yes = el('button', 'btn btn-sm', 'Let in');
      yes.type = 'button';
      const no = el('button', 'btn btn-sm btn-dark', 'No');
      no.type = 'button';
      const answer = async (accept) => {
        yes.disabled = no.disabled = true;
        try {
          await backend.answerJoinRequest(r.id, q.user_id, accept);
          st.roomReqs.delete(reqKey(r.id, q.user_id));
          if (accept) addMember(r.id, q.user_id);
        } catch (e) { note(PZ.friendlyError(e), 'error'); }
        renderRequestsBar(); renderRooms();
      };
      yes.addEventListener('click', () => answer(true));
      no.addEventListener('click', () => answer(false));
      chip.append(name, yes, no);
      bar.append(chip);
    });
  }

  async function toggleLock() {
    const r = room();
    if (!r || r.kind !== 'group') return;
    const btn = $('btn-lock-toggle');
    btn.disabled = true;
    try {
      await backend.setGroupLocked(r.id, !r.locked);
      r.locked = !r.locked;
      if (!r.locked) for (const [k, q] of [...st.roomReqs]) if (k.startsWith(r.id + '|') && q.kind === 'request') st.roomReqs.delete(k);
    } catch (e) { note(PZ.friendlyError(e), 'error'); }
    btn.disabled = false;
    renderHead(); renderRooms(); renderRequestsBar(); renderJoinPrompt();
  }

  async function toggleCooldowns() {
    const r = room();
    if (!r || r.kind !== 'group') return;
    const on = !cooldownsIn(r);
    const btn = $('btn-cooldown-toggle');
    if (!btn) return;
    btn.disabled = true;
    try {
      await backend.setGroupCooldowns(r.id, on);
      r.cooldowns = on;
      note('');
    } catch (e) { note(PZ.friendlyError(e), 'error'); }
    btn.disabled = false;
    renderHead(); renderComposer();
  }

  // ---------------------------------------------------------------- side panels
  const PHONE = window.matchMedia('(max-width: 960px)');
  const isPhone = () => PHONE.matches;
  const sheetOpen = () => document.body.classList.contains('show-rooms') || document.body.classList.contains('show-people');
  let sheetOpener = null;

  // which: 'rooms' | 'people'. On phones this opens/closes a bottom sheet;
  // on bigger screens it expands/collapses the panel (remembered per browser).
  function setPanel(which, open) {
    const body = document.body;
    if (isPhone()) {
      if (!open) return closeOverlays();
      sheetOpener = document.activeElement;
      body.classList.remove('show-rooms', 'show-people');
      body.classList.add('show-' + which);
      const focusTarget = which === 'rooms' ? $('btn-collapse-rooms') : $('btn-collapse-people');
      setTimeout(() => focusTarget.focus({ preventScroll: true }), 50);
      return;
    }
    body.classList.toggle(which + '-collapsed', !open);
    store.set('pz_' + which + '_collapsed', open ? '0' : '1');
    const next = open ? (which === 'rooms' ? $('btn-collapse-rooms') : $('btn-collapse-people'))
      : (which === 'rooms' ? $('btn-expand-rooms') : $('btn-expand-people'));
    next.focus({ preventScroll: true });
  }

  function restorePanels() {
    document.body.classList.toggle('rooms-collapsed', store.get('pz_rooms_collapsed') === '1');
    document.body.classList.toggle('people-collapsed', store.get('pz_people_collapsed') === '1');
  }

  // Drag a sheet's header downwards to close it.
  function swipeToClose(handle) {
    let startY = null;
    let sheet = null;
    handle.addEventListener('pointerdown', (e) => {
      if (!isPhone() || e.target.closest('button, input')) return;
      startY = e.clientY;
      sheet = handle.closest('.panel');
      sheet.style.transition = 'none';
      handle.setPointerCapture(e.pointerId);
    });
    handle.addEventListener('pointermove', (e) => {
      if (startY === null) return;
      sheet.style.transform = `translateY(${Math.max(0, e.clientY - startY)}px)`;
    });
    const end = (e) => {
      if (startY === null) return;
      const dy = e.clientY - startY;
      startY = null;
      sheet.style.transition = '';
      sheet.style.transform = '';
      if (dy > 80) closeOverlays();
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  function closeOverlays() {
    const wasOpen = sheetOpen();
    document.body.classList.remove('show-rooms', 'show-people');
    if (wasOpen && sheetOpener && document.contains(sheetOpener)) sheetOpener.focus({ preventScroll: true });
    sheetOpener = null;
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
      const name = el('span', 'join-name', r.name);
      if (r.locked) { const lock = el('span', 'room-lock'); lock.innerHTML = LOCK_SVG; name.append(lock); }
      const q = myRoomReq(r.id);
      const open = !r.locked || amAdmin() || (q && q.kind === 'invite');
      const b = el('button', 'btn btn-sm' + (open ? '' : ' btn-dark'), open ? 'Join' : q ? 'Asked' : 'Ask to join');
      b.type = 'button';
      b.disabled = !open && !!q;
      b.addEventListener('click', async () => {
        $('dlg-join').close();
        if (open) return joinRoom(r.id);
        await openRoom(r.id);
        joinPromptAction('request');
      });
      row.append(icon, name, el('span', 'join-count', `${memberCount(r)} members`), b);
      list.append(row);
    });
    $('dlg-join').showModal();
  }

  // ---------------------------------------------------------------- invite links
  const pageBase = () => location.href.split('#')[0].split('?')[0];
  const linkFor = (code) => `${pageBase()}#invite=${code}`;
  const fmtDay = (t) => new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' });

  async function openInviteDialog() {
    $('invite-error').hidden = true;
    $('invite-link').textContent = '…';
    $('invite-meta').textContent = '';
    $('invite-explain').textContent = `Anyone with this link can join for ${st.settings.invite_days} days. Send it anywhere: WhatsApp, email, a DM.`;
    $('dlg-invite').showModal();
    try {
      st.invites = await backend.listInvites();
      if (!st.invites.length) {
        await backend.createInvite();
        st.invites = await backend.listInvites();
      }
      renderInvites(st.invites[0] && st.invites[0].code);
    } catch (e) { inviteError(e); }
  }

  function inviteError(e) {
    $('invite-error').textContent = PZ.friendlyError(e);
    $('invite-error').hidden = false;
  }

  function renderInvites(selected) {
    const cur = st.invites.find((i) => i.code === selected) || st.invites[0];
    st.inviteSelected = cur ? cur.code : null;
    $('invite-link').textContent = cur ? linkFor(cur.code) : 'No live links. Press New link.';
    $('invite-meta').textContent = cur ? `Works until ${fmtDay(cur.expires_at)} • ${cur.uses} joined so far` : '';
    $('invite-copy').disabled = !cur;
    const list = $('invite-list');
    list.textContent = '';
    $('invite-list-wrap').hidden = !st.invites.length;
    st.invites.forEach((i) => {
      const row = el('div', 'invite-row' + (cur && i.code === cur.code ? ' is-current' : ''));
      const pick = el('button', 'invite-pick', `…${i.code.slice(-4)}`);
      pick.type = 'button';
      pick.title = 'Show this link';
      pick.addEventListener('click', () => renderInvites(i.code));
      const off = el('button', 'btn btn-sm btn-dark', 'Switch off');
      off.type = 'button';
      off.addEventListener('click', async () => {
        off.disabled = true;
        try { await backend.revokeInvite(i.code); st.invites = await backend.listInvites(); renderInvites(st.inviteSelected); }
        catch (e) { off.disabled = false; inviteError(e); }
      });
      row.append(pick, el('span', 'invite-row-meta', `until ${fmtDay(i.expires_at)} • ${i.uses} joined`), off);
      list.append(row);
    });
  }

  function openCreateDialog() {
    $('create-name').value = '';
    $('create-error').hidden = true;
    $('create-locked').checked = false;
    $('create-locked-row').hidden = !amAdmin();
    const fs = $('create-icons');
    fs.querySelectorAll('label').forEach((n) => n.remove());
    ICONS.forEach((ic, i) => {
      const l = el('label', 'icon-opt');
      const inp = el('input');
      inp.type = 'radio'; inp.name = 'icon'; inp.value = ic; inp.checked = i === 0;
      const sp = el('span', null, ic);
      sp.style.color = ICON_COLORS[ic];
      l.append(inp, sp);
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
      const sp = el('span');
      sp.style.background = c;
      l.title = c;
      l.append(inp, sp);
      fs.append(l);
    });
    $('dlg-profile').showModal();
  }

  // ---------------------------------------------------------------- sign on
  // An invite code survives the trip to Google and back in localStorage.
  const INVITE_KEY = 'pz_invite';
  const NAME_KEY = 'pz_name';
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch (_) { /* private mode */ } }
  };
  const PANELS = {
    signin: 'Sign on to Pazhampori chat',
    invite: "You're invited",
    finish: 'One last step'
  };

  function inviteFromUrl() {
    const m = (location.hash + '&' + location.search).match(/[#?&]invite=([A-Za-z0-9]{4,20})/);
    return m ? m[1].toUpperCase() : null;
  }

  // When Google sign-in fails, Supabase sends people back here with
  // ?error=...&error_description=... (or the same after #). Read it before
  // anything tidies the address bar, so the page can say what went wrong
  // instead of quietly showing the start again.
  function signInErrorFromUrl() {
    const params = new URLSearchParams(location.search);
    new URLSearchParams(location.hash.replace(/^#/, '')).forEach((v, k) => { if (!params.has(k)) params.set(k, v); });
    const error = params.get('error');
    const desc = params.get('error_description') || '';
    if (!error && !desc) return null;
    if (error === 'access_denied') return 'Google sign-in was cancelled. Try again when you are ready.';
    if (/exchange external code/i.test(desc)) {
      return 'Google sign-in could not finish because the chat\'s Google setup was rejected. ' +
        'That is a problem on our side, not yours. Try again in a few minutes, and if it keeps happening, tell whoever invited you.';
    }
    if (/signups? not allowed/i.test(desc)) return 'New sign-ups are switched off right now.';
    return 'Google sign-in did not finish: ' + (desc || error).slice(0, 200);
  }

  function showPanel(name, msg) {
    entered = false;
    $('toolbar').hidden = true;
    $('main').hidden = true;
    $('banned').hidden = true;
    $('signon').hidden = false;
    $('sb-you').hidden = true;
    $('sb-words').textContent = '';
    $('sb-conn').textContent = backend.mode === 'demo' ? 'Demo mode: the Google button signs you straight in.' : 'Not connected';
    Object.keys(PANELS).forEach((k) => { $('panel-' + k).hidden = k !== name; });
    $('auth-title').textContent = PANELS[name];
    authMsg(msg && msg.error);
  }

  function authMsg(error) {
    $('auth-error').textContent = error || '';
    $('auth-error').hidden = !error;
  }

  function busy(btn, on) {
    if (btn) btn.disabled = on;
    $('modem-line').textContent = on ? 'ATDT 555-0199 … dialing …' : 'ATDT 555-0199 … CONNECT 56000';
  }

  async function showInvite(code, error) {
    showPanel('invite', { error });
    st.inviteCode = code;
    $('invite-code-show').textContent = code;
    $('invite-hello').textContent = "You're invited to Pazhampori chat. Pick a screen name, then join with your Google account.";
    try {
      const state = await backend.checkInvite(code);
      if (state !== 'OK') authMsg(PZ.ERRORS[state] || PZ.ERRORS.INVITE_INVALID);
    } catch (_) { /* checked again on join */ }
  }

  // Checks the invite (from the link) and the screen name typed on the invite page.
  async function readInviteForm() {
    const code = st.inviteCode;
    const name = $('invite-username').value.trim();
    if (!code) throw Object.assign(new Error('INVITE_INVALID'), { code: 'INVITE_INVALID' });
    const state = await backend.checkInvite(code, name);
    if (state !== 'OK') throw Object.assign(new Error(state), { code: state });
    store.set(INVITE_KEY, code);
    store.set(NAME_KEY, name);
    return { code, name };
  }

  let finishingFor = null;
  // Runs after any sign-in: members go straight in, others finish joining.
  async function afterSignIn(id) {
    if (!id || finishingFor === id || (entered && st.meId === id)) return;
    finishingFor = id;
    st.meId = id;
    let self = null;
    try { self = await backend.loadSelf(); }
    catch (e) { finishingFor = null; return showPanel('signin', { error: PZ.friendlyError(e) }); }
    if (self) {
      store.del(INVITE_KEY); store.del(NAME_KEY);
      finishingFor = null;
      return enterChat(id, self);
    }
    const code = store.get(INVITE_KEY);
    const name = store.get(NAME_KEY);
    if (code && name) {
      try {
        await backend.joinWithInvite(code, name);
        store.del(INVITE_KEY); store.del(NAME_KEY);
        finishingFor = null;
        return enterChat(id);
      } catch (e) {
        finishingFor = null;
        return showFinish(code, name, PZ.friendlyError(e));
      }
    }
    finishingFor = null;
    showFinish(code || '', name || '');
  }

  // Signed in with Google but no profile yet. Without an invite link there
  // is nothing to do here except sign out.
  function showFinish(code, name, error) {
    showPanel('finish', { error });
    st.inviteCode = code || null;
    $('finish-code-show').textContent = code || '';
    $('finish-username').value = name || '';
    $('form-finish').hidden = !code;
    $('finish-text').textContent = code
      ? 'Almost in. Check your screen name and enter.'
      : "You're signed in, but you're not a member. Pazhampori chat is invite-only: open the invite link a member sent you, then join with Google.";
  }

  // ---------------------------------------------------------------- boot
  async function enterChat(id, self) {
    if (entered && st.meId === id) return;
    entered = true;
    st.meId = id;
    if (!self) { try { self = await backend.loadSelf(); } catch (_) { /* loadAll below reports errors */ } }
    if (self && self.banned_at) return showBanned();
    let d;
    try { d = await backend.loadAll(); } catch (e) { entered = false; return showPanel('signin', { error: PZ.friendlyError(e) }); }
    st.profiles.clear(); d.profiles.forEach((p) => st.profiles.set(p.id, p));
    if (!st.profiles.has(id)) { entered = false; return showFinish(store.get(INVITE_KEY), store.get(NAME_KEY)); }
    st.rooms.clear(); d.rooms.forEach((r) => st.rooms.set(r.id, r));
    st.members.clear(); d.memberships.forEach((m) => addMember(m.room_id, m.user_id));
    st.requests.clear(); d.friendRequests.forEach((r) => st.requests.set(r.id, r));
    st.roomReqs.clear(); (d.roomRequests || []).forEach((q) => st.roomReqs.set(reqKey(q.room_id, q.user_id), q));
    st.settings = Object.assign({}, PZ.DEFAULT_SETTINGS, d.settings);
    st.msgs.clear(); st.unread.clear(); st.local.clear();

    $('signon').hidden = true;
    $('toolbar').hidden = false;
    $('main').hidden = false;
    renderStatus();
    const g = globalRoom();
    backend.subscribe({
      message: addMessage,
      profile: (p) => {
        st.profiles.set(p.id, Object.assign(st.profiles.get(p.id) || {}, p));
        if (p.id === st.meId && p.banned_at) return showBanned();
        renderPeople(); renderStatus();
        if (p.id === st.meId) { renderComposer(); renderHead(); renderJoinPrompt(); renderRequestsBar(); }
        if ($('dlg-person').open) renderPersonCard();
      },
      room: (r) => {
        const before = st.rooms.get(r.id);
        const coolChanged = !!before && cooldownsIn(before) !== cooldownsIn(Object.assign({}, before, r));
        st.rooms.set(r.id, Object.assign(before || {}, r));
        if (coolChanged && r.id === st.current) note('');
        renderRooms(); renderPeople();
        if (r.id === st.current) { renderHead(); renderJoinPrompt(); renderRequestsBar(); renderComposer(); }
      },
      membership: (op, m) => {
        if (op === 'add') addMember(m.room_id, m.user_id);
        else if (st.members.has(m.room_id)) st.members.get(m.room_id).delete(m.user_id);
        if (m.room_id === st.current) { renderPeople(); renderHead(); }
        if (m.user_id === st.meId && m.room_id === st.current && op === 'add' && $('composer').hidden) {
          st.roomReqs.delete(reqKey(m.room_id, st.meId));
          st.msgs.delete(m.room_id);
          openRoom(m.room_id);
        }
        renderRooms();
        if ($('dlg-person').open) renderPersonCard();
      },
      roomRequest: (op, q) => {
        const k = reqKey(q.room_id, q.user_id);
        if (op === 'add') st.roomReqs.set(k, q); else st.roomReqs.delete(k);
        const r = st.rooms.get(q.room_id);
        if (op === 'add' && r && q.user_id === st.meId && q.kind === 'invite') {
          note(`An admin invited you to #${r.name}. It's in your room list.`, 'ok');
          flashRoom(q.room_id);
        }
        if (op === 'add' && r && q.kind === 'request' && amAdmin()) flashRoom(q.room_id);
        renderRooms();
        if (q.room_id === st.current) { renderJoinPrompt(); renderRequestsBar(); }
        if ($('dlg-person').open) renderPersonCard();
      },
      friendRequest: (r) => {
        for (const [k, v] of st.requests) if (String(k).startsWith('local-') && v.to_user === r.to_user && v.from_user === r.from_user) st.requests.delete(k);
        st.requests.set(r.id, r);
        if (r.status === 'accepted') refreshSocial().then(() => { renderPeople(); if ($('dlg-person').open) renderPersonCard(); });
        renderPeople();
        if ($('dlg-person').open) renderPersonCard();
      },
      settings: (sv) => { st.settings = Object.assign(st.settings, sv); renderStatus(); renderComposer(); },
      reaction: (op, x) => {
        if (!x || x.message_id == null || !x.user_id) return;
        setLocalReaction(x.message_id, x.user_id, op === 'remove' ? null : x.kind);
        refreshReacts(x.message_id);
      },
      presence: onPresence,
      connection: (c) => { st.conn = c; renderStatus(); }
    });
    if (g) await openRoom(g.id);
    pushPresence();
    ping();
  }

  function wire() {
    // Sign on: Google only, and new people only through an invite link
    $('btn-google-signin').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      authMsg();
      busy(btn, true);
      try {
        await backend.signInWithGoogle();
        if (backend.mode === 'demo') await afterSignIn(await backend.currentUserId());
      } catch (err) { authMsg(PZ.friendlyError(err)); busy(btn, false); }
    });
    $('link-back-signin').addEventListener('click', () => showPanel('signin'));

    $('btn-google-join').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      authMsg();
      busy(btn, true);
      try {
        await readInviteForm();
        await backend.signInWithGoogle();
        if (backend.mode === 'demo') await afterSignIn(await backend.currentUserId());
      } catch (err) { authMsg(PZ.friendlyError(err)); busy(btn, false); }
    });

    $('form-finish').addEventListener('submit', async (e) => {
      e.preventDefault();
      authMsg();
      const name = $('finish-username').value.trim();
      busy($('finish-submit'), true);
      try {
        await backend.joinWithInvite(st.inviteCode, name);
        store.del(INVITE_KEY); store.del(NAME_KEY);
        await enterChat(st.meId);
      } catch (err) { authMsg(PZ.friendlyError(err)); }
      finally { busy($('finish-submit'), false); }
    });
    $('link-finish-signout').addEventListener('click', async () => {
      store.del(NAME_KEY);
      try { await backend.signOut(); } finally { location.reload(); }
    });

    // Toolbar and rooms
    $('btn-join').addEventListener('click', openJoinDialog);
    $('btn-invite').addEventListener('click', openInviteDialog);
    $('btn-create').addEventListener('click', openCreateDialog);
    $('btn-join-here').addEventListener('click', (e) => joinPromptAction(e.currentTarget.dataset.action));
    $('btn-join-alt').addEventListener('click', (e) => joinPromptAction(e.currentTarget.dataset.action));
    $('btn-lock-toggle').addEventListener('click', toggleLock);
    if ($('btn-cooldown-toggle')) $('btn-cooldown-toggle').addEventListener('click', toggleCooldowns);
    $('pc-lock-btn').addEventListener('click', inviteToLockedGroup);
    // Side panels: collapse to rails on desktop, bottom sheets on phones.
    $('btn-collapse-rooms').addEventListener('click', () => setPanel('rooms', false));
    $('btn-expand-rooms').addEventListener('click', () => setPanel('rooms', true));
    $('btn-collapse-people').addEventListener('click', () => setPanel('people', false));
    $('btn-expand-people').addEventListener('click', () => setPanel('people', true));
    $('btn-title-rooms').addEventListener('click', () => { if (isPhone() || document.body.classList.contains('rooms-collapsed')) setPanel('rooms', true); });
    $('btn-online-people').addEventListener('click', () => { if (isPhone() || document.body.classList.contains('people-collapsed')) setPanel('people', true); });
    $('sheet-backdrop').addEventListener('click', closeOverlays);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && isPhone() && sheetOpen()) closeOverlays(); });
    swipeToClose($('rooms-panel').querySelector('.panel-head'));
    swipeToClose($('people-panel').querySelector('.people-tabs'));
    restorePanels();
    $('room-search').addEventListener('input', (e) => { st.search = e.target.value; renderRooms(); });

    $('ptab-all').addEventListener('click', () => setPeopleTab('all'));
    $('ptab-friends').addEventListener('click', () => setPeopleTab('friends'));

    // Composer
    const input = $('msg-input');
    input.addEventListener('input', () => { autosize(); note(''); renderComposer(); if (input.value.trim()) startTyping(); else stopTyping(); markActive(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    });
    $('composer').addEventListener('submit', (e) => { e.preventDefault(); send(); });
    // Tapping SEND shouldn't take focus from the message box (keeps the keyboard up).
    $('btn-send').addEventListener('mousedown', (e) => { if (document.activeElement === input) e.preventDefault(); });

    // Keep the whole app inside the visible area. On phones the keyboard
    // shrinks that area, and the message box must stay above it.
    const vv = window.visualViewport;
    const fit = () => {
      const h = vv ? vv.height * (vv.scale || 1) : window.innerHeight;
      document.documentElement.style.setProperty('--app-h', Math.round(h) + 'px');
      if (vv && vv.offsetTop > 0 && vv.scale <= 1.01) window.scrollTo(0, 0);
    };
    if (vv) { vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit); }
    window.addEventListener('resize', fit);
    fit();
    // Phones: while typing, hide the extra bars so the conversation has room.
    input.addEventListener('focus', () => {
      if (!isPhone()) return;
      document.body.classList.add('kb-open');
      setTimeout(() => { const box = $('messages'); box.scrollTop = box.scrollHeight; }, 300);
    });
    input.addEventListener('blur', () => document.body.classList.remove('kb-open'));

    const MAX_IMAGE = 5 * 1024 * 1024;

    // Shrink images before they upload, to save Supabase storage and
    // bandwidth: longest side 1280px, compressed as WebP (or JPEG where the
    // browser can't make WebP). GIFs are left alone so they keep moving, and
    // the original is kept if shrinking wouldn't make it smaller.
    const MAX_SIDE = 1280;
    const toBlob = (c, type, q) => new Promise((res) => c.toBlob(res, type, q));
    async function shrinkIfNeeded(f) {
      if (f.type === 'image/gif' || !window.createImageBitmap) return f;
      try {
        const bmp = await createImageBitmap(f);
        const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
        if (scale === 1 && f.size <= 200 * 1024) return f;
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(bmp.width * scale));
        c.height = Math.max(1, Math.round(bmp.height * scale));
        const ctx = c.getContext('2d');
        ctx.drawImage(bmp, 0, 0, c.width, c.height);
        let blob = await toBlob(c, 'image/webp', 0.82);
        if (!blob || blob.type !== 'image/webp') {
          // JPEG has no see-through parts: put white behind the picture.
          ctx.globalCompositeOperation = 'destination-over';
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, c.width, c.height);
          blob = await toBlob(c, 'image/jpeg', 0.82);
        }
        if (!blob || blob.size >= f.size) return f;
        const ext = blob.type === 'image/webp' ? '.webp' : '.jpg';
        return new File([blob], (f.name || 'image').replace(/\.[^.]*$/, '') + ext, { type: blob.type });
      } catch (_) { return f; }
    }

    // One path for images, whether picked with the button or pasted.
    async function pickImage(f) {
      if (!f || $('composer').hidden) return;
      if (limits().dm) return note(PZ.ERRORS.NO_IMAGES_FOR_FRIENDS, 'error');
      if (lockState()) return note(PZ.ERRORS.IMAGE_LOCKED, 'error');
      if (!/^image\/(png|jpeg|gif|webp)$/.test(f.type)) return note('Only PNG, JPEG, GIF or WebP images.', 'error');
      f = await shrinkIfNeeded(f);
      if (f.size > MAX_IMAGE) return note('That image is too big (5 MB max).', 'error');
      const words = PZ.countWords(input.value);
      if (words > limits().words) return note(`Your caption has ${words} words. The limit is ${limits().words}.`, 'error');
      st.pendingFile = f;
      const prev = $('img-preview');
      if (prev.dataset.url) URL.revokeObjectURL(prev.dataset.url);
      prev.dataset.url = URL.createObjectURL(f);
      prev.src = prev.dataset.url;
      $('img-warning').textContent = `After sending an image you can't send anything for ${imageLockText()}.` +
        (words ? ` Your typed text (${words} word${words === 1 ? '' : 's'}) goes with it as a caption.` : '');
      $('dlg-image').returnValue = '';
      $('dlg-image').showModal();
    }

    $('img-input').addEventListener('change', (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      pickImage(f);
    });

    // Paste an image (Ctrl+V / Cmd+V) into the message box, or anywhere in
    // the chat that isn't another text field. Plain text pastes as usual.
    document.addEventListener('paste', (e) => {
      if (!entered || document.querySelector('dialog[open]')) return;
      const t = e.target;
      const otherField = t && t !== input &&
        (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
      if (otherField) return;
      const dt = e.clipboardData;
      if (!dt) return;
      let f = Array.from(dt.files || []).find((x) => /^image\//.test(x.type));
      if (!f) {
        const item = Array.from(dt.items || []).find((x) => x.kind === 'file' && /^image\//.test(x.type));
        f = item && item.getAsFile();
      }
      if (!f) return;
      e.preventDefault();
      pickImage(f);
    });

    $('dlg-image').addEventListener('close', () => {
      const f = st.pendingFile;
      st.pendingFile = null;
      if ($('dlg-image').returnValue === 'send' && f) send(f);
    });

    // Dialogs
    $('form-create').addEventListener('submit', async (e) => {
      if (e.submitter && e.submitter.value === 'cancel') return;
      e.preventDefault();
      const name = $('create-name').value.trim().toLowerCase();
      const icon = (document.querySelector('#create-icons input:checked') || {}).value || '#';
      const locked = amAdmin() && $('create-locked').checked;
      $('create-submit').disabled = true;
      try {
        const id = await backend.createGroup(name, icon, locked);
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
      const text = st.inviteSelected ? linkFor(st.inviteSelected) : '';
      if (!text) return;
      try { await navigator.clipboard.writeText(text); $('invite-copy').textContent = 'Copied'; }
      catch (_) {
        const r = document.createRange(); r.selectNodeContents($('invite-link'));
        const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
        $('invite-copy').textContent = 'Press Ctrl+C';
      }
      setTimeout(() => { $('invite-copy').textContent = 'Copy link'; }, 2000);
    });
    $('invite-new').addEventListener('click', async () => {
      $('invite-error').hidden = true;
      $('invite-new').disabled = true;
      try {
        const made = await backend.createInvite();
        st.invites = await backend.listInvites();
        renderInvites(made.code);
      } catch (e) { inviteError(e); }
      finally { $('invite-new').disabled = false; }
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
    $('btn-banned-signout').addEventListener('click', async () => {
      try { await backend.signOut(); } finally { location.reload(); }
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
    const signInError = signInErrorFromUrl();
    const linkCode = inviteFromUrl();
    if (linkCode) store.set(INVITE_KEY, linkCode);
    const live = cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY;
    if (live && !window.supabase) {
      backend = PZ.createDemoBackend();
      return showPanel('signin', { error: 'Could not load the Supabase library. Check your internet connection and reload.' });
    }
    backend = live ? PZ.createSupabaseBackend(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY) : PZ.createDemoBackend();
    document.body.classList.toggle('is-demo', backend.mode === 'demo');
    backend.onAuthChange((id) => {
      if (id) afterSignIn(id);
      else if (entered) location.reload();
    });
    // An invite link opened in a tab that already shows this page.
    window.addEventListener('hashchange', () => {
      const c = inviteFromUrl();
      if (!c) return;
      store.set(INVITE_KEY, c);
      history.replaceState(null, '', location.pathname);
      if (!entered) showInvite(c);
    });
    const id = await backend.currentUserId();
    // Tidy the address bar once Supabase has read any ?code= from Google.
    if (location.hash || location.search) history.replaceState(null, '', location.pathname);
    if (id) return afterSignIn(id);
    const code = linkCode || store.get(INVITE_KEY);
    if (code) return showInvite(code, signInError);
    showPanel('signin', { error: signInError });
  }

  start();
})();
