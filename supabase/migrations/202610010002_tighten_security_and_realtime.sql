-- Production security and private Realtime hardening.
revoke execute on function public.join_board(uuid, text) from anon;
revoke execute on function public.join_board(uuid, text) from public;
grant execute on function public.join_board(uuid, text) to authenticated;

revoke execute on function public.rls_auto_enable() from anon, authenticated, public;

drop policy if exists board_presence_read on realtime.messages;
drop policy if exists board_presence_send on realtime.messages;
drop policy if exists board_realtime_read on realtime.messages;
drop policy if exists board_realtime_send on realtime.messages;

create policy board_realtime_read on realtime.messages
for select to authenticated
using (
  (select realtime.topic()) like 'board:%'
  and (select private.is_board_member(
    (split_part((select realtime.topic()), ':', 2))::uuid,
    (select auth.uid())
  ))
  and extension = any (array['presence','broadcast'])
);

create policy board_realtime_send on realtime.messages
for insert to authenticated
with check (
  (select realtime.topic()) like 'board:%'
  and (select private.is_board_member(
    (split_part((select realtime.topic()), ':', 2))::uuid,
    (select auth.uid())
  ))
  and extension = any (array['presence','broadcast'])
);
