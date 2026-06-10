-- Perf pass 2026-06-10: /api/status fetches the latest 100 sync_log rows with
-- a global ORDER BY sync_start DESC LIMIT 100 (no source filter). The only
-- existing index is the composite (source, data_type, sync_start DESC), which
-- cannot serve a global recency sort — so the query seq-scans + sorts the
-- whole table on every status poll. Trivial today (~5.4k rows) but the table
-- grows ~8 rows/hour (~70k/yr) and the route is polled every 60s.
-- Additive only; no semantic change.
CREATE INDEX IF NOT EXISTS idx_sync_log_sync_start
  ON pds.sync_log (sync_start DESC);
