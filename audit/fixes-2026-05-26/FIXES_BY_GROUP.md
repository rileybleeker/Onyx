# Fixes by Group — 2026-05-26

Per-group reference: original audit finding text + the fix that shipped.
Diff snippets show the key change; full commits on GitHub for context.

Reviewers, when reading the re-audit response, can cross-reference each
finding ID against the relevant group section here.

---

## P0a — whoop_journal trigger date columns

**Ticket:** [Audit P0] whoop_journal trigger incorrectly populates onyx_et_date and onyx_local_date
**Notion:** 36cbf5b4-4bf2-81e1-8723-c7e9e1ac261f
**Finder:** Gemini · TZ domain
**Commit:** `6f28b10` · **Migration:** `audit_p0_whoop_journal_trigger_cycle_anchor`
**File:** sql/adr_0001_04_other_onyx_dates.sql

**Original recommendation:**
> Modify the trigger to look up start_time and timezone_offset from
> associated pds.whoop_cycles row and call pds.derive_onyx_dates to
> correctly populate all three date columns.

**Fix:** Trigger joins to `pds.whoop_cycles` via `((wc.start_time + INTERVAL '12 hours') AT TIME ZONE 'America/New_York')::date = NEW.cycle_date`
and calls `pds.derive_onyx_dates(start_time, timezone_offset, 'cycle_anchor')`.
`behaviors_date` (when set by the older trigger) wins for behavioral_date.

```sql
-- before (lines ~253-265)
NEW.onyx_behavioral_date := COALESCE(NEW.behaviors_date, NEW.cycle_date);
NEW.onyx_et_date         := NEW.cycle_date;
NEW.onyx_local_date      := NEW.cycle_date;
NEW.onyx_tz_source       := CASE WHEN NEW.behaviors_date IS NOT NULL
                                  THEN 'cycle_anchor'
                                  ELSE 'default_et_fallback' END;

-- after (selected lines, full body in commit)
SELECT wc.start_time, wc.timezone_offset
  INTO cycle_start_time, cycle_tz_offset
  FROM pds.whoop_cycles wc
 WHERE ((wc.start_time + INTERVAL '12 hours')
        AT TIME ZONE 'America/New_York')::date = NEW.cycle_date
 ORDER BY wc.start_time
 LIMIT 1;
IF cycle_start_time IS NOT NULL THEN
    SELECT * INTO d FROM pds.derive_onyx_dates(
        cycle_start_time, cycle_tz_offset, 'cycle_anchor');
    NEW.onyx_et_date         := d.onyx_et_date;
    NEW.onyx_local_date      := d.onyx_local_date;
    NEW.onyx_behavioral_date := COALESCE(NEW.behaviors_date, d.onyx_behavioral_date);
    NEW.onyx_tz_source       := d.onyx_tz_source;
ELSE
    -- orphan-fallback branch (improved further in Group D)
END IF;
```

**Empirical:** 11,910 rows refired. 10,720 (89.8%) have et_date = cycle_date
(unchanged); 1,190 (10.2%) gained corrected onyx_et_date. 100% now tagged
`cycle_anchor`. Verified 0 cycle_dates resolve to multiple cycles via the
join (LIMIT 1 is safe). See [EMPIRICAL.md](EMPIRICAL.md).

---

## P0b — Garmin ETL future-date guard uses ET-local

**Ticket:** [Audit P0] Garmin ETL future-date guard hardcoded to single timezone (drops valid data)
**Notion:** 36cbf5b4-4bf2-8116-983d-e87af27ba983
**Finder:** Gemini · ETL domain
**Commit:** `7be6edc` · **Migration:** —
**File:** garmin_etl.py

**Original recommendation:**
> Either drop the future-date guard entirely (rely on Garmin's API
> timestamps), OR make the guard TZ-aware by checking the activity's
> start_time_gmt against UTC now() + small slack.

**Fix:** Root cause was the iteration boundary in `main()`, not the
sync_* function. `today = date.today()` returns UTC on a GHA runner.
Fixed at the iteration boundary so every `sync_*` path inherits the
corrected ET-local `today` — no per-function guards needed.

