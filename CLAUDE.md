# Onyx — Claude Code Instructions

Personal health data aggregation and analytics platform.
Syncs biometric data from Garmin, WHOOP, and Eight Sleep into a unified Supabase Postgres database,
visualized via a Next.js frontend with AI-powered analysis through Claude.

## Project Structure

```
Onyx/
├── garmin_etl.py            # Garmin Connect → Supabase (8 tables)
├── whoop_etl.py             # WHOOP API v2 → Supabase (5 tables)
├── whoop_journal_import.py  # WHOOP Journal CSV export → Supabase
├── whoop_journal_email.py   # IMAP monitor: auto-downloads WHOOP export → Supabase
├── whoop_journal_watcher.py # Watches journal_inbox/ for auto-import
├── journal_inbox/           # Drop WHOOP journal CSVs here
├── journal_archive/         # Processed CSVs moved here
├── eight_sleep_etl.py       # Eight Sleep API → Supabase (1 table)
├── myfitnesspal_import.py   # MyFitnessPal CSV → Supabase (nutrition table)
├── myfitnesspal_email.py    # IMAP monitor: auto-imports MFP CSV export emails
├── mfp_inbox/               # Drop MFP nutrition CSVs here for auto-import
├── mfp_archive/             # Processed CSVs moved here
├── spotify_etl.py           # Spotify recently-played → Supabase (plays + tracks + artists w/ MusicBrainz genres)
├── supplement_lookup.py     # NIH DSLD → Supabase (supplement_products dim; CLI: search/seed/seed-from-upc/list)
├── supplement_schema.sql    # supplement_products + supplement_intake + compound rollup views
├── meal_schema.sql          # meal_events + meal_timing_daily view (clock-time meal events for HRV timing analysis)
├── weight_schema.sql        # weight_log: one row per ET day, kg-stored body weight (manual entry from /nutrition)
├── spotify_schema.sql       # Spotify table DDL + spotify_daily_signature view
├── spotify_playlists_schema.sql  # Spotify playlists audit table DDL
├── journal_etl.py           # Notion personal Journal → Supabase (entries + Voyage embeddings)
├── journal_schema.sql       # pds.journal_entries table + search_journal_entries RPC
├── ci_token_helper.py       # Download/upload OAuth tokens for CI
├── sync_log_helper.py       # Shared pds.sync_log writer — always sets sync_start + sync_end + duration
├── retry_helper.py          # Shared httpx retry wrapper: exponential backoff + 429 Retry-After honoring
├── hrv_analysis.py          # HRV deep analysis pipeline (Phases 1-3.5): data loading,
│                            #   ~350-column / ~250-feature matrix, stat analysis, XGBoost/SARIMAX/Prophet,
│                            #   walk-forward backtest, stores results to Supabase
├── causal_inference.py      # Phase 2.5: doubly-robust causal estimates (AIPW + PSM + naive)
│                            #   for every binary + continuous treatment, with E-value sensitivity
│                            #   analysis. Imported by hrv_analysis.py; surfaced as causal/* rows
│                            #   in pds.hrv_analysis_results and rendered on /analytics/hrv.
├── hrv_predict.py           # Daily HRV prediction: loads saved model, predicts tomorrow,
│                            #   backfills actuals, recomputes rolling metrics, drift check
├── hrv_backfill_check.py    # Detects historical backfill (any row with calendar_date older
│                            #   than 2 days, updated since the last hrv_analysis_results
│                            #   computed_at). Emits GitHub Actions output
│                            #   backfill_detected=true|false.
├── requirements-analysis.txt # Python deps for HRV analysis (xgboost, statsmodels, prophet, etc.)
├── analysis_output/         # Generated plots + xgboost_hrv_model.pkl (gitignored)
├── .github/workflows/
│   ├── daily-etl.yml            # Hourly Health ETL: Garmin + WHOOP (`0 * * * *`)
│   ├── eight-sleep-etl.yml      # Eight Sleep ETL — daily at 3 PM ET (`0 19 * * *`)
│   ├── mfp-email.yml            # MyFitnessPal email check (`15 * * * *`)
│   ├── whoop-journal-email.yml  # WHOOP journal email check (`30 * * * *`)
│   ├── journal-sync.yml         # Notion personal Journal sync (`35 * * * *`)
│   ├── habits-sync.yml          # Habits sync from Notion (`45 * * * *`)
│   ├── spotify-etl.yml          # Spotify recently-played (`50 * * * *`)
│   ├── hrv-prediction.yml       # HRV prediction — auto-runs after each ETL via workflow_run, plus guaranteed 23:50 ET finalization (DST-safe)
│   └── hrv-retrain-on-backfill.yml  # HRV Analysis Retrain — hourly backfill check + daily 12:00 UTC safety-net
├── whoop_schema.sql         # WHOOP table DDL
├── eight_sleep_schema.sql   # Eight Sleep DDL + daily_health_matrix view
├── sql/
│   ├── rls_policies.sql     # Row-Level Security policies
│   └── ci_tokens.sql        # CI token storage table
├── ARCHITECTURE.md          # Full system architecture reference
├── .env                     # Secrets (NEVER commit)
└── frontend/                # Next.js 15 app
    └── src/
        ├── app/             # Pages (13 routes; `/` redirects to /status, `/meals` redirects to /nutrition) + API routes
        │   ├── analytics/hrv/  # HRV Analysis dashboard (predictions, SHAP, models)
        │   └── spotify/        # Spotify listening dashboard (volume, mood signature, sonic profile radar, top artists/tracks)
        ├── components/      # AppShell, Sidebar, MobileNav, ChartCard, StatCard
        └── lib/             # Supabase clients, queries.ts, format.ts
```

## Tech Stack

