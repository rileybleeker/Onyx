-- ============================================================
-- Onyx: direct drink capture (PROD-CAFF-01 bounded slice, prepared 2026-11-15)
-- ============================================================
-- Prepared for independent SQL / security review. NOT applied by the builder.
-- Additive only: ADD COLUMN IF NOT EXISTS, guarded ADD CONSTRAINT, CREATE INDEX
-- IF NOT EXISTS, CREATE OR REPLACE (function, views). Nothing for the anon role,
-- nothing removed, no dependent object touched. Turning it off: APPENDIX A at the
-- end (stops new drink rows and takes drinks out of both projections; keeps rows).
--
-- One said or tapped drink (Log > Say it / Drinks) = ONE row in pds.photo_meals
-- with capture_kind = 'drink'. Existing photo meals keep capture_kind = 'photo'
-- (the column default), so every existing row and the photo routes are unchanged.
-- Both projections read that one row:
--   pds.direct_drink_daily   kcal / macros / sugar / sodium / caffeine per
--                            behavioral day (Nutrition adds it to every day kind).
--   pds.caffeine_events      a third UNION branch, source 'dietary',
--                            event_key 'direct_capture:<meal_id>'.
-- A drink is never also written as a supplement intake.
--
-- Row state shared by both projections (one decision, never two heuristics):
--   deleted_at    tombstone (Undo / Remove). The row stays so a late retry with
--                 the same client_key cannot bring it back (trigger refuses to
--                 clear it). Counted nowhere.
--   diary_overlap 'in_diary' = Riley said this drink is already in Cronometer /
--                 a supplement / an order: kept for the record, counted nowhere.
--                 Independent of cronometer_servings.serving_id (that id is
--                 replaced on every re-import, sql/cronometer_replace_servings.sql).
--   revision      starts at 1; every drink UPDATE must set exactly old + 1 (the
--                 route sends expected_revision; a stale edit changes nothing).
--
-- Time (drink rows only; the photo branch of the trigger is unchanged):
--   eaten_at      the instant, supplied by the save route (a true "now" keeps
--                 the captured UTC instant; a typed clock time is converted in
--                 time_zone with DST gaps refused and repeated hours chosen).
--   time_zone     IANA zone of that clock. The trigger checks that eaten_date is
--                 the behavioral day ((local - 6 h)::date) and eaten_time the
--                 local HH:MM of eaten_at in time_zone; it never overwrites the
--                 instant with the noon-of-day zone rule. An unknown historical
--                 time is never saved (no sentinel): the Log editor asks for it.
--
-- Known limits, kept open on PROD-CAFF-01: no automatic link to later Cronometer
-- imports (a drink logged here and later also in Cronometer counts twice until
-- Riley marks it in_diary); unknown-time drinks are not storable; drinks reach
-- pds.daily_health_matrix_behavioral_mat (caffeine x HRV) at its next refresh.
-- ============================================================

-- ── Columns (NULL for photo rows) ─────────────────────────────
ALTER TABLE pds.photo_meals
    ADD COLUMN IF NOT EXISTS capture_kind          TEXT        NOT NULL DEFAULT 'photo',
    ADD COLUMN IF NOT EXISTS revision              INTEGER     NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS deleted_at            TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS diary_overlap         TEXT        NOT NULL DEFAULT 'none',
    ADD COLUMN IF NOT EXISTS time_zone             TEXT,
    ADD COLUMN IF NOT EXISTS drink_product_id      TEXT,
    ADD COLUMN IF NOT EXISTS drink_product_version INTEGER,
    ADD COLUMN IF NOT EXISTS drink_servings        NUMERIC,
    ADD COLUMN IF NOT EXISTS drink_label           JSONB,
    ADD COLUMN IF NOT EXISTS caffeine_mg           NUMERIC,
    ADD COLUMN IF NOT EXISTS sugar_g               NUMERIC,
    ADD COLUMN IF NOT EXISTS sodium_mg             NUMERIC;

COMMENT ON COLUMN pds.photo_meals.capture_kind IS
    'photo = meal from a plate photo (photo routes only); drink = direct drink capture (/api/nutrition/drinks only). Never changes after insert.';
