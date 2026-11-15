-- The db image moved from pgvector 0.8.1 (Postgres 17.8) to 0.8.6: bring the extension's SQL objects up to
-- the installed library. A no-op where the extension is already at the default version.
alter extension vector update;
