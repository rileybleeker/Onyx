-- ============================================================
-- Onyx: "Run now" requests for jobs on Riley's PC (2026-11-16)
-- ============================================================
-- One row per press of a Run now button. Today only the Kindle harvester (task 'kindle').
--
-- Event driven, no polling job on the PC: POST /api/kindle/run inserts a row, Supabase Realtime
-- pushes the INSERT to the idle listener on the PC (tools/kindle_harvest/run-listener.mjs, one
-- websocket held open since logon), which starts the "Onyx Kindle Harvest" scheduled task and
-- writes its answer back on the same row: picked_up_at + outcome when it starts (or finds a
-- scheduled run already going), finished_at + exit_code when the harvest ends. The button reads
-- the row through GET /api/kindle/run?id=… while it waits.
--
-- Stored: the task name, times, an outcome word, the harvester's exit code and a short code.
-- No highlight text, no Amazon data, no error text.
--
-- SERVICE-ROLE ONLY: RLS on, no policies, no anon / authenticated grant. Realtime delivers a
-- row only to a subscriber whose role can read it, so only the PC's service key hears inserts.
-- Re-running this file is safe.
-- ============================================================

CREATE TABLE IF NOT EXISTS pds.pc_run_requests (
    id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    task          TEXT        NOT NULL,
    requested_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    picked_up_at  TIMESTAMPTZ,
    outcome       TEXT,                     -- started | already_running | failed
    finished_at   TIMESTAMPTZ,
    exit_code     INTEGER,                  -- the harvester's exit code (0 ok, 1 error, 2 signed out, 3 no token)
    detail        TEXT,                     -- short code, e.g. did_not_start, task_missing, timeout
    CONSTRAINT pc_run_requests_task CHECK (task IN ('kindle')),
    CONSTRAINT pc_run_requests_outcome CHECK (outcome IS NULL OR outcome IN ('started', 'already_running', 'failed')),
    CONSTRAINT pc_run_requests_detail CHECK (detail IS NULL OR (length(detail) <= 60 AND detail ~ '^[a-z0-9_]+$'))
);

CREATE INDEX IF NOT EXISTS pc_run_requests_task_time_idx ON pds.pc_run_requests (task, requested_at DESC);

ALTER TABLE pds.pc_run_requests ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON pds.pc_run_requests FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON pds.pc_run_requests TO service_role;

-- Realtime: push INSERTs to the PC listener.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'pds' AND tablename = 'pc_run_requests'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE pds.pc_run_requests;
  END IF;
END $$;
