# Audit Prompt — Onyx Schema & DB Design (Domain 1)

> **Re-audit notice:** This bundle was assembled fresh from current code on 2026-05-26. Audit independently — do not assume prior findings are still present or that the code has been fixed since.

## Role

You are an **independent database design reviewer** for a personal health-analytics platform. The schema was designed by another AI assistant (Claude) without external review. Your job is to audit the table structure, indexes, RLS policies, view design, JSONB choices, and overall referential integrity.

**Framing constraints:**

- **n=1.** Single-user personal-use system. No multi-tenant concerns, no PII compliance scope.
- **Postgres 17 on Supabase.** Hosted, managed. Anon role + service_role pattern.
- **Modest scale today, modest growth.** Largest tables ~12K rows. ~36 rows/day growth on the hottest table.
- **The cost of getting this wrong** is silent ETL bugs that corrupt downstream analytics. Schema that catches problems at write-time (constraints, FKs, CHECK) is more valuable than schema that's permissive but creates ambiguity later.
- **You cannot run queries or inspect data.** Reason from the DDL as captured in `SCHEMA_DDL.md` and the `.sql` files in this bundle.
- **Do not assume the existing implementation is correct.**

## What you should review

1. **`SCHEMA_DDL.md`** — production state of the `pds` schema (indexes, FKs, RLS, views, functions, triggers)
2. **`*_schema.sql` files at bundle root** — the canonical "intended" DDL per source (whoop, eight_sleep, mfp, spotify, journal, supplement, meal, weight, etc.)
3. **`sql/` directory** — 21 SQL files including the two `daily_health_matrix*` views, the ADR-0001 attribution migrations, the `hrv_predictions_latest` view, triggers, RLS policies

Read in this order: `CONTEXT.md` → `SCHEMA_DDL.md` → the relevant `.sql` files based on what you want to dig into.

## Rubric — four 1-5 scores

Score the schema domain overall on each of:

| Dimension | What 1 means | What 5 means |
|---|---|---|
| **Correctness** | Schema produces wrong answers / allows invalid states. Bugs in constraints, indexes, or RLS that bite today. | Constraints catch invalid writes. Indexes match query patterns. RLS consistent and correct. View semantics unambiguous. |
| **Robustness** | Future schema changes will be painful. Easy to write inconsistent data. Migrations leave the schema in odd states. | Designed for evolution. Constraints catch upstream ETL bugs at write-time. Migrations are clean. |
| **Scalability** | Won't survive 3-5× data growth. Missing indexes on hot paths. JSONB used where columns belong (or vice versa). | Indexes match query patterns. Partitioning strategy in place where needed. JSONB used judiciously. |
| **Idiomaticness** | Bespoke patterns. Postgres features misused or unused. | Idiomatic Postgres. Uses GIN/HNSW/partial indexes appropriately. RLS pattern is consistent and recognizable. |

One-sentence rationale per score.

## Severity scale

- **P0** — schema allows invalid states today, or queries that read it produce wrong results today. Example: missing UNIQUE constraint causing duplicate writes; RLS hole; wrong column type.
- **P1** — incorrect under foreseeable conditions. Example: missing FK that will allow orphaned rows during future ETL changes; index that helps now but breaks at 10× volume.
- **P2** — works but inefficient or brittle. Example: missing index on a query path; JSONB where a column would be cleaner; duplicate indexes; legacy view not yet deprecated.
- **P3** — style / consistency. Example: inconsistent naming, indexes that duplicate the PK column-set, RLS policy targeting `{public}` vs `{service_role}` when both work.

## Effort

- **S** — < 1 hour
- **M** — half-day
- **L** — full day
- **XL** — multi-day (needs migration plan, possibly user data backfill)

## Where to focus

### Highest-priority questions

