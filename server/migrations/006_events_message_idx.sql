-- User and assistant messages per session in seq order, with their time: the summariser's scheduler
-- counts a session's uncovered messages (and finds the oldest) from this index alone, per session,
-- instead of scanning the events table.
create index events_session_message_seq_idx on events (session_id, seq) include (ts) where kind in ('user', 'assistant');
