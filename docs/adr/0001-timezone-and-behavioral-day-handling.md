# ADR-0001 — Timezone & Behavioral-Day Handling

**Status**: Accepted
**Date**: 2026-05-24
**Decision-makers**: Riley (+ Claude facilitating)
**Supersedes**: [Timezone & Behavioral-Day Design Notes](https://www.notion.so/36abf5b44bf281a3be1fd21ea546fffb) (Notion design-notes page; to be marked SUPERSEDED on this ADR's acceptance)
**Companion audit**: [Timezone Variable Attribution Audit](https://www.notion.so/36bbf5b44bf281e4952bf872f662be63) (foundational input for this ADR)

---

## Context

Onyx joins every analytical surface — `daily_health_matrix`, HRV pipeline, causal layer, dashboards — on a single `calendar_date` column. That column has been computed under two implicit, conflicting rules:

1. **ET clock day** for most sources (Garmin daily summaries, MFP, Spotify `played_date_et`, WHOOP workouts, Eight Sleep)
2. **Behavioral day** for a handful of sources (WHOOP cycles via `+12h ET`, supplements / meal_events via UI defaults, WHOOP journal via the `behaviors_date` trigger introduced 2026-05-23)

The two rules give the same answer ~95% of the time and silently disagree the rest. The pre-decision audit run 2026-05-24 surfaced **84.4% of bedtimes are post-midnight ET** (median ≈ 01:00 ET), making the "awake-tail" attribution problem structural, not edge-case. Travel days (~3.8% of cycles, ~2 weeks/year) are a smaller secondary problem.

Two hard inputs framed the decision:

- **Constraint (Riley, 2026-05-24)**: source-provided date fields stay untouched. All Onyx-derived attribution goes into new columns alongside the source columns, never overwriting.
- **Policy direction (Riley, 2026-05-24)**: use correct dates regardless of the magnitude of statistical impact; sensitivity tests are deferred.

The companion audit enumerates every variable across every source and verifies the citations. Two follow-up findings from validation during this ADR pass:

1. The audit's "behaviors_date trigger uses `start_time + offset − 6h`" claim is correct; verified at [whoop_schema.sql:189-208](../../whoop_schema.sql#L189-L208).
2. Side-finding not in the audit: [api/habits/complete/route.ts:20](../../frontend/src/app/api/habits/complete/route.ts#L20) defaults `completionDate` to **UTC date**, not ET — habit taps between 20:00–24:00 ET silently land on tomorrow. Folded into Phase 1 cleanups.

---

## Decision

### D1 — Three date types per event
**Chosen: (c) Three.** Every source event carries `onyx_et_date`, `onyx_behavioral_date`, and `onyx_local_date` (each `DATE`), plus `onyx_tz_source` (provenance enum). This matches Oura's published Calendar Day / Sleep Day / Activity Day model — the only platform that publicly ships an end-to-end multi-type design — and matches Riley's three-types-of-time intuition. Three distinct semantic questions (clock-day in canonical TZ, behavioral day of Riley's life, clock-day in the TZ Riley was actually in) genuinely need three answers; collapsing any pair loses information that's load-bearing for at least one consumer (D5). **Confidence: HIGH.**

### D2 — Behavioral day = bedtime-to-bedtime
**Chosen: (b) Bedtime-to-bedtime**, anchored on the WHOOP cycle when available, with fallback to `(instant_in_local_tz − 6h)::date`. This is exactly what the production `whoop_journal.behaviors_date` trigger already computes ([whoop_schema.sql:189-208](../../whoop_schema.sql#L189-L208)) and what the `+12h` cycle rule in `daily_health_matrix` already implements for WHOOP cycles. The HRV pipeline's `shift(-1)` semantics ("behaviors of day N drive HRV measured night N→N+1") align naturally with bedtime-to-bedtime. Midsleep-anchored (c) is the academic gold standard but requires habitual-midsleep inference and would re-attribute every existing row; the marginal correctness over bedtime-anchored is unlikely to justify the disruption. **Confidence: HIGH.**

### D3 — Hybrid TZ detection
**Chosen: (d) Hybrid**, tiered:
1. **Source-provided TZ when exposed** — WHOOP `timezone_offset` (already captured on `whoop_cycles`, `whoop_sleep`, `whoop_workouts`, currently unused everywhere except the `behaviors_date` trigger); Garmin activities derived offset (`start_time_local − start_time_gmt`); Eight Sleep `timezone` field (pending empirical test, then ETL column add + re-pull).
2. **WHOOP cycle anchor** — for any source within a cycle's time window, inherit the cycle's `timezone_offset`. Covers ~96% of days where WHOOP is online.
3. **`pds.user_tz_log` table** — manual fallback. `(effective_from TIMESTAMPTZ, tz TEXT IANA)`. Hand-maintained ~5–10 rows/year from calendar / photo-geotag reconstruction.
4. **Garmin GPS** (`garmin_activities.start_latitude/longitude`) — backstop via tz-lookup library.
5. **Default ET fallback** — last resort, always flagged via `onyx_tz_source = 'default_et_fallback'`.

**Confidence: HIGH on the design.** MEDIUM on Eight Sleep specifically — depends on the deferred empirical test of whether the `timezone` field pyEight exposes actually appears in our API responses.

### D4 — Persist on source tables + expose on the view
**Chosen: (a) source-table columns + (b) view re-exposure (hybrid).** Source tables holding a TIMESTAMPTZ instant get four new columns: `onyx_et_date`, `onyx_behavioral_date`, `onyx_local_date`, `onyx_tz_source`. Trigger-populated on insert/update from the appropriate D3 tier. Source tables without a real instant (MFP CSV, Notion `entry_date`, habit `cycle_date`) only get `onyx_behavioral_date` populated by their ETL using the same tiered lookup at ingest time. `daily_health_matrix` exposes the spine's three onyx_dates **alongside** (not replacing) the existing `calendar_date` column — every downstream join continues to work unchanged during the transition. Pattern matches the existing `whoop_journal.behaviors_date` precedent. **Confidence: HIGH.**

### D5 — Consumer × date-type matrix
**Chosen: per-consumer assignment per table below.** The principle: every HRV / causal / behavior-affects-recovery analytic joins on `onyx_behavioral_date`; every "what hour of day" / "where on the clock" feature derives from `onyx_local_date`; only MFP energy-balance and operational status pages join on `onyx_et_date`.

| Consumer | onyx_et_date | onyx_behavioral_date | onyx_local_date |
|---|---|---|---|
| HRV pipeline (`hrv_analysis.py` feature matrix, `shift(-1)`) | — | **join key** | feature input only |
| Causal layer (`causal_inference.py` AIPW/PSM, `hrv_target_t1`) | — | **join key** | — |
| `/analytics/hrv` dashboard (predictions, correlations, causal) | — | **join key** | — |
| `/nutrition` — MFP macros / calorie balance | **join key** | — | — |
| `/nutrition` — calorie burnt (WHOOP cycle anchored) | — | **join key** | — |
| `/nutrition` — meal timing (last-meal-hour) | — | row identity via behavioral | **hour feature** |
| `/supplements` — log + history | — | **join key** | — |
| `/spotify` — daily volume / signature | — | **join key** | — |
| `/spotify` — time-of-day listening pattern | — | row identity | **hour feature** |
| `/status` — sync freshness | **join key** | — | — |
| Sleep-timing UI (bedtime / wake / midpoint) | — | row identity | **hour features** |
| `daily_health_matrix` spine | retained as `calendar_date` (backward-compat) | exposed alongside as new column | exposed alongside as new column |

**Confidence: HIGH on the principle; MEDIUM on per-consumer edges** — some dashboards (e.g. `/spotify`) genuinely need both behavioral attribution (for "which day's listening") and local clock (for "what hour of the night"). The matrix encodes that explicitly.

### D6 — Ambiguous / missing TZ
**Chosen: (b) Fall back to ET but flag the row.** `onyx_tz_source` enum carries provenance: `source_field | cycle_anchor | user_tz_log | gps_inferred | default_et_fallback`. Dashboards can render fallback rows differently (badge / opacity). The HRV pipeline can choose to drop them, downweight them, or include them with `tz_is_fallback` as a feature/confounder. **Definitively not (a) silent** (that's today's failure mode) and **not (d) NULL** (NaN propagation breaks every downstream feature). **Confidence: HIGH.**

### D7 — Full historical backfill, with snapshot
**Chosen: (d) Full backfill + snapshot.** Rationale:
- For sources where TZ is recoverable from already-captured data (WHOOP — 100% of cycles; Garmin activities — 100% of rows), backfill is deterministic and free; no ambiguity.
- For sources needing `user_tz_log`, Riley reconstructs travel periods from calendar / photo geotags. At 3.8% travel prevalence (≈22 cycles over 19 months), this is a one-time tractable exercise.
- Snapshot the pre-change `daily_health_matrix` to `pds_legacy.daily_health_matrix_v0` for A/B comparison + rollback. Cheap disk; useful for the deferred sensitivity test (Phase 2).

Riley's policy direction ("use correct dates regardless of magnitude of impact") rules out (a) forward-only — a historical regime shift in the time series is itself a defect when the goal is correctness. **Confidence: HIGH on principle; MEDIUM on operational scope** (depends on how much `user_tz_log` reconstruction Riley wants to do).

### D8 — Hybrid phased rollout
**Chosen: (c) Hybrid — full schema lands in one push, populated and consumed in phases.** See Rollout Plan below for the full breakdown. **Confidence: HIGH.**

---

## Consequences

### Positive
- **Awake-tail attribution finally correct across the whole codebase** — fixes ~50 `journal_*` columns, all habit completions, all WHOOP workouts, all Garmin activity aggregations, every `days_since_*` and `consecutive_*` cascade-error chain.
- **Travel-day attribution becomes possible** — WHOOP's per-cycle `timezone_offset` (free, in DB since ingestion) does the work for ~96% of days; `user_tz_log` covers the rest.
- **HRV pipeline `shift(-1)` is provably aligned**: every behavior-side feature column now lives on the same `onyx_behavioral_date` as the WHOOP HRV measurement that closes that day. The current implicit alignment that the `behaviors_date` trigger creates for one source generalizes.
- **Dashboards can render local time honestly** — a 10 PM PT bedtime stops reading as 1 AM ET.
- **Per-source provenance is auditable** via `onyx_tz_source`.
- **Source-of-truth preservation** is structural — the hard constraint is satisfied by construction.
- **Two production design patterns generalize**: (a) the `whoop_journal.behaviors_date` trigger pattern, and (b) the `meal_last_meal_to_bedtime_min` TZ-invariant-delta-against-cycle-bedtime pattern. The latter remains the canonical example of a *correctly-designed* behavioral feature; the new schema makes it easier to follow that pattern everywhere.

### Negative / cost
- **Schema migration on ~12 source tables** to add the four new columns. Per-table backfill compute for ~575 cycles × N sources.
- **One-time HRV model retraining** under the new attribution before the legacy snapshot can be retired. Causal estimates re-run.
- **`user_tz_log` requires manual hand-maintenance** for the ~4% of travel cycles. Tradeoff: ground truth comes from Riley's memory / calendar / photos; perfect automation isn't possible.
- **Eight Sleep cannot adopt source-field TZ until the deferred empirical test confirms the field exists in our responses**. Phase 1 ships using cycle-anchor for Eight Sleep; tier-1 promotion happens in Phase 4.
- **Cosmetic dashboard shifts on travel days** — a 1 AM ET-attributed bedtime that re-attributes to 10 PM PT will visibly move in any historical chart. Acceptable: this is the correction, not a regression.
- **Coupling overhead**: every consumer now declares which date type it joins on. Per-consumer documentation burden, but enforced by the D5 matrix.

### Reversibility per decision
| Decision | Reversibility | Cost of reversal |
|---|---|---|
| D1 (three types) | **Hard** — additive schema; columns can be dropped, but downstream consumers depend on them once adopted | Drop the columns + revert each consumer's join key |
| D2 (bedtime-to-bedtime) | **Easy** — re-define the derivation function and re-run backfill | Tail of cached models retrains |
| D3 (TZ detection tiering) | **Easy** — per-source swap | None unless we delete `user_tz_log` |
| D4 (source-table persistence) | **Medium** — moving column ↔ view requires migration | One pass per affected source |
| D5 (consumer mapping) | **Easy** — each consumer's join is a code change | None |
| D6 (ET fallback + flag) | **Easy** — change the COALESCE / enum default | None |
| D7 (full backfill + snapshot) | **Hard once skipped** — historical data not reconstructable if `user_tz_log` is incomplete | Significant — past dashboards wrong forever |
| D8 (phased) | **N/A** — process choice | None |

D1 and D7 are the lock-in decisions; both are made deliberately.

---

## Alternatives considered

- **D1 = (a) Single canonical** — rejected. With 84.4% post-midnight bedtimes, ET-only is structurally wrong for the dominant case; can't simultaneously be the right column for HRV joins AND MFP energy balance AND time-of-day features. The whole problem statement comes from `calendar_date` not being able to be all three at once.
- **D1 = (b) Two (drop `onyx_et_date`)** — considered. Rejected because MFP's clock-date semantic genuinely is a third concept; collapsing `et_date` into `local_date` makes Hawaii MFP rows and Hawaii WHOOP cycles fail to share a join key. Also: `et_date` is the existing canonical and removing it would break every cached model and dashboard mid-flight.
- **D1 = (d) Per-source domain-specific** — rejected. Every consumer would have to learn which source uses which column; defeats the point of a contract.
- **D2 = (c) Midsleep-anchored rolling** — academic gold standard, more robust to bedtime drift. Rejected for v1 because the production `behaviors_date` trigger and `+12h` cycle rule already implement bedtime-anchored; switching requires re-attributing every row AND building habitual-midsleep inference. Revisit if sensitivity tests show meaningful gain.
- **D2 = (d) Fixed 6 PM–6 PM** — Oura's approach. Rejected for Onyx because Riley's bedtime varies materially (10 PM–3 AM range) and a fixed cutoff would arbitrarily mis-attribute behaviors near 6 PM.
- **D3 = (a) Source-provided only** — rejected. Many sources have no TZ field (Garmin daily summary, MFP, Notion entries); a single-tier design has too many gaps. Hybrid is required.
- **D4 = (c) Dedicated `event_date_map` table** — rejected. Extra join overhead, and "who maintains this" is ambiguous (trigger? batch?). Source-column persistence already has precedent via `whoop_journal.behaviors_date` and is the cleanest pattern.
- **D4 = (b) View-time only** — partially rejected. View-time recomputation can't service consumers that bypass the view (Spotify dashboard, supplement page query their tables directly). Source-column persistence is the right primary; view re-exposure is additive.
- **D4 = (d) Application-code only** — rejected. Every consumer would reinvent the derivation; correctness becomes a per-consumer audit problem.
- **D6 = (a) Silent ET fallback** — rejected. That IS today's failure mode.
- **D6 = (d) NULL the derived date** — rejected. NaN propagation breaks every downstream feature; the HRV pipeline would lose every fallback-source row.
- **D7 = (a) Forward-only** — rejected. Violates Riley's "use correct dates regardless of impact" policy direction; creates a regime shift in the time series.
- **D7 = (c) Travel-period-only backfill** — rejected. Doesn't fix the dominant problem (awake-tail attribution applies on home days too).
- **D8 = (a) Lightweight first pass** — rejected. The schema is the load-bearing piece; shipping it half-done leaves consumers half-migrated, which is the worst state. Phased *adoption* yes; phased *schema* no.
- **D8 = (b) Full design in one push** — rejected. Risk of breaking everything at once; phased adoption is safer.

---

## Rollout plan

Each phase is sized to ship independently. Reversibility marked per step.

### Phase 1 — Schema + free TZ wins (1–2 weeks) — **MEDIUM reversibility**

1. **Add `pds.user_tz_log` table** — `(effective_from TIMESTAMPTZ PRIMARY KEY, tz TEXT NOT NULL CHECK (tz ~ '^[A-Za-z]+/[A-Za-z_]+$'))`. RLS on. Initially empty. *Reversible: drop table.*
2. **Add four columns to source tables holding TIMESTAMPTZ instants**: `whoop_cycles`, `whoop_sleep`, `whoop_workouts`, `garmin_activities`, `garmin_sleep`, `garmin_hrv`, `eight_sleep_trends`, `spotify_plays`, `supplement_intake`, `meal_events`, `journal_entries` (`notion_created_at` anchor), `habit_journal` (via trigger join to WHOOP cycle), `myfitnesspal_nutrition`. Columns: `onyx_et_date DATE`, `onyx_behavioral_date DATE`, `onyx_local_date DATE`, `onyx_tz_source TEXT`. *Reversible: drop columns.*
3. **Triggers**: per-source `BEFORE INSERT OR UPDATE` triggers that populate the four columns per the D3 tier ladder. WHOOP free — `timezone_offset` already there. Garmin activities free — offset derivable from `start_time_local − start_time_gmt`. Others use cycle-anchor lookup → `user_tz_log` → ET fallback. *Reversible: drop triggers, drop columns.*
4. **Backfill** every existing row by running the trigger as an UPDATE pass. ~575 WHOOP cycles + ~349 Garmin activities + ~624 Spotify plays + smaller tables. Estimate < 5 min total compute. *Reversible: ignore the new columns and rejoin on `calendar_date`.*
5. **Snapshot** `pds.daily_health_matrix` to `pds_legacy.daily_health_matrix_v0` as a materialized table. *Reversible: drop the snapshot.*
6. **Expose new columns on `daily_health_matrix`** alongside (NOT replacing) `calendar_date`: add `onyx_et_date`, `onyx_behavioral_date`, `onyx_local_date` from the spine and each per-source join. *Reversible: revert view DDL.*
7. **Fix two genuine bugs uncovered by the audit and ADR validation**:
   - [eight_sleep_etl.py:357-365 / 376-390](../../eight_sleep_etl.py#L351-L390) — `parse_interval` uses naive UTC `dt.date()` to bucket bed/room temp + toss-turns. Replace with ET conversion (and after Phase 1, with `onyx_behavioral_date` derived from `interval.ts`). *Reversible: revert the diff.*
   - [api/habits/complete/route.ts:20](../../frontend/src/app/api/habits/complete/route.ts#L20) — defaults `completionDate` to UTC `new Date().toISOString().split("T")[0]` instead of ET. Fix to ET, and let the upcoming `onyx_behavioral_date` trigger handle awake-tail re-attribution. *Reversible: revert.*
8. **Drastic-TZ-abroad: transition-day flag.** Add `onyx_is_transition_day BOOLEAN` to `whoop_cycles`. Trigger-populated true when consecutive cycles have non-equal `timezone_offset` values (i.e., Riley flew between them). Surfaces the "WHOOP picked one offset for a cycle that physically spanned two TZs" imprecision from Open Question #9 as a queryable flag rather than a silent ambiguity. Downstream consumers can opt to filter, downweight, or visually mark these. *Reversible: drop column.*
9. **Drastic-TZ-abroad: missing-`user_tz_log` detection.** Add `pds.tz_log_gaps` view that joins `whoop_cycles.timezone_offset` against the declared `user_tz_log` interval covering each cycle's `start_time` and flags mismatches (e.g., a WHOOP `+09:00` cycle on a day where `user_tz_log` says `America/New_York`). One row per disagreeing day. Surfaced on `/status` (Phase 3) as a yellow banner "Travel detected without log entry: 2026-04-30 → 2026-05-03." Failure mode without this: Riley forgets to log a trip → manual sources silently default to ET → silent attribution wrong for the whole trip. *Reversible: drop view.*

### Phase 2 — HRV pipeline rewires (1 week) — **EASY reversibility** (gated behind `model_version`)

1. **`hrv_analysis.py`** — change `pivot_habits` (line 827) and `pivot_supplements` (line 866-870) to key on `onyx_behavioral_date`. `pivot_journal` already does the right thing via `behaviors_date` ([line 791-792](../../hrv_analysis.py#L791-L792)); leave it for now and reconcile in Phase 3. *Reversible: code revert; cached model `v1` retained.*
2. **`build_feature_matrix`** — sort the frame on `onyx_behavioral_date` instead of `calendar_date`. Lag features and `_days_since` / `_consecutive_days` mechanics unchanged; they just operate on the corrected sort key. *Reversible.*
3. **Causal layer** (`causal_inference.py`) — `ALIGN_KEY` becomes `onyx_behavioral_date`. AIPW / PSM / Naive estimators unchanged. *Reversible.*
4. **Run sensitivity test** (the deferred audit #4): re-run the full HRV pipeline against `pds_legacy.daily_health_matrix_v0` (old attribution) vs new. Compare top correlations, top SHAP features, model RMSE per horizon, and AIPW ATEs per treatment. Publish results to a new Notion page; even if Riley's policy direction is "correct regardless of magnitude," the magnitude is itself a useful diagnostic for *which* features moved most and validates the schema choice empirically.
5. **Publish new models under `model_version='behavioral_v1'`** in `pds.hrv_predictions` and `pds.hrv_model_metrics`. Existing `v1` / `backtest_*` rows untouched. The view `hrv_predictions_latest` continues to tiebreak via the existing CASE expression. *Reversible: filter the view to exclude `behavioral_v1`.*

### Phase 3 — Dashboards (1 week) — **EASY reversibility**

1. **`/analytics/hrv`** — every query in `lib/queries.ts` that reads HRV / behavioral data switches join key to `onyx_behavioral_date`. *Reversible: code revert.*
2. **`/spotify`** — `played_date_et` keeps its existing STORED-generated definition (locked into schema; can't be replaced without dropping the column). Layer a view on top that adds `onyx_behavioral_date`. Daily-signature reads switch to behavioral. Time-of-day plots switch to `onyx_local_date`-based hour features. *Reversible.*
3. **`/nutrition`** — meal-timing UI surfaces `onyx_local_date`-derived `meal_last_hour` (correct on travel days). MFP macros + calorie balance continue to join on `onyx_et_date` per the D5 matrix. Calorie-burnt-vs-consumed chart joins on `onyx_behavioral_date` so a Hawaii TDEE cycle pairs with the right MFP day. *Reversible.*
4. **`/supplements`** — already correct; verify and tag.
5. **`/status`** — two-part change:
   - Freshness check switches from `onyx_et_date`-anchored to `MAX(spine.calendar_date)`-anchored, so a Berlin trip showing "Garmin: 18h stale" stops mis-reporting when data is actually real-time in Berlin local. ET stays the rendering label only; the comparison is against the actual most-recent spine date.
   - **Travel-day banner**: render when `onyx_tz_source != 'source_field' AND timezone_offset != ET-current`.
   - **Untracked-travel banner**: read `pds.tz_log_gaps` (Phase 1 step 9). When any row is present, render a yellow `"Travel detected without log entry: {date_from} → {date_to} ({offset})"` warning with a one-click link to add a `user_tz_log` entry. Closes the "Riley forgot to log a trip" silent-failure mode.

### Phase 4 — Eight Sleep + ongoing improvements — **EASY reversibility**

1. ~~**Eight Sleep empirical test**~~ — **RESOLVED 2026-05-25**. Captured `pds.eight_sleep_trends.raw_json` from production confirms the `/trends` payload carries no IANA `timezone` field (only UTC instants). pyEight claim does not hold for this endpoint. Eight Sleep stays at D3 tier-2/5; promotion path closed unless we add a `/sleep-sessions` endpoint call (separate scope).
2. ~~If present: add `timezone` column to `eight_sleep_trends`, ETL captures it, trigger promotes Eight Sleep to D3 tier-1.~~ — Removed; gating step #1 returned negative.
3. **`user_tz_log` retroactive entries** — Riley reconstructs travel periods from calendar / photo geotags / expense reports. Use `pds.tz_log_gaps` (Phase 1 step 9) as the candidate list — 18 distinct trip ranges across history covering Europe (+02:00), PST (-08:00), CST/CDT (-06:00/-05:00). Bulk-INSERT one or two rows per trip, then `UPDATE pds.whoop_cycles SET start_time = start_time` to re-trigger backfill against the new log. `/status` banner shrinks as gaps close.
4. **GPS-based TZ inference** (optional, low priority) — for Garmin activities with `start_latitude / start_longitude`, use `tz-lookup` or equivalent to backstop `user_tz_log`.
5. **Old `calendar_date` column eventual retirement** — only after every consumer in D5 is verified on the new keys. Probably 1–2 quarters out; not a Phase 4 commitment, just a forward note.

---

## Open questions deferred to follow-up

1. **Sensitivity test magnitude** — deferred per Riley's "correct regardless of impact" framing, but Phase 2 step 4 surfaces it. If the gain is >5% RMSE or moves the top-10 SHAP ranking, that confirms the schema choice empirically; if it's <2%, the schema was still right but Riley should know the model wasn't structurally biased by the old attribution.
2. ~~**Eight Sleep `timezone` field empirical verification** — gating Phase 4 step 1.~~ **RESOLVED 2026-05-25** by inspecting captured `raw_json` from `pds.eight_sleep_trends` (production data). The `/trends` payload has **no `timezone`, no `tz`, no IANA field anywhere** — only UTC instants (`presenceStart`, `sleepStart` ending in `Z`). The pyEight community claim does not hold for this endpoint. Eight Sleep stays at D3 tier-2 (cycle-anchor) / tier-5 (ET fallback) indefinitely. Phase 4 step 2 (promote to tier-1) is removed from the rollout plan. The hard-coded `?tz=America/New_York` request param remains the only TZ signal Eight Sleep accepts.
3. **Whether to ever retire `calendar_date`** — see Phase 4 step 5.
4. **`meal_last_hour` view definition** — currently hard-codes `'America/New_York'` ([meal_schema.sql:98-101](../../meal_schema.sql#L98-L101)). Replace with `onyx_local_date`-aware projection in Phase 3, but requires the meal-events `onyx_local_date` to be populated first (which requires Phase 1 to have shipped). Sequencing is captured but the exact view rewrite is not.
5. **`spotify_plays.played_date_et` migration** — the STORED generated column locks ET into the schema. The existing roadmap edge case (a) flagged this; the chosen approach is layer-a-view-on-top rather than drop-and-recompute. Revisit if the STORED column becomes a real constraint.
6. **Backfill of `user_tz_log` from Riley's lived history** — how far back to reconstruct. Default: as far as Riley has reliable signal; at minimum the 22 non-ET cycles already identified.
7. **DST transitions** (2×/year) — not explicitly addressed; the `timezone_offset` from WHOOP handles them implicitly per-cycle, and `user_tz_log` should include DST shifts as separate rows. Add explicit DST test to the sensitivity test suite.
8. **Multi-segment sleep / no-sleep nights** — current `whoop_sleep is_nap=false` filter handles naps; a true no-sleep night leaves no cycle. Behavioral-day attribution for such a night falls back to the `−6h` rule on the next available cycle. Worth flagging as a Phase 2 sensitivity check but no schema change needed.
9. **Red-eye flights** (bedtime in TZ-A, wake in TZ-B with a 5-hour cycle) — the `timezone_offset` on `whoop_cycles` is a single value per cycle; ambiguity at exactly the worst possible boundary. Document as a known limitation; accept until evidence shows it matters. **Partially mitigated** by the Phase 1 step 8 `onyx_is_transition_day` flag — the ambiguity is no longer silent, downstream consumers can detect and handle.

10. **Drastic-TZ-abroad** (single-TZ stays in materially different zones — Europe `+02:00`, Tokyo `+09:00`, Sydney `+11:00`; already happens — empirically 4 cycles at `+02:00` 2026-04-30 → 2026-05-03 and 4 at `-08:00` 2025-12-06 → 2025-12-09). The mathematical core (per-cycle `timezone_offset` driving `onyx_behavioral_date` derivation) works under any signed offset including IDL crossings. **Three operational gaps were surfaced and prioritized into Phase 1 / Phase 3 rather than deferred**:
    1. **Garmin spine ambiguity at transitions** — `pds.garmin_daily_summary.calendar_date` is pre-attributed in watch-local TZ. When the watch auto-switches mid-flight (default with GPS), the spine produces a non-contiguous date sequence (skipped or compressed day). `shift(N)` lags on those rows are arithmetic-correct but semantically off-by-a-day at the boundary. **Handled** by the Phase 1 step 8 `onyx_is_transition_day` flag — downstream features (lag, `_days_since`, `_consecutive_days`) can detect and skip / interpolate / weight-down the transition row. Long-term: consider whether the matrix spine itself should switch from `gds.calendar_date` to `onyx_behavioral_date` for cross-source consistency; punt for now since changing the spine cascades into every consumer.
    2. **`/status` page semantics abroad** — current ADR D5 has `/status` join on `onyx_et_date`. While Riley is in Berlin, his "freshest" Garmin sync is real-time but the ET-anchored freshness check sees it as ~18h stale. **Handled** by the Phase 3 step 5 spine-anchored freshness rewrite.
    3. **`user_tz_log` forget-to-log failure mode** — if Riley travels and forgets to add the `user_tz_log` entry, sources without their own TZ field (MFP, Notion entries, habits, supplements) silently default to ET for the whole trip. The `onyx_tz_source='default_et_fallback'` flag makes individual rows queryable, but not surfaced. **Handled** by the Phase 1 step 9 `pds.tz_log_gaps` view + Phase 3 step 5 `/status` banner — WHOOP's per-cycle `timezone_offset` becomes the canary: any cycle whose offset disagrees with the declared `user_tz_log` triggers an explicit warning with a one-click log-entry prompt.

    Edge cases the above does NOT yet handle (acceptable v1 limitations):
    - **WHOOP-offline travel** (strap dies during trip → no cycle to canary against). Detection becomes Garmin-GPS-based, deferred to Phase 4 step 4.
    - **Multi-stop trips** (NY → Berlin → Tokyo in one cycle) — vanishingly rare; the per-cycle single-offset assumption holds with reduced precision.
    - **Spine date compression at IDL crossing** — physically a day is lost/gained; the matrix reflects this honestly and the transition flag marks the boundary row.

---

## Rubric scorecard

Against the Part 2 evaluation criteria from the design-notes page:

| Criterion | This ADR |
|---|---|
| **1. HRV model correctness** | Improves significantly. Awake-tail (84.4% prevalence) misalignment is removed across all sources; `shift(-1)` finally consistent. |
| **2. Dashboard interpretability** | Improves on travel days (~4% prevalence). Local-hour features stop reading as ET-of-local-instant. |
| **3. Engineering cost** | Moderate: ~12 table migrations, ~3 weeks total work, one-time HRV retrain. |
| **4. Operational cost** | Low: `user_tz_log` is hand-maintained but only ~5–10 entries/year. Provenance enum makes failures visible. |
| **5. Reversibility** | Strong on downstream (D2–D6, D8); deliberate lock-in on D1 (schema) and D7 (backfill scope). Snapshot mitigates D7. |
| **6. Validation against prior art** | Strong: matches Oura's three-types model, aligns with social-jetlag literature's behavioral-day construct (bedtime-anchored), and uses WHOOP's own per-cycle `timezone_offset` primitive that the audit found we'd ignored. |
| **7. Robustness** | Good: tiered TZ detection has a real fallback ladder; failure modes are surfaced (not hidden) via `onyx_tz_source`. |
| **8. Source-of-truth preservation** | **Hard filter satisfied by construction.** All derivations are in new columns alongside source fields; no source data is mutated. |

No proposed option fails the source-of-truth hard filter.
