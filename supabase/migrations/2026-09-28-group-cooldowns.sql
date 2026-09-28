-- Group cooldowns, 28 September 2026.
-- Admins can switch the image cooldown and flood control off in a group.
-- Global chat always keeps them; friend chats no longer have them.
-- For a database set up from an older schema.sql: paste this whole file into
-- the Supabase SQL editor and run it once. Running it twice is harmless.
begin;

alter table public.rooms add column if not exists cooldowns boolean not null default true;
alter table public.rooms drop constraint if exists rooms_cooldowns_groups_only;
alter table public.rooms add constraint rooms_cooldowns_groups_only check (cooldowns or kind = 'group');

-- The upload rule now looks at which room an image is for.
drop policy if exists "members upload images to own folder" on storage.objects;
drop function if exists public.can_upload_image();

create or replace function public.can_upload_image(p_name text) returns boolean
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

  -- Image rule: 2 minutes of silence after sending an image.
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

create or replace function public.set_group_cooldowns(p_room uuid, p_on boolean) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.am_admin() then raise exception 'NOT_ADMIN'; end if;
  update public.rooms set cooldowns = p_on where id = p_room and kind = 'group' and cooldowns <> p_on;
  if found then
    insert into public.messages (room_id, user_id, kind, body)
    values (p_room, auth.uid(), 'system', case when p_on then 'COOLDOWNS_ON' else 'COOLDOWNS_OFF' end);
  end if;
end $$;

revoke execute on function public.can_upload_image(text), public.set_group_cooldowns(uuid, boolean) from anon, authenticated, public;
grant  execute on function public.can_upload_image(text), public.set_group_cooldowns(uuid, boolean) to authenticated;

create policy "members upload images to own folder" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'chat-images'
    and (storage.foldername(name))[1] = auth.uid()::text
    and public.can_upload_image(name)
  );

commit;
