// Talks to Supabase. Every write goes through a database function
// (supabase/schema.sql) so the rules can't be skipped from the browser.
(function () {
  const BUCKET = 'chat-images';

  function wrap(error) {
    const e = new Error(error.message || String(error));
    e.code = window.PZ.errorCode(error);
    return e;
  }
  function fail(code) { const e = new Error(code); e.code = code; throw e; }

  // Where Google and password-reset links send people back to: this page,
  // without any #invite or ?code leftovers.
  const pageUrl = () => location.origin + location.pathname;

  function createSupabaseBackend(url, key) {
    const sb = window.supabase.createClient(url, key, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
      realtime: { params: { eventsPerSecond: 10 } }
    });
    const host = new URL(url).host;
    const urlCache = new Map();
    let dbChannel = null;
    let presenceChannel = null;
    let presenceState = {};
    let userId = null;
    let recovering = false;   // back from a reset-password email

    async function rpc(fn, args) {
      const { data, error } = await sb.rpc(fn, args);
      if (error) throw wrap(error);
      return data;
    }

    async function select(q) {
      const { data, error } = await q;
      if (error) throw wrap(error);
      return data;
    }

    return {
      mode: 'live',
      host,

      // ------------------------------------------------------------ signing in
      async currentUserId() {
        const { data } = await sb.auth.getSession();
        userId = data.session ? data.session.user.id : null;
        return userId;
      },

      // fn(userId, event). event 'PASSWORD_RECOVERY' means the person came
      // back from a reset-password email and should pick a new password.
      onAuthChange(fn) {
        sb.auth.onAuthStateChange((event, session) => {
          const id = session ? session.user.id : null;
          if (event === 'PASSWORD_RECOVERY') { recovering = true; userId = id; setTimeout(() => fn(id, event), 0); return; }
          if (id !== userId) { userId = id; setTimeout(() => fn(id, event), 0); }
        });
      },

      async signInWithGoogle() {
        const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: pageUrl() } });
        if (error) throw wrap(error);
        // The browser now leaves for Google and comes back to this page.
      },

      async signIn(email, password) {
        const { data, error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw wrap(error);
        userId = data.user.id;
        return userId;
      },

      async signUpEmail(email, password) {
        const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: pageUrl() } });
        if (error) throw wrap(error);
        if (!data.session) fail('CONFIRM_EMAIL');
        userId = data.user.id;
        return userId;
      },

      async sendPasswordReset(email) {
        const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: pageUrl() });
        if (error) throw wrap(error);
      },

      async setNewPassword(password) {
        const { error } = await sb.auth.updateUser({ password });
        if (error) throw wrap(error);
        recovering = false;
      },
      inRecovery: () => recovering,

      checkInvite: (code, username) => rpc('check_signup', { p_code: code, p_username: username || null }),
      joinWithInvite: async (code, username) => {
        try { await rpc('join_with_invite', { p_code: code, p_username: username }); }
        catch (e) { if (/duplicate key|unique/i.test(e.message)) fail('USERNAME_TAKEN'); throw e; }
      },

      async signOut() {
        if (presenceChannel) await sb.removeChannel(presenceChannel);
        if (dbChannel) await sb.removeChannel(dbChannel);
        presenceChannel = dbChannel = null;
        await sb.auth.signOut();
        userId = null;
      },

      // ------------------------------------------------------------ reading
      // null when signed in without a profile (never used an invite link).
      // A banned person can still read their own row, nothing else.
      async loadSelf() {
        return select(sb.from('profiles').select('*').eq('id', userId).maybeSingle());
      },

      async loadAll() {
        const [profiles, rooms, memberships, friendRequests, settings, roomRequests] = await Promise.all([
          select(sb.from('profiles').select('*')),
          select(sb.from('rooms').select('*').order('created_at')),
          select(sb.from('room_members').select('room_id,user_id')),
          select(sb.from('friend_requests').select('*')),
          select(sb.from('settings').select('*').single()),
          select(sb.from('room_requests').select('*'))
        ]);
        return { profiles, rooms, memberships, friendRequests, settings, roomRequests };
      },

      async loadMessages(roomId) {
        const rows = await select(sb.from('messages').select('*')
          .eq('room_id', roomId).order('id', { ascending: false }).limit(150));
        return rows.reverse();
      },

      // ------------------------------------------------------------ chatting
      async sendMessage(roomId, body, file) {
        let path = null;
        if (file) {
          const ext = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'png';
          path = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
          const { error } = await sb.storage.from(BUCKET).upload(path, file, {
            contentType: file.type, upsert: false
          });
          if (error) {
            if (/row-level security|unauthorized|403/i.test(error.message)) fail('IMAGE_LOCKED');
            throw wrap(error);
          }
        }
        const res = await rpc('send_message', { p_room: roomId, p_body: body || '', p_image_path: path });
        return Object.assign({ path }, res);
      },

      createGroup: (name, icon, locked) => rpc('create_group', { p_name: name, p_icon: icon, p_locked: !!locked }),
      joinRoom: (id) => rpc('join_room', { p_room: id }),
      leaveRoom: (id) => rpc('leave_room', { p_room: id }),
      requestToJoin: (id) => rpc('request_to_join', { p_room: id }),
      dismissRoomRequest: (id) => rpc('dismiss_room_request', { p_room: id }),
      inviteToGroup: (room, user) => rpc('invite_to_group', { p_room: room, p_user: user }),
      answerJoinRequest: (room, user, accept) => rpc('answer_join_request', { p_room: room, p_user: user, p_accept: accept }),
      setGroupLocked: (room, locked) => rpc('set_group_locked', { p_room: room, p_locked: locked }),

      createInvite: () => rpc('create_invite'),
      revokeInvite: (code) => rpc('revoke_invite', { p_code: code }),
      async listInvites() {
        return select(sb.from('invites').select('code,expires_at,uses,created_at')
          .eq('created_by', userId).is('revoked_at', null).gt('expires_at', new Date().toISOString())
          .order('created_at', { ascending: false }));
      },

      sendFriendRequest: (id) => rpc('send_friend_request', { p_to: id }),
      respondFriendRequest: (id, accept) => rpc('respond_friend_request', { p_id: id, p_accept: accept }),
      setAdmin: (id, admin) => rpc('set_admin', { p_user: id, p_admin: admin }),
      banUser: (id, ban) => rpc('ban_user', { p_user: id, p_ban: ban }),

      async updateProfile(patch) {
        const { error } = await sb.from('profiles').update(patch).eq('id', userId);
        if (error) {
          if (/duplicate|unique/i.test(error.message)) fail('USERNAME_TAKEN');
          if (/check constraint/i.test(error.message)) fail('USERNAME_INVALID');
          throw wrap(error);
        }
      },

      async imageUrl(path) {
        const hit = urlCache.get(path);
        if (hit && hit.expires > Date.now()) return hit.url;
        const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(path, 3600);
        if (error) throw wrap(error);
        urlCache.set(path, { url: data.signedUrl, expires: Date.now() + 3500 * 1000 });
        return data.signedUrl;
      },

      async ping() {
        const t = performance.now();
        const { data, error } = await sb.from('settings').select('total_words').single();
        if (error) throw wrap(error);
        return { ms: performance.now() - t, totalWords: data.total_words };
      },

      // ------------------------------------------------------------ live updates
      subscribe(h) {
        dbChannel = sb.channel('db-changes')
          .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (p) => h.message(p.new))
          .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, (p) => p.new && p.new.id && h.profile(p.new))
          .on('postgres_changes', { event: '*', schema: 'public', table: 'rooms' }, (p) => p.new && p.new.id && h.room(p.new))
          .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'room_members' }, (p) => h.membership('add', p.new))
          .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'room_members' }, (p) => h.membership('remove', p.old))
          .on('postgres_changes', { event: '*', schema: 'public', table: 'room_requests' }, (p) =>
            h.roomRequest(p.eventType === 'DELETE' ? 'remove' : 'add', p.eventType === 'DELETE' ? p.old : p.new))
          .on('postgres_changes', { event: '*', schema: 'public', table: 'friend_requests' }, (p) => p.new && p.new.id && h.friendRequest(p.new))
          .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'settings' }, (p) => h.settings(p.new))
          .subscribe((status) => h.connection(status === 'SUBSCRIBED' ? 'up' : status === 'CLOSED' ? 'down' : 'trying'));

        presenceChannel = sb.channel('online', { config: { presence: { key: userId } } });
        presenceChannel
          .on('presence', { event: 'sync' }, () => {
            presenceState = {};
            const raw = presenceChannel.presenceState();
            for (const k of Object.keys(raw)) {
              // One person may have several tabs open: keep the most active one.
              const metas = raw[k].slice().sort((a, b) => (b.active_at || 0) - (a.active_at || 0));
              presenceState[k] = metas[0];
            }
            h.presence(presenceState);
          })
          .subscribe(async (status) => {
            if (status === 'SUBSCRIBED' && this._pendingPresence) {
              await presenceChannel.track(this._pendingPresence);
            }
          });
      },

      async setPresence(state) {
        this._pendingPresence = state;
        if (presenceChannel) {
          try { await presenceChannel.track(state); } catch (_) { /* sent again on next change */ }
        }
      }
    };
  }

  window.PZ = window.PZ || {};
  window.PZ.createSupabaseBackend = createSupabaseBackend;
})();
