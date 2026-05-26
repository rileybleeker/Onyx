# Production Schema State — `pds` Schema

Pulled live from Supabase Postgres 17 on 2026-05-25 23:25 ET. This is **what's actually in production**, not just the .sql files. The canonical DDL files (`*_schema.sql`, `sql/*.sql`) are included in the bundle alongside this doc — read both. Discrepancies between intended and actual are themselves findings.

## Inventory

- **36 tables** (rows from 1 weight_log → 11,910 whoop_journal → see DATA_PROFILE.md for full counts)
- **14 views**
- **29 functions** (mostly trigger functions + behavioral-day helpers)
- **30+ triggers** (most are `set_onyx_dates_*` — ADR-0001 attribution machinery)
- **49 RLS policies**
- **1 foreign key** — see "Referential integrity" below
- **85 indexes** total across all tables

## Tables and their indexes

```
pds.ci_tokens
  PK         (service)

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
  PK         (prediction_date, model, horizon_days)
  idx        (input_data_hash)

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
  idx        (calendar_date)                   -- duplicate? PK already covers
  idx        (onyx_behavioral_date)

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
  idx        (track_id)

pds.spotify_tracks
  PK         (track_id)
  idx        (features_source)

pds.supplement_intake
  PK         (intake_id)
  idx        (onyx_behavioral_date)
  idx        (intake_date DESC)
  idx        (intake_date, product_id)
  idx        (product_id)

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
  idx        (log_date DESC)                   -- duplicate? PK already covers

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
  idx        (cycle_date)                       -- duplicate? PK starts with this

pds.whoop_recovery
  PK         (cycle_id)
  idx        (created_at)

pds.whoop_sleep
  PK         (sleep_id)
  idx        (onyx_behavioral_date)
  idx        (cycle_id)
  idx        (start_time)

pds.whoop_workouts
  PK         (workout_id)
  idx        (onyx_behavioral_date)
  idx        (start_time)
```

## Referential integrity — only 1 FK in the entire schema

```sql
ALTER TABLE pds.supplement_intake
  ADD CONSTRAINT supplement_intake_product_id_fkey
  FOREIGN KEY (product_id) REFERENCES pds.supplement_products(product_id)
  ON UPDATE NO ACTION ON DELETE NO ACTION;
```

**Notably absent foreign keys** (relationships enforced only in application code):

- `whoop_recovery.cycle_id` → `whoop_cycles.cycle_id` (1:1 dependency)
- `whoop_sleep.cycle_id` → `whoop_cycles.cycle_id` (M:1, used in joins)
- `whoop_workouts.cycle_id` → `whoop_cycles.cycle_id`
- `spotify_plays.track_id` → `spotify_tracks.track_id`
- `spotify_plays.artist_id` → `spotify_artists.artist_id`
- `garmin_activity_laps.activity_id` → `garmin_activities.activity_id`
- `habit_journal.question` ↔ `habit_name_map.name` (no FK; loose join in app code)
- `hrv_model_metrics.input_data_hash` ↔ `hrv_predictions.input_data_hash` (no FK; cross-reference left implicit)

**Reviewer should consider:** is this absence deliberate (single-user, fast iteration, hand-managed) or technical debt? The cost of adding FKs is small at this scale; the benefit is catching upstream ETL bugs at write-time rather than at downstream join-time.

## Row-Level Security policies

49 policies across all RLS-enabled tables. Pattern is highly consistent:

| Pattern | Count | Behavior |
|---|---|---|
| `anon_read` SELECT for `{anon}` role with `qual = 'true'` | most tables | anon key can read everything in `pds` |
| `service_full_access` ALL for `{service_role}` or `{public}` | 18 tables | service key can read/write |
| Bespoke names (`Allow anon read access on whoop_journal`, etc.) | a few legacy | same semantics, older naming |

**Inconsistency worth flagging:**

- Most `service_full_access` policies target `{service_role}` (correct).
- Several (`whoop_cycles`, `whoop_recovery`, `whoop_sleep`, `whoop_workouts`, `garmin_*`, `sync_log`) target `{public}` instead. The `public` role technically includes anon — even though the policy says `with_check = 'true'` and `qual = 'true'`, granting ALL to `public` is semantically broader than `service_role`. **Likely an early-development pattern that should be normalized.**
- A few tables have RLS enabled with `anon_read` but **no `service_*` policy** (`garmin_workouts`, `habit_metadata_history`, `meal_events`, `journal_entries`, `myfitnesspal_nutrition`, `spotify_*`, `supplement_*`, `weight_log`). These rely on the service-role's bypass-RLS privilege rather than explicit policy — works but creates an inconsistency for any future migration off Supabase.

## Views

