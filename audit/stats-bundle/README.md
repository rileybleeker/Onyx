# Onyx Stats Audit Bundle

Self-contained bundle for an independent statistics audit of the Onyx HRV analytics pipeline.

**Pinned to commit:** `5ceb269`
**Created:** 2026-05-25

## What's in this bundle

| File | What it is | Read order |
|---|---|---|
| `PROMPT.md` | The audit prompt with rubric, severity scale, and required JSON output schema | **1 — read first** |
| `CONTEXT.md` | Project framing, key assumptions, decision history, what to focus on | 2 |
| `DATA_PROFILE.md` | Row counts, date ranges, missingness — informs power assessment | 3 |
| `SCHEMA.md` | DDL for the output tables + view definitions for the input spine | 4 |
| `VARIABLE_COVERAGE_AUDIT.md` | Prior self-audit (May 21, 2026) — variable × test coverage matrix | 5 |
| `hrv_analysis.py` | Main pipeline (~4500 LoC). Loads matrix, builds ~250 features, runs stats, trains models, writes results. | 6 — primary focus |
| `causal_inference.py` | AIPW + PSM + naive ATE estimation with E-value sensitivity. | 7 — primary focus |
| `hrv_predict.py` | Daily prediction job (orchestration). | 8 — light review |

## How this gets used

This bundle is read by two external models (GPT-5 + Gemini 2.5 Pro) in independent parallel reviews. Each returns a JSON object matching the schema in `PROMPT.md`. The results are written into the Notion **Audit Findings** database with the `Reviewer` field tagged to the source model.

The companion script is `audit_runner.py` (one level up in the repo). It loads this bundle, fires both APIs in parallel, and saves responses to `audit/responses/`.

## License / sharing

This bundle contains code that is part of a private repository. **Do not share or post publicly.** The data profile contains aggregate counts only — no values, no individual measurements.
