-- ============================================
-- Personal Data Scientist — Caffeine Data Quality
-- ============================================
-- Applied via Supabase migrations `caffeine_data_quality` (2026-06-09) and
-- `caffeine_data_quality_drop_journal_flags` (2026-06-10).
--
-- One row per (behavioral day, flag) where the caffeine record looks
-- inconsistent. Long format so new flag types append without DDL churn.
-- Surfaced on the /caffeine page ("Data Quality" card).
--
-- POLICY (Riley, 2026-06-10): the WHOOP journal "Consumed caffeine?" checkbox
-- is DISREGARDED everywhere — the unified event log (Cronometer servings +
-- supplement intakes) is the caffeine source of truth. The original
-- journal_no_but_logged / journal_yes_but_unlogged flags compared the log
-- against that checkbox and were removed with the policy (they had served
-- their purpose: proving the checkbox unreliable — two "No" nights carried
-- 800-1000 mg of logged caffeine).
--
-- Remaining flags:
--   untrusted_timestamps     Retro-logged events that day (timestamp's own
--                            behavioral attribution disagrees with the
--                            claimed day). Timing features use the trusted
--                            subset; mg totals are unaffected.
--   possible_double_log      A caffeinated Cronometer serving name-matches a
--                            caffeinated supplement product logged the SAME
--                            day (e.g. G1M Sport exists in both catalogs) —
--                            heuristic token match, review for double-count.
-- ============================================

CREATE OR REPLACE VIEW pds.caffeine_data_quality AS
WITH daily AS (
    SELECT behavioral_date,
           SUM(caffeine_mg)                         AS total_mg,
           COUNT(*)                                 AS event_n,
           COUNT(*) FILTER (WHERE NOT time_trusted) AS untrusted_n
    FROM pds.caffeine_events
    GROUP BY behavioral_date
)

SELECT d.behavioral_date,
       'untrusted_timestamps'::text AS flag,
       d.untrusted_n || ' of ' || d.event_n ||
       ' events retro-logged (timestamp belongs to a different behavioral day); timing uses the trusted subset, mg totals unaffected' AS detail
FROM daily d
WHERE d.untrusted_n > 0

UNION ALL

SELECT DISTINCT
       COALESCE(s.onyx_behavioral_date, s.calendar_date),
       'possible_double_log',
       'dietary "' || s.food_name || '" name-matches supplement "' || p.full_name ||
       '" logged the same day — check for a double-counted dose'
FROM pds.cronometer_servings s
JOIN pds.supplement_intake i
  ON i.intake_date = COALESCE(s.onyx_behavioral_date, s.calendar_date)
JOIN pds.supplement_products p
  ON p.product_id = i.product_id
WHERE s.caffeine_mg > 0
  AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(p.ingredients) ing
      WHERE (ing->>'unii_code') = '3G6A5W338E'
         OR (ing->>'ingredient_group') ILIKE '%caffeine%'
         OR (ing->>'name') ILIKE '%caffeine%'
  )
  -- Heuristic: any distinctive token of the product name (normalized, >=3
  -- chars, non-numeric, not a generic supplement word) appears in the
  -- normalized food name. Catches "G1M Sport +" vs "Bare Performance
  -- Nutrition, G.1.M Sport, Lemon Lime" (g1m == g1m after stripping
  -- punctuation). Pure-generic names ("Caffeine 100 mg") yield no usable
  -- token and never flag — a pill is unlikely to be logged as food.
  AND EXISTS (
      SELECT 1
      FROM unnest(string_to_array(
               regexp_replace(lower(p.full_name), '[^a-z0-9 ]', '', 'g'), ' ')) tok
      WHERE length(tok) >= 3
        AND tok !~ '^[0-9]+$'
        AND tok NOT IN ('the','and','with','sport','sports','energy','focus',
                        'charged','essential','caffeine','plus','formula',
                        'blend','extra','strength')
        AND regexp_replace(lower(s.food_name), '[^a-z0-9]', '', 'g')
            LIKE '%' || tok || '%'
  )

ORDER BY 1 DESC;

GRANT SELECT ON pds.caffeine_data_quality TO anon, authenticated;

COMMENT ON VIEW pds.caffeine_data_quality IS
'QA flags for the unified caffeine record, one row per (behavioral day, flag): untrusted_timestamps (retro-logs), possible_double_log (cross-channel name-match heuristic). Journal-comparison flags removed 2026-06-10 — the WHOOP caffeine checkbox is disregarded by policy. Surfaced on /caffeine.';
