// Unit identity of the supplement compound rollup (HIST-UNIT-01). Import-free (bundled by name in offline tests).
//
// pds.supplement_intake_by_compound has one row per (day, compound_key, ingredient_group, unii_code, unit_class):
// unit_class 'mass' = every mass unit converted to mg (pds.unit_to_mg_factor_for, which also maps Vitamin A / D / E
// IU with that vitamin's own factor); any other class is the literal label unit, never converted ('unitless' = a
// number with no unit). One compound in two classes is two rows: never added together and never one table row.
// Ingredients whose label gives no readable amount are not in the view at all; they are listed separately
// (unquantifiedIngredients), never as a 0 and never as an unknown unit.

export const MASS_UNIT_CLASS = "mass";
export const UNKNOWN_UNIT_CLASS = "unitless";

export interface CompoundIdentity {
  compound_key: string;
  ingredient_group?: string | null;
  unii_code?: string | null;
  unit_class?: string | null;
  unit?: string | null;
}

/** The row's unit class; a payload without one (older cached copy) takes it from `unit` ('mg' = mass, as the view). */
export function unitClassOf(c: { unit_class?: string | null; unit?: string | null }): string {
  if (typeof c.unit_class === "string" && c.unit_class.trim()) return c.unit_class;
  if (c.unit === "mg") return MASS_UNIT_CLASS;
  return typeof c.unit === "string" && c.unit.trim() ? c.unit : UNKNOWN_UNIT_CLASS;
}

/**
 * React key of a compound row: the rollup's own group key without the day. Distinct for mg / mL siblings of one
 * compound and the same for the same row across refreshes and reorders (never the list position).
 */
export function compoundRowKey(c: CompoundIdentity): string {
  return JSON.stringify([c.compound_key, c.ingredient_group ?? null, c.unii_code ?? null, unitClassOf(c)]);
}

/** Distinct compounds (a compound shown in two units counts once). */
export function distinctCompoundCount(rows: readonly CompoundIdentity[]): number {
  return new Set(rows.map((c) => c.compound_key)).size;
}

/** Same normalisation as pds.unit_to_mg_factor_for: letters only, lower case. */
export function isIuUnit(u: string): boolean {
  return u.toLowerCase().replace(/[^a-z]/g, "") === "iu";
}

function literalUnits(sourceUnits: unknown): string[] {
  if (!Array.isArray(sourceUnits)) return [];
  const out = new Set<string>();
  for (const u of sourceUnits) if (typeof u === "string" && u.trim()) out.add(u);
  return Array.from(out).sort();
}

export interface UnitLabel {
  /** Text after the amount ("" when the label gives no unit). */
  unit: string;
  /** True when the amount is mg after conversion. */
  converted: boolean;
  /** Short tag next to the unit, or null. */
  note: string | null;
  /** Tooltip of the tag, or null. */
  title: string | null;
}

/** How a row's amount is labelled: mg (with "from IU" provenance), or the literal unit marked as not converted. */
export function compoundUnitLabel(c: CompoundIdentity & { source_units?: unknown }): UnitLabel {
  const cls = unitClassOf(c);
  const sources = literalUnits(c.source_units);
  if (cls === MASS_UNIT_CLASS) {
    return sources.some(isIuUnit)
      ? { unit: "mg", converted: true, note: "from IU", title: `Converted to mg from ${sources.join(", ")} with this vitamin's own IU factor` }
      : { unit: "mg", converted: true, note: null, title: null };
  }
  if (cls === UNKNOWN_UNIT_CLASS) {
    return { unit: "", converted: false, note: "no unit", title: "The label gives a number with no unit: not converted and not added to any other row" };
  }
  return { unit: cls, converted: false, note: "not in mg", title: `Amount in ${cls} as on the label: not converted to mg and not added to an mg row` };
}

/** The view's own filter: an ingredient counts only when its quantity reads as digits and dots. */
export function isQuantified(q: unknown): boolean {
  if (typeof q === "number") return Number.isFinite(q) && q >= 0;
  return typeof q === "string" && /^[0-9.]+$/.test(q);
}

export interface UnquantifiedIngredient {
  /** ingredient_group, else the ingredient name. */
  name: string;
  /** The label's amount text when it is not a number (e.g. "blend"), else null. */
  label: string | null;
  /** Distinct products of the day that list it. */
  product_count: number;
}

/**
 * Ingredients of the day's intakes that the rollup leaves out because the label gives no readable amount.
 * `intakes` = one entry per intake with its product's ingredients JSON (the products table's array).
 */
