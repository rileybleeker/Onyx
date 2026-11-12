import { createHash } from "crypto";

// merchant_kind keyword rule — MIRRORS ALCOHOL_WORDS / STORE_WORDS in
// delivery_email_etl.py (keep the two lists in step, the way lib/dsld.ts mirrors
// supplement_lookup.py). Only 'restaurant' orders count toward meal features.
const ALCOHOL_WORDS = [
  "package store", "liquor", "wine & spirits", "wine and spirits", "total wine", "bottle shop",
  "beverage", "spirits", "beer & wine", "beer and wine", "abc fine wine", "bevmo",
];
const STORE_WORDS = [
  "quick save", "mini market", "mini mart", "minimart", "supermarket", "cvs", "walgreens", "pharmacy",
  "food mart", "7-eleven", "7 eleven", "convenience", "grocery", "kroger", "publix", "whole foods", "target",
  "costco", "walmart", "safeway", "sprouts", "trader joe", "petco", "petsmart", "dollar general",
  "family dollar", "gopuff", "circle k", "quiktrip", "racetrac", "food lion", "aldi",
  "shoppers drug mart", "sobeys",
];

export type MerchantKind = "restaurant" | "alcohol" | "store";

// Exact merchant name -> kind, checked before the keyword lists. MIRRORS MERCHANT_KIND_OVERRIDES
// in delivery_email_etl.py: a correction goes in both files, never in an UPDATE on the table
// (the next import rewrites merchant_kind from this rule).
const MERCHANT_KIND_OVERRIDES: Record<string, MerchantKind> = {};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function merchantKind(name: string): MerchantKind {
  if (Object.prototype.hasOwnProperty.call(MERCHANT_KIND_OVERRIDES, name)) return MERCHANT_KIND_OVERRIDES[name];
  const n = name.toLowerCase();
  if (ALCOHOL_WORDS.some((w) => n.includes(w))) return "alcohol";
  if (STORE_WORDS.some((w) => new RegExp(`(?<![a-z])${escapeRe(w)}(?![a-z])`).test(n))) return "store";
  return "restaurant";
}

export interface ItemCustomization {
  title?: string | null;
  options?: string[] | null;
}

/** "Size: Large; Add: Bacon, Avocado" — the text the estimator sees and the est_key hashes. */
export function customizationsText(c: ItemCustomization[] | null | undefined): string {
  return (c ?? [])
    .map((x) => {
      const opts = (x.options ?? []).filter(Boolean).join(", ");
      const title = (x.title ?? "").trim();
      return title && opts ? `${title}: ${opts}` : title || opts;
    })
    .filter(Boolean)
    .join("; ");
}

/** One estimate per distinct dish: same store + title + customizations → same key. */
export function estKey(store: string, title: string, c: ItemCustomization[] | null | undefined): string {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
  return createHash("sha256")
    .update([norm(store), norm(title), norm(customizationsText(c))].join("|"))
    .digest("hex")
    .slice(0, 32);
}

// ─── Uber Eats harvester payload → pds.delivery_order_items rows ─────────────
// (tools/ubereats_harvest/harvest.mjs posts these to /api/delivery/items/import)

export interface HarvestItem {
  key?: string;
  title?: string;
  quantity?: number | null;
  price?: number | null; // cents
  customizations?: ItemCustomization[] | null;
}
export interface HarvestOrder {
  uuid?: string;
  store?: string;
  completedAt?: string | null;
  isCancelled?: boolean;
  currency?: string | null;
  total?: number | null; // cents
  multiConsumer?: boolean;
  items?: HarvestItem[];
}

/**
 * Upsert rows for pds.delivery_order_items. FACTS ONLY: the row never carries eaten_fraction (how much
 * Riley ate, set by hand on /nutrition and /check-in), so the importer's ON CONFLICT DO UPDATE leaves a
 * set portion alone on every re-harvest. tests/delivery-portion.test.cjs asserts the key set.
 */
export function buildOrderItemRows(orders: HarvestOrder[]) {
  // Values come from Uber's JSON by way of the harvester: coerce them so one odd order
  // (a string price, a bad date) cannot make the whole upsert throw or store garbage.
  const cents = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) / 100 : null);
  const isoOrNull = (v: unknown) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null);
  const rows = [];
  for (const o of orders) {
    if (!o || typeof o.uuid !== "string" || typeof o.store !== "string" || !o.uuid || !o.store.trim()) continue;
    const store = o.store.trim().slice(0, 200);
    const kind = merchantKind(store);
    const items = Array.isArray(o.items) ? o.items : [];
    for (const [idx, it] of items.entries()) {
      if (!it || typeof it.title !== "string" || !it.title.trim()) continue;
      const title = it.title.trim().slice(0, 300);
      const customizations = Array.isArray(it.customizations) ? it.customizations : [];
      const qty = typeof it.quantity === "number" && Number.isFinite(it.quantity) && it.quantity > 0 ? it.quantity : 1;
      rows.push({
        provider: "uber_eats",
        order_uuid: o.uuid,
        item_key: typeof it.key === "string" && it.key ? it.key : `idx:${idx}`,
        store_name: store,
        merchant_kind: kind,
        completed_at: isoOrNull(o.completedAt),
        is_cancelled: !!o.isCancelled,
        order_total: cents(o.total),
        currency: typeof o.currency === "string" ? o.currency.slice(0, 8) : null,
        multi_consumer: !!o.multiConsumer,
        title,
        quantity: qty,
        price: cents(it.price),
        customizations,
        est_key: estKey(store, title, customizations),
      });
    }
  }
  return rows;
}
