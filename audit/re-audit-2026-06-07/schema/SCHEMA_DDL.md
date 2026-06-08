# Production Schema State — `pds` Schema

> **Regenerated from live prod 2026-06-07 (re-audit).** Counts, indexes, FKs,
> RLS write-grants, views, and the trigger list below were re-pulled from
> Supabase Postgres 17 and corrected — the prior snapshot (dated 2026-05-25)
> had drifted and caused ~13 false-alarm "missing in prod" findings this round
> (FKs/indexes/RLS that are in fact applied). The original snapshot framing is
> preserved below; only stale facts were corrected.

Originally pulled live from Supabase Postgres 17 on 2026-05-25 23:25 ET. This is **what's actually in production**, not just the .sql files. The canonical DDL files (`*_schema.sql`, `sql/*.sql`) are included in the bundle alongside this doc — read both. Discrepancies between intended and actual are themselves findings.

## Inventory

*(live counts re-pulled 2026-06-07)*

- **39 tables** (rows from 1 weight_log → 11,910 whoop_journal → see DATA_PROFILE.md for full counts). New since the 2026-05-25 snapshot: `cronometer_nutrition_daily`, `cronometer_servings`, `supplement_stack`, `supplement_stack_item`, plus Garmin rollup tables (`garmin_monthly_summary`, `garmin_weekly_summary`, `garmin_weekly_sleep`).
- **22 views**
- **33 functions** (mostly trigger functions + behavioral-day helpers)
- **26 triggers** (most are `set_onyx_dates_*` — ADR-0001 attribution machinery; plus the new `zzz_bump_synced_at` cluster + Cronometer triggers, 2026-06-07)
- **75 RLS policies**
- **10 foreign keys** — see "Referential integrity" below
- **119 indexes** total across all tables

## Tables and their indexes

*(Index inventory re-pulled live 2026-06-07. Material corrections vs the
2026-05-25 snapshot: `idx_mfp_nutrition_date` and `idx_weight_log_date` — the
two PK-duplicating indexes flagged below — were DROPPED (gone from prod, see
`sql/audit_re_2026_05_26_drop_redundant_indexes.sql`); the redundant
`idx_whoop_journal` cycle_date index is also gone. New covering/partial indexes
exist: `idx_garmin_sleep_behavioral_score`, `idx_whoop_recovery_cycle_scored`,
`idx_whoop_sleep_cycle_scored_main`, `idx_spotify_tracks_featurized`,
`idx_spotify_plays_date_track`, `idx_supplement_intake_stack`,
`idx_supplement_stack_active_name`, plus `idx_hrv_predictions_tiebreak` on
`hrv_predictions`. New Cronometer + Garmin-rollup tables added their own
indexes. Only the changed/added blocks are annotated below; the rest match
prod.)*

