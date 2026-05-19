/**
 * Server-side DSLD (NIH Dietary Supplement Label Database) client.
 *
 * Mirrors the parsing logic in supplement_lookup.py so the Next.js seed flow
 * and the Python CLI produce identical rows in pds.supplement_products.
 *
 * DSLD is public, no auth. We always proxy through our /api routes — the
 * browser never hits dsld.od.nih.gov directly so we can rate-limit / cache
 * later if needed.
 */

const DSLD_API = "https://api.ods.od.nih.gov/dsld/v9";

export interface DsldHit {
  id: string;
  brand_name: string | null;
  full_name: string | null;
  upc_sku: string | null;
  physical_state: string | null;
}

export interface NormalizedIngredient {
  name: string | null;
  ingredient_group: string | null;
  unii_code: string | null;
  category: string | null;
  quantity: number | null;
  unit: string | null;
  percent_dv: number | null;
  forms: Array<{
    name: string | null;
    ingredient_group: string | null;
    unii_code: string | null;
    category: string | null;
    percent: number | null;
  }>;
  notes: string | null;
}

export interface NormalizedProduct {
  product_id: string;
  dsld_id: number;
  brand_name: string | null;
  full_name: string | null;
  upc_sku: string | null;
  serving_size: number | null;
  serving_unit: string | null;
  servings_per_container: number | null;
  product_type: string | null;
  physical_state: string | null;
  target_groups: string[];
  ingredients: NormalizedIngredient[];
  off_market: boolean;
  raw_json: unknown;
}

/** UPCs in DSLD often have spaces and dashes — strip to digits only. */
export function digitsOnly(s: string | null | undefined): string | null {
  if (!s) return null;
  const out = s.replace(/\D/g, "");
  return out.length > 0 ? out : null;
}

export async function dsldSearch(query: string, size = 10): Promise<DsldHit[]> {
  const url = new URL(`${DSLD_API}/search-filter`);
  url.searchParams.set("q", query);
  url.searchParams.set("size", String(size));
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`DSLD search returned ${res.status}`);
  const json = (await res.json()) as { hits?: Array<{ _id: string; _source: Record<string, unknown> }> };
  return (json.hits ?? []).map((h) => ({
    id: h._id,
    brand_name: (h._source.brandName as string | null) ?? null,
    full_name: (h._source.fullName as string | null) ?? null,
    upc_sku: digitsOnly(h._source.upcSku as string | null | undefined),
    physical_state:
      ((h._source.physicalState as { langualCodeDescription?: string } | undefined)
        ?.langualCodeDescription) ?? null,
  }));
}

export async function dsldLabel(dsldId: number): Promise<Record<string, unknown>> {
  const res = await fetch(`${DSLD_API}/label/${dsldId}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`DSLD label ${dsldId} returned ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

function flattenIngredient(ing: Record<string, unknown>): NormalizedIngredient {
  const qtyList = (ing.quantity as Array<Record<string, unknown>> | undefined) ?? [];
  const q = qtyList[0] ?? {};
  const dvList = (q.dailyValueTargetGroup as Array<Record<string, unknown>> | undefined) ?? [];
  const dv = dvList[0] ?? {};
  const forms = ((ing.forms as Array<Record<string, unknown>> | undefined) ?? []).map((f) => ({
    name: (f.name as string | null) ?? null,
    ingredient_group: (f.ingredientGroup as string | null) ?? null,
    unii_code: (f.uniiCode as string | null) ?? null,
    category: (f.category as string | null) ?? null,
    percent: (f.percent as number | null) ?? null,
  }));
  const quantityRaw = q.quantity;
  return {
    name: (ing.name as string | null) ?? null,
    ingredient_group: (ing.ingredientGroup as string | null) ?? null,
    unii_code: (ing.uniiCode as string | null) ?? null,
    category: (ing.category as string | null) ?? null,
    quantity: typeof quantityRaw === "number" ? quantityRaw : null,
    unit: (q.unit as string | null) ?? null,
    percent_dv: (dv.percent as number | null) ?? null,
    forms,
    notes: (ing.notes as string | null) ?? null,
  };
}

export function normalizeLabel(label: Record<string, unknown>): NormalizedProduct {
  const dsldId = label.id as number;
  const servingSizes = (label.servingSizes as Array<Record<string, unknown>> | undefined) ?? [];
  const serving = servingSizes[0] ?? {};
  const netContents = (label.netContents as Array<Record<string, unknown>> | undefined) ?? [];
  const net = netContents[0] ?? {};
  const ingredientRows = (label.ingredientRows as Array<Record<string, unknown>> | undefined) ?? [];
  const ingredients = ingredientRows.map(flattenIngredient);
  const servingsPerContainer =
    typeof net.quantity === "number" && net.unit === serving.unit ? (net.quantity as number) : null;

  return {
    product_id: `dsld_${dsldId}`,
    dsld_id: dsldId,
    brand_name: (label.brandName as string | null) ?? null,
    full_name: (label.fullName as string | null) ?? null,
    upc_sku: digitsOnly(label.upcSku as string | null | undefined),
    serving_size: (serving.minQuantity as number | null) ?? null,
    serving_unit: (serving.unit as string | null) ?? null,
    servings_per_container: servingsPerContainer,
    product_type:
      ((label.productType as { langualCodeDescription?: string } | undefined)
        ?.langualCodeDescription) ?? null,
    physical_state:
      ((label.physicalState as { langualCodeDescription?: string } | undefined)
        ?.langualCodeDescription) ?? null,
    target_groups: (label.targetGroups as string[] | undefined) ?? [],
    ingredients,
    off_market: (label.offMarket as boolean | undefined) ?? false,
    raw_json: label,
  };
}
