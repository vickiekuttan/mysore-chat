-- ============================================================================
-- Pazhampori chat: database schema
--
-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- It is safe to run on a fresh project only. The last line prints your first
-- invite code (valid 30 days); the first account that joins with it becomes
-- the founder.
--
-- Every chat rule is enforced HERE, in the database, not in the browser.
-- The web page only mirrors the rules so people see friendly messages.
-- To change a rule later, edit the numbers in the `settings` table
-- (Table Editor > settings). No code change needed.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. Settings: one row holding every tunable rule + the global word counter
-- ---------------------------------------------------------------------------
create table public.settings (
  id                  int primary key default 1 check (id = 1),
  max_words_public    int    not null default 8,        -- words per message in Global chat and groups
  max_chars_public    int    not null default 160,      -- stops one giant "word" flooding the room
  max_words_friends   int    not null default 200,      -- words per message in friend chats
  max_chars_friends   int    not null default 2000,
  spam_count          int    not null default 10,       -- this many messages...
  spam_window_seconds int    not null default 60,       -- ...inside this window...
  spam_wait_seconds   int    not null default 300,      -- ...means waiting this long
  image_lock_seconds  int    not null default 30,       -- no sending at all for 30 seconds after an image
  wipe_at_words       bigint not null default 1000000,  -- Global + groups are erased at this many words
  total_words         bigint not null default 0,        -- running count since the last wipe
  wipe_count          int    not null default 0,
  last_wiped_at       timestamptz,
  invite_days         int    not null default 7,        -- how long an invite link works
  max_active_invites  int    not null default 5         -- live invite links per member
);
insert into public.settings default values;


-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------
create table public.profiles (
  id                 uuid primary key references auth.users(id) on delete cascade,
  username           text not null check (username ~ '^[A-Za-z0-9_]{3,20}$'),
  color              text not null default '#e0338f' check (color ~ '^#[0-9a-fA-F]{6}$'),
  modem              text not null default '56k'
                       check (modem in ('14.4k','28.8k','33.6k','56k','ISDN','cable','T1')),
  status_text        text not null default '' check (char_length(status_text) <= 40),
  is_admin           boolean not null default false,   -- shown as [OP]
  is_owner           boolean not null default false,   -- the founder: first account, can't be demoted or banned
  banned_at          timestamptz,                      -- set = locked out of everything
  banned_by          uuid references public.profiles(id) on delete set null,
  muted_until        timestamptz,
  image_locked_until timestamptz,
  invited_by         uuid references public.profiles(id) on delete set null,
  invite_code        text,
  created_at         timestamptz not null default now(),
  check (not is_owner or is_admin),
  check (not is_owner or banned_at is null)
);
create unique index profiles_username_ci on public.profiles (lower(username));
create unique index profiles_one_owner   on public.profiles (is_owner) where is_owner;

-- Invite links. One link can bring in any number of people until it expires
-- (7 days by default) or its creator or an admin revokes it.
create table public.invites (
  code       text primary key,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '7 days',
  revoked_at timestamptz,
  uses       int not null default 0
);

create table public.rooms (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null check (kind in ('global','group','dm')),
  name       text,
  icon       text not null default '#' check (icon in ('#','*','♬','@','?','♥','!','~','$','%')),
  created_by uuid references public.profiles(id) on delete set null,
  dm_key     text unique,            -- "smallerUserId:largerUserId" for friend chats
  locked     boolean not null default false,  -- locked groups: admin invite or approval only
  cooldowns  boolean not null default true,   -- image cooldown + flood control; admins can switch them off in a group
  created_at timestamptz not null default now(),
  check (kind <> 'group' or name ~ '^[a-z0-9_]{2,24}$'),
  check (not locked or kind = 'group'),
  constraint rooms_cooldowns_groups_only check (cooldowns or kind = 'group'),
  check ((kind = 'dm') = (dm_key is not null))
);
create unique index rooms_one_global  on public.rooms (kind) where kind = 'global';
create unique index rooms_group_names on public.rooms (lower(name)) where kind = 'group';
insert into public.rooms (kind, name, icon) values ('global', 'Global chat', '*');

create table public.room_members (
  room_id   uuid not null references public.rooms(id) on delete cascade,
  user_id   uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id)
);
create index room_members_user on public.room_members (user_id);

