-- Production performance hardening: index foreign keys and stabilize auth lookups in RLS.
create index if not exists boards_owner_idx on public.boards(owner_id);
create index if not exists cards_created_by_idx on public.cards(created_by);

alter policy profiles_select_own on public.profiles
  using (id = (select auth.uid()));
alter policy profiles_insert_own on public.profiles
  with check (id = (select auth.uid()));
alter policy profiles_update_own on public.profiles
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

alter policy boards_select_member on public.boards
  using ((select private.is_board_member(id, (select auth.uid()))));
alter policy boards_insert_owner on public.boards
  with check (owner_id = (select auth.uid()));
alter policy boards_update_owner on public.boards
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
alter policy boards_delete_owner on public.boards
  using (owner_id = (select auth.uid()));

alter policy members_select_member on public.board_members
  using ((select private.is_board_member(board_id, (select auth.uid()))));
alter policy members_insert_owner on public.board_members
  with check (exists (
    select 1 from public.boards b
    where b.id = board_members.board_id
      and b.owner_id = (select auth.uid())
  ));
alter policy members_delete_owner on public.board_members
  using (exists (
    select 1 from public.boards b
    where b.id = board_members.board_id
      and b.owner_id = (select auth.uid())
  ));

alter policy cards_select_member on public.cards
  using ((select private.is_board_member(board_id, (select auth.uid()))));
alter policy cards_insert_member on public.cards
  with check (
    (select private.is_board_member(board_id, (select auth.uid())))
    and created_by = (select auth.uid())
  );
alter policy cards_update_member on public.cards
  using ((select private.is_board_member(board_id, (select auth.uid()))))
  with check ((select private.is_board_member(board_id, (select auth.uid()))));
alter policy cards_delete_member on public.cards
  using ((select private.is_board_member(board_id, (select auth.uid()))));
