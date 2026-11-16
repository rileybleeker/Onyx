-- ============================================================
-- Onyx: direct drink capture OFF switch (reverses sql/direct_drink_capture.sql
-- without losing records). Prepared 2026-11-15 for review; NOT applied. Apply
-- only after sql/direct_drink_capture.sql, and only to stop drink capture.
-- ============================================================
-- What it does:
--   1. New drink rows are refused (OXD00): the drinks route answers 503 "Drink
--      capture is turned off" and the Log editor keeps the drink with that
--      error (nothing shows as Saved). Edits and Undo of existing drink rows
--      keep working (same trigger rules); photo meals are unchanged.
--   2. pds.caffeine_events returns to the deployed two-branch definition
--      (supplements + Cronometer, 2026-11-16 snapshot), so drinks leave Caffeine.
--   3. pds.direct_drink_daily keeps its columns but returns no rows, so drinks
--      leave Nutrition (getNutrition adds nothing; the view still exists, so no
--      read error).
-- What it keeps: every row of pds.photo_meals (photo and drink), the added
-- columns and constraints, all grants, pds.photo_meal_daily (photo rows only).
-- Turning capture back on: re-apply sql/direct_drink_capture.sql (idempotent);
-- stored drinks are counted again exactly as before.
-- Frontend note: the Log Drinks section and its device copy keep pending drinks;
-- with the switch on they stay unsaved with the 503 message.
-- Additive statements only (CREATE OR REPLACE); security_invoker restated.
-- ============================================================

CREATE OR REPLACE FUNCTION pds.photo_meals_set_eaten_at()
RETURNS TRIGGER AS $$
DECLARE
    tz TEXT;
    local_ts TIMESTAMP;
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.capture_kind IS DISTINCT FROM OLD.capture_kind THEN
        RAISE EXCEPTION 'a capture keeps its kind' USING ERRCODE = 'OXD02';
    END IF;

    IF NEW.capture_kind = 'drink' THEN
        IF TG_OP = 'INSERT' THEN
            RAISE EXCEPTION 'drink capture is turned off' USING ERRCODE = 'OXD00';
        END IF;
        IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
            RAISE EXCEPTION 'a removed drink stays removed' USING ERRCODE = 'OXD03';
        END IF;
        IF NEW.revision <> OLD.revision + 1 THEN
            RAISE EXCEPTION 'drink revision must advance by one' USING ERRCODE = 'OXD04';
        END IF;
        IF NEW.eaten_at IS NULL OR NEW.time_zone IS NULL THEN
            RAISE EXCEPTION 'a drink needs its instant and time zone' USING ERRCODE = 'OXD01';
        END IF;
        local_ts := NEW.eaten_at AT TIME ZONE NEW.time_zone;
        IF (local_ts - interval '6 hours')::date <> NEW.eaten_date
           OR date_trunc('minute', local_ts)::time <> date_trunc('minute', NEW.eaten_time::interval)::time THEN
            RAISE EXCEPTION 'drink day / clock do not match its instant' USING ERRCODE = 'OXD01';
        END IF;
        IF NEW.eaten_at > NOW() + interval '5 minutes' THEN
            RAISE EXCEPTION 'that time has not happened yet' USING ERRCODE = 'OXP01';
        END IF;
        NEW.updated_at := NOW();
        RETURN NEW;
    END IF;

    -- Photo meals: exactly the previous rule (sql/photo_meals.sql).
    tz := COALESCE(pds.tz_for_instant((NEW.eaten_date + time '12:00') AT TIME ZONE 'America/New_York'),
                   'America/New_York');
    NEW.eaten_at := ((NEW.eaten_date + CASE WHEN NEW.eaten_time < time '06:00' THEN 1 ELSE 0 END)
                     + NEW.eaten_time) AT TIME ZONE tz;
    IF NEW.eaten_at > NOW() + interval '5 minutes' THEN
        RAISE EXCEPTION 'that time has not happened yet' USING ERRCODE = 'OXP01';
    END IF;
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE VIEW pds.direct_drink_daily WITH (security_invoker = true) AS
SELECT eaten_date                                   AS behavioral_date,
       count(*)::int                                AS drink_count,
       sum(kcal)                                    AS kcal,
       sum(protein_g)                               AS protein_g,
       sum(carbs_g)                                 AS carbs_g,
       sum(fat_g)                                   AS fat_g,
       CASE WHEN count(sugar_g) = count(*) THEN sum(sugar_g) END     AS sugar_g,
       CASE WHEN count(sodium_mg) = count(*) THEN sum(sodium_mg) END AS sodium_mg,
       sum(caffeine_mg)                             AS caffeine_mg,
       min(eaten_at)                                AS first_drink_at,
       max(eaten_at)                                AS last_drink_at
  FROM pds.photo_meals
 WHERE false
 GROUP BY eaten_date;

-- The deployed definition (2026-11-16 snapshot), invoker security restated.
CREATE OR REPLACE VIEW pds.caffeine_events WITH (security_invoker = true) AS
 SELECT 'supplement'::text AS source,
    'supplement_intake:'::text || i.intake_id::text AS event_key,
    i.intake_date AS behavioral_date,
    i.intake_time AS event_time,
    sum(((ing.value ->> 'quantity'::text)::numeric) * i.doses *
        CASE lower(COALESCE(ing.value ->> 'unit'::text, 'mg'::text))
            WHEN 'g'::text THEN 1000::numeric
            WHEN 'mcg'::text THEN 0.001
            WHEN 'µg'::text THEN 0.001
            WHEN 'ug'::text THEN 0.001
            ELSE 1::numeric
        END) AS caffeine_mg,
    i.intake_time IS NOT NULL AND ((i.intake_time AT TIME ZONE pds.tz_for_instant(i.intake_time)) - '06:00:00'::interval)::date = i.intake_date AS time_trusted
   FROM pds.supplement_intake i
     JOIN pds.supplement_products p ON p.product_id = i.product_id
     CROSS JOIN LATERAL jsonb_array_elements(p.ingredients) ing(value)
  WHERE ((ing.value ->> 'unii_code'::text) = '3G6A5W338E'::text OR (ing.value ->> 'ingredient_group'::text) ~~* '%caffeine%'::text OR (ing.value ->> 'name'::text) ~~* '%caffeine%'::text) AND (ing.value ->> 'quantity'::text) ~ '^[0-9]+(\.[0-9]+)?$'::text
  GROUP BY i.intake_id, i.intake_date, i.intake_time
UNION ALL
 SELECT 'dietary'::text AS source,
    'cronometer_serving:'::text || s.serving_id::text AS event_key,
    COALESCE(s.onyx_behavioral_date, s.calendar_date) AS behavioral_date,
    s.event_time,
    s.caffeine_mg,
    s.event_time IS NOT NULL AND ((s.event_time AT TIME ZONE pds.tz_for_instant(s.event_time)) - '06:00:00'::interval)::date = COALESCE(s.onyx_behavioral_date, s.calendar_date) AS time_trusted
   FROM pds.cronometer_servings s
  WHERE s.caffeine_mg IS NOT NULL AND s.caffeine_mg > 0::numeric;
