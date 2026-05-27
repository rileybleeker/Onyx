# Edge Cases — known limitations / risks flagged during the session

Things I noticed while implementing fixes that are NOT bugs in the current
deployment but ARE risks worth tracking. The re-audit may find one of
these; this document captures the reasoning so we can quickly decide
whether to treat the finding as a confirmed-known or as a new escalation.

---

## EC-1 — The +12h ET trick fails for UTC+13 / +14 timezones

**Affected fix:** P0a (whoop_journal trigger cycle join)
**File:** `sql/adr_0001_04_other_onyx_dates.sql:set_onyx_dates_whoop_journal`
**Severity if hit:** P1 — wrong cycle joined for travel to NZ/Samoa/Kiribati

**The trick:**
```sql
WHERE ((wc.start_time + INTERVAL '12 hours')
       AT TIME ZONE 'America/New_York')::date = NEW.cycle_date
```

**The assumption:** adding 12 hours to a bedtime instant pushes the
ET clock past midnight into the wake day, regardless of the user's
local TZ. The assumption holds when `|user_tz_offset_from_ET| < 12h`,
which covers UTC offsets from −19h to +7h relative to ET.

**Where it fails:** UTC+13 (NZ Daylight, Samoa) or UTC+14 (Kiribati Line
Islands). Concrete example: a 22:00 NZ Daylight bedtime is 22:00 UTC+13
= 09:00 UTC = 05:00 ET (same calendar day). +12h ET → 17:00 ET, same
date. The cycle would join to itself (same date) — but WHOOP's
cycle_date for that night is "tomorrow" in NZ frame, so the JOIN
key (NEW.cycle_date) is the next day → no match → fallback branch
fires.

**Today's impact:** zero. Riley's user_tz_log doesn't currently include
any +13/+14 entries.

**Mitigation if it becomes relevant:** harden the join to use
`wc.onyx_local_date` directly (which is now reliably derived in the
`derive_onyx_dates` rewrite) instead of the +12h ET trick. Trade-off:
the join would need a second pass when `behaviors_date` is the
canonical key, not `cycle_date`.

---

## EC-2 — Travel-day mismatch in daily_health_matrix_behavioral GDS join

**Affected fix:** G3 (matrix spine drop GDS)
**File:** `sql/daily_health_matrix_behavioral_main_session.sql`
**Severity if hit:** P2 — wrong GDS row joined on a travel transition

**The mismatch:** After Group G3, the spine is purely
`onyx_behavioral_date` but GDS still LEFT JOINs via
`gds.calendar_date = s.calendar_date`. GDS's `calendar_date` is the
Garmin watch's local date; the spine is bedtime-anchored behavioral
date. On a travel transition day (where the user crosses a date
boundary in their watch-local TZ vs. ET frame), these differ by 1 day.

**Today's impact:** few rows. Riley's user_tz_log has only a handful of
entries; travel-day rows would show GDS data from a date adjacent to
the "right" day. The other 8 spine sources still join correctly.

**Mitigation:** option (b) from the audit — backfill `onyx_behavioral_date`
into `garmin_daily_summary` via a trigger. Would also benefit
`garmin_stress`, `garmin_heart_rate`, `garmin_training_status` (which
have the same issue). Deferred per audit's own framing.

---

## EC-3 — XGBoost pred_std assumes residual distribution is constant over time

**Affected fix:** E2 (XGBoost OOF pred_std per horizon)
**File:** `hrv_analysis.py:run_evaluation`
**Severity if hit:** P2 — CI width is fixed per horizon rather than adaptive

**The simplification:** `pred_std_by_horizon[h]` is computed ONCE before
the backtest loop using TimeSeriesSplit OOF on the full feature matrix.
Then reused for every backtest fold at that h. If the true residual
distribution changes over time (regime shift, e.g., a feature became
more or less predictive after a training-load change), the PIs use
the same σ across folds.

**Today's impact:** acceptable. Riley's HRV variability is reasonably
stationary on a quarter-to-quarter scale. CI coverage at 87-92% across
horizons suggests no major regime drift in the validation window.

**Mitigation if regime drift becomes visible:** switch to nested
TimeSeriesSplit (run a 5-fold OOF inside each backtest fold's training
window). Cost: ~25 min added to pipeline run. The audit's recommendation
allowed either approach.

---

## EC-4 — Supplement unit_to_mg_factor IU drops silently for now

**Affected fix:** F3 (supplement units extended)
**File:** `sql/supplements_unii_cleanup.sql`
**Severity if hit:** P1 if IU products start appearing in intake data

**The gap:** `unit_to_mg_factor('IU')` returns NULL. IU conversion is
vitamin-specific (Vit D 1 IU = 0.025 mcg; Vit A 1 IU = 0.3 mcg;
Vit E 1 IU = 0.67 mg) and the function has no UNII context to look up.

**Today's impact:** zero IU intakes in pds.supplement_intake. The
audit view `pds.supplement_intake_unmapped` will surface this if it
changes.

**Mitigation when relevant:** build a per-UNII conversion table:

```sql
CREATE TABLE pds.iu_to_mg_factor (
    unii_code TEXT PRIMARY KEY,
    factor_mg_per_iu NUMERIC NOT NULL,
    source TEXT  -- citation for the conversion factor
);
INSERT INTO pds.iu_to_mg_factor VALUES
    ('9VU1KI44GP', 0.000025, 'Vit D cholecalciferol — Wikipedia/FDA'),
    ('81G40H8B0T', 0.0003, 'Vit A retinol — DRI tables'),
    ('H4N855PNZ1', 0.67, 'Vit E α-tocopherol — IOM');
```

Then update `pds.supplement_intake_by_compound` to LEFT JOIN this table
when `label_unit = 'IU'`.

---

## EC-5 — hrv_predictions retention policy unspecified

**Affected fix:** G1 (surrogate id + 4-tuple unique index)
**File:** `pds.hrv_predictions`
**Severity if hit:** P3 — disk usage grows unboundedly

**The new behavior:** each retrain version now lands as a separate row
(was: latest version overwrote previous). Across days, the table will
accumulate one row per (date × model × horizon × version). 30 model
versions × ~3 years × 7 horizons × 5 models ≈ 100K rows/year.

**Today's impact:** zero (table currently ~11K rows). Postgres handles
100K rows trivially.

**Mitigation if it becomes a concern:** add a retention policy via
scheduled cron deleting versions older than N days, EXCEPT for the
most-recent version per (date, model, horizon). Effectively keeps
"history for the last N model versions" without unbounded growth.

---

## EC-6 — E-value CI bound semantics for near-null effects

**Affected fix:** E1 (compute_e_value)
**File:** `causal_inference.py:compute_e_value`
**Severity if hit:** P2 — overconfident e_ci=1.0 reports near the null

**The behavior:** when the CI crosses zero (i.e., the result is not
significant), `e_ci = 1.0` — meaning "no robustness." This is
mathematically the right answer for a CI that includes the null. But
visually, a P0.04-significant negative effect with CI = [-3, -0.5] and
a P0.06-non-significant effect with CI = [-3, +0.3] will report very
different e_ci values even though the point estimates are nearly
identical.

**Today's impact:** the `/analytics/hrv` causal forest plot already
marks non-significant rows differently; the e_ci=1.0 lands them in
the "no robustness" bucket which is consistent UX.

**Not a bug.** This is the standard VanderWeele-Ding interpretation.
Documented here in case the re-audit flags the boundary behavior.
