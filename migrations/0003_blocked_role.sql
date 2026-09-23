-- Uploads are open to every signed-in account; the owner can block one.
-- A blocked account keeps a members row with role 'blocked'.
begin;
alter table members drop constraint members_role_check;
alter table members add constraint members_role_check check (role in ('owner', 'member', 'blocked'));
commit;
