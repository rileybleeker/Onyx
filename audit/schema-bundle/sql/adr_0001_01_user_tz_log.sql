-- =============================================================================
-- ADR-0001 Phase 1, step 1 — pds.user_tz_log + derivation helpers
-- =============================================================================
-- Per docs/adr/0001-timezone-and-behavioral-day-handling.md (D3 hybrid TZ
-- detection, tier 3). Hand-maintained table of "Riley was in IANA TZ X
-- starting from instant T." Falls back to ET when no row covers an instant.
--
-- Schema:
--   user_tz_log(effective_from TIMESTAMPTZ PK, tz TEXT IANA)
--
-- The "currently in effect" TZ at any instant `t` is the row with the
-- largest `effective_from` <= t. Insert one row per TZ transition (typically
-- flight landings). NY trips don't need entries — that's the default.
--
-- Helper:
--   pds.tz_for_instant(ts TIMESTAMPTZ) — returns the IANA TZ in effect.
--     Lookups: user_tz_log first, fall back to 'America/New_York'.
--
--   pds.derive_onyx_dates(ts, tz_offset_text, tz_source_in)
--     Returns (et_date, behavioral_date, local_date, tz_source).
--     tz_offset_text: TZD format ('-04:00', '+09:00') when the source
--       provides its own offset (WHOOP). Pass NULL to fall through to
--       user_tz_log lookup.
--     tz_source_in: provenance label set by the caller per D6
--       ('source_field' | 'cycle_anchor' | 'user_tz_log' | 'gps_inferred'
--        | 'default_et_fallback').
--
-- Apply: run in Supabase SQL Editor or via MCP apply_migration.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. pds.user_tz_log table
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS pds.user_tz_log (
    effective_from  TIMESTAMPTZ NOT NULL,
    tz              TEXT NOT NULL,
    notes           TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),

    PRIMARY KEY (effective_from),
    -- Loose check that tz looks like an IANA zone (Region/Area). Don't try to
    -- validate the full zone list here — Postgres can't enforce that without
    -- a custom function calling pg_timezone_names. Format check catches the
    -- common mistake of passing 'EDT' or '-04:00' instead of 'America/New_York'.
    CHECK (tz ~ '^[A-Za-z]+/[A-Za-z_]+(/[A-Za-z_]+)?$' OR tz IN ('UTC', 'GMT'))
);

CREATE INDEX IF NOT EXISTS idx_user_tz_log_effective_from
    ON pds.user_tz_log (effective_from DESC);

COMMENT ON TABLE pds.user_tz_log IS
'Per ADR-0001 D3: hand-maintained log of Riley''s timezone transitions. One row per flight landing into a non-ET zone (and back). pds.tz_for_instant() reads this. ~5-10 rows/year expected.';

ALTER TABLE pds.user_tz_log ENABLE ROW LEVEL SECURITY;

-- Service role full access; anon read-only (matches existing pattern).
DROP POLICY IF EXISTS user_tz_log_service_all ON pds.user_tz_log;
CREATE POLICY user_tz_log_service_all ON pds.user_tz_log
    FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS user_tz_log_anon_read ON pds.user_tz_log;
CREATE POLICY user_tz_log_anon_read ON pds.user_tz_log
    FOR SELECT TO anon, authenticated USING (true);

-- ---------------------------------------------------------------------------
-- 2. pds.tz_for_instant — IANA TZ lookup with ET fallback
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pds.tz_for_instant(ts TIMESTAMPTZ)
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
    SELECT COALESCE(
        (SELECT tz
           FROM pds.user_tz_log
          WHERE effective_from <= ts
          ORDER BY effective_from DESC
          LIMIT 1),
        'America/New_York'
    );
$$;

COMMENT ON FUNCTION pds.tz_for_instant(TIMESTAMPTZ) IS
'Per ADR-0001 D3 tier 3+5: returns IANA TZ in effect at the given instant per user_tz_log, falling back to America/New_York. Used by triggers that derive onyx_local_date without a source TZ field.';

