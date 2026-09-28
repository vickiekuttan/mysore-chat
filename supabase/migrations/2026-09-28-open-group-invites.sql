-- Invitations to open groups, 28 September 2026.
-- Admins can invite someone to any group, not only locked ones. Unlocking a
-- group now keeps its invitations (it still clears requests to join).
-- For a database set up from an older schema.sql: paste this whole file into
-- the Supabase SQL editor and run it once. Running it twice is harmless.
begin;

create or replace function public.invite_to_group(p_room uuid, p_user uuid) returns text
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

create or replace function public.set_group_locked(p_room uuid, p_locked boolean) returns void
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

commit;
