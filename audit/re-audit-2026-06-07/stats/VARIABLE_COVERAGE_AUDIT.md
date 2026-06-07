# HRV Variable-Coverage Audit — 2026-05-21

**Purpose.** Confirm that every variable Onyx collects or computes is considered for the appropriate HRV statistical tests — or has a documented reason to be excluded. The matrix below lists every analyzable column from every data source, the tests it participates in, and (when not tested) the documented rationale or the audit finding.

**Conventions used in this report.**
- **Outcome everywhere** = `whoop_hrv_rmssd.shift(-1)` (next-night WHOOP RMSSD). Garmin `last_night_avg_ms` and Eight Sleep `avg_hrv` are NOT used as outcomes, NOT averaged in, per the documented "HRV columns are not interchangeable" rule.
- **Test abbreviations:** SPR = Spearman global correlation (§2.1, BH-FDR). PCO = partial correlation (§2.3). OLS3 = Stage-3 standardized OLS w/ HAC (§2.4). WJ = Welch's t on journal (§2.5). WH = Welch's t on habits (§2.6). WS = Welch's t on supplements (§2.7, FDR). DR = supplement dose-response Spearman (§2.8, FDR). NUT = nutrition Spearman (§2.9, FDR). GC = Granger top-10 (§2.11). XGB = XGBoost feature pool (§3.1). SHAP-G = global SHAP (§3.2). SHAP-C = controllable-only SHAP (§3.3). PI = permutation importance (§3.5). SAR = SARIMAX exog candidate (§3.6). PRO = Prophet regressor candidate (§3.9). EMJ = error-mode by journal (§3.5.4). EMH = error-mode by habit (§3.5.5). CIb = causal binary AIPW/PSM (Phase 2.5). CIc = causal continuous median-split AIPW/PSM. DM = Diebold–Mariano (model-vs-model, not feature-level).
- **"Auto-admitted"** means the variable falls through the universal Phase-2 numeric gate (≥2 distinct values + ≥30 non-null) and the Phase-3 ≥5%-density gate; no prefix list excludes it.
- **Coverage column** is the answer to the user's question. `Cov ✓` = the variable is genuinely tested. `Excl (rationale)` = excluded intentionally per documented reason. `Gap` = audit finding.

---

## 1. Coverage matrix by data source

### 1.1 WHOOP — Recovery (`pds.whoop_recovery`)

