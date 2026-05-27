# Audit Fixes — 2026-05-26 Session Record

Internal record of the 2026-05-26 audit-closure session. Captures what shipped,
why, and how it was verified — so the re-audit reviewers' findings can be
compared against what we *intended* to fix.

**Audience: us (Riley + future Claude sessions).** Reviewers running the
re-audit must NOT see this directory — fixes are deliberately hidden from
them per the "fresh independent re-audit" mandate. The companion bundle
at `audit/re-audit-2026-05-26/` (assembled separately) carries only the
post-fix code + the same finding-category prompts the original audit used.

## Headline

- **14 audit tickets closed** across 9 commits + 8 Supabase migrations
- **Audit open count: 32 → 0** P0/P1 over a single day
- **All fixes validated** by an end-to-end `python hrv_analysis.py` run
  (exit 0, no errors, no shift-contract warnings, XGBoost CI coverage now
  87-92% across horizons vs. systematic under-coverage pre-fix)

## File map

| File | What's in it |
|---|---|
| [README.md](README.md) | This file |
| [SESSION_NARRATIVE.md](SESSION_NARRATIVE.md) | Chronological story: when each group was picked, what order, why |
| [FIXES_BY_GROUP.md](FIXES_BY_GROUP.md) | Per-group: original audit finding, fix description, commit SHA, migration, inline diff snippet |
| [DEVIATIONS.md](DEVIATIONS.md) | Places I diverged from the literal audit recommendation, with rationale |
| [EDGE_CASES.md](EDGE_CASES.md) | Known limitations / edge cases I flagged for human review |
| [EMPIRICAL.md](EMPIRICAL.md) | Concrete validation data: CI coverage table, refire counts, orphan checks |

## Groups closed

| # | Group | Component | Commit | Migration | Tickets |
|---|---|---|---|---|---|
| Pre | P0 whoop_journal trigger | Database | `6f28b10` | `audit_p0_whoop_journal_trigger_cycle_anchor` | 1 P0 |
| Pre | P0 Garmin future-date guard | ETL | `7be6edc` | — | 1 P0 |
| A | HRV stats: VIF + SARIMAX exog | Analysis | `a37a43e` | — | 3 P1 |
| B | WHOOP cycle hub FKs | Database | `81d61bc` | `audit_p1_whoop_cycle_fks` | 2 P1 |
| C | Garmin laps + Spotify dim FKs | Database | `855e6cf` | `audit_p1_group_c_fks` | 2 P1 |
| D | TZ-trigger cluster | Database | `62b44c0` | `audit_p1_group_d_tz_trigger_cluster` | 3 P1 |
| E | Analysis correctness (E-value, XGBoost PI) | Analysis | `f89c551` | — | 2 P1 |
| F | ETL hygiene cluster | ETL | `ec1cf34` | `audit_p1_unit_to_mg_factor_plus_unmapped_view_v2` | 4 P1 |
| G | Schema/views cleanup | Database | `c0cff10` | `audit_p1_g1_hrv_predictions_pk_surrogate` + `audit_p1_g3_dhm_behavioral_drop_gds_spine` + `audit_p1_g4_recovery_vs_pace_rename_hrv_column` | 5 P1 |
| H | Garmin TZ frontend + trigger | ETL/Database | `843b69f` | `audit_p1_h4_garmin_activities_trigger_refuse_fallback` | 4 P1 |

## How to use this when the re-audit returns

For each finding in the re-audit response JSON:

1. Look up the ticket area in `FIXES_BY_GROUP.md` (groups A–H).
2. If the re-audit reports a finding in an area we shipped a fix for:
   - **If it's the same finding** → our fix didn't take. Read `DEVIATIONS.md`
     and `EDGE_CASES.md` to check whether this was a known compromise or a
     genuine miss.
   - **If it's a new finding in adjacent code** → legitimate new bug, file a
     new ticket.
3. If the re-audit reports a finding in an area we did NOT touch → either a
   pre-existing finding we deferred, or a genuine new finding. Compare
   against `audit/p01_findings.json` (the original audit's full output).

## Re-audit prerequisites

When you assemble the re-audit bundle (`audit/re-audit-2026-05-26/`):

- Bundle commit SHA: `843b69f` (HEAD at session close)
- Use the **same 5 topic bundles** as the original audit: units, stats, schema, tz, etl
- Copy current files from HEAD; **do not include** any files from this
  `audit/fixes-2026-05-26/` directory
- Modify each PROMPT.md to add a one-line preamble: *"This is a re-audit.
  Bundle was assembled fresh from current code. Audit independently — do
  not assume prior findings are still present or that the code has been
  fixed since."* No more hint than that.
- Bump `bundle_commit` in the JSON schema example to `843b69f`
