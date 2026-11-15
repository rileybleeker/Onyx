-- ============================================================
-- Onyx: UI preferences that follow Riley across devices (2026-11-14)
-- ============================================================
-- One row per key, a small JSON value. First key: "overview.cards" = the order and the hidden cards of the
-- overview under Today (lib/overview-cards.ts). The sidebar order can use the same table under its own key.
--
-- Access model (AGENTS.md, Database): owner-readable through owner_read; written only by
-- /api/ui/preferences (owner session, same-origin JSON, size-capped, never in isCiRoute()) with the service
-- role. Values are layout choices only, never health or finance data.
--
-- Additive and safe to re-run. Contains no statement that removes an object (the Supabase MCP connector
-- refuses migrations that do).
-- ============================================================

CREATE TABLE IF NOT EXISTS pds.ui_preferences (
    key        TEXT        PRIMARY KEY,
    value      JSONB       NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ui_preferences_key_format CHECK (key ~ '^[a-z][a-z0-9]*([._-][a-z0-9]+)*$' AND length(key) <= 64),
    CONSTRAINT ui_preferences_value_shape CHECK (jsonb_typeof(value) IN ('object', 'array')),
    CONSTRAINT ui_preferences_value_size CHECK (length(value::text) <= 8192)
);

ALTER TABLE pds.ui_preferences ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON pds.ui_preferences FROM anon, authenticated;
GRANT SELECT ON pds.ui_preferences TO authenticated;
GRANT SELECT, INSERT, UPDATE ON pds.ui_preferences TO service_role;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'pds' AND tablename = 'ui_preferences' AND policyname = 'owner_read'
    ) THEN
        CREATE POLICY owner_read ON pds.ui_preferences FOR SELECT TO authenticated
            USING ((SELECT auth.uid()) = 'dc041abc-115a-4252-8536-803f2ac75557'::uuid);
    END IF;
END $$;
