-- Each queued chunk carries the machine that uploaded its session (sessions.machine_id, fixed at first ingest), so
-- a machine's embed lane (EMBED_MACHINE_URLS) claims its own work through an index instead of joining the whole
-- chunks table. Null: no machine known; that work embeds on the Zima. `enqueued_at` dates the wait, for check.sh.
alter table embed_queue add column machine_id uuid references machines(id);
alter table embed_queue add column enqueued_at timestamptz not null default now();
update embed_queue q set machine_id = s.machine_id
from chunks c join sessions s on s.id = c.session_id
where c.id = q.chunk_id;
create index embed_queue_machine_ready_idx on embed_queue (machine_id, priority, chunk_id) where not dead;