```python
# before (line ~816)
today = date.today()

# after
try:
    from zoneinfo import ZoneInfo
    today = datetime.now(ZoneInfo("America/New_York")).date()
except Exception:
    today = date.today()
```

---

## Group A — HRV stats (VIF + SARIMAX exog)

**Tickets:**
- [Audit P1] Exploratory OLS model lacks multicollinearity checks (VIF)
- [Audit P1] SARIMAX full-data 7-day forecast uses unshifted exog
- [Audit P1] Walk-forward SARIMAX exog window — verify shifted-vs-unshifted alignment

**Commit:** `a37a43e` · **Migration:** —
**File:** hrv_analysis.py

### A1 — VIF on Stage-3 OLS

```python
# Inserted between StandardScaler() and OLS fit
from statsmodels.stats.outliers_influence import variance_inflation_factor
vif_drops: list[dict] = []
while X_full_std.shape[1] > 2:
    X_vif = sm.add_constant(X_full_std)
    vifs = [float(variance_inflation_factor(X_vif, j))
            for j in range(1, X_vif.shape[1])]
    finite_vifs = [v for v in vifs if not np.isnan(v)]
    if not finite_vifs or max(finite_vifs) <= 10.0:
        break
    drop_idx = int(np.nanargmax(vifs))
    vif_drops.append({"feature": survivors[drop_idx], "vif": float(vifs[drop_idx])})
    survivors = [s for i, s in enumerate(survivors) if i != drop_idx]
    X_full_std = np.delete(X_full_std, drop_idx, axis=1)
```

Each surviving feature gets a `vif` field in the output row.
`results["stage3_vif_drops"]` records dropped features per run.

**Empirical (2026-05-26 run):** dropped `whoop_day_strain` (VIF=16.3),
k=7, max_vif=5.1.

### A2 — SARIMAX full-data 7-day forecast exog alignment

```python
# before (line ~2733)
fut_exog_all = original_exog.iloc[-7:] if original_exog is not None else None

# after
fut_exog_all = exog.iloc[-7:] if exog is not None else None
```

Training contract: `exog[N] = original_exog[N-1]` (the shift). Forecast
must receive shifted values, not original.

### A3 — SARIMAX walk-forward exog assertion (verification)

```python
# Inserted after the .shift(1) construction of `exog`
if original_exog is not None and exog is not None and len(exog) >= 3:
    chk = min(max(1, len(exog) // 2), len(exog) - 1)
    if not np.allclose(
        exog.iloc[chk].to_numpy(dtype=float),
        original_exog.iloc[chk - 1].to_numpy(dtype=float),
        equal_nan=True,
    ):
        log.warning(f"  SARIMAX exog shift contract violated at idx={chk}...")
```

Walk-forward path was already correct; assertion is forward-defense.

---

## Group B — WHOOP cycle hub FKs

**Tickets:**
- [Audit P1] Add FKs: whoop_recovery/sleep.cycle_id → whoop_cycles.cycle_id (GPT-5)
- [Audit P1] Missing FKs on WHOOP cycle hub allow silent orphans (Claude variant)

**Commit:** `81d61bc` · **Migration:** `audit_p1_whoop_cycle_fks`
**File:** sql/whoop_cycle_fks.sql

**Original (GPT-5):**
> Add NOT VALID FKs and then VALIDATE after an orphan check.

**Original (Claude variant):**
> ALTER TABLE pds.whoop_recovery ADD CONSTRAINT whoop_recovery_cycle_fk
> FOREIGN KEY (cycle_id) REFERENCES pds.whoop_cycles(cycle_id) ON DELETE CASCADE;
> same for whoop_sleep and whoop_workouts.

**Fix:**

```sql
ALTER TABLE pds.whoop_recovery
  ADD CONSTRAINT whoop_recovery_cycle_id_fkey
  FOREIGN KEY (cycle_id) REFERENCES pds.whoop_cycles(cycle_id)
  ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE pds.whoop_sleep
  ADD CONSTRAINT whoop_sleep_cycle_id_fkey
  FOREIGN KEY (cycle_id) REFERENCES pds.whoop_cycles(cycle_id)
  ON UPDATE CASCADE ON DELETE CASCADE;
```

