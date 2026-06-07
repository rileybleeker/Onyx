# SQL Unit Conversion Reference

## `pds.unit_to_mg_factor(u text) RETURNS numeric`

Used by `pds.supplement_intake_by_compound` view to normalize all compound dosages to milligrams.

```sql
CREATE OR REPLACE FUNCTION pds.unit_to_mg_factor(u text)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $function$
    SELECT CASE REGEXP_REPLACE(LOWER(COALESCE(u, '')), '[^a-zµ]', '', 'g')
        WHEN 'mg'          THEN 1
        WHEN 'milligram'   THEN 1
        WHEN 'milligrams'  THEN 1
        WHEN 'g'           THEN 1000
        WHEN 'gram'        THEN 1000
        WHEN 'grams'       THEN 1000
        WHEN 'mcg'         THEN 0.001
        WHEN 'µg'          THEN 0.001
        WHEN 'microgram'   THEN 0.001
        WHEN 'micrograms'  THEN 0.001
        WHEN 'kg'          THEN 1000000
        WHEN 'kilogram'    THEN 1000000
        WHEN 'kilograms'   THEN 1000000
        ELSE NULL
    END;
$function$
```

**Worth flagging for the audit:**
- Returns `NULL` for unrecognized units — silently drops rows from the rollup view (`supplement_intake_by_compound`) when a product spec uses IU, oz, mL, fl-oz, drops, scoops, capsules, etc. None of those are in the dictionary.
- Does NOT handle activity-related supplement units like **IU** (Vitamin A, D, E commonly labeled in IU on packaging). This is a P1 risk for the supplement coverage matrix.
- The regex `[^a-zµ]` correctly handles "mg." with trailing punctuation but collapses "mg/mL" → "mgml" → falls through to NULL silently.

## Per-source unit decisions captured in CLAUDE.md

Quoted directly from the project docs:

### Calories / energy expenditure

> "Calories burnt" / daily energy expenditure: WHOOP is the canonical source, not Garmin. Any UI/query/feature surfacing TDEE reads `pds.whoop_cycles.kilojoule` and converts kJ → kcal via `/4.184`. Tag each cycle to its ET cycle date via the `+12h` rule. Don't substitute Garmin's `total_kilocalories` even though it covers the same concept — Garmin's BMR + active calc may diverge.

Audit question: every place that surfaces a calorie value — does it read kJ from `whoop_cycles` and divide by 4.184, or does it read `whoop_kilojoule` and forget to convert?

### Body weight

> `pds.weight_log.weight_kg NUMERIC(6,3) NOT NULL` is the canonical storage unit (matches `whoop_body_measurements.weight_kilogram`). Frontend accepts + displays pounds via `kgToLb`/`lbToKg` helpers.

Audit question: are the helper functions correct? Off-by-one in conversion factor? Default precision loss?

### HRV — three different things sharing one name

> `whoop_recovery.hrv_rmssd_milli` is RMSSD in milliseconds, measured during the WHOOP-detected sleep cycle.
> `garmin_hrv.last_night_avg_ms` is Garmin's proprietary time-weighted average of 5-minute HRV samples during sleep — NOT RMSSD; the unit is ms but the algorithm is different.
> `eight_sleep_trends.avg_hrv` is undocumented by Eight Sleep.
> Treat each as its own variable; never average or substitute.

Audit question: does any frontend chart or query compose these three across sources (e.g. fill in missing whoop_hrv days with garmin_hrv values)? That would be a silent semantic conflation.

### Garmin sleep timestamps

> `garmin_sleep.sleep_start` / `sleep_end` are stored as true UTC instants (`sleepStartTimestampGMT` from the API). The previously-used `*Local` field encoded the local clock as UTC, shifting timestamps by ~4-5h.

Audit question: anywhere in the frontend or queries that touches Garmin sleep — does it correctly treat `sleep_start` as UTC, or does it accidentally apply a TZ shift?

### Distance / pace

`format.ts` converts meters → miles via `1609.344`. Pace converts m/s → min/mile. Note Riley is American (mile-based display) but storage is metric. The bundle's `format.ts` is the canonical formatter.