```
pds.ci_tokens
  PK         (service)

pds.cronometer_nutrition_daily
  PK         (calendar_date)
  idx        (onyx_behavioral_date)

pds.cronometer_servings
  PK         (serving_id)
  idx        (onyx_behavioral_date)
  idx        (calendar_date)
  idx        (event_time)
  idx        (meal_group)

pds.eight_sleep_trends
  PK         (calendar_date, bed_side)
  idx        (onyx_behavioral_date)
  idx        (calendar_date)

pds.garmin_activities
  PK         (activity_id, ts)
  idx        (activity_type, ts DESC)
  idx        (onyx_behavioral_date)

pds.garmin_activity_laps
  UNIQUE     (activity_id, lap_index, ts)
  idx        (activity_id, lap_index)

pds.garmin_daily_summary
  UNIQUE     (calendar_date, ts)
  idx        (calendar_date DESC)

pds.garmin_heart_rate
  UNIQUE     (calendar_date, ts)
  idx        (calendar_date DESC)

pds.garmin_hrv
  UNIQUE     (calendar_date, ts)
  idx        (onyx_behavioral_date)
  idx        (calendar_date DESC)

pds.garmin_sleep
  UNIQUE     (calendar_date, sleep_id, ts)
  idx        (onyx_behavioral_date)
  idx-partial (onyx_behavioral_date, overall_sleep_score DESC) WHERE overall_sleep_score IS NOT NULL  -- covering, 2026-05-26
  idx        (calendar_date DESC)

pds.garmin_stress
  UNIQUE     (calendar_date, ts)
  idx        (calendar_date DESC)

pds.garmin_training_status
  UNIQUE     (calendar_date, ts)
  idx        (calendar_date DESC)

pds.garmin_workouts
  PK         (workout_id)

pds.habit_journal
  PK         (cycle_date, question)
  idx        (onyx_behavioral_date)
  idx        (cycle_date)

pds.habit_metadata_history
  PK         (notion_page_id, valid_from)
  idx        (notion_page_id, valid_from DESC)
  idx-partial (notion_page_id) WHERE valid_to IS NULL
  UNIQUE-partial (notion_page_id) WHERE valid_to IS NULL  -- enforces one open period

pds.habit_name_map
  PK         (notion_page_id)

pds.hrv_analysis_results
  PK         (id)
  UNIQUE     (result_type, result_key)

pds.hrv_model_metrics
  PK         (eval_date, model, horizon_days)
  idx        (input_data_hash)

pds.hrv_predictions
  PK         (id)
  UNIQUE     (prediction_date, model, horizon_days, model_version) NULLS NOT DISTINCT
  idx        (input_data_hash)
  idx        (prediction_date, model, horizon_days, <backtest/behavioral CASE>, created_at DESC)  -- idx_hrv_predictions_tiebreak, backs hrv_predictions_latest (2026-06-06)

pds.journal_entries
  PK         (notion_page_id)
  idx        (onyx_behavioral_date)
  idx        (entry_date)
  idx-hnsw   (embedding vector_cosine_ops)   -- vector similarity
  idx        (mood)
  idx-gin    (topics)                          -- jsonb array search

pds.meal_events
  PK         (event_id)
  idx        (onyx_behavioral_date)
  idx        (event_date DESC)
  idx        (kind, event_date DESC)

pds.myfitnesspal_nutrition
  PK         (calendar_date)
  idx        (onyx_behavioral_date)
  -- NOTE (2026-06-07): the PK-duplicating idx_mfp_nutrition_date was DROPPED — no longer in prod.

pds.spotify_artists
  PK         (artist_id)
  idx-gin    (genres)

pds.spotify_playlists
  PK         (playlist_id)
  idx        (created_at DESC)
  idx        (created_via)

pds.spotify_plays
  PK         (played_at, track_id)
  idx        (artist_id)
  idx        (onyx_behavioral_date)
  idx        (played_date_et)
  idx        (played_date_et, track_id)        -- idx_spotify_plays_date_track
  idx        (track_id)

pds.spotify_tracks
  PK         (track_id)
  idx        (features_source)
  idx-partial (track_id) WHERE valence IS NOT NULL  -- idx_spotify_tracks_featurized

pds.supplement_intake
  PK         (intake_id)
  idx        (onyx_behavioral_date)
  idx        (intake_date DESC)
  idx        (intake_date, product_id)
  idx        (product_id)
  idx-partial (stack_id) WHERE stack_id IS NOT NULL  -- idx_supplement_intake_stack (stacks provenance)

pds.supplement_stack
  PK         (stack_id)
  UNIQUE-partial (lower(name)) WHERE is_active = true  -- one active stack per name

pds.supplement_stack_item
  PK         (item_id)
  UNIQUE     (stack_id, product_id)
  idx        (stack_id)

pds.supplement_products
  PK         (product_id)
  idx-partial (is_active) WHERE is_active = true
  idx        (brand_name)
  idx-partial (dsld_id) WHERE dsld_id IS NOT NULL
  idx-gin    (ingredients)                     -- jsonb structure
  idx-partial (upc_sku) WHERE upc_sku IS NOT NULL

pds.sync_log
  PK         (id)
  idx        (source, data_type, sync_start DESC)

pds.user_tz_log
  PK         (effective_from)
  idx        (effective_from DESC)

pds.weight_log
  PK         (log_date)
  -- NOTE (2026-06-07): the PK-duplicating idx_weight_log_date was DROPPED — no longer in prod.

pds.whoop_body_measurements
  PK         (measured_at)

pds.whoop_cycles
  PK         (cycle_id)
  idx        (onyx_behavioral_date)
  idx        (start_time)
  idx-partial (onyx_is_transition_day) WHERE = true

pds.whoop_journal
  PK         (cycle_date, question)
  idx        (onyx_behavioral_date)
  idx        (behaviors_date)
  idx        (category)
  -- NOTE (2026-06-07): the redundant idx_whoop_journal cycle_date index was DROPPED (PK already starts with cycle_date).

pds.whoop_recovery
  PK         (cycle_id)
  idx        (created_at)
  idx-partial (cycle_id) WHERE score_state = 'SCORED'  -- idx_whoop_recovery_cycle_scored

pds.whoop_sleep
  PK         (sleep_id)
  idx        (onyx_behavioral_date)
  idx        (cycle_id)
  idx-partial (cycle_id) WHERE score_state = 'SCORED' AND is_nap = false  -- idx_whoop_sleep_cycle_scored_main (main-session pick)
  idx        (start_time)

pds.whoop_workouts
  PK         (workout_id)
  idx        (onyx_behavioral_date)
  idx        (start_time)
```