COMMENT ON COLUMN pds.photo_meals.drink_label IS
    'Drink rows: frozen per-container label snapshot {product_id, version, name, label{kcal, protein_g, carbs_g, fat_g, sugar_g, sodium_mg, caffeine_mg, serving, serving_fl_oz}, source{page, label_image, read_on}} from frontend/src/lib/drink-products.ts at capture time.';
COMMENT ON COLUMN pds.photo_meals.diary_overlap IS
    'Drink rows: none = counted; in_diary = Riley said it is already logged in Cronometer / supplements / an order, so neither Nutrition nor Caffeine counts it.';
COMMENT ON COLUMN pds.photo_meals.deleted_at IS
    'Drink rows: tombstone set by Undo / Remove. Counted nowhere; never cleared (a late retry cannot resurrect it).';

-- ── Constraints (guarded: no IF NOT EXISTS for constraints) ───
DO $constraints$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'pds.photo_meals'::regclass AND conname = 'photo_meals_capture_kind_check') THEN
        ALTER TABLE pds.photo_meals ADD CONSTRAINT photo_meals_capture_kind_check
            CHECK (capture_kind IN ('photo', 'drink'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'pds.photo_meals'::regclass AND conname = 'photo_meals_diary_overlap_check') THEN
        ALTER TABLE pds.photo_meals ADD CONSTRAINT photo_meals_diary_overlap_check
            CHECK (diary_overlap IN ('none', 'in_diary'));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'pds.photo_meals'::regclass AND conname = 'photo_meals_revision_check') THEN
        ALTER TABLE pds.photo_meals ADD CONSTRAINT photo_meals_revision_check CHECK (revision >= 1);
    END IF;
    -- Photo rows carry none of the drink fields; drink rows carry all of them.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'pds.photo_meals'::regclass AND conname = 'photo_meals_kind_fields_check') THEN
        ALTER TABLE pds.photo_meals ADD CONSTRAINT photo_meals_kind_fields_check CHECK (
            (capture_kind = 'photo'
             AND drink_product_id IS NULL AND drink_product_version IS NULL AND drink_servings IS NULL
             AND drink_label IS NULL AND caffeine_mg IS NULL AND deleted_at IS NULL
             AND diary_overlap = 'none')
            OR
            (capture_kind = 'drink'
             AND drink_product_id IS NOT NULL AND drink_product_version >= 1
             AND drink_servings > 0 AND drink_servings <= 6
             AND jsonb_typeof(drink_label) = 'object'
             AND caffeine_mg IS NOT NULL AND caffeine_mg >= 0 AND caffeine_mg <= 2000
             AND (sugar_g IS NULL OR sugar_g >= 0) AND (sodium_mg IS NULL OR sodium_mg >= 0)
             AND time_zone IS NOT NULL AND eaten_at IS NOT NULL
             AND time_source IN ('now', 'manual')
             AND est_kcal IS NULL AND model IS NULL)
        );
    END IF;
END
$constraints$;

CREATE INDEX IF NOT EXISTS idx_photo_meals_drink_date
    ON pds.photo_meals (eaten_date) WHERE capture_kind = 'drink';

-- ── Trigger: photo branch unchanged, drink branch validates ──
-- Error codes: OXP01 future (as before), OXD00 drink capture turned off (only
-- set by the off switch), OXD01 inconsistent drink time, OXD02 kind change,
-- OXD03 tombstone cleared, OXD04 revision not old + 1.
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
        IF TG_OP = 'UPDATE' THEN
            IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
                RAISE EXCEPTION 'a removed drink stays removed' USING ERRCODE = 'OXD03';
            END IF;
            IF NEW.revision <> OLD.revision + 1 THEN
                RAISE EXCEPTION 'drink revision must advance by one' USING ERRCODE = 'OXD04';
            END IF;
        ELSIF NEW.revision <> 1 THEN
            RAISE EXCEPTION 'a new drink starts at revision 1' USING ERRCODE = 'OXD04';
        END IF;
        IF NEW.eaten_at IS NULL OR NEW.time_zone IS NULL THEN
            RAISE EXCEPTION 'a drink needs its instant and time zone' USING ERRCODE = 'OXD01';
        END IF;
        -- An unknown zone name raises here (22023), so nothing is stored for it.
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
-- (The trigger itself, photo_meals_set_eaten_at BEFORE INSERT OR UPDATE, already
-- exists and calls this function; it is not re-created.)

