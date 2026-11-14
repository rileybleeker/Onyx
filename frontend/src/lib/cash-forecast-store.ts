/**
 * Validation and row mapping for the cash forecast inputs (pds.finance_plan_items, pds.finance_plan_drivers).
 * PURE: no I/O. Used by /api/finance/forecast/* and the server loader. Design: docs/cash-flow-forecast.md.
 */
import type { CardTerms, Certainty, ForecastSettings, GrowthDriver, PlannedItem } from "./cash-forecast";
import { parseScenarioParams } from "./cash-forecast-scenario";
import { parseTaxProfile } from "./tax-plan";

export const MAX_FORECAST_BODY_BYTES = 2048;
const CERTAINTIES: readonly Certainty[] = ["confirmed", "likely", "possible"];
const UNITS = ["month", "week", "day"] as const;
const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

type HeaderGetter = { get(name: string): string | null };
/** Same-origin JSON with a size cap (the owner session itself is enforced by the middleware). */
export function checkJsonRequest(headers: HeaderGetter, requestOrigin: string, maxBytes = MAX_FORECAST_BODY_BYTES): { status: number; error: string } | null {
  const origin = headers.get("origin");
  if (!origin) return { status: 403, error: "missing Origin" };
  let o: URL;
  let r: URL;
  try {
    o = new URL(origin);
    r = new URL(requestOrigin);
  } catch {
    return { status: 403, error: "bad Origin" };
  }
  const hosts = [headers.get("x-forwarded-host"), headers.get("host"), r.host].filter(Boolean);
  if (!hosts.includes(o.host)) return { status: 403, error: "cross-origin request refused" };
  const type = (headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return { status: 415, error: "Content-Type must be application/json" };
  const len = headers.get("content-length");
  if (len != null && (!/^[0-9]+$/.test(len) || Number(len) > maxBytes)) return { status: 413, error: "body too large" };
  return null;
}

export interface ItemInput {
  label: string;
  item_date: string;
  amount_cents: number;
  certainty: Certainty;
  repeat_unit: (typeof UNITS)[number] | null;
  repeat_every: number | null;
  repeat_count: number | null;
  note: string | null;
}
const ITEM_KEYS = new Set(["label", "date", "amountCents", "certainty", "repeatUnit", "repeatEvery", "repeatCount", "note"]);

/** Body {label, date, amountCents (money in +, out -), certainty?, repeatUnit?, repeatEvery?, repeatCount?, note?}. */
export function parseItemBody(body: unknown): { ok: true; item: ItemInput } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be an object" };
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (!ITEM_KEYS.has(k)) return { ok: false, error: `unknown field ${k}` };
  const label = typeof b.label === "string" ? b.label.trim() : "";
  if (!label || label.length > 120) return { ok: false, error: "label must be 1 to 120 characters" };
  if (!isDay(b.date)) return { ok: false, error: "date must be YYYY-MM-DD" };
  if (!isNum(b.amountCents) || !Number.isInteger(b.amountCents) || b.amountCents === 0 || Math.abs(b.amountCents) > 100_000_000_000) {
    return { ok: false, error: "amountCents must be a non-zero whole number of cents" };
  }
  const certainty = b.certainty === undefined ? "likely" : b.certainty;
  if (!CERTAINTIES.includes(certainty as Certainty)) return { ok: false, error: "certainty must be confirmed, likely or possible" };
  let unit: ItemInput["repeat_unit"] = null;
  let every: number | null = null;
  let count: number | null = null;
  if (b.repeatUnit !== undefined && b.repeatUnit !== null) {
    if (!UNITS.includes(b.repeatUnit as (typeof UNITS)[number])) return { ok: false, error: "repeatUnit must be month, week or day" };
    unit = b.repeatUnit as ItemInput["repeat_unit"];
    every = b.repeatEvery === undefined ? 1 : (b.repeatEvery as number);
    count = b.repeatCount as number;
    if (!Number.isInteger(every) || every < 1 || every > 52) return { ok: false, error: "repeatEvery must be 1 to 52" };
    if (!Number.isInteger(count) || count < 1 || count > 120) return { ok: false, error: "repeatCount must be 1 to 120" };
  }
  const note = typeof b.note === "string" && b.note.trim() ? b.note.trim().slice(0, 300) : null;
  return { ok: true, item: { label, item_date: b.date, amount_cents: b.amountCents, certainty: certainty as Certainty, repeat_unit: unit, repeat_every: every, repeat_count: count, note } };
}

export const isUuid = (s: unknown): s is string => typeof s === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export interface ItemRow extends ItemInput {
  id: string;
}
export function itemRowToPlanned(r: ItemRow): PlannedItem {
  return {
    id: r.id,
    label: r.label,
    date: r.item_date,
    amountCents: Number(r.amount_cents),
    certainty: r.certainty,
    repeat: r.repeat_unit && r.repeat_count ? { unit: r.repeat_unit, every: r.repeat_every ?? 1, count: r.repeat_count } : undefined,
  };
}

