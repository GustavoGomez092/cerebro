-- Counts dirty marks on a project state, so an update or rebuild clears `dirty` only when no new
-- mark (a new summary, a re-bind, an adopt or a session move) arrived while it ran.
alter table project_states add column dirty_gen bigint not null default 0;