-- Locked groups: an admin's invitation ('invite') or someone asking to join
-- ('request'). One open row per person per group.
create table public.room_requests (
  room_id    uuid not null references public.rooms(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  kind       text not null check (kind in ('invite','request')),
  by_user    uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

create table public.messages (
  id         bigint generated always as identity primary key,
  room_id    uuid not null references public.rooms(id) on delete cascade,
  user_id    uuid references public.profiles(id) on delete set null,
  target_id  uuid references public.profiles(id) on delete set null,  -- who an admin action was about
  kind       text not null default 'text' check (kind in ('text','image','system')),
  body       text not null default '',
  image_path text,
  word_count int  not null default 0,
  created_at timestamptz not null default now()
);
create index messages_room_recent on public.messages (room_id, id desc);
create index messages_user_recent on public.messages (user_id, created_at desc);

create table public.friend_requests (
  id           bigint generated always as identity primary key,
  from_user    uuid not null references public.profiles(id) on delete cascade,
  to_user      uuid not null references public.profiles(id) on delete cascade,
  status       text not null default 'pending' check (status in ('pending','accepted','declined')),
  created_at   timestamptz not null default now(),
  responded_at timestamptz,
  check (from_user <> to_user)
);
create unique index friend_pair on public.friend_requests
  (least(from_user, to_user), greatest(from_user, to_user));

-- Image files left behind by a wipe. Files in Storage cannot be removed from
-- SQL, so they are listed here for manual cleanup (see README).
create table public.orphaned_images (
  path      text primary key,
  listed_at timestamptz not null default now()
);


-- ---------------------------------------------------------------------------
-- 3. Helpers
-- ---------------------------------------------------------------------------

-- Counts words the same way the web page does: runs of non-space characters.
-- Unusual Unicode spaces are treated as spaces so nobody can glue 20 words
-- together with an invisible "non-breaking" space.
create function public.count_words(t text) returns int
language sql immutable as $$
  select case when s.n = '' then 0 else array_length(string_to_array(s.n, ' '), 1) end
  from (select btrim(regexp_replace(coalesce(t, ''),
          -- whitespace plus: no-break space, ogham space, U+2000 to U+200B,
          -- line/paragraph separators, narrow no-break, math and ideographic
          -- spaces, zero-width no-break space
          '[\s' || chr(160) || chr(5760) || chr(8192) || '-' || chr(8203) || chr(8232) || chr(8233)
            || chr(8239) || chr(8287) || chr(12288) || chr(65279) || ']+', ' ', 'g')) as n) s
$$;

-- A member is someone with a profile who is not banned.
create function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and banned_at is null)
$$;

create function public.am_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and is_admin and banned_at is null)
$$;

create function public.can_read_room(p_room uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_member() and (
    exists (select 1 from public.rooms where id = p_room and kind = 'global')
    or exists (select 1 from public.room_members where room_id = p_room and user_id = auth.uid())
  )
$$;

create function public.new_code() returns text
language sql volatile as $$
  select upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))
$$;

-- Used by the Storage policy: you may upload only while you are allowed to
-- send. Files go to <your id>/<room id>/<file>; uploads for a group with
-- cooldowns switched off (that you can post in) skip the cooldown check.
create function public.can_upload_image(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and banned_at is null
      and (
        ((image_locked_until is null or image_locked_until <= now())
          and (muted_until   is null or muted_until        <= now()))
        or (split_part(p_name, '/', 2) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            and exists (select 1 from public.rooms r
                         where r.id::text = split_part(p_name, '/', 2)
                           and r.kind = 'group' and not r.cooldowns
                           and public.can_read_room(r.id)))
      )
  )
$$;


-- ---------------------------------------------------------------------------
-- 4. Joining. The only way in: open an invite link, sign in with Google.
--    Anyone can sign in with Google, but only a valid invite turns that into
--    a member; signed-in people without a profile can't see or do anything.
--    (Also switch the Email provider off in Supabase: see README.)
-- ---------------------------------------------------------------------------

-- Is this invite usable right now? Returns OK, INVITE_INVALID or INVITE_EXPIRED.
create function public.invite_state(p_code text) returns text
language sql stable security definer set search_path = public as $$
  select case
    when i.code is null or i.revoked_at is not null then 'INVITE_INVALID'
    when exists (select 1 from public.profiles c where c.id = i.created_by and c.banned_at is not null) then 'INVITE_INVALID'
    when i.expires_at <= now() then 'INVITE_EXPIRED'
    else 'OK'
  end
  from (select 1) one
  left join public.invites i on i.code = upper(btrim(coalesce(p_code, '')))
$$;

