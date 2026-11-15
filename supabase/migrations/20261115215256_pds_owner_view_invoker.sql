-- Ordinary browser-readable views must enforce the caller's existing owner RLS.
-- No grants, data, columns or definitions change. Direct materialized-view access
-- is a separate caller/facade migration; do not treat this as closing that path.
-- One DO statement is atomic; all preconditions precede every ALTER.
DO $migration$
DECLARE
    expected constant jsonb := '[{"name":"caffeine_events","definition_md5":"d60696c5af52a16d16dbf0489a5487ad"},{"name":"caffeine_data_quality","definition_md5":"c153df3cf59d686673e31690656cb241"},{"name":"whoop_main_cycle_per_behavioral_date","definition_md5":"67527fb0007bfe484b974b826605e51c"},{"name":"caffeine_timing_daily","definition_md5":"6154e926dec2c2b9d80350cc8e361831"},{"name":"cronometer_nutrition_behavioral_daily","definition_md5":"7a5f44cd84e0123319f26fbdd1c7e262"},{"name":"garmin_hrv_latest_per_behavioral_date","definition_md5":"8f5ff850eb5bb43b84209a58656af63a"},{"name":"garmin_sleep_best_per_behavioral_date","definition_md5":"d8a816ec9071ef2e5a00036d89007bf6"},{"name":"meal_timing_daily","definition_md5":"1e2affdc7dacfa4f329865ec2f6d900a"},{"name":"meal_timing_from_cronometer","definition_md5":"4dc84f682bc0df36b27b96b11c64e1f5"},{"name":"daily_health_matrix_behavioral","definition_md5":"c36d6a221ffa2b5d715665f0e2a056fe"},{"name":"supplement_intake_by_compound","definition_md5":"00407e36bd4ddcd804d0c3b73d96d5c8"},{"name":"daily_micronutrient_totals","definition_md5":"2264c161d74ad870ddf18dc1bca572b6"},{"name":"daily_supplement_matrix","definition_md5":"0f4cde80e44119944a3d5f3e5057366a"},{"name":"delivery_uneaten_meal_orders","definition_md5":"746ca3d3fa4fdc8cf7e4737a6abe7c6f"},{"name":"delivery_daily","definition_md5":"fcd542381f1809aa16b04386b969798f"},{"name":"delivery_items_unestimated","definition_md5":"157c28de3f35d03e7cb9b13526da2914"},{"name":"delivery_nutrition_daily","definition_md5":"64845ff6f0c3f7af3d522c9a8d51eca2"},{"name":"journal","definition_md5":"d751cec12141d7f8a3cc86329d0ad7e5"},{"name":"flight_day_unified","definition_md5":"85464d845cce43f3703b87543f9fb40b"},{"name":"hrv_prediction_gaps","definition_md5":"6ab476d763552ba1403e1a395073f952"},{"name":"hrv_predictions_eval","definition_md5":"e1702f18022374186d58f82297bb0a37"},{"name":"hrv_predictions_latest","definition_md5":"35d42ca505737aaabe801318d28d4620"},{"name":"legacy_mfp_nutrition_archive","definition_md5":"543ee4bd9c92b3c5e8e14f0103497d99"},{"name":"melatonin_unified","definition_md5":"023166e29d2b79063331628a1e70afdb"},{"name":"phone_app_sessions","definition_md5":"0a28096db1efb4e145c6211d8fb4a219"},{"name":"phone_screen_daily","definition_md5":"8a5d8b8dea901b906333186ccc7da9b0"},{"name":"recovery_vs_pace","definition_md5":"72b4dcc111366539389878a92255dfce"},{"name":"spotify_daily_signature","definition_md5":"50f5c73a6edaa4b31b4a58667f2761af"},{"name":"supplement_unii_sentinel_check","definition_md5":"7c731fedd97a2ba648bc565734dcbb12"},{"name":"trips","definition_md5":"e803f13fcdb8c704f84da9b3ff9c49cd"},{"name":"tz_log_gaps","definition_md5":"5d1e7d94802434ba0e406d181fb35c57"}]';
    expected_policies constant jsonb := '[{"name":"cronometer_nutrition_daily","policy_md5":"64305ca6ceef4e18e0abae4f87053859"},{"name":"cronometer_servings","policy_md5":"64305ca6ceef4e18e0abae4f87053859"},{"name":"delivery_item_leftovers","policy_md5":"155b6c14e532f42cf9d85d510939a995"},{"name":"delivery_item_nutrition","policy_md5":"64305ca6ceef4e18e0abae4f87053859"},{"name":"delivery_order_items","policy_md5":"64305ca6ceef4e18e0abae4f87053859"},{"name":"delivery_orders","policy_md5":"64305ca6ceef4e18e0abae4f87053859"},{"name":"eight_sleep_trends","policy_md5":"64305ca6ceef4e18e0abae4f87053859"},{"name":"flight_email_log","policy_md5":"64305ca6ceef4e18e0abae4f87053859"},{"name":"flights","policy_md5":"64305ca6ceef4e18e0abae4f87053859"},{"name":"garmin_activities","policy_md5":"64305ca6ceef4e18e0abae4f87053859"},{"name":"garmin_daily_summary","policy_md5":"64305ca6ceef4e18e0abae4f87053859"},{"name":"garmin_heart_rate","policy_md5":"64305ca6ceef4e18e0abae4f87053859"},{"name":"garmin_hrv","policy_md5":"64305ca6ceef4e18e0abae4f87053859"},{"name":"garmin_sleep","policy_md5":"64305ca6ceef4e18e0abae4f87053859"},{"name":"garmin_stress","policy_md5":"64305ca6ceef4e18e0abae4f87053859"},{"name":"garmin_training_status","policy_md5":"64305ca6ceef4e18e0abae4f87053859"},{"name":"garmin_workouts","policy_md5":"f232169c289f3c9bfd65152def69171d"},{"name":"habit_journal","policy_md5":"73d12b062fcf7205bfec715eb96d3852"},{"name":"hrv_model_metrics","policy_md5":"bc2837118be746b24a315de541b757b6"},{"name":"hrv_predictions","policy_md5":"386095eee8142e070dc2709c856e8e45"},{"name":"meal_events","policy_md5":"64305ca6ceef4e18e0abae4f87053859"},{"name":"myfitnesspal_nutrition","policy_md5":"64305ca6ceef4e18e0abae4f87053859"},{"name":"phone_app_events","policy_md5":"64305ca6ceef4e18e0abae4f87053859"},{"name":"photo_meals","policy_md5":"155b6c14e532f42cf9d85d510939a995"},{"name":"spotify_plays","policy_md5":"64305ca6ceef4e18e0abae4f87053859"},{"name":"spotify_tracks","policy_md5":"64305ca6ceef4e18e0abae4f87053859"},{"name":"supplement_intake","policy_md5":"64305ca6ceef4e18e0abae4f87053859"},{"name":"supplement_products","policy_md5":"64305ca6ceef4e18e0abae4f87053859"},{"name":"user_tz_log","policy_md5":"dd6bad1278c25e2e7aebc7b970e044f1"},{"name":"whoop_cycles","policy_md5":"64305ca6ceef4e18e0abae4f87053859"},{"name":"whoop_recovery","policy_md5":"64305ca6ceef4e18e0abae4f87053859"},{"name":"whoop_sleep","policy_md5":"64305ca6ceef4e18e0abae4f87053859"},{"name":"whoop_workouts","policy_md5":"64305ca6ceef4e18e0abae4f87053859"}]';
    r record;
    relation_id oid;
    unsafe_count integer;
