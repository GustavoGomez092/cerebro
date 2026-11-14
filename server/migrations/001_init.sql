create extension if not exists vector;
create extension if not exists unaccent;

-- Keep statements and idle transactions from holding resources forever.
do $$ begin
  execute format('alter database %I set statement_timeout = %L', current_database(), '30s');
  execute format('alter database %I set idle_in_transaction_session_timeout = %L', current_database(), '60s');
end $$;

-- Full-text config: no stemming (English/Spanish mix), accents folded.
create text search configuration cerebro (copy = simple);
alter text search configuration cerebro
  alter mapping for asciiword, word, numword, asciihword, hword, numhword, hword_asciipart, hword_part, hword_numpart
  with unaccent, simple;

-- One-row install settings. instance_id lets clients verify they reached this install.
create table settings (
  id boolean primary key default true check (id),
  instance_id uuid not null default gen_random_uuid(),
  embed_model text,
  embed_dims integer,
  created_at timestamptz not null default now()
);
insert into settings default values;

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
  last_used_at timestamptz,
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

-- Append-only audit of every binding change and session move.
create table binding_history (
  id bigserial primary key,
  binding_id uuid not null references bindings(id),
  machine_id uuid references machines(id),
  action text not null,
  before jsonb,
  after jsonb,
  at timestamptz not null default now()
);
create index binding_history_binding_idx on binding_history (binding_id, at);

create table sessions (
  id text primary key,
  binding_id uuid not null references bindings(id),
  machine_id uuid not null references machines(id),
  cwd text not null,
  repo text not null,
  subpath text not null default '',
  started_at timestamptz not null,
  last_event_at timestamptz,
  ended_at timestamptz,
  imported boolean not null default false,
  meta jsonb not null default '{}'
);
create index sessions_binding_idx on sessions (binding_id);
create index sessions_started_idx on sessions (started_at desc);
create index sessions_repo_idx on sessions (repo, subpath);

-- Raw conversation, kept forever. Immutable after insert.
create table events (
  id bigserial primary key,
  session_id text not null references sessions(id),
  key text not null,
  seq integer not null,
  ts timestamptz not null,
  kind text not null check (kind in ('user', 'assistant', 'tool_call', 'tool_result')),
  text text compression lz4 not null default '',
  tool_name text,
  tool_input jsonb,
  meta jsonb not null default '{}',
  unique (session_id, key)
);
create index events_session_seq_idx on events (session_id, seq);

-- Search units. Full-text works as soon as a chunk exists; vectors arrive later.
create table chunks (
  id bigserial primary key,
  session_id text not null references sessions(id),
  first_seq integer not null,
  last_seq integer not null,
  part integer not null default 0,
  ts_from timestamptz not null,
  ts_to timestamptz not null,
  text text not null,
  extra_terms text not null default '',
  tsv tsvector generated always as (to_tsvector('cerebro'::regconfig, text || ' ' || extra_terms)) stored,
  unique (session_id, first_seq, last_seq, part)
);
create index chunks_tsv_idx on chunks using gin (tsv);
create index chunks_ts_from_idx on chunks (ts_from);

create table chunk_embeddings (
  chunk_id bigint primary key references chunks(id) on delete cascade,
  embedding halfvec(1024) not null
);
create index chunk_embeddings_hnsw_idx on chunk_embeddings using hnsw (embedding halfvec_cosine_ops);

-- Durable embedding work queue. priority 0 = live session, 1 = imported history.
create table embed_queue (
  chunk_id bigint primary key references chunks(id) on delete cascade,
  priority smallint not null default 0,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  locked_until timestamptz,
  last_error text,
  dead boolean not null default false
);
create index embed_queue_ready_idx on embed_queue (priority, chunk_id) where not dead;
