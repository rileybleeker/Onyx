# Context — Onyx Units & Semantic Conflation Audit

You are reviewing the unit-conversion and "same name, different thing" paths across Onyx — the smallest of the 5 audit domains but historically a source of subtle bugs across health-data systems.

## What Onyx is

n=1 single-user personal health platform. American user but metric storage in the DB. Sources ship data in their own units; Onyx normalizes at write or at read time.

## The four classes of bug you're hunting

1. **Same name, different thing.** Three different "HRV" columns (`whoop_hrv_rmssd`, `garmin_hrv_last_night`, `eight_sleep_hrv`) all in milliseconds but with different algorithms — averaging or substituting them produces nonsense. Same trap for "calories" (Garmin's `total_kilocalories` ≠ WHOOP-derived TDEE), "weight" (kg vs lb), "sleep duration" (Garmin milliseconds vs WHOOP milliseconds vs Eight Sleep seconds).
2. **Same thing, wrong unit.** Distance stored in meters; UI shows miles. Energy stored in kilojoules (WHOOP) but TDEE display expects kcal. Supplement compound amounts stored in their label unit; rollup view wants milligrams.
3. **Silent loss.** A unit-conversion function that returns NULL for unrecognized units silently drops rows from rollup. Sub-precision conversions that round when they shouldn't.
4. **Timestamp-labeled-as-something-else.** Garmin's `start_time_local` is local wall-clock labeled as UTC (+00). Treating it as a true UTC instant shifts everything by 4-5 hours.

## Files in this bundle

- `format.ts` — frontend display formatters (units, dates, durations, distance, pace, TZ helpers)
- `queries.ts` — Supabase data-fetching layer; unit conversions happen here on read
- `SQL_UNITS.md` — DB-level unit conversion function + quoted decisions from CLAUDE.md

## Audit questions

1. **The `pds.unit_to_mg_factor` SQL function** — does it cover every unit that appears in actual `supplement_products.ingredients` rows? It currently returns NULL for IU, oz, mL, drops, scoops, capsules. What's the silent-drop blast radius?
2. **kJ → kcal for TDEE.** Conversion factor 4.184 is universal. But: every place that surfaces a calorie value — does it read kJ from `whoop_cycles` and divide by 4.184, or does it forget the conversion? Search `queries.ts` for every reference to `kilojoule`, `kcal`, `calories`.
3. **kg ↔ lb for body weight.** `kgToLb` / `lbToKg` helpers. Correct factor 2.20462. Off-by-one risks: nothing should round before the final display.
4. **HRV conflation.** The three HRV columns. Does any code path (chart, query, fill-missing logic, lag feature builder) ever combine them? That would be a P0.
5. **Garmin sleep timestamps.** `garmin_sleep.sleep_start` is true UTC. The previously-used `*Local` field encoded local clock as UTC (silent TZ shift). Are all consumers using `*GMT`-derived columns?
6. **`format.ts` itself.** 79 lines. Check `formatDistance`, `formatPace`, `formatDuration` for correctness.
7. **Duration units across sources.** Garmin: seconds, milliseconds, AND minutes depending on column. WHOOP: nearly always milliseconds. Eight Sleep: seconds. Any aggregation across sources risks mixing.

## Severity guide for this domain

- **P0** — wrong number displayed today. Example: a chart that averages WHOOP RMSSD and Garmin's time-weighted HRV as if they're the same metric.
- **P1** — wrong under foreseeable conditions. Example: supplement unit conversion silently drops IU-labeled products that Riley's likely to log next.
- **P2** — works but brittle. Example: hard-coded conversion factor with no source comment; conversion happens at chart layer instead of query layer (multiple drift sites).
- **P3** — style. Example: missing units in axis labels, inconsistent precision.

## Out of scope

- Schema design (covered by schema bundle)
- TZ semantics (covered by TZ bundle)
- Statistical methods that consume these values (covered by stats bundle)
- ETL ingestion correctness (covered by ETL bundle)