BEGIN
    PERFORM set_config('lock_timeout', '5s', true);
    IF current_setting('server_version_num')::integer < 150000 THEN
        RAISE EXCEPTION 'security_invoker requires PostgreSQL 15 or newer';
    END IF;
    FOR r IN SELECT * FROM jsonb_to_recordset(expected)
        AS x(name text, definition_md5 text)
    LOOP
        SELECT c.oid INTO relation_id FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'pds' AND c.relname = r.name AND c.relkind = 'v';
        IF relation_id IS NULL OR md5(pg_get_viewdef(relation_id, true)) <> r.definition_md5 THEN
            RAISE EXCEPTION 'View definition drift: %; review before applying', r.name;
        END IF;
        IF NOT has_table_privilege('authenticated', relation_id, 'SELECT') THEN
            RAISE EXCEPTION 'Caller grant drift: %', r.name;
        END IF;
    END LOOP;

    FOR r IN SELECT * FROM jsonb_to_recordset(expected_policies)
        AS x(name text, policy_md5 text)
    LOOP
        IF r.policy_md5 <> (SELECT md5(coalesce(string_agg(
            policyname || chr(31) || cmd || chr(31) || array_to_string(roles, ',')
            || chr(31) || coalesce(qual, '') || chr(31) || coalesce(with_check, ''),
            chr(30) ORDER BY policyname), ''))
            FROM pg_policies WHERE schemaname='pds' AND tablename=r.name) THEN
            RAISE EXCEPTION 'Source policy drift: %; review before applying', r.name;
        END IF;
    END LOOP;

    -- Follow ordinary-view dependencies to their source relations. Never grant
    -- access to a service-only source just to make an invoker view compile.
    WITH RECURSIVE sources(oid) AS (
        SELECT to_regclass(format('pds.%I', x.name))::oid
        FROM jsonb_to_recordset(expected) AS x(name text, definition_md5 text)
        UNION
        SELECT d.refobjid
        FROM sources s
        JOIN pg_rewrite w ON w.ev_class = s.oid
        JOIN pg_depend d ON d.objid = w.oid AND d.classid = 'pg_rewrite'::regclass
            AND d.refclassid = 'pg_class'::regclass AND d.refobjid <> s.oid
    )
    SELECT count(*) INTO unsafe_count
    FROM sources s JOIN pg_class c ON c.oid = s.oid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'pds' AND (
        NOT has_table_privilege('authenticated', c.oid, 'SELECT')
        OR (c.relkind IN ('r', 'p') AND NOT c.relrowsecurity)
        OR c.relkind NOT IN ('r', 'p', 'v')
        OR (c.relkind = 'v'
            AND NOT EXISTS (SELECT 1 FROM pg_options_to_table(c.reloptions) o
                WHERE o.option_name = 'security_invoker' AND o.option_value::boolean)
            AND NOT EXISTS (SELECT 1 FROM jsonb_to_recordset(expected)
                AS x(name text, definition_md5 text) WHERE x.name = c.relname))
    );
    IF unsafe_count <> 0 THEN
        RAISE EXCEPTION 'Source permissions/RLS/dependencies drifted; review before applying';
    END IF;

    -- The timezone helper reads this table under invoker permissions. It is not
    -- recorded as a relation dependency for a string-body SQL function.
    IF NOT has_table_privilege('authenticated', 'pds.user_tz_log', 'SELECT')
       OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'pds.user_tz_log'::regclass)
       OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'pds' AND p.proname IN ('behavioral_today_now', 'tz_for_instant', 'unit_to_mg_factor', 'unit_to_mg_factor_for')
           AND (p.prosecdef OR NOT has_function_privilege('authenticated', p.oid, 'EXECUTE'))) THEN
        RAISE EXCEPTION 'Invoker helper permissions drifted; review before applying';
    END IF;

    FOR r IN SELECT * FROM jsonb_to_recordset(expected)
        AS x(name text, definition_md5 text)
    LOOP
        EXECUTE format('ALTER VIEW pds.%I SET (security_invoker = true)', r.name);
    END LOOP;
END
$migration$;
