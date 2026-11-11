import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Log one product from the /supplements list by NAME, with an optional
 * amount ("15 mg", "2 capsules") and optional clock times — the single-product
 * sibling of logStackIntake. Used by the log_supplement_intake chat tool
 * ("log 15 mg of Adderall at 8:30am and noon").
 *
 * Writes ordinary pds.supplement_intake rows (one per time), so every rollup
 * and the HRV/causal pipeline pick them up unchanged.
 *
 * Conventions honored (see AGENTS.md, supplement intake):
 *   - intake_date = behavioral day (defaults to pds.behavioral_today_now()).
 *   - A clock time before 06:00 belongs to the NEXT calendar day's small hours
 *     (awake tail), so its instant still resolves back to intake_date under the
 *     -6h rule and stays "trusted" by the caffeine timing layer.
 *   - No times + today → stamped now. No times + a past day → intake_time NULL
 *     ("time unspecified"), never a fake "now".
 *
 * The Supabase client passed in MUST already be scoped to schema "pds".
 */

interface Ingredient {
  name: string | null;
  ingredient_group: string | null;
  quantity: number | null;
  unit: string | null;
  notes?: string | null;
  forms?: Array<{ name: string | null; ingredient_group: string | null }>;
}

interface Product {
  product_id: string;
  brand_name: string | null;
  full_name: string | null;
  serving_size: number | null;
  serving_unit: string | null;
  ingredients: Ingredient[];
}

export interface LogIntakeInput {
  product: string;
  amount?: number | null;
  unit?: string | null;
  times?: string[] | null;
  date?: string | null;
  notes?: string | null;
}

export interface LogIntakeResult {
  ok: boolean;
  error?: string;
  /** Set on an ambiguous / missing product so the model can ask. */
  candidates?: string[];
  product?: string;
  product_id?: string;
  intake_date?: string;
  timezone?: string;
  doses_each?: number;
  amount_each?: string;
  logged?: Array<{ intake_id: number; time: string | null }>;
  skipped_duplicates?: string[];
}

const norm = (s: string | null | undefined) =>
  (s ?? "").toLowerCase().replace(/[^a-z0-9µ.]+/g, " ").trim();

const label = (p: Product) => [p.brand_name, p.full_name].filter(Boolean).join(" ");

// ---------- product matching ----------

function ingredientText(p: Product): string {
  return norm(
    (p.ingredients ?? [])
      .flatMap((i) => [i.name, i.ingredient_group, i.notes, ...(i.forms ?? []).flatMap((f) => [f.name, f.ingredient_group])])
      .join(" "),
  );
}

/** 3 = exact name, 2 = every word in the product name, 1 = every word found
 *  once ingredient names/notes are included (e.g. a brand name kept in notes). */
function matchScore(p: Product, query: string): number {
  const q = norm(query);
  const tokens = q.split(" ").filter(Boolean);
  if (tokens.length === 0) return 0;
  const name = norm(label(p));
  if (name === q || norm(p.full_name) === q) return 3;
  if (tokens.every((t) => name.includes(t))) return 2;
  const all = `${name} ${ingredientText(p)}`;
  if (tokens.every((t) => all.includes(t))) return 1;
  return 0;
}

export function resolveProduct(
  products: Product[],
  query: string,
): { match?: Product; candidates: Product[] } {
  const scored = products.map((p) => ({ p, s: matchScore(p, query) })).filter((x) => x.s > 0);
  if (scored.length === 0) return { candidates: [] };
  const best = Math.max(...scored.map((x) => x.s));
  const top = scored.filter((x) => x.s === best).map((x) => x.p);
  return top.length === 1 ? { match: top[0], candidates: top } : { candidates: top };
}

// ---------- amount → doses ----------

const MASS_TO_MG: Record<string, number> = { g: 1000, mg: 1, mcg: 0.001, ug: 0.001, "µg": 0.001 };
const PILL_WORDS = new Set(["pill", "tablet", "tab", "capsule", "cap", "softgel", "gel", "caplet"]);

/** "Capsule(s)" / "Vegetable Capsule" / "Gummy(ies)" / "softgels" → "capsule" / "gummy" / "softgel". */
function countUnit(u: string | null | undefined): string {
  const w = (u ?? "").toLowerCase().replace(/\([^)]*\)/g, "").trim().split(/\s+/).pop() ?? "";
  if (w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  return w.endsWith("s") ? w.slice(0, -1) : w;
}