/** Body {key, value}: key 'settings' | 'card:<account_key>' | 'growth:<account_key>'; value null removes the driver. */
export function parseDriverBody(
  body: unknown,
  knownAccounts: ReadonlySet<string>,
): { ok: true; key: string; value: Record<string, unknown> | null } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be an object" };
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) if (k !== "key" && k !== "value") return { ok: false, error: `unknown field ${k}` };
  const key = typeof b.key === "string" ? b.key : "";
  if (key === "tax") {
    if (b.value === null) return { ok: true, key, value: null };
    const profile = parseTaxProfile(b.value);
    return profile ? { ok: true, key, value: profile as unknown as Record<string, unknown> } : { ok: false, error: "tax profile needs salaryAnnualCents and employmentStart" };
  }
  const sm = /^scenario:([a-z0-9-]{1,40})$/.exec(key);
  if (sm) {
    if (b.value === null) return { ok: true, key, value: null };
    const v = b.value as Record<string, unknown> | undefined;
    const name = typeof v?.name === "string" ? v.name.trim().slice(0, 60) : "";
    if (!name || !v?.params || typeof v.params !== "object") return { ok: false, error: "scenario needs a name and params" };
    const raw = v.params as Record<string, unknown>;
    const params = parseScenarioParams((k) => (raw[k] === undefined || raw[k] === null ? null : String(raw[k])));
    return { ok: true, key, value: { name, params } };
  }
  const m = /^(settings|card|growth)(?::(.+))?$/.exec(key);
  if (!m || (m[1] === "settings") !== !m[2]) return { ok: false, error: "key must be settings, tax, scenario:<name>, card:<account> or growth:<account>" };
  if (m[2] && !knownAccounts.has(m[2])) return { ok: false, error: "unknown account" };
  if (b.value === null) return { ok: true, key, value: null };
  if (!b.value || typeof b.value !== "object" || Array.isArray(b.value)) return { ok: false, error: "value must be an object or null" };
  const v = b.value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const pct = (name: string, max: number) => {
    if (v[name] === undefined || v[name] === null || v[name] === "") return null;
    if (!isNum(v[name]) || (v[name] as number) < 0 || (v[name] as number) > max) return `${name} must be 0 to ${max}`;
    out[name] = Math.round((v[name] as number) * 100) / 100;
    return null;
  };
  const cents = (name: string) => {
    if (v[name] === undefined || v[name] === null || v[name] === "") return null;
    if (!isNum(v[name]) || !Number.isInteger(v[name]) || (v[name] as number) < 0 || (v[name] as number) > 100_000_000_000) return `${name} must be whole cents, 0 or more`;
    out[name] = v[name];
    return null;
  };
  const day = (name: string) => {
    if (v[name] === undefined || v[name] === null || v[name] === "") return null;
    if (!isDay(v[name])) return `${name} must be YYYY-MM-DD`;
    out[name] = v[name];
    return null;
  };
  const allowed: Record<string, string[]> = {
    settings: ["bufferCents", "inflationPct"],
    card: ["aprPct", "promoEnds", "promoAprPct", "standardAprPct", "promoNote"],
    growth: ["returnPct", "monthlyContributionCents", "contributionStarts"],
  };
  for (const k of Object.keys(v)) if (!allowed[m[1]].includes(k)) return { ok: false, error: `unknown value field ${k}` };
  const errs =
    m[1] === "settings"
      ? [cents("bufferCents"), pct("inflationPct", 20)]
      : m[1] === "card"
        ? [pct("aprPct", 60), day("promoEnds"), pct("promoAprPct", 60), pct("standardAprPct", 60)]
        : [pct("returnPct", 30), cents("monthlyContributionCents"), day("contributionStarts")];
  const err = errs.find(Boolean);
  if (err) return { ok: false, error: err };
  if (m[1] === "card" && typeof v.promoNote === "string" && v.promoNote.trim()) out.promoNote = v.promoNote.trim().slice(0, 200);
  return { ok: true, key, value: out };
}

export interface DriverRow {
  key: string;
  value: Record<string, unknown>;
}
/** Drivers -> the engine's settings, card terms and growth inputs (unknown or malformed entries are skipped). */
export function driversToInputs(rows: readonly DriverRow[]): { settings: ForecastSettings; cardTerms: CardTerms[]; growth: GrowthDriver[] } {
  const settings: ForecastSettings = {};
  const cardTerms: CardTerms[] = [];
  const growth: GrowthDriver[] = [];
  const n = (v: unknown) => (isNum(v) ? v : undefined);
  for (const r of rows) {
    const v = r.value ?? {};
    if (r.key === "settings") {
      settings.bufferCents = n(v.bufferCents);
      settings.inflationPct = n(v.inflationPct);
    } else if (r.key.startsWith("card:")) {
      cardTerms.push({
        account_key: r.key.slice(5),
        aprPct: n(v.aprPct),
        promoEnds: isDay(v.promoEnds) ? v.promoEnds : undefined,
        promoAprPct: n(v.promoAprPct),
        standardAprPct: n(v.standardAprPct),
        promoNote: typeof v.promoNote === "string" ? v.promoNote : undefined,
      });
    } else if (r.key.startsWith("growth:")) {
      growth.push({
        account_key: r.key.slice(7),
        returnPct: n(v.returnPct),
        monthlyContributionCents: n(v.monthlyContributionCents),
        contributionStarts: isDay(v.contributionStarts) ? v.contributionStarts : undefined,
      });
    }
  }
  return { settings, cardTerms, growth };
}
