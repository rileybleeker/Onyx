# Empirical Validation — 2026-05-26

Concrete data points captured before/during/after the session. These are
the ground-truth checks that a re-audit reviewer cannot reproduce
(because they're reading code, not querying the DB).

When the re-audit returns: if a finding contradicts one of these data
points, dig deeper.

---

## XGBoost CI coverage (Group E most consequential validation)

Audit ticket recommendation: "Verify pds.hrv_model_metrics.ci_coverage
matches nominal after the fix." Nominal target: 90% (PIs at ±1.645σ).

After Group E fix (commit `f89c551`), eval_date `2026-05-26`:

| Horizon | n_predictions | CI coverage | CI avg width (ms) |
|---|---|---|---|
| h=1 | 332 | **86.7%** | 106.4 |
| h=2 | 331 | **90.6%** | 121.5 |
| h=3 | 330 | **90.6%** | 120.6 |
| h=4 | 329 | **91.5%** | 118.9 |
| h=5 | 328 | **87.5%** | 112.3 |
| h=6 | 327 | **90.5%** | 117.0 |
| h=7 | 326 | **91.1%** | 120.3 |

All seven horizons land within ~3pp of the 90% nominal target. Pre-fix
behavior used in-sample training residuals (tight by construction);
expected pre-fix coverage 70-80%.

Per-horizon σ (computed via TimeSeriesSplit OOF on the full feature
matrix once, before the backtest loop):

```
Walk-forward pred_std by horizon:
  h=1:32.33, h=2:36.92, h=3:36.66, h=4:36.14,
  h=5:34.14, h=6:35.57, h=7:36.57
```

σ scales sensibly with h. h=1 matches the value `train_xgboost` computed
independently (reuse path works).

---

## TZ-source distribution across affected tables (Group D refire)

After migration `audit_p1_group_d_tz_trigger_cluster` (commit `62b44c0`):

| Table | rows | tz_source distribution |
|---|---|---|
| whoop_journal | 11,910 | 100% `cycle_anchor` |
| spotify_plays | 721 | 100% `cycle_anchor` |
| supplement_intake (w/ intake_time) | 133 | 100% `cycle_anchor` |
| meal_events (w/ event_time) | 4 | 100% `cycle_anchor` |
| journal_entries (w/ notion_created_at) | 5 | 100% `cycle_anchor` |
| journal_entries (entry_date only) | 38 | 100% `default_et_fallback` |
| habit_journal | 31 | 100% `user_tz_log` |

The `cycle_anchor` dominance reflects that nearly every instant Riley
records falls inside a WHOOP cycle's range. The 100% `user_tz_log` on
`habit_journal` is interesting — it means every habit completion to date
has a matching user_tz_log entry (Riley has been disciplined about
logging TZ transitions). The 38 `default_et_fallback` journal entries
are date-only Notion entries with no `notion_created_at` instant.

---

## Sanity test cases for derive_onyx_dates (Group D)

Three canonical cases — output should be identical pre/post-fix:

| Case | onyx_et_date | onyx_behavioral_date | onyx_local_date | onyx_tz_source |
|---|---|---|---|---|
| NY 11:55 PM ET bedtime | 2026-05-23 | 2026-05-23 | 2026-05-23 | cycle_anchor* |
| NY 00:30 ET awake-tail | 2026-05-24 | 2026-05-23 | 2026-05-24 | cycle_anchor* |
| Berlin 23:00 CEST with offset | 2026-05-01 | 2026-05-01 | 2026-05-01 | source_field |

*pre-fix would have been `default_et_fallback`; the date values are
unchanged.

---

## Orphan checks (Groups B + C)

Pre-migration orphan counts (all proposed FKs):

| Table.column → parent | Orphans | Rows |
|---|---|---|
| whoop_recovery.cycle_id → whoop_cycles | 0 | 573 |
| whoop_sleep.cycle_id → whoop_cycles | 0 | 827 |
| garmin_activity_laps.activity_id → garmin_activities | 0 | 3849 |
| spotify_plays.track_id → spotify_tracks | 0 | 721 |
| spotify_plays.artist_id → spotify_artists | 0 | 721 |

Zero orphans across all 5 relationships → plain `ADD CONSTRAINT`
applied (no `NOT VALID + VALIDATE` two-step needed).

---

## VIF prune (Group A, 2026-05-26 run)

Stage-3 OLS on the BH-FDR-survivor set:

- Probed top 30 survivors → joint-non-null sample n=253
- k_max_for_n = 12 (n/20 floor); capped at 15 → start with k=12
- VIF iteration: dropped `whoop_day_strain` (VIF=16.3 > 10)
- Final: n=253, k=7, obs/predictor=36.1, R²=0.287, max_vif=5.1

`results["stage3_vif_drops"]` is now populated per run.

---

## hrv_predictions PK semantic test (Group G1)

Post-migration, the schema accepts multiple rows per
(prediction_date, model, horizon_days) when model_version differs:

```sql
-- This now succeeds (was forbidden under the old composite PK):
INSERT INTO pds.hrv_predictions
    (prediction_date, model, horizon_days, model_version, predicted_hrv)
VALUES ('2026-05-27', 'xgboost', 1, '2026-05-27_v1', 127.0);
INSERT INTO pds.hrv_predictions
    (prediction_date, model, horizon_days, model_version, predicted_hrv)
VALUES ('2026-05-27', 'xgboost', 1, '2026-05-27_v2', 128.0);
-- Both lands; same triple, different versions.
```

`NULLS NOT DISTINCT` on the unique index ensures we can't accidentally
end up with multiple null-version rows for the same triple.

ETL upsert paths (hrv_predict.py + hrv_analysis.py) targeting the
4-tuple succeeded on the 2026-05-26 pipeline run.

---

## Final DB state summary

| Metric | Value | Note |
|---|---|---|
| `pds` schema FK count | **6** | up from 1 pre-session |
| `pds.hrv_predictions` rows | 11,047 | +2 from session pipeline run |
| `pds.whoop_journal` rows (cycle_anchor) | 11,910 / 11,910 (100%) | refired by D migration |
| `pds.spotify_plays` rows (cycle_anchor) | 721 / 721 (100%) | refired by D migration |
| `pds.habit_journal` rows (user_tz_log) | 31 / 31 (100%) | refired by D migration |
| `pds.supplement_intake_unmapped` rows | 5 | 2 Calorie + 3 IU (0 intakes) |
| Migrations applied this session | 8 | all `audit_p[01]_*` named |
| Commits this session | 9 | `6f28b10` through `843b69f` |

---

## Pipeline run timing

`python hrv_analysis.py` end-to-end on 2026-05-26:

- Start: ~18:50 ET
- End: ~19:42 ET
- Wall time: ~52 minutes
- Exit code: 0
- Warnings: 1 (pre-existing matplotlib "SARIMAX plot failed" — not
  related to any audit fix)
- Errors: 0

Phases:
- Data load + feature engineering: ~6 min
- Phase 2 stats + Stage 3 OLS (with VIF prune): ~4 min
- SARIMAX + Prophet: ~3 min
- **Phase 3.5 walk-forward backtest (largest phase):** ~32 min
  - Per-horizon OOF pred_std (NEW): ~5 min total upfront
  - 7 horizons × ~6 min each = ~42 min, parallelized somewhat
- Causal inference (E-value validates here): ~5 min
- DB storage + plots: ~2 min
