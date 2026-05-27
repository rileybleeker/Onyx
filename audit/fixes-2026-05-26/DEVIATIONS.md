# Deviations — places where I diverged from the literal audit recommendation

For each fix that didn't match the audit's recommendation word-for-word,
this document explains:
- What the audit recommended
- What I shipped instead
- Why
- What this would look like if the re-audit reviewer flags it as still wrong

If the re-audit finds the same issue in one of these areas, read the
"Why" carefully — it may be the right call to revisit the deviation.

---

## D1 — Spotify track FK: RESTRICT instead of SET NULL

**Ticket:** [Audit P1] Add FKs: spotify_plays.track_id/artist_id → dim tables (GPT-5)
**Group:** C
**Commit:** `855e6cf`

**Audit said:**
> ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED NOT VALID

**Shipped:**
> ON DELETE RESTRICT DEFERRABLE INITIALLY DEFERRED (plain ADD, no NOT VALID)

**Why:** `spotify_plays.track_id` is `NOT NULL` because it's part of the
PK `(played_at, track_id)`. `ON DELETE SET NULL` would fail at delete
time with a constraint-violation error — the literal recommendation is
not implementable as written.

`ON DELETE RESTRICT` is the safe-by-default alternative and matches the
underlying reality: `spotify_tracks` is a monotonically-growing dim
table; we don't routinely delete tracks. If someone ever does need to
delete a track row (e.g., dedup), they should explicitly handle the
referencing plays first.

`spotify_plays.artist_id` IS nullable, so SET NULL applied as written
on that side.

**If re-audit flags this:** the right escalation is either (a) make
`track_id` nullable + change the PK to use `id BIGSERIAL` (matches what
Group G1 did for hrv_predictions) and re-apply SET NULL, OR (b) leave
RESTRICT and accept the deviation. Both are defensible; (b) is the
status quo.

---

## D2 — WHOOP cycle FK scope: workouts removed

**Ticket:** [Audit P1] Missing FKs on WHOOP cycle hub allow silent orphans (Claude variant)
**Group:** B
**Commit:** `81d61bc`

**Audit said:**
> ALTER TABLE pds.whoop_recovery ADD CONSTRAINT ...
> ALTER TABLE pds.whoop_sleep ADD CONSTRAINT ...
> ALTER TABLE pds.whoop_workouts ADD CONSTRAINT ...

**Shipped:**
> Only whoop_recovery + whoop_sleep. whoop_workouts NOT included.

**Why:** Pre-migration `information_schema.columns` probe revealed
`pds.whoop_workouts` has NO `cycle_id` column. There's nothing to FK.
The Claude-variant ticket assumed the schema matched the other two
children; it doesn't.

**If re-audit flags this:** likely a false-positive — the re-audit
reviewer should also see the missing column. If they do flag it, the
correct escalation is to add the column (which would require backfilling
from WHOOP API since the original ETL never captured it) before the FK.

---

## D3 — WHOOP cycle FK skipped `NOT VALID` + `VALIDATE` two-step

**Tickets:** Group B + Group C
**Commits:** `81d61bc`, `855e6cf`

**Audit said:**
> Add NOT VALID FKs and then VALIDATE after an orphan check.

**Shipped:**
> Plain `ALTER TABLE ... ADD CONSTRAINT` (no NOT VALID + VALIDATE).

**Why:** Orphan check on the pre-migration data revealed 0 orphans
across all four FK relationships:
- whoop_recovery (573 rows): 0 orphans
- whoop_sleep (827 rows): 0 orphans
- garmin_activity_laps (3849 rows): 0 orphans
- spotify_plays (721 rows): 0 orphans on track_id, 0 on artist_id

When orphan count is 0, `NOT VALID + VALIDATE` is equivalent to plain
`ADD CONSTRAINT` semantically, but uses 2 ALTERs instead of 1. The
two-step is a safety pattern for migrations where you suspect orphans
might exist; we explicitly confirmed they don't.

**If re-audit flags this:** likely an idiom-preference comment, not a
correctness issue. Acceptable.

---

## D4 — Behavioral matrix spine fix used option (a)

**Ticket:** [Audit P1] Behavioral matrix spine mixes watch-local calendar_date with onyx_behavioral_date
**Group:** G3
**Commit:** `c0cff10`