```
pds.daily_health_matrix                  -- legacy clock-day spine (Garmin spine)
pds.daily_health_matrix_behavioral       -- canonical ADR-0001 spine (135 cols)
pds.daily_supplement_matrix              -- one row per behavioral day with compounds_jsonb
pds.hrv_prediction_gaps                  -- diagnostic: days with no prediction
pds.hrv_predictions_eval                 -- evaluation join with truth
pds.hrv_predictions_latest               -- DISTINCT ON (date, model, horizon) for freshest
pds.journal                              -- UNION of whoop_journal + habit_journal
pds.meal_timing_daily                    -- one row per ET date with last_meal_to_bedtime etc.
pds.recovery_vs_pace                     -- bivariate diagnostic
pds.spotify_daily_signature              -- audio-feature daily aggregate
pds.supplement_intake_by_compound        -- jsonb explode → per-compound rollup with UNII
pds.supplement_unii_sentinel_check       -- canary: rows with missing UNII
pds.trips                                -- derived from user_tz_log
pds.tz_log_gaps                          -- canary: WHOOP offset disagrees with tz_for_instant
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
- `pds.unit_to_mg_factor(text, text) → numeric` — supplement unit conversion (mcg→mg, IU→mg etc.)
- `pds.refresh_materialized_views()` — none currently materialized; future-proofing

### `set_onyx_dates_*` BEFORE INSERT/UPDATE triggers (11 of these)
One per table that holds a TIMESTAMPTZ event. Each calls `derive_onyx_dates(ts, source_field)` and populates the four `onyx_*` columns on every write. **This is the load-bearing implementation of ADR-0001 — bugs here propagate everywhere.**

Tables with `set_onyx_dates_*` triggers:
- `whoop_cycles`, `whoop_sleep`, `whoop_workouts`, `whoop_journal`
- `garmin_activities`, `garmin_sleep`, `garmin_hrv`
- `eight_sleep_trends`
- `mfp_nutrition`
- `journal_entries`
- `meal_events`
- `supplement_intake`
- `habit_journal`
- `spotify_plays`

### Other triggers
- `set_whoop_cycles_transition_flag` — sets `onyx_is_transition_day` BEFORE INSERT/UPDATE on `whoop_cycles`
- `cycle_refresh_journal_behaviors_trigger` — propagates journal behavior-date updates when WHOOP cycle metadata changes
- `journal_behaviors_date_trigger` — legacy WHOOP journal attribution
- `habit_journal_backfill_trigger` — emits a `sync_log` signal when a backdated habit completion is written; downstream consumer is `hrv_backfill_check.py` (triggers retrain)
- `trg_meal_events_updated_at` — auto-touch updated_at
- `weight_log_touch_updated_at` — same

### `search_journal_entries` RPC
PostgreSQL function exposed to PostgREST: takes `(query_embedding vector(1024), date_from, date_to, mood_filter, topic_filters, result_limit)` and returns rows from `journal_entries` ranked by cosine similarity to the query embedding. Used by the chat tool `query_journal_entries`.

## What to focus on in the schema audit

These are the highest-leverage questions for this domain:

1. **Referential integrity.** Should the missing FKs be added? What's the cost/benefit at this scale?
2. **RLS consistency.** The `public`-role-targeting `service_full_access` policies — bug or intentional?
3. **JSONB usage.** `supplement_products.ingredients` (deeply nested), `journal_entries.topics` (array), `spotify_*.raw_json` (preserved API response). Are these the right structures? When does a column become a column vs. stay in JSONB?
4. **Index coverage.** Are there hot query paths missing indexes? Are there indexes that duplicate the PK (e.g., `idx_mfp_nutrition_date`, `idx_weight_log_date`)?
5. **The 135-column behavioral matrix view.** Is this the right spine, or has it become a "god view" with maintenance burden? The dedup-via-LATERAL-LIMIT-1 pattern is repeated 5+ times — worth refactoring?
6. **The two parallel matrix views** (`daily_health_matrix` legacy + `daily_health_matrix_behavioral`). Should the legacy view be deprecated and removed?
7. **Trigger-based ADR-0001 attribution.** Is putting behavioral-day logic in 11 separate triggers the right pattern? Alternative: a single trigger or computed/generated columns?
8. **Sparse fact tables joined in Python rather than SQL** (supplement_intake, spotify_*, journal_entries). Documented as deliberate isolation — does the design hold?
9. **`hrv_predictions` row growth.** 10,980 rows already (~36 per eval_date). At this rate the table doubles in ~9 months. Partitioning strategy?
10. **`whoop_journal` row growth.** 11,910 rows already. Pivoted to wide-format in pipeline; long-format in storage. Is the long-format right?
