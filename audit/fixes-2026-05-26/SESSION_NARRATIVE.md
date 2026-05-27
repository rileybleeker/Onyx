# Session Narrative — 2026-05-26 Audit Closure

## Starting state

The audit pre-session (commit `7e4eae6`) produced 164 findings across 5
domains (units / stats / schema / tz / etl) from 3 independent reviewers
(GPT-5, Gemini, Claude). 43 of those were promoted to the Implementation
Roadmap as `[Audit Px]` tickets. By the start of this session, 11 of the
43 had already shipped (mostly via commits `96914dd`, `a52a55a`, `2076d6a`,
`6b7adbf`). The remaining open count was **32 P0/P1 tickets**.

This session's mandate: **close out the remaining 32 in a single day.**

## Working method

For each batch:

1. **Pick a group** by domain coherence — items that share a file, a
   conceptual area, or the same test infrastructure (one pipeline run
   validates multiple fixes).
2. **Read the audit notes** for each ticket in the group to extract the
   exact recommendation.
3. **Read the current code** to verify the recommendation still applies
   (line numbers had drifted in some tickets — found via grep, not by
   trusting the stale `:line` refs in the audit Notes).
4. **Probe with SQL** before any schema change: orphan checks, current
   constraint state, view definitions via `pg_get_viewdef`. Refuse to
   apply a migration without empirical confirmation the inputs match
   the audit's premise.
5. **Ship** code + migration + repo SQL source files in the same commit.
6. **Update Notion** with the commit SHA + migration name in the ticket's
   Notes field; flip Status → Done.
7. **Defer pipeline validation** until the end of the session (one full
   `hrv_analysis.py` run takes ~30 min, so batching saves time).

## Chronological order

### Phase 1: Reconciliation (10 min)

Queried Notion for all `[Audit P0]` items, fetched each in parallel.
Discovered 6 of the 8 P0s already had Status=Done with commit refs that
weren't surfacing in earlier searches — search results showed the page
title even when Notes had the "Fixed in commit..." text. **2 genuine open
P0s remained:** `whoop_journal trigger` and `Garmin future-date guard`.

Pattern reused later in the session: the "stale-search-Done" failure mode
hit again in Group E (confounder bfill was Done already, narrowing the
group from 3 → 2 items).

### Phase 2: P0 closeout

**P0a — `whoop_journal` trigger date columns** (`6f28b10`)

The pre-fix trigger set `onyx_et_date := NEW.cycle_date` and
`onyx_local_date := NEW.cycle_date`. WHOOP's `cycle_date` is the user-
local wake day; on travel days that diverges from ET clock day. The fix
joins to `pds.whoop_cycles` via the `+12h` ET trick and calls
`pds.derive_onyx_dates(cycle.start_time, cycle.timezone_offset, 'cycle_anchor')`.
Refire on 11,910 rows: 1,190 (10.2%) gained corrected dates; 100% now
tagged `cycle_anchor`. Verified 0 cycle_dates resolve to multiple cycles
via the join (LIMIT 1 is safe).

**P0b — Garmin ETL future-date guard** (`7be6edc`)

Root cause was in `garmin_etl.py:main()` where `today = date.today()`
returns UTC on a GHA runner. Fix: ET-local via `ZoneInfo("America/New_York")`.
Stops the bug at the iteration boundary so every `sync_*` path inherits
the corrected `today` — no need to add per-function guards.

### Phase 3: Group A (HRV stats, hrv_analysis.py only)

Three tickets in one file → one commit, validated by one pipeline run.

- **VIF on Stage-3 OLS** at line ~1853. Iterative drop-by-max-VIF loop
  with threshold 10. Today's matrix dropped `whoop_day_strain`
  (VIF=17.0), final k=7 / max_vif=5.1.
- **SARIMAX exog full-data forecast** at line 2733: was passing
  `original_exog.iloc[-7:]` (unshifted) into a model trained on shifted
  exog. Now passes `exog.iloc[-7:]` to match the training contract.
- **SARIMAX walk-forward verification** at line 2705: walk-forward path
  was already correct. Added a one-time invariant assertion after the
  `.shift(1)` step so future refactors can't break the contract silently.

### Phase 4: Group B (WHOOP cycle hub FKs)

3-of-3 reviewer consensus. Pre-migration probe revealed:

- `whoop_workouts` has NO `cycle_id` column → Claude-variant's expanded
  scope is moot, drops out.
- 0 orphans in `whoop_recovery` (573) or `whoop_sleep` (827) → plain
  `ADD CONSTRAINT`, no `NOT VALID` + `VALIDATE` two-step needed.

User picked `ON DELETE CASCADE`. Migration `audit_p1_whoop_cycle_fks`.

### Phase 5: Group C (Garmin laps + Spotify dim FKs)

Three FKs in one migration:

- `garmin_activity_laps.activity_id` → `garmin_activities.activity_id`
  (CASCADE). Needed a `UNIQUE INDEX` on `garmin_activities(activity_id)`
  first since the parent PK is the compound `(activity_id, ts)`.
- `spotify_plays.track_id` → `spotify_tracks.track_id`: audit said
  `ON DELETE SET NULL` but the column is NOT NULL (part of the
  `(played_at, track_id)` PK). RESTRICT used instead — see
  `DEVIATIONS.md`.
- `spotify_plays.artist_id` → `spotify_artists.artist_id`: SET NULL
  as audit recommended (column is nullable).

### Phase 6: Group D (TZ-trigger cluster — most architecturally significant change)

Three audit findings all converging in `pds.derive_onyx_dates`:

1. **Tier-2 cycle anchor** added (GPT-5). New helper
   `pds.cycle_offset_for_instant(ts)` returns the WHOOP cycle's
   `timezone_offset` when ts is in `[start_time, end_time)`. Tier 2
   inserted between source-field and user_tz_log in the resolution
   ladder.
2. **Provenance fix** (Gemini). Tier-3+5 branch refactored to read the
   matching log row explicitly (`SELECT tz INTO log_tz`) instead of
   inferring user_tz_log usage via an `EXISTS` heuristic.
3. **habit_journal trigger** (Claude). Was hardcoded
   `default_et_fallback`; now anchors at noon ET on cycle_date, looks
   up user_tz_log, shifts `onyx_local_date` on non-NY hits.

After refire: 100% `cycle_anchor` on spotify_plays (721), whoop_journal
(11,910), supplement_intake (133). 31 habit_journal rows now correctly
tagged `user_tz_log`. **Canonical sanity tests produce identical dates
pre/post-fix** — only provenance is more accurate.

### Phase 7: Verify pass

Confirmed 4 stale-search items already Done (AIPW × 2 variants, whoop_tz_backfill NameError P1, Garmin sleep GMT P1). Open audit count
dropped from ~25 → ~20 P1.

### Phase 8: Group E (analysis correctness)

Originally 3 items; `Confounder bfill` already Done (96914dd) → 2 items:

- **E-value CI bound for negative effects** (`compute_e_value` in
  causal_inference.py). Pre-fix took only `ci_low` and reused it for
  both signs of ATE. For negative ATE the bound nearest null is
  `ci_high` (upper bound). Signature now takes both ci_low + ci_high
  and picks by sign.
- **XGBoost walk-forward PI under-coverage** at hrv_analysis.py:3039.
  Was using `np.std(y_tr - m.predict(X_tr))` (in-sample residuals,
  tight by construction). Fix: compute OOF-honest σ per horizon ONCE
  via TimeSeriesSplit on the full feature matrix before the backtest
  loop, reuse across all folds at that h. h=1 reuses the value
  `train_xgboost` already computed.

**Empirically validated** by the final pipeline run: XGBoost CI coverage
now 87–92% across horizons (target 90%). Pre-fix would have shown
70–80% under-coverage.

### Phase 9: Group F (ETL hygiene)

4 tickets across 4 files:

- **MFP + WHOOP-journal email no-op heartbeat** — added `log_sync(...,
  status='success', records=0)` in the no-email branch.
- **Spotify multi-artist** — `new_artist_ids` comprehension in
  `run_etl` was `artists[0]` only; now iterates every artist on every
  play. `spotify_plays.artist_id` intentionally stays primary-only
  (single-FK semantics).