-- ---------------------------------------------------------------------------
-- 3. pds.derive_onyx_dates — pure derivation function
-- ---------------------------------------------------------------------------
-- Returns the three onyx_* dates + provenance enum, given:
--   ts            : the UTC instant of the event
--   tz_offset_text: TZD-format offset from a source field ('-04:00'), or NULL
--                   to fall through to user_tz_log lookup
--   tz_source_in  : provenance ('source_field', 'cycle_anchor',
--                   'user_tz_log', 'gps_inferred', 'default_et_fallback')
--
-- Behavioral date = (instant in local TZ − 6h)::date. Matches the
-- whoop_journal.behaviors_date trigger formula. The −6h boundary means any
-- bedtime up to 6 AM local attributes to "yesterday" — generalized
-- bedtime-to-bedtime per D2.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION pds.derive_onyx_dates(
    ts                TIMESTAMPTZ,
    tz_offset_text    TEXT,
    tz_source_in      TEXT
)
RETURNS TABLE (
    onyx_et_date          DATE,
    onyx_behavioral_date  DATE,
    onyx_local_date       DATE,
    onyx_tz_source        TEXT
)
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    local_instant     TIMESTAMP;
    resolved_offset   INTERVAL;
    resolved_tz       TEXT;
    resolved_source   TEXT;
BEGIN
    IF ts IS NULL THEN
        RETURN QUERY SELECT NULL::DATE, NULL::DATE, NULL::DATE, NULL::TEXT;
        RETURN;
    END IF;

    -- ET is always derivable (canonical reference).
    onyx_et_date := (ts AT TIME ZONE 'America/New_York')::date;

    -- Resolve local TZ via tier ladder.
    IF tz_offset_text IS NOT NULL AND tz_offset_text <> '' THEN
        -- Tier 1: source provided TZD offset directly.
        resolved_offset := tz_offset_text::interval;
        local_instant   := (ts AT TIME ZONE 'UTC') + resolved_offset;
        resolved_source := COALESCE(tz_source_in, 'source_field');

        onyx_local_date      := local_instant::date;
        onyx_behavioral_date := (local_instant - INTERVAL '6 hours')::date;
    ELSE
        -- Tier 3+5: user_tz_log lookup, ET fallback.
        resolved_tz := pds.tz_for_instant(ts);
        IF resolved_tz = 'America/New_York' AND NOT EXISTS (
            SELECT 1 FROM pds.user_tz_log
             WHERE effective_from <= ts
             LIMIT 1
        ) THEN
            resolved_source := COALESCE(tz_source_in, 'default_et_fallback');
        ELSE
            resolved_source := COALESCE(tz_source_in, 'user_tz_log');
        END IF;

        local_instant        := ts AT TIME ZONE resolved_tz;
        onyx_local_date      := local_instant::date;
        onyx_behavioral_date := (local_instant - INTERVAL '6 hours')::date;
    END IF;

    onyx_tz_source := resolved_source;
    RETURN QUERY SELECT
        onyx_et_date,
        onyx_behavioral_date,
        onyx_local_date,
        onyx_tz_source;
END;
$$;

COMMENT ON FUNCTION pds.derive_onyx_dates(TIMESTAMPTZ, TEXT, TEXT) IS
'Per ADR-0001 D1/D2/D3: derives the three onyx_* dates + provenance from a UTC instant. Triggers across source tables call this. Pass tz_offset_text from the source field when available (WHOOP timezone_offset); pass NULL to fall through to user_tz_log/ET. Behavioral day uses the -6h rule matching whoop_journal.behaviors_date.';

-- ---------------------------------------------------------------------------
-- 4. Sanity tests (use as smoke check after apply)
-- ---------------------------------------------------------------------------
-- Expected outputs documented inline.
--
-- (a) NY 11:55 PM ET bedtime (Riley home), no source offset:
--   SELECT * FROM pds.derive_onyx_dates(
--       '2026-05-24 03:55:00+00'::timestamptz,  -- = 23:55 EDT 2026-05-23
--       NULL, NULL
--   );
-- Expected: et_date 2026-05-23, behavioral 2026-05-23, local 2026-05-23,
--           tz_source 'default_et_fallback' (no user_tz_log row)
--
-- (b) NY 12:30 AM ET bedtime (awake tail):
--   SELECT * FROM pds.derive_onyx_dates(
--       '2026-05-24 04:30:00+00'::timestamptz,  -- = 00:30 EDT 2026-05-24
--       NULL, NULL
--   );
-- Expected: et_date 2026-05-24, behavioral 2026-05-23 (the -6h pushes back),
--           local 2026-05-24, tz_source 'default_et_fallback'
--
-- (c) Berlin 11 PM CEST bedtime, WHOOP-provided offset:
--   SELECT * FROM pds.derive_onyx_dates(
--       '2026-05-01 21:00:00+00'::timestamptz,  -- = 23:00 CEST 2026-05-01
--       '+02:00', 'source_field'
--   );
-- Expected: et_date 2026-05-01 (17:00 EDT same day), behavioral 2026-05-01,
--           local 2026-05-01, tz_source 'source_field'
