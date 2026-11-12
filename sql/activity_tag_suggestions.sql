-- ---------------------------------------------------------------------------
-- pds.activity_tag_suggestions: cache of LLM-proposed strength tags.
--
-- WHY: WHOOP logs all lifting as one generic 'weightlifting_msk' and Garmin
--   records no strength type, so split_labels (leg|pull|push) and muscle_groups
--   (11 tags) on whoop_workouts / garmin_activities are filled by hand on
--   /activities. POST /api/activities/suggest-tags asks Claude to PROPOSE tags
--   for untagged strength rows from the session's name, duration, strain, HR,
--   HR-zone minutes, weekday and Riley's own recent tagged sessions. The page
--   shows the proposal as ghosted chips with Accept / Dismiss. Nothing here is
--   ever written to the activity rows by the server: Accept goes through the
--   existing POST /api/activities/categorize, which validates the arrays.
--
-- ROLE OF THIS TABLE: a cache and an audit trail, nothing more.
--   - one row per (source, activity_id): a row that already has a cache entry is
--     never sent to the model again, so a page reload costs nothing;
--   - dismissed = true means the suggestion was dismissed OR accepted. Either
--     way it is never shown again (otherwise clearing the tags of an accepted
--     session by hand would bring the old suggestion back);
--   - a dismiss for an activity with no cache row stores a tombstone (empty
--     arrays, dismissed = true) so it is not suggested later either.
--   source is 'garmin' | 'whoop'; activity_id is TEXT because whoop_workouts.
--   workout_id is a UUID string (garmin_activities.activity_id is a bigint,
--   stored here as its decimal text).
--   The tag arrays are not constrained by a CHECK here: the route strips
--   everything outside the canonical sets before it writes, and the real tags
--   only reach the activity tables through /api/activities/categorize, whose
--   own constraints (sql/activity_muscle_groups.sql) stay the gate.
--
-- ACCESS: service role only (the route runs with the service-role key behind the
--   normal session middleware). RLS is on and there is no policy for anon or
--   authenticated, and their grants are revoked, so neither can read or write it
--   (same model as the phone_usage_* tables).
--
-- Additive and idempotent. Apply with the Supabase MCP apply_migration
-- (migration name: activity_tag_suggestions).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pds.activity_tag_suggestions (
    source        TEXT        NOT NULL CHECK (source IN ('garmin', 'whoop')),
    activity_id   TEXT        NOT NULL,
    split_labels  TEXT[]      NOT NULL DEFAULT '{}',
    muscle_groups TEXT[]      NOT NULL DEFAULT '{}',
    confidence    TEXT        CHECK (confidence IN ('high', 'medium', 'low')),
    model         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    dismissed     BOOLEAN     NOT NULL DEFAULT FALSE,
    PRIMARY KEY (source, activity_id)
);

COMMENT ON TABLE pds.activity_tag_suggestions IS
    'LLM-proposed split_labels / muscle_groups for untagged strength rows (cache + audit). Never written to the activity tables by the server; Accept goes through /api/activities/categorize. dismissed = dismissed or accepted.';

ALTER TABLE pds.activity_tag_suggestions ENABLE ROW LEVEL SECURITY;

-- service_role bypasses RLS; the explicit policy documents the intent and keeps
-- the table service-only if that ever changes.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'pds'
          AND tablename = 'activity_tag_suggestions'
          AND policyname = 'service_full_access'
    ) THEN
        CREATE POLICY service_full_access ON pds.activity_tag_suggestions
            FOR ALL TO service_role USING (true) WITH CHECK (true);
    END IF;
END
$$;

REVOKE ALL ON pds.activity_tag_suggestions FROM anon, authenticated;
GRANT ALL ON pds.activity_tag_suggestions TO service_role;