## Referential integrity — 10 FKs

*(Re-pulled 2026-06-07. CORRECTIONS vs the 2026-05-25 snapshot: the
`habit_journal.question` FK now EXISTS in prod (constraint
`fk_habit_journal_question` → `habit_name_map(habit_name)`, applied
`sql/audit_re_2026_05_26_habit_journal_question_fk.sql`) — do NOT re-raise it as
"notably absent". Three supplement-stack FKs were also added with the stacks
feature. The 6 FKs the old doc listed are all still present and unchanged.)*

```sql
-- WHOOP cycle hub
ALTER TABLE pds.whoop_recovery
  ADD CONSTRAINT whoop_recovery_cycle_id_fkey
  FOREIGN KEY (cycle_id) REFERENCES pds.whoop_cycles(cycle_id)
  ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE pds.whoop_sleep
  ADD CONSTRAINT whoop_sleep_cycle_id_fkey
  FOREIGN KEY (cycle_id) REFERENCES pds.whoop_cycles(cycle_id)
  ON UPDATE CASCADE ON DELETE CASCADE;

-- Garmin laps → activities (parent uses a separate UNIQUE INDEX on activity_id
-- since the table PK is the compound (activity_id, ts))
ALTER TABLE pds.garmin_activity_laps
  ADD CONSTRAINT garmin_activity_laps_activity_id_fkey
  FOREIGN KEY (activity_id) REFERENCES pds.garmin_activities(activity_id)
  ON UPDATE CASCADE ON DELETE CASCADE;

-- Spotify plays → dim tables (DEFERRABLE for in-transaction ETL ordering)
ALTER TABLE pds.spotify_plays
  ADD CONSTRAINT spotify_plays_track_id_fkey
  FOREIGN KEY (track_id) REFERENCES pds.spotify_tracks(track_id)
  ON UPDATE CASCADE ON DELETE RESTRICT
  DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE pds.spotify_plays
  ADD CONSTRAINT spotify_plays_artist_id_fkey
  FOREIGN KEY (artist_id) REFERENCES pds.spotify_artists(artist_id)
  ON UPDATE CASCADE ON DELETE SET NULL
  DEFERRABLE INITIALLY DEFERRED;

-- Supplements (pre-existing)
ALTER TABLE pds.supplement_intake
  ADD CONSTRAINT supplement_intake_product_id_fkey
  FOREIGN KEY (product_id) REFERENCES pds.supplement_products(product_id)
  ON UPDATE NO ACTION ON DELETE NO ACTION;

-- Habit journal → name map (ADDED 2026-05-26; was previously listed as "absent")
ALTER TABLE pds.habit_journal
  ADD CONSTRAINT fk_habit_journal_question
  FOREIGN KEY (question) REFERENCES pds.habit_name_map(habit_name)
  ON UPDATE CASCADE ON DELETE RESTRICT;

-- Supplement stacks (added with the stacks feature)
ALTER TABLE pds.supplement_intake
  ADD CONSTRAINT supplement_intake_stack_id_fkey
  FOREIGN KEY (stack_id) REFERENCES pds.supplement_stack(stack_id)
  ON DELETE SET NULL;

ALTER TABLE pds.supplement_stack_item
  ADD CONSTRAINT supplement_stack_item_stack_id_fkey
  FOREIGN KEY (stack_id) REFERENCES pds.supplement_stack(stack_id)
  ON DELETE CASCADE;

ALTER TABLE pds.supplement_stack_item
  ADD CONSTRAINT supplement_stack_item_product_id_fkey
  FOREIGN KEY (product_id) REFERENCES pds.supplement_products(product_id);
```

