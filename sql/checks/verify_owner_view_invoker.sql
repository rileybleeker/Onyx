-- Run only AFTER the migration is merged and applied, using privileged SQL access.
-- No records, schemas, users or grants are written. Session claims/roles roll back.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '45s';
DO $check$
DECLARE
    view_names constant text[] := ARRAY['pds.caffeine_data_quality','pds.caffeine_events','pds.caffeine_timing_daily','pds.cronometer_nutrition_behavioral_daily','pds.daily_health_matrix_behavioral','pds.daily_micronutrient_totals','pds.daily_supplement_matrix','pds.delivery_daily','pds.delivery_items_unestimated','pds.delivery_nutrition_daily','pds.delivery_uneaten_meal_orders','pds.flight_day_unified','pds.garmin_hrv_latest_per_behavioral_date','pds.garmin_sleep_best_per_behavioral_date','pds.hrv_prediction_gaps','pds.hrv_predictions_eval','pds.hrv_predictions_latest','pds.journal','pds.legacy_mfp_nutrition_archive','pds.meal_timing_daily','pds.meal_timing_from_cronometer','pds.melatonin_unified','pds.phone_app_sessions','pds.phone_screen_daily','pds.photo_meal_daily','pds.recovery_vs_pace','pds.spotify_daily_signature','pds.supplement_intake_by_compound','pds.supplement_intake_unmapped','pds.supplement_unii_sentinel_check','pds.trips','pds.tz_log_gaps','pds.whoop_main_cycle_per_behavioral_date'];
    table_names constant text[] := ARRAY['pds.cronometer_nutrition_daily','pds.cronometer_servings','pds.delivery_item_leftovers','pds.delivery_item_nutrition','pds.delivery_order_items','pds.delivery_orders','pds.eight_sleep_trends','pds.flight_email_log','pds.flights','pds.garmin_activities','pds.garmin_daily_summary','pds.garmin_heart_rate','pds.garmin_hrv','pds.garmin_sleep','pds.garmin_stress','pds.garmin_training_status','pds.garmin_workouts','pds.habit_journal','pds.hrv_model_metrics','pds.hrv_predictions','pds.meal_events','pds.myfitnesspal_nutrition','pds.phone_app_events','pds.photo_meals','pds.spotify_plays','pds.spotify_tracks','pds.supplement_intake','pds.supplement_products','pds.user_tz_log','pds.whoop_cycles','pds.whoop_recovery','pds.whoop_sleep','pds.whoop_workouts'];
    owner_id uuid;
    initial_role text := current_user;
    relation_name text;
    subject text;
    has_data boolean;
    owner_checks integer := 0;
    negative_checks integer := 0;
    service_checks integer := 0;
BEGIN
    SELECT substring(qual from '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}')::uuid
    INTO owner_id FROM pg_policies
    WHERE schemaname='pds' AND tablename='habit_journal' AND policyname='owner_read';
    IF owner_id IS NULL OR owner_id = '00000000-0000-0000-0000-000000000001'::uuid THEN
        RAISE EXCEPTION 'Owner policy must identify a distinct configured owner';
    END IF;
    IF has_schema_privilege('anon', 'pds', 'USAGE') THEN
        RAISE EXCEPTION 'Anonymous schema access unexpectedly enabled';
    END IF;
    FOREACH relation_name IN ARRAY view_names LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_class c, pg_options_to_table(c.reloptions) o
            WHERE c.oid=relation_name::regclass AND o.option_name='security_invoker'
                AND o.option_value::boolean) THEN
            RAISE EXCEPTION 'View does not enforce invoker permissions: %', relation_name;
        END IF;
    END LOOP;

    PERFORM set_config('request.jwt.claim.sub', owner_id::text, true);
    PERFORM set_config('request.jwt.claims', jsonb_build_object('sub',owner_id,'role','authenticated')::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';
    FOREACH relation_name IN ARRAY view_names LOOP
        EXECUTE format('SELECT * FROM %s LIMIT 0', relation_name::regclass);
        owner_checks := owner_checks + 1;
    END LOOP;
    SELECT exists(SELECT 1 FROM pds.journal) INTO has_data;
    IF NOT has_data THEN RAISE EXCEPTION 'Owner journal canary unexpectedly inaccessible or empty'; END IF;

    -- Missing identity and a distinct, synthetic identity must both see no base
    -- inputs. Aggregates may return harmless zero/null rows from those empty inputs.
    FOREACH subject IN ARRAY ARRAY['', '00000000-0000-0000-0000-000000000001'] LOOP
        PERFORM set_config('request.jwt.claim.sub', subject, true);
        PERFORM set_config('request.jwt.claims', CASE WHEN subject='' THEN '{}'
            ELSE jsonb_build_object('sub',subject,'role','authenticated')::text END, true);
        FOREACH relation_name IN ARRAY table_names LOOP
            EXECUTE format('SELECT exists(SELECT 1 FROM %s)', relation_name::regclass) INTO has_data;
            IF has_data THEN RAISE EXCEPTION 'Non-owner can read source relation: %', relation_name; END IF;
            negative_checks := negative_checks + 1;
        END LOOP;
        SELECT exists(SELECT 1 FROM pds.journal) INTO has_data;
        IF has_data THEN RAISE EXCEPTION 'Non-owner journal read leaked rows'; END IF;
    END LOOP;

    EXECUTE 'SET LOCAL ROLE service_role';
    FOREACH relation_name IN ARRAY view_names LOOP
        EXECUTE format('SELECT * FROM %s LIMIT 0', relation_name::regclass);
        service_checks := service_checks + 1;
    END LOOP;
    EXECUTE format('SET LOCAL ROLE %I', initial_role);
    PERFORM set_config('onyx.owner_view_verification', jsonb_build_object(
        'owner_query_contracts',owner_checks,'service_query_contracts',service_checks,
        'denied_source_probes',negative_checks,'owner_canary',true,
        'nonowner_canary_denied',true,'anonymous_schema_denied',true)::text, true);
END
$check$;
SELECT current_setting('onyx.owner_view_verification')::jsonb AS verification;
ROLLBACK;
