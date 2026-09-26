-- ============================================================================
-- Pazhampori chat: database schema
--
-- Paste this whole file into Supabase > SQL Editor > New query, then Run.
-- It is safe to run on a fresh project only. The last line prints your first
-- invite code; use it to create the first account (that account becomes OP).
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
  image_lock_seconds  int    not null default 600,      -- no sending at all for 10 min after an image
  wipe_at_words       bigint not null default 1000000,  -- Global + groups are erased at this many words
  total_words         bigint not null default 0,        -- running count since the last wipe
  wipe_count          int    not null default 0,
  last_wiped_at       timestamptz
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
  created_at         timestamptz not null default now(),
  check (not is_owner or is_admin),
  check (not is_owner or banned_at is null)
);
create unique index profiles_username_ci on public.profiles (lower(username));
create unique index profiles_one_owner   on public.profiles (is_owner) where is_owner;

create table public.invites (
  code       text primary key,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  used_by    uuid references public.profiles(id) on delete set null,
  used_at    timestamptz
);

create table public.rooms (
  id         uuid primary key default gen_random_uuid(),
  kind       text not null check (kind in ('global','group','dm')),
  name       text,
  icon       text not null default '#' check (icon in ('#','*','♬','@','?','♥','!','~','$','%')),
  created_by uuid references public.profiles(id) on delete set null,
  dm_key     text unique,            -- "smallerUserId:largerUserId" for friend chats
  created_at timestamptz not null default now(),
  check (kind <> 'group' or name ~ '^[a-z0-9_]{2,24}$'),
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

-- Used by the Storage policy: you may upload only while you are allowed to send.
create function public.can_upload_image() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and banned_at is null
      and (image_locked_until is null or image_locked_until <= now())
      and (muted_until        is null or muted_until        <= now())
  )
$$;


-- ---------------------------------------------------------------------------
-- 4. Sign-up: an account is only created with a valid, unused invite code.
--    The web page passes invite_code and username as sign-up metadata.
-- ---------------------------------------------------------------------------
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_code     text := upper(btrim(coalesce(new.raw_user_meta_data->>'invite_code', '')));
  v_username text := btrim(coalesce(new.raw_user_meta_data->>'username', ''));
  v_first    boolean;
  v_colors   text[] := array['#e0338f','#8a2be2','#1e6fe0','#12a07a','#e0661a','#1ba3bd','#b8860b','#c2187a','#5c9e1e'];
begin
  perform 1 from public.invites where code = v_code and used_by is null for update;
  if not found then
    raise exception 'INVITE_INVALID';
  end if;
  if v_username !~ '^[A-Za-z0-9_]{3,20}$' then
    raise exception 'USERNAME_INVALID';
  end if;
  if exists (select 1 from public.profiles where lower(username) = lower(v_username)) then
    raise exception 'USERNAME_TAKEN';
  end if;

  select not exists (select 1 from public.profiles) into v_first;

  insert into public.profiles (id, username, color, is_admin, is_owner)
  values (new.id, v_username,
          case when v_first then '#e02020' else v_colors[1 + floor(random() * array_length(v_colors, 1))::int] end,
          v_first, v_first);

  update public.invites set used_by = new.id, used_at = now() where code = v_code;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Lets the sign-up form say "that invite code doesn't work" before trying.
create function public.check_signup(p_code text, p_username text) returns text
language plpgsql stable security definer set search_path = public as $$
begin
  if not exists (select 1 from public.invites where code = upper(btrim(p_code)) and used_by is null) then
    return 'INVITE_INVALID';
  end if;
  if btrim(coalesce(p_username, '')) !~ '^[A-Za-z0-9_]{3,20}$' then
    return 'USERNAME_INVALID';
  end if;
  if exists (select 1 from public.profiles where lower(username) = lower(btrim(p_username))) then
    return 'USERNAME_TAKEN';
  end if;
  return 'OK';
end $$;


-- ---------------------------------------------------------------------------
-- 5. Actions (the web page calls these; nobody writes to tables directly)
-- ---------------------------------------------------------------------------