-- ── Photo projection: photo rows only (same columns, same order) ──
CREATE OR REPLACE VIEW pds.photo_meal_daily WITH (security_invoker = true) AS
SELECT eaten_date              AS behavioral_date,
       count(*)::int           AS meal_count,
       sum(kcal)               AS est_kcal,
       sum(protein_g)          AS est_protein_g,
       sum(carbs_g)            AS est_carbs_g,
       sum(fat_g)              AS est_fat_g,
       min(eaten_at)           AS first_meal_at,
       max(eaten_at)           AS last_meal_at
  FROM pds.photo_meals
 WHERE capture_kind = 'photo'
 GROUP BY eaten_date;

-- ── Drink projection (Nutrition) ──────────────────────────────
-- Sugar / sodium: a day total only when every counted drink has the value
-- (an unknown stays unknown, never a silent 0).
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
 WHERE capture_kind = 'drink'
   AND deleted_at IS NULL
   AND diary_overlap = 'none'
 GROUP BY eaten_date;

COMMENT ON VIEW pds.direct_drink_daily IS
    'Direct drink captures per behavioral day (pds.photo_meals capture_kind = drink, not removed, not marked in_diary). Added to every Nutrition day by getNutrition; the same rows feed pds.caffeine_events.';

REVOKE ALL ON pds.direct_drink_daily FROM PUBLIC;
REVOKE ALL ON pds.direct_drink_daily FROM anon;
GRANT SELECT ON pds.direct_drink_daily TO authenticated, service_role;

-- ── Caffeine events: live definition (2026-11-16 snapshot) + drinks ──
-- The first two branches are the deployed definition unchanged. Column names,
-- types and order are unchanged, so pds.caffeine_timing_daily,
-- pds.caffeine_data_quality and the behavioral matrix keep compiling.
-- security_invoker is restated: CREATE OR REPLACE resets view options.
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
  WHERE s.caffeine_mg IS NOT NULL AND s.caffeine_mg > 0::numeric
UNION ALL
 SELECT 'dietary'::text AS source,
    'direct_capture:'::text || m.meal_id::text AS event_key,
    m.eaten_date AS behavioral_date,
    m.eaten_at AS event_time,
    m.caffeine_mg,
    m.eaten_at IS NOT NULL AND ((m.eaten_at AT TIME ZONE pds.tz_for_instant(m.eaten_at)) - '06:00:00'::interval)::date = m.eaten_date AS time_trusted
   FROM pds.photo_meals m
  WHERE m.capture_kind = 'drink'::text AND m.deleted_at IS NULL AND m.diary_overlap = 'none'::text
    AND m.caffeine_mg IS NOT NULL AND m.caffeine_mg > 0::numeric;

-- Existing grants on pds.caffeine_events (authenticated SELECT, service_role) are
-- kept by CREATE OR REPLACE; nothing is granted to anon.

