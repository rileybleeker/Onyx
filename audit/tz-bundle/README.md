# Onyx TZ-Bundle Audit

Self-contained bundle for an independent review of the ADR-0001 timezone implementation (Domain 2).

**Pinned to commit:** `5ceb269`
**Created:** 2026-05-25

## Read order

1. `PROMPT.md` — audit prompt with rubric + JSON output schema
2. `CONTEXT.md` — audit-specific framing
3. `ADR_0001.md` — the canonical design doc
4. `sql/adr_0001_*.sql` — the implementation in numeric order
5. `gps_tz_backfill.py`, `whoop_tz_backfill.py` — Python auto-population helpers

## Fire

```powershell
python audit_runner.py --fire --bundle audit/tz-bundle
```