**Audit offered two options:**
> (a) drop garmin_daily_summary from the spine (rely on other 8 sources;
>     gds still LEFT-joins via calendar_date). Option (a) lower-risk.
> (b) add onyx_behavioral_date to garmin_daily_summary via backfill
>     that derives behavioral_date from a representative cycle.

**Shipped option (a).**

**Why:** Lower risk per the audit's own framing. GDS rows on travel-day
transitions still LEFT-JOIN with a known per-day mismatch (GDS's
calendar_date is Garmin watch-local; the spine is now purely
onyx_behavioral_date). Travel days are rare for Riley; the mismatch is
known and documented in the SQL source comment.

**If re-audit flags this:** option (b) is the architecturally cleaner
solution. The triggers on garmin_daily_summary / garmin_stress /
garmin_heart_rate / garmin_training_status would all need onyx_*
columns + a derivation rule. Bigger surgery; not done today.

---

## D5 — Supplement units: scope reduced, audit view added instead

**Ticket:** [Audit P1] Supplement unit conversion drops common units (Gemini + Claude variant)
**Group:** F3/F4
**Commit:** `ec1cf34`

**Audit recommended:**
> (1) Extend unit_to_mg_factor to support more units; for IU require
>     per-vitamin lookup table.
> (2) For non-convertible units (scoops, capsules), decide handling.
> (3) Monitoring to detect new unrecognized units.

**Shipped:**
- Added `mcg DFE` and `mcg RAE` to the function (the only common DSLD
  variants not previously handled).
- Created `pds.supplement_intake_unmapped` view — surfaces remaining
  drops. (This is the audit's recommendation #3.)
- Did NOT build a per-vitamin IU lookup table.
- Did NOT decide handling for scoops/capsules.

**Why:** Empirical probe revealed today's production data has only 9
distinct units (mg, mcg, g, Gram(s), mcg DFE, mcg RAE, IU, Calorie(s),
NULL). The audit view exposes the 2 unhandled-but-present cases:
- `Calorie(s)` (2 products, 9 intakes) — not a mass; explicit ignore
  is the right call.
- `IU` (1 product, 0 intakes today) — would need per-vitamin lookup,
  but Riley hasn't taken any IU-labeled supplements recently.

When IU intakes appear in the data, the audit view will surface them
and we can build the per-vitamin table then.

**If re-audit flags this:** correct flag. The per-vitamin IU lookup is
genuinely deferred. The audit view is meant to make this deferral
visible rather than invisible.

---

## D6 — Group H4 trigger fallback: option (a) not (b)

**Ticket:** [Audit P1] garmin_activities trigger treats start_time_local as UTC instant
**Group:** H4
**Commit:** `843b69f`

**Audit offered two options:**
> (a) refuse the fallback (set onyx_* to NULL + tag default_et_fallback
>     so the row is queryable)
> (b) explicitly convert start_time_local to UTC by subtracting an
>     offset from user_tz_log

**Shipped option (a) with tag = `'missing_gmt_instant'`** (not
`'default_et_fallback'` — see below).

**Why:** 0/349 current rows trigger the fallback path; option (b) builds
infrastructure we'd never use. Option (a) is purely defensive against
future degenerate ingest, and `'missing_gmt_instant'` is more
diagnostic than `'default_et_fallback'` — the latter would lump this
case in with the legitimate fallback path, hiding the data-quality
signal.

**If re-audit flags this:** the literal recommendation said
`'default_et_fallback'`. Using a more specific tag is an
idiomaticness improvement, not a correctness regression.

---

## D7 — VIF threshold: 10 not 5

**Ticket:** [Audit P1] Exploratory OLS model lacks multicollinearity checks (VIF)
**Group:** A1
**Commit:** `a37a43e`

**Audit said:**
> Iteratively remove the feature with the highest VIF until all remaining
> features are below a standard threshold (e.g., 5 or 10).

**Shipped:** threshold = 10.

**Why:** The audit explicitly offered both thresholds. At our n~100 /
k~10 working dataset size, threshold 5 would prune most features
(every behavioral signal is somewhat correlated with the others in
HRV data — workout strain correlates with HR, journal sleep
self-reports correlate with sleep duration, etc.). Threshold 10 is
the conventional "severe multicollinearity" cutoff and preserves
enough features to learn from.

**If re-audit flags this:** subjective call; threshold 5 is also
defensible. Easy to revisit by changing one number.
