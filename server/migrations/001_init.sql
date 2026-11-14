create extension if not exists vector;

create table clients (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  created_at timestamptz not null default now()
);
insert into clients (name) values ('Personal');

create table projects (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references clients(id),
  name text not null,
  created_at timestamptz not null default now(),
  unique (client_id, name)
);

create table machines (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table bindings (
  id uuid primary key default gen_random_uuid(),
  repo text not null,
  subpath text not null default '',
  status text not null check (status in ('active', 'declined')),
  client_id uuid references clients(id),
  project_id uuid references projects(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (repo, subpath),
  check (status = 'declined' or client_id is not null)
);

create table sessions (
  id text primary key,
  binding_id uuid not null references bindings(id),
  machine_id uuid not null references machines(id),
  cwd text not null,
  started_at timestamptz not null,
  last_event_at timestamptz,
  ended_at timestamptz,
  imported boolean not null default false
);
create index sessions_binding_idx on sessions (binding_id);

create table events (
  id bigserial primary key,
  key text not null unique,
  session_id text not null references sessions(id),
  seq integer not null,
  ts timestamptz not null,
  kind text not null check (kind in ('user', 'assistant', 'tool_call', 'tool_result')),
  text text not null default '',
  tool_name text,
  tool_input jsonb,
  indexed boolean not null default false
);
create index events_session_seq_idx on events (session_id, seq);
create index events_unindexed_idx on events (session_id) where not indexed;

create table chunks (
  id bigserial primary key,
  session_id text not null references sessions(id),
  first_seq integer not null,
  last_seq integer not null,
  part integer not null default 0,
  ts_from timestamptz not null,
  ts_to timestamptz not null,
  text text not null,
  tsv tsvector generated always as (to_tsvector('simple', text)) stored,
  embedding vector(1024) not null,
  unique (session_id, first_seq, last_seq, part)
);
create index chunks_session_idx on chunks (session_id);
create index chunks_tsv_idx on chunks using gin (tsv);
create index chunks_embedding_idx on chunks using hnsw (embedding vector_cosine_ops);
