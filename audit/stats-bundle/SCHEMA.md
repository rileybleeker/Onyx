# Schema — Tables and Views the Stats Pipeline Touches

DDL is captured from production Supabase (Postgres 17). All objects live in the `pds` schema.

## Output tables (where results land)

### `pds.hrv_predictions` (10,980 rows)

```sql
CREATE TABLE pds.hrv_predictions (
  prediction_date         DATE NOT NULL,
  model                   TEXT NOT NULL,           -- 'xgboost' | 'sarimax' | 'prophet' | 'baseline_naive' | 'baseline_7d_avg' | 'baseline_dow'
  predicted_hrv           NUMERIC,
  prediction_lower        NUMERIC,                  -- 80% PI lower
  prediction_upper        NUMERIC,                  -- 80% PI upper
  actual_hrv              NUMERIC,                  -- backfilled by hrv_predict.py once truth known
  residual                NUMERIC,                  -- actual - predicted
  horizon_days            INTEGER NOT NULL,         -- 1..7
  top_drivers             JSONB,                    -- top SHAP features for this prediction
  model_version           TEXT,                     -- 'v1' | 'backtest_initial' | 'backtest_<date>'
  training_window_start   DATE,
  training_window_end     DATE,
  created_at              TIMESTAMPTZ,
  input_data_hash         TEXT                      -- SHA of input matrix; new hash => retrain
);
```

### `pds.hrv_model_metrics` (569 rows)

```sql
CREATE TABLE pds.hrv_model_metrics (
  eval_date              DATE NOT NULL,
  model                  TEXT NOT NULL,
  horizon_days           INTEGER NOT NULL,
  mae                    NUMERIC,
  rmse                   NUMERIC,
  mape                   NUMERIC,
  r_squared              NUMERIC,
  directional_accuracy   NUMERIC,                  -- new metric (improvement on legacy)
  ci_coverage            NUMERIC,                  -- empirical 80% PI hit rate
  ci_avg_width           NUMERIC,
  n_predictions          INTEGER,
  model_version          TEXT,
  created_at             TIMESTAMPTZ,
  input_data_hash        TEXT,
  directional_accuracy_legacy  NUMERIC             -- retained for backwards-compat plots
);
```

### `pds.hrv_analysis_results` (22 rows — one per result_type per analysis run)

```sql
CREATE TABLE pds.hrv_analysis_results (
  id                INTEGER PRIMARY KEY,
  result_type       TEXT NOT NULL,                  -- 'correlation' | 'journal_impact' | 'habit_impact' |
                                                    -- 'supplement_impact' | 'nutrition_impact' | 'feature_importance' |
                                                    -- 'model_comparison' | 'causal'
  result_key        TEXT,                           -- e.g. 'spearman' | 'shap_habit' | 'binary_treatments' | 'dag'
  result_json       JSONB NOT NULL,                 -- payload, schema varies by result_type
  computed_at       TIMESTAMPTZ,
  input_data_hash   TEXT
);
```

Each `python hrv_analysis.py` run writes ~10–14 rows to this table (one per `(result_type, result_key)` combination).

## View: `pds.hrv_predictions_latest`

DISTINCT ON `(prediction_date, model, horizon_days)` returning freshest row per forecast. **Live (non-backtest) predictions win when both exist for the same date; backtest rows fall through as fallback.** This is load-bearing — see [CONTEXT.md](CONTEXT.md) for the history of why.

```sql
-- ORDER BY (CASE WHEN model_version LIKE 'backtest%' THEN 1 ELSE 0 END), created_at DESC
```

## Spine view: `pds.daily_health_matrix_behavioral`

One row per behavioral day, ADR-0001 attribution rules applied. **135 columns wide.** This is the base for `hrv_analysis.py:load_data`.

