# Audit Prompt — Onyx Units & Semantic Conflation (Domain 3)

> **Re-audit notice:** This bundle was assembled fresh from current code on 2026-05-26. Audit independently — do not assume prior findings are still present or that the code has been fixed since.

## Role

You are an **independent reviewer of unit-conversion correctness and semantic conflation risk** for a personal health-analytics dashboard. You're auditing the smallest of 5 audit domains but historically a source of subtle bugs across health-data systems.

## Framing

- n=1 single-user. American user, metric storage. UI displays in mile/lb/kcal.
- You cannot run the code or query the DB. Reason from the files in this bundle.
- Bug surface here is small but high-leverage — a unit-conversion error displays wrong numbers to the user and can poison the stats pipeline.

## Files

- `format.ts` — 79-line frontend display formatter (units, dates, durations, distance, pace)
- `queries.ts` — 997-line data fetching + on-read transformation layer
- `SQL_UNITS.md` — DB-level `unit_to_mg_factor` function + quoted unit-decision excerpts from CLAUDE.md
- `CONTEXT.md` — what you're auditing and why

Read in this order: `CONTEXT.md` → `SQL_UNITS.md` → `format.ts` (small, read fully) → `queries.ts` (grep for unit-related code paths: kcal, kilojoule, kg, lb, hrv, sleep_start, distance).

## Four classes of bug to hunt

1. **Same name, different thing** — three "HRV" columns, two "calories" sources, etc.
2. **Same thing, wrong unit** — meters vs miles, kJ vs kcal, kg vs lb, ms vs s.
3. **Silent loss** — conversion function returning NULL on unrecognized input, rounding before final display.
4. **Timestamp-labeled-as-something-else** — Garmin's `*Local` field encoded local clock as UTC.

## Rubric — four 1-5 scores

| Dimension | What 1 means | What 5 means |
|---|---|---|
| **Correctness** | Wrong numbers displayed today. Conversions missing or inverted. Same name treated as same thing. | Conversions correct, sources never confused, units consistent in storage and display. |
| **Robustness** | Falls over on edge cases (unknown unit, NULL, zero). | Defensive checks. Silent-drop paths logged. NULL semantics explicit. |
| **Scalability** | Conversion happens at chart layer with N drift sites. | Conversion at one canonical layer (query OR view OR helper). |
| **Idiomaticness** | Magic numbers everywhere, no named constants. | Named constants, comments citing source, clear single-source-of-truth. |

## Severity

- **P0** — wrong number shown today. Example: a chart averaging WHOOP RMSSD and Garmin's time-weighted HRV as if they're the same metric.
- **P1** — wrong under foreseeable conditions. Example: supplement unit conversion silently drops IU-labeled products.
- **P2** — brittle/inefficient. Example: hard-coded conversion factor with no source comment; conversion at chart layer instead of query layer.
- **P3** — style. Inconsistent precision, missing units in axis labels.

## Effort

S / M / L / XL — same scale as other Onyx audit bundles.

## Output format — REQUIRED

Single JSON object, no prose outside it, no markdown fences. Same schema as the other bundles:

```json
{
  "reviewer_metadata": {"model": "...", "review_date": "2026-05-26", "bundle_commit": "83f7a0a"},
  "domain_scores": {
    "correctness":    {"score": 4, "rationale": "..."},
    "robustness":     {"score": 3, "rationale": "..."},
    "scalability":    {"score": 4, "rationale": "..."},
    "idiomaticness":  {"score": 4, "rationale": "..."}
  },
  "summary": "200-500 word narrative.",
  "findings": [
    {
      "id": "F-001",
      "title": "...",
      "severity": "P0|P1|P2|P3",
      "effort": "S|M|L|XL",
      "dimensions": ["Correctness", ...],
      "file_ref": "queries.ts:234 or format.ts:67 or SQL_UNITS.md:unit_to_mg_factor",
      "description": "...",
      "evidence": "...",
      "recommendation": "..."
    }
  ],
  "things_done_well": [...],
  "questions_for_followup": [...]
}
```

Volume: 3–15 findings expected (smaller domain). Quality over quantity.

Now produce the JSON.
