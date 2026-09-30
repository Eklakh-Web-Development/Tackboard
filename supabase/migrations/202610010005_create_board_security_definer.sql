-- Create boards through a tightly scoped SECURITY DEFINER RPC.
-- This is required because the owner membership row does not exist until after the board insert.
create or replace function public.create_board(p_name text)
returns table(id uuid, name text, share_token text)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  board_id uuid;
  caller uuid := auth.uid();
  raw_token text := rtrim(translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/', '-_'), '=');
begin
  if caller is null then raise exception 'authentication required'; end if;
  if p_name is null or char_length(trim(p_name)) < 1 or char_length(trim(p_name)) > 80 then
    raise exception 'invalid board name';
  end if;

  insert into public.boards(name, owner_id, share_token_hash)
    values(trim(p_name), caller, encode(extensions.digest(raw_token, 'sha256'),'hex'))
    returning boards.id into board_id;

  insert into public.board_members(board_id, user_id, role)
    values(board_id, caller, 'owner');

  return query select board_id, trim(p_name), raw_token;
end;
$$;

revoke all on function public.create_board(text) from public;
revoke execute on function public.create_board(text) from anon;
grant execute on function public.create_board(text) to authenticated;
