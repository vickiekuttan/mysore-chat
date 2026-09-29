-- Space limits, 29 September 2026.
-- Global chat and the groups are also wiped (messages and images only;
-- groups, members, friend chats and accounts stay) when the database reaches
-- 400 MB or chat images reach 800 MB: 80% of Supabase's free plan. Wiped
-- images are now actually deleted from Storage, by members' pages in the
-- background.
-- For a database set up from an older schema.sql: paste this whole file into
-- the Supabase SQL editor and run it once. Running it twice is harmless.
begin;

alter table public.settings add column if not exists wipe_at_db_bytes    bigint not null default 400000000;
alter table public.settings add column if not exists wipe_at_image_bytes bigint not null default 800000000;

create or replace function public.image_bytes_in_use() returns bigint
language sql stable security definer set search_path = public as $$
  select coalesce(sum((o.metadata->>'size')::bigint), 0)
    from storage.objects o
   where o.bucket_id = 'chat-images'
     and not exists (select 1 from public.orphaned_images x where x.path = o.name)
$$;

create or replace function public.wipe_public(p_body text) returns void
language plpgsql security definer set search_path = public as $$
declare v_global uuid;
begin
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
  values (v_global, null, 'system', p_body);
end $$;

create or replace function public.send_message(p_room uuid, p_body text default '', p_image_path text default null)
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
  v_wipe   text;
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
      v_wipe := 'WIPE';
    -- Space: wipe before Supabase's free-plan limits are reached (going over
    -- makes the database read-only). Deleted rows don't shrink the database
    -- right away, so a database-size wipe waits an hour before it can repeat.
    elsif public.image_bytes_in_use() >= v_set.wipe_at_image_bytes
       or (pg_database_size(current_database()) >= v_set.wipe_at_db_bytes
           and (v_set.last_wiped_at is null or v_set.last_wiped_at < now() - interval '1 hour')) then
      v_wipe := 'WIPE_SPACE';
    end if;

    if v_wipe is not null then
      perform public.wipe_public(v_wipe);
      v_wiped := true;
    end if;
  end if;

  return jsonb_build_object('id', v_id, 'wiped', v_wiped, 'wipe', v_wipe);
end $$;

create or replace function public.is_orphaned_image(p_name text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.orphaned_images where path = p_name)
$$;

create or replace function public.orphaned_image_batch() returns text[]
language sql stable security definer set search_path = public as $$
  select case when public.is_member()
    then coalesce((select array_agg(path) from
           (select path from public.orphaned_images order by listed_at, path limit 100) x), '{}'::text[])
    else '{}'::text[] end
$$;

create or replace function public.forget_deleted_images(p_paths text[]) returns int
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  if not public.is_member() then raise exception 'NOT_A_MEMBER'; end if;
  delete from public.orphaned_images o
   where o.path = any(p_paths)
     and not exists (select 1 from storage.objects s where s.bucket_id = 'chat-images' and s.name = o.path);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke execute on function public.image_bytes_in_use(), public.wipe_public(text),
  public.is_orphaned_image(text), public.orphaned_image_batch(), public.forget_deleted_images(text[])
  from anon, authenticated, public;
grant execute on function public.is_orphaned_image(text), public.orphaned_image_batch(),
  public.forget_deleted_images(text[]) to authenticated;

drop policy if exists "members clear wiped images" on storage.objects;
create policy "members clear wiped images" on storage.objects
  for delete to authenticated using (
    bucket_id = 'chat-images' and public.is_member() and public.is_orphaned_image(name)
  );

commit;
