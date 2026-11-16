// A supplement label read counts as an accepted result only when it holds a usable product:
// a product name and at least one ingredient with a name (and, when present, a quantity that is a
// finite number >= 0). Pure, no imports. Used by the label photo route before it records success.

const text = (v: unknown): boolean => typeof v === "string" && v.trim().length > 0;

export function isUsableLabel(p: unknown): boolean {
  if (!p || typeof p !== "object") return false;
  const o = p as { full_name?: unknown; brand_name?: unknown; ingredients?: unknown };
  if (!text(o.full_name) && !text(o.brand_name)) return false;
  if (!Array.isArray(o.ingredients) || o.ingredients.length === 0) return false;
  return o.ingredients.every((i) => {
    if (!i || typeof i !== "object") return false;
    const ing = i as { name?: unknown; quantity?: unknown };
    if (!text(ing.name)) return false;
    return ing.quantity == null || (typeof ing.quantity === "number" && Number.isFinite(ing.quantity) && ing.quantity >= 0);
  });
}