**Notably absent foreign keys** (relationships enforced only in application code):

- `whoop_workouts.cycle_id` → `whoop_cycles.cycle_id` — *the table has no cycle_id column; WHOOP's API doesn't supply one*
- `hrv_model_metrics.input_data_hash` ↔ `hrv_predictions.input_data_hash` (no FK; cross-reference left implicit)

*(The `habit_journal.question` ↔ `habit_name_map` relationship is now a real FK — see `fk_habit_journal_question` above — and is no longer absent.)*

**Reviewer should consider:** is the remaining absence deliberate (single-user, fast iteration, hand-managed) or technical debt? The cost of adding FKs is small at this scale; the benefit is catching upstream ETL bugs at write-time rather than at downstream join-time.

## Row-Level Security policies

75 policies across all RLS-enabled tables *(re-pulled live 2026-06-07)*. Pattern is highly consistent:

| Pattern | Behavior |
|---|---|
| `anon_read` SELECT for `{anon}` role with `qual = 'true'` | anon key can read everything in `pds` |
| `service_full_access` (or `service_write_*`) ALL for `{service_role}` | service key can read/write |
| Bespoke names (`Allow anon read access on whoop_journal`, etc.) | same semantics, older naming |

**RLS write-grant audit — CORRECTED 2026-06-07 (was a false alarm):**

- **NO policy grants write (ALL/INSERT/UPDATE/DELETE) to the `public` role.** Every
  write/ALL policy in `pds` targets `{service_role}` exclusively — verified live
  against `pg_policy` (every row with `polcmd IN ('w','a','d','*')` resolves to
  `roles = {service_role}`). The prior snapshot's claim that
  `whoop_cycles / whoop_recovery / whoop_sleep / whoop_workouts / garmin_* /
  sync_log` grant ALL to `{public}` is **stale and should not be re-raised** —
  those tables' `service_full_access` policies are `service_role`-scoped. The
  security lockdown (`sql/security_lockdown_2026_06_06.sql`) normalized any
  remaining `public`-targeted write policies. The HRV tables use named
  `service_write_*` policies (`service_write_analysis` / `_metrics` /
  `_predictions`) — also `service_role`-scoped.
- `anon`/`authenticated` roles only ever hold SELECT policies; they have no write path.
- Some tables historically lacked an explicit `service_*` policy and relied on
  the service-role's bypass-RLS privilege; the lockdown migration added explicit
  `service_full_access` policies broadly, so most RLS-enabled tables now carry
  both an `anon_read` SELECT and a `service_role` ALL policy.

## Views

*(22 views, re-pulled live 2026-06-07. Added since the 2026-05-25 snapshot: the
Cronometer views, the micronutrient recombination view, the
`supplement_intake_unmapped` unit-drop canary, the legacy MFP archive view, and
the **behavioral-matrix helper views** — `garmin_hrv_latest_per_behavioral_date`,
`garmin_sleep_best_per_behavioral_date`, `whoop_main_cycle_per_behavioral_date` —
which DO exist in prod and factor the LATERAL dedup logic out of
`daily_health_matrix_behavioral`.)*

