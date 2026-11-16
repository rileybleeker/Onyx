-- Post-apply check for sql/direct_drink_capture.sql. Run only AFTER independent review
-- and application, with privileged SQL access, under supervision. Everything happens in
-- ONE transaction that ends in ROLLBACK: the synthetic rows below never persist and no
-- real record changes. Synthetic far-past behavioral day 2001-01-03 (no real caffeine or
-- nutrition rows) and fixed synthetic client keys. Not run by the builder.
BEGIN;
SET LOCAL statement_timeout = '45s';
DO $check$
DECLARE
    owner_id uuid;
    initial_role text := current_user;
    d constant date := '2001-01-03';
    lbl constant jsonb := '{"product_id":"synthetic-drink","version":1,"name":"synthetic drink","label":{"kcal":5,"caffeine_mg":200}}';
    item constant jsonb := '[{"name":"synthetic drink","portion":"1 can","kcal":5,"protein_g":0,"carbs_g":1,"fat_g":0}]';
    a_id bigint;
    b_id bigint;
    c_id bigint;
    n integer;
    total numeric;
    kcal_total numeric;
    photo_before bigint;
    photo_after bigint;
    leaked boolean;
BEGIN
    -- 0. Shape: invoker views, no anonymous access, deployed column order.
    IF has_schema_privilege('anon', 'pds', 'USAGE') THEN RAISE EXCEPTION 'anon has pds usage'; END IF;
    IF EXISTS (SELECT 1 FROM unnest(ARRAY['pds.direct_drink_daily','pds.caffeine_events','pds.photo_meal_daily']) v
               WHERE NOT EXISTS (SELECT 1 FROM pg_class c, pg_options_to_table(c.reloptions) o
                                 WHERE c.oid = v::regclass AND o.option_name = 'security_invoker' AND o.option_value::boolean)) THEN
        RAISE EXCEPTION 'a projection lost security_invoker';
    END IF;
    IF has_table_privilege('anon', 'pds.direct_drink_daily', 'SELECT') OR has_table_privilege('anon', 'pds.caffeine_events', 'SELECT') THEN
        RAISE EXCEPTION 'anon can read a drink projection';
    END IF;
    IF (SELECT string_agg(attname, ',' ORDER BY attnum) FROM pg_attribute
        WHERE attrelid = 'pds.caffeine_events'::regclass AND attnum > 0)
       <> 'source,event_key,behavioral_date,event_time,caffeine_mg,time_trusted' THEN
        RAISE EXCEPTION 'caffeine_events column order changed';
    END IF;
    IF (SELECT string_agg(attname, ',' ORDER BY attnum) FROM pg_attribute
        WHERE attrelid = 'pds.photo_meal_daily'::regclass AND attnum > 0)
       <> 'behavioral_date,meal_count,est_kcal,est_protein_g,est_carbs_g,est_fat_g,first_meal_at,last_meal_at' THEN
        RAISE EXCEPTION 'photo_meal_daily column order changed';
    END IF;
    IF EXISTS (SELECT 1 FROM pds.photo_meals WHERE eaten_date = d) THEN RAISE EXCEPTION 'synthetic day is not empty'; END IF;
    SELECT count(*) INTO photo_before FROM pds.photo_meals WHERE capture_kind = 'photo';

    -- 1. One drink = one caffeine event + one Nutrition contribution, not a photo meal.
    INSERT INTO pds.photo_meals (client_key, capture_kind, eaten_date, eaten_time, eaten_at, time_zone, time_source,
        items, kcal, protein_g, carbs_g, fat_g, sugar_g, sodium_mg, caffeine_mg,
        drink_product_id, drink_product_version, drink_servings, drink_label)
    VALUES ('00000000-0000-4000-8000-00000000d001', 'drink', d, '14:05', timestamptz '2001-01-03 14:05:00-05', 'America/New_York', 'manual',
        item, 5, 0, 1, 0, 0, 25, 200, 'synthetic-drink', 1, 1, lbl)
    RETURNING meal_id INTO a_id;
    SELECT count(*) INTO n FROM pds.caffeine_events WHERE event_key = 'direct_capture:' || a_id;
    IF n <> 1 THEN RAISE EXCEPTION 'expected one caffeine event, got %', n; END IF;
    IF (SELECT source FROM pds.caffeine_events WHERE event_key = 'direct_capture:' || a_id) <> 'dietary' THEN RAISE EXCEPTION 'drink not dietary'; END IF;
    SELECT total_caffeine_mg INTO total FROM pds.caffeine_timing_daily WHERE calendar_date = d;
    IF total IS DISTINCT FROM 200 THEN RAISE EXCEPTION 'caffeine total %', total; END IF;
    SELECT kcal INTO kcal_total FROM pds.direct_drink_daily WHERE behavioral_date = d;
    IF kcal_total IS DISTINCT FROM 5 THEN RAISE EXCEPTION 'drink kcal %', kcal_total; END IF;
    IF EXISTS (SELECT 1 FROM pds.photo_meal_daily WHERE behavioral_date = d) THEN RAISE EXCEPTION 'drink in photo projection'; END IF;

    -- 2. A second can adds; a zero-kcal drink still counts caffeine; unknown sugar stays NULL.
    INSERT INTO pds.photo_meals (client_key, capture_kind, eaten_date, eaten_time, eaten_at, time_zone, time_source,
        items, kcal, protein_g, carbs_g, fat_g, caffeine_mg, drink_product_id, drink_product_version, drink_servings, drink_label)
    VALUES ('00000000-0000-4000-8000-00000000d002', 'drink', d, '16:00', timestamptz '2001-01-03 16:00:00-05', 'America/New_York', 'manual',
        '[{"name":"zero","portion":"1 can","kcal":0,"protein_g":0,"carbs_g":0,"fat_g":0}]', 0, 0, 0, 0, 100,
        'synthetic-zero', 1, 1, '{"product_id":"synthetic-zero","version":1,"name":"zero","label":{}}')
    RETURNING meal_id INTO b_id;
    SELECT total_caffeine_mg INTO total FROM pds.caffeine_timing_daily WHERE calendar_date = d;
    IF total IS DISTINCT FROM 300 THEN RAISE EXCEPTION 'two drinks: caffeine %', total; END IF;
    IF (SELECT drink_count FROM pds.direct_drink_daily WHERE behavioral_date = d) <> 2 THEN RAISE EXCEPTION 'two drinks: count'; END IF;
    IF (SELECT sugar_g FROM pds.direct_drink_daily WHERE behavioral_date = d) IS NOT NULL THEN RAISE EXCEPTION 'unknown sugar summed as 0'; END IF;

    -- 3. in_diary and the tombstone leave BOTH projections.
    UPDATE pds.photo_meals SET diary_overlap = 'in_diary', revision = revision + 1 WHERE meal_id = b_id;
    SELECT total_caffeine_mg INTO total FROM pds.caffeine_timing_daily WHERE calendar_date = d;
    IF total IS DISTINCT FROM 200 THEN RAISE EXCEPTION 'in_diary counted in caffeine'; END IF;
    IF (SELECT drink_count FROM pds.direct_drink_daily WHERE behavioral_date = d) <> 1 THEN RAISE EXCEPTION 'in_diary counted in nutrition'; END IF;
    UPDATE pds.photo_meals SET deleted_at = now(), revision = revision + 1 WHERE meal_id = a_id;
    IF EXISTS (SELECT 1 FROM pds.caffeine_timing_daily WHERE calendar_date = d) THEN RAISE EXCEPTION 'tombstone in caffeine'; END IF;
    IF EXISTS (SELECT 1 FROM pds.direct_drink_daily WHERE behavioral_date = d) THEN RAISE EXCEPTION 'tombstone in nutrition'; END IF;

    -- 4. Trigger guards.
    BEGIN UPDATE pds.photo_meals SET deleted_at = NULL, revision = revision + 1 WHERE meal_id = a_id;
          RAISE EXCEPTION 'resurrection allowed'; EXCEPTION WHEN SQLSTATE 'OXD03' THEN NULL; END;
    BEGIN UPDATE pds.photo_meals SET drink_servings = 2 WHERE meal_id = b_id;
          RAISE EXCEPTION 'edit without new revision allowed'; EXCEPTION WHEN SQLSTATE 'OXD04' THEN NULL; END;
    BEGIN UPDATE pds.photo_meals SET capture_kind = 'photo', revision = revision + 1 WHERE meal_id = b_id;
          RAISE EXCEPTION 'kind change allowed'; EXCEPTION WHEN SQLSTATE 'OXD02' THEN NULL; END;
    BEGIN INSERT INTO pds.photo_meals (client_key, capture_kind, eaten_date, eaten_time, eaten_at, time_zone, time_source,
              items, kcal, protein_g, carbs_g, fat_g, caffeine_mg, drink_product_id, drink_product_version, drink_servings, drink_label)
          VALUES ('00000000-0000-4000-8000-00000000d003', 'drink', d, '12:00', timestamptz '2001-01-03 14:05:00-05', 'America/New_York', 'manual',
              item, 5, 0, 1, 0, 200, 'synthetic-drink', 1, 1, lbl);
          RAISE EXCEPTION 'mismatched clock allowed'; EXCEPTION WHEN SQLSTATE 'OXD01' THEN NULL; END;

    -- 5. Constraints: NULL required drink fields, a non-quarter amount, NaN, and drink fields on a photo row fail.
    BEGIN INSERT INTO pds.photo_meals (client_key, capture_kind, eaten_date, eaten_time, eaten_at, time_zone, time_source,
              items, kcal, protein_g, carbs_g, fat_g, caffeine_mg, drink_product_id, drink_product_version, drink_servings, drink_label)
          VALUES ('00000000-0000-4000-8000-00000000d004', 'drink', d, '14:05', timestamptz '2001-01-03 14:05:00-05', 'America/New_York', 'manual',
              item, 5, 0, 1, 0, 200, 'synthetic-drink', NULL, 1, lbl);
          RAISE EXCEPTION 'NULL drink_product_version allowed'; EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN INSERT INTO pds.photo_meals (client_key, capture_kind, eaten_date, eaten_time, eaten_at, time_zone, time_source,
              items, kcal, protein_g, carbs_g, fat_g, caffeine_mg, drink_product_id, drink_product_version, drink_servings, drink_label)
          VALUES ('00000000-0000-4000-8000-00000000d005', 'drink', d, '14:05', timestamptz '2001-01-03 14:05:00-05', 'America/New_York', 'manual',
              item, 5, 0, 1, 0, 200, 'synthetic-drink', 1, NULL, lbl);
          RAISE EXCEPTION 'NULL drink_servings allowed'; EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN INSERT INTO pds.photo_meals (client_key, capture_kind, eaten_date, eaten_time, eaten_at, time_zone, time_source,
              items, kcal, protein_g, carbs_g, fat_g, caffeine_mg, drink_product_id, drink_product_version, drink_servings, drink_label)
          VALUES ('00000000-0000-4000-8000-00000000d006', 'drink', d, '14:05', timestamptz '2001-01-03 14:05:00-05', 'America/New_York', 'manual',
              item, 5, 0, 1, 0, 200, 'synthetic-drink', 1, 1, NULL);
          RAISE EXCEPTION 'NULL drink_label allowed'; EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN INSERT INTO pds.photo_meals (client_key, capture_kind, eaten_date, eaten_time, eaten_at, time_zone, time_source,
              items, kcal, protein_g, carbs_g, fat_g, caffeine_mg, drink_product_id, drink_product_version, drink_servings, drink_label)
          VALUES ('00000000-0000-4000-8000-00000000d007', 'drink', d, '14:05', timestamptz '2001-01-03 14:05:00-05', 'America/New_York', 'manual',
              item, 5, 0, 1, 0, 200, 'synthetic-drink', 1, 0.3, lbl);
          RAISE EXCEPTION 'non-quarter servings allowed'; EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN INSERT INTO pds.photo_meals (client_key, capture_kind, eaten_date, eaten_time, eaten_at, time_zone, time_source,
              items, kcal, protein_g, carbs_g, fat_g, caffeine_mg, drink_product_id, drink_product_version, drink_servings, drink_label)
          VALUES ('00000000-0000-4000-8000-00000000d008', 'drink', d, '14:05', timestamptz '2001-01-03 14:05:00-05', 'America/New_York', 'manual',
              item, 5, 'NaN', 1, 0, 200, 'synthetic-drink', 1, 1, lbl);
          RAISE EXCEPTION 'NaN protein allowed'; EXCEPTION WHEN check_violation THEN NULL; END;
    BEGIN INSERT INTO pds.photo_meals (client_key, eaten_date, eaten_time, time_source, items, kcal, protein_g, carbs_g, fat_g, caffeine_mg)
          VALUES ('00000000-0000-4000-8000-00000000d009', d, '12:00', 'manual', item, 5, 0, 1, 0, 50);
          RAISE EXCEPTION 'photo row with caffeine allowed'; EXCEPTION WHEN check_violation THEN NULL; END;

    -- 6. Existing photo meals untouched.
    SELECT count(*) INTO photo_after FROM pds.photo_meals WHERE capture_kind = 'photo';
    IF photo_after <> photo_before THEN RAISE EXCEPTION 'photo rows changed'; END IF;

    -- 7. Access: owner reads; another identity and no identity read nothing; authenticated cannot write.
    INSERT INTO pds.photo_meals (client_key, capture_kind, eaten_date, eaten_time, eaten_at, time_zone, time_source,
        items, kcal, protein_g, carbs_g, fat_g, caffeine_mg, drink_product_id, drink_product_version, drink_servings, drink_label)
    VALUES ('00000000-0000-4000-8000-00000000d00a', 'drink', d, '18:00', timestamptz '2001-01-03 18:00:00-05', 'America/New_York', 'manual',
        item, 5, 0, 1, 0, 200, 'synthetic-drink', 1, 1, lbl)
    RETURNING meal_id INTO c_id;
    SELECT substring(qual from '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')::uuid
      INTO owner_id FROM pg_policies WHERE schemaname = 'pds' AND tablename = 'photo_meals' AND policyname = 'owner_read';
    IF owner_id IS NULL THEN RAISE EXCEPTION 'photo_meals owner policy missing'; END IF;
    PERFORM set_config('request.jwt.claim.sub', owner_id::text, true);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', owner_id, 'role', 'authenticated')::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    IF NOT EXISTS (SELECT 1 FROM pds.direct_drink_daily WHERE behavioral_date = d) THEN RAISE EXCEPTION 'owner cannot read drink projection'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pds.caffeine_events WHERE event_key = 'direct_capture:' || c_id) THEN RAISE EXCEPTION 'owner cannot read drink caffeine'; END IF;
    PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
    PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}', true);
    SELECT exists(SELECT 1 FROM pds.photo_meals WHERE meal_id = c_id)
        OR exists(SELECT 1 FROM pds.direct_drink_daily WHERE behavioral_date = d)
        OR exists(SELECT 1 FROM pds.caffeine_events WHERE event_key = 'direct_capture:' || c_id) INTO leaked;
    IF leaked THEN RAISE EXCEPTION 'non-owner can read drink rows'; END IF;
    PERFORM set_config('request.jwt.claim.sub', '', true);
    PERFORM set_config('request.jwt.claims', '{}', true);
    IF exists(SELECT 1 FROM pds.photo_meals WHERE meal_id = c_id) THEN RAISE EXCEPTION 'no-identity caller can read drink rows'; END IF;
    BEGIN INSERT INTO pds.photo_meals (client_key, eaten_date, eaten_time, time_source, items, kcal, protein_g, carbs_g, fat_g)
          VALUES ('00000000-0000-4000-8000-00000000d00b', d, '12:00', 'manual', item, 0, 0, 0, 0);
          RAISE EXCEPTION 'authenticated caller could write'; EXCEPTION WHEN insufficient_privilege THEN NULL; END;
    EXECUTE format('SET LOCAL ROLE %I', initial_role);

    PERFORM set_config('onyx.direct_drink_verification', jsonb_build_object(
        'one_event_one_contribution', true, 'second_can_adds', true, 'zero_kcal_caffeine', true,
        'in_diary_and_tombstone_excluded_both', true, 'trigger_guards', true, 'null_and_range_constraints', true,
        'photo_rows_untouched', true, 'owner_only_reads', true)::text, true);
END
$check$;
SELECT current_setting('onyx.direct_drink_verification')::jsonb AS verification;
ROLLBACK;
