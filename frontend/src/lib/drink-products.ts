// Drinks Onyx knows the label of (PROD-CAFF-01, direct drink capture). Each product is one exact retail item
// (brand, flavor, container size) with a VERSIONED label snapshot and where it was read. The Say it model may only
// pick one of these ids; the save route resolves the id here and stores a copy of the label on the row, so a later
// label change (a new version here) never rewrites what was already logged.
//
// Rules:
//   - One product = one exact item. Never a brand rule: another flavor, size or the powder is a different product
//     (or not in this list at all, so it stays unresolved).
//   - Every required number is known (kcal, protein, carbs, fat, caffeine). A product with an unknown required
//     value is not usable (validateDrinkProduct); optional ones (sugar, sodium) may be null = unknown, never 0.
//   - Values are per container as printed. Quantities are in containers (a half can = 0.5).
//
// Pure: no network, no React. Used by the voice route, the drinks route, the Log Drinks section and tests.

export interface DrinkLabel {
  /** Serving as printed: one container. */
  serving: string;
  serving_fl_oz: number;
  kcal: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  /** Optional: null = not on the label snapshot (unknown, never read as 0). */
  sugar_g: number | null;
  sodium_mg: number | null;
  caffeine_mg: number | null;
}

export interface DrinkProduct {
  id: string;
  /** Bumped whenever the label values change; stored with each capture. */
  version: number;
  brand: string;
  name: string;
  flavor: string;
  container: "can";
  label: DrinkLabel;
  /** Where the label was read (stored with each capture as provenance). */
  source: { page: string; label_image: string; read_on: string };
}

export const DRINK_PRODUCTS: ReadonlyArray<DrinkProduct> = [
  {
    id: "gorilla-mind-energy-wild-grape-16oz",
    version: 1,
    brand: "Gorilla Mind",
    name: "Gorilla Mind Energy Drink, Wild Grape",
    flavor: "Wild Grape",
    container: "can",
    label: {
      serving: "1 can (16 fl oz)",
      serving_fl_oz: 16,
      kcal: 5,
      protein_g: 0,
      carbs_g: 1,
      fat_g: 0,
      sugar_g: 0,
      sodium_mg: 25,
      caffeine_mg: 200,
    },
    source: {
      page: "https://gorillamind.com/products/gorilla-mind-energy-drink",
      label_image: "https://gorillamind.com/cdn/shop/files/WG-GorillaMind_LFR12_16oz_Can_109mm-PMS-OUTLINED.png?v=1690791691",
      read_on: "2026-11-15",
    },
  },
];

const REQUIRED: ReadonlyArray<keyof DrinkLabel> = ["kcal", "protein_g", "carbs_g", "fat_g", "caffeine_mg"];

/** Why a product definition is not usable (null = usable). Required values known, all numbers finite and >= 0. */
export function validateDrinkProduct(p: DrinkProduct): string | null {
  if (!/^[a-z0-9-]{3,80}$/.test(p.id)) return "bad id";
  if (!Number.isInteger(p.version) || p.version < 1) return "bad version";
  if (!(p.label.serving_fl_oz > 0)) return "bad serving size";
  for (const k of REQUIRED) {
    const v = p.label[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return `${k} unknown`;
  }
  for (const k of ["sugar_g", "sodium_mg"] as const) {
    const v = p.label[k];
    if (v !== null && (typeof v !== "number" || !Number.isFinite(v) || v < 0)) return `${k} invalid`;
  }
  return null;
}

/** A usable product by id (exact), or null. */
export function drinkProduct(id: unknown): DrinkProduct | null {
  if (typeof id !== "string") return null;
  const p = DRINK_PRODUCTS.find((d) => d.id === id);
  return p && validateDrinkProduct(p) === null ? p : null;
}

/** What the Say it model is shown: ids and names only. */
export function drinkCandidates(): Array<{ id: string; name: string }> {
  return DRINK_PRODUCTS.filter((p) => validateDrinkProduct(p) === null).map((p) => ({ id: p.id, name: `${p.name}, ${p.label.serving}` }));
}

// ---- matching what was said ----------------------------------------------------------------------------------

export type DrinkIssue = "powder" | "flavor" | "unknown";

export type DrinkMatch = { kind: "match"; product: DrinkProduct } | { kind: "unresolved"; issue: DrinkIssue };

const norm = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;

/** Words that mean the powder / pre-workout, not the canned drink. */
const POWDER = [" powder ", " pre workout ", " preworkout ", " scoop ", " scoops ", " tub ", " gorilla mode ", " mix "];
const GORILLA_MIND = [" gorilla mind ", " gorillamind "];
const OTHER_FLAVORS = [" cherry ", " mango ", " lime ", " lemon ", " peach ", " berry ", " watermelon ", " orange ", " apple ", " punch ", " rainbow ", " candy ", " strawberry ", " blue ", " tropical ", " citrus "];

/**
 * The words used for a drink -> one product, or why it stays unresolved. Deliberately narrow: the brand AND the
 * flavor must both be said; the powder or pre-workout is never the can; another flavor is not in the list.
 * `modelPick` (an id the model chose from drinkCandidates) is only accepted when the words do not contradict it.
 */
export function matchDrinkProduct(said: string, modelPick: string | null = null): DrinkMatch | null {
  const s = norm(said);
  const brand = GORILLA_MIND.some((b) => s.includes(b));
  if (!brand) {
    // Not one of ours by its words: the model's pick alone is not enough (it might be guessing).
    return modelPick ? { kind: "unresolved", issue: "unknown" } : null;
  }
  if (POWDER.some((w) => s.includes(w))) return { kind: "unresolved", issue: "powder" };
  if (OTHER_FLAVORS.some((w) => s.includes(w))) return { kind: "unresolved", issue: "unknown" };
  if (!s.includes(" grape ")) return { kind: "unresolved", issue: "flavor" };
  const p = drinkProduct("gorilla-mind-energy-wild-grape-16oz");
  return p ? { kind: "match", product: p } : { kind: "unresolved", issue: "unknown" };
}

export const DRINK_ISSUE_TEXT: Record<DrinkIssue, string> = {
  powder: "Sounds like the powder or pre-workout, not the can. Not logged as the drink.",
  flavor: "Which flavor? Only Wild Grape is in the drink list.",
  unknown: "Not in the drink list yet. Nothing was counted.",
};