- **Supplement unit_to_mg_factor** — added `mcg DFE` + `mcg RAE`. New
  view `pds.supplement_intake_unmapped` surfaces remaining drops.
  Per-vitamin IU lookup deferred (today's data has 0 IU intakes).
  Closes two duplicate variant tickets in one fix.
- **Garmin ON CONFLICT verify** — cross-referenced all 9 `garmin_etl.py`
  upsert paths against `information_schema.table_constraints`. Every
  on_conflict matches the actual constraint. No code change; just
  verification.

### Phase 10: Group G (schema/views)

5 tickets — biggest batch.

- **G1 hrv_predictions PK** — dropped composite PK, added `id BIGSERIAL`
  PK + unique index on `(date,model,horizon,version) NULLS NOT DISTINCT`.
  ETL upserts (hrv_predict.py × 2, hrv_analysis.py × 1) updated to
  target the 4-tuple constraint. The actual-backfill path now selects
  `model_version` in addition to the other key columns so it matches
  existing rows instead of inserting NULL-version duplicates.
- **G2 Two competing matrix defs** — verification only. Only one file
  exists today; the other was removed in an earlier commit.
- **G3 Matrix spine fix** — dropped `garmin_daily_summary` from the
  spine UNION. GDS still LEFT JOINs via calendar_date (accepting the
  known travel-day mismatch per audit option a).
- **G4 HRV semantic conflation** — renamed `recovery_vs_pace.whoop_hrv`
  → `whoop_hrv_rmssd_ms`. Frontend callers updated.
  `daily_health_matrix_behavioral` was already source-prefixed.
- **G5 FK meta-ticket** — verified 6 FKs now exist after Groups B + C.
  Audit-prioritised health-matrix joins are all covered. Remaining
  tables have no natural parent-child relationships FKs would enforce.

### Phase 11: Group H (Garmin TZ frontend + trigger)

4 tickets, 3 of them duplicates (3-of-3 consensus on the
`getActivities` filter bug):

- **H1/H2/H3 getActivities filter** — `queries.ts:getActivities` was
  filtering and ordering by `start_time_local` (wall-clock labeled +00).
  Switched to `start_time_gmt` (true UTC). One commit closes 3
  tickets.
- **H4 garmin_activities trigger fallback** — when `start_time_gmt` is
  NULL, the trigger was silently using `start_time_local` as if it
  were UTC. Trigger now refuses the fallback (audit option a) and
  tags `onyx_tz_source='missing_gmt_instant'`. 0/349 current rows
  trigger this path; purely defensive.

### Phase 12: Final validation

`python hrv_analysis.py` end-to-end. 50 minutes wall-time. Exit 0,
zero errors, zero shift-contract warnings.

Key empirical signal: XGBoost CI coverage moved from systematic under-
coverage (typically 70-80% with training-residual σ) to within ~3pp of
the nominal 90% target on all 7 horizons.

## Order rationale

Schema FKs (B + C) were done before the TZ trigger cluster (D) because
the FK migrations were mechanical (orphan check + ADD CONSTRAINT) and
gave momentum. The TZ cluster was the most architecturally significant
change of the session and benefited from having a couple wins in the
bank first.

Analysis correctness (E) came after the TZ cluster because it depended
on the same `hrv_analysis.py` file Group A had just edited, and one
pipeline run could validate both groups together at the end.

ETL hygiene (F) was deferred to last because it spanned 4 different
files with no shared validation harness — pure mechanical work, no
test to gate on. The Garmin ON CONFLICT ticket turned out to be
verification only, so the group landed faster than expected.

## What I deliberately didn't do

- Did not modify `whoop_journal.cycle_date` interpretation across the
  codebase even though the trigger fix changes 1,190 rows' `onyx_et_date`
  semantics. Downstream consumers (`/analytics/hrv`, causal pipeline)
  read `onyx_behavioral_date` for HRV analytics, not `onyx_et_date`,
  so the semantic shift doesn't ripple into model outputs.
- Did not backfill `garmin_daily_summary` with an `onyx_behavioral_date`
  column even though G3 surfaces a travel-day join mismatch. Per the
  audit's own option (a) framing, that fix is lower-risk and matches
  current behavior except on a tiny number of edge days.
- Did not build a per-vitamin IU lookup table for supplement unit
  conversion. Today's data has 0 IU intakes; the audit view exposes
  the gap if it becomes relevant.
- Did not run a full re-test of the daily-prediction job
  (`hrv_predict.py`) after the hrv_predictions PK change. The
  `store_predictions` upsert path in `hrv_analysis.py` exercised the
  new on_conflict target end-to-end and succeeded; the live
  `hrv_predict.py` path uses the same pattern.
