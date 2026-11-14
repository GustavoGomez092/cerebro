-- Summaries: per-session rolling summaries and per-binding history summaries.
create table summaries (
  id bigserial primary key,
  session_id text references sessions(id),
  kind text not null check (kind in ('session', 'history')),
  binding_id uuid not null references bindings(id),
  client_id uuid,
  project_id uuid,
  first_seq integer,
  last_seq integer,
  ts_from timestamptz not null,
  ts_to timestamptz not null,
  title text not null,
  body jsonb not null,
  text text not null,
  tsv tsvector generated always as (to_tsvector('cerebro'::regconfig, title || ' ' || text)) stored,
  model text not null,
  created_at timestamptz not null default now(),
  unique (session_id, first_seq, last_seq)
);
create index summaries_tsv_idx on summaries using gin (tsv);
create index summaries_project_idx on summaries (project_id, ts_to desc);
create index summaries_client_idx on summaries (client_id, ts_to desc);

create table summary_embeddings (
  summary_id bigint primary key references summaries(id) on delete cascade,
  embedding halfvec(1024) not null
);
create index summary_embeddings_hnsw_idx on summary_embeddings using hnsw (embedding halfvec_cosine_ops);

-- Durable summarising work queue, one row per session.
create table summary_jobs (
  session_id text primary key references sessions(id),
  priority smallint not null default 0,
  covered_seq integer not null default -1,
  due_at timestamptz not null default now(),
  attempts integer not null default 0,
  locked_until timestamptz,
  last_error text,
  dead boolean not null default false
);

-- Rolling state document per scope: 'project:<uuid>' or 'client:<uuid>'.
create table project_states (
  scope text primary key,
  client_id uuid not null,
  project_id uuid,
  doc jsonb not null,
  text text not null,
  version integer not null default 1,
  dirty boolean not null default false,
  source_summary_ids bigint[] not null default '{}',
  updated_at timestamptz not null default now()
);

-- Token spend, for budget limits. kind: summary | state | history.
create table usage_ledger (
  id bigserial primary key,
  at timestamptz not null default now(),
  tokens integer not null,
  kind text not null
);
create index usage_ledger_at_idx on usage_ledger (at);
