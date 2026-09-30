-- Fix share-link rotation to use PostgreSQL-compatible URL-safe base64.
create or replace function public.rotate_share_token(p_board_id uuid)
returns text
language plpgsql
security invoker
set search_path = public, pg_catalog
as $$
declare
  raw_token text := rtrim(
    translate(
      encode(extensions.gen_random_bytes(24), 'base64'),
      '+/',
      '-_'
    ),
    '='
  );
begin
  if auth.uid() is null then
    raise exception 'authentication required';
  end if;

  update public.boards
    set share_token_hash = encode(extensions.digest(raw_token, 'sha256'),'hex')
  where id = p_board_id
    and owner_id = auth.uid();

  if not found then
    raise exception 'owner access required';
  end if;

  return raw_token;
end;
$$;

revoke all on function public.rotate_share_token(uuid) from public;
revoke execute on function public.rotate_share_token(uuid) from anon;
grant execute on function public.rotate_share_token(uuid) to authenticated;
