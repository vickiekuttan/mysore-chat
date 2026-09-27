// DEMO MODE: a pretend server that lives in this browser tab.
// Same rules as the real database, fake people, nothing is saved.
(function () {
  const now = () => Date.now();
  const iso = (t) => new Date(t).toISOString();
  const uid = () => Math.random().toString(36).slice(2, 10);

  function fail(code) { const e = new Error(code); e.code = code; throw e; }

  function createDemoBackend() {
    const S = Object.assign({}, window.PZ.DEFAULT_SETTINGS, { total_words: 412338 });
    const ME = 'me';
    let signedIn = false;
    let hasProfile = true;   // false between signing up and picking a screen name
    let h = null;
    let nextMsgId = 500;
    const images = new Map();

    const people = [
      ['jen', 'ADMIN_Jen', '#e02020', 'T1', '', true, 12],
      ['suze', 'cyberSuze', '#e0338f', '56k', 'NYC', false, 0],
      ['dragon', 'xX_Dragon_Xx', '#8a2be2', 'ISDN', '', false, 0],
      ['pete', 'pixel_pete', '#1e6fe0', '28.8k', '', false, 1],
      ['moon', 'moonchild77', '#12a07a', '33.6k', 'headphones', false, 0],
      ['beep', 'beepBoop', '#e0661a', 'cable', '', false, 2],
      ['angel', 'netAngel', '#1ba3bd', '56k', '', false, 4],
      ['kid', 'cassetteKid', '#b8860b', '28.8k', 'just arrived', false, 0],
      ['liz', 'laser_liz', '#c2187a', '56k', 'brb dinner', false, 25]
    ];
    // In the demo you are the founder, so every admin tool can be tried.
    const profiles = [{ id: ME, username: 'star_gazer', color: '#e6c200', modem: '56k', status_text: '', is_admin: true, is_owner: true, banned_at: null, muted_until: null, image_locked_until: null }]
      .concat(people.map(([id, username, color, modem, status_text, is_admin]) =>
        ({ id, username, color, modem, status_text, is_admin, is_owner: false, banned_at: null, muted_until: null, image_locked_until: null })));
    const idle = Object.fromEntries(people.map((p) => [p[0], p[6]]));

    const rooms = [{ id: 'global', kind: 'global', name: 'Global chat', icon: '*' }];
    const joined = ['after_school', 'music_swap', 'homepage_help', 'skate_spot'];
    const explore = [['newbies', '*'], ['mp3_cafe', '♬'], ['webmasters', '@'], ['conspiracies', '?'], ['pen_pals', '♥'], ['game_zone', '!']];
    joined.forEach((n) => rooms.push({ id: n, kind: 'group', name: n, icon: '#' }));
    explore.forEach(([n, i]) => rooms.push({ id: n, kind: 'group', name: n, icon: i }));

    const memberships = [];
    const everyone = profiles.map((p) => p.id);
    joined.forEach((r, i) => everyone.slice(0, 4 + i * 2).forEach((u) => memberships.push({ room_id: r, user_id: u })));
    explore.forEach(([r], i) => everyone.slice(1, 3 + i).forEach((u) => memberships.push({ room_id: r, user_id: u })));

    // A locked group you're in (as an admin), with someone waiting to be let in,
    // and one you're not in yet.
    rooms.push({ id: 'vip_lounge', kind: 'group', name: 'vip_lounge', icon: '$', locked: true, created_by: 'jen' });
    ['jen', ME, 'suze'].forEach((u) => memberships.push({ room_id: 'vip_lounge', user_id: u }));
    rooms.push({ id: 'mods_only', kind: 'group', name: 'mods_only', icon: '!', locked: true, created_by: 'jen' });
    memberships.push({ room_id: 'mods_only', user_id: 'jen' });
    const roomRequests = [
      { room_id: 'vip_lounge', user_id: 'angel', kind: 'request', by_user: 'angel', created_at: iso(now() - 600000) }
    ];
    const invites = [];

    const friendRequests = [];
    let reqId = 1;
    ['suze', 'dragon', 'pete', 'beep', 'angel'].forEach((f) => {
      friendRequests.push({ id: reqId++, from_user: f, to_user: ME, status: 'accepted' });
      const room = { id: 'dm-' + f, kind: 'dm', name: null, icon: '@', dm_key: 'me:' + f };
      rooms.push(room);
      memberships.push({ room_id: room.id, user_id: ME }, { room_id: room.id, user_id: f });
    });
    ['moon', 'kid', 'liz'].forEach((f) => friendRequests.push({ id: reqId++, from_user: f, to_user: ME, status: 'pending' }));

    const messages = [];
    function add(room_id, user_id, body, kind = 'text', ago = 0, image_path = null) {
      const m = { id: nextMsgId++, room_id, user_id, kind, body, image_path,
        word_count: kind === 'system' ? 0 : window.PZ.countWords(body), created_at: iso(now() - ago * 1000) };
      messages.push(m);
      return m;
    }
    [
      ['suze', 'who remembers the aquarium screensaver cheat code?'],
      ['dragon', 'up up down down left right B A'],
      ['pete', 'brb rebooting. modem noise even when OFFLINE.'],
      ['jen', 'Reminder: no chain letters, no flooding. Thanks!'],
      ['moon', '♪ now playing: Steal My Sunshine, Len'],
      ['beep', '/\\_/\\ ( o.o ) web site needs glitter'],
      ['angel', 'made everybody a spinning homepage button. Uploading!'],
      ['kid', 'hiiii sorry, took 4 tries to connect.'],
      ['suze', '@cassetteKid welcome back!! Pete posted it above.'],
      ['dragon', 'prediction: songs download in ten seconds someday.'],
      ['pete', 'BACK. computer survived. optimism belongs in #conspiracies.']
    ].forEach(([u, b], i, all) => add('global', u, b, 'text', (all.length - i) * 40));
    add('after_school', 'kid', 'JOINED', 'system', 300);
    add('after_school', 'suze', 'anyone finish the geometry worksheet?', 'text', 250);
    add('music_swap', 'moon', 'trading my mixtape for your burned CD', 'text', 900);
    add('dm-suze', 'suze', 'hey!! did you see the new guestbook I added to my homepage? it has a hit counter and a little spinning globe gif', 'text', 3000);

    const bots = [
      ['dragon', 'who has the MIDI of that one song'],
      ['suze', 'my mom needs the phone line. 5 minutes!!'],
      ['angel', 'guestbook is live. sign it please :)'],
      ['beep', 'lol my cat walked on the keyboard'],
      ['pete', 'anyone else stuck at 26.4k tonight?'],
      ['moon', 'a/s/l? jk jk'],
      ['kid', 'finally got the mp3. 45 minutes. worth it'],
      ['jen', 'Please keep it friendly, everyone.']
    ];
    let botIdx = 0;
    let typers = {};

    function emit(fn, ...args) { if (h && h[fn]) setTimeout(() => h[fn](...args), 0); }
    function presence() {
      const state = {};
      profiles.forEach((p) => {
        if (p.id === ME) { if (myPresence) state[ME] = myPresence; return; }
        state[p.id] = { user_id: p.id, room_id: 'global', typing: !!typers[p.id],
          away: p.id === 'liz', active_at: now() - idle[p.id] * 60000 };
      });
      emit('presence', state);
    }
    let myPresence = null;

    function botTick() {
      const [u, text] = bots[botIdx++ % bots.length];
      const bp = profiles.find((p) => p.id === u);
      if (bp && bp.banned_at) return;
      typers[u] = true; presence();
      setTimeout(() => {
        typers[u] = false; idle[u] = 0;
        S.total_words += window.PZ.countWords(text);
        emit('message', add('global', u, text));
        emit('settings', Object.assign({}, S));
        presence();
      }, 2500);
    }

    function me() { return profiles.find((p) => p.id === ME); }
    function dropRequest(roomId, userId) {
      const i = roomRequests.findIndex((q) => q.room_id === roomId && q.user_id === userId);
      if (i < 0) return;
      const [row] = roomRequests.splice(i, 1);
      emit('roomRequest', 'remove', { room_id: row.room_id, user_id: row.user_id });
    }
    function addToRoom(roomId, userId) {
      dropRequest(roomId, userId);
      if (memberships.some((m) => m.room_id === roomId && m.user_id === userId)) return;
      memberships.push({ room_id: roomId, user_id: userId });
      emit('membership', 'add', { room_id: roomId, user_id: userId });
      emit('message', add(roomId, userId, 'JOINED', 'system'));
    }
    function canRead(roomId) {
      const r = rooms.find((x) => x.id === roomId);
      return r && (r.kind === 'global' || memberships.some((m) => m.room_id === roomId && m.user_id === ME));
    }

    return {
      mode: 'demo',
      host: 'irc.pazhampori.example:6667',

      async currentUserId() { return signedIn ? ME : null; },
      onAuthChange() {},
      async signInWithGoogle() {
        signedIn = true;
        try { if (localStorage.getItem('pz_invite')) hasProfile = false; } catch (_) { /* ignore */ }
      },
      async checkInvite(code, username) {
        if (!code) return 'INVITE_INVALID';
        if (username !== undefined && username !== null) {
          if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) return 'USERNAME_INVALID';
          if (profiles.some((p) => p.id !== ME && p.username.toLowerCase() === username.toLowerCase())) return 'USERNAME_TAKEN';
        }
        return 'OK';
      },
      async joinWithInvite(code, username) {
        const st = await this.checkInvite(code, username);
        if (st !== 'OK') fail(st);
        me().username = username;
        hasProfile = true;
      },
      async signOut() { signedIn = false; },

      async loadAll() {
        return JSON.parse(JSON.stringify({ profiles, rooms, memberships, friendRequests, settings: S, roomRequests }));
      },
      async loadMessages(roomId) {
        if (!canRead(roomId)) return [];
        return messages.filter((m) => m.room_id === roomId).slice(-150);
      },

      async sendMessage(roomId, body, file) {
        const p = me();
        const room = rooms.find((r) => r.id === roomId);
        if (!room) fail('ROOM_NOT_FOUND');
        if (!canRead(roomId)) fail('NOT_IN_ROOM');
        if (p.image_locked_until && Date.parse(p.image_locked_until) > now()) fail('IMAGE_LOCKED');
        if (p.muted_until && Date.parse(p.muted_until) > now()) fail('SPAM_WAIT');
        const text = String(body || '').trim();
        const words = window.PZ.countWords(text);
        if (!words && !file) fail('EMPTY');
        const dm = room.kind === 'dm';
        if (dm && file) fail('NO_IMAGES_FOR_FRIENDS');
        if (words > (dm ? S.max_words_friends : S.max_words_public)) fail('TOO_MANY_WORDS');
        if (text.length > (dm ? S.max_chars_friends : S.max_chars_public)) fail('TOO_LONG');

        let path = null;
        if (file) { path = ME + '/' + uid(); images.set(path, URL.createObjectURL(file)); }
        const m = add(roomId, ME, text, file ? 'image' : 'text', 0, path);
        emit('message', m);
        if (file) p.image_locked_until = iso(now() + S.image_lock_seconds * 1000);

        let wiped = false;
        if (!dm) {
          const since = now() - S.spam_window_seconds * 1000;
          const recent = messages.filter((x) => x.user_id === ME && x.kind !== 'system' &&
            Date.parse(x.created_at) > since && rooms.find((r) => r.id === x.room_id).kind !== 'dm').length;
          if (recent >= S.spam_count) p.muted_until = iso(now() + S.spam_wait_seconds * 1000);
          S.total_words += words;
          if (S.total_words >= S.wipe_at_words) {
            for (let i = messages.length - 1; i >= 0; i--) {
              if (rooms.find((r) => r.id === messages[i].room_id).kind !== 'dm') messages.splice(i, 1);
            }
            S.total_words = 0;
            emit('message', add('global', null, 'WIPE', 'system'));
            wiped = true;
          }
          emit('settings', Object.assign({}, S));
        }
        emit('profile', Object.assign({}, p));
        return { id: m.id, wiped, path };
      },

      async createGroup(name, icon, locked) {
        const n = String(name || '').trim().toLowerCase();
        if (locked && !me().is_admin) fail('NOT_ADMIN');
        if (!/^[a-z0-9_]{2,24}$/.test(n)) fail('GROUP_NAME_INVALID');
        if (rooms.some((r) => r.kind === 'group' && r.name === n)) fail('GROUP_NAME_TAKEN');
        const room = { id: 'g-' + uid(), kind: 'group', name: n, icon: icon || '#', created_by: ME, locked: !!locked };
        rooms.push(room);
        memberships.push({ room_id: room.id, user_id: ME });
        emit('room', room);
        emit('membership', 'add', { room_id: room.id, user_id: ME });
        emit('message', add(room.id, ME, 'CREATED', 'system'));
        return room.id;
      },
      async joinRoom(id) {
        if (memberships.some((m) => m.room_id === id && m.user_id === ME)) return;
        const r = rooms.find((x) => x.id === id);
        if (r && r.locked && !me().is_admin) {
          const inv = roomRequests.findIndex((q) => q.room_id === id && q.user_id === ME && q.kind === 'invite');
          if (inv < 0) fail('GROUP_LOCKED');
        }
        addToRoom(id, ME);
      },
      async requestToJoin(id) {
        const r = rooms.find((x) => x.id === id);
        if (!r || !r.locked) fail('NOT_LOCKED');
        if (memberships.some((m) => m.room_id === id && m.user_id === ME)) return 'ALREADY_IN';
        if (me().is_admin) { addToRoom(id, ME); return 'JOINED'; }
        const q = roomRequests.find((x) => x.room_id === id && x.user_id === ME);
        if (q && q.kind === 'invite') { addToRoom(id, ME); return 'JOINED'; }
        if (q) return 'ALREADY_REQUESTED';
        const row = { room_id: id, user_id: ME, kind: 'request', by_user: ME, created_at: iso(now()) };
        roomRequests.push(row);
        emit('roomRequest', 'add', Object.assign({}, row));
        return 'REQUESTED';
      },
      async dismissRoomRequest(id) { dropRequest(id, ME); },
      async inviteToGroup(roomId, userId) {
        const r = rooms.find((x) => x.id === roomId);
        if (!r || !r.locked) fail('NOT_LOCKED');
        const t = profiles.find((p) => p.id === userId);
        if (!t) fail('USER_NOT_FOUND');
        if (t.banned_at) fail('USER_BANNED');
        if (memberships.some((m) => m.room_id === roomId && m.user_id === userId)) return 'ALREADY_IN';
        const q = roomRequests.find((x) => x.room_id === roomId && x.user_id === userId);
        if (q && q.kind === 'request') { addToRoom(roomId, userId); return 'ADDED'; }
        dropRequest(roomId, userId);
        const row = { room_id: roomId, user_id: userId, kind: 'invite', by_user: ME, created_at: iso(now()) };
        roomRequests.push(row);
        emit('roomRequest', 'add', Object.assign({}, row));
        // Pretend they accept after a moment.
        setTimeout(() => { if (roomRequests.includes(row)) addToRoom(roomId, userId); }, 5000);
        return 'INVITED';
      },
      async answerJoinRequest(roomId, userId, accept) {
        const q = roomRequests.find((x) => x.room_id === roomId && x.user_id === userId && x.kind === 'request');
        if (!q) fail('REQUEST_NOT_FOUND');
        if (accept) addToRoom(roomId, userId); else dropRequest(roomId, userId);
      },
      async setGroupLocked(roomId, locked) {
        const r = rooms.find((x) => x.id === roomId);
        if (!r || r.kind !== 'group' || !!r.locked === locked) return;
        r.locked = locked;
        emit('room', Object.assign({}, r));
        emit('message', add(roomId, ME, locked ? 'LOCKED' : 'UNLOCKED', 'system'));
        if (!locked) roomRequests.filter((q) => q.room_id === roomId).forEach((q) => dropRequest(roomId, q.user_id));
      },
      async leaveRoom(id) {
        const i = memberships.findIndex((m) => m.room_id === id && m.user_id === ME);
        if (i >= 0) memberships.splice(i, 1);
        emit('membership', 'remove', { room_id: id, user_id: ME });
      },
      async createInvite() {
        const live = invites.filter((i) => !i.revoked && Date.parse(i.expires_at) > now());
        if (live.length >= S.max_active_invites) fail('TOO_MANY_INVITES');
        const inv = { code: (uid() + uid()).toUpperCase().slice(0, 10), expires_at: iso(now() + S.invite_days * 86400000), uses: 0, created_at: iso(now()) };
        invites.unshift(inv);
        return { code: inv.code, expires_at: inv.expires_at };
      },
      async listInvites() {
        return invites.filter((i) => !i.revoked && Date.parse(i.expires_at) > now()).map((i) => Object.assign({}, i));
      },
      async revokeInvite(code) {
        const i = invites.find((x) => x.code === code);
        if (!i) fail('INVITE_INVALID');
        i.revoked = true;
      },

      async sendFriendRequest(to) {
        const tp = profiles.find((p) => p.id === to);
        if (tp && tp.banned_at) fail('USER_BANNED');
        const r = friendRequests.find((x) => (x.from_user === ME && x.to_user === to) || (x.from_user === to && x.to_user === ME));
        if (r && r.status === 'accepted') return 'ALREADY_FRIENDS';
        if (r && r.status === 'pending' && r.to_user === ME) { await this.respondFriendRequest(r.id, true); return 'ACCEPTED'; }
        if (r && r.status === 'pending') return 'ALREADY_SENT';
        const req = { id: reqId++, from_user: ME, to_user: to, status: 'pending' };
        friendRequests.push(req);
        emit('friendRequest', Object.assign({}, req));
        // Pretend they accept a few seconds later.
        setTimeout(() => {
          req.status = 'accepted';
          const room = { id: 'dm-' + to, kind: 'dm', name: null, icon: '@', dm_key: 'me:' + to };
          if (!rooms.some((x) => x.id === room.id)) {
            rooms.push(room);
            memberships.push({ room_id: room.id, user_id: ME }, { room_id: room.id, user_id: to });
            emit('room', room);
            emit('membership', 'add', { room_id: room.id, user_id: ME });
            emit('membership', 'add', { room_id: room.id, user_id: to });
          }
          emit('friendRequest', Object.assign({}, req));
        }, 4000);
        return 'SENT';
      },
      async respondFriendRequest(id, accept) {
        const req = friendRequests.find((x) => x.id === id);
        if (!req || req.to_user !== ME || req.status !== 'pending') fail('REQUEST_NOT_FOUND');
        req.status = accept ? 'accepted' : 'declined';
        emit('friendRequest', Object.assign({}, req));
        if (!accept) return null;
        const other = req.from_user;
        const room = { id: 'dm-' + other, kind: 'dm', name: null, icon: '@', dm_key: 'me:' + other };
        if (!rooms.some((x) => x.id === room.id)) {
          rooms.push(room);
          memberships.push({ room_id: room.id, user_id: ME }, { room_id: room.id, user_id: other });
          emit('room', room);
          emit('membership', 'add', { room_id: room.id, user_id: ME });
          emit('membership', 'add', { room_id: room.id, user_id: other });
        }
        return room.id;
      },

      async updateProfile(patch) {
        if (patch.username !== undefined && !/^[A-Za-z0-9_]{3,20}$/.test(patch.username)) fail('USERNAME_INVALID');
        if (patch.username && profiles.some((p) => p.id !== ME && p.username.toLowerCase() === patch.username.toLowerCase())) fail('USERNAME_TAKEN');
        Object.assign(me(), patch);
        emit('profile', Object.assign({}, me()));
      },

      async setAdmin(id, admin) {
        const t = profiles.find((p) => p.id === id);
        if (!t) fail('USER_NOT_FOUND');
        if (t.is_owner) fail('CANNOT_CHANGE_OWNER');
        if (admin && t.banned_at) fail('USER_BANNED');
        if (t.is_admin === admin) return;
        t.is_admin = admin;
        emit('profile', Object.assign({}, t));
        emit('message', Object.assign(add('global', ME, admin ? 'PROMOTED' : 'DEMOTED', 'system'), { target_id: id }));
      },
      async banUser(id, ban) {
        const t = profiles.find((p) => p.id === id);
        if (id === ME) fail('NOT_YOURSELF');
        if (!t) fail('USER_NOT_FOUND');
        if (t.is_owner) fail('CANNOT_CHANGE_OWNER');
        if (!!t.banned_at === ban) return;
        if (ban && t.is_admin) fail('DEMOTE_FIRST');
        t.banned_at = ban ? iso(now()) : null;
        if (ban) {
          for (let i = friendRequests.length - 1; i >= 0; i--) {
            const r = friendRequests[i];
            if (r.status === 'pending' && (r.from_user === id || r.to_user === id)) {
              friendRequests.splice(i, 1);
              emit('friendRequest', Object.assign({}, r, { status: 'declined' }));
            }
          }
        }
        emit('profile', Object.assign({}, t));
        emit('message', Object.assign(add('global', ME, ban ? 'BANNED' : 'UNBANNED', 'system'), { target_id: id }));
      },
      async loadSelf() { return hasProfile ? Object.assign({}, me()) : null; },

      async imageUrl(path) { return images.get(path) || ''; },
      async ping() { return { ms: 900 + Math.random() * 900, totalWords: S.total_words }; },

      subscribe(handlers) {
        h = handlers;
        emit('connection', 'up');
        presence();
        setInterval(botTick, 14000);
        setTimeout(botTick, 5000);
      },
      async setPresence(state) { myPresence = state; presence(); }
    };
  }

  window.PZ = window.PZ || {};
  window.PZ.createDemoBackend = createDemoBackend;
})();
