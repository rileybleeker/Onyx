-- Apartment reset (2026-11-17): one manageable cleanup action on Today, then optional light upkeep.
--
--   pds.home_reset_items     Riley's small editable plan: one row per cleanup action (area, action text,
--                            effort 2 / 5 / 10 minutes). status open | done; snoozed_until hides it; upkeep is
--                            NULL (not asked yet), 'none' (declined), 'weekly' or 'biweekly'; upkeep_paused stops
--                            prompts; next_due_on is when an upkeep action is due again (set from the DAY IT WAS
--                            DONE, never from the previous due date, so missed periods never pile up).
--   pds.home_reset_receipts  one row per tap (done / partly / snooze), keyed by a browser-made UUID: a retried tap
--                            is a no-op and answers with the stored result.
--   pds.home_reset_act()     applies one tap atomically (receipt + item change in one transaction).
--
-- Private home details. SERVICE ROLE ONLY: RLS on, no policies, nothing granted to anon / authenticated.
-- Never physically removed by the app. Additive only: creates two tables and one function, changes nothing else.

CREATE TABLE IF NOT EXISTS pds.home_reset_items (
    id              UUID PRIMARY KEY,                       -- picked by the browser (retry-safe create)
    area            TEXT NOT NULL CHECK (char_length(area) BETWEEN 1 AND 40),
    action          TEXT NOT NULL CHECK (char_length(action) BETWEEN 1 AND 120),
    minutes         INTEGER NOT NULL DEFAULT 5 CHECK (minutes IN (2, 5, 10)),
    remaining       TEXT CHECK (remaining IS NULL OR char_length(remaining) <= 120), -- what is left after "Partly done"
    status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
    snoozed_until   TIMESTAMPTZ,
    partial_count   INTEGER NOT NULL DEFAULT 0 CHECK (partial_count >= 0),
    upkeep          TEXT CHECK (upkeep IS NULL OR upkeep IN ('none', 'weekly', 'biweekly')),
    upkeep_paused   BOOLEAN NOT NULL DEFAULT false,
    next_due_on     DATE,                                   -- NULL = due now
    last_done_on    DATE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    removed_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS home_reset_items_live_idx ON pds.home_reset_items (created_at) WHERE removed_at IS NULL;

CREATE TABLE IF NOT EXISTS pds.home_reset_receipts (
    receipt_id   UUID PRIMARY KEY,
    item_id      UUID NOT NULL REFERENCES pds.home_reset_items (id),
    action       TEXT NOT NULL CHECK (action IN ('done', 'partly', 'snooze')),
    on_date      DATE NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS home_reset_receipts_item_idx ON pds.home_reset_receipts (item_id, created_at DESC);

ALTER TABLE pds.home_reset_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE pds.home_reset_receipts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON pds.home_reset_items, pds.home_reset_receipts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON pds.home_reset_items TO service_role;
GRANT SELECT, INSERT ON pds.home_reset_receipts TO service_role;

-- One tap, atomically. Returns 'applied' (new receipt), 'replayed' (this receipt id was already applied) or
-- 'missing' (no live item). p_remaining only matters for 'partly'; p_snooze_until only for 'snooze' (capped at 14 days).
CREATE OR REPLACE FUNCTION pds.home_reset_act(
    p_receipt UUID, p_item UUID, p_action TEXT, p_remaining TEXT DEFAULT NULL, p_snooze_until TIMESTAMPTZ DEFAULT NULL
) RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
    v_today DATE := (now() AT TIME ZONE 'America/New_York')::date;
    v_item  pds.home_reset_items%ROWTYPE;
    v_new   INTEGER;
BEGIN
    IF p_action NOT IN ('done', 'partly', 'snooze') THEN RAISE EXCEPTION 'bad action' USING ERRCODE = '22023'; END IF;
    SELECT * INTO v_item FROM pds.home_reset_items WHERE id = p_item AND removed_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RETURN 'missing'; END IF;
    INSERT INTO pds.home_reset_receipts (receipt_id, item_id, action, on_date)
        VALUES (p_receipt, p_item, p_action, v_today) ON CONFLICT (receipt_id) DO NOTHING;
    GET DIAGNOSTICS v_new = ROW_COUNT;
    IF v_new = 0 THEN RETURN 'replayed'; END IF;

    IF p_action = 'done' THEN
        UPDATE pds.home_reset_items SET
            last_done_on = v_today, remaining = NULL, partial_count = 0, snoozed_until = NULL, updated_at = now(),
            status = CASE WHEN upkeep IN ('weekly', 'biweekly') AND NOT upkeep_paused THEN 'open' ELSE 'done' END,
            next_due_on = CASE WHEN upkeep = 'weekly' AND NOT upkeep_paused THEN v_today + 7
                               WHEN upkeep = 'biweekly' AND NOT upkeep_paused THEN v_today + 14
                               ELSE NULL END
        WHERE id = p_item;
    ELSIF p_action = 'partly' THEN
        UPDATE pds.home_reset_items SET
            partial_count = partial_count + 1, remaining = left(NULLIF(btrim(p_remaining), ''), 120), updated_at = now()
        WHERE id = p_item;
    ELSE
        UPDATE pds.home_reset_items SET
            snoozed_until = LEAST(GREATEST(COALESCE(p_snooze_until, now() + interval '1 day'), now()), now() + interval '14 days'),
            updated_at = now()
        WHERE id = p_item;
    END IF;
    RETURN 'applied';
END;
$$;
REVOKE ALL ON FUNCTION pds.home_reset_act(UUID, UUID, TEXT, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pds.home_reset_act(UUID, UUID, TEXT, TEXT, TIMESTAMPTZ) TO service_role;
