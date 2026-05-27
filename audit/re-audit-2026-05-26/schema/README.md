# Onyx Schema-Bundle Audit

Self-contained bundle for an independent review of the Onyx `pds` schema (Domain 1 of 7 in the System Audit).

**Pinned to commit:** `83f7a0a` (re-audit 2026-05-26)
**Created:** 2026-05-26

## What's in this bundle

| File | What it is | Read order |
|---|---|---|
| `PROMPT.md` | The audit prompt with rubric, severity scale, and required JSON output schema | **1 — read first** |
| `CONTEXT.md` | Project framing, design decisions, n=1 constraints, what to focus on | 2 |
| `SCHEMA_DDL.md` | Production schema state pulled from Supabase: 85+ indexes, 49 RLS policies, 6 FKs, 30+ triggers, 14 views | 3 |
| `*_schema.sql` (10 files) | Canonical "intended" DDL per data source | 4 — reference as needed |
| `sql/*.sql` (26 files) | Migrations, view definitions, RLS, triggers, ADR-0001 attribution rollout | 4 — reference as needed |

## How this gets used

Same flow as the stats bundle:

```powershell
python audit_runner.py --fire --bundle audit/schema-bundle
```

Responses land in `audit/responses/<reviewer>-<commit>-<timestamp>.json`. Findings then get parsed into the Notion **Audit Findings** database with `Domain = "1 — Schema"`.

## License / sharing

Private repository. Do not share publicly.