| Variable | Tests it participates in | Coverage |
|---|---|---|
| `whoop_hrv_rmssd` | **TARGET** (outcome shift-1); also kept as Phase-3 feature ("this morning's HRV") | n/a — outcome |
| `whoop_recovery_score` | Phase 2: SPR / WJ / WH / WS / DR / NUT (auto-admitted via numeric gate); Phase 3: **EXCLUDED** (line 2016: "derived from same sleep's HRV — circular") | **Gap (leakage in Phase 2)** — same-sleep mediator. Should be excluded from Phase 2 correlations too. |
| `whoop_rhr` | SPR / OLS3 / SHAP-G / XGB / PI / SAR / PRO candidate; **NOT a causal treatment** | Excl-CIb (mediator: HRV-derived per `causal_inference.py:169-181`) — descriptive coverage OK |
| `whoop_spo2` | SPR / XGB / SHAP-G / OLS3 / PI | Cov ✓ (descriptive only — not a treatment, no causal estimate, but it's an internal physio signal, not behavioral; reasonable) |
| `whoop_skin_temp` | SPR / XGB / SHAP-G / OLS3 / PI | Excl-CIb (mediator); descriptive Cov ✓ |
| `user_calibrating` (bool flag) | Likely auto-admitted if 0/1 but **not a `journal_` prefix** → won't enter WJ; will enter SPR | Cov partial — not a gap (gating flag, not a behavioral variable) |

### 1.2 WHOOP — Cycles & daytime strain (`pds.whoop_cycles`)

| Variable | Tests | Coverage |
|---|---|---|
| `whoop_day_strain` | SPR / OLS3 / SHAP-G / SHAP-C (in CONTROLLABLE prefix) / XGB / PI / **CIc** | Cov ✓ |
| `whoop_kilojoule` | SPR / SHAP-G / XGB / PI / **CIc** | Cov ✓ |
| `whoop_cycle_avg_hr`, `whoop_cycle_max_hr` | SPR / XGB / SHAP-G | **Gap** — not in `CONTINUOUS_TREATMENTS`. Cycle HR is a daytime-physiology summary; could be a meaningful continuous treatment. |
| `start_time`, `end_time` (cycle timing) | Only used to derive bedtime/wake/midpoint hours; the *derived* timing vars are tested but **excluded as causal treatments** (mediator — measured at sleep) | Excl rationale documented |

### 1.3 WHOOP — Sleep (`pds.whoop_sleep`)

| Variable | Tests | Coverage |
|---|---|---|
| `whoop_sleep_duration_milli` | SPR / OLS3 (often top survivor) / SHAP-G / SHAP-C / XGB / PI / PCO control | Excl-CIb (mediator); descriptive Cov ✓ |
| `whoop_sleep_performance`, `whoop_sleep_efficiency`, `whoop_sleep_consistency` | SPR / SHAP-G / XGB / PI | Excl-CI (same-night mediator); descriptive Cov ✓ |
| `whoop_deep_sleep_milli`, `whoop_rem_sleep_milli`, `whoop_light_sleep_milli`, `whoop_awake_milli` | SPR / SHAP-G / XGB / PI | Excl-CI mediator; descriptive Cov ✓ |
| `whoop_disturbances` | SPR / SHAP-G / XGB / PI | Excl-CI mediator; descriptive Cov ✓ |
| `whoop_respiratory_rate` | SPR / SHAP-G / XGB / PI | Excl-CI mediator; descriptive Cov ✓ |
| `total_no_data_time_milli`, `sleep_cycle_count`, `baseline_milli`, `need_from_sleep_debt_milli`, `need_from_recent_strain_milli`, `need_from_recent_nap_milli` | Surfaced via `build_feature_matrix` if `ws_cols` lists them — verify per-column; if surfaced, auto-admitted to SPR/XGB | **Gap to verify** — confirm `ws_cols` actually includes these; if not, they're invisible to the pipeline. |
| `is_nap` | bool, would auto-admit if present | n/a — naps filtered earlier |

### 1.4 WHOOP — Workouts (`pds.whoop_workouts`, aggregated)

| Variable | Tests | Coverage |
|---|---|---|
| `whoop_workout_count`, `total_whoop_strain`, `total_whoop_kilojoule`, `max_whoop_workout_hr`, `avg_whoop_workout_hr`, `total_zone4_5_milli`, `total_zone0_1_milli` | SPR / SHAP-G / XGB / SHAP-C (whoop_workout_ prefix) / PI / **CIc (all 7 listed)** | Cov ✓ |
| `percent_recorded`, `distance_meter`, `altitude_gain_meter`, `altitude_change_meter`, `zone_zero_milli` … `zone_three_milli` (per-workout) | Aggregated into the above; per-workout granularity not preserved | **Gap (minor)** — altitude/distance summed across workouts isn't aggregated into daily features. Probably negligible. |

### 1.5 WHOOP — Journal (`pds.whoop_journal`, ~57 questions)

All 57 yes/no questions are pivoted into `journal_<question>` boolean columns. Tests applied to **every** `journal_*` column:

| Test | Applied? | Notes |
|---|---|---|
| WJ Welch's t | ✓ (all journal_ cols, min 5 Yes + 5 No) | **No FDR correction — audit finding #1 below** |
| SPR | ✓ (auto-admit) | FDR applied here |
| SHAP-G (`feature_importance/shap_journal`) | ✓ | sliced by prefix |
| SHAP-C | ✓ (CONTROLLABLE includes `journal_`) | |
| CIb | ✓ (auto-enumerated, plus lag-1-exclusion guard) | Hard drop <10/arm; flag if <20 |
| EMJ | ✓ | residual breakdown |
| SAR / PRO | One journal column seeded into top_features | density gate: 20% / 25% |
| GC | Only if it lands in the top 10 |r| | |

**Per-question coverage = Cov ✓** for the ~57 questions, **subject to the FDR-asymmetry gap**.

Specific journal questions include (from live `pds.whoop_journal`): all sleep-prep, substance, recovery-intervention, activity, light-exposure, mental-state, and social/context questions enumerated in the agent report (verbatim list in [Appendix A](#appendix-a-full-journal-question-list)).

### 1.6 WHOOP — Body Measurements (`pds.whoop_body_measurements`)

| Variable | Tests | Coverage |
|---|---|---|
| `weight_kg` (derived from `weight_kilogram`) | SPR / SHAP-G / XGB / PI | Excl-CI ("changes too slowly for a daily ATE", `causal_inference.py:179`); descriptive Cov ✓ |
| `bmi` | SPR / SHAP-G / XGB / PI | Excl-CI same rationale; descriptive Cov ✓ |
| `weight_change_7d` | SPR / SHAP-G / XGB | Cov ✓ (descriptive only, not a treatment) |
| `height_meter`, `max_heart_rate` (personal) | Static-ish, derived into BMI / used for zone calculations | n/a — not a daily signal |

### 1.7 Garmin — Daily summary (`pds.garmin_daily_summary`)

| Variable | Tests | Coverage |
|---|---|---|
| `total_steps` | SPR / SHAP-G / SHAP-C / XGB / PI / **CIc** | Cov ✓ |
| `total_distance_meters` | SPR / SHAP-G / XGB / PI | **Gap (minor)** — not in CONTINUOUS_TREATMENTS. Highly collinear with `total_steps` so a single causal estimate may suffice; flag as intentional? |
| `floors_ascended`, `floors_descended` | SPR / SHAP-G / XGB / PI | **Gap** — no causal estimate. Stair-climbing is a controllable behavior; consider adding. |
| `total_kilocalories`, `active_kilocalories`, `bmr_kilocalories` | SPR / SHAP-G / XGB / PI / **CIc** (`total_kilocalories`, `active_kilocalories` only — `bmr_kilocalories` excluded) | `bmr_kilocalories` excl is fine (~constant). Cov ✓ |
| `resting_heart_rate` (garmin_rhr) | SPR / SHAP-G / XGB / PI | Excl-CIb (HRV-derived mediator); descriptive Cov ✓ |
| `min_heart_rate`, `max_heart_rate`, `last_seven_days_avg_rhr` | SPR / SHAP-G / XGB / PI | Excl-CIb same family; Cov ✓ descriptive |
| `avg_stress_level`, `max_stress_level`, `high_stress_duration_min`, `pct_high_stress`, `stress_ratio` | SPR / SHAP-G / XGB / PI / **CIc all 5** | Cov ✓ |
| `rest_stress_duration_min`, `low_stress_duration_min`, `medium_stress_duration_min` | SPR / SHAP-G / XGB / PI | **Gap** — not in CONTINUOUS_TREATMENTS. Asymmetric coverage of stress buckets; low/medium stress could matter for the recovery-state model. Suggest adding. |
| `stress_qualifier` (text label) | Dropped during numeric coerce | **Gap (categorical)** — never one-hot encoded. Audit finding #5. |
| `body_battery_charged`, `body_battery_drained` | SPR / SHAP-G / XGB / PI / **CIc** | Cov ✓ |
| `body_battery_highest`, `body_battery_lowest`, `body_battery_most_recent` | SPR / SHAP-G / XGB / PI | **Gap (minor)** — peak/trough BB not in CIc; intentional? `charged` / `drained` capture the dynamic. |
| `avg_spo2`, `lowest_spo2` | SPR / SHAP-G / XGB / PI | Cov ✓ (descriptive only — internal physio, not a behavior treatment) |
| `avg_waking_respiration`, `highest_respiration`, `lowest_respiration` | SPR / SHAP-G / XGB / PI (if surfaced) | **Gap to verify** — only `avg_waking_respiration` is in the matrix view; `highest_/lowest_respiration` may be dropped at the view. |
| `moderate_intensity_minutes`, `vigorous_intensity_minutes` | SPR / SHAP-G / SHAP-C / XGB / PI / **CIc** | Cov ✓ |
| `intensity_minutes_goal` | Auto-admit | **Gap (low value)** — personal goal field, near-constant. Reasonable to ignore. |
| `highly_active_seconds`, `active_seconds`, `sedentary_seconds` | SPR / SHAP-G / SHAP-C / XGB / PI / **CIc** | Cov ✓ |
| `sleeping_seconds` | Auto-admit | Excl-CI (mediator); descriptive Cov ✓ |
| `abnormal_hr_count` | Auto-admit if present | **Gap (low value)** — rare event; statistical floor likely failed. |
| `min_avg_heart_rate`, `max_avg_heart_rate` | Auto-admit | Cov ✓ descriptive |

### 1.8 Garmin — HRV (`pds.garmin_hrv`)

| Variable | Tests | Coverage |
|---|---|---|
| `garmin_hrv_last_night` | SPR / SHAP-G / XGB / PI; **NOT the model target** | Excl-CIb (different HRV algorithm, but still HRV-derived → mediator); descriptive Cov ✓ |
| `garmin_hrv_weekly_avg` | SPR / SHAP-G / XGB / PI; sparse-rescued | Excl-CIb same; Cov ✓ |
| `garmin_hrv_5min_high` | sparse-rescued via HIGH_VALUE_SPARSE | Excl-CIb; Cov ✓ |
| `garmin_hrv_baseline_low/_high` | sparse-rescued | Excl-CIb; Cov ✓ |
| `hrv_status` (text) | Dropped at numeric coerce | **Gap (categorical)** — qualitative status (Balanced/Unbalanced/Low/Poor/None) is ordinal-meaningful and never encoded. |
| `raw_hrv_readings` (jsonb, 5-min samples) | Not unpacked | **Gap (research opportunity)** — could compute custom RMSSD from raw samples, intraday HRV variability. Audit finding #6. |

### 1.9 Garmin — Stress, HR, Training Status

| Variable group | Tests | Coverage |
|---|---|---|
| `garmin_stress_overall`, `garmin_rest/low/medium/high_stress_sec` (window-level) | SPR / SHAP-G / XGB / PI | Cov ✓ descriptive. **Gap** — high_stress_sec is in daily summary as min; not all bucket-seconds are in CIc. |
| `garmin_hr_zone1_sec` … `garmin_hr_zone5_sec` | SPR / SHAP-G / SHAP-C / XGB / PI; **CIc covers zone_2 through zone_5** | Zone 1 not in CIc — defensible (rest level). Cov ✓ |
| `training_readiness_score`, `_level` | SPR / SHAP-G / XGB / PI; sparse-rescued | Excl-CIb (HRV-derived composite); descriptive Cov ✓ |
| `garmin_acute/chronic_training_load`, `atl_ctl_ratio`, `total_training_load` | SPR / SHAP-G / SHAP-C / XGB / PI / **CIc all 4** | Cov ✓ |
| `garmin_training_load_balance` (text), `garmin_training_status` (text), `garmin_training_status_message` (string), `load_focus` (jsonb) | Dropped at numeric coerce / jsonb unsupported | **Gap (categorical/structured)** — `training_status` ∈ {Productive, Detraining, Maintaining, …} is ordinal-meaningful. Audit finding #5. |
| `garmin_recovery_time_hours`, `_factor`, `garmin_recovery_hr`, `garmin_hrv_factor`, `garmin_sleep_score_factor`, `garmin_sleep_history_factor`, `garmin_stress_history_factor` | SPR / SHAP-G / XGB / PI; sparse-rescued | Excl-CIb (these *are* HRV-derived composites); descriptive Cov ✓ |
| `garmin_vo2_max_running`, `_cycling`, `garmin_fitness_age` | sparse-rescued | Cov ✓ descriptive (slow-changing — appropriately not a daily treatment) |

### 1.10 Garmin — Sleep (`pds.garmin_sleep`)

| Variable | Tests | Coverage |
|---|---|---|
| `garmin_sleep_score`, `garmin_sleep_duration_sec`, `garmin_deep_sleep_sec`, `garmin_light_sleep_sec`, `garmin_rem_sleep_sec`, `garmin_awake_sec`, `garmin_sleep_hr`, `garmin_sleep_respiration`, `garmin_sleep_stress` | SPR / SHAP-G / XGB / PI | Excl-CI (mediator); descriptive Cov ✓ |
| `garmin_deep_pct`, `garmin_rem_pct` (derived) | SPR / SHAP-G / XGB / PI | Excl-CI; descriptive Cov ✓ |
| `quality_score`, `duration_score`, `recovery_score`, `rem_score`, `light_score`, `deep_score`, `restlessness_score`, `sleep_need_seconds`, `sleep_debt_seconds`, `is_nap`, `auto_detected`, `sleep_result_type` | **NOT in the `daily_health_matrix` view** | **Gap to verify** — does `build_feature_matrix` merge these from raw `garmin_sleep`? If not, they're invisible. Audit finding #2. |

### 1.11 Garmin — Activities & Laps (`pds.garmin_activities`, `pds.garmin_activity_laps`, `pds.garmin_workouts`)

| Variable group | Tests | Coverage |
|---|---|---|
| Daily-aggregated: `activity_count`, `total_activity_duration_min`, `total_activity_distance_km`, `total_activity_calories`, `max_aerobic_te`, `max_anaerobic_te`, `total_training_load`, `max_activity_hr`, `avg_activity_hr`, `total_elevation_gain_m`, `latest_vo2_max` | SPR / SHAP-G / SHAP-C (`garmin_activity_`) / XGB / PI / **CIc** | Cov ✓ |
| `is_run_day`, `is_rest_day`, `negative_split` (event-derived bool) | All Phase 2/3 + **CIb (EXPLICIT_BINARY_TREATMENTS)** | Cov ✓ |
| `lap_pace_cv`, `lap_hr_range` (from laps table) | SPR / SHAP-G / XGB / PI | **Gap (minor)** — derived but not in CIc. Pacing consistency is plausibly relevant. |
| Per-activity columns not aggregated: `sport_type`, `avg_power_watts`, `normalized_power`, `avg_speed_mps`, `avg_running_cadence`, `avg_temperature_c`, `performance_condition`, `total_sets/_reps` | Not surfaced | **Gap** — none reach the daily matrix. Particularly power/cadence-of-day for runners could matter. Out-of-scope for v1 but worth noting. |
| `pds.garmin_workouts` (planned templates, not executions) | **Not joined at all** | Excl — defensible (planning ≠ execution). No documented rationale in CLAUDE.md. Audit finding #4. |

### 1.12 Eight Sleep (`pds.eight_sleep_trends`)

| Variable | Tests | Coverage |
|---|---|---|
| `eight_sleep_score`, `eight_sleep_fitness_score` | SPR / SHAP-G / SHAP-C (eight_sleep_) / XGB / PI | Excl-CI (mediator); descriptive Cov ✓ |
| `eight_sleep_hrv`, `eight_sleep_hr`, `eight_sleep_breath_rate` | SPR / SHAP-G / XGB / PI | Excl-CIb (HRV-derived / mediator); descriptive Cov ✓ |
| `eight_sleep_bed_temp`, `eight_sleep_room_temp`, `bed_room_temp_delta` (derived) | SPR / SHAP-G / XGB / PI | **Gap (partial)** — temp is partly environmental input (room temp) and partly mediator (bed temp = body warming the bed). Could split: `eight_sleep_room_temp` is genuinely upstream and could be a continuous treatment. Audit finding #7. |
| `eight_sleep_duration_sec`, `eight_sleep_deep_sec`, `eight_sleep_rem_sec`, `eight_sleep_toss_turns` | SPR / SHAP-G / XGB / PI | Excl-CI mediator; descriptive Cov ✓ |
| `sleep_quality_score`, `_duration_score`, `latency_asleep_score`, `latency_out_score`, `wakeup_consistency_score`, `sleep_routine_score` | If surfaced into the matrix, auto-admit | **Gap to verify** — only some of these reach the matrix. `latency_asleep_score` and `wakeup_consistency_score` are signal-rich. |

### 1.13 MFP — Nutrition (`pds.myfitnesspal_nutrition`)

| Variable | Phase 2 NUT (Spearman, BH-FDR) | Other Phase 2 | Phase 3 | **CIc** | Coverage |
|---|---|---|---|---|---|
| `mfp_calories` | ✓ (in NUTRITION_COLS) | SPR / SHAP-G | XGB / PI | ✓ | Cov ✓ |
| `mfp_protein_g` | ✓ | " | " | ✓ | Cov ✓ |
| `mfp_carbs_g` | ✓ | " | " | ✓ | Cov ✓ |
| `mfp_fat_g` | ✓ | " | " | ✓ | Cov ✓ |
| `mfp_fiber_g` | ✓ | " | " | ✓ | Cov ✓ |
| `mfp_sugar_g` | ✓ | " | " | ✓ | Cov ✓ |
| `mfp_sodium_mg` | ✓ | " | " | ✓ | Cov ✓ |
| `mfp_water_ml` | **✗ MISSING from NUTRITION_COLS** | SPR / SHAP-G / XGB / PI | ✓ | ✓ | **Gap** — see finding #3 |
| `mfp_exercise_kcal` | **✗** | SPR / SHAP-G / XGB / PI | ✓ | ✓ | **Gap** — finding #3 |
| `net_calories` (derived) | **✗** | SPR / SHAP-G / XGB / PI | ✓ | ✓ | **Gap** — finding #3 |
| `protein_pct`, `carb_pct`, `fat_pct` (derived) | **✗** | SPR / SHAP-G / SHAP-C / XGB / PI | ✓ | ✓ | **Gap** — finding #3 |
| `sodium_per_water` (derived) | **✗** | SPR / SHAP-G / XGB / PI | | | **Gap (minor)** — not in CIc either. |
| `meals_json` (per-meal jsonb) | Never unpacked | | | | **Gap (research opportunity)** — meal-timing-of-day extractable. Audit finding #6. |

### 1.14 Supplements (`pds.supplement_intake_by_compound`)

| Variable family | Tests | Coverage |
|---|---|---|
| `supplement_<compound>_amount` (~70 columns, one per UNII compound) | WS Welch's (FDR) / DR dose-response (FDR) / SPR / SHAP-G / SHAP-C (`supplement_` prefix) / XGB / PI / **CIb** (binarized taken/not-taken) | Cov ✓ — by far the most thoroughly tested family |
| `supplements_jsonb` map | Not analyzed as a single field | n/a — replaced by per-compound columns |
| `supplement_distinct_compounds`, `supplement_total_doses` | SPR / SHAP-G / XGB / PI | **Gap (minor)** — not in CIc. Total-doses-per-day could be a useful "stack volume" treatment. |

### 1.15 Habits (`pds.habit_journal`)

| Variable family | Tests | Coverage |
|---|---|---|
| `habit_<habit>` (~13 boolean columns) | WH Welch's (no FDR) / SPR / SHAP-G / SHAP-C (`habit_`) / XGB / PI / **CIb** / EMH | Cov ✓ subject to **no-FDR-on-habit-impact** (finding #1) |

### 1.16 Notion Journal (`pds.journal_entries`)

| Variable | Tests | Coverage |
|---|---|---|
| `mood` (low/neutral/good/great) | None | Excl by design (CLAUDE.md: "Not auto-joined into daily_health_matrix"). **Audit finding #8 — reconsider:** mood is an ordinal pre-bedtime self-report and is plausibly the single most predictive psychological variable. Worth promoting. |
| `confidence` (high/medium/low) | None | Excl by design |
| `word_count` | None | Excl by design |
| `topics` (jsonb tags) | None | Excl by design |
| `source` (voice/typed/remarkable) | None | Excl by design |
| `entry_date`, `title`, `content_md`, `embedding`, `notion_*_at`, `archived` | n/a — provenance / textual / vector | Reasonable |

### 1.17 Spotify (`pds.spotify_daily_signature`, etc.)

| Variable | Tests | Coverage |
|---|---|---|
| `play_count`, `unique_tracks`, `unique_artists`, `total_minutes` | None | Excl by design (CLAUDE.md: "Spotify tables are isolated from health data by design") — Cov ✗ but documented |
| `avg_valence`, `avg_energy`, `avg_tempo`, `avg_danceability`, `avg_acousticness`, `avg_instrumentalness`, `avg_liveness`, `avg_speechiness`, `avg_loudness` | None | Excl by design. **Audit finding #9 — reconsider:** evening music valence/energy is a plausible arousal proxy. Worth promoting if/when listening coverage is solid. |
| `featurized_plays` | n/a — gating metric | |

### 1.18 Derived / engineered (in `build_feature_matrix`)

| Variable group | Tests | Coverage |
|---|---|---|
| HRV lags (`hrv_lag1/2/3`), rolling (`hrv_7d_mean/std`, `hrv_28d_mean/std`, `hrv_z_28d`), `delta_hrv`, `delta_rhr`, `hrv_vs_baseline` | SPR / SHAP-G / XGB / PI; **CIb confounders** (hrv_lag1, hrv_7d_mean) | Cov ✓ (predictive features); explicitly excluded as treatments |
| Personal z-scores (`*_z28d`) | SPR / SHAP-G / XGB / PI | Cov ✓ descriptive; not treatments (correct — they're transforms of mediators) |
| Behavior lags (`whoop_day_strain_lag1`, `_lag2`, `whoop_sleep_duration_milli_lag1`, etc.) | SPR / SHAP-G / XGB / PI; **CIb confounders** | Cov ✓ |
| Calendar (`day_of_week`, `is_weekend`) | SPR / SHAP-G / XGB / PI; CIb confounders | Cov ✓ |
| Training-load ratios + rolling | SPR / SHAP-G / XGB / PI / **CIc** | Cov ✓ |
| Days-since counters (`days_since_alcohol/_sauna/_hard_workout/_rest_day`) and `consecutive_run_days` | SPR / SHAP-G / SHAP-C / XGB / PI / **CIc** | Cov ✓ |
| Sleep debt + stage % (`sleep_debt_7d`, `sleep_debt_ratio`, `*_deep_pct`, `*_rem_pct`, `*_light_pct`) | SPR / SHAP-G / XGB / PI | Excl-CI mediator; descriptive Cov ✓ |
| Nutrition ratios (`protein_pct`, `carb_pct`, `fat_pct`, `net_calories`, `sodium_per_water`) | SPR / SHAP-G / SHAP-C / XGB / PI / **CIc (all except `sodium_per_water`)** | Cov ✓ (but missing from NUT — finding #3) |
| HR-zone pct (`pct_zone_1` … `pct_zone_5`) | SPR / SHAP-G / XGB / PI | **Gap (minor)** — derived % isn't in CIc (raw zone seconds are). Likely fine. |
| Stress derived (`pct_high_stress`, `stress_ratio`) | SPR / SHAP-G / XGB / PI / **CIc** | Cov ✓ |
| Sleep timing (`bedtime_hour`, `wake_hour`, `sleep_midpoint_hour`) | SPR / SHAP-G / XGB / PI | Excl-CI (mediator: measured at sleep itself); descriptive Cov ✓ |
| Body composition (`weight_kg`, `bmi`, `weight_change_7d`) | SPR / SHAP-G / XGB / PI | Excl-CI (slow-changing per docs); Cov ✓ descriptive |
| Workout-to-sleep timing (`last_workout_end_to_sleep_min`, `had_evening_workout`, `whoop_strain_per_hour_to_bed`) | SPR / SHAP-G / SHAP-C / XGB / PI; **CIb (`had_evening_workout`), CIc (the two continuous)** | Cov ✓ |
| Environment (`bed_room_temp_delta`) | SPR / SHAP-G / XGB / PI | **Gap (minor)** — not in CIc. See finding #7. |
| Interaction terms (`alcohol_x_sleep_duration`, `strain_x_caffeine`, `load_x_hrv_lag1`, `room_temp_x_sleep_eff`) | SPR / SHAP-G / XGB / PI | Cov ✓ — not separately tested as treatments (correctly — they're conditional effects, not interventions) |

---

## 2. Audit findings (gaps and inconsistencies)

Ordered by severity / actionability.

### Finding #1 — Multiple-comparison correction is asymmetric across families ⚠ HIGH

- §2.5 `journal_impact/all` (Welch's t, ~57 questions): **no BH-FDR**.
- §2.6 `habit_impact/all` (Welch's t, ~13 habits): **no BH-FDR**.
- §2.7 `supplement_impact/yes_no` (~70 compounds): **BH-FDR applied** (line 1782–1787).
- §2.8 `supplement_impact/dose_response`: **BH-FDR applied**.
- §2.9 `nutrition_impact/spearman`: **BH-FDR applied**.
- §2.1 global Spearman: **BH-FDR applied**.

At ~57 journal tests and α=0.05, ~2.85 false positives are expected by chance. Frontend currently surfaces "significant" results without that correction, which inflates the rate of spurious "journaled X moved your HRV by N ms" claims. **Action:** add `_apply_fdr()` call after the journal-impact and habit-impact loops, matching the supplement pattern.

### Finding #2 — Garmin sleep sub-scores may be invisible to the pipeline ⚠ MEDIUM

The `daily_health_matrix` view does not surface `quality_score`, `duration_score`, `recovery_score`, `rem_score`, `light_score`, `deep_score`, `restlessness_score`, `sleep_need_seconds`, `sleep_debt_seconds`, `is_nap`, `auto_detected`, `sleep_result_type` from `pds.garmin_sleep`. `build_feature_matrix` does merge the raw `garmin_sleep` table on `calendar_date` — but the merge column list (`gs_cols` or equivalent) needs to be verified. **Action:** grep `build_feature_matrix` for `garmin_sleep` merge, confirm which columns are kept.

### Finding #3 — Phase 2 Spearman/NUT is missing 6 nutrition columns that the causal layer treats as first-class ⚠ MEDIUM

`NUTRITION_COLS` (`hrv_analysis.py:1873–1881`) covers only 7 columns; `CONTINUOUS_TREATMENTS` covers 13 (+ derived %). Missing from descriptive `nutrition_impact`: `mfp_water_ml`, `mfp_exercise_kcal`, `net_calories`, `protein_pct`, `carb_pct`, `fat_pct`. Result: the `/analytics/hrv` Nutrition Impact card silently understates the nutrition variable set. **Action:** extend `NUTRITION_COLS` to match.

### Finding #4 — `whoop_recovery_score` is a Phase-2 correlation leak ⚠ MEDIUM

`prepare_ml_data` (line 2016) excludes `whoop_recovery_score` from Phase-3 features as "derived from same sleep's HRV — circular." The same logic applies to Phase 2 Spearman: a correlation between `whoop_recovery_score(today)` and `whoop_hrv_rmssd(tomorrow)` is partly a same-sleep mechanical correlation, and the top-50 Spearman card will surface it as a "driver." **Action:** add `whoop_recovery_score` to the Phase-2 exclusion set, or apply the same exclusion at the `numeric_cols` filter (line 1428–1430).

### Finding #5 — Categorical/qualitative text columns are silently dropped ⚠ MEDIUM

These columns get coerced to numeric and dropped: `stress_qualifier`, `hrv_status` (Garmin), `garmin_training_status`, `garmin_training_load_balance`, `garmin_training_readiness_level`, `garmin_sleep_result_type`, `whoop_score_state`. Several are **ordinal** (e.g., `hrv_status` ∈ {None, Poor, Low, Unbalanced, Balanced}; `garmin_training_status` ∈ {Detraining, Recovery, Maintaining, Productive, Peaking, Overreaching}) and carry information the numeric pipeline can't see. **Action:** one-hot encode the ordinal ones, or hand-encode to integer codes; add them to SPR + XGB.

### Finding #6 — Granger uses raw |Spearman r| top-10 rather than FDR survivors ⚠ LOW (statistical)

Line 1939 picks `corr_df.head(10)` for Granger. If the raw top-10 contains FDR-failed features, Granger results inherit that selection bias. **Action:** use `corr_df[corr_df["passes_fdr"]].head(10)` instead.

### Finding #7 — Phase-2 effective lag is wrong; behaviors aren't lagged ⚠ HIGH (interpretation-affecting)

Phase 2's `STAT_TARGET` is `df[TARGET].shift(-1)` — tomorrow's HRV. But feature columns are read at row N as-is. For `whoop_sleep_duration_milli`, row N already represents *the sleep that produced HRV at row N* (which is shifted forward to become the target at row N-1). So `whoop_sleep_duration_milli(row N)` correlates with `HRV(row N+1)` — that's the wrong sleep relative to the night being predicted. The docstrings claim "behavior on day N → HRV on night N+1." **Confirm what the matrix actually contains.** If `whoop_sleep_duration_milli` at row N is the *previous* sleep, alignment is fine. If it's *that night's* sleep, every same-night mediator is shifted by one row. This is also flagged by `WHOOP_JOURNAL_LAG_DAYS = 0` being marked "unverified" at lines 132–145. **Action:** write an alignment test that picks 5 known-alcohol nights, confirms the alcohol flag is on the row matching the sleep being predicted, and pins it down once.

### Finding #8 — Notion Journal `mood` / `confidence` / `word_count` / `topics` are unused ⚠ MEDIUM (opportunity)

CLAUDE.md documents the exclusion as "isolation principle" but the principle was for *content* / textual / semantic data — not for structured metadata that has clear daily-grain meaning. Pre-bedtime mood is plausibly one of the most informative psychological signals for next-night HRV. **Action (option):** join `journal_entries.{mood, confidence, word_count}` into `daily_health_matrix` on `entry_date` (max-per-date if multi-entry days), encode `mood` ordinally (low=0, neutral=1, good=2, great=3) and `confidence` similarly, and let it flow through SPR + SHAP-G + CIc. Topics could be jsonb-flagged top-N as binary treatments.

### Finding #9 — Spotify is excluded by documented design but worth revisiting ⚠ LOW

CLAUDE.md states Spotify is isolated by design because listening coverage is incomplete (Garmin offline playback is invisible). That rationale is real but doesn't preclude *correlational* analysis on the days where coverage *is* good — the daily-signature view already has a `featurized_plays` gating column. Evening valence/energy/loudness are real arousal proxies. **Action:** consider an opt-in flag that joins `spotify_daily_signature` into the matrix on days where `featurized_plays >= some_threshold`. Phase-2 only at first.

### Finding #10 — Dead/unimplemented gates in `causal_inference.py` ⚠ LOW (code hygiene)

`MIN_CONTINUOUS_N = 50` and `MIN_DISTINCT_DOSES = 3` are declared (lines 119–120) and never referenced. The latter is presumably for a planned per-compound dose-response causal estimator (currently dose-response is only Phase 2.8 descriptive). **Action:** either implement and use them, or delete and add a `# TODO` for the dose-response causal estimator if it's still on the roadmap.

### Finding #11 — Confounders silently dropped if missing ⚠ LOW (silent failure)

`_confounders_for` at `causal_inference.py:491` returns `[c for c in base if c in available_cols]` without warning. If a future schema rename drops `sleep_debt_7d`, adjustment quality degrades invisibly. **Action:** log a warning when a declared confounder isn't found.

### Finding #12 — Raw minute-level jsonb (`raw_hrv_readings`, `raw_hr_values`, `raw_stress_values`) never unpacked ⚠ LOW (opportunity)

Hours of intraday data sit unused. Custom RMSSD, ultra-short-window HRV, stress-onset slope, post-meal HR response are all derivable. Out-of-scope for v1 but flag as a research roadmap item.

### Finding #13 — `pds.garmin_workouts` (planned workout templates) is entirely unused ⚠ LOW

The table holds workout plans (interval pace targets, distances). Not joined anywhere. Probably correct — planning ≠ execution — but CLAUDE.md should state this explicitly to lock in the rationale.

### Finding #14 — A few continuous treatments are notably absent from CIc ⚠ LOW (completeness)

Mentioned inline above; collected here:
- `total_distance_meters` (Garmin) — collinear with steps, probably fine
- `floors_ascended`, `floors_descended`
- `rest_stress_duration_min`, `low_stress_duration_min`, `medium_stress_duration_min`
- `whoop_cycle_avg_hr`, `whoop_cycle_max_hr`
- `body_battery_highest/lowest/most_recent` (peak/trough)
- `lap_pace_cv`, `lap_hr_range` (pacing consistency)
- `eight_sleep_room_temp` (genuinely upstream environmental control)
- `bed_room_temp_delta`
- `supplement_distinct_compounds`, `supplement_total_doses` (stack volume)
- `sodium_per_water` ratio

Pick the ones that match your "actionable lever" model and add them to `CONTINUOUS_TREATMENTS`.

---

## 3. Coverage summary

| Family | Variables | Tested (descriptive) | Tested (causal) | Excluded with documented rationale | Genuine gaps |
|---|---:|---:|---:|---:|---:|
| WHOOP recovery / cycles / sleep | ~25 | 25 | 4 mediators-excluded by design | 21 (mediator excl docs) | 1 (`whoop_recovery_score` leak in Phase 2) |
| WHOOP workouts (aggregated) | 7 | 7 | 7 | — | — |
| WHOOP journal | ~57 | 57 | 57 | — | FDR missing (finding #1) |
| WHOOP body | 3 | 3 | 0 | 2 (slow-changing) | — |
| Garmin daily | ~30 | ~28 | ~12 | RHR family (mediator), stress_qualifier text | 3 (stress buckets not in CIc) + 1 categorical |
| Garmin HRV | 6 | 5 | 0 | All HRV-derived | 1 (`hrv_status` text) + 1 (raw jsonb) |
| Garmin stress/HR/training | ~25 | ~22 | 4 training-load | RHR/training-readiness family (mediator) | 3 categorical/text fields |
| Garmin sleep | ~17 (raw) | partial — verify (finding #2) | 0 | Mediator | sub-scores may be invisible |
| Garmin activities/laps | ~13 daily-derived | 13 | 13 (incl. 3 EXPLICIT binary) | — | lap pacing not in CIc |
| Garmin workouts (planned) | — | 0 | 0 | Not documented | finding #13 |
| Eight Sleep | ~15 | 12 | 0 | Mediator (sleep-quality is post-treatment) | room_temp could be a treatment (finding #7) |
| MFP | 9 + 5 derived | 14 in SPR/XGB/CIc | 13 in CIc | — | `NUTRITION_COLS` misses 6 (finding #3); meals_json unused |
| Supplements | ~70 compounds | 70 | 70 | — | — |
| Habits | ~13 | 13 | 13 | — | FDR missing (finding #1) |
| Notion Journal | 4 structured | 0 | 0 | Documented "isolation principle" | finding #8 — reconsider mood/confidence |
| Spotify daily signature | ~13 | 0 | 0 | Documented coverage gap | finding #9 — reconsider |
| Derived / engineered | ~80 | ~70 | ~30 | Mediators (HRV-lags, sleep-timing, body comp) | minor: pct_zone_*, bed_room_temp_delta |

---

## 4. Recommendations (priority-ordered)

| Priority | Action | Files to edit |
|---|---|---|
| P0 | Add BH-FDR to `journal_impact` and `habit_impact` (Finding #1) | `hrv_analysis.py:1615-1731` |
| P0 | Confirm Phase-2 row-alignment for behavior vs target (Finding #7) — write a one-shot test | new file under `tests/` |
| P0 | Exclude `whoop_recovery_score` from Phase-2 Spearman (Finding #4) | `hrv_analysis.py:1428-1430` |
| P1 | Extend `NUTRITION_COLS` to match `CONTINUOUS_TREATMENTS` (Finding #3) | `hrv_analysis.py:1873-1881` |
| P1 | Verify `garmin_sleep` sub-score visibility in `build_feature_matrix` (Finding #2) | `hrv_analysis.py:build_feature_matrix` |
| P1 | One-hot encode the ordinal text fields: `hrv_status`, `garmin_training_status`, `garmin_training_load_balance`, `garmin_training_readiness_level`, `garmin_sleep_result_type`, `stress_qualifier` (Finding #5) | `build_feature_matrix` |
| P1 | Promote Notion Journal `mood` + `confidence` + `word_count` into the matrix (Finding #8) | `eight_sleep_schema.sql` (matrix view) + `build_feature_matrix` |
| P2 | Switch Granger input from raw top-10 to FDR survivors (Finding #6) | `hrv_analysis.py:1939` |
| P2 | Add the dozen missing CIc candidates (Finding #14) | `causal_inference.py:182-265` |
| P2 | Log warnings when declared confounders are missing (Finding #11) | `causal_inference.py:485-491` |
| P3 | Spotify opt-in join gated on `featurized_plays` threshold (Finding #9) | matrix view + `build_feature_matrix` |
| P3 | Clean up `MIN_CONTINUOUS_N` / `MIN_DISTINCT_DOSES` dead constants (Finding #10) | `causal_inference.py:119-120` |
| P3 | Document `garmin_workouts` exclusion in CLAUDE.md (Finding #13) | `CLAUDE.md` |
| P4 | Custom-RMSSD / intraday HRV from raw jsonb (Finding #12) | new feature module |

---

## Appendix A — Full journal question list

The 57 WHOOP journal questions, all pivoted into `journal_*` columns and tested by WJ + SPR + SHAP-G + CIb + EMJ (subject to per-question 5-Yes/5-No min for WJ, and 10/10 for CIb):

- **Sleep environment / prep (12):** ate_food_close_to_bedtime, dimmed_your_lights_after_sunset, read_non_screened_device_while_in_bed, viewed_a_screen_device_in_bed, slept_in_the_same_bed_as_usual, slept_with_a_nightguard_or_retainer, wore_a_mouthguard_while_sleeping, wore_a_nasal_strip_while_sleeping, wore_a_sleep_mask, wore_ear_plugs_to_bed, wore_mouth_tape_while_sleeping, took_a_hot_shower_before_bed
- **Substances / consumption (10):** consumed_caffeine, consumed_carbohydrates, consumed_magnesium, consumed_protein, took_a_melatonin_supplement, took_a_multivitamin, took_an_anti_inflammatory_drug_nsaids, have_any_alcoholic_drinks, hydrated_sufficiently, tracked_your_calories
- **Recovery / interventions (9):** did_compression_therapy, took_a_cold_shower, took_an_ice_bath, used_a_sauna, received_massage_therapy, practiced_breathwork, spent_time_stretching, meditated, journaled_your_thoughts
- **Activity (3):** did_zone_2_cardio, took_a_rest_day, took_a_vacation_day
- **Light exposure (3):** saw_artificial_light_upon_waking_up, saw_direct_sunlight_upon_waking_up, spend_time_outdoors
- **Mental state (13):** expressed_gratitude, felt_motivated, felt_recovered, felt_energized_throughout_the_day, felt_emotionally_and_mentally_stable, felt_depressed_or_down, felt_irritable, felt_nervous_or_anxious, experienced_stress, experienced_brain_fog, experienced_a_headache, experienced_bloating, feeling_sick_or_ill
- **Social / context (8):** connected_with_family_and_or_friends, had_a_therapy_session, learned_something_interesting_or_important, made_progress_on_an_important_goal, masturbated, traveled_on_a_plane, worked_from_home, worked_late

## Appendix B — Test inventory (quick reference)

| ID | Test | Function | Variable selection rule | FDR | Storage |
|---|---|---|---|---|---|
| 2.1 | Spearman global | `run_statistical_analysis` 1434 | All numeric, ≥30 non-null, ≥2 distinct | ✓ q=0.05 | `correlation/spearman_top50` + `_journal` + `_habit` |
| 2.3 | Partial correlation | 1514 | Top 15 BH-FDR survivors | — | CSV only |
| 2.4 | Standardized OLS + HAC | 1555 | BH-FDR survivors, capped n/k≥20, k≤15 | — | `regression/stage3_standardized_ols` |
| 2.5 | Welch journal | 1615 | `journal_*` cols, ≥5/arm | **✗ (gap)** | `journal_impact/all` |
| 2.6 | Welch habit | 1671 | `habit_*` cols ex-`_lag1`, ≥5/arm | **✗ (gap)** | `habit_impact/all` |
| 2.7 | Welch supplement | 1733 | Per compound, ≥3/arm | ✓ | `supplement_impact/yes_no` |
| 2.8 | Supp dose-response | 1803 | ≥3 distinct doses, ≥20 merged | ✓ | `supplement_impact/dose_response` |
| 2.9 | Nutrition Spearman | 1867 | `NUTRITION_COLS` (7 cols) | ✓ | `nutrition_impact/spearman` |
| 2.10 | ACF / PACF | 1920 | Target only | — | PNG |
| 2.11 | Granger top-10 | 1936 | Top 10 |r| from §2.1 | **✗ (gap — not FDR)** | CSV only |
| 2.12 | Rolling Spearman | 1962 | Top 5 |r| | — | PNG |
| 2.5* | Causal binary | `causal_inference.py:run_causal_battery` | `journal_*`, `habit_*`, `supplement_*_amount`, EXPLICIT_BINARY_TREATMENTS | n/a — per-treatment naive/PSM/AIPW | `causal/binary_treatments` |
| 2.5* | Causal continuous | same | `CONTINUOUS_TREATMENTS` median-split | n/a | `causal/continuous_treatments` |
| 3.1 | XGBoost | `train_xgboost` 2081 | ≥5% density, exclude `{calendar_date,hrv_target_t1,hrv_next,whoop_recovery_score}` | n/a | `hrv_predictions` |
| 3.2 | SHAP global | 2144 | Inherits XGBoost feat pool | n/a | `feature_importance/shap_*` |
| 3.3 | Controllable SHAP | 2242 | `CONTROLLABLE_FEATURE_PREFIXES` | n/a | `feature_importance/shap_controllable` |
| 3.5 | Permutation importance | 2229 | Inherits XGBoost | n/a | `feature_importance/permutation` |
| 3.6 | SARIMAX exog | `train_sarimax` 2297 | Top features ≥20% density, cap 7 | n/a | `hrv_predictions` + `hrv_model_metrics` |
| 3.9 | Prophet regressors | `train_prophet` 2447 | Top features ≥25% density, cap 3 | n/a | `hrv_predictions` + `hrv_model_metrics` |
| 3.5.3 | Diebold–Mariano | 2722 | Hardcoded model pairs | — | `model_comparison/diebold_mariano` |
| 3.5.4 | Error-mode journal | 2781 | `journal_*` flags | — | `model_comparison/error_modes_by_journal` |
| 3.5.5 | Error-mode habit | 2819 | `habit_*` flags ex-`_lag1` | — | `model_comparison/error_modes_by_habit` |
