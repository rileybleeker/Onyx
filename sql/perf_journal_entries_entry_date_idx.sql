-- Perf (speed budget, 2026-11-17): /api/journal/list (the /log Journal section and its early prewarm) filters
-- archived = false, a range on entry_date (from/to) and orders by entry_date DESC with LIMIT 20. No index on
-- entry_date exists in the repo's SQL, so the query sorts or scans the whole table. This partial index matches
-- that filter and order exactly.
--
-- Additive only: no DROP, no change to existing objects. NOT APPLIED. Apply via the Supabase MCP or dashboard.
-- CONCURRENTLY is not used because it cannot run inside a transaction block; the table is small, so a plain
-- build is brief. If the MCP refuses a plain build, run it from the SQL editor.

CREATE INDEX IF NOT EXISTS idx_journal_entries_live_entry_date
    ON pds.journal_entries (entry_date DESC)
    WHERE archived = false;
