create extension if not exists pgcrypto with schema extensions;
create schema if not exists private;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null check (char_length(display_name) between 1 and 50),
  created_at timestamptz not null default now()
);

create table if not exists public.boards (
  id uuid primary key default extensions.gen_random_uuid(),
  name text not null default 'Untitled board' check (char_length(name) between 1 and 80),
  owner_id uuid not null references auth.users(id) on delete cascade,
  share_token_hash text unique,
  created_at timestamptz not null default now()
);

create table if not exists public.board_members (
  board_id uuid not null references public.boards(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null default 'editor' check (role in ('owner','editor')),
  created_at timestamptz not null default now(),
  primary key (board_id, user_id)
);

create table if not exists public.cards (
  id uuid primary key default extensions.gen_random_uuid(),
  board_id uuid not null references public.boards(id) on delete cascade,
  col text not null check (col in ('todo','doing','done')),
  title text not null check (char_length(title) between 1 and 200),
  description text not null default '' check (char_length(description) <= 2000),
  pos double precision not null check (abs(pos) < 1000000000000),
  created_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create index if not exists board_members_user_idx on public.board_members(user_id);
create index if not exists cards_board_idx on public.cards(board_id, col, pos, id);

create or replace function private.is_board_member(p_board_id uuid, p_user_id uuid default auth.uid())
returns boolean language sql stable security definer
set search_path = public, pg_catalog
as $$
  select exists (
    select 1 from public.board_members
    where board_id = p_board_id and user_id = p_user_id
  );
$$;
revoke all on function private.is_board_member(uuid, uuid) from public;
grant execute on function private.is_board_member(uuid, uuid) to authenticated;

create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = public, pg_catalog as $$
begin new.updated_at = now(); return new; end; $$;

drop trigger if exists cards_updated_at on public.cards;
create trigger cards_updated_at before update on public.cards
for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;
alter table public.boards enable row level security;
alter table public.board_members enable row level security;
alter table public.cards enable row level security;

drop policy if exists profiles_select_own on public.profiles;
drop policy if exists profiles_insert_own on public.profiles;
drop policy if exists profiles_update_own on public.profiles;
create policy profiles_select_own on public.profiles for select to authenticated using (id = auth.uid());
create policy profiles_insert_own on public.profiles for insert to authenticated with check (id = auth.uid());
create policy profiles_update_own on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists boards_select_member on public.boards;
drop policy if exists boards_insert_owner on public.boards;
drop policy if exists boards_update_owner on public.boards;
drop policy if exists boards_delete_owner on public.boards;
create policy boards_select_member on public.boards for select to authenticated using ((select private.is_board_member(id, auth.uid())));
create policy boards_insert_owner on public.boards for insert to authenticated with check (owner_id = auth.uid());
create policy boards_update_owner on public.boards for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy boards_delete_owner on public.boards for delete to authenticated using (owner_id = auth.uid());

drop policy if exists members_select_member on public.board_members;
drop policy if exists members_insert_owner on public.board_members;
drop policy if exists members_delete_owner on public.board_members;
create policy members_select_member on public.board_members for select to authenticated using ((select private.is_board_member(board_id, auth.uid())));
create policy members_insert_owner on public.board_members for insert to authenticated with check (exists (select 1 from public.boards b where b.id = board_id and b.owner_id = auth.uid()));
create policy members_delete_owner on public.board_members for delete to authenticated using (exists (select 1 from public.boards b where b.id = board_id and b.owner_id = auth.uid()));

drop policy if exists cards_select_member on public.cards;
drop policy if exists cards_insert_member on public.cards;
drop policy if exists cards_update_member on public.cards;
drop policy if exists cards_delete_member on public.cards;
create policy cards_select_member on public.cards for select to authenticated using ((select private.is_board_member(board_id, auth.uid())));
create policy cards_insert_member on public.cards for insert to authenticated with check ((select private.is_board_member(board_id, auth.uid())) and created_by = auth.uid());
create policy cards_update_member on public.cards for update to authenticated using ((select private.is_board_member(board_id, auth.uid()))) with check ((select private.is_board_member(board_id, auth.uid())));
create policy cards_delete_member on public.cards for delete to authenticated using ((select private.is_board_member(board_id, auth.uid())));

create or replace function public.create_board(p_name text)
returns table(id uuid, name text, share_token text)
language plpgsql security invoker set search_path = public, pg_catalog
as $$
declare
  board_id uuid;
  raw_token text := encode(extensions.gen_random_bytes(24), 'base64url');
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if p_name is null or char_length(trim(p_name)) < 1 or char_length(trim(p_name)) > 80 then raise exception 'invalid board name'; end if;
  insert into public.boards(name, owner_id, share_token_hash)
    values(trim(p_name), auth.uid(), encode(extensions.digest(raw_token, 'sha256'),'hex'))
    returning boards.id into board_id;
  insert into public.board_members(board_id, user_id, role) values(board_id, auth.uid(), 'owner');
  return query select board_id, trim(p_name), raw_token;
end; $$;
grant execute on function public.create_board(text) to authenticated;

create or replace function public.join_board(p_board_id uuid, p_token text)
returns boolean
language plpgsql security definer set search_path = public, pg_catalog
as $$
begin
  if auth.uid() is null then raise exception 'authentication required'; end if;
  if not exists (
    select 1 from public.boards
    where id = p_board_id and share_token_hash = encode(extensions.digest(p_token, 'sha256'),'hex')
  ) then raise exception 'invalid board invite'; end if;
  insert into public.board_members(board_id, user_id, role)
    values(p_board_id, auth.uid(), 'editor')
    on conflict (board_id, user_id) do nothing;
  return true;
end; $$;
revoke all on function public.join_board(uuid, text) from public;
grant execute on function public.join_board(uuid, text) to authenticated;

create or replace function public.rotate_share_token(p_board_id uuid)
returns text
language plpgsql security invoker set search_path = public, pg_catalog
as $$
declare raw_token text := encode(extensions.gen_random_bytes(24), 'base64url');
begin
  update public.boards
    set share_token_hash = encode(extensions.digest(raw_token, 'sha256'),'hex')
  where id = p_board_id and owner_id = auth.uid();
  if not found then raise exception 'owner access required'; end if;
  return raw_token;
end; $$;
grant execute on function public.rotate_share_token(uuid) to authenticated;

grant select on public.profiles to authenticated;
grant select, insert, update, delete on public.boards to authenticated;
grant select, insert, delete on public.board_members to authenticated;
grant select, insert, update, delete on public.cards to authenticated;

drop policy if exists board_presence_read on realtime.messages;
drop policy if exists board_presence_send on realtime.messages;
create policy board_presence_read on realtime.messages
for select to authenticated
using (
  (select realtime.topic()) like 'board:%'
  and (select private.is_board_member(split_part(realtime.topic(), ':', 2)::uuid, auth.uid()))
);
create policy board_presence_send on realtime.messages
for insert to authenticated
with check (
  (select realtime.topic()) like 'board:%'
  and (select private.is_board_member(split_part(realtime.topic(), ':', 2)::uuid, auth.uid()))
);

alter publication supabase_realtime add table public.cards;
alter table public.cards replica identity full;

revoke all on schema private from public;
grant usage on schema private to authenticated;