- **ETL**: Python 3, httpx, garminconnect, supabase-py, python-dotenv
- **Database**: Supabase (Postgres 17), schema `pds`, 19 tables + `journal` unified view + 3 HRV analysis tables (`hrv_predictions`, `hrv_model_metrics`, `hrv_analysis_results`) + Spotify (`spotify_plays`, `spotify_tracks`, `spotify_artists`, `spotify_playlists`, `spotify_daily_signature` view) + Supplements (`supplement_products`, `supplement_intake`, `supplement_intake_by_compound` view, `daily_supplement_matrix` view) + Notion personal Journal (`journal_entries` with pgvector embeddings, `search_journal_entries` RPC)
- **Frontend**: Next.js 15, React 19, Tailwind CSS 4, Recharts 3.8, TypeScript 5
- **AI Chat**: Claude Sonnet 4, agentic tool-use loop with 18 tools (11 query + mark_habit_complete + query_journal + query_journal_entries + query_eight_sleep + search_spotify_catalog + query_spotify_tracks_by_features + create_spotify_playlist). Habit completion via chat syncs to both Supabase and Notion. Playlist creation goes via `lib/spotify-server.ts` which refreshes the access token on every call against `pds.ci_tokens` and writes any rotated refresh token back so the Python ETL stays in sync. `query_journal_entries` supports semantic search via Voyage AI embeddings (voyage-3-large) — frontend embeds the user's query at request time, then RPC runs cosine similarity against pre-computed entry embeddings.
- **System Status**: `/status` page — source cards for every ingestion ETL + the HRV Analysis predict path + the **HRV Retrain** card (predict and retrain tracked separately because the predict path keeps writing fresh forecasts from the cached model even when the retrain pipeline crashes — the audit caught the `category`/`categories[]` rename had been breaking every retrain attempt for weeks before this card existed). Each card has a **Method** row (`automated` cyan / `semi-automated` amber-300 / `manual` amber-500) and a Cadence row, KPI summary, 20-entry sync history. The HRV Retrain card derives status from `pds.sync_log` heartbeats emitted by `hrv_analysis.py` (`source='hrv_analysis', data_type='retrain'`), with `MAX(hrv_analysis_results.computed_at)` as fallback for historical runs that predate the heartbeat. >30h since last successful retrain = `failed`, 26-30h = `partial`. **Lesson learned (audit 2026-05-26):** any pipeline that writes to Supabase needs a sync_log heartbeat on EVERY run (success or failure) — without one, silent failures escape monitoring because downstream effects (predictions, dashboards) keep looking healthy via cached state. The `METHOD` map in `api/status/route.ts` is the source of truth for the automated/semi-automated/manual category — semi-automated = cron import that requires a user-triggered export from the source app (WHOOP and MFP have no API export; user must request CSV via the source's web UI, then the IMAP cron picks it up). `GET /api/status` queries `pds.sync_log` by `(source, data_type)` key + `MAX()` date per data table. Auto-refreshes every 60s. ReccoBeats + MusicBrainz are *enrichment* subsystems (not ingestion) — their freshness is based on `sync_start` recency (heartbeat) rather than data age, because "no new items to enrich today" is healthy, not stale. `enrichmentSource()` helper in `api/status/route.ts` encodes that semantics: >12h since last heartbeat = failed, >4h = partial, otherwise success. `spotify_etl.py` writes a sync_log row for each subsystem every run (even with `records_synced=0`).
- **Auth**: Supabase Auth — email + password (primary) with magic link fallback. RLS on all tables. `/account` page exposes `supabase.auth.updateUser({ password })` for self-service password changes.
- **Hosting**: Vercel (frontend), Supabase Cloud (database)

## Commands

```bash
# ETL (runs automatically via GitHub Actions every hour on :00)
python garmin_etl.py                    # Sync last 7 days
python whoop_etl.py                     # Sync last 30 days
python whoop_journal_import.py <csv>    # Import WHOOP journal CSV export
python whoop_journal_email.py --once   # Check email for WHOOP export, import journal
python whoop_journal_watcher.py        # Watch inbox folder for auto-import
python eight_sleep_etl.py               # Sync last 7 days
python myfitnesspal_import.py <csv>     # Import MFP nutrition CSV export
python myfitnesspal_email.py --once    # Check email for MFP export, import
python <etl>.py --backfill N            # Backfill N days
python spotify_etl.py --auth            # One-time Spotify OAuth bootstrap (local)
python spotify_etl.py                   # Sync recently-played (last 50 since high-water mark)
python spotify_etl.py --refeaturize     # Backfill audio features for tracks with NULL valence
python spotify_etl.py --backfill-artists # Enrich every distinct artist in spotify_plays (one-time, after schema change)
python spotify_etl.py --refresh-genres   # Re-fetch MusicBrainz tags for spotify_artists rows with empty genres

# CI Token Management
python ci_token_helper.py upload garmin   # Seed/update Garmin tokens in Supabase
python ci_token_helper.py upload whoop    # Seed/update WHOOP tokens in Supabase
python ci_token_helper.py upload spotify  # Seed/update Spotify tokens in Supabase
python ci_token_helper.py download garmin # Restore Garmin tokens from Supabase
python ci_token_helper.py download whoop  # Restore WHOOP tokens from Supabase
python ci_token_helper.py download spotify # Restore Spotify tokens from Supabase

# GitHub Actions
gh workflow run daily-etl.yml           # Manually trigger ETL workflow
gh workflow run whoop-journal-email.yml # Manually trigger journal email check

# Frontend
cd frontend && npm run dev              # Dev server on :3000
cd frontend && npm run build            # Production build
cd frontend && npm run lint             # ESLint

# Install
pip install garminconnect supabase python-dotenv httpx requests timezonefinder
pip install -r requirements-analysis.txt  # HRV analysis deps
cd frontend && npm install

# HRV Analysis Pipeline (run once or after major data changes)
python hrv_analysis.py                  # Full pipeline: data + stats + models + store
python hrv_analysis.py --skip-analysis  # Skip stat plots (faster retraining)
python hrv_predict.py --predict         # Daily prediction (run after ETL)
python hrv_predict.py --backfill-only   # Just backfill actuals + recompute metrics
gh workflow run hrv-prediction.yml      # Manually trigger daily prediction in CI
```

## Database

- Schema: `pds`
- All tables use upsert with conflict resolution (idempotent ETL)
- `habit_journal` table stores habit completions (same schema as `whoop_journal`)
- `journal` view UNIONs `whoop_journal` + `habit_journal` with a `source` column for unified analysis
- Habit definitions are managed in Notion (Habits DB under Project Onyx, ID: `29cc936fd5e14ae8b10a4fe5c5f7a6cd`)
- Bidirectional sync: completions from Onyx/Chat update both Supabase and Notion; Notion "Last Completed" syncs to Supabase on page load
- `habit_name_map` tracks Notion page ID → name; renaming a habit in Notion auto-updates all historical `habit_journal` entries
- **Backdated habit completions trigger HRV retraining.** A Postgres trigger (`habit_journal_backfill_trigger`, defined in `sql/habit_journal_backfill_trigger.sql`) fires on every INSERT/UPDATE/DELETE on `pds.habit_journal` and emits a `pds.sync_log` row (`source='habit_journal', data_type='backfill_signal'`) whenever the affected `cycle_date` is in the past (ET). `hrv_backfill_check.py` reads this signal alongside its row-scan checks; either path setting `backfill_detected=true` triggers a full `hrv_analysis.py` retrain on the next hourly tick. The trigger covers paths the original row-scan missed: the UPDATE branch of upsert (which doesn't bump `synced_at` because the API call doesn't include it in the patch object) and DELETE (which leaves no row for `WHERE synced_at > last_analysis` to find — relevant when Riley undoes a backdated completion). Today's writes are deliberately suppressed by the trigger; same-day mutations are picked up by the daily safety-net retrain at 12:00 UTC instead, since an hourly retrain on every habit tap would be wasteful.
- **Habits are analyzed as a first-class category in `hrv_analysis.py`** (alongside but separate from journal). The pipeline loads `source` from the unified `pds.journal` view and routes WHOOP entries through `pivot_journal` (`journal_*` columns) and habit completions through `pivot_habits` (`habit_*` columns, label preserved from Notion). After merging, NaN is filled with 0 per-habit from each habit's first completion onward — `habit_journal` only stores one row per completion event, so a missing day means "didn't tap complete" (= 0), not "unknown". Four habit-specific `hrv_analysis_results` rows are written every run: `correlation/spearman_habit`, `habit_impact/all` (Welch's t-test mirroring `journal_impact`), `feature_importance/shap_habit`, and `model_comparison/error_modes_by_habit`. `habit_` is also in `CONTROLLABLE_FEATURE_PREFIXES` (actionable-only SHAP ranking) and in the SARIMAX/Prophet exog seed prefix list. The `/analytics/hrv` dashboard surfaces all four via dedicated Habit sub-sections in Prediction Drivers, HRV Correlates, and a sibling "Habit Impact" card next to Journal Impact. With sparse history (each habit needs ≥5 Yes-nights + ≥5 No-nights for the t-test, and ≥20 non-null days for Spearman) the chart populates incrementally as completions accumulate.
- `myfitnesspal_nutrition` stores daily nutrition totals (calories, macros, fiber, sugar, sodium) + `meals_json` JSONB for per-meal breakdown. Import via CSV export (Settings → Export Data in MFP app). Email automation in `myfitnesspal_email.py` checks inbox every 4h via `mfp-email.yml`. Uses same IMAP credentials as WHOOP journal. Manual: drop CSV in `mfp_inbox/` or run `myfitnesspal_import.py <csv>`.
- `ci_tokens` table stores rotating OAuth tokens for GitHub Actions (Garmin + WHOOP)
- RLS enabled: anon key = read-only, service role key = full access
- Sync operations logged to `pds.sync_log`
- `whoop_journal` data is boolean-only (Yes/No) — WHOOP's CSV export does not include quantity values entered in the app (e.g., "3 drinks", "200mg caffeine"). This is a WHOOP platform limitation.
- HRV analysis tables: `hrv_predictions` (model forecasts + actuals), `hrv_model_metrics` (rolling eval), `hrv_analysis_results` (correlations, journal impact, model comparison as JSON)
- **Multi-horizon XGBoost + baseline backtest (h=1..7).** Previously only SARIMAX wrote multi-horizon rows to `pds.hrv_model_metrics`; XGBoost / baseline_naive / baseline_7d_avg / baseline_dow were `horizon_days=1` only, leaving the "Accuracy by Forecast Horizon" chart with only purple SARIMAX bars at t+2..t+7. Fixed by parameterizing `prepare_ml_data(df, horizon=1)` so the same feature matrix can be paired with `TARGET.shift(-h)` for any h, then iterating h ∈ [1..7] in `run_evaluation`'s walk-forward backtest (XGBoost retrains per fold per horizon; baselines compute per (i, h) — naive/7d_avg are constant across h while DOW shifts with the target weekday). Each h has its own residual std for prediction intervals. The h=1 row of each model is still stored under `eval_results[m_name]` for backward-compat with the headline "Model Comparison" table and CLI prints. Downstream analyses that conflate horizons (Diebold-Mariano paired test, error-mode-by-journal-flag, residual histograms / vs-predicted / DOW plots, rolling-30d-MAE chart) are explicitly filtered to `horizon_days == 1` — they're interpretable only for the headline next-day model. Frontend `getHrvModelMetrics` bumped from `.limit(20)` → `.limit(100)` since one eval_date now writes ~36 rows (xgboost×7 + sarimax×7 + 3 baselines×7 + prophet×1). The chart will populate on the next `python hrv_analysis.py` run or the daily 12:00 UTC retrain. Hyperparameters: h>1 reuses h=1's tuned shape (max_depth=4, lr=0.05, n=200) without per-horizon Optuna so the multi-horizon sweep stays under a few minutes.
- **HRV variable-coverage audit (2026-05-21)** — `docs/hrv_variable_coverage_audit_2026-05-21.md` enumerates every variable from every data source vs every test (Spearman, Welch journal/habit/supplement/nutrition, Granger, XGBoost/SHAP, SARIMAX/Prophet, AIPW/PSM causal). Fixes applied:
  - **BH-FDR added to `journal_impact` and `habit_impact`** (was missing, supplement/nutrition already had it). The frontend `passes_fdr` field is now populated for both — at ~57 journal questions ~3 false positives would otherwise have been reported at α=0.05.
  - **Phase-2 Spearman now excludes the trivial-autocorrelation HRV transforms** (`whoop_hrv_rmssd`, `whoop_recovery_score`, `hrv_lag*`, `hrv_*d_mean/std`, `hrv_z_28d`, `delta_hrv`, `hrv_vs_baseline`) — these were dominating the top-50 drivers chart with persistence rather than behavioral signal.
  - **Granger now uses BH-FDR survivors** as its input top-10 (was raw top-10 by |r|, inheriting multiple-comparison bias).
  - **`NUTRITION_COLS` extended** to match the causal layer's nutrition family (added `mfp_water_ml`, `mfp_exercise_kcal`, `net_calories`, `protein_pct`, `carb_pct`, `fat_pct`).
  - **Ordinal text columns now encoded** instead of silently dropped: `garmin_hrv.hrv_status` → `garmin_hrv_status_ord` (LOW=0, UNBALANCED=1, BALANCED=2); `garmin_training_status.training_readiness_level` → `garmin_training_readiness_level_ord` (POOR=0, LOW=1, MODERATE=2, HIGH=3). `training_readiness_score` (numeric) was referenced in `HIGH_VALUE_SPARSE_FEATURES` but not actually being fetched by the loader — fixed.
  - **Notion Journal mood/confidence/word_count promoted into the matrix** as `nj_mood_ord` (low/neutral/good/great → 0/1/2/3), `nj_confidence_ord` (low/medium/high → 0/1/2), `nj_word_count`, `nj_topic_count`, `nj_entry_count`. Uses `nj_` prefix NOT `journal_` to avoid being misread as a boolean WHOOP journal question by the Welch's t-test and causal binary-enumeration scans. Aggregated per-day via MAX mood (best of the day), MAX confidence, SUM word_count.
  - **Phase-2 alignment regression test** at `tests/test_phase2_alignment.py` synthesizes alcohol→HRV-depression and confirms `journal_alcohol(N)` correlates negatively with `hrv_next(N)` — locks in the behaviors-of-day-X semantics verified on 2026-04-16.
  - **Causal layer additions:** stress buckets (rest/low/medium), floors_ascended, whoop_cycle_avg/max_hr, lap_pace_cv/lap_hr_range, supplement_distinct_compounds/total_doses, eight_sleep_room_temp, and the three new nj_ ordinal columns added to `CONTINUOUS_TREATMENTS`. `_confounders_for` now logs a warning when declared confounders are missing from the matrix (previously silent). `MIN_CONTINUOUS_N=50` is now actually enforced (was declared but never referenced); `MIN_DISTINCT_DOSES` removed (descriptive dose-response stays in Phase 2 only — no causal dose-response estimator).
  - **Spotify daily-signature opt-in:** set `ONYX_INCLUDE_SPOTIFY=1` to include `sp_play_count`, `sp_total_minutes`, `sp_avg_valence`/`_energy`/`_tempo`/`_danceability`/etc. Audio-feature means are zeroed on days with `featurized_plays<5` so thin-sample days don't bias the average. Off by default because of Garmin offline-playback coverage gap (workout-heavy listening is invisible to the recently-played API).
  - **Out of scope (documented):** `pds.garmin_workouts` (planned workout templates — plans ≠ executions, not joined); raw minute-level jsonb (`raw_hrv_readings`, `raw_hr_values`, `raw_stress_values` — research roadmap item for custom RMSSD / intraday HRV).
- **Causal inference layer (Phase 2.5 of `hrv_analysis.py`).** Lives in `causal_inference.py` and runs after the descriptive stats. Treatments span every controllable variable across all data sources — see "Treatment coverage" subsection below. For each treatment the layer estimates the ATE on next-night HRV three ways:
  1. **Naive** — Welch's `mean(Y|T=1) − mean(Y|T=0)`. Same number the existing `journal_impact` / `supplement_impact` / `habit_impact` charts show; included as the unadjusted baseline.
  2. **Propensity Score Matching (PSM)** — 1:3 nearest-neighbor matching on logit propensity from a logistic model fit on the confounders, ATT estimated as the mean within-pair Y difference, CI by paired bootstrap (B=500). Common-support trimming at propensity ∈ [0.05, 0.95].
  3. **AIPW (doubly robust)** — logistic propensity + two Ridge outcome models (one per arm), combined via the AIPW influence function. **Cross-fitting uses `TimeSeriesSplit(n_splits=5)`** (not shuffled KFold — fixed 2026-05-26 after audit finding F-001, where 3-of-3 reviewers caught that shuffled folds let the outcome model see near-future values via `hrv_lag1` and the autocorrelated residual structure, narrowing the IF SE and creating false positives). ATE = mean of per-row influence values. **Two CIs reported alongside each other**: (a) IF-based via `sd(ψ)/√n`, the familiar form consumers expect; (b) **block-bootstrap CI** (`_block_bootstrap_ci`, 7-day blocks × 1000 reps) which resamples contiguous time slices of ψ to preserve autocorrelation the IF SE assumes is i.i.d. The per-treatment `aipw_bb_width_ratio = width(bb_ci) / width(if_ci)` flags treatments where IF SE is too narrow; verification on 108 treatments (`audit/aipw_shift_findings.md`) found median ratio 1.13 with 6 treatments diverging >1.5× (`body_battery_drained`, `medium_stress_duration_min`, `journal_felt_recovered`, etc.) — for those, trust the BB CI. Unbiased if either the propensity or the outcome model is correct.

  **Confounder set** is pre-treatment lag-1 only (`hrv_lag1`, `hrv_7d_mean`, `whoop_day_strain_lag1`, `whoop_sleep_duration_milli_lag1`, `rolling_7d_training_load`, `sleep_debt_7d`, `day_of_week`, `is_weekend`). Supplement family additionally gets `journal_have_any_alcoholic_drinks_lag1` and `journal_consumed_caffeine_lag1` because supplement-conscious days tend to differ in adjacent lifestyle. **Same-night sleep/recovery/HRV-derived variables are DELIBERATELY EXCLUDED** — they are mediators on the very causal path being estimated; adjusting for them would block the effect (mediator-adjustment bias). The reported quantity is therefore the **total effect** (which includes the sleep-quality channel) — the actionable answer for "if I take magnesium tonight, what happens to my HRV tomorrow?"

  **Sensitivity** via the VanderWeele & Ding (2017) E-value — minimum strength on the risk-ratio scale that an unmeasured confounder would need (with both T and Y) to fully explain the estimate away. Continuous outcome → Cohen's d → RR via Chinn (2000): `RR ≈ exp(0.91·d)`, then `E = RR + √(RR·(RR−1))`. Higher = more robust to unmeasured confounding.

  **Cell-size gates:** treatments with fewer than 10 days in either arm are dropped entirely (recorded in `causal/dropped_low_n`); those with 10-19 in either arm are reported but flagged `low_n=true` (rendered with reduced opacity + ⚠ marker on the UI).

  **Storage:** five new rows in `pds.hrv_analysis_results` per run, all under `result_type='causal'`:
  - `binary_treatments` — list of binary-treatment results
  - `continuous_treatments` — list of median-split continuous-treatment results
  - `dag` — declared confounder sets + mediator exclusions + identifying assumptions (rendered as the DAG / Assumptions card on the UI for transparency)
  - `meta` — run metadata (estimator versions, bootstrap reps, fold counts, trim bounds)
  - `dropped_low_n` — treatments excluded for insufficient sample, with reason

  **Frontend:** new "Causal Inference" section on `/analytics/hrv` (between the descriptive impact charts and the Prediction-vs-Actual section) with (a) an explanation card describing purpose + method, (b) a forest plot of binary AIPW ATEs with 95% CI error bars, (c) a naive-vs-adjusted comparison table sorted by absolute attenuation, (d) a continuous-treatment forest plot, and (e) a DAG / Assumptions card rendering the stored DAG payload. Empty until `python hrv_analysis.py` runs.

  **Why this is meaningfully different from the existing correlation / Welch / Granger machinery:** every other test in the pipeline answers *what's associated with* HRV. The causal layer answers *what would change HRV if intervened on*, by adjusting for the lifestyle clustering that confounds the naive comparison (e.g. alcohol nights co-occur with restaurant nights and weekend nights — naive Welch's blames alcohol for the whole pile).

  **Treatment coverage (which variables get a causal estimate):**
  - **Binary treatments** auto-enumerated from the matrix by prefix:
    - `journal_*` (every WHOOP journal yes/no question — ~50 columns when fully populated)
    - `habit_*` (Notion-managed habit completions, dynamic)
    - `supplement_*_amount` (every compound from `pds.supplement_intake_by_compound`, binarized to taken/not-taken — ~50 compounds; most flagged `low_n=true` until tracking history accumulates)
  - **Binary treatments** explicitly listed in `EXPLICIT_BINARY_TREATMENTS` (so they survive renames): `had_evening_workout`, `is_run_day`, `is_rest_day`, `negative_split`.
  - **Continuous treatments** (median-split to put them on the same scale as the binaries), declared in `CONTINUOUS_TREATMENTS`. Covers every daytime/behavioral variable from every data source:
    - *Nutrition (MFP):* calories, protein/carbs/fat (g + % of cals), fiber, sugar, sodium, water, exercise_kcal, net_calories
    - *Daytime strain / activity (WHOOP + Garmin):* WHOOP day_strain, WHOOP kilojoule, steps, total_kcal, active_kcal, moderate/vigorous intensity minutes, highly_active/active/sedentary seconds
    - *Training load:* rolling 3d/7d, acute, chronic, ATL/CTL ratio, total_training_load
    - *Stress (Garmin):* avg / max stress level, high-stress duration, % high stress, stress ratio
    - *Body Battery (Garmin):* charged, drained
    - *Workout timing:* minutes from last workout to bedtime, strain÷hours-to-bed
    - *Workout aggregates (Garmin):* activity_count, duration_min, distance_km, calories, max aerobic/anaerobic TE, max/avg activity HR, total elevation gain
    - *Workout aggregates (WHOOP):* workout_count, total/avg strain, total kJ, peak/avg workout HR, total time in zones 4-5 / zones 0-1
    - *HR zones (Garmin daily):* zone_2 through zone_5 seconds
    - *Recovery state:* days_since_alcohol, days_since_sauna, days_since_hard_workout, days_since_rest_day, consecutive_run_days
  - **DELIBERATELY excluded as treatments** (they are mediators or near-tautological outcomes — see the module's docstring for the full DAG argument): every same-night sleep variable (WHOOP `whoop_sleep_*`, Garmin `garmin_sleep_*`, Eight Sleep `eight_sleep_*`), every HRV-derived variable (`whoop_recovery_score`, `whoop_rhr`, `garmin_rhr`, `whoop_skin_temp`, `hrv_z_28d`), sleep timing recorded from the sleep itself (`bedtime_hour`, `wake_hour`, `sleep_midpoint_hour`), and body-composition (`weight_kg`, `bmi`) which changes too slowly for a daily ATE.
  - **`pds.garmin_workouts` (planned workout templates) is intentionally NOT joined into the HRV pipeline** — it stores scheduled-workout plans (interval targets, distances), not executions. The execution-side data (`garmin_activities` + laps) drives all training-load features. Plans without execution would be noise; executions without plans are still observed.
- `pds.hrv_predictions_latest` view — DISTINCT ON (prediction_date, model, horizon_days) returning freshest row per forecast. **Live (non-backtest) predictions win when both exist for the same date; backtest rows fall through as fallback** — necessary because the daily prediction job only writes ONE row per day (tomorrow's forecast), and the ~57 historical h=1 rows from before the `*_v1` naming convention still carry `model_version='backtest_initial'` despite being genuine day-ahead forecasts. An earlier "WHERE model_version NOT LIKE 'backtest%'" filter hid all of them and emptied the Prediction-vs-Actual chart; the current view tiebreaks via `CASE WHEN model_version LIKE 'backtest%' THEN 1 ELSE 0 END` in `ORDER BY` instead. **All UI/analytics reads should go through the view**; the raw table accumulates multiple runs per day and generic fetches hit row limits fast. DDL in `sql/hrv_predictions_latest.sql`.
- `supabase-py` schema access: always use `supa.schema("pds").from_(table)` — NOT `supa.table()` which defaults to `public`
- `whoop_workouts` has no `cycle_id` column; use `workout_id` + derive `calendar_date` from `start_time` via ET-of-start (see TZ convention below)
- **Timezone convention** — governed by [ADR-0001 — Timezone & Behavioral-Day Handling](docs/adr/0001-timezone-and-behavioral-day-handling.md) ([Notion mirror](https://www.notion.so/36bbf5b44bf281c0895edb425358b458)). Three date types are carried per event:
  - `onyx_et_date` — clock day in `America/New_York` (canonical comparison key, MFP energy-balance semantics).
  - `onyx_behavioral_date` — bedtime-to-bedtime "day of Riley's life" via `(instant_local_tz − 6h)::date` (HRV pipeline, causal layer, behavior-affects-recovery analytics).
  - `onyx_local_date` — clock day in the TZ Riley was physically in (time-of-day features like `meal_last_hour`, `bedtime_hour`, travel-aware dashboard rendering).

  Every source table holding a TIMESTAMPTZ instant carries all three columns plus `onyx_tz_source` (provenance: `source_field | cycle_anchor | user_tz_log | gps_inferred | default_et_fallback`). Source date columns stay untouched (hard constraint). TZ detection ladder: WHOOP `timezone_offset` (free; already in DB) → Garmin activities offset (`start_time_local − start_time_gmt`) → cycle-anchor → `pds.user_tz_log` → ET fallback (flagged).

  **Two parallel `daily_health_matrix` views** since ADR-0001:
  - **`pds.daily_health_matrix_behavioral`** — every source join keyed on `onyx_behavioral_date`. **This is the canonical view for HRV / causal / behavior-affects-recovery analytics.** WHOOP cycle deduplicated via `LATERAL ... LIMIT 1` (longest cycle per behavioral day) so transition-day "arrival nap + main cycle" doesn't double-count. `onyx_is_transition_day` aggregated via `bool_or` across all cycles on the day. Consumers: `hrv_analysis.py`, `causal_inference.py`, `/analytics/hrv`, `lib/queries.ts:getHealthMatrix`. DDL: `sql/adr_0001_08_daily_health_matrix_behavioral.sql`.
  - **`pds.daily_health_matrix`** — original view, **retained for backward-compat.** Used by MFP energy-balance (clock-date semantics by design) and `/status` freshness checks. Spine is `garmin_daily_summary.calendar_date` (Garmin watch local date). DDL: `sql/daily_health_matrix.sql`.

  **`pds.user_tz_log`** — hand-maintained table of TZ transitions. Schema: `(effective_from TIMESTAMPTZ PK, tz TEXT IANA, notes TEXT)`. Insert one row per flight landing into a non-ET zone (and back). NY trips don't need entries (default). Read by `pds.tz_for_instant(ts)` which is used by every non-WHOOP / non-Garmin-activity trigger to derive local TZ.

  **`pds.tz_log_gaps`** — canary view comparing WHOOP `timezone_offset` to `pds.tz_for_instant`. Any disagreeing cycle = "Riley traveled but forgot to log it." `/status` page reads this and renders a yellow banner.

  **Behavioral-day rule** — for any instant `ts` with resolved local TZ:
  - `onyx_behavioral_date = ((ts AT TIME ZONE local_tz) − 6h)::date`
  - Generalizes the existing `whoop_journal.behaviors_date` trigger formula. Pre-midnight bedtimes attribute to today; post-midnight bedtimes (84.4% of nights for Riley) attribute back to yesterday.

  **Legacy view rules** (still apply in `pds.daily_health_matrix`):
  - **Point-in-time events** (workouts, weigh-ins): `(start_time AT TIME ZONE 'America/New_York')::date`
  - **WHOOP cycles** (bedtime-to-bedtime spans): `((start_time + INTERVAL '12 hours') AT TIME ZONE 'America/New_York')::date` — wake-day attribution.
  - **Garmin `start_time_local`**: stored as local wall-clock labeled as UTC (+00); `::date` yields ET date directly.
  - The `hrv_analysis.py` pipeline previously mirrored these rules via `to_date_str()` / `to_et_date_str()` / `to_cycle_et_date_str()` helpers; post-ADR-0001 it reads the behavioral view, so `calendar_date` in the loaded matrix IS `onyx_behavioral_date`.

  **Snapshot for A/B**: `pds_legacy.daily_health_matrix_v0` is a frozen materialization of the pre-ADR view (794 rows), retained for the Phase 2 sensitivity test and rollback if needed.

  **GPS-based TZ auto-population** (ADR-0001 Phase 4 step 4): `gps_tz_backfill.py` scans `pds.garmin_activities` for `(start_latitude, start_longitude)` and inserts new `pds.user_tz_log` rows whenever the GPS-inferred IANA TZ disagrees with what `pds.tz_for_instant` currently returns. Filters out same-UTC-offset cases (e.g. Toronto/Louisville share EDT with NY — geographically distinct but behaviorally identical). Runs automatically at the end of `garmin_etl.py` with `--since <earliest_date_this_run>` to keep the per-run cost ~5s. One-shot full-history sweep available via `python gps_tz_backfill.py --apply`.

  **WHOOP-cycle-based TZ auto-population** (ADR-0001 Phase 4 step 4 extension): `whoop_tz_backfill.py` is the companion path for trips where Garmin GPS doesn't fire (rest trip, no outdoor activity, watch off). Runs automatically at the end of `whoop_etl.py`. Every WHOOP cycle ships a `timezone_offset` (e.g. `-06:00`) — the script detects cycles whose offset disagrees with `pds.tz_for_instant`'s current resolution and inserts new `user_tz_log` rows. Since WHOOP gives offset only (not IANA), the script picks the most-common IANA for that offset from Riley's MANUAL `user_tz_log` entries (history-derived), falling back to a generic offset → IANA map. Same-offset cases skip (no behavioral difference). The notes field tags every auto-insert (`whoop-auto: cycle <id> offset <off>; <provenance>; log was <prior_tz>`) so they're distinguishable from manual entries — and the history-derived defaults computed from ONLY manual entries to avoid bootstrap bias.

  **Resolution priority across the three TZ-population paths**: Manual > GPS-auto > WHOOP-auto. Manual entries are never overridden; the auto scripts only fill gaps. GPS gives exact IANA when available; WHOOP gives offset always. Together they cover essentially every realistic trip without manual maintenance — manual SQL is only needed if both devices are left at home.
- **Supplement intake — behavioral-day convention (NOT clock date).** A `pds.supplement_intake` row's `intake_date` should reflect the **day the intake belongs to behaviorally**, not the wall-clock date of the moment it was taken. A pre-bed supplement consumed at 12:05 AM ET — *before* the user has slept — belongs to the day that just ended, not the new clock date. Rationale (three converging reasons):
  1. **WHOOP cycle alignment.** WHOOP defines a "day" by bedtime-to-bedtime spans (see the `+12h` cycle rule above). The awake-tail period after midnight but before sleep is part of the *previous* cycle, not the new one. Treating supplements the same way keeps the journal × cycle × intake triple consistent.
  2. **HRV pipeline correctness.** `hrv_analysis.py:build_feature_matrix` uses `shift(-1)` to predict HRV(N+1) from behaviors(N). A pre-bed supplement affects the *immediately following* sleep, whose HRV is recorded on cycle_date N+1. To make the shift line up, the intake must be on row N. A naive clock-date attribution at 12:05 AM would silently mis-train the model.
  3. **Stack consistency.** An "evening stack" (mag, melatonin, etc.) that sometimes lands at 11:55 PM and sometimes at 12:05 AM should not split across two rows of `daily_health_matrix` based on a 10-minute clock crossing that has no biological meaning.

  **MyFitnessPal — log on behavioral day via manual backdate (decision 2026-05-25).** Earlier versions of this file said MFP follows "literal clock date" for energy-balance reasons. That was correct under one interpretation (clock-anchored calorie totals) but Riley's PRIMARY use of MFP is HRV/recovery analysis (mfp_* macro features feed `hrv_analysis.py`). For that use case, clock-date attribution creates the same awake-tail misalignment the ADR-0001 rewrite eliminated for every other source: a 1 AM heavy-fat meal would land on the wrong row vs. the HRV measuring its effect. Convention going forward:
  - **When logging a meal in MFP between 00:00 and ~5 AM ET that is genuinely pre-bed (your awake-tail), backdate it to yesterday in the MFP date picker.** The trip is "did I eat this meal before today's behavioral day ended?" — answer yes → log under yesterday.
  - The MFP daily-totals UI will look uneven on backdate days (yesterday shows ~2700 cal, today shows ~1800). That's the cost; the analytical correctness is the benefit.
  - The Onyx side requires no code change: the trigger sets `onyx_behavioral_date = calendar_date`, so behaviorally-logged MFP rows are correctly behavioral-attributed.
  - For pure energy-balance questions ("did I hit 180g protein on May 22?"), MFP's daily totals will reflect Riley's BEHAVIORAL day (May 22 = 10 AM May 22 → 1 AM May 23 clock-time), which is the right semantic for that question too (your fasting window starts at sleep, not at midnight).
  - For the temporal "when did I eat" question, `pds.meal_events` remains the source of truth (it has timestamps; MFP's standard CSV export does not).

  **Operational implications:**
  - `pds.supplement_intake.intake_date` is the canonical join key (behavioral day, ET).
  - `pds.supplement_intake.intake_time TIMESTAMPTZ` stores the truthful clock instant — kept independent of `intake_date` so a 12:05 AM May 21 click attributed to May 20 keeps the accurate timestamp without losing the date semantics.
  - `/supplements` UI: defaults intake_date to the current ET date and the time to the current clock instant, but exposes a manual date override on the quick-tap log flow (so the user can attribute a post-midnight intake to yesterday without going through the edit modal). EditIntakeModal already supports retroactive date adjustment for past intakes.
  - When ingesting historic supplement logs from any other source (Apple Health, manual CSV), the importer must apply the same rule.
- **HRV columns are not interchangeable across sources.** `whoop_recovery.hrv_rmssd_milli` is RMSSD in milliseconds, measured during the WHOOP-detected sleep cycle. `garmin_hrv.last_night_avg_ms` is Garmin's proprietary time-weighted average of 5-minute HRV samples during sleep — *not* RMSSD; the unit is ms but the algorithm is different. `eight_sleep_trends.avg_hrv` is undocumented by Eight Sleep. Treat each as its own variable; never average or substitute.
- **Garmin sleep timestamps:** `garmin_sleep.sleep_start` / `sleep_end` are stored as true UTC instants (`sleepStartTimestampGMT` from the API). The previously-used `*Local` field encoded the local clock as UTC, shifting timestamps by ~4-5h.
- **Spotify tables are isolated from health data by design.** `spotify_plays` + `spotify_tracks` are NOT joined into `daily_health_matrix`. Listening behavior stands on its own; any health correlation happens at view/query time only. `spotify_daily_signature` is a per-ET-date aggregate view (play counts, unique tracks/artists, mean audio features) — frontend reads go through it where possible. PK on `spotify_plays` is `(played_at, track_id)` for idempotent upserts. `played_date_et` is a stored generated column matching the ET-canonical TZ convention.
- **Spotify audio features come from ReccoBeats, not Spotify.** Spotify deprecated `/v1/audio-features` for apps registered after 2024-11-27 (this app is post-cutoff). `spotify_tracks.features_source` records provenance (`'reccobeats'` or null when unresolved). The `spotify_daily_signature` view only computes feature means over plays with non-null valence so partial coverage doesn't bias the signal.
- **Spotify OAuth scope is `user-read-recently-played playlist-modify-private`** — both ingestion (ETL) and write (playlist creation from chat or `/spotify` button) use the same refresh token in `pds.ci_tokens`. If the scope changes, re-run `python spotify_etl.py --auth` then `python ci_token_helper.py upload spotify`; old refresh tokens still work but only carry their original scope claim. The Next.js client (`lib/spotify-server.ts`) writes any rotated refresh token back to `ci_tokens` so the Python ETL stays in sync (rare race: last-write-wins, acceptable for personal scale).
- **Spotify Feb 2026 API migration** affects this codebase. Use the post-migration endpoints in `lib/spotify-server.ts`: `POST /me/playlists` (NOT the removed `POST /users/{user_id}/playlists`) for create, and `POST /playlists/{id}/items` (NOT the removed `/tracks`) for add. Symptom of using the old endpoints is a bare `403 {"error":{"status":403,"message":"Forbidden"}}` with no scope hint. Migration guide: https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide. Development Mode apps additionally require the app owner to have an active Spotify Premium subscription. **Batch GET endpoints (`/v1/artists`, `/v1/tracks`, `/v1/albums`, etc.) were also removed** — same bare-403 symptom; replacement is per-id `/v1/artists/{id}` etc. `spotify_etl.py:SpotifyClient.artists()` already does this with a 50ms sleep between calls.
- **`pds.spotify_playlists`** logs every playlist Onyx creates (one row per `playlist_id`) with `track_ids` JSONB, `created_via` (`'chat'` | `'button'` | `'builder'`), and the originating `prompt` if from chat or builder. Audit + UI history. Not joined to other tables.
- **Playlist generation has three entry points**, all share `lib/spotify-server.ts:createPlaylist`:
  1. `/api/spotify/create-playlist` — one-click "Create from top tracks" button on `/spotify`, no LLM (passes a known track list). `created_via='button'`.
  2. `/api/chat` — general-purpose chat with 3 Spotify tools mixed in alongside health tools. `created_via='chat'`.
  3. `/api/spotify/generate-playlist` — **dedicated SSE-streamed endpoint** behind the "Generate playlist" modal in the `/spotify` page header. Free-text prompt + structured controls (source_pool, vibes[], era, genres[]). Runs a focused agentic loop with the same 3 Spotify tools, but **gates which tools the agent sees by `source_pool`** (`history` → only `query_spotify_tracks_by_features`; `discovery` → only `search_spotify_catalog`; `mix` → both) so the mode can't drift. Streams `status` / `tool_use` / `tool_result` / `message` / `done` / `error` events. `created_via='builder'`.
- **`pds.spotify_artists`** is a dim table for artist enrichment (genres, images). Spotify's Dev Mode `GET /v1/artists/{id}` post-Feb 2026 strips `genres`, `popularity`, and `followers` from the response — only `id/name/images/href/uri` come back. So genres come from **MusicBrainz** (no API key, 1 req/sec, polite User-Agent), looked up by artist name; top match's tags (sorted by user-vote count, top 8) populate `genres` as a JSONB array. Hit rate during initial backfill: 49/51 artists matched. Two artists missed via name-format issues (`JAŸ-Z` diacritic, `¥$` collab project). Refresh empty rows with `python spotify_etl.py --refresh-genres`. Initial seed for existing artists: `python spotify_etl.py --backfill-artists` (Spotify enrich) then `--refresh-genres` (MusicBrainz tags). The regular ETL handles both for new artists. Genre tags are crowdsourced — expect some noise like "british", "2020s", "favorites" mixed in with real genres.
- **`pds.meal_events` captures clock-time meal events for HRV timing analysis.** Deliberately separate from `pds.myfitnesspal_nutrition`: MFP carries macros at daily-totals grain with **no timestamps** (the CSV export drops per-meal times); `meal_events` carries clock-instant grain with **no macros**. The two are joined at view-time. Fact table: `event_id BIGSERIAL`, `event_date DATE NOT NULL` (behavioral-day, ET — same convention as `supplement_intake`; a 12:05 AM pre-bed meal is attributed to the previous day), `event_time TIMESTAMPTZ NOT NULL` (truthful clock instant), `kind TEXT DEFAULT 'last_meal'` (extensible: last_meal | first_meal | snack | other), `notes`, plus auto-touched `created_at` / `updated_at`. View `pds.meal_timing_daily` aggregates one row per ET date with `last_meal_time`, `last_meal_hour` (ET decimal hour 0-23.99, e.g. 19.75 = 7:45 PM), `first_meal_hour`, `eating_window_hours`, `meal_event_count`, `last_meal_kind`, plus the **bedtime-anchored `last_meal_to_bedtime_minutes`** — computed as `whoop_sleep.start_time − last_meal_time` against the WHOOP cycle that closes the behavioral day (the cycle tagged to N+1 via the `+12h` ET rule). The bedtime-anchored metric is what the HRV pipeline reads because it's monotonic in physiological lateness: a 1:30 AM meal + 1:35 AM bedtime resolves to 5 minutes, whereas the raw `last_meal_hour` would invert at midnight (0.083 < 19.75) and confuse any model using it directly. UI lives on `/nutrition` (page renamed to "Nutrition / Meal Timing" on 2026-05-23; previously a standalone `/meals` page which now 301-redirects to `/nutrition`) — single quick-log button defaulting to *now* with manual date AND time overrides. **Post-midnight auto-attribution**: when the user logs between 00:00–04:00 ET, `event_date` defaults to **yesterday** (the behavioral day that's ending pre-bed) with a green explainer banner; tapping "use today instead" overrides. The explainer renders whenever `event_date ≠ ET today` so the date semantics are visible in the act. API is `/api/meals` (GET/POST/PATCH/DELETE). The view is now joined into `daily_health_matrix` as `meal_last_hour`, `meal_first_hour`, `meal_eating_window_hours`, `meal_event_count`, and `meal_last_meal_to_bedtime_min`; `meal_` is in `CONTROLLABLE_FEATURE_PREFIXES` (SHAP-actionable) and `meal_last_meal_to_bedtime_min` + siblings are in `CONTINUOUS_TREATMENTS` in `causal_inference.py` (nutrition family — gets the lifestyle-clustering confounder set). Spearman + SHAP coverage activates automatically once ~18 days of logs clear the 5% non-null filter; AIPW causal estimates require ≥10 days in each median-split arm (and surface with `low_n=true` until 20). Schema in `meal_schema.sql`.
- **`pds.weight_log` stores daily body weight — manual entry from `/nutrition`.** One row per ET date (PK on `log_date`); `weight_kg NUMERIC(6,3) NOT NULL` is the canonical storage unit (matches `whoop_body_measurements.weight_kilogram`). Frontend accepts + displays pounds via `kgToLb`/`lbToKg` helpers — Riley is American but kg keeps the column join-compatible with WHOOP and any future analytics. POST upserts on `log_date` so re-logging the same day overwrites; PATCH edits in place; DELETE removes. API at `/api/weight` (GET/POST/PATCH/DELETE). UI lives in the "Body Weight" section on `/nutrition` (below the MFP macros block) with three KPI tiles (latest, 7d avg, 30d delta in lb), a quick-log card with date override, and a trend chart. **Not joined into `daily_health_matrix` today** — weight changes too slowly for the daily-ATE causal layer (already excluded in `causal_inference.py`); it's a standalone trend store. If we later want weight as a slow-moving covariate (e.g. body comp regressions), join via `LEFT JOIN pds.weight_log wl ON gds.calendar_date = wl.log_date`. Schema in `weight_schema.sql`.
- **"Calories burnt" / daily energy expenditure: WHOOP is the canonical source, not Garmin.** Any UI/query/feature surfacing TDEE reads `pds.whoop_cycles.kilojoule` and converts kJ → kcal via `/4.184`. Tag each cycle to its ET cycle date via the `+12h` rule (matches the timezone convention above). Don't substitute Garmin's `total_kilocalories` even though it covers the same concept — Garmin's BMR + active calc may diverge, and Riley has confirmed WHOOP as the source of record on Onyx. Implementation reference: `frontend/src/lib/queries.ts:getWhoopCaloriesBurnt` and the Calorie Trend / Net Energy Balance charts on `/nutrition`.
- **Supplements: isolated dim/fact tables, joined in Python (NOT in `daily_health_matrix`).** `pds.supplement_products` (dim, JSONB ingredients) + `pds.supplement_intake` (fact, one row per intake event). The DB-level `pds.daily_supplement_matrix` view exists (one row per behavioral-day, with a `compounds_jsonb` map + `distinct_compounds` + `total_doses`) but is **not** LEFT JOINed into `daily_health_matrix_behavioral` — it's loaded directly by `hrv_analysis.py` (read of `supplement_intake_by_compound`) and merged in pandas. Same isolation principle as Spotify + Notion-journal: open-ended compound space + sparse coverage make a per-day SQL JOIN noisy compared to a Python merge that can filter on coverage. If you need supplements alongside other matrix variables, do `LEFT JOIN pds.daily_supplement_matrix dsm ON dsm.calendar_date = dhm.calendar_date` at query time. Compound names come from `pds.daily_supplement_matrix.compounds_jsonb` (a `{compound_name: {amount, unit, category}}` map — query specific compounds with `(compounds_jsonb->'Vitamin D'->>'amount')::numeric`). JSONB rather than hardcoded columns because the compound space is open-ended (50+ across a stack) and a user's supplement list changes — locking schema would be wrong. The underlying `pds.supplement_intake_by_compound` view explodes ingredient JSONB × dose and groups by FDA **UNII** code (when present) so cross-product summation just works: Vitamin C from a multivitamin and a standalone Vitamin C tablet roll up into one row. Product data comes from the **NIH DSLD** (Dietary Supplement Label Database) — public API at `https://api.ods.od.nih.gov/dsld/v9/`, no auth, covers vitamins/minerals/botanicals/nootropics with full ingredient lists. Seed paths: `python supplement_lookup.py search "<query>"` → `seed <dsld_id>`, or `seed-from-upc <upc>`, or the `/supplements` page's search/barcode-scan UI. The Next.js `/api/supplements/*` routes and the Python CLI share parsing logic (`frontend/src/lib/dsld.ts` mirrors `supplement_lookup.py:normalize_label`) so both produce identical rows.
- **Barcode scanning is built-in.** `BarcodeScannerModal` (`@zxing/browser`) opens the rear camera, detects UPC-A/UPC-E/EAN-13, calls back with the digit string. The `/supplements` Add Product flow uses this: scan a bottle → `/api/supplements/search?q=<upc>` → if exactly one hit, single-click seed; else show candidates. Camera resources are torn down on close/detect/unmount to avoid stale streams. Works in any HTTPS browser context — including the PWA standalone shell.
- **Custom-product fallback via photo + Claude vision.** When a product isn't in DSLD (private-label, niche brand, regional SKU), the Add Product modal exposes a "Not in DSLD? Add custom →" link. Flow: snap a photo of the Supplement Facts panel → client-side resize to 1600px JPEG @ 0.85 → `POST /api/supplements/extract-from-photo` (base64) → Claude Sonnet 4 vision reads the label → returns the same `NormalizedProduct` shape DSLD produces. The route prepends a **reference table of (ingredient_group, UNII, category) tuples derived from existing `pds.supplement_products`** to the prompt, so Claude maps extracted ingredients to the user's already-canonical compound vocabulary. A server-side post-pass also backfills `unii_code` + `category` from the reference table for any row Claude returned with a matching `ingredient_group` but null UNII. The extracted product lands in an editable review form (`CustomSupplementFlow.tsx`) where every field — including per-ingredient quantity, unit, UNII, category — can be hand-corrected before save. `POST /api/supplements/custom-product` writes the row with `product_id = "custom_<hex>"` and `dsld_id = null`; `raw_json` carries the Claude usage stats + reference-table size for replay. Cross-product compound rollup in `supplement_intake_by_compound` works transparently because matched UNII codes are the join key. **The photo is never persisted** — it's sent to Anthropic as base64 in the single vision call and discarded after the response. Files: `frontend/src/app/api/supplements/extract-from-photo/route.ts`, `frontend/src/app/api/supplements/custom-product/route.ts`, `frontend/src/components/CustomSupplementFlow.tsx`.
- **Spotify play coverage is incomplete by design.** `recently-played` only contains plays that Spotify's backend received — offline playback from Spotify-licensed partner devices (Garmin watches with downloaded playlists, some car head units, older standalone wearables) does **not** report per-track telemetry back to the account, so those plays are invisible to our ETL, to Wrapped, and to Spotify-generated personalization playlists. Phone/desktop/web app plays are reported in real time and *are* captured. The `/spotify` page surfaces this as a coverage note under the page header so users interpreting the sonic profile / volume / ledger understand the dashboard under-counts Garmin-heavy workout listening. No code-level fix is possible — Spotify's partner SDK simply doesn't pipe the data.
- **`pds.journal_entries` is the personal Notion journal — distinct from `pds.journal` (the WHOOP+habit *behavior* view).** Notion DB "Entries" (ID `96541038264d45aba2a9601d9b175a7e`, parent page "Journal"). One row per Notion page; PK = `notion_page_id`. Properties: `entry_date` (ET-naive — Notion's Date property has no time component), `title`, `mood` (low/neutral/good/great), `source` (voice/remarkable/typed), `confidence` (high/medium/low), `topics` (JSONB array), `content_md` (page body as markdown), `word_count`, `embedding` vector(1024) from Voyage `voyage-3-large`, `archived` (soft-delete). Skip-if-unchanged guard: `notion_edited_at` — ETL only re-fetches blocks / re-embeds when Notion's `last_edited_time` advances. Indexes: B-tree on `entry_date` + `mood`, GIN on `topics`, HNSW (cosine) on `embedding`. RPC `pds.search_journal_entries(query_embedding, date_from, date_to, mood_filter, topic_filters, result_limit)` exposes filtered + similarity-ordered search to the chat tool. **Not auto-joined into `daily_health_matrix`** — same isolation principle as Spotify; cross-analysis happens at query time only. Notion is single write surface (read-only direction, unlike habits which is bidirectional). Sync via `journal_etl.py` hourly at `:35`. Journal DB must be shared with the "SMS Reminders" Notion integration (same blocker as initial habits deployment — `project_onyx_habits.md` memory).

  **When creating a journal entry in Notion (e.g. forwarding a Claude conversation Riley dictated):** the `notion-create-pages` call **must** populate all four metadata properties — `Source`, `Confidence`, `Mood`, `Topics` — plus `Title` and `Date`. Never create a journal page with any of these unset. Parent: `{ type: "data_source_id", data_source_id: "de49562b-652b-4e95-94b1-085dc7ce8c99" }` (the Entries data source under the Journal DB).

  **Field rules** — these mirror the canonical version in the **"Reminders/Habits/Journal Entry"** Claude.ai Project, which is the source of truth for the mobile/web Claude flow. **When changing the rules here, also update that Project's custom instructions to keep both surfaces in sync.**
  - **`Source`** (select: `voice` | `typed` | `remarkable`). DEFAULT `voice` — anything originating from a Claude conversation. Override to `typed` only if the user explicitly says the entry's origin was typed text; `remarkable` only if it came from their reMarkable tablet.
  - **`Confidence`** (select: `high` | `medium` | `low`). Measures the **user's certainty about the entry's content** (NOT transcription confidence — repurposed 2026-05-24; the Notion property description was updated to match). DEFAULT `medium` whenever the entry doesn't clearly signal certainty — never leave blank. `high` for explicit conviction ("I know…", "definitely"); `low` for hedging ("I think maybe…", "could be wrong").
  - **`Mood`** (select: `low` | `neutral` | `good` | `great`). Infer from content; never leave blank. low = negative affect, neutral = informational/flat, good = positive affect, great = strong positive. If torn between adjacent values, pick the lower one.
  - **`Topics`** (multi-select). Prefer existing tags when one fits — current list: `work, relationships, dating, health, gym, running, alcohol, sobriety, mental-health, family, travel, reflection, goals, finance, sleep`. New tags are allowed only when none of the existing ones reasonably fit (don't add "fitness" when "gym" or "running" applies; don't add "anxiety" when "mental-health" applies). At least one tag per entry.
  - **`Title`** (title): short, specific, 3–8 words. Scannable in a list. Avoid generic titles like "Journal Entry" or "Note".
  - **`Date`** (date): today in `America/New_York`, date-only. Override if the user names a different date ("yesterday", explicit date).

  **Body — VERBATIM RULE.** The page body MUST be the user's raw text exactly as they said it. Do NOT summarize, paraphrase, condense, restructure, rewrite for clarity/flow/grammar, remove tangents/repetition/filler, add headings or bullet structure the user didn't provide, or add narrator framing ("Today Riley reflected on…"). The journal is a primary-source record of the user's own words. The ONLY editing allowed: sentence-ending punctuation + commas at clear speech pauses, paragraph breaks at natural topic shifts, capitalization, and unambiguous dictation-typo fixes (e.g. "their"/"there"). The `Title` is where summarization belongs — never let title-style condensation leak into the body. If the user explicitly asks for a summary ("just summarize this", "give me the gist"), summarize — otherwise the body is verbatim.

## Environment Variables

Root `.env` (Python ETL): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY,
GARMIN_EMAIL, GARMIN_PASSWORD, WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET,
EIGHTSLEEP_EMAIL, EIGHTSLEEP_PASSWORD, IMAP_HOST, IMAP_EMAIL, IMAP_APP_PASSWORD,
MFP_USERNAME, MFP_PASSWORD, SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REDIRECT_URI,
NOTION_API_KEY, NOTION_JOURNAL_DB, VOYAGE_API_KEY

`frontend/.env.local`: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY,
SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY, NOTION_API_KEY, NOTION_HABITS_DB, VOYAGE_API_KEY

## Claude Code Permissions

Configured in `.claude/settings.local.json`. Two layers of control:

**Permission Modes** (cycle with Shift+Tab in CLI):
- `default` — prompts for each tool on first use
- `acceptEdits` — auto-approves file edits, still prompts for bash
- `plan` — read-only, no edits or commands
- `bypassPermissions` — skip all prompts (isolated environments only)

**Pre-approved Bash Commands** (run without prompting in any mode):
`python`, `python3`, `pip`, `npm`, `npx`, `node`, `git`, `gh`, `ls`, `pwd`,
`which`, `where`, `find`, `curl`, `export`, `cmd.exe`, `wc`, `diff`, `sort`,
`mkdir`, `cp`, `mv`, `touch`

**Pre-approved Tools**: WebSearch, WebFetch, all Supabase MCP ops, Notion (fetch/search/update/create pages)

**Guard Hooks** (run before every tool call regardless of mode):
- `guard_path.sh` — validates file paths before Write/Edit/NotebookEdit
- `guard_bash.sh` — validates commands before Bash execution

**Not pre-approved** (always prompts): `rm`, `kill`, destructive commands, Supabase project lifecycle ops

## GitHub Actions ETL

All data sources run **hourly** on a staggered schedule to spread load and avoid thundering herds:

| Workflow | File | Cron | What it does |
|---|---|---|---|
| Hourly Health ETL | `daily-etl.yml` | `0 * * * *` | Garmin + WHOOP (2 parallel jobs) |
| Eight Sleep ETL | `eight-sleep-etl.yml` | `0 19 * * *` | Eight Sleep — daily at 3 PM ET (data only updates post-sleep) |
| MyFitnessPal email | `mfp-email.yml` | `15 * * * *` | IMAP check → import MFP nutrition CSV |
| WHOOP journal email | `whoop-journal-email.yml` | `30 * * * *` | IMAP check → import WHOOP journal CSV |
| Notion Journal Sync | `journal-sync.yml` | `35 * * * *` | Notion DB query → upsert + Voyage embed → `pds.journal_entries` |
| Habits sync | `habits-sync.yml` | `45 * * * *` | Curls `POST /api/habits/sync` on Vercel |
| Spotify ETL | `spotify-etl.yml` | `50 * * * *` | Pulls recently-played; upserts plays + tracks; featurizes new tracks via ReccoBeats. Hourly (was 2h) to minimize loss from Spotify's 50-track server-side cap; emits `partial` sync_log status when a run returns exactly 50 items so /status surfaces cap-hit incidents. |
| HRV prediction | `hrv-prediction.yml` | `workflow_run` after hourly ETL + `50 3 * * *` + `50 4 * * *` | Backfills actuals + predicts next day. Hourly workflow_run runs give intra-day monitoring; the two scheduled crons land on 23:50 ET year-round (one per DST state — the `dst-gate` job skips the wrong-season run by checking `TZ=America/New_York date +%H == 23`). The 23:50 ET run captures the final day's imports (Habits at :45, journal at :30, MFP at :15) before ET midnight closes the day. **`hrv_predict.py` uses `et_today()` (`zoneinfo.ZoneInfo("America/New_York")`) for all date arithmetic** — a UTC `date.today()` on the runner would mis-tag the late-ET-evening run as the day-after-next. |
| HRV Analysis Retrain | `hrv-retrain-on-backfill.yml` | `20 * * * *` + `0 12 * * *` | Two triggers: (1) hourly backfill check via `hrv_backfill_check.py` — runs full `hrv_analysis.py` only if any row with `calendar_date < today-2` was updated since last `hrv_analysis_results.computed_at`. (2) Daily unconditional retrain at 12:00 UTC (~8am ET) — safety net so correlations stay fresh even if no backfill ever fires. The decision is made by the "Decide whether to retrain" step that branches on `github.event.schedule` / `github.event_name`. |

Notes:
- **Filename vs. display name**: `daily-etl.yml` kept for git history; workflow display name is **"Hourly Health ETL"**. The `hrv-prediction.yml` `workflow_run` trigger references the display name.
- **Manual trigger**: `gh workflow run <workflow-file>.yml` for any of them.
- **Token persistence**: Garmin/WHOOP tokens stored in `pds.ci_tokens`, managed by `ci_token_helper.py`.
- **Token recovery (Garmin)**: If Garmin tokens expire in CI, re-run ETL locally then `python ci_token_helper.py upload garmin`.
- **Token recovery (WHOOP)**: If WHOOP refresh token expires (400 on token refresh), re-run `python whoop_etl.py --days 7` locally then `python ci_token_helper.py upload whoop`. WHOOP tokens can expire after several days of failed refreshes — check `/status` page for silent failures. Hourly cadence increases risk here — monitor closely.
- **GitHub Secrets**: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GARMIN_EMAIL, GARMIN_PASSWORD, WHOOP_CLIENT_ID, WHOOP_CLIENT_SECRET, EIGHTSLEEP_EMAIL, EIGHTSLEEP_PASSWORD, EIGHTSLEEP_CLIENT_ID, EIGHTSLEEP_CLIENT_SECRET, IMAP_HOST, IMAP_EMAIL, IMAP_APP_PASSWORD, SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET.
- **Spotify bootstrap (one-time, local)**: register app at developer.spotify.com → set redirect URI to `http://127.0.0.1:8888/callback` → put `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` in `.env` → run `python spotify_etl.py --auth` (opens browser) → `python ci_token_helper.py upload spotify`. CI uses `ci_token_helper.py download spotify` at the start of each run and re-uploads after (refresh tokens occasionally rotate).
- **Actions minutes**: Repo is private; hourly schedule is estimated to use ~3000–6000 min/month, likely over the 2000-min free tier. Monitor usage under GitHub → Settings → Billing.

## Conventions

- After making frontend changes, always start the dev server (`cd frontend && npm run dev`) so the user can see updates immediately in the browser
- After completing a task, always commit and push to git — Vercel auto-deploys from `master` (root directory: `frontend`)
- ETL scripts are standalone Python files at the project root (not in a package)
- Frontend follows Next.js App Router conventions (page.tsx per route)
- Supabase queries go in `frontend/src/lib/queries.ts`
- Reusable UI components go in `frontend/src/components/`
- **Sidebar and MobileNav must stay in sync.** `Sidebar.tsx` (desktop) and `MobileNav.tsx` (mobile PWA drawer) maintain independent `nav` arrays — they do not share a source. Any nav change (new route, label, icon, ordering, shortcut) must be applied to **both files** in the same commit, or the mobile app silently falls out of sync. When adding a new route, grep both files (`grep -l "nav = \[" frontend/src/components/`) and update each.
- **Every integration must appear on `/status`.** When adding a new data source (ingestion ETL, enrichment subsystem, manually-driven log like supplements) it is **not done** until it has a card on the System Status page. The change touches three places, all in the same commit:
  1. `frontend/src/app/api/status/route.ts` — add a `MAX(...)` query for the source's data table to the `Promise.all` block, derive a `daysLag`, and append a new entry to the `sources` object. Use `deriveStatus(syncEntry, lag)` for ETL-driven sources, `deriveStatus(null, lag)` for manual-log sources (like habits / supplements where the data date itself is the freshness signal), or `enrichmentSource({label, entry})` for passive enrichment subsystems where "no new items today" is healthy. **Also add entries to the `CADENCE` and `METHOD` maps** — every source must declare its sync cadence and its integration method (`automated` / `semi-automated` / `manual`); semi-automated is reserved for cron imports that depend on a user-triggered export from the source app.
  2. `frontend/src/app/status/page.tsx` — add the source key to `SOURCE_ORDER`, `SOURCE_BADGE`, and `SOURCE_BADGE_COLOR`. If the source writes to `pds.sync_log`, also add it to `HISTORY_SOURCE_LABELS` (and any new `data_type` strings to `HISTORY_TYPE_LABELS`).
  3. If the source has an ETL, emit a `sync_log` heartbeat per run via `log_sync_entry()` (see `spotify_etl.py` for the pattern — Spotify writes three heartbeats per run: `spotify|plays`, `reccobeats|audio_features`, `musicbrainz|artist_tags`). The ETL should log `records_synced=0` rather than skipping the entry on no-op runs, so the status page sees a fresh heartbeat every cycle.
- SQL schema changes: create a .sql file, then apply via Supabase MCP or dashboard
- Always upsert (never raw insert) to keep ETL idempotent
- Never commit secrets (.env files are gitignored)
- **JSONB writes: pass dicts/lists directly to supabase-py; do NOT wrap with `json.dumps()`.** supabase-py serializes dicts to JSONB natively. Wrapping with `json.dumps()` produces a JSONB column whose top-level type is `'string'` rather than `'object'`/`'array'`, silently breaking every downstream JSON path query (`raw_json->>'field'` returns NULL). For dicts containing non-JSON-safe types (datetime, Decimal, numpy floats), use `json.loads(json.dumps(obj, default=str))` to sanitize-then-unwrap instead of double-encoding. Audit pass on 2026-05-26 found this bug at 25+ sites across every ETL and the analysis pipeline; backfilled via `(col #>> '{}')::jsonb` migration (`audit_jsonb_backfill_*`). The `pds.spotify_plays.raw_json` column was the only one that got it right from the start because the Spotify ETL was written after the bug pattern propagated elsewhere.
- **Every Python script that writes to Supabase emits a `pds.sync_log` heartbeat on EVERY run** — success AND failure, including uncaught exceptions. The audit caught silent retrain failures because `hrv_analysis.py` lacked a heartbeat, so its crashes were invisible to `/status`. Pattern: wrap `main()` in try/except in `if __name__ == "__main__"`, call `log_sync_entry(status='success'|'failed', records=N, error=str|None, duration=T)` in both branches. Without this, downstream effects (predictions, dashboards) keep looking healthy via cached state while the upstream pipeline is broken.

## Backlog & Open Items

**Canonical backlog: [Implementation Roadmap (Notion)](https://www.notion.so/bb09c504d2404220acc04ef7db9d9774)** — under AI & Development → Project Onyx → System Architecture. Schema: Task / Component (Database, ETL, Analysis, Visualization, AI/MCP, Security) / Phase (1-4) / Priority (P0-P3) / Status (To Do / In Progress / Blocked / Done) / Notes. Both a table view and a Kanban-by-status view.

**This is the source of truth for "what's open" and "what's next" on Onyx.** Do not track open items in this file — CLAUDE.md is for *shipped* capability + conventions; the roadmap is for *pending* work. When shipping a feature, mark the matching task `Done` (or create-then-Done one in the same call) and refresh its Notes with the commit / module / route. When noticing a bug or polish opportunity you won't fix in the current session, create a `To Do` page with enough context that a future session can pick it up cold.

Mechanics (Claude Code): use the Notion MCP — `notion-update-page` (`command: "update_properties"`, `properties: {"Status": "Done", "Notes": "..."}`) for existing pages; `notion-create-pages` (`parent: {"type":"data_source_id", "data_source_id":"6041b9d9-4bd1-4b7b-9ed9-f9b91fd635fe"}`) for new ones. Always populate all 5 properties.