-- Send a message. Returns {"id": ..., "wiped": true/false}.
-- Errors are short codes the page turns into friendly text:
--   NOT_A_MEMBER, ROOM_NOT_FOUND, NOT_IN_ROOM, EMPTY, IMAGE_LOCKED, SPAM_WAIT,
--   TOO_MANY_WORDS, TOO_LONG, NO_IMAGES_FOR_FRIENDS, BAD_IMAGE
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
begin
  -- Lock this person's row so two fast sends are checked one after the other.
  select * into v_prof from public.profiles where id = v_uid for update;
  if not found then raise exception 'NOT_A_MEMBER'; end if;
  if v_prof.banned_at is not null then raise exception 'BANNED'; end if;

  select * into v_room from public.rooms where id = p_room;
  if not found then raise exception 'ROOM_NOT_FOUND'; end if;
  if not public.can_read_room(p_room) then raise exception 'NOT_IN_ROOM'; end if;

  select * into v_set from public.settings where id = 1;

  if v_prof.image_locked_until > now() then raise exception 'IMAGE_LOCKED'; end if;
  if v_prof.muted_until        > now() then raise exception 'SPAM_WAIT';    end if;

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

  -- Image rule: 10 minutes of silence after sending an image.
  if p_image_path is not null then
    update public.profiles
       set image_locked_until = now() + make_interval(secs => v_set.image_lock_seconds)
     where id = v_uid;
  end if;

  if v_room.kind <> 'dm' then
    -- Spam rule: too many messages inside the window means a wait.
    select count(*) into v_recent
      from public.messages m join public.rooms r on r.id = m.room_id
     where m.user_id = v_uid and r.kind <> 'dm' and m.kind <> 'system'
       and m.created_at > now() - make_interval(secs => v_set.spam_window_seconds);
    if v_recent >= v_set.spam_count then
      update public.profiles
         set muted_until = now() + make_interval(secs => v_set.spam_wait_seconds)
       where id = v_uid;
    end if;

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


create function public.create_group(p_name text, p_icon text default '#') returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_uid  uuid := auth.uid();
  v_name text := lower(btrim(coalesce(p_name, '')));
  v_id   uuid;
begin
  if not public.is_member() then raise exception 'NOT_A_MEMBER'; end if;
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

  insert into public.rooms (kind, name, icon, created_by)
  values ('group', v_name, coalesce(nullif(p_icon, ''), '#'), v_uid)
  returning id into v_id;
  insert into public.room_members (room_id, user_id) values (v_id, v_uid);
  insert into public.messages (room_id, user_id, kind, body) values (v_id, v_uid, 'system', 'CREATED');
  return v_id;
end $$;


create function public.join_room(p_room uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_member() then raise exception 'NOT_A_MEMBER'; end if;
  if not exists (select 1 from public.rooms where id = p_room and kind = 'group') then
    raise exception 'ROOM_NOT_FOUND';
  end if;
  insert into public.room_members (room_id, user_id) values (p_room, auth.uid())
  on conflict do nothing;
  if found then
    insert into public.messages (room_id, user_id, kind, body)
    values (p_room, auth.uid(), 'system', 'JOINED');
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


create function public.create_invite() returns text
language plpgsql security definer set search_path = public as $$
declare v_code text;
begin
  if not public.is_member() then raise exception 'NOT_A_MEMBER'; end if;
  if (select count(*) from public.invites where created_by = auth.uid() and used_by is null) >= 5 then
    raise exception 'TOO_MANY_INVITES';
  end if;
  v_code := public.new_code();
  insert into public.invites (code, created_by) values (v_code, auth.uid());
  return v_code;
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
    delete from public.invites where created_by = p_user and used_by is null;
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

-- orphaned_images: no policies, so only the Supabase dashboard can see it.

-- Signed-out visitors may only call check_signup.
revoke execute on all functions in schema public from anon, public;
grant  execute on function public.handle_new_user() to supabase_auth_admin;
grant  execute on function public.check_signup(text, text) to anon, authenticated;
grant  execute on function public.count_words(text), public.is_member(), public.can_read_room(uuid),
         public.can_upload_image(), public.send_message(uuid, text, text), public.create_group(text, text),
         public.join_room(uuid), public.leave_room(uuid), public.create_invite(),
         public.send_friend_request(uuid), public.respond_friend_request(bigint, boolean),
         public.am_admin(), public.set_admin(uuid, boolean), public.ban_user(uuid, boolean)
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
    and public.can_upload_image()
  );

create policy "members view images" on storage.objects
  for select to authenticated using (bucket_id = 'chat-images' and public.is_member());


-- ---------------------------------------------------------------------------
-- 8. Live updates
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table
  public.messages, public.rooms, public.room_members, public.profiles,
  public.friend_requests, public.settings;


-- ---------------------------------------------------------------------------
-- 9. Your first invite code (use it to sign up; that first account is OP)
-- ---------------------------------------------------------------------------
insert into public.invites (code) values (public.new_code());
select code as your_first_invite_code from public.invites;