-- ============================================================
-- APPENDIX A (commented out, NOT part of the migration): OFF SWITCH.
-- Run separately only to stop drink capture without losing records:
-- new drink INSERTs are refused (OXD00 -> route 503 "turned off"), edits and
-- Undo of existing drinks keep working, drinks leave both projections, every
-- row / column / grant stays. Re-running this file turns it back on.
-- (Kept here because the builder could only write this one SQL file; move it
-- to its own file during review.)
-- ============================================================
-- CREATE OR REPLACE FUNCTION pds.photo_meals_set_eaten_at()
-- RETURNS TRIGGER AS $$
-- DECLARE
--     tz TEXT;
--     local_ts TIMESTAMP;
-- BEGIN
--     IF TG_OP = 'UPDATE' AND NEW.capture_kind IS DISTINCT FROM OLD.capture_kind THEN
--         RAISE EXCEPTION 'a capture keeps its kind' USING ERRCODE = 'OXD02';
--     END IF;
--     IF NEW.capture_kind = 'drink' THEN
--         IF TG_OP = 'INSERT' THEN
--             RAISE EXCEPTION 'drink capture is turned off' USING ERRCODE = 'OXD00';
--         END IF;
--         IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
--             RAISE EXCEPTION 'a removed drink stays removed' USING ERRCODE = 'OXD03';
--         END IF;
--         IF NEW.revision <> OLD.revision + 1 THEN
--             RAISE EXCEPTION 'drink revision must advance by one' USING ERRCODE = 'OXD04';
--         END IF;
--         IF NEW.eaten_at IS NULL OR NEW.time_zone IS NULL THEN
--             RAISE EXCEPTION 'a drink needs its instant and time zone' USING ERRCODE = 'OXD01';
--         END IF;
--         local_ts := NEW.eaten_at AT TIME ZONE NEW.time_zone;
--         IF (local_ts - interval '6 hours')::date <> NEW.eaten_date
--            OR date_trunc('minute', local_ts)::time <> date_trunc('minute', NEW.eaten_time::interval)::time THEN
--             RAISE EXCEPTION 'drink day / clock do not match its instant' USING ERRCODE = 'OXD01';
--         END IF;
--         IF NEW.eaten_at > NOW() + interval '5 minutes' THEN
--             RAISE EXCEPTION 'that time has not happened yet' USING ERRCODE = 'OXP01';
--         END IF;
--         NEW.updated_at := NOW();
--         RETURN NEW;
--     END IF;
--     tz := COALESCE(pds.tz_for_instant((NEW.eaten_date + time '12:00') AT TIME ZONE 'America/New_York'),
--                    'America/New_York');
--     NEW.eaten_at := ((NEW.eaten_date + CASE WHEN NEW.eaten_time < time '06:00' THEN 1 ELSE 0 END)
--                      + NEW.eaten_time) AT TIME ZONE tz;
--     IF NEW.eaten_at > NOW() + interval '5 minutes' THEN
--         RAISE EXCEPTION 'that time has not happened yet' USING ERRCODE = 'OXP01';
--     END IF;
--     NEW.updated_at := NOW();
--     RETURN NEW;
-- END;
-- $$ LANGUAGE plpgsql;
--
-- CREATE OR REPLACE VIEW pds.direct_drink_daily WITH (security_invoker = true) AS
-- SELECT eaten_date AS behavioral_date, count(*)::int AS drink_count,
--        sum(kcal) AS kcal, sum(protein_g) AS protein_g, sum(carbs_g) AS carbs_g, sum(fat_g) AS fat_g,
--        CASE WHEN count(sugar_g) = count(*) THEN sum(sugar_g) END AS sugar_g,
--        CASE WHEN count(sodium_mg) = count(*) THEN sum(sodium_mg) END AS sodium_mg,
--        sum(caffeine_mg) AS caffeine_mg, min(eaten_at) AS first_drink_at, max(eaten_at) AS last_drink_at
--   FROM pds.photo_meals
--  WHERE false
--  GROUP BY eaten_date;
--
-- -- pds.caffeine_events: re-create with ONLY the first two branches of the
-- -- definition above (supplement + cronometer_serving, the deployed 2026-11-16
-- -- snapshot), keeping WITH (security_invoker = true).