```
pds.daily_health_matrix                       -- legacy clock-day spine (Garmin spine)
pds.daily_health_matrix_behavioral            -- canonical ADR-0001 spine (now ~135+ cols incl. Cronometer)
pds.daily_micronutrient_totals                -- per-nutrient _dietary + _supplement + _total recombination
pds.daily_supplement_matrix                   -- one row per behavioral day with compounds_jsonb
pds.caffeine_timing_daily                     -- per-behavioral-day caffeine timing (bedtime-anchored)
pds.garmin_hrv_latest_per_behavioral_date     -- behavioral-matrix helper (dedup by onyx_behavioral_date)
pds.garmin_sleep_best_per_behavioral_date     -- behavioral-matrix helper (best sleep per behavioral day)
pds.whoop_main_cycle_per_behavioral_date      -- behavioral-matrix helper (longest cycle per behavioral day)
pds.hrv_prediction_gaps                       -- diagnostic: days with no prediction
pds.hrv_predictions_eval                      -- evaluation join with truth
pds.hrv_predictions_latest                    -- DISTINCT ON (date, model, horizon) for freshest
pds.journal                                   -- UNION of whoop_journal + habit_journal
pds.legacy_mfp_nutrition_archive              -- frozen MFP era (≤ 2026-05-31 Cronometer cutover)
pds.meal_timing_daily                         -- one row per ET date with last_meal_to_bedtime etc. (meal_events)
pds.meal_timing_from_cronometer               -- meal timing from Cronometer Gold per-entry timestamps
pds.recovery_vs_pace                          -- bivariate diagnostic
pds.spotify_daily_signature                   -- audio-feature daily aggregate
pds.supplement_intake_by_compound             -- jsonb explode → per-compound rollup with UNII
pds.supplement_intake_unmapped                -- canary: intake rows whose unit didn't map to mg
pds.supplement_unii_sentinel_check            -- canary: rows with bogus/sentinel UNII
pds.trips                                     -- derived from user_tz_log
pds.tz_log_gaps                               -- canary: WHOOP offset disagrees with tz_for_instant
```

## Functions and triggers (ADR-0001 machinery)

### Behavioral-day helpers
- `pds.tz_for_instant(timestamptz) → text` — resolves the local IANA TZ for any instant by reading `user_tz_log` (handles travel days)
- `pds.derive_onyx_dates(timestamptz, text) → record` — given an instant + provenance, produces `(onyx_et_date, onyx_behavioral_date, onyx_local_date, onyx_tz_source)`
- `pds.behavioral_today_now() → date` — convenience: current ET behavioral day
- `pds.compute_journal_behaviors_date(...)` — legacy WHOOP journal date attribution
- `pds.refresh_journal_behaviors_dates_for_cycle(...)` — recomputes journal dates after cycle changes
- `pds.interval_to_tzd(interval) → text` — interval formatting helper
- `pds.seconds_to_duration(int) → text` — display helper
- `pds.sleep_efficiency(...)` — derived metric
- `pds.unit_to_mg_factor(text) → numeric` — supplement mass-unit conversion to mg (single TEXT arg; NULL for non-mass units like IU/mL/count). *(Corrected 2026-06-07: prod signature is one arg, not two; includes the Greek-mu→micro-sign normalization fix.)*
- `pds.refresh_materialized_views()` — none currently materialized; future-proofing

### `set_onyx_dates_*` BEFORE INSERT/UPDATE triggers (15 of these as of 2026-06-07)
One per table that holds a TIMESTAMPTZ event. Each calls `derive_onyx_dates(ts, source_field)` and populates the four `onyx_*` columns on every write. **This is the load-bearing implementation of ADR-0001 — bugs here propagate everywhere.**

Tables with `set_onyx_dates_*` triggers *(re-pulled live 2026-06-07; two new Cronometer triggers added)*:
- `whoop_cycles`, `whoop_sleep`, `whoop_workouts`, `whoop_journal`
- `garmin_activities`, `garmin_sleep`, `garmin_hrv`
- `eight_sleep_trends`
- `myfitnesspal_nutrition` (trigger `mfp_nutrition_set_onyx_dates`)
- `journal_entries`
- `meal_events`
- `supplement_intake`
- `habit_journal`
- `spotify_plays`
- `cronometer_nutrition_daily` (trigger `set_onyx_dates_cronometer_daily` — collapses to calendar_date) — **NEW 2026-06-07**
- `cronometer_servings` (trigger `set_onyx_dates_cronometer_servings` — derives from event_time when present, else calendar_date) — **NEW 2026-06-07**

