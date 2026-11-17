// Quality gate for one model-estimated delivery dish (OPS: dish estimate quality, 2026-11-17).
//
// Pure and import-free so tests can bundle it. A model estimate that fails a rule is never stored:
// the route skips it from the upsert and counts it as not accepted in the pilot observation, so the
// cost gate sees a plausible-looking but wrong answer instead of recording it as a result.

export type EstimateKind = "food" | "drink" | "alcohol" | "non_food";

/** The estimate fields the gate reads (the model reply's row, after JSON parsing). */
export interface EstimateLike {
  kind: EstimateKind;
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  alcohol_g: number;
}

export interface EstimateQuality {
  usable: boolean;
  reason: string;
}

/** kcal must be a finite number in [0, 5000]. */
const KCAL_MIN = 0;
const KCAL_MAX = 5000;
/** When kcal > 50, the macro energy (4p + 4c + 9f) must stay within this share of it. */
const MACRO_ENERGY_TOLERANCE = 0.35;
/** A non-alcoholic drink may carry zero macros, but not more than this many kcal. */
const DRINK_MAX_KCAL = 1000;

const ok = (): EstimateQuality => ({ usable: true, reason: "ok" });
const bad = (reason: string): EstimateQuality => ({ usable: false, reason });

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Whether one estimate is usable, with a reason string (never data: no dish, store or price text).
 * The route clamps negatives to zero only AFTER this gate, so a negative macro value is judged as
 * the zero it would become, not rejected for being negative.
 */
export function estimateQuality(e: EstimateLike): EstimateQuality {
  const kcal = num(e.kcal);
  if (!Number.isFinite(kcal) || kcal < KCAL_MIN || kcal > KCAL_MAX) {
    return bad("kcal_out_of_range");
  }
  const protein = Math.max(0, num(e.protein_g));
  const carbs = Math.max(0, num(e.carbs_g));
  const fat = Math.max(0, num(e.fat_g));
  const alcohol = Math.max(0, num(e.alcohol_g));

  if (e.kind === "non_food") return ok();

  if (e.kind === "alcohol") {
    if (alcohol <= 0) return bad("alcohol_without_alcohol");
    return ok();
  }

  // food and drink
  if (alcohol > 0) return bad("alcohol_on_non_alcohol_kind");
  if (e.kind === "food") {
    if (protein <= 0 && carbs <= 0 && fat <= 0) return bad("food_without_macros");
    if (kcal > 50) {
      const macroEnergy = 4 * protein + 4 * carbs + 9 * fat;
      const within = Math.abs(macroEnergy - kcal) <= MACRO_ENERGY_TOLERANCE * kcal;
      if (!within) return bad("macro_energy_mismatch");
    }
    return ok();
  }
  // drink with no alcohol: macros may be zero, but the kcal must fit a drink
  if (kcal > DRINK_MAX_KCAL) return bad("drink_kcal_too_high");
  return ok();
}