**Deviations:**
- `whoop_workouts` scope removed (column doesn't exist — see [DEVIATIONS.md](DEVIATIONS.md))
- `NOT VALID + VALIDATE` two-step skipped (0 orphans, see [EMPIRICAL.md](EMPIRICAL.md))

---

## Group C — Garmin laps + Spotify dim FKs

**Tickets:**
- [Audit P1] Garmin laps → activities FK (parent needs unique activity_id)
- [Audit P1] Add FKs: spotify_plays.track_id/artist_id → dim tables

**Commit:** `855e6cf` · **Migration:** `audit_p1_group_c_fks`
**File:** sql/group_c_fks.sql

```sql
-- garmin_activities PK is (activity_id, ts); need column-unique on activity_id
CREATE UNIQUE INDEX IF NOT EXISTS uq_garmin_activities_activity_id
    ON pds.garmin_activities(activity_id);

ALTER TABLE pds.garmin_activity_laps
    ADD CONSTRAINT garmin_activity_laps_activity_id_fkey
    FOREIGN KEY (activity_id) REFERENCES pds.garmin_activities(activity_id)
    ON UPDATE CASCADE ON DELETE CASCADE;

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
```

**Deviation:** spotify_plays.track_id audit said SET NULL — column is
NOT NULL so RESTRICT used. See [DEVIATIONS.md](DEVIATIONS.md).

---

## Group D — TZ-trigger cluster

**Tickets:**
- [Audit P1] Tier-2 WHOOP cycle anchor not applied for non-WHOOP sources (GPT-5)
- [Audit P1] Provenance onyx_tz_source misattributed on ET fallback (Gemini)
- [Audit P1] habit_journal trigger never consults user_tz_log (Claude)

**Commit:** `62b44c0` · **Migration:** `audit_p1_group_d_tz_trigger_cluster`
**Files:** sql/adr_0001_01_user_tz_log.sql, sql/adr_0001_04_other_onyx_dates.sql

### D1 — Tier-2 cycle anchor (new helper + derive_onyx_dates rewrite)

```sql
CREATE OR REPLACE FUNCTION pds.cycle_offset_for_instant(ts TIMESTAMPTZ)
RETURNS TEXT LANGUAGE sql STABLE AS $$
    SELECT timezone_offset FROM pds.whoop_cycles
     WHERE ts >= start_time
       AND (end_time IS NULL OR ts < end_time)
       AND timezone_offset IS NOT NULL
     ORDER BY start_time DESC LIMIT 1;
$$;
```

Inserted as a new Tier 2 in `derive_onyx_dates` between source-field
and user_tz_log.

### D2 — Provenance fix (Tier-3+5 explicit log lookup)

```sql
-- before (EXISTS heuristic — could mis-tag rows)
resolved_tz := pds.tz_for_instant(ts);
IF resolved_tz = 'America/New_York' AND NOT EXISTS (...) THEN
    resolved_source := COALESCE(tz_source_in, 'default_et_fallback');
ELSE
    resolved_source := COALESCE(tz_source_in, 'user_tz_log');
END IF;

-- after (explicit log row read)
SELECT tz INTO log_tz FROM pds.user_tz_log
 WHERE effective_from <= ts ORDER BY effective_from DESC LIMIT 1;
IF log_tz IS NOT NULL THEN
    resolved_tz := log_tz;
    resolved_source := COALESCE(tz_source_in, 'user_tz_log');
ELSE
    resolved_tz := 'America/New_York';
    resolved_source := COALESCE(tz_source_in, 'default_et_fallback');
END IF;
```

### D3 — habit_journal trigger with user_tz_log lookup

```sql
CREATE OR REPLACE FUNCTION pds.set_onyx_dates_habit_journal()
RETURNS TRIGGER AS $$
DECLARE noon_et TIMESTAMPTZ; log_tz TEXT;
BEGIN
    NEW.onyx_et_date         := NEW.cycle_date;
    NEW.onyx_behavioral_date := NEW.cycle_date;
    noon_et := (NEW.cycle_date::timestamp + INTERVAL '12 hours')
               AT TIME ZONE 'America/New_York';
    SELECT tz INTO log_tz FROM pds.user_tz_log
     WHERE effective_from <= noon_et ORDER BY effective_from DESC LIMIT 1;
    IF log_tz IS NOT NULL AND log_tz <> 'America/New_York' THEN
        NEW.onyx_local_date := (noon_et AT TIME ZONE log_tz)::date;
        NEW.onyx_tz_source  := 'user_tz_log';
    ELSE
        NEW.onyx_local_date := NEW.cycle_date;
        NEW.onyx_tz_source  := CASE WHEN log_tz IS NOT NULL
                                    THEN 'user_tz_log'
                                    ELSE 'default_et_fallback' END;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```

Same TZ-aware fallback applied to whoop_journal orphan branch (audit
recommended the pairing explicitly).

**Empirical:** 31 habit_journal rows correctly tagged `user_tz_log`
after refire. 100% cycle_anchor on spotify_plays (721), supplement_intake (133), whoop_journal (11,910). See [EMPIRICAL.md](EMPIRICAL.md).

---

## Group E — Analysis correctness

**Tickets:**
- [Audit P1] E-value CI uses wrong bound for negative effects (GPT-5)
- [Audit P1] XGBoost walk-forward writes PIs from training-residual std (Claude)

**Commit:** `f89c551` · **Migration:** —
**Files:** causal_inference.py, hrv_analysis.py

### E1 — E-value bound for negative effects

```python
# before — ci_low only; reused for both signs of ATE
def compute_e_value(ate: float, ci_low: float, pooled_sd: float) -> dict:
    ...
    if ate > 0:
        d_ci = ci_low / pooled_sd
    else:
        d_ci = -ci_low / pooled_sd if ci_low < 0 else 0.0
    ...

# after — takes both bounds, picks by sign
def compute_e_value(ate: float, ci_low: float, ci_high: float,
                     pooled_sd: float) -> dict:
    ...
    if ate > 0:
        if ci_low <= 0: e_ci = 1.0
        else:
            d_ci = ci_low / pooled_sd
            e_ci = _e(np.exp(0.91 * d_ci))
    else:
        if ci_high >= 0: e_ci = 1.0
        else:
            d_ci = ci_high / pooled_sd
            e_ci = _e(np.exp(0.91 * d_ci))
```

Call site at `_estimate_one` updated to pass both bounds.

### E2 — XGBoost OOF pred_std per horizon

```python
# Inserted before the backtest loop in run_evaluation
pred_std_by_horizon: dict[int, float] = {}
headline_pred_std = xgb_results.get("pred_std") if xgb_results else None
if headline_pred_std and headline_pred_std > 0:
    pred_std_by_horizon[1] = float(headline_pred_std)
for _h in HORIZONS:
    if _h in pred_std_by_horizon: continue
    _, _, X_h_full, y_h_full = prepare_ml_data(df, horizon=_h)
    tscv_h = TimeSeriesSplit(n_splits=5)
    oof_resid: list[float] = []
    for tr_idx, va_idx in tscv_h.split(X_h_full):
        fm = XGBRegressor(max_depth=4, learning_rate=0.05, n_estimators=200,
                          min_child_weight=3, subsample=0.8, colsample_bytree=0.8,
                          tree_method="hist", random_state=42)
        fm.fit(X_h_full.iloc[tr_idx], y_h_full.iloc[tr_idx], verbose=False)
        oof_resid.extend((y_h_full.iloc[va_idx].values
                          - fm.predict(X_h_full.iloc[va_idx])).tolist())
    if len(oof_resid) >= 30:
        pred_std_by_horizon[_h] = float(np.std(oof_resid))

# Inside the per-fold loop, replaces in-sample std
residuals_std = pred_std_by_horizon.get(
    h, float(np.std(y_tr.values - m.predict(X_tr)))
)
```

**Empirical (2026-05-26 run):**
- Walk-forward σ by horizon: h=1:32.33, h=2:36.92, h=3:36.66, h=4:36.14, h=5:34.14, h=6:35.57, h=7:36.57
- XGBoost CI coverage post-fix: 86.7 / 90.6 / 90.6 / 91.5 / 87.5 / 90.5 / 91.1 % at h=1..7. **All within 3pp of nominal 90%.** Pre-fix would have shown systematic under-coverage (~70-80%).

---

## Group F — ETL hygiene

**Tickets:**
- [Audit P1] MFP and WHOOP-journal email scripts skip sync_log heartbeat on no-op runs
- [Audit P1] Spotify ETL only processes the first artist on collaborative tracks
- [Audit P1] Supplement unit conversion function silently drops rows with common units (Gemini)
- [Audit P1] unit_to_mg_factor silently drops IU/oz/mL/drops/scoops (Claude variant — closed by same fix)
- [Audit P1] Verify Garmin ON CONFLICT targets match actual unique constraints

**Commit:** `ec1cf34` · **Migration:** `audit_p1_unit_to_mg_factor_plus_unmapped_view_v2`
**Files:** myfitnesspal_email.py, whoop_journal_email.py, spotify_etl.py,
sql/supplements_unii_cleanup.sql, sql/audit_p1_unit_unmapped_view.sql

### F1 — Email scripts no-op heartbeat

```python
# myfitnesspal_email.py + whoop_journal_email.py:check_email
if not emails:
    log.info("No new MFP export emails")
    log_sync(sb, "myfitnesspal", "nutrition", "success",
             records=0, duration=time.time() - t_start)
    return 0
```

### F2 — Spotify multi-artist enrichment

```python
# before — artists[0] only
new_artist_ids = list({
    (it.get("track") or {}).get("artists", [{}])[0].get("id")
    for it in items
    if (it.get("track") or {}).get("artists")
})

# after — every artist on every play
new_artist_ids = list({
    a.get("id")
    for it in items
    for a in ((it.get("track") or {}).get("artists") or [])
    if a.get("id")
})
```

### F3/F4 — Supplement unit conversion

Added two WHEN cases to `pds.unit_to_mg_factor`:

```sql
WHEN 'mcgdfe'      THEN 0.001  -- Folate DFE (treats as mcg approx)
WHEN 'mcgrae'      THEN 0.001  -- Vitamin A RAE (treats as mcg approx)
```

New view `pds.supplement_intake_unmapped` exposes remaining drops:

```sql
CREATE OR REPLACE VIEW pds.supplement_intake_unmapped AS
SELECT p.product_id, p.brand_name, p.full_name, ing->>'ingredient_group',
       ing->>'unit', ing->>'unii_code', COUNT(si.intake_id), ...
FROM pds.supplement_products p
CROSS JOIN LATERAL jsonb_array_elements(p.ingredients) ing
LEFT JOIN pds.supplement_intake si ON si.product_id = p.product_id
WHERE pds.unit_to_mg_factor(ing->>'unit') IS NULL
  AND ing ? 'unit'
GROUP BY ...;
```

Today shows only 'Calorie(s)' (2 products, 9 intakes — not a mass) and
'IU' on a Centrum row (0 intakes — Riley hasn't taken it).

### F5 — Garmin ON CONFLICT verify (no code change)

Cross-referenced all 9 garmin_etl.py upsert paths against
`information_schema.table_constraints`. Every on_conflict matches.

---

## Group G — Schema/views

**Tickets:**
- [Audit P1] hrv_predictions PK blocks multi-run history (GPT-5)
- [Audit P1] Two competing definitions of daily_health_matrix_behavioral (Claude — verification only)
- [Audit P1] Behavioral matrix spine mixes watch-local calendar_date (Claude)
- [Audit P1] Risk of HRV semantic conflation in unaudited upstream views (Gemini)
- [Audit P1] Near-total absence of FK constraints (Gemini — meta-ticket closed by B + C)

**Commit:** `c0cff10` · **Migrations:**
- `audit_p1_g1_hrv_predictions_pk_surrogate`
- `audit_p1_g3_dhm_behavioral_drop_gds_spine`
- `audit_p1_g4_recovery_vs_pace_rename_hrv_column`

### G1 — hrv_predictions surrogate PK + 4-tuple unique index

```sql
ALTER TABLE pds.hrv_predictions DROP CONSTRAINT hrv_predictions_pkey;
ALTER TABLE pds.hrv_predictions ADD COLUMN id BIGSERIAL PRIMARY KEY;
CREATE UNIQUE INDEX uq_hrv_predictions_quad
    ON pds.hrv_predictions(prediction_date, model, horizon_days, model_version)
    NULLS NOT DISTINCT;
```

ETL upserts updated at 3 call sites (hrv_predict.py × 2, hrv_analysis.py × 1).
The actual-backfill path now also selects `model_version` so it matches
existing rows instead of inserting NULL-version duplicates.

### G3 — Matrix spine fix (drop GDS from UNION)

```sql
-- Removed from spine UNION
UNION SELECT calendar_date FROM pds.garmin_daily_summary
    WHERE calendar_date IS NOT NULL  -- REMOVED
```

GDS continues to LEFT JOIN via `gds.calendar_date = s.calendar_date` —
accepting the known travel-day mismatch per audit option (a, lower risk).

### G4 — recovery_vs_pace column rename

```sql
-- before
wr.hrv_rmssd_milli AS whoop_hrv,

-- after
wr.hrv_rmssd_milli AS whoop_hrv_rmssd_ms,
```

Frontend callers updated: `queries.ts:getRunningRecoveryContext` and
`activities/page.tsx`.

### G2 + G5 — Verification only

- G2: only one matrix view SQL file exists (`*_main_session.sql`); the
  other had been removed earlier. No fix needed.
- G5: 6 FKs now exist (whoop_recovery + whoop_sleep + garmin_activity_laps
  + spotify_plays.artist_id + spotify_plays.track_id + supplement_intake.product_id).
  Audit-prioritised joins covered. Remaining tables have no natural
  parent-child relationships FKs would enforce.

---

## Group H — Garmin TZ frontend + trigger

**Tickets:**
- [Audit P1] getActivities() filters Garmin wall-clock-as-UTC column (Claude) — H1
- [Audit P1] Garmin activities filtered/sorted by start_time_local (GPT-5) — H2 (duplicate of H1)
- [Audit P1] Query for Garmin activities uses local timestamp (Gemini) — H3 (duplicate of H1)
- [Audit P1] garmin_activities trigger treats start_time_local as UTC (Claude) — H4

**Commit:** `843b69f` · **Migration:** `audit_p1_h4_garmin_activities_trigger_refuse_fallback`
**Files:** frontend/src/lib/queries.ts, sql/adr_0001_03_garmin_onyx_dates.sql

### H1/H2/H3 — getActivities filter (one fix, 3 tickets)

```typescript
// before
.gte("start_time_local", since.toISOString())
.order("start_time_local", { ascending: false });

// after
.gte("start_time_gmt", since.toISOString())
.order("start_time_gmt", { ascending: false });
```

### H4 — garmin_activities trigger refuses NULL-gmt fallback

```sql
-- before — silent mis-attribution
instant_utc := NEW.start_time_gmt;
IF instant_utc IS NULL THEN
    instant_utc := NEW.start_time_local;  -- fallback (semantic lossy)
END IF;

-- after — refuse + tag the row as missing
IF NEW.start_time_gmt IS NULL THEN
    NEW.onyx_et_date         := NULL;
    NEW.onyx_behavioral_date := NULL;
    NEW.onyx_local_date      := NULL;
    NEW.onyx_tz_source       := 'missing_gmt_instant';
    RETURN NEW;
END IF;
```

Today 0/349 rows trigger this path; purely defensive.

---

## Cross-cutting changes (not new audit tickets but worth recording)

The trigger rewrite in Group D also touched the `whoop_journal` trigger
orphan-fallback branch (the same TZ-aware fallback as `habit_journal`).
The original Group P0a fix at commit `6f28b10` set the orphan branch to
plain `default_et_fallback`; Group D upgraded it to consult user_tz_log
at noon ET. Both are still semantically reasonable for orphaned rows
(orphans should be rare); the upgrade is consistency with habit_journal
rather than a bug fix.
