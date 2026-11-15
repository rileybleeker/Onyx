-- ============================================================================
-- AI tool usage (2026-11-14): daily metadata about Riley's Claude Code and
-- Codex sessions on the PC (tools/ai_usage_harvest)
-- ============================================================================
-- Source: a Task Scheduler harvester on the PC reads the session logs both
-- tools keep locally (~/.claude/projects/**.jsonl, ~/.codex/sessions/**) and
-- keeps METADATA ONLY: record times, token counts, model names, how many
-- prompts and tool calls, and the working folder's NAME. No prompt or reply
-- text, tool input or output, file path, branch or title ever leaves the PC;
-- the harvester checks every row against an allow-list before upload and
-- tests/test_ai_usage_harvest.py fails if log content reaches a row.
--
-- One row per (device, behavioral day, tool, project folder name), aggregated
-- on the PC before upload:
--   behavioral_date   ADR-0001 day of the record's local time on the PC
--                     (00:00-05:59 belongs to the day before), computed on the PC
--   sessions          top-level sessions STARTED that day (subagents are not sessions)
--   subagents         subagent transcripts / threads started that day
--   prompts           user prompts typed (tool results and injected context are not prompts)
--   tool_calls        tool calls, subagents included
--   active_minutes    distinct clock minutes with session activity (top-level sessions)
--   late_active_minutes / after_midnight_active_minutes
--                     of those, local 21:00-05:59 / 00:00-05:59
--   session_minutes   sum over sessions of first-to-last activity within the day
--   *_tokens          model usage, subagents included. input = uncached input;
--                     cache_read / cache_write as each tool reports them
--   models            distinct model names used that day
--   first_activity / last_activity   first and last top-level activity (UTC)
-- SDK-driven Claude Code runs and Codex exec runs are left out (automation).
-- A day is re-sent until it has ended, then it is final on the PC.
--
-- Access: RLS on; the owner account may read it in the browser (owner_read,
-- the pattern in sql/pds_owner_only_read.sql), the service role writes it (the
-- harvester, with ~/.onyx_supabase_secret) and /api/status reads only its
-- heartbeat (ai_usage|sessions in pds.sync_log). anon gets nothing.
--
-- Safe to re-run (IF NOT EXISTS everywhere). Contains no destructive
-- statement, so the Supabase MCP connector will not refuse it.
-- ============================================================================

CREATE TABLE IF NOT EXISTS pds.ai_tool_usage_daily (
    device                          TEXT        NOT NULL CHECK (device ~ '^[a-z0-9._-]{1,40}$'),
    behavioral_date                 DATE        NOT NULL,
    tool                            TEXT        NOT NULL CHECK (tool IN ('claude_code', 'codex')),
    project                         TEXT        NOT NULL CHECK (project ~ '^[a-z0-9._-]{1,64}$'),  -- folder name only
    sessions                        INTEGER     NOT NULL DEFAULT 0 CHECK (sessions >= 0),
    subagents                       INTEGER     NOT NULL DEFAULT 0 CHECK (subagents >= 0),
    prompts                         INTEGER     NOT NULL DEFAULT 0 CHECK (prompts >= 0),
    tool_calls                      INTEGER     NOT NULL DEFAULT 0 CHECK (tool_calls >= 0),
    active_minutes                  INTEGER     NOT NULL DEFAULT 0 CHECK (active_minutes BETWEEN 0 AND 1500),
    late_active_minutes             INTEGER     NOT NULL DEFAULT 0 CHECK (late_active_minutes >= 0),
    after_midnight_active_minutes   INTEGER     NOT NULL DEFAULT 0 CHECK (after_midnight_active_minutes >= 0),
    session_minutes                 INTEGER     NOT NULL DEFAULT 0 CHECK (session_minutes >= 0),
    input_tokens                    BIGINT      NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
    output_tokens                   BIGINT      NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
    cache_read_tokens               BIGINT      NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
    cache_write_tokens              BIGINT      NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
    models                          TEXT[]      NOT NULL DEFAULT '{}' CHECK (cardinality(models) <= 10),
    first_activity                  TIMESTAMPTZ,
    last_activity                   TIMESTAMPTZ,
    synced_at                       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (device, behavioral_date, tool, project),
    CHECK (late_active_minutes <= active_minutes),
    CHECK (after_midnight_active_minutes <= late_active_minutes),
    CHECK (first_activity IS NULL OR last_activity IS NULL OR first_activity <= last_activity)
);

CREATE INDEX IF NOT EXISTS ai_tool_usage_daily_behavioral_idx
    ON pds.ai_tool_usage_daily (behavioral_date);

COMMENT ON TABLE pds.ai_tool_usage_daily IS
    'Claude Code + Codex usage per (device, behavioral day, tool, project folder name): sessions, prompts, tool calls, active and late-night minutes, tokens, models. Metadata only, aggregated on the PC by tools/ai_usage_harvest (no conversation content). Heartbeat ai_usage|sessions.';

-- ---------------------------------------------------------------------------
-- RLS + grants: owner reads, service role writes (mirrors sql/pollen_schema.sql)
-- ---------------------------------------------------------------------------
ALTER TABLE pds.ai_tool_usage_daily ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'pds' AND tablename = 'ai_tool_usage_daily' AND policyname = 'owner_read'
    ) THEN
        CREATE POLICY owner_read ON pds.ai_tool_usage_daily FOR SELECT TO authenticated
            USING ((SELECT auth.uid()) = 'dc041abc-115a-4252-8536-803f2ac75557'::uuid);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'pds' AND tablename = 'ai_tool_usage_daily' AND policyname = 'service_full_access'
    ) THEN
        CREATE POLICY service_full_access ON pds.ai_tool_usage_daily
            FOR ALL TO service_role USING (true) WITH CHECK (true);
    END IF;
END $$;

REVOKE ALL ON pds.ai_tool_usage_daily FROM anon, authenticated;
GRANT SELECT ON pds.ai_tool_usage_daily TO authenticated;
GRANT ALL    ON pds.ai_tool_usage_daily TO service_role;

-- Make PostgREST pick up the new table without waiting for a restart.
NOTIFY pgrst, 'reload schema';
