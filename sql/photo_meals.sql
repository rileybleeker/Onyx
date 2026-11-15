-- ============================================================
-- Onyx: food by photo (2026-11-14)
-- ============================================================
-- Riley photographs a plate on /nutrition (or Log > Meal photo), Claude
-- vision estimates each food with kcal and macros, Riley confirms or edits
-- the list, and only then is the meal saved here. The photo is never stored.
--
--   pds.photo_meals       one row per confirmed meal: the item list (jsonb),
--                         totals summed from the items by the save route,
--                         Claude's original total (est_kcal) and when it was
--                         eaten.
--   pds.photo_meal_daily  kcal / macros per behavioral day, same columns as
--                         pds.delivery_nutrition_daily.
--
-- When it was eaten (same rule as pds.delivery_item_leftovers.eaten_time):
--   eaten_date  behavioral day; eaten_time the local wall clock, from the
--   photo's EXIF capture time when the file has one, else the moment it was
--   picked, editable before saving. A time before 06:00 is the small hours
--   that CLOSE the behavioral day (01:30 on day D = 01:30 on calendar D+1).
--   eaten_at is computed by the trigger from (eaten_date, eaten_time) and
--   pds.tz_for_instant at noon ET of that day, never sent by a client; a time
--   in the future (5 min slack) is refused with SQLSTATE OXP01.
--
-- Counting (frontend getNutrition, lib/photo-meal.ts combineEstimateDays):
-- a day with a Cronometer/MFP log uses the log only (the diary already holds
-- the meal). On other days photo meals ADD to the Uber Eats estimate; the
-- review screen warns when an Uber Eats order was delivered within 2 h of the
-- meal time, so a delivered meal is not photographed into the day twice.
-- Not yet wired into the HRV pipeline or pds.meal_timing_daily.
--
-- Writes: POST / DELETE /api/nutrition/photo-meals (owner session only, the
-- service role writes). Idempotent: client_key is a browser-made UUID and the
-- save route upserts on it, so a double tap saves one meal.
--
-- Additive only: CREATE ... IF NOT EXISTS / CREATE OR REPLACE.
-- ============================================================

CREATE TABLE IF NOT EXISTS pds.photo_meals (
    meal_id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    client_key   UUID        NOT NULL UNIQUE,
    eaten_date   DATE        NOT NULL,             -- behavioral day
    eaten_time   TIME        NOT NULL,             -- local wall clock as confirmed
    eaten_at     TIMESTAMPTZ,                      -- set by the trigger
    time_source  TEXT        NOT NULL,             -- photo | now | manual
    items        JSONB       NOT NULL,             -- [{name, portion, kcal, protein_g, carbs_g, fat_g}]
    kcal         NUMERIC     NOT NULL,
    protein_g    NUMERIC     NOT NULL,
    carbs_g      NUMERIC     NOT NULL,
    fat_g        NUMERIC     NOT NULL,
    est_kcal     NUMERIC,                          -- Claude's total before Riley's edits
    confidence   TEXT,                             -- high | medium | low
    model        TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT photo_meals_time_source_check CHECK (time_source IN ('photo', 'now', 'manual')),
    CONSTRAINT photo_meals_confidence_check  CHECK (confidence IS NULL OR confidence IN ('high', 'medium', 'low')),
    CONSTRAINT photo_meals_items_check       CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) BETWEEN 1 AND 30),
    CONSTRAINT photo_meals_totals_check      CHECK (kcal BETWEEN 0 AND 20000 AND protein_g >= 0 AND carbs_g >= 0 AND fat_g >= 0)
);

COMMENT ON TABLE pds.photo_meals IS
    'Meals logged from a plate photo: Claude vision estimate, confirmed or edited by Riley before saving. Totals = sum of items. eaten_date is the behavioral day; eaten_at is computed by the trigger. Set on /nutrition.';

CREATE INDEX IF NOT EXISTS idx_photo_meals_date ON pds.photo_meals (eaten_date);

CREATE OR REPLACE FUNCTION pds.photo_meals_set_eaten_at()
RETURNS TRIGGER AS $$
DECLARE
    tz TEXT;
BEGIN
    tz := COALESCE(pds.tz_for_instant((NEW.eaten_date + time '12:00') AT TIME ZONE 'America/New_York'),
                   'America/New_York');
    NEW.eaten_at := ((NEW.eaten_date + CASE WHEN NEW.eaten_time < time '06:00' THEN 1 ELSE 0 END)
                     + NEW.eaten_time) AT TIME ZONE tz;
    IF NEW.eaten_at > NOW() + interval '5 minutes' THEN
        RAISE EXCEPTION 'that time has not happened yet' USING ERRCODE = 'OXP01';
    END IF;
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER photo_meals_set_eaten_at
    BEFORE INSERT OR UPDATE ON pds.photo_meals
    FOR EACH ROW EXECUTE FUNCTION pds.photo_meals_set_eaten_at();

-- ── Access: owner reads in the browser, service role writes ─
ALTER TABLE pds.photo_meals ENABLE ROW LEVEL SECURITY;
CREATE POLICY owner_read ON pds.photo_meals FOR SELECT TO authenticated
    USING ((SELECT auth.uid()) = 'dc041abc-115a-4252-8536-803f2ac75557'::uuid);
CREATE POLICY service_full_access ON pds.photo_meals FOR ALL TO service_role
    USING (true) WITH CHECK (true);
GRANT SELECT ON pds.photo_meals TO authenticated;
GRANT ALL    ON pds.photo_meals TO service_role;

-- ── Per behavioral day (getNutrition fills non-Cronometer days with it) ─
CREATE OR REPLACE VIEW pds.photo_meal_daily WITH (security_invoker = true) AS
SELECT eaten_date              AS behavioral_date,
       count(*)::int           AS meal_count,
       sum(kcal)               AS est_kcal,
       sum(protein_g)          AS est_protein_g,
       sum(carbs_g)            AS est_carbs_g,
       sum(fat_g)              AS est_fat_g,
       min(eaten_at)           AS first_meal_at,
       max(eaten_at)           AS last_meal_at
  FROM pds.photo_meals
 GROUP BY eaten_date;

COMMENT ON VIEW pds.photo_meal_daily IS
    'Photo-logged meals per behavioral day (kcal, macros, first/last meal time). Same est_* columns as pds.delivery_nutrition_daily.';

GRANT SELECT ON pds.photo_meal_daily TO authenticated, service_role;
