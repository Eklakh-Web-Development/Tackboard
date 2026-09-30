-- Fix PostgreSQL encode(): base64url is not a supported encoding name.
-- Generate standard base64, translate URL-sensitive characters, and remove padding.
create or replace function public.create_board(p_name text)
returns table(id uuid, name text, share_token text)
language plpgsql security invoker set search_path = public, pg_catalog
as $$
declare
  board_id uuid;
  raw_token text := rtrim(translate(encode(extensions.gen_random_bytes(24), 'base64'), '+/', '-_'), '=');
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
