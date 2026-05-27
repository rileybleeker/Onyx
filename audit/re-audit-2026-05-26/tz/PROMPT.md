# Audit Prompt — Onyx Timezone & Behavioral-Day Implementation (Domain 2)

> **Re-audit notice:** This bundle was assembled fresh from current code on 2026-05-26. Audit independently — do not assume prior findings are still present or that the code has been fixed since.

## Role

You are an **independent reviewer of timezone handling and date-attribution logic** in a personal health-analytics platform. ADR-0001 (the design doc in this bundle) was made by another AI assistant; your job is to audit the **implementation**, not the design.

**Framing:**
- n=1 single-user (Riley), travels 1-2x/month, lives in ET
- Postgres 17 trigger-based implementation
- ~3% of behavioral days are "transition days"
- You cannot run queries; reason from the SQL and Python files in the bundle

**Do not assume the existing implementation is correct.** Specifically: the ADR is the *intent*; the SQL files are the *implementation*; this audit asks whether they match.

## What to review

1. `ADR_0001.md` — the canonical design (read first)
2. `sql/adr_0001_*.sql` (9 files) — the implementation, in numeric order
3. `gps_tz_backfill.py` — auto-populates user_tz_log from Garmin GPS
4. `whoop_tz_backfill.py` — auto-populates user_tz_log from WHOOP cycle offsets

## Rubric — four 1-5 scores

| Dimension | What 1 means | What 5 means |
|---|---|---|
| **Correctness** | Implementation diverges from ADR-0001 in load-bearing ways. Triggers produce wrong dates today. | Implementation faithfully realizes the ADR. Date columns correct in all current data. |
| **Robustness** | Breaks on edge cases (DST switch, transcontinental flight, midnight-adjacent events, missing GPS). | Handles every reasonable edge case explicitly. |
| **Scalability** | Trigger-per-write overhead unacceptable at 10x scale. tz_for_instant is O(n). | Linear or near-linear. Indexes support tz_log lookups. |
| **Idiomaticness** | Bespoke patterns. Doesn't use Postgres TZ primitives well. | Idiomatic PG: AT TIME ZONE, BEFORE triggers, function composition. |

## Severity scale

- **P0** — produces incorrect dates today. Example: a trigger sets the wrong `onyx_behavioral_date` for known travel days. Pipeline downstream consumes the bad value.
- **P1** — incorrect under foreseeable conditions. Example: handles ET-to-PT correctly but breaks on date-line crossing (Tokyo trip); falls back to ET silently when user_tz_log has a gap.
- **P2** — works but brittle. Example: relies on implicit assumption that `start_time` is never NULL; trigger order matters but isn't documented.
- **P3** — style / consistency. Example: trigger naming, comment quality.

## Effort

- **S** — < 1 hour
- **M** — half-day
- **L** — full day (migration may need backfill)
- **XL** — multi-day (re-derives historical date columns)

## Where to focus

1. **Trigger function correctness.** Each `set_onyx_dates_*` trigger. Edge cases: NULL ts, very old ts, future ts.
2. **`pds.tz_for_instant(ts)` semantics.** Behavior between log entries, before the first, after the last. Defaults.
3. **Behavioral-day −6h rule.** Consistently applied? 5:55 AM vs 6:05 AM.
4. **GPS-based auto-population.** Same-offset cases (Toronto/Louisville both EDT). Should skip — does it?
5. **WHOOP-offset auto-population.** Offset → IANA isn't bijective. Disambiguation logic?
6. **Resolution priority.** Manual > GPS > WHOOP. Respected?
7. **Provenance tracking.** `onyx_tz_source` always populated? `default_et_fallback` flagged?
8. **Two matrix views.** Date attribution semantics differ — is this documented? Hazards of conflation?

## Out of scope

- Schema-level design (covered by schema bundle)
- ETL correctness (covered by ETL bundle)
- Statistical analyses that consume these dates (covered by stats bundle)

## Output format — REQUIRED

Same JSON schema as the other Onyx audit bundles. Return one JSON object, no prose outside it, no markdown fences.

```json
{
  "reviewer_metadata": {"model": "...", "review_date": "2026-05-26", "bundle_commit": "83f7a0a"},
  "domain_scores": {
    "correctness":    {"score": 3, "rationale": "..."},
    "robustness":     {"score": 4, "rationale": "..."},
    "scalability":    {"score": 5, "rationale": "..."},
    "idiomaticness":  {"score": 4, "rationale": "..."}
  },
  "summary": "200-500 word narrative — what's working, what isn't, top 3 fixes.",
  "findings": [
    {
      "id": "F-001",
      "title": "Short title (<80 chars)",
      "severity": "P0|P1|P2|P3",
      "effort": "S|M|L|XL",
      "dimensions": ["Correctness", ...],
      "file_ref": "sql/adr_0001_xx.sql:123 or gps_tz_backfill.py:45",
      "description": "What's wrong (1-3 sentences).",
      "evidence": "Specific code reference / quoted snippet.",
      "recommendation": "What to do (1-2 sentences)."
    }
  ],
  "things_done_well": [{"title": "...", "file_ref": "...", "why_it_matters": "..."}],
  "questions_for_followup": ["..."]
}
```

5–20 findings expected. Quality over quantity. Save credit in `things_done_well`. Concrete file refs always.

Now produce the JSON.
