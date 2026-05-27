# Onyx Re-Audit Bundle — 2026-05-26

Five-domain re-audit of the Onyx personal health-analytics platform. Same
structure as the original 2026-05-25 audit, refreshed against current
code at commit `83f7a0a`.

## What's here

| Sub-bundle | Domain | Files | Reviewer |
|---|---|---|---|
| `units/` | 3 — Unit conversion & semantic conflation | 6 | independent |
| `stats/` | 5 — Statistics pipeline | 9 | independent |
| `schema/` | 1 — Schema & DB design | 35 (incl. sql/) | independent |
| `tz/` | 2 — Timezone & behavioral-day handling | 11 (incl. sql/) | independent |
| `etl/` | 4 — ETL correctness & idempotency | 17+ (incl. schemas/, workflows/) | independent |

Each sub-bundle is self-contained: PROMPT.md (rubric + JSON output
schema), CONTEXT.md (framing), README.md (read order), plus the source
files the reviewer needs.

## Re-audit mandate

Per the **"fresh independent re-audit"** principle:

- Reviewers were told this is a re-audit (one-line preamble in each
  PROMPT.md) but **not** what changed since the prior audit.
- Bundles include only current code; no diff history, no commit list,
  no fix annotations.
- Reviewers find what they find. If they re-surface a prior finding,
  that's signal the fix didn't take. If they surface something new,
  it's a new bug.

## How to run

```powershell
python audit_runner.py --fire --bundle audit/re-audit-2026-05-26/units
python audit_runner.py --fire --bundle audit/re-audit-2026-05-26/stats
python audit_runner.py --fire --bundle audit/re-audit-2026-05-26/schema
python audit_runner.py --fire --bundle audit/re-audit-2026-05-26/tz
python audit_runner.py --fire --bundle audit/re-audit-2026-05-26/etl
```

Responses land in `audit/responses/<reviewer>-<bundle_commit>-<timestamp>.json`,
same pattern as the original audit.

## How to interpret results

Internal comparison set (NOT visible to reviewers): `audit/fixes-2026-05-26/`.
That directory has FIXES_BY_GROUP.md (what we shipped), DEVIATIONS.md
(where we diverged from the original recommendation), EDGE_CASES.md
(known limits), EMPIRICAL.md (validation data the audit can't reproduce).

For each re-audit finding:

1. **Same finding as before, in an area we shipped a fix for** → our fix
   didn't take. Read DEVIATIONS.md / EDGE_CASES.md to check whether
   this was a known compromise.
2. **New finding in an area we touched** → fix may have introduced a
   regression. Cross-reference the relevant Group section in
   FIXES_BY_GROUP.md.
3. **New finding in an untouched area** → either a pre-existing
   finding the first audit missed, or a regression from unrelated
   work. Both worth filing.

## Bundle differences from the original 2026-05-25 audit

For transparency (these are bookkeeping changes only, not fix hints):

- `bundle_commit` bumped: `5ceb269` → `83f7a0a`
- `review_date` bumped: `2026-05-25` → `2026-05-26`
- `schema/SCHEMA_DDL.md` "Referential integrity" section regenerated
  to reflect the current FK state (the schema audit needs accurate
  ground truth or the audit is useless)
- `schema/CONTEXT.md` §5 (foreign keys) updated to match current state
- `stats/CONTEXT.md` §85-91 (leakage concerns) reworded from
  "known bugs" framing to "things reviewer should check" framing —
  the original wording leaked which items had pending fixes
- All source code files refreshed to HEAD (`83f7a0a`)
- One-line "Re-audit notice" added at the top of each PROMPT.md
