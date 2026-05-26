# Onyx Units-Bundle Audit

Independent review of unit conversions and semantic-conflation risk (Domain 3).

**Pinned to commit:** `5ceb269`

## Files

- `PROMPT.md` — rubric + JSON output schema
- `CONTEXT.md` — four classes of bug, what to audit
- `SQL_UNITS.md` — DB unit-conversion function + CLAUDE.md decision excerpts
- `format.ts` — frontend display formatter (79 lines)
- `queries.ts` — data fetching + on-read transforms (997 lines)

## Fire

```powershell
python audit_runner.py --fire --bundle audit/units-bundle
```
