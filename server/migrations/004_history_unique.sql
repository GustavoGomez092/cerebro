-- One initial history per folder binding and period: re-sending the same period replaces it.
create unique index summaries_history_period_idx on summaries (binding_id, ts_from, ts_to) where kind = 'history';
