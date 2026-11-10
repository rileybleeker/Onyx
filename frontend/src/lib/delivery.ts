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