### Other triggers *(re-pulled live 2026-06-07)*
- `whoop_cycles_set_transition_flag` — sets `onyx_is_transition_day` BEFORE INSERT/UPDATE on `whoop_cycles`
- `whoop_cycles_refresh_next_transition_day` — recomputes the following cycle's transition flag when a cycle changes
- `cycle_refresh_journal_behaviors_trigger` — propagates journal behavior-date updates when WHOOP cycle metadata changes
- `habit_journal_backfill_trigger` — emits a `sync_log` signal when a backdated habit completion is written; downstream consumer is `hrv_backfill_check.py` (triggers retrain)
- `trg_meal_events_updated_at` — auto-touch updated_at on `meal_events`
- `weight_log_touch_updated_at` — auto-touch updated_at on `weight_log`
- **`zzz_bump_synced_at`** (BEFORE UPDATE, function `pds.bump_synced_at_on_change()`) — bumps `synced_at` to `now()` whenever any non-`synced_at` column changed; attached to **`garmin_daily_summary`, `eight_sleep_trends`, `myfitnesspal_nutrition`, `whoop_journal`** so the upsert UPDATE branch (which omits synced_at from the patch) keeps /status freshness + backfill change-detection accurate. **NEW 2026-06-07** (repo: `sql/audit_re_2026_06_07_triggers.sql`).

*(Note: the legacy standalone `journal_behaviors_date_trigger` listed in the
prior snapshot is no longer a separate trigger — its formula was merged into
`set_onyx_dates_whoop_journal`. It is not in the live trigger list.)*

### `search_journal_entries` RPC
PostgreSQL function exposed to PostgREST: takes `(query_embedding vector(1024), date_from, date_to, mood_filter, topic_filters, result_limit)` and returns rows from `journal_entries` ranked by cosine similarity to the query embedding. Used by the chat tool `query_journal_entries`.

## What to focus on in the schema audit

These are the highest-leverage questions for this domain:

1. **Referential integrity.** Should the missing FKs be added? What's the cost/benefit at this scale?
2. **RLS consistency.** *(RESOLVED 2026-06-07: no write policy targets `public` anymore — all are `service_role`-scoped after the security lockdown. The remaining nuance is purely cosmetic: a few tables use named `service_write_*` policies vs the common `service_full_access` name.)*
3. **JSONB usage.** `supplement_products.ingredients` (deeply nested), `journal_entries.topics` (array), `spotify_*.raw_json` (preserved API response). Are these the right structures? When does a column become a column vs. stay in JSONB?
4. **Index coverage.** Are there hot query paths missing indexes? *(The PK-duplicating `idx_mfp_nutrition_date` and `idx_weight_log_date` flagged in the prior snapshot have since been DROPPED — 2026-06-07 — so this question is largely resolved; remaining work is confirming the new covering/partial indexes are used by the matrix views.)*
5. **The 135-column behavioral matrix view.** Is this the right spine, or has it become a "god view" with maintenance burden? The dedup-via-LATERAL-LIMIT-1 pattern is repeated 5+ times — worth refactoring?
6. **The two parallel matrix views** (`daily_health_matrix` legacy + `daily_health_matrix_behavioral`). Should the legacy view be deprecated and removed?
7. **Trigger-based ADR-0001 attribution.** Is putting behavioral-day logic in 11 separate triggers the right pattern? Alternative: a single trigger or computed/generated columns?
8. **Sparse fact tables joined in Python rather than SQL** (supplement_intake, spotify_*, journal_entries). Documented as deliberate isolation — does the design hold?
9. **`hrv_predictions` row growth.** 10,980 rows already (~36 per eval_date). At this rate the table doubles in ~9 months. Partitioning strategy?
10. **`whoop_journal` row growth.** 11,910 rows already. Pivoted to wide-format in pipeline; long-format in storage. Is the long-format right?