export function dosesFor(
  p: Product,
  query: string,
  amount: number | null | undefined,
  unit: string | null | undefined,
): { doses: number; amount_each?: string } | { error: string } {
  if (amount == null) return { doses: 1 };
  if (!Number.isFinite(amount) || amount <= 0) return { error: "amount must be a positive number" };

  const serving = `${p.serving_size ?? 1} ${p.serving_unit ?? "serving"}`;
  const u = (unit ?? "").toLowerCase().trim();
  if (!u || ["serving", "servings", "dose", "doses"].includes(u)) return { doses: amount };

  // Weight (mg / mcg / g) or IU → divide by what one serving contains.
  if (u in MASS_TO_MG || u === "iu") {
    const withQty = (p.ingredients ?? []).filter((i) => i.quantity != null && i.quantity > 0 && i.unit);
    let target = withQty.length === 1 ? withQty[0] : undefined;
    if (!target) {
      const tokens = norm(query).split(" ").filter(Boolean);
      const named = withQty.filter((i) => {
        const t = norm(`${i.name} ${i.ingredient_group} ${i.notes ?? ""}`);
        return tokens.some((tok) => tok.length > 2 && t.includes(tok));
      });
      if (named.length === 1) target = named[0];
    }
    if (!target) {
      return {
        error: `"${label(p)}" has ${withQty.length} ingredients per ${serving}, so ${amount} ${unit} is ambiguous. Ask how many servings were taken.`,
      };
    }
    const tu = (target.unit ?? "").toLowerCase().trim();
    let perServing: number | null = null;
    if (u === "iu" && tu === "iu") perServing = target.quantity!;
    else if (u in MASS_TO_MG && tu in MASS_TO_MG) perServing = (target.quantity! * MASS_TO_MG[tu]) / MASS_TO_MG[u];
    if (perServing == null) {
      return { error: `"${label(p)}" lists ${target.quantity} ${target.unit} ${target.name} per ${serving}; cannot convert ${amount} ${unit}.` };
    }
    return {
      doses: Math.round((amount / perServing) * 10000) / 10000,
      amount_each: `${amount} ${unit} ${target.name ?? target.ingredient_group ?? ""}`.trim(),
    };
  }

  // Count units (capsules, scoops, gummies…) → divide by the serving size.
  const mine = countUnit(u);
  const theirs = countUnit(p.serving_unit);
  if (mine === theirs || (PILL_WORDS.has(mine) && PILL_WORDS.has(theirs))) {
    return {
      doses: Math.round((amount / (p.serving_size || 1)) * 10000) / 10000,
      amount_each: `${amount} ${unit}`,
    };
  }
  return { error: `"${label(p)}" is measured in ${serving}; cannot convert ${amount} ${unit}. Ask how many servings were taken.` };
}

// ---------- clock times ----------

/** "08:30" | "8:30am" | "12pm" | "noon" | "midnight" → {h, m}. */
export function parseClock(s: string): { h: number; m: number } | null {
  const t = s.toLowerCase().trim().replace(/\./g, "");
  if (t === "noon") return { h: 12, m: 0 };
  if (t === "midnight") return { h: 0, m: 0 };
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[3] === "pm" ? 12 : 0);
  }
  if (h > 23 || min > 59) return null;
  return { h, m: min };
}

function tzOffsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const g = (type: string) => Number(parts.find((x) => x.type === type)?.value);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - utcMs;
}

/** The instant at which a wall clock in `tz` reads `dateStr h:m`. */
export function wallClockToUtc(dateStr: string, h: number, m: number, tz: string): Date {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const naive = Date.UTC(y, mo - 1, d, h, m);
  let utc = naive - tzOffsetMs(naive, tz);
  const again = naive - tzOffsetMs(utc, tz); // second pass settles DST edges
  if (again !== utc) utc = again;
  return new Date(utc);
}

function addDays(dateStr: string, n: number): string {
  const [y, mo, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d + n)).toISOString().slice(0, 10);
}

/** Instant for a clock time on behavioral day `day`: before 06:00 = the small
 *  hours that close that day, i.e. the next calendar date. */
