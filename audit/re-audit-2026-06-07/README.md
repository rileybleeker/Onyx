# Onyx Re-Audit Bundle — 2026-06-07

Five-domain re-audit of the Onyx personal health-analytics platform.
Same structure as the 2026-05-26 re-audit, refreshed against current
code at commit `2f70ba1`. This is the third pass — the first audit ran
at `5ceb269`, the second at `83f7a0a`, this one at `2f70ba1`.

## What's here

| Sub-bundle | Domain | Files | Reviewer |
|---|---|---|---|
| `units/` | 3 — Unit conversion & semantic conflation | 6 | independent |
| `stats/` | 5 — Statistics pipeline | 9 | independent |
| `schema/` | 1 — Schema & DB design | 50 (incl. sql/) | independent |
| `tz/` | 2 — Timezone & behavioral-day handling | 11 (incl. sql/) | independent |
| `etl/` | 4 — ETL correctness & idempotency | 22 (incl. schemas/, workflows/) | independent |

Each sub-bundle is self-contained: PROMPT.md (rubric + JSON output
schema), CONTEXT.md (framing), README.md (read order), plus the source
files the reviewer needs.

## Re-audit mandate

Per the **"fresh independent re-audit"** principle:

- Reviewers are told this is a re-audit (one-line preamble in each
  PROMPT.md) but **not** what changed since the prior audit.
- Bundles include only current code; no diff history, no commit list,
  no fix annotations.
- Reviewers find what they find. If they re-surface a prior finding,
  that's signal the fix didn't take. If they surface something new,
  it's a new bug.

## How to run

```powershell
python audit_runner.py --fire --bundle audit/re-audit-2026-06-07/units
python audit_runner.py --fire --bundle audit/re-audit-2026-06-07/stats
python audit_runner.py --fire --bundle audit/re-audit-2026-06-07/schema
python audit_runner.py --fire --bundle audit/re-audit-2026-06-07/tz
python audit_runner.py --fire --bundle audit/re-audit-2026-06-07/etl
```

Each call fires the bundle at all three external reviewers in
parallel (GPT-5, Gemini 2.5/3.1-pro, DeepSeek V4-Pro) and saves their
JSON responses to `audit/responses/<bundle>-<reviewer>-<commit>-<ts>.json`,
same pattern as the prior audits.

## How to interpret results

Internal comparison set (NOT visible to reviewers): `audit/fixes-2026-05-26/`
remains the canonical record of fixes shipped between the second and
third audit. For each re-audit finding:

1. **Same finding as before, in an area we shipped a fix for** → our fix
   didn't take. Read DEVIATIONS.md / EDGE_CASES.md to check whether
   this was a known compromise.
2. **New finding in an area we touched** → fix may have introduced a
   regression. Cross-reference the relevant Group section in
   `audit/fixes-2026-05-26/FIXES_BY_GROUP.md` plus the commits tagged
   `Audit re-2026-05-26 P0/P1/P2/P3` in `git log 83f7a0a..2f70ba1`.
3. **New finding in an untouched area** → either a pre-existing
   finding both prior audits missed, or a regression from unrelated
   work. Both worth filing.

## Bundle differences from the 2026-05-26 re-audit

For transparency (bookkeeping changes only, no fix hints):

- `bundle_commit` bumped: `83f7a0a` → `2f70ba1`
- `review_date` bumped: `2026-05-26` → `2026-06-07`
- All source code files refreshed to HEAD (`2f70ba1`)
- One-line "Re-audit notice" date updated in each PROMPT.md
- New source files added to reflect work since the prior audit (no fix
  annotations — reviewers should treat these as ordinary source files):
  - **etl/**: `cronometer_import.py`, `cronometer_watcher.py`,
    `sync_log_helper.py`, `retry_helper.py`
  - **etl/schemas/**: `cronometer_schema.sql`
  - **schema/**: `cronometer_schema.sql`
  - **schema/sql/**: `activity_split_label.sql`, `caffeine_timing_daily.sql`,
    `cronometer_matrix_view.sql`, `daily_micronutrient_totals.sql`,
    `legacy_mfp_nutrition_archive.sql`, `meal_timing_from_cronometer.sql`,
    `security_lockdown_2026_06_06.sql`, plus the four `audit_re_2026_05_26_*.sql`
    DDL files shipped during the May 26→June 7 fix cycle.
  - Stale files removed from `schema/sql/`:
    `hrv_predictions_surrogate_pk.sql` (renamed `audit_p1_*`),
    `supplement_intake_unmapped_view.sql` (renamed `audit_p1_unit_unmapped_view.sql`).
- `schema/SCHEMA_DDL.md` and `schema/CONTEXT.md` were **NOT** regenerated
  this round — the FK / RLS state has shifted somewhat (notably
  `security_lockdown_2026_06_06.sql` tightened anon writes on habit data
  + Garmin matviews) but the bundle deliberately keeps the prior DDL
  ground-truth doc so reviewers reason from the same baseline both
  passes. If a finding turns on stale DDL, that's signal the doc needs
  a regen, not that the reviewer is wrong.
