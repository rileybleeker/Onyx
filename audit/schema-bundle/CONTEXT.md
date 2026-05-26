# Context — Onyx Schema & Database Design Audit

This is the briefing for an independent reviewer of the Onyx `pds` schema. Read this first.

## What Onyx is

Personal health-data aggregation and analytics platform for **one user** (Riley). Ingests from WHOOP, Garmin, Eight Sleep, MyFitnessPal, Spotify, Notion (personal journal + habits), and the user's own supplement/meal/weight logs. Visualizes through a Next.js dashboard backed by Supabase Postgres 17.

The schema you're reviewing has been growing for ~9 months. Most design decisions were made by Claude during implementation with light human review. Riley wants an independent audit of the table structure, indexes, RLS, JSONB choices, view design, and overall referential integrity.

## Scale and operational context

- **n=1.** One user. No multi-tenant concerns. No PII compliance scope.
- **Not productionized.** Personal-use only. Daily batch ETL via GitHub Actions. Frontend on Vercel.
- **Modest volumes.** Largest tables: `hrv_predictions` (~11K), `whoop_journal` (~12K), `garmin_activity_laps` (~4K). Most tables under 1K rows.
- **Growth rate:** modest. The largest table (`hrv_predictions`) gains ~36 rows/day from the daily eval, doubling in ~9 months.
- **Failure mode that matters:** silent ETL bugs that corrupt downstream analytics. A schema that catches problems at write-time (constraints, FKs, CHECK) is more valuable than schema that's permissive at write but creates ambiguity later.

## Architectural decisions worth knowing

### 1. ADR-0001 behavioral-day attribution

Every TIMESTAMPTZ event carries four derived columns: `onyx_et_date`, `onyx_behavioral_date`, `onyx_local_date`, `onyx_tz_source`. These are computed by BEFORE-INSERT/UPDATE triggers that call `pds.derive_onyx_dates(ts, provenance)`, which itself calls `pds.tz_for_instant(ts)` to resolve the local IANA timezone for the instant (handles travel days via `pds.user_tz_log`).

**Why triggers and not generated columns:** the local TZ depends on `user_tz_log` content at insert-time, which is a separate table's state. PostgreSQL generated columns must be deterministic in their own row. The trigger approach lets the TZ resolution happen at write-time using whatever state `user_tz_log` is in then. Tradeoff: trigger logic is harder to test and reason about than expressions.

This is load-bearing for the entire downstream analytics layer — see `sql/adr_0001_*.sql` for the rollout migrations.

### 2. Dim/fact isolation for sparse data

Three sources are deliberately **NOT joined into the daily health matrix views**:

- **Spotify** (`spotify_plays`, `spotify_tracks`, `spotify_artists`) — open-ended music data; correlation is exploratory not core
- **Supplements** (`supplement_intake`, `supplement_products` + `supplement_intake_by_compound` view) — open-ended compound space; sparse per-compound coverage
- **Notion journal entries** (`journal_entries`) — long-form text with embeddings; not a fixed-schema fact

These are loaded directly by `hrv_analysis.py` and merged in pandas. The argument: forcing them into the matrix SQL would either explode the column count (one per compound, one per artist) or force a JSONB blob that's hard to query.

### 3. Two parallel "daily health matrix" views

- `pds.daily_health_matrix` — legacy, clock-day attribution (Garmin daily summary as spine)
- `pds.daily_health_matrix_behavioral` — canonical, behavioral-day attribution

Retained both during migration. Reviewer should consider whether the legacy view can be deprecated/removed.

### 4. JSONB choices

- `supplement_products.ingredients` — deeply nested (`{ingredient_group: [...], unii: ..., amount: ..., unit: ..., category: ...}`). GIN-indexed. Cross-product compound rollup uses the `pds.supplement_intake_by_compound` view which explodes via `jsonb_array_elements`.
- `journal_entries.topics` — flat array of tag strings. GIN-indexed for tag-based filter.
- `journal_entries.embedding vector(1024)` — Voyage `voyage-3-large` embedding. HNSW-indexed for cosine similarity.
- `spotify_*.raw_json` — preserved API response payloads for re-derivation if schema changes.
- `hrv_*.result_json` / `top_drivers` — payload schemas that vary per `result_type` / per model run.

Reviewer should evaluate: when does a field become a column vs stay in JSONB? Some `mfp_nutrition` columns (`protein_pct`, `carb_pct`, `fat_pct`) feel like computed values that could live in a view.

### 5. Single foreign key in the entire schema

Only `supplement_intake.product_id → supplement_products.product_id` is FK-enforced. Every other relationship (WHOOP cycle/sleep/recovery, Spotify play/track/artist, etc.) is enforced only in application code.

This is deliberate (sort of): the schema was built incrementally, and FK constraints get in the way during iterative ETL development. But "deliberate" and "right" aren't the same thing. Now that the ETL is stable, FKs may catch upstream bugs that currently surface as silent join failures.

### 6. RLS pattern — anon read + service write

Every `pds` table has RLS enabled. The standard pattern:
- `anon_read` policy: SELECT for `{anon}` role with `qual = 'true'` — anon key can read everything
- `service_full_access` policy: ALL for `{service_role}` with `qual = 'true', with_check = 'true'` — service key can read/write

Several inconsistencies exist (see `SCHEMA_DDL.md` "Row-Level Security policies" section). Reviewer should flag which are bugs vs intentional.

### 7. Trigger-based attribution (not application code)

ADR-0001 derived columns are populated by BEFORE triggers on every table holding a TIMESTAMPTZ event. **Tradeoff:** code that writes to these tables doesn't need to think about `onyx_*` columns; the database handles it. **Risk:** the trigger code paths are 11+ separate functions (one per table) that may drift.

### 8. Behavioral facts in long-format vs wide-format

`whoop_journal` is stored long-format: one row per `(cycle_date, question)`. The analysis pipeline pivots to wide-format in pandas for modeling.

Alternatives considered (and rejected during design): a wide-format table with one column per question, or JSONB per day. The long-format pattern handles new questions gracefully (no schema migration) at the cost of `cycle_date × 59 questions = 11,910 rows` after 270 days.

Same pattern applies to `habit_journal`. Reviewer should evaluate.

## Where to focus

The audit should answer:

1. **Are the missing foreign keys an oversight or a deliberate choice that should be documented?**
2. **Are the RLS policy inconsistencies safe to leave (anon role → public role distinction)?**
3. **Is the long-format `whoop_journal` / `habit_journal` the right shape?**
4. **Is the `daily_health_matrix_behavioral` view too complex (135 cols, repeated LATERAL-LIMIT-1 dedup) — should it be refactored?**
5. **Are there index gaps on hot query paths (especially around `hrv_predictions_latest` view's tiebreak)?**
6. **JSONB vs column tradeoff — are there fields that should be promoted to columns or vice versa?**
7. **The trigger-based ADR-0001 attribution — right pattern, or fragile?**
8. **Partitioning strategy for the growing tables** (`hrv_predictions`, `whoop_journal`, `garmin_activity_laps`)?
9. **Is the dim/fact isolation pattern (Spotify, supplements, journal_entries) holding up?**

## What's out of scope

- Application code that reads/writes the schema (covered by ETL bundle, frontend queries domain).
- The statistical methodology that runs on top of these tables (covered by stats bundle).
- Timezone semantics correctness (covered by TZ bundle — focus on whether ADR-0001 is implemented correctly. This audit just covers the schema-level pattern).