1. **Referential integrity.** Only ONE foreign key exists in the entire schema (`supplement_intake.product_id`). Is this an oversight or a deliberate single-user-fast-iteration choice that should now be revisited? Specifically: are there join paths in the application code that would benefit from FK enforcement?
2. **RLS consistency.** Several `service_full_access` policies target `{public}` role instead of `{service_role}`. Some tables have RLS enabled with only `anon_read` and no explicit service policy. Bug or intentional?
3. **The 135-column `daily_health_matrix_behavioral` view.** Five repeated LATERAL+LIMIT+1 dedup blocks. Is this the right pattern, or is the view becoming a maintenance liability?
4. **Two parallel matrix views** (`daily_health_matrix` legacy + `daily_health_matrix_behavioral` canonical). Should the legacy view be deprecated?
5. **Long-format vs wide-format.** `whoop_journal` and `habit_journal` store one row per `(date, question)`. Pipeline pivots to wide-format in pandas. Right design?
6. **JSONB usage.** `supplement_products.ingredients` (deeply nested), `journal_entries.topics` (flat array), `spotify_*.raw_json` (preserved payload), `hrv_*.result_json` (varying schema per result_type). When is JSONB right vs columns?
7. **Index coverage.** Are there hot query paths missing indexes? Are there indexes that duplicate the PK column-set? Specifically check `hrv_predictions_latest` view's tiebreak path.
8. **Trigger-based ADR-0001 attribution.** 11+ `set_onyx_dates_*` triggers, each calling `pds.derive_onyx_dates()`. Right pattern, or fragile?
9. **Partitioning.** `hrv_predictions` (11K rows, 36/day), `whoop_journal` (12K rows, growing). Should they be partitioned?

### Out of scope (covered by other audit domains)

- Timezone semantic correctness (covered by TZ bundle — focus only on the schema-level pattern)
- The statistical methodology that consumes these tables (covered by stats bundle)
- ETL correctness (covered by ETL bundle)
- Frontend query patterns (separate review)

## What good findings look like

- **Concrete reference**: `pds.whoop_journal.idx_whoop_journal_date` or `sql/adr_0001_08_daily_health_matrix_behavioral.sql:42`.
- **Specific claim**: not "the schema could be tighter" but "no FK on `spotify_plays.track_id → spotify_tracks.track_id` — orphan plays exist after a track deletion."
- **A specific fix.** "Add `ALTER TABLE pds.X ADD CONSTRAINT...`" not "consider revising."

## Output format — REQUIRED

Return a single JSON object matching this exact schema. No prose outside the JSON. No markdown fences.

```json
{
  "reviewer_metadata": {
    "model": "<your model name>",
    "review_date": "2026-05-26",
    "bundle_commit": "83f7a0a"
  },
  "domain_scores": {
    "correctness":    {"score": 3, "rationale": "One sentence."},
    "robustness":     {"score": 4, "rationale": "One sentence."},
    "scalability":    {"score": 5, "rationale": "One sentence."},
    "idiomaticness":  {"score": 4, "rationale": "One sentence."}
  },
  "summary": "200-500 word narrative covering: what's working, what isn't, where the riskiest design choices hide, and the top 3 things you'd fix if you could only fix three.",
  "findings": [
    {
      "id": "F-001",
      "title": "Short title (under 80 chars)",
      "severity": "P0",
      "effort": "M",
      "dimensions": ["Correctness"],
      "file_ref": "pds.whoop_journal or sql/adr_0001_08_daily_health_matrix_behavioral.sql:42",
      "description": "What's wrong, in 1-3 sentences.",
      "evidence": "Specific DDL snippet or reasoning chain.",
      "recommendation": "What to do, specifically. 1-2 sentences."
    }
  ],
  "things_done_well": [
    {
      "title": "Short title",
      "file_ref": "pds.journal_entries",
      "why_it_matters": "Why this is non-trivially correct or well-designed."
    }
  ],
  "questions_for_followup": [
    "Questions you couldn't answer from the bundle alone."
  ]
}
```

### Field rules

- `findings[].severity` — `P0` | `P1` | `P2` | `P3`
- `findings[].effort` — `S` | `M` | `L` | `XL`
- `findings[].dimensions` — array of any subset of `["Correctness", "Robustness", "Scalability", "Idiomaticness"]`
- `findings[].file_ref` — `<table_or_view>` or `<sql_file>:<line>`
- `domain_scores.<dim>.score` — integer 1-5

### Volume expectations

5–20 substantive findings. Quality over quantity.

## Final reminder

If the schema is mostly well-designed, **say so**. That's a valid result. Save credit explicitly in `things_done_well`.

Now produce the JSON.
