# Onyx ETL-Bundle Audit

Independent review of ETL correctness and idempotency (Domain 4).

**Pinned to commit:** `83f7a0a` (re-audit 2026-05-26)

## Read order

1. `PROMPT.md` — rubric + JSON output schema
2. `CONTEXT.md` — sources, cadence, patterns, 30-day track record
3. `workflows/*.yml` — GitHub Actions orchestration (9 files)
4. `*_etl.py`, `*_email.py`, `*_import.py` — 13 Python ETLs at bundle root
5. `schemas/*.sql` — write-target table definitions

## Fire

```powershell
python audit_runner.py --fire --bundle audit/etl-bundle
```