-- Lets the invite page check the link (and a screen name) before signing in.
create function public.check_signup(p_code text, p_username text default null) returns text
language plpgsql stable security definer set search_path = public as $$
declare v_state text := public.invite_state(p_code);
begin
  if v_state <> 'OK' then return v_state; end if;
  if p_username is null then return 'OK'; end if;
  if btrim(p_username) !~ '^[A-Za-z0-9_]{3,20}$' then return 'USERNAME_INVALID'; end if;
  if exists (select 1 from public.profiles where lower(username) = lower(btrim(p_username))) then
    return 'USERNAME_TAKEN';
  end if;
  return 'OK';
end $$;

-- Called right after signing in with Google from an invite link: creates your
-- profile. The very first person ever to join becomes the founder.
create function public.join_with_invite(p_code text, p_username text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid      uuid := auth.uid();
  v_code     text := upper(btrim(coalesce(p_code, '')));
  v_username text := btrim(coalesce(p_username, ''));
  v_inv      public.invites%rowtype;
  v_state    text;
  v_first    boolean;
  v_colors   text[] := array['#e0338f','#8a2be2','#1e6fe0','#12a07a','#e0661a','#1ba3bd','#b8860b','#c2187a','#5c9e1e'];
begin
  if v_uid is null then raise exception 'NOT_SIGNED_IN'; end if;
  if exists (select 1 from public.profiles where id = v_uid) then raise exception 'ALREADY_MEMBER'; end if;
  -- Google accounts only, even if another sign-in method gets switched on by mistake.
  if not exists (select 1 from auth.users u where u.id = v_uid
                   and (u.raw_app_meta_data->>'provider' = 'google'
                        or coalesce(u.raw_app_meta_data->'providers', '[]'::jsonb) ? 'google')) then
    raise exception 'GOOGLE_ONLY';
  end if;

  select * into v_inv from public.invites where code = v_code for update;
  v_state := public.invite_state(v_code);
  if v_state <> 'OK' then raise exception '%', v_state; end if;

  if v_username !~ '^[A-Za-z0-9_]{3,20}$' then raise exception 'USERNAME_INVALID'; end if;
  if exists (select 1 from public.profiles where lower(username) = lower(v_username)) then
    raise exception 'USERNAME_TAKEN';
  end if;

  select not exists (select 1 from public.profiles) into v_first;

  insert into public.profiles (id, username, color, is_admin, is_owner, invited_by, invite_code)
  values (v_uid, v_username,
          case when v_first then '#e02020' else v_colors[1 + floor(random() * array_length(v_colors, 1))::int] end,
          v_first, v_first, v_inv.created_by, v_code);

  update public.invites set uses = uses + 1 where code = v_code;
end $$;


-- ---------------------------------------------------------------------------
-- 5. Actions (the web page calls these; nobody writes to tables directly)
-- ---------------------------------------------------------------------------

-- Send a message. Returns {"id": ..., "wiped": true/false}.
-- Errors are short codes the page turns into friendly text:
--   NOT_A_MEMBER, ROOM_NOT_FOUND, NOT_IN_ROOM, EMPTY, IMAGE_LOCKED, SPAM_WAIT,
--   TOO_MANY_WORDS, TOO_LONG, NO_IMAGES_FOR_FRIENDS, BAD_IMAGE
-- IMAGE_LOCKED and SPAM_WAIT only apply in Global and in groups that keep
-- cooldowns on; friend chats and cooldown-free groups skip them.
create function public.send_message(p_room uuid, p_body text default '', p_image_path text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid    uuid := auth.uid();
  v_prof   public.profiles%rowtype;
  v_room   public.rooms%rowtype;
  v_set    public.settings%rowtype;
  v_body   text := btrim(coalesce(p_body, ''));
  v_words  int;
  v_recent int;
  v_total  bigint;
  v_id     bigint;
  v_wiped  boolean := false;
  v_global uuid;
  v_cool   boolean;
begin
  -- Lock this person's row so two fast sends are checked one after the other.
  select * into v_prof from public.profiles where id = v_uid for update;
  if not found then raise exception 'NOT_A_MEMBER'; end if;
  if v_prof.banned_at is not null then raise exception 'BANNED'; end if;

  select * into v_room from public.rooms where id = p_room;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  if not public.can_read_room(p_room) then raise exception 'NOT_IN_ROOM'; end if;

  select * into v_set from public.settings where id = 1;

  -- Cooldowns only count in Global and in groups that keep them on.
  v_cool := v_room.kind = 'global' or (v_room.kind = 'group' and v_room.cooldowns);
  if v_cool and v_prof.image_locked_until > now() then raise exception 'IMAGE_LOCKED'; end if;
  if v_cool and v_prof.muted_until        > now() then raise exception 'SPAM_WAIT';    end if;

  v_words := public.count_words(v_body);
  if v_words = 0 and p_image_path is null then raise exception 'EMPTY'; end if;

  if v_room.kind = 'dm' then
    if p_image_path is not null then raise exception 'NO_IMAGES_FOR_FRIENDS'; end if;
    if v_words > v_set.max_words_friends then raise exception 'TOO_MANY_WORDS'; end if;
    if char_length(v_body) > v_set.max_chars_friends then raise exception 'TOO_LONG'; end if;
  else
    if v_words > v_set.max_words_public then raise exception 'TOO_MANY_WORDS'; end if;
    if char_length(v_body) > v_set.max_chars_public then raise exception 'TOO_LONG'; end if;
  end if;

  if p_image_path is not null then
    -- The file must be in this person's own folder and must really exist.
    if split_part(p_image_path, '/', 1) <> v_uid::text
       or not exists (select 1 from storage.objects
                      where bucket_id = 'chat-images' and name = p_image_path) then
      raise exception 'BAD_IMAGE';
    end if;
  end if;

  insert into public.messages (room_id, user_id, kind, body, image_path, word_count)
  values (p_room, v_uid, case when p_image_path is null then 'text' else 'image' end,
          v_body, p_image_path, v_words)
  returning id into v_id;

  -- Image rule: 30 seconds of silence after sending an image.
  if v_cool and p_image_path is not null then
    update public.profiles
       set image_locked_until = now() + make_interval(secs => v_set.image_lock_seconds)
     where id = v_uid;
  end if;

  -- Spam rule: too many messages inside the window means a wait. Only
  -- messages in rooms where cooldowns apply are counted.
  if v_cool then
    select count(*) into v_recent
      from public.messages m join public.rooms r on r.id = m.room_id
     where m.user_id = v_uid and m.kind <> 'system'
       and (r.kind = 'global' or (r.kind = 'group' and r.cooldowns))
       and m.created_at > now() - make_interval(secs => v_set.spam_window_seconds);
    if v_recent >= v_set.spam_count then
      update public.profiles
         set muted_until = now() + make_interval(secs => v_set.spam_wait_seconds)
       where id = v_uid;
    end if;
  end if;

  if v_room.kind <> 'dm' then

    -- Word counter and the 1,000,000-word wipe.
    update public.settings set total_words = total_words + v_words where id = 1
      returning total_words into v_total;

    if v_total >= v_set.wipe_at_words then
      insert into public.orphaned_images (path)
        select m.image_path from public.messages m join public.rooms r on r.id = m.room_id
         where r.kind <> 'dm' and m.image_path is not null
      on conflict do nothing;

      delete from public.messages m using public.rooms r
       where r.id = m.room_id and r.kind <> 'dm';

      update public.settings
         set total_words = 0, wipe_count = wipe_count + 1, last_wiped_at = now()
       where id = 1;

      select id into v_global from public.rooms where kind = 'global';
      insert into public.messages (room_id, user_id, kind, body)
      values (v_global, null, 'system', 'WIPE');
      v_wiped := true;
    end if;
  end if;

  return jsonb_build_object('id', v_id, 'wiped', v_wiped);
end $$;


-- Anyone can create an open group. Only admins can create a locked one.
create function public.create_group(p_name text, p_icon text default '#', p_locked boolean default false) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_uid  uuid := auth.uid();
  v_name text := lower(btrim(coalesce(p_name, '')));
  v_id   uuid;
begin
  if not public.is_member() then raise exception 'NOT_A_MEMBER'; end if;
  if coalesce(p_locked, false) and not public.am_admin() then raise exception 'NOT_ADMIN'; end if;
  if v_name !~ '^[a-z0-9_]{2,24}$' then raise exception 'GROUP_NAME_INVALID'; end if;
  if exists (select 1 from public.rooms where kind = 'group' and lower(name) = v_name) then
    raise exception 'GROUP_NAME_TAKEN';
  end if;
  if (select count(*) from public.rooms where kind = 'group' and created_by = v_uid) >= 10 then
    raise exception 'TOO_MANY_GROUPS';
  end if;
  if (select count(*) from public.rooms where kind = 'group') >= 200 then
    raise exception 'TOO_MANY_GROUPS';
  end if;

  insert into public.rooms (kind, name, icon, created_by, locked)
  values ('group', v_name, coalesce(nullif(p_icon, ''), '#'), v_uid, coalesce(p_locked, false))
  returning id into v_id;
  insert into public.room_members (room_id, user_id) values (v_id, v_uid);
  insert into public.messages (room_id, user_id, kind, body) values (v_id, v_uid, 'system', 'CREATED');
  return v_id;
end $$;


-- Join a group. Locked groups need an admin's invitation first (admins
-- themselves can walk into any locked group).
create function public.join_room(p_room uuid) returns void
language plpgsql security definer set search_path = public as $$
declare v_room public.rooms%rowtype;
begin
  if not public.is_member() then raise exception 'NOT_A_MEMBER'; end if;
  select * into v_room from public.rooms where id = p_room and kind = 'group';
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  if exists (select 1 from public.room_members where room_id = p_room and user_id = auth.uid()) then return; end if;
  if v_room.locked and not public.am_admin() then
    delete from public.room_requests where room_id = p_room and user_id = auth.uid() and kind = 'invite';
    if not found then raise exception 'GROUP_LOCKED'; end if;
  end if;
  perform public.add_to_room(p_room, auth.uid());
end $$;

-- Internal: add someone to a group and announce it. Not callable from the page.
create function public.add_to_room(p_room uuid, p_user uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  insert into public.room_members (room_id, user_id) values (p_room, p_user) on conflict do nothing;
  if found then
    insert into public.messages (room_id, user_id, kind, body) values (p_room, p_user, 'system', 'JOINED');
  end if;
  delete from public.room_requests where room_id = p_room and user_id = p_user;
end $$;

-- Ask to join a locked group. If an admin already invited you, you're in.
-- Returns REQUESTED, ALREADY_REQUESTED, JOINED or ALREADY_IN.
create function public.request_to_join(p_room uuid) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_room public.rooms%rowtype;
  v_req  public.room_requests%rowtype;
begin
  if not public.is_member() then raise exception 'NOT_A_MEMBER'; end if;
  select * into v_room from public.rooms where id = p_room and kind = 'group';
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  if not v_room.locked then raise exception 'NOT_LOCKED'; end if;
  if exists (select 1 from public.room_members where room_id = p_room and user_id = auth.uid()) then return 'ALREADY_IN'; end if;
  select * into v_req from public.room_requests where room_id = p_room and user_id = auth.uid() for update;
  if found and v_req.kind = 'invite' then
    perform public.add_to_room(p_room, auth.uid());
    return 'JOINED';
  elsif found then
    return 'ALREADY_REQUESTED';
  end if;
  insert into public.room_requests (room_id, user_id, kind, by_user) values (p_room, auth.uid(), 'request', auth.uid());
  return 'REQUESTED';
end $$;

-- Withdraw your own request, or decline an admin's invitation.
create function public.dismiss_room_request(p_room uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  delete from public.room_requests where room_id = p_room and user_id = auth.uid();
end $$;

-- Admins: invite someone into a group (open or locked). They see the
-- invitation and press Join. If they had already asked to join a locked
-- group, this lets them straight in. Returns INVITED, ADDED or ALREADY_IN.
create function public.invite_to_group(p_room uuid, p_user uuid) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_room public.rooms%rowtype;
  v_req  public.room_requests%rowtype;
begin
  if not public.am_admin() then raise exception 'NOT_ADMIN'; end if;
  select * into v_room from public.rooms where id = p_room and kind = 'group';
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  if not exists (select 1 from public.profiles where id = p_user) then raise exception 'USER_NOT_FOUND'; end if;
  if exists (select 1 from public.profiles where id = p_user and banned_at is not null) then raise exception 'USER_BANNED'; end if;
  if exists (select 1 from public.room_members where room_id = p_room and user_id = p_user) then return 'ALREADY_IN'; end if;
  select * into v_req from public.room_requests where room_id = p_room and user_id = p_user for update;
  if found and v_req.kind = 'request' then
    perform public.add_to_room(p_room, p_user);
    return 'ADDED';
  end if;
  insert into public.room_requests (room_id, user_id, kind, by_user) values (p_room, p_user, 'invite', auth.uid())
  on conflict (room_id, user_id) do update set kind = 'invite', by_user = excluded.by_user, created_at = now();
  return 'INVITED';
end $$;

-- Admins: let someone who asked into a locked group, or turn them down.
create function public.answer_join_request(p_room uuid, p_user uuid, p_accept boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.am_admin() then raise exception 'NOT_ADMIN'; end if;
  if not exists (select 1 from public.room_requests where room_id = p_room and user_id = p_user and kind = 'request') then
    raise exception 'REQUEST_NOT_FOUND';
  end if;
  if p_accept then
    if exists (select 1 from public.profiles where id = p_user and banned_at is not null) then raise exception 'USER_BANNED'; end if;
    perform public.add_to_room(p_room, p_user);
  else
    delete from public.room_requests where room_id = p_room and user_id = p_user;
  end if;
end $$;

-- Admins: lock or unlock an existing group. Current members stay.
create function public.set_group_locked(p_room uuid, p_locked boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.am_admin() then raise exception 'NOT_ADMIN'; end if;
  update public.rooms set locked = p_locked where id = p_room and kind = 'group' and locked <> p_locked;
  if found then
    insert into public.messages (room_id, user_id, kind, body)
    values (p_room, auth.uid(), 'system', case when p_locked then 'LOCKED' else 'UNLOCKED' end);
    if not p_locked then
      -- Nobody needs to ask to join an open group. Invitations stay.
      delete from public.room_requests where room_id = p_room and kind = 'request';
    end if;
  end if;
end $$;

-- Admins only: switch a group's cooldowns (image cooldown + flood control)
-- off or back on. Global chat always keeps them.
create function public.set_group_cooldowns(p_room uuid, p_on boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.am_admin() then raise exception 'NOT_ADMIN'; end if;
  update public.rooms set cooldowns = p_on where id = p_room and kind = 'group' and cooldowns <> p_on;
  if found then
    insert into public.messages (room_id, user_id, kind, body)
    values (p_room, auth.uid(), 'system', case when p_on then 'COOLDOWNS_ON' else 'COOLDOWNS_OFF' end);
  end if;
end $$;


create function public.leave_room(p_room uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.rooms where id = p_room and kind = 'group') then
    raise exception 'ROOM_NOT_FOUND';
  end if;
  delete from public.room_members where room_id = p_room and user_id = auth.uid();
end $$;


-- Make an invite link code. Returns {"code": ..., "expires_at": ...}.
create function public.create_invite() returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_set  public.settings%rowtype;
  v_code text := public.new_code();
  v_exp  timestamptz;
begin
  if not public.is_member() then raise exception 'NOT_A_MEMBER'; end if;
  select * into v_set from public.settings where id = 1;
  if (select count(*) from public.invites
       where created_by = auth.uid() and revoked_at is null and expires_at > now()) >= v_set.max_active_invites then
    raise exception 'TOO_MANY_INVITES';
  end if;
  v_exp := now() + make_interval(days => v_set.invite_days);
  insert into public.invites (code, created_by, expires_at) values (v_code, auth.uid(), v_exp);
  return jsonb_build_object('code', v_code, 'expires_at', v_exp);
end $$;

-- Switch off an invite link. Its creator or any admin can do this.
create function public.revoke_invite(p_code text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_member() then raise exception 'NOT_A_MEMBER'; end if;
  update public.invites set revoked_at = coalesce(revoked_at, now())
   where code = upper(btrim(p_code)) and (created_by = auth.uid() or public.am_admin());
  if not found then raise exception 'INVITE_INVALID'; end if;
end $$;


-- Sending a request to someone who already sent you one simply accepts it.
create function public.send_friend_request(p_to uuid) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_req public.friend_requests%rowtype;
begin
  if not public.is_member() then raise exception 'NOT_A_MEMBER'; end if;
  if p_to = v_uid then raise exception 'NOT_YOURSELF'; end if;
  if not exists (select 1 from public.profiles where id = p_to) then raise exception 'USER_NOT_FOUND'; end if;
  if exists (select 1 from public.profiles where id = p_to and banned_at is not null) then raise exception 'USER_BANNED'; end if;

  select * into v_req from public.friend_requests
   where least(from_user, to_user) = least(v_uid, p_to)
     and greatest(from_user, to_user) = greatest(v_uid, p_to)
   for update;

  if not found then
    insert into public.friend_requests (from_user, to_user) values (v_uid, p_to);
    return 'SENT';
  elsif v_req.status = 'accepted' then
    return 'ALREADY_FRIENDS';
  elsif v_req.status = 'pending' and v_req.from_user = v_uid then
    return 'ALREADY_SENT';
  elsif v_req.status = 'pending' then
    perform public.respond_friend_request(v_req.id, true);
    return 'ACCEPTED';
  else
    -- Declined earlier: allow a fresh request.
    update public.friend_requests
       set from_user = v_uid, to_user = p_to, status = 'pending',
           created_at = now(), responded_at = null
     where id = v_req.id;
    return 'SENT';
  end if;
end $$;


-- Only the person who received the request can answer it.
-- Accepting creates the private friend chat. Returns that chat's room id.
create function public.respond_friend_request(p_id bigint, p_accept boolean) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_req  public.friend_requests%rowtype;
  v_key  text;
  v_room uuid;
begin
  if not public.is_member() then raise exception 'NOT_A_MEMBER'; end if;
  select * into v_req from public.friend_requests where id = p_id for update;
  if not found or v_req.to_user <> auth.uid() or v_req.status <> 'pending' then
    raise exception 'REQUEST_NOT_FOUND';
  end if;
  if p_accept and exists (select 1 from public.profiles where id = v_req.from_user and banned_at is not null) then
    raise exception 'USER_BANNED';
  end if;

  if not p_accept then
    update public.friend_requests set status = 'declined', responded_at = now() where id = p_id;
    return null;
  end if;

  update public.friend_requests set status = 'accepted', responded_at = now() where id = p_id;

  v_key := least(v_req.from_user, v_req.to_user)::text || ':' || greatest(v_req.from_user, v_req.to_user)::text;
  insert into public.rooms (kind, dm_key, icon) values ('dm', v_key, '@')
  on conflict (dm_key) do nothing;
  select id into v_room from public.rooms where dm_key = v_key;
  insert into public.room_members (room_id, user_id)
  values (v_room, v_req.from_user), (v_room, v_req.to_user)
  on conflict do nothing;
  return v_room;
end $$;


-- ---------------------------------------------------------------------------
-- 5b. Admin tools. Every change is announced in Global chat, IRC style.
--   Errors: NOT_ADMIN, USER_NOT_FOUND, CANNOT_CHANGE_OWNER, USER_BANNED,
--           NOT_YOURSELF, DEMOTE_FIRST
-- ---------------------------------------------------------------------------

-- Make someone an admin ([OP]) or a regular again. Admins may step down
-- themselves. Nobody can demote the founder.
create function public.set_admin(p_user uuid, p_admin boolean) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_t      public.profiles%rowtype;
  v_global uuid;
begin
  if not public.am_admin() then raise exception 'NOT_ADMIN'; end if;
  select * into v_t from public.profiles where id = p_user for update;
  if not found then raise exception 'USER_NOT_FOUND'; end if;
  if v_t.is_owner then raise exception 'CANNOT_CHANGE_OWNER'; end if;
  if p_admin and v_t.banned_at is not null then raise exception 'USER_BANNED'; end if;
  if v_t.is_admin = p_admin then return; end if;

  update public.profiles set is_admin = p_admin where id = p_user;
  select id into v_global from public.rooms where kind = 'global';
  insert into public.messages (room_id, user_id, target_id, kind, body)
  values (v_global, auth.uid(), p_user, 'system', case when p_admin then 'PROMOTED' else 'DEMOTED' end);
end $$;


-- Ban (p_ban = true) or unban someone. A banned person can't read, post,
-- upload, invite or friend anyone until unbanned. Admins must be made
-- regulars before they can be banned, and the founder can never be banned.
create function public.ban_user(p_user uuid, p_ban boolean) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_t      public.profiles%rowtype;
  v_global uuid;
begin
  if not public.am_admin() then raise exception 'NOT_ADMIN'; end if;
  if p_user = auth.uid() then raise exception 'NOT_YOURSELF'; end if;
  select * into v_t from public.profiles where id = p_user for update;
  if not found then raise exception 'USER_NOT_FOUND'; end if;
  if v_t.is_owner then raise exception 'CANNOT_CHANGE_OWNER'; end if;
  if (v_t.banned_at is not null) = p_ban then return; end if;

  if p_ban then
    if v_t.is_admin then raise exception 'DEMOTE_FIRST'; end if;
    update public.profiles set banned_at = now(), banned_by = auth.uid() where id = p_user;
    update public.invites set revoked_at = now() where created_by = p_user and revoked_at is null;
    delete from public.room_requests where user_id = p_user;
    delete from public.friend_requests where status = 'pending' and (from_user = p_user or to_user = p_user);
  else
    update public.profiles set banned_at = null, banned_by = null where id = p_user;
  end if;

  select id into v_global from public.rooms where kind = 'global';
  insert into public.messages (room_id, user_id, target_id, kind, body)
  values (v_global, auth.uid(), p_user, 'system', case when p_ban then 'BANNED' else 'UNBANNED' end);
end $$;


-- ---------------------------------------------------------------------------
-- 6. Row Level Security: who can READ what. Nobody may write directly.
-- ---------------------------------------------------------------------------
alter table public.settings        enable row level security;
alter table public.profiles        enable row level security;
alter table public.invites         enable row level security;
alter table public.rooms           enable row level security;
alter table public.room_members    enable row level security;
alter table public.messages        enable row level security;
alter table public.friend_requests enable row level security;
alter table public.orphaned_images enable row level security;
alter table public.room_requests   enable row level security;

create policy "members read settings" on public.settings
  for select to authenticated using (public.is_member());

create policy "members read profiles" on public.profiles
  for select to authenticated using (public.is_member());

-- Even a banned person can read their own profile, so the page can tell them.
create policy "read own profile" on public.profiles
  for select to authenticated using (id = auth.uid());

-- People may edit only their own name, color, modem and status line.
create policy "edit own profile" on public.profiles
  for update to authenticated using (id = auth.uid() and public.is_member()) with check (id = auth.uid());
revoke update on public.profiles from authenticated, anon;
grant update (username, color, modem, status_text) on public.profiles to authenticated;

create policy "see own invites" on public.invites
  for select to authenticated using (created_by = auth.uid());

-- Everyone sees Global chat and every group (so they can join); friend chats
-- are visible only to the two friends.
create policy "members read rooms" on public.rooms
  for select to authenticated using (
    public.is_member() and (kind <> 'dm' or public.can_read_room(id))
  );

create policy "members read memberships" on public.room_members
  for select to authenticated using (
    public.is_member() and exists (select 1 from public.rooms r where r.id = room_id and r.kind <> 'dm')
    or user_id = auth.uid()
    or public.can_read_room(room_id)
  );

create policy "read messages in my rooms" on public.messages
  for select to authenticated using (public.can_read_room(room_id));

create policy "see my friend requests" on public.friend_requests
  for select to authenticated using (from_user = auth.uid() or to_user = auth.uid());

-- Your own invitations/requests; admins see all of them so they can answer.
create policy "see locked-group requests" on public.room_requests
  for select to authenticated using (
    public.is_member() and (user_id = auth.uid() or public.am_admin())
  );

-- orphaned_images: no policies, so only the Supabase dashboard can see it.

-- Signed-out visitors may only check an invite link. add_to_room and
-- invite_state are internal helpers and are not granted to anyone.
revoke execute on all functions in schema public from anon, authenticated, public;
grant  execute on function public.check_signup(text, text) to anon, authenticated;
grant  execute on function public.count_words(text), public.is_member(), public.am_admin(),
         public.can_read_room(uuid), public.can_upload_image(text),
         public.join_with_invite(text, text), public.create_invite(), public.revoke_invite(text),
         public.send_message(uuid, text, text),
         public.create_group(text, text, boolean), public.join_room(uuid), public.leave_room(uuid),
         public.request_to_join(uuid), public.dismiss_room_request(uuid),
         public.invite_to_group(uuid, uuid), public.answer_join_request(uuid, uuid, boolean),
         public.set_group_locked(uuid, boolean), public.set_group_cooldowns(uuid, boolean),
         public.send_friend_request(uuid), public.respond_friend_request(bigint, boolean),
         public.set_admin(uuid, boolean), public.ban_user(uuid, boolean)
  to authenticated;


-- ---------------------------------------------------------------------------
-- 7. Image storage: private bucket, 5 MB max, images only
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('chat-images', 'chat-images', false, 5242880,
        array['image/png','image/jpeg','image/gif','image/webp'])
on conflict (id) do nothing;

create policy "members upload images to own folder" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'chat-images'
    and (storage.foldername(name))[1] = auth.uid()::text
    and public.can_upload_image(name)
  );

create policy "members view images" on storage.objects
  for select to authenticated using (bucket_id = 'chat-images' and public.is_member());


-- ---------------------------------------------------------------------------
-- 8. Live updates
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table
  public.messages, public.rooms, public.room_members, public.profiles,
  public.friend_requests, public.settings, public.room_requests;


-- ---------------------------------------------------------------------------
-- 9. Your first invite code, valid 30 days. Open your site with
--    #invite=THE_CODE on the end of the address; the first account to join
--    becomes the founder.
-- ---------------------------------------------------------------------------
insert into public.invites (code, expires_at) values (public.new_code(), now() + interval '30 days');
select code as your_first_invite_code from public.invites;
