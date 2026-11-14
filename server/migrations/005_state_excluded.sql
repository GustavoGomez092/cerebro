-- Summaries the last rebuild of a state deliberately left out (to fit the budget), so later updates do
-- not fold them back in one at a time. Overwritten by every rebuild.
alter table project_states add column excluded_summary_ids bigint[] not null default '{}';
