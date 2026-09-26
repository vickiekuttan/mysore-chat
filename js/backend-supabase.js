// Talks to Supabase. Every write goes through a database function
// (supabase/schema.sql) so the rules can't be skipped from the browser.
(function () {
  const BUCKET = 'chat-images';

  function wrap(error) {
    const e = new Error(error.message || String(error));
    e.code = window.PZ.errorCode(error);
    return e;
  }

  function createSupabaseBackend(url, key) {
    const sb = window.supabase.createClient(url, key, {
      auth: { persistSession: true, autoRefreshToken: true },
      realtime: { params: { eventsPerSecond: 10 } }
    });
    const host = new URL(url).host;
    const urlCache = new Map();
    let dbChannel = null;
    let presenceChannel = null;
    let presenceState = {};
    let userId = null;

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

      async currentUserId() {
        const { data } = await sb.auth.getSession();
        userId = data.session ? data.session.user.id : null;
        return userId;
      },

      onAuthChange(fn) {
        sb.auth.onAuthStateChange((event, session) => {
          const id = session ? session.user.id : null;
          if (id !== userId) { userId = id; fn(id); }
        });
      },

      async signIn(email, password) {
        const { data, error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw wrap(error);
        userId = data.user.id;
        return userId;
      },

      async signUp({ email, password, username, code }) {
        const status = await rpc('check_signup', { p_code: code, p_username: username });
        if (status !== 'OK') { const e = new Error(status); e.code = status; throw e; }
        const { data, error } = await sb.auth.signUp({
          email, password,
          options: { data: { username, invite_code: code } }
        });
        if (error) {
          if (/database error/i.test(error.message)) {
            throw new Error('Sign-up failed. The invite code may have just been used, or the screen name was taken.');
          }
          throw wrap(error);
        }
        if (!data.session) {
          const e = new Error('Almost there: check your email for a confirmation link, then sign in.');
          e.code = 'CONFIRM_EMAIL';
          throw e;
        }
        userId = data.user.id;
        return userId;
      },

      async signOut() {
        if (presenceChannel) await sb.removeChannel(presenceChannel);
        if (dbChannel) await sb.removeChannel(dbChannel);
        presenceChannel = dbChannel = null;
        await sb.auth.signOut();
        userId = null;
      },

      async loadAll() {
        const [profiles, rooms, memberships, friendRequests, settings] = await Promise.all([
          select(sb.from('profiles').select('*')),
          select(sb.from('rooms').select('*').order('created_at')),
          select(sb.from('room_members').select('room_id,user_id')),
          select(sb.from('friend_requests').select('*')),
          select(sb.from('settings').select('*').single())
        ]);
        return { profiles, rooms, memberships, friendRequests, settings };
      },

      async loadMessages(roomId) {
        const rows = await select(sb.from('messages').select('*')
          .eq('room_id', roomId).order('id', { ascending: false }).limit(150));
        return rows.reverse();
      },

      async sendMessage(roomId, body, file) {
        let path = null;
        if (file) {
          const ext = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) || 'png';
          path = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
          const { error } = await sb.storage.from(BUCKET).upload(path, file, {
            contentType: file.type, upsert: false
          });
          if (error) {
            if (/row-level security|unauthorized|403/i.test(error.message)) {
              const e = new Error('IMAGE_LOCKED'); e.code = 'IMAGE_LOCKED'; throw e;
            }
            throw wrap(error);
          }
        }
        const res = await rpc('send_message', { p_room: roomId, p_body: body || '', p_image_path: path });
        return Object.assign({ path }, res);
      },

      createGroup: (name, icon) => rpc('create_group', { p_name: name, p_icon: icon }),
      joinRoom: (id) => rpc('join_room', { p_room: id }),
      leaveRoom: (id) => rpc('leave_room', { p_room: id }),
      createInvite: () => rpc('create_invite'),
      sendFriendRequest: (id) => rpc('send_friend_request', { p_to: id }),
      respondFriendRequest: (id, accept) => rpc('respond_friend_request', { p_id: id, p_accept: accept }),
      setAdmin: (id, admin) => rpc('set_admin', { p_user: id, p_admin: admin }),
      banUser: (id, ban) => rpc('ban_user', { p_user: id, p_ban: ban }),

      // A banned person can still read their own profile row, nothing else.
      async loadSelf() {
        return select(sb.from('profiles').select('*').eq('id', userId).maybeSingle());
      },

      async updateProfile(patch) {
        const { error } = await sb.from('profiles').update(patch).eq('id', userId);
        if (error) {
          if (/duplicate|unique/i.test(error.message)) { const e = new Error('USERNAME_TAKEN'); e.code = 'USERNAME_TAKEN'; throw e; }
          if (/check constraint/i.test(error.message)) { const e = new Error('USERNAME_INVALID'); e.code = 'USERNAME_INVALID'; throw e; }
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

      subscribe(h) {
        dbChannel = sb.channel('db-changes')
          .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, (p) => h.message(p.new))
          .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, (p) => p.new && p.new.id && h.profile(p.new))
          .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'rooms' }, (p) => h.room(p.new))
          .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'room_members' }, (p) => h.membership('add', p.new))
          .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'room_members' }, (p) => h.membership('remove', p.old))
          .on('postgres_changes', { event: '*', schema: 'public', table: 'friend_requests' }, (p) => p.new && p.new.id && h.friendRequest(p.new))
          .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'settings' }, (p) => h.settings(p.new))
          .subscribe((status) => h.connection(status === 'SUBSCRIBED' ? 'up' : status === 'CLOSED' ? 'down' : 'trying'));

        presenceChannel = sb.channel('online', { config: { presence: { key: userId } } });
        presenceChannel
          .on('presence', { event: 'sync' }, () => {
            presenceState = {};
            const raw = presenceChannel.presenceState();
            for (const key of Object.keys(raw)) {
              // One person may have several tabs open: keep the most active one.
              const metas = raw[key].slice().sort((a, b) => (b.active_at || 0) - (a.active_at || 0));
              presenceState[key] = metas[0];
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
