-- Reactions, 29 September 2026.
-- People can react to a message with Perfect pazhampori ('perfect') or
-- Stinky kayappam ('stinky'): one reaction per person per message.
-- For a database set up from an older schema.sql: paste this whole file into
-- the Supabase SQL editor and run it once. Running it twice is harmless.
-- It only adds things; nothing existing is changed or removed.
begin;

create table if not exists public.message_reactions (
  message_id bigint not null references public.messages(id) on delete cascade,
  user_id    uuid   not null references public.profiles(id) on delete cascade,
  room_id    uuid   not null references public.rooms(id) on delete cascade,
  kind       text   not null check (kind in ('perfect','stinky')),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id)
);
create index if not exists message_reactions_room on public.message_reactions (room_id);
alter table public.message_reactions enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'message_reactions'
                   and policyname = 'read reactions in my rooms') then
    create policy "read reactions in my rooms" on public.message_reactions
      for select to authenticated using (public.can_read_room(room_id));
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
                   and schemaname = 'public' and tablename = 'message_reactions') then
    alter publication supabase_realtime add table public.message_reactions;
  end if;
end $$;

create or replace function public.set_reaction(p_message bigint, p_kind text) returns text
language plpgsql security definer set search_path = public as $$
declare v_msg public.messages%rowtype;
begin
  if not public.is_member() then raise exception 'NOT_A_MEMBER'; end if;
  select * into v_msg from public.messages where id = p_message;
  if not found then raise exception 'MESSAGE_NOT_FOUND'; end if;
  if not public.can_read_room(v_msg.room_id) then raise exception 'NOT_IN_ROOM'; end if;
  if v_msg.kind = 'system' then raise exception 'CANNOT_REACT'; end if;
  if p_kind is null then
    delete from public.message_reactions where message_id = p_message and user_id = auth.uid();
    return null;
  end if;
  if p_kind not in ('perfect', 'stinky') then raise exception 'BAD_REACTION'; end if;
  insert into public.message_reactions (message_id, user_id, room_id, kind)
  values (p_message, auth.uid(), v_msg.room_id, p_kind)
  on conflict (message_id, user_id) do update set kind = excluded.kind, created_at = now();
  return p_kind;
end $$;

revoke execute on function public.set_reaction(bigint, text) from anon, authenticated, public;
grant  execute on function public.set_reaction(bigint, text) to authenticated;

commit;
