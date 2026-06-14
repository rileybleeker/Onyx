-- Melatonin journal <-> supplement bridge view (2026-06-14)
-- ---------------------------------------------------------------------------
-- Riley decided the WHOOP-derived journal question "Took a melatonin supplement?"
-- (frozen, HAB-39) is duplicative with the /supplements tracker. This read-only
-- view unifies the two signals on the shared BEHAVIORAL-DAY axis so HRV analysis
-- keeps the full ~288-observation history while the supplement dose becomes the
-- source of truth going forward.
--
-- READ-ONLY by construction: it only SELECTs from pds.journal (which reads the
-- frozen WHOOP era) and pds.supplement_intake_by_compound. It issues no DML, so
-- no frozen-era guard, name-freeze trigger, or channel-routing trigger ever fires.
--
-- Columns (one row per behavioral day that has ANY melatonin signal):
--   calendar_date     behavioral day (ET). journal side = COALESCE(behaviors_date,
--                     cycle_date) [bedtime-6h], identical to pivot_journal's
--                     fallback; supplement side = supplement_intake.intake_date
--                     (also the behavioral day). Same axis, no shift.
--   melatonin_present journal Yes/No (1/0), OVERRIDDEN to taken (1) on any day a
--                     real supplement dose exists -- the pill log is the source of
--                     truth (resolves a future journal-No + logged-dose conflict
--                     in favour of the dose).
--   melatonin_dose_mg summed supplement mg for the day; NULL before the first
--                     logged dose. NEVER nominal-filled -- the WHOOP CSV never
--                     exported a quantity, so the historical era carries no
--                     fabricated dose (preserves untracked-vs-took-zero).
--   source_flag       'journal' | 'supplement' | 'both' -- audits the override
--                     seam (the 2026-06-03 instrument change) per behavioral day.
--
-- Consumed in hrv_analysis.py:build_feature_matrix as a single SUPPLEMENT-family
-- feature: melatonin_present is merged as `supplement_melatonin_amount` (so it
-- inherits the supplement_*_amount causal enumeration + confounders + labels
-- while carrying the full history), and melatonin_dose_mg is a continuous
-- supplement treatment. The raw pivot_supplements melatonin column is dropped
-- first so there is exactly ONE melatonin column.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW pds.melatonin_unified AS
WITH j AS (
    SELECT COALESCE(behaviors_date, cycle_date) AS calendar_date,
           MAX((answer = 'Yes')::int)           AS journal_present
    FROM pds.journal
    WHERE question ILIKE '%melatonin%'
      AND answer IN ('Yes', 'No')
    GROUP BY 1
),
s AS (
    -- Robust to a future ingredient_group spelling change: match the stable UNII
    -- OR the name. unit is verified 'mg' for this compound; total_amount is summed
    -- across products taken that behavioral day.
    SELECT calendar_date,
           SUM(total_amount) AS dose_mg
    FROM pds.supplement_intake_by_compound
    WHERE unii_code = 'JL5DK93RCL' OR ingredient_group ILIKE 'melatonin'
    GROUP BY 1
)
SELECT
    COALESCE(j.calendar_date, s.calendar_date)                          AS calendar_date,
    CASE WHEN s.dose_mg IS NOT NULL THEN 1 ELSE j.journal_present END   AS melatonin_present,
    s.dose_mg                                                          AS melatonin_dose_mg,
    CASE
        WHEN s.dose_mg IS NOT NULL AND j.journal_present IS NOT NULL THEN 'both'
        WHEN s.dose_mg IS NOT NULL THEN 'supplement'
        ELSE 'journal'
    END                                                                AS source_flag
FROM j
FULL OUTER JOIN s ON j.calendar_date = s.calendar_date;

GRANT SELECT ON pds.melatonin_unified TO anon, authenticated;