Key structural choices:
- **Date spine** built via UNION across every source's `onyx_behavioral_date` (whoop_cycles + garmin_activities + garmin_sleep + garmin_hrv + eight_sleep_trends + myfitnesspal_nutrition + meal_events + supplement_intake + garmin_daily_summary).
- **WHOOP cycle deduplication via LATERAL with `LIMIT 1`** ordered by `(end_time − start_time) DESC` — longest cycle per behavioral day wins (handles transition-day "nap + main cycle" duplicates).
- **Garmin sleep dedup**: LATERAL `LIMIT 1` ordered by `overall_sleep_score DESC NULLS LAST` filtered to `is_nap = false AND sleep_id IS NOT NULL`.
- **Garmin HRV dedup**: LATERAL `LIMIT 1` ordered by `calendar_date DESC` (no duplicates expected, just safety).
- **Eight Sleep filter**: `bed_side = 'left'` (Riley's side).
- **Transition day aggregation**: `bool_or(onyx_is_transition_day)` across all whoop_cycles on the day.

The full view definition is embedded in `hrv_analysis.py` context — reviewers can extract it from the SQL there if needed.

**Column families** (135 columns, prefix-grouped):

| Prefix | Source | Approx column count |
|---|---|---|
| `garmin_*` (sleep, hrv, hr, training, recovery, activity, stress) | Garmin Connect | 50 |
| `whoop_*` (cycle, recovery, sleep, workout) | WHOOP | 22 |
| `eight_sleep_*` | Eight Sleep Pod | 15 |
| `mfp_*` | MyFitnessPal | 9 |
| `meal_*` | meal_events view (timing-only, no macros) | 5 |
| Garmin daily summary direct columns (steps, kcal, stress, body battery, spo2, intensity, active/sedentary seconds) | Garmin Connect | 28 |
| `onyx_*` (date types, tz_source, transition flag) | ADR-0001 metadata | 6 |

**Note: this view does NOT include journal, habits, or supplements.** Those are loaded separately and merged in pandas inside `hrv_analysis.py` (so the SQL view stays simple and the open-ended compound/question spaces don't bloat it).

## Behavioral fact tables (loaded separately by `hrv_analysis.py`)

### `pds.whoop_journal` (11,910 rows)

```sql
CREATE TABLE pds.whoop_journal (
  cycle_date              DATE,                     -- WHOOP cycle wake-day
  question                TEXT,                     -- e.g. 'Have any alcoholic drinks?'
  category                TEXT,                     -- WHOOP's grouping
  answer                  BOOLEAN,                  -- YES/NO only (WHOOP API limitation)
  notes                   TEXT,
  synced_at               TIMESTAMPTZ,
  behaviors_date          DATE,                     -- WHOOP's own behavioral-day attribution (legacy)
  onyx_et_date            DATE,
  onyx_behavioral_date    DATE,                     -- canonical join key for HRV pipeline
  onyx_local_date         DATE,
  onyx_tz_source          TEXT
);
```

Pipeline calls `pivot_journal()` to turn long-format (question, answer) pairs into wide `journal_<slug>` boolean columns. Each column gets a NaN→0 fill from that question's first-asked date onward.

### `pds.habit_journal` (29 rows — extremely sparse)

Identical schema to `whoop_journal` except no `behaviors_date` column (Onyx-native dates only).

Pipeline calls `pivot_habits()` to produce `habit_<slug>` boolean columns. Same per-habit NaN→0 fill from each habit's first completion onward.

### `pds.journal` view

UNION of `whoop_journal` + `habit_journal` with a `source` column. Used by `hrv_analysis.py` to route rows through the appropriate pivot function. Used by the frontend chat tools but **NOT** by the stats pipeline directly — the pipeline reads the underlying tables.

### `pds.supplement_intake_by_compound` view (loaded by hrv_analysis.py)

Explodes `supplement_intake` × `supplement_products.ingredients_jsonb` and groups by FDA UNII code (when present). Output: one row per `(intake_date, compound_name, unit)` with summed `amount`. Cross-product summation works correctly: Vitamin C from a multivitamin + a standalone Vitamin C tablet roll up into one row. Pipeline pivots to wide `supplement_<compound>_amount` columns.

### `pds.daily_supplement_matrix` view (exists but NOT joined into the behavioral matrix)

One row per behavioral day with `compounds_jsonb` (`{compound: {amount, unit, category}}` map), `distinct_compounds`, `total_doses`. Loaded directly by `hrv_analysis.py` rather than joined in SQL — same isolation principle as Spotify and the Notion journal.

## Read patterns

- `hrv_analysis.py:load_data` reads `daily_health_matrix_behavioral` (full table scan), `whoop_journal`/`habit_journal` (filtered to dates with HRV target), `supplement_intake_by_compound` (full scan).
- Output writes use `INSERT ... ON CONFLICT DO UPDATE` on natural keys: `(prediction_date, model, horizon_days, model_version)` for predictions; `(eval_date, model, horizon_days, model_version)` for metrics; `(result_type, result_key, computed_at)` for analysis results.
- RLS is enabled on every table; the pipeline uses the service role key to bypass.

## Indexes worth noting

Most indexes are implicit (PKs and FKs). Worth flagging for the audit:

- `pds.hrv_predictions` has no explicit composite index covering `(prediction_date, model, horizon_days)` despite the latest-view ORDER BY that depends on it. Could be a P2 finding for the frontend-queries domain rather than stats.
- `pds.whoop_journal` is filtered by `onyx_behavioral_date` in every pipeline read; whether there's an index on that column is worth checking (the audit can flag it).
