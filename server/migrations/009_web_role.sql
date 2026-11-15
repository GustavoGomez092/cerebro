-- cerebro-web's own database role: the `auth` schema (Better Auth) and nothing else, never the `cerebro` superuser.
-- Created NOLOGIN so no secret lives in a migration: `cli.ts web-db-role` (deploy/zima/web-db-role.sh on the Zima)
-- gives it LOGIN and a password. Roles are cluster-wide: an existing one (another database, a restore) is kept.
do $$ begin
  create role cerebro_web nologin;
exception when duplicate_object then null;
end $$;

grant usage, create on schema auth to cerebro_web;
grant select, insert, update, delete on all tables in schema auth to cerebro_web;
alter default privileges in schema auth grant select, insert, update, delete on tables to cerebro_web;
alter default privileges in schema auth grant usage, select on sequences to cerebro_web;
alter role cerebro_web set search_path = auth;

-- Nothing in public. PUBLIC's default USAGE on the schema is revoked too (the server's role owns everything there and
-- keeps its rights), so cerebro_web can't even list Cerebro's tables.
revoke all on schema public from cerebro_web;
revoke all on schema public from public;
