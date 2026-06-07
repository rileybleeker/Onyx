-- pds.legacy_mfp_nutrition_archive — defensive snapshot of the MyFitnessPal era.
-- Applied via Supabase migration `legacy_mfp_nutrition_archive` (2026-05-31).
--
-- MFP ingestion stopped at the Cronometer cutover (2026-05-31). This labeled,
-- read-only window over pds.myfitnesspal_nutrition formalizes "MFP-era nutrition"
-- so the pre-Cronometer data stays clearly addressable. The base table is never
-- dropped — this is purely a convenience/safety view.
CREATE OR REPLACE VIEW pds.legacy_mfp_nutrition_archive AS
SELECT *
FROM pds.myfitnesspal_nutrition
WHERE calendar_date <= DATE '2026-05-31';

GRANT SELECT ON pds.legacy_mfp_nutrition_archive TO anon, authenticated;

COMMENT ON VIEW pds.legacy_mfp_nutrition_archive IS
  'Frozen MFP-era nutrition (calendar_date <= 2026-05-31). MFP ingestion stopped at the Cronometer cutover; defensive archive — base table myfitnesspal_nutrition retained in full.';
