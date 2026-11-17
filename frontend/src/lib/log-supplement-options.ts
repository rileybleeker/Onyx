/**
 * The /log Supplements "Log a product" options (docs/agents/supplements.md "Supplements on /log", 2026-11-16): every
 * active product from the /supplements list as a tappable option, shown without typing, most used first. The search
 * box filters the same options; a tap selects (several can be selected, lib/log-supplement-multi.ts holds the
 * selection). Pure and import-free (tests/log-supplement-options.test.cjs); the section reads the data.
 *
 * "Most used" = single-product doses (not doses a stack logged) among the newest 200 intakes of the last 30 days
 * (`GET /api/supplements/history`, which caps a page at 200 rows; stack doses use up part of that, so with daily
 * stacks it reaches back fewer days) plus behavioral today's `GET /api/supplements/today`, then the most recent, then
 * the name. The section shows the options as soon as the products are in (never waiting for a network read of the
 * history), fixes their order on that first display and keeps it while it is mounted.
 */

export interface OptionProduct {
  product_id: string;
  brand_name: string | null;
  full_name: string | null;
}

/** One intake row as the section reads it: today's or the 30-day history (both carry `stack_id` and `notes`). */
export interface UsageRow {
  intake_id: number;
  product_id: string;
  intake_date: string;
  intake_time: string | null;
  stack_id?: number | null;
  notes?: string | null;
}

export interface Usage {
  count: number;
  /** "YYYY-MM-DD|<intake_time or empty>" of the newest dose: compares as a string. */
  last: string;
}

/** Options shown before "Show all". */
export const OPTIONS_CAP = 12;

/**
 * The note lib/supplement-stacks.ts writes on every dose a stack logged. A fallback only: a dose with a `stack_id`
 * is a stack's whatever its note says; the note covers a history copy cached before the route returned `stack_id`.
 */
const STACK_NOTE = "Logged from stack";

export const normName = (s: string | null | undefined) => (s ?? "").toLowerCase().replace(/[^a-z0-9µ.]+/g, " ").trim();
const labelOf = (p: OptionProduct) => p.full_name?.trim() || p.brand_name?.trim() || "Product";

/** A dose a stack logged: picked with the stack's Log it, so it does not make the product a frequent pick. */
export function fromStack(r: UsageRow): boolean {
  if (r.stack_id != null) return true;
  return typeof r.notes === "string" && r.notes.startsWith(STACK_NOTE);
}

/**
 * Doses per product. A later row with the same intake id replaces an earlier one (pass the history first, then
 * today's rows, which say exactly whether a stack logged them); `skip` = intake ids being removed (Undo).
 */
export function usageByProduct(rows: Iterable<UsageRow>, skip: ReadonlySet<number> = new Set()): Map<string, Usage> {
  const byId = new Map<number, UsageRow>();
  for (const r of rows) {
    if (!r || typeof r.product_id !== "string" || !Number.isFinite(Number(r.intake_id))) continue;
    byId.set(Number(r.intake_id), r);
  }
  const out = new Map<string, Usage>();
  byId.forEach((r, id) => {
    if (skip.has(id) || fromStack(r)) return;
    const when = `${r.intake_date ?? ""}|${r.intake_time ?? ""}`;
    const u = out.get(r.product_id);
    if (!u) out.set(r.product_id, { count: 1, last: when });
    else {
      u.count += 1;
      if (when > u.last) u.last = when;
    }
  });
  return out;
}

/** Most doses first, then the most recent, then the name (products never logged singly: by name). */
export function orderOptions<P extends OptionProduct>(products: readonly P[], usage: ReadonlyMap<string, Usage>): P[] {
  return [...products].sort((a, b) => {
    const ua = usage.get(a.product_id);
    const ub = usage.get(b.product_id);
    const byCount = (ub?.count ?? 0) - (ua?.count ?? 0);
    if (byCount) return byCount;
    const la = ua?.last ?? "";
    const lb = ub?.last ?? "";
    if (la !== lb) return la < lb ? 1 : -1;
    return labelOf(a).localeCompare(labelOf(b)) || a.product_id.localeCompare(b.product_id);
  });
}

/**
 * The order fixed once it is settled (the section keeps it while mounted): a history or today answer that lands
 * later, or a dose just logged, never moves an option under the finger. Products no longer listed drop out, new
 * ones go last.
 */
export function keepOrder<P extends OptionProduct>(ordered: readonly P[], frozen: readonly string[] | null): P[] {
  if (!frozen) return [...ordered];
  const byId = new Map(ordered.map((p) => [p.product_id, p]));
  const out: P[] = [];
  const seen = new Set<string>();
  for (const id of frozen) {
    const p = byId.get(id);
    if (p && !seen.has(id)) {
      out.push(p);
      seen.add(id);
    }
  }
  for (const p of ordered) if (!seen.has(p.product_id)) out.push(p);
  return out;
}

/**
 * The options matching the filter: brand + name contain every word. An exact name match comes first, the rest keep
 * the given (most used) order. An empty filter keeps every option.
 */
export function filterOptions<P extends OptionProduct>(ordered: readonly P[], query: string): P[] {
  const tokens = normName(query).split(" ").filter(Boolean);
  if (tokens.length === 0) return [...ordered];
  const q = normName(query);
  const matches = ordered.filter((p) => {
    const name = normName(`${p.brand_name ?? ""} ${p.full_name ?? ""}`);
    return tokens.every((t) => name.includes(t));
  });
  const exact = matches.filter((p) => normName(p.full_name) === q);
  return exact.length ? [...exact, ...matches.filter((p) => normName(p.full_name) !== q)] : matches;
}

/**
 * What is on screen: the first `cap` (all with `showAll`), plus every selected option that is further down (so it can
 * be unticked in place). `selected` = one id or several; an id that is not in `list` (filtered out) is not added: the
 * selection area lists those on their own.
 */
export function visibleOptions<P extends OptionProduct>(
  list: readonly P[],
  showAll: boolean,
  selected: string | readonly string[] | null,
  cap = OPTIONS_CAP,
): { shown: P[]; more: number } {
  const shown = showAll ? [...list] : list.slice(0, cap);
  const want = new Set(selected == null ? [] : typeof selected === "string" ? [selected] : selected);
  if (want.size > 0) {
    const have = new Set(shown.map((p) => p.product_id));
    for (const p of list) if (want.has(p.product_id) && !have.has(p.product_id)) shown.push(p);
  }
  return { shown, more: list.length - shown.length };
}

/** Each option's text: the product name, with the brand added when two products share the name. */
export function optionLabels(products: readonly OptionProduct[]): Map<string, string> {
  const seen = new Map<string, number>();
  for (const p of products) seen.set(normName(labelOf(p)), (seen.get(normName(labelOf(p))) ?? 0) + 1);
  const out = new Map<string, string>();
  for (const p of products) {
    const label = labelOf(p);
    const brand = p.brand_name?.trim();
    const twin = (seen.get(normName(label)) ?? 0) > 1;
    out.set(p.product_id, twin && brand && normName(brand) !== normName(label) ? `${label} · ${brand}` : label);
  }
  return out;
}