export function instantOnBehavioralDay(day: string, h: number, m: number, tz: string): Date {
  return wallClockToUtc(h < 6 ? addDays(day, 1) : day, h, m, tz);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Pds = SupabaseClient<any, any, any>;

/** The time zone Riley is in at `at` (pds.user_tz_log ladder; ET fallback). */
export async function currentTimeZone(supabase: Pds, at: Date = new Date()): Promise<string> {
  try {
    const { data } = await supabase.rpc("tz_for_instant", { ts: at.toISOString() });
    return (data as string | null) || "America/New_York";
  } catch {
    return "America/New_York";
  }
}

export async function behavioralToday(supabase: Pds): Promise<string> {
  const etClock = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  try {
    const { data } = await supabase.rpc("behavioral_today_now");
    return (data as string | null) || etClock();
  } catch {
    return etClock();
  }
}

// ---------- the write ----------

export async function logSupplementIntake(supabase: Pds, input: LogIntakeInput): Promise<LogIntakeResult> {
  const query = (input.product ?? "").trim();
  if (!query) return { ok: false, error: "product is required" };

  const { data: products, error: prodErr } = await supabase
    .from("supplement_products")
    .select("product_id,brand_name,full_name,serving_size,serving_unit,ingredients")
    .eq("is_active", true);
  if (prodErr) return { ok: false, error: prodErr.message };

  const { match, candidates } = resolveProduct((products ?? []) as Product[], query);
  if (!match) {
    return candidates.length > 1
      ? { ok: false, error: `"${query}" matches more than one product. Ask which one.`, candidates: candidates.map(label) }
      : {
          ok: false,
          error: `No product matching "${query}" in the supplements list. It has to be added on the /supplements page first.`,
          candidates: ((products ?? []) as Product[]).map(label),
        };
  }

  const dose = dosesFor(match, query, input.amount, input.unit);
  if ("error" in dose) return { ok: false, error: dose.error, product: label(match) };

  const today = await behavioralToday(supabase);
  const intake_date = input.date || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(intake_date)) return { ok: false, error: "date must be YYYY-MM-DD" };

  const tz = await currentTimeZone(supabase, wallClockToUtc(intake_date, 12, 0, "America/New_York"));

  let stamps: Array<string | null>;
  if (input.times && input.times.length > 0) {
    stamps = [];
    for (const raw of input.times) {
      const c = parseClock(String(raw));
      if (!c) return { ok: false, error: `Could not read the time "${raw}". Use 24-hour HH:MM.` };
      stamps.push(instantOnBehavioralDay(intake_date, c.h, c.m, tz).toISOString());
    }
  } else {
    stamps = [intake_date === today ? new Date().toISOString() : null];
  }

  // A re-sent message must not double-log: skip a timed entry that already
  // exists for this product + day + instant + dose.
  const { data: existing } = await supabase
    .from("supplement_intake")
    .select("intake_time,doses")
    .eq("product_id", match.product_id)
    .eq("intake_date", intake_date);
  const seen = new Set(
    (existing ?? [])
      .filter((r) => r.intake_time)
      .map((r) => `${new Date(r.intake_time as string).getTime()}|${Number(r.doses)}`),
  );
  const timed = !!(input.times && input.times.length > 0);
  const fresh = stamps.filter((s) => !(timed && s && seen.has(`${new Date(s).getTime()}|${dose.doses}`)));
  const skipped = stamps.filter((s) => !fresh.includes(s)) as string[];

  const local = (iso: string | null) =>
    iso
      ? new Date(iso).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" })
      : null;

  let logged: Array<{ intake_id: number; time: string | null }> = [];
  if (fresh.length > 0) {
    const rows = fresh.map((intake_time) => ({
      product_id: match.product_id,
      doses: dose.doses,
      intake_date,
      intake_time,
      notes: input.notes ?? "Logged from chat",
    }));
    const { data: inserted, error: insErr } = await supabase
      .from("supplement_intake")
      .insert(rows)
      .select("intake_id,intake_time");
    if (insErr) return { ok: false, error: insErr.message };
    logged = (inserted ?? []).map((r) => ({ intake_id: r.intake_id, time: local(r.intake_time) }));
  }

  return {
    ok: true,
    product: label(match),
    product_id: match.product_id,
    intake_date,
    timezone: tz,
    doses_each: dose.doses,
    amount_each: dose.amount_each,
    logged,
    skipped_duplicates: skipped.length > 0 ? skipped.map((s) => local(s)!) : undefined,
  };
}