-- ============================================================
-- APPENDIX B (commented out, NOT part of the migration): POST-APPLY CHECK.
-- Run after review + application with privileged SQL access. One transaction
-- ending in ROLLBACK: the synthetic rows (far-past day 2001-01-03, fixed
-- synthetic keys) never persist; no real record changes.
-- ============================================================
-- BEGIN;
-- SET LOCAL statement_timeout = '45s';
-- DO $check$
-- DECLARE
--     owner_id uuid; initial_role text := current_user; d constant date := '2001-01-03';
--     a_id bigint; b_id bigint; c_id bigint; n integer; total numeric; kcal_total numeric;
--     photo_before bigint; photo_after bigint; leaked boolean;
-- BEGIN
--     -- 0. Shape: invoker views, no anon access, deployed column order.
--     IF has_schema_privilege('anon', 'pds', 'USAGE') THEN RAISE EXCEPTION 'anon has pds usage'; END IF;
--     IF EXISTS (SELECT 1 FROM unnest(ARRAY['pds.direct_drink_daily','pds.caffeine_events','pds.photo_meal_daily']) v
--                WHERE NOT EXISTS (SELECT 1 FROM pg_class c, pg_options_to_table(c.reloptions) o
--                                  WHERE c.oid = v::regclass AND o.option_name = 'security_invoker' AND o.option_value::boolean)) THEN
--         RAISE EXCEPTION 'a projection lost security_invoker';
--     END IF;
--     IF has_table_privilege('anon', 'pds.direct_drink_daily', 'SELECT') OR has_table_privilege('anon', 'pds.caffeine_events', 'SELECT') THEN
--         RAISE EXCEPTION 'anon can read a drink projection';
--     END IF;
--     IF (SELECT string_agg(attname, ',' ORDER BY attnum) FROM pg_attribute
--         WHERE attrelid = 'pds.caffeine_events'::regclass AND attnum > 0)
--        <> 'source,event_key,behavioral_date,event_time,caffeine_mg,time_trusted' THEN
--         RAISE EXCEPTION 'caffeine_events column order changed';
--     END IF;
--     IF (SELECT string_agg(attname, ',' ORDER BY attnum) FROM pg_attribute
--         WHERE attrelid = 'pds.photo_meal_daily'::regclass AND attnum > 0)
--        <> 'behavioral_date,meal_count,est_kcal,est_protein_g,est_carbs_g,est_fat_g,first_meal_at,last_meal_at' THEN
--         RAISE EXCEPTION 'photo_meal_daily column order changed';
--     END IF;
--     SELECT count(*) INTO photo_before FROM pds.photo_meals WHERE capture_kind = 'photo';
--
--     -- 1. One drink = one caffeine event + one Nutrition contribution, not a photo meal.
--     INSERT INTO pds.photo_meals (client_key, capture_kind, eaten_date, eaten_time, eaten_at, time_zone, time_source,
--         items, kcal, protein_g, carbs_g, fat_g, sugar_g, sodium_mg, caffeine_mg,
--         drink_product_id, drink_product_version, drink_servings, drink_label)
--     VALUES ('00000000-0000-4000-8000-00000000d001', 'drink', d, '14:05', timestamptz '2001-01-03 14:05:00-05', 'America/New_York', 'manual',
--         '[{"name":"synthetic","portion":"1 can","kcal":5,"protein_g":0,"carbs_g":1,"fat_g":0}]', 5, 0, 1, 0, 0, 25, 200,
--         'synthetic', 1, 1, '{"product_id":"synthetic","version":1,"name":"synthetic","label":{}}')
--     RETURNING meal_id INTO a_id;
--     SELECT count(*) INTO n FROM pds.caffeine_events WHERE event_key = 'direct_capture:' || a_id;
--     IF n <> 1 THEN RAISE EXCEPTION 'expected one caffeine event, got %', n; END IF;
--     SELECT total_caffeine_mg INTO total FROM pds.caffeine_timing_daily WHERE calendar_date = d;
--     IF total IS DISTINCT FROM 200 THEN RAISE EXCEPTION 'caffeine total %', total; END IF;
--     SELECT kcal INTO kcal_total FROM pds.direct_drink_daily WHERE behavioral_date = d;
--     IF kcal_total IS DISTINCT FROM 5 THEN RAISE EXCEPTION 'drink kcal %', kcal_total; END IF;
--     IF EXISTS (SELECT 1 FROM pds.photo_meal_daily WHERE behavioral_date = d) THEN RAISE EXCEPTION 'drink in photo projection'; END IF;
--
--     -- 2. A second can adds; a zero-kcal drink still counts caffeine; unknown sugar stays NULL.
--     INSERT INTO pds.photo_meals (client_key, capture_kind, eaten_date, eaten_time, eaten_at, time_zone, time_source,
--         items, kcal, protein_g, carbs_g, fat_g, caffeine_mg, drink_product_id, drink_product_version, drink_servings, drink_label)
--     VALUES ('00000000-0000-4000-8000-00000000d002', 'drink', d, '16:00', timestamptz '2001-01-03 16:00:00-05', 'America/New_York', 'manual',
--         '[{"name":"zero","portion":"1 can","kcal":0,"protein_g":0,"carbs_g":0,"fat_g":0}]', 0, 0, 0, 0, 100,
--         'synthetic-zero', 1, 1, '{"product_id":"synthetic-zero","version":1,"name":"zero","label":{}}')
--     RETURNING meal_id INTO b_id;
--     SELECT total_caffeine_mg INTO total FROM pds.caffeine_timing_daily WHERE calendar_date = d;
--     IF total IS DISTINCT FROM 300 THEN RAISE EXCEPTION 'two drinks: caffeine %', total; END IF;
--     IF (SELECT drink_count FROM pds.direct_drink_daily WHERE behavioral_date = d) <> 2 THEN RAISE EXCEPTION 'two drinks: count'; END IF;
--     IF (SELECT sugar_g FROM pds.direct_drink_daily WHERE behavioral_date = d) IS NOT NULL THEN RAISE EXCEPTION 'unknown sugar summed as 0'; END IF;
--
--     -- 3. in_diary and the tombstone leave BOTH projections.
--     UPDATE pds.photo_meals SET diary_overlap = 'in_diary', revision = revision + 1 WHERE meal_id = b_id;
--     SELECT total_caffeine_mg INTO total FROM pds.caffeine_timing_daily WHERE calendar_date = d;
--     IF total IS DISTINCT FROM 200 THEN RAISE EXCEPTION 'in_diary counted in caffeine'; END IF;
--     IF (SELECT drink_count FROM pds.direct_drink_daily WHERE behavioral_date = d) <> 1 THEN RAISE EXCEPTION 'in_diary counted in nutrition'; END IF;
--     UPDATE pds.photo_meals SET deleted_at = now(), revision = revision + 1 WHERE meal_id = a_id;
--     IF EXISTS (SELECT 1 FROM pds.caffeine_timing_daily WHERE calendar_date = d) THEN RAISE EXCEPTION 'tombstone in caffeine'; END IF;
--     IF EXISTS (SELECT 1 FROM pds.direct_drink_daily WHERE behavioral_date = d) THEN RAISE EXCEPTION 'tombstone in nutrition'; END IF;
--
--     -- 4. Trigger guards.
--     BEGIN UPDATE pds.photo_meals SET deleted_at = NULL, revision = revision + 1 WHERE meal_id = a_id;
--           RAISE EXCEPTION 'resurrection allowed'; EXCEPTION WHEN SQLSTATE 'OXD03' THEN NULL; END;
--     BEGIN UPDATE pds.photo_meals SET drink_servings = 2 WHERE meal_id = b_id;
--           RAISE EXCEPTION 'edit without new revision allowed'; EXCEPTION WHEN SQLSTATE 'OXD04' THEN NULL; END;
--     BEGIN UPDATE pds.photo_meals SET capture_kind = 'photo', revision = revision + 1 WHERE meal_id = b_id;
--           RAISE EXCEPTION 'kind change allowed'; EXCEPTION WHEN SQLSTATE 'OXD02' THEN NULL; END;
--     BEGIN INSERT INTO pds.photo_meals (client_key, capture_kind, eaten_date, eaten_time, eaten_at, time_zone, time_source,
--               items, kcal, protein_g, carbs_g, fat_g, caffeine_mg, drink_product_id, drink_product_version, drink_servings, drink_label)
--           VALUES ('00000000-0000-4000-8000-00000000d003', 'drink', d, '12:00', timestamptz '2001-01-03 14:05:00-05', 'America/New_York', 'manual',
--               '[{"name":"x","portion":null,"kcal":0,"protein_g":0,"carbs_g":0,"fat_g":0}]', 0, 0, 0, 0, 1, 'x', 1, 1, '{}');
--           RAISE EXCEPTION 'mismatched clock allowed'; EXCEPTION WHEN SQLSTATE 'OXD01' THEN NULL; END;
--     BEGIN INSERT INTO pds.photo_meals (client_key, eaten_date, eaten_time, time_source, items, kcal, protein_g, carbs_g, fat_g, caffeine_mg)
--           VALUES ('00000000-0000-4000-8000-00000000d005', d, '12:00', 'manual',
--               '[{"name":"x","portion":null,"kcal":0,"protein_g":0,"carbs_g":0,"fat_g":0}]', 0, 0, 0, 0, 50);
--           RAISE EXCEPTION 'photo row with caffeine allowed'; EXCEPTION WHEN check_violation THEN NULL; END;
--
--     -- 5. Existing photo meals untouched.
--     SELECT count(*) INTO photo_after FROM pds.photo_meals WHERE capture_kind = 'photo';
--     IF photo_after <> photo_before THEN RAISE EXCEPTION 'photo rows changed'; END IF;
--
--     -- 6. Access: owner reads; another identity and no identity read nothing; authenticated cannot write.
--     INSERT INTO pds.photo_meals (client_key, capture_kind, eaten_date, eaten_time, eaten_at, time_zone, time_source,
--         items, kcal, protein_g, carbs_g, fat_g, caffeine_mg, drink_product_id, drink_product_version, drink_servings, drink_label)
--     VALUES ('00000000-0000-4000-8000-00000000d006', 'drink', d, '18:00', timestamptz '2001-01-03 18:00:00-05', 'America/New_York', 'manual',
--         '[{"name":"x","portion":null,"kcal":5,"protein_g":0,"carbs_g":1,"fat_g":0}]', 5, 0, 1, 0, 200, 'x', 1, 1, '{}')
--     RETURNING meal_id INTO c_id;
--     SELECT substring(qual from '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')::uuid
--       INTO owner_id FROM pg_policies WHERE schemaname = 'pds' AND tablename = 'photo_meals' AND policyname = 'owner_read';
--     PERFORM set_config('request.jwt.claim.sub', owner_id::text, true);
--     PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', owner_id, 'role', 'authenticated')::text, true);
--     EXECUTE 'SET LOCAL ROLE authenticated';
--     IF NOT EXISTS (SELECT 1 FROM pds.caffeine_events WHERE event_key = 'direct_capture:' || c_id) THEN RAISE EXCEPTION 'owner cannot read'; END IF;
--     PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
--     PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
--     SELECT exists(SELECT 1 FROM pds.photo_meals WHERE meal_id = c_id)
--         OR exists(SELECT 1 FROM pds.direct_drink_daily WHERE behavioral_date = d)
--         OR exists(SELECT 1 FROM pds.caffeine_events WHERE event_key = 'direct_capture:' || c_id) INTO leaked;
--     IF leaked THEN RAISE EXCEPTION 'non-owner can read drink rows'; END IF;
--     PERFORM set_config('request.jwt.claim.sub', '', true);
--     PERFORM set_config('request.jwt.claims', '{}', true);
--     IF exists(SELECT 1 FROM pds.photo_meals WHERE meal_id = c_id) THEN RAISE EXCEPTION 'no-identity read'; END IF;
--     BEGIN INSERT INTO pds.photo_meals (client_key, eaten_date, eaten_time, time_source, items, kcal, protein_g, carbs_g, fat_g)
--           VALUES ('00000000-0000-4000-8000-00000000d007', d, '12:00', 'manual', '[{"name":"x","portion":null,"kcal":0,"protein_g":0,"carbs_g":0,"fat_g":0}]', 0, 0, 0, 0);
--           RAISE EXCEPTION 'authenticated could write'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
--     EXECUTE format('SET LOCAL ROLE %I', initial_role);
--     PERFORM set_config('onyx.direct_drink_verification', '{"passed":true}', true);
-- END
-- $check$;
-- SELECT current_setting('onyx.direct_drink_verification')::jsonb AS verification;
-- ROLLBACK;