export function unquantifiedIngredients(intakes: readonly { product_id: string; ingredients: unknown }[]): UnquantifiedIngredient[] {
  const byName = new Map<string, { label: string | null; products: Set<string> }>();
  for (const intake of intakes) {
    if (!Array.isArray(intake.ingredients)) continue;
    for (const ing of intake.ingredients) {
      if (!ing || typeof ing !== "object") continue;
      const rec = ing as Record<string, unknown>;
      if (isQuantified(rec.quantity)) continue;
      const group = typeof rec.ingredient_group === "string" && rec.ingredient_group.trim() ? rec.ingredient_group : null;
      const named = typeof rec.name === "string" && rec.name.trim() ? rec.name : null;
      const name = group ?? named ?? "Unnamed ingredient";
      const text = typeof rec.quantity === "string" && rec.quantity.trim() ? rec.quantity.trim().slice(0, 40) : null;
      const entry = byName.get(name) ?? { label: null, products: new Set<string>() };
      entry.label ??= text;
      entry.products.add(intake.product_id);
      byName.set(name, entry);
    }
  }
  return Array.from(byName.entries())
    .map(([name, e]) => ({ name, label: e.label, product_count: e.products.size }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// ── /analytics/hrv Supplement Dose-Response (hrv_analysis.supplement_dose_response_rows) ──────────────────────────
// One unit class per compound: a row's amounts are mg (IU converted with the vitamin's own factor) or one literal
// unit, never both. The coverage payload (supplement_impact / dose_response_coverage) says which compounds have no
// estimate and why, so a compound never disappears from the chart without a reason on screen.

export interface DoseLeftOut {
  compound: string;
  reason: string;
  unit_classes: string[];
  n_days: number;
}

export interface DoseCoverage {
  analyzed: number;
  /** Estimates that left out some days (an intake in another unit, or one without a readable amount). */
  withExcludedDays: number;
  /** False when the run could not check intakes without a readable amount (or the payload predates that check). */
  unquantifiedChecked: boolean;
  excluded: DoseLeftOut[];
}

function count(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** The stored coverage payload, or null when there is none or it is not an object. */
export function parseDoseCoverage(v: unknown): DoseCoverage | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const excluded: DoseLeftOut[] = [];
  if (Array.isArray(o.excluded)) {
    for (const e of o.excluded) {
      if (!e || typeof e !== "object") continue;
      const r = e as Record<string, unknown>;
      if (typeof r.compound !== "string" || !r.compound) continue;
      excluded.push({
        compound: r.compound,
        reason: typeof r.reason === "string" ? r.reason : "",
        unit_classes: Array.isArray(r.unit_classes) ? r.unit_classes.filter((u): u is string => typeof u === "string") : [],
        n_days: count(r.n_days),
      });
    }
  }
  return {
    analyzed: count(o.analyzed),
    withExcludedDays: count(o.with_excluded_days),
    unquantifiedChecked: o.unquantified_check === "checked",
    excluded,
  };
}

const LEFT_OUT_REASON: Record<string, string> = {
  unquantified: "no amount on the label",
  unknown_unit: "amounts without a unit",
  mixed_unconverted_units: "units that cannot be compared",
  too_few_comparable_days: "too few comparable days",
};

/** "Compound (why)" for a compound with no estimate; the units are named when they are the reason. */
export function doseLeftOutLabel(e: DoseLeftOut): string {
  const reason = LEFT_OUT_REASON[e.reason] ?? "left out";
  const shown = e.unit_classes.map((u) => (u === MASS_UNIT_CLASS ? "mg" : u === UNKNOWN_UNIT_CLASS ? "no unit" : u));
  const units = e.reason === "mixed_unconverted_units" && shown.length ? `: ${shown.join(", ")}` : "";
  return `${e.compound} (${reason}${units})`;
}

/** Unit shown next to a dose-response compound ("mg", "mg, from IU", "mL, not in mg"); null for a row without one. */
export function doseRowUnit(r: { unit?: unknown; converted?: unknown; converted_from_iu?: unknown }): string | null {
  const unit = typeof r.unit === "string" && r.unit.trim() ? r.unit : null;
  if (!unit) return null;
  if (r.converted_from_iu === true) return `${unit}, from IU`;
  if (r.converted === false) return `${unit}, not in mg`;
  return unit;
}

/** "3 days in another unit and 2 days without an amount left out", or null when the estimate left out no day. */
export function doseRowLeftOutDays(r: { excluded_days?: unknown }): string | null {
  const d = r.excluded_days && typeof r.excluded_days === "object" ? (r.excluded_days as Record<string, unknown>) : {};
  const other = count(d.other_unit);
  const none = count(d.unquantified);
  const parts: string[] = [];
  if (other) parts.push(`${other} ${other === 1 ? "day" : "days"} in another unit`);
  if (none) parts.push(`${none} ${none === 1 ? "day" : "days"} without an amount`);
  return parts.length ? `${parts.join(" and ")} left out` : null;
}

/** Lines shown under the dose-response chart; empty when there is nothing to say. */
export function doseCoverageLines(c: DoseCoverage | null, max = 6): string[] {
  if (!c) return [];
  const lines: string[] = [];
  if (c.excluded.length) {
    const shown = c.excluded.slice(0, max).map(doseLeftOutLabel);
    const more = c.excluded.length - shown.length;
    lines.push(`No estimate: ${shown.join(" · ")}${more > 0 ? ` · ${more} more` : ""}`);
  }
  if (c.withExcludedDays) {
    lines.push(`${c.withExcludedDays === 1 ? "1 estimate leaves" : `${c.withExcludedDays} estimates leave`} out days logged in another unit or without an amount.`);
  }
  if ((c.excluded.length || c.withExcludedDays || c.analyzed) && !c.unquantifiedChecked) {
    lines.push("Intakes without a readable amount were not checked on this run.");
  }
  return lines;
}

/** Whether the dose-response card has something to show: estimates, or compounds left out with a reason. */
export function showDoseResponseCard(rows: readonly unknown[], c: DoseCoverage | null): boolean {
  return rows.length > 0 || (c?.excluded.length ?? 0) > 0;
}
