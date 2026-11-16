// Direct drink capture (PROD-CAFF-01 slice): one said or tapped drink -> ONE row in pds.photo_meals with
// capture_kind = 'drink' (sql/direct_drink_capture.sql) -> Nutrition (pds.direct_drink_daily) and Caffeine
// (pds.caffeine_events, source 'dietary', event key direct_capture:<meal_id>). Never a supplement intake as well.
//
// This file holds the pure rules shared by the save route, the Log Drinks section, getNutrition and the tests:
//   - request bodies (create / edit / remove), refused rather than clamped;
//   - quantities (containers in quarter steps) and totals from the product's frozen label snapshot;
//   - time: a true "now" keeps the captured UTC instant and its IANA zone; a typed clock time is converted in the
//     chosen zone with DST gaps refused and repeated hours resolved only by an explicit earlier / later choice;
//     an unknown historical time is never saved (the section asks for it);
//   - replay identity: the same client_key + the same normalized capture is the same event; anything else is a
//     conflict (shown, never auto-overwritten) or a revision-checked edit;
//   - the Nutrition merge: distinct direct drinks ADD to a Cronometer day and to an estimate day, and alone make a
//     "DRINKS" day; a drink marked "in the diary" (only for a Cronometer entry that counts in both channels)
//     counts nowhere (same rule as the SQL projections);
//   - the editor item's readiness (itemSave). The session store with its pending-operation recovery is
//     lib/drink-session.ts.
// No network, no React, no Node built-ins (WebCrypto only for item keys).

import { shiftYmd } from "./delivery-portion";
import { drinkProduct, type DrinkLabel, type DrinkProduct } from "./drink-products";

export const DRINKS_URL = "/api/nutrition/drinks";
export const MAX_DRINK_BODY_BYTES = 4096;
/** A capture may be retried (offline, lost answer) up to this long after the moment it describes. */
export const NOW_MAX_AGE_MS = 48 * 3_600_000;
/** Same slack as the photo trigger: a clock a few minutes fast is not "the future". */
export const FUTURE_SLACK_MS = 5 * 60_000;
/** A typed day may be today or up to this many behavioral days before (the voice route's window). */
export const DRINK_DAYS_BACK = 6;
export const MAX_SERVINGS = 6;
/** Same-product drink within this window of a new one: ask "that one or another?" before saving. */
export const RECENT_SAME_MS = 3 * 3_600_000;

export type Overlap = "none" | "in_diary";
export const DRINK_SOURCE = "direct_drink";

export type DrinkTime =
  | { mode: "now"; /** ISO instant captured at the tap. */ at: string; zone: string }
  | { mode: "manual"; /** Behavioral day. */ day: string; /** Local wall clock "HH:MM". */ time: string; zone: string; fold: "earlier" | "later" | null };

export interface DrinkSave {
  client_key: string;
  product_id: string;
  /** Containers (cans): 0.25 steps, 0.25 to MAX_SERVINGS. */
  servings: number;
  time: DrinkTime;
  overlap: Overlap;
}

export interface DrinkEdit extends DrinkSave {
  expected_revision: number;
}

/** One stored drink as the route answers it. */
export interface DrinkRecord {
  meal_id: number;
  client_key: string;
  product_id: string;
  product_version: number;
  name: string;
  servings: number;
  eaten_date: string;
  eaten_time: string;
  eaten_at: string;
  time_zone: string;
  time_source: "now" | "manual";
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  sugar_g: number | null;
  sodium_mg: number | null;
  caffeine_mg: number;
  overlap: Overlap;
  revision: number;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);

export function isYmd(s: unknown): s is string {
  if (typeof s !== "string" || !YMD.test(s)) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
export const isHhmm = (s: unknown): s is string => typeof s === "string" && HHMM.test(s);
export const isUuid = (s: unknown): s is string => typeof s === "string" && UUID.test(s);

/** 0.25 steps from 0.25 to MAX_SERVINGS (a quarter, half, one, two cans…). */
export function isServings(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0.25 && v <= MAX_SERVINGS && Math.abs(v * 4 - Math.round(v * 4)) < 1e-9;
}

/** Amount + unit as said -> containers, or null when not said / not a clean quarter step. */
export function servingsFrom(amount: number | null, unit: string | null, product: DrinkProduct | null): number | null {
  if (amount == null || !Number.isFinite(amount) || amount <= 0) return null;
  let cans: number | null = null;
  if (unit === "can") cans = amount;
  else if (unit === "fl_oz" && product) cans = amount / product.label.serving_fl_oz;
  if (cans == null) return null;
  const q = Math.round(cans * 4) / 4;
  return Math.abs(q - cans) <= 0.02 && isServings(q) ? q : null;
}

// ---- time ----------------------------------------------------------------------------------------------------

export function isValidZone(z: unknown): z is string {
  if (typeof z !== "string" || z.length < 3 || z.length > 64 || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(z)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: z });
    return true;
  } catch {
    return false;
  }
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function wall(ms: number, zone: string): { date: string; time: string; wallMs: number } {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
    formatters.set(zone, f);
  }
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(new Date(ms))) p[part.type] = part.value;
  const hour = p.hour === "24" ? "00" : p.hour;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${hour}:${p.minute}`,
    wallMs: Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(hour), Number(p.minute), Number(p.second)),
  };
}

/** Local calendar date and "HH:MM" of an instant in a zone. */
export function localClockAt(ms: number, zone: string): { date: string; time: string } {
  const w = wall(ms, zone);
  return { date: w.date, time: w.time };
}

/** Behavioral day of an instant: the local clock minus 6 h (before 06:00 closes the day before). */
export function behavioralDayAt(ms: number, zone: string): string {
  const { date, time } = localClockAt(ms, zone);
  return time < "06:00" ? shiftYmd(date, -1) : date;
}

/** The calendar date a behavioral day + clock time falls on (01:30 on day D = calendar D + 1). */
export function clockDateOf(day: string, time: string): string {
  return time < "06:00" ? shiftYmd(day, 1) : day;
}

/**
 * Every instant at which the zone's wall clock reads `date time`: [] in a DST gap (the clock skipped it), two in a
 * repeated hour (clocks went back), else one. Ascending.
 */
export function instantsForWallClock(date: string, time: string, zone: string): number[] {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const target = Date.UTC(y, m - 1, d, hh, mm);
  const offsets = new Set<number>();
  for (const probe of [target - 86_400_000, target, target + 86_400_000]) offsets.add(wall(probe, zone).wallMs - Math.floor(probe / 1000) * 1000);
  const out = new Set<number>();
  for (const o of Array.from(offsets)) {
    const t = target - o;
    if (wall(t, zone).wallMs === target) out.add(t);
  }
  return Array.from(out).sort((a, b) => a - b);
}

export type TimeProblem = "nonexistent" | "ambiguous" | "future" | "too_old" | "bad_zone" | "bad_time";

export type ResolvedTime =
  | { ok: true; eaten_at: string; eaten_ms: number; eaten_date: string; eaten_time: string; time_source: "now" | "manual"; time_zone: string }
  | { ok: false; problem: TimeProblem; error: string; choices?: string[] };

export const TIME_PROBLEM_TEXT: Record<TimeProblem, string> = {
  nonexistent: "That clock time did not exist that day (the clocks went forward). Pick another time.",
  ambiguous: "That clock time happened twice (the clocks went back). Pick earlier or later.",
  future: "That time has not happened yet.",
  too_old: "That day is too far back for a drink here.",
  bad_zone: "Unknown time zone.",
  bad_time: "Set the time.",
};

const fail = (problem: TimeProblem, choices?: string[]): ResolvedTime => ({ ok: false, problem, error: TIME_PROBLEM_TEXT[problem], ...(choices ? { choices } : {}) });

/**
 * A full ISO instant with an explicit zone designator: "2026-11-15T19:05:30Z", "...30.123Z", "...30-05:00". A
 * date-only or zone-less string ("2026-11-15", "2026-11-15T14:05") is refused: the host's zone would decide it.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d(\.\d{1,6})?)?(Z|[+-]([01]\d|2[0-3]):[0-5]\d)$/;
export function isIsoInstant(s: unknown): s is string {
  return typeof s === "string" && s.length <= 40 && ISO_INSTANT.test(s) && isYmd(s.slice(0, 10)) && Number.isFinite(Date.parse(s));
}

/**
 * A capture's time -> the instant, behavioral day and local clock to store. `today` = behavioral today (server:
 * pds.behavioral_today_now()); `nowMs` = the server's clock. Never invents a time: an unresolved manual time is a
 * problem, never noon or now.
 *
 * `bounds: false` resolves the instant only (zone, ISO syntax, DST gap / repeated hour still apply) without the
 * new-capture window (future, 48 h, 6 days): used to compare a retried request with a drink ALREADY stored under
 * its key, so a replay days later still answers the stored drink (or its removal) instead of "too old".
 */
export function resolveDrinkTime(t: DrinkTime, nowMs: number, today: string, { bounds = true }: { bounds?: boolean } = {}): ResolvedTime {
  if (!isValidZone(t.zone)) return fail("bad_zone");
  const earliest = shiftYmd(today, -DRINK_DAYS_BACK);
  if (t.mode === "now") {
    if (!isIsoInstant(t.at)) return fail("bad_time");
    const ms = Date.parse(t.at);
    if (bounds && ms > nowMs + FUTURE_SLACK_MS) return fail("future");
    if (bounds && ms < nowMs - NOW_MAX_AGE_MS) return fail("too_old");
    const day = behavioralDayAt(ms, t.zone);
    // The device zone may put the instant a day either side of the server's behavioral today on a travel day.
    if (bounds && (day < earliest || day > shiftYmd(today, 1))) return fail("too_old");
    return { ok: true, eaten_at: new Date(ms).toISOString(), eaten_ms: ms, eaten_date: day, eaten_time: localClockAt(ms, t.zone).time, time_source: "now", time_zone: t.zone };
  }
  if (!isYmd(t.day) || !isHhmm(t.time)) return fail("bad_time");
  if (bounds && t.day > today) return fail("future");
  if (bounds && t.day < earliest) return fail("too_old");
  const instants = instantsForWallClock(clockDateOf(t.day, t.time), t.time, t.zone);
  if (instants.length === 0) return fail("nonexistent");
  let ms = instants[0];
  if (instants.length > 1) {
    if (t.fold == null) return fail("ambiguous", instants.map((i) => new Date(i).toISOString()));
    ms = t.fold === "later" ? instants[instants.length - 1] : instants[0];
  }
  if (bounds && ms > nowMs + FUTURE_SLACK_MS) return fail("future");
  return { ok: true, eaten_at: new Date(ms).toISOString(), eaten_ms: ms, eaten_date: t.day, eaten_time: t.time, time_source: "manual", time_zone: t.zone };
}

/**
 * Behavioral today without the database: the Eastern WALL clock, then the 06:00 rule (never "now minus 6 elapsed
 * hours", which is off by an hour across a DST change).
 */
export function fallbackBehavioralToday(nowMs: number): string {
  return behavioralDayAt(nowMs, "America/New_York");
}

// ---- request bodies ------------------------------------------------------------------------------------------

function parseTime(v: unknown): Parsed<DrinkTime> {
  const t = obj(v);
  if (!t) return { ok: false, error: "time must be an object" };
  if (t.mode === "now") {
    if (Object.keys(t).sort().join(",") !== "at,mode,zone") return { ok: false, error: "time must be exactly {mode, at, zone}" };
    if (!isIsoInstant(t.at)) return { ok: false, error: "time.at must be an ISO instant with Z or an offset" };
    if (!isValidZone(t.zone)) return { ok: false, error: "time.zone must be an IANA time zone" };
    return { ok: true, value: { mode: "now", at: t.at, zone: t.zone } };
  }
  if (t.mode === "manual") {
    const keys = Object.keys(t).sort().join(",");
    if (keys !== "day,fold,mode,time,zone") return { ok: false, error: "time must be exactly {mode, day, time, zone, fold}" };
    if (!isYmd(t.day)) return { ok: false, error: "time.day must be YYYY-MM-DD" };
    if (!isHhmm(t.time)) return { ok: false, error: "time.time must be HH:MM" };
    if (!isValidZone(t.zone)) return { ok: false, error: "time.zone must be an IANA time zone" };
    if (t.fold !== null && t.fold !== "earlier" && t.fold !== "later") return { ok: false, error: "time.fold must be earlier, later or null" };
    return { ok: true, value: { mode: "manual", day: t.day, time: t.time, zone: t.zone, fold: t.fold as "earlier" | "later" | null } };
  }
  return { ok: false, error: "time.mode must be now or manual" };
}

/**
 * The body's shape only. Whether product_id is in the CURRENT catalogue is checked by the route for a new drink or
 * a product change, after a stored drink under the key was compared: a retry of a drink captured before a
 * catalogue change still answers that drink.
 */
function parseCapture(b: Record<string, unknown>): Parsed<DrinkSave> {
  if (!isUuid(b.client_key)) return { ok: false, error: "client_key must be a UUID" };
  if (typeof b.product_id !== "string" || !PRODUCT_ID.test(b.product_id)) return { ok: false, error: "product_id must be a drink id" };
  if (!isServings(b.servings)) return { ok: false, error: `servings must be 0.25 to ${MAX_SERVINGS} in quarter steps` };
  if (b.overlap !== "none" && b.overlap !== "in_diary") return { ok: false, error: "overlap must be none or in_diary" };
  const time = parseTime(b.time);
  if (!time.ok) return time;
  return {
    ok: true,
    value: { client_key: (b.client_key as string).toLowerCase(), product_id: b.product_id as string, servings: b.servings as number, time: time.value, overlap: b.overlap as Overlap },
  };
}

const PRODUCT_ID = /^[a-z0-9-]{3,80}$/;
const CREATE_KEYS = "client_key,overlap,product_id,servings,time";
const EDIT_KEYS = "client_key,expected_revision,overlap,product_id,servings,time";

/** POST: exactly {client_key, product_id, servings, time, overlap}. */
export function parseDrinkCreate(body: unknown): Parsed<DrinkSave> {
  const b = obj(body);
  if (!b) return { ok: false, error: "body must be a JSON object" };
  if (Object.keys(b).sort().join(",") !== CREATE_KEYS) return { ok: false, error: `body must be exactly {${CREATE_KEYS}}` };
  return parseCapture(b);
}

const isRevision = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 1;

/** PATCH: the whole capture again plus expected_revision (the revision the browser last saw). */
export function parseDrinkEdit(body: unknown): Parsed<DrinkEdit> {
  const b = obj(body);
  if (!b) return { ok: false, error: "body must be a JSON object" };
  if (Object.keys(b).sort().join(",") !== EDIT_KEYS) return { ok: false, error: `body must be exactly {${EDIT_KEYS}}` };
  if (!isRevision(b.expected_revision)) return { ok: false, error: "expected_revision must be a positive integer" };
  const c = parseCapture(b);
  if (!c.ok) return c;
  return { ok: true, value: { ...c.value, expected_revision: b.expected_revision } };
}

/** DELETE (Undo / Remove): exactly {client_key, expected_revision}. The row stays as a tombstone. */
export function parseDrinkRemove(body: unknown): Parsed<{ client_key: string; expected_revision: number }> {
  const b = obj(body);
  if (!b) return { ok: false, error: "body must be a JSON object" };
  if (Object.keys(b).sort().join(",") !== "client_key,expected_revision") return { ok: false, error: "body must be exactly {client_key, expected_revision}" };
  if (!isUuid(b.client_key)) return { ok: false, error: "client_key must be a UUID" };
  if (!isRevision(b.expected_revision)) return { ok: false, error: "expected_revision must be a positive integer" };
  return { ok: true, value: { client_key: b.client_key.toLowerCase(), expected_revision: b.expected_revision } };
}

// ---- totals and the stored row -------------------------------------------------------------------------------

const r1 = (x: number) => Math.round(x * 10) / 10;

export interface LabelSnapshot {
  product_id: string;
  version: number;
  name: string;
  label: DrinkLabel;
  source: DrinkProduct["source"];
}

export function snapshotOf(p: DrinkProduct): LabelSnapshot {
  return { product_id: p.id, version: p.version, name: p.name, label: { ...p.label }, source: { ...p.source } };
}

/** A stored snapshot read back from jsonb, or null when it is not one (never guessed). */
export function asSnapshot(raw: unknown): LabelSnapshot | null {
  const s = obj(raw);
  const label = obj(s?.label);
  if (!s || !label || typeof s.product_id !== "string" || typeof s.name !== "string" || typeof s.version !== "number") return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
  const l: DrinkLabel = {
    serving: typeof label.serving === "string" ? label.serving : "",
    serving_fl_oz: n(label.serving_fl_oz) ?? 0,
    kcal: n(label.kcal), protein_g: n(label.protein_g), carbs_g: n(label.carbs_g), fat_g: n(label.fat_g),
    sugar_g: n(label.sugar_g), sodium_mg: n(label.sodium_mg), caffeine_mg: n(label.caffeine_mg),
  };
  if (l.kcal == null || l.protein_g == null || l.carbs_g == null || l.fat_g == null || l.caffeine_mg == null) return null;
  return { product_id: s.product_id, version: s.version, name: s.name, label: l, source: (s.source as LabelSnapshot["source"]) ?? { page: "", label_image: "", read_on: "" } };
}

export interface DrinkTotals {
  kcal: number;
  protein_g: number;
  carbs_g: number;
  fat_g: number;
  sugar_g: number | null;
  sodium_mg: number | null;
  caffeine_mg: number;
}

/** Label x servings. Required values must be known (a snapshot without them is refused earlier). */
export function drinkTotals(label: DrinkLabel, servings: number): DrinkTotals {
  const x = (v: number | null) => (v == null ? null : r1(v * servings));
  return {
    kcal: r1((label.kcal ?? 0) * servings),
    protein_g: r1((label.protein_g ?? 0) * servings),
    carbs_g: r1((label.carbs_g ?? 0) * servings),
    fat_g: r1((label.fat_g ?? 0) * servings),
    sugar_g: x(label.sugar_g),
    sodium_mg: x(label.sodium_mg),
    caffeine_mg: r1((label.caffeine_mg ?? 0) * servings),
  };
}

export function servingsText(servings: number, container = "can"): string {
  const FRACTIONS: Record<number, string> = { 0: "", 0.25: "¼", 0.5: "½", 0.75: "¾" };
  const whole = Math.floor(servings + 1e-9);
  const frac = FRACTIONS[Math.round((servings - whole) * 4) / 4] ?? "";
  const n = `${whole > 0 ? whole : ""}${frac}` || "0";
  return `${n} ${container}${servings > 1 ? "s" : ""}`;
}

/** The pds.photo_meals columns of a drink capture (the route adds client_key, revision and the kind). */
export function drinkRowValues(snapshot: LabelSnapshot, servings: number, t: Extract<ResolvedTime, { ok: true }>, overlap: Overlap) {
  const tot = drinkTotals(snapshot.label, servings);
  return {
    eaten_date: t.eaten_date,
    eaten_time: t.eaten_time,
    eaten_at: t.eaten_at,
    time_source: t.time_source,
    time_zone: t.time_zone,
    // Same item shape as a photo meal, so the shared table's checks and any item reader keep working.
    items: [{ name: snapshot.name, portion: servingsText(servings), kcal: tot.kcal, protein_g: tot.protein_g, carbs_g: tot.carbs_g, fat_g: tot.fat_g }],
    kcal: tot.kcal,
    protein_g: tot.protein_g,
    carbs_g: tot.carbs_g,
    fat_g: tot.fat_g,
    sugar_g: tot.sugar_g,
    sodium_mg: tot.sodium_mg,
    caffeine_mg: tot.caffeine_mg,
    drink_product_id: snapshot.product_id,
    drink_product_version: snapshot.version,
    drink_servings: servings,
    drink_label: snapshot,
    diary_overlap: overlap,
  };
}

/** Columns the drinks route reads back. */
export const DRINK_COLUMNS =
  "meal_id, client_key, capture_kind, deleted_at, revision, eaten_date, eaten_time, eaten_at, time_zone, time_source, kcal, protein_g, carbs_g, fat_g, sugar_g, sodium_mg, caffeine_mg, drink_product_id, drink_product_version, drink_servings, drink_label, diary_overlap";

/** A stored row -> the record the browser sees. */
export function toDrinkRecord(r: Record<string, unknown>): DrinkRecord {
  const snap = asSnapshot(r.drink_label);
  const num = (v: unknown) => Number(v);
  const opt = (v: unknown) => (v == null ? null : Number(v));
  return {
    meal_id: num(r.meal_id),
    client_key: String(r.client_key),
    product_id: String(r.drink_product_id),
    product_version: num(r.drink_product_version),
    name: snap?.name ?? String(r.drink_product_id),
    servings: num(r.drink_servings),
    eaten_date: String(r.eaten_date),
    eaten_time: String(r.eaten_time).slice(0, 5),
    eaten_at: String(r.eaten_at),
    time_zone: String(r.time_zone),
    time_source: r.time_source === "manual" ? "manual" : "now",
    kcal: num(r.kcal),
    protein_g: num(r.protein_g),
    carbs_g: num(r.carbs_g),
    fat_g: num(r.fat_g),
    sugar_g: opt(r.sugar_g),
    sodium_mg: opt(r.sodium_mg),
    caffeine_mg: num(r.caffeine_mg),
    overlap: r.diary_overlap === "in_diary" ? "in_diary" : "none",
    revision: num(r.revision),
  };
}

/**
 * Is this stored drink the same capture as the request (a retry, a double tap, a lost answer)? Same product,
 * amount, instant, zone, time kind and overlap state. Anything else is a different capture under the same key.
 */
export function sameCapture(rec: DrinkRecord, save: DrinkSave, t: Extract<ResolvedTime, { ok: true }>): boolean {
  return (
    rec.product_id === save.product_id &&
    Math.abs(rec.servings - save.servings) < 1e-9 &&
    Date.parse(rec.eaten_at) === t.eaten_ms &&
    rec.time_zone === t.time_zone &&
    rec.time_source === t.time_source &&
    rec.overlap === save.overlap
  );
}

// ---- overlap with what is already logged ---------------------------------------------------------------------

const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** A logged entry's name that likely IS this drink (same brand words). A prompt, never an automatic deletion. */
export function likelySameDrink(p: DrinkProduct, loggedName: string): boolean {
  const brand = compact(p.brand);
  return brand.length >= 4 && compact(loggedName).includes(brand);
}

export interface OverlapCandidate {
  source: "cronometer" | "supplement" | "delivery";
  name: string;
  /** Local "HH:MM" when known. */
  time: string | null;
  /** Cronometer: the serving's caffeine (null = none logged), which decides whether it counts in Caffeine. */
  caffeine_mg: number | null;
  /** Explicit proof of the nutrition rollup's attribution and known nutrient values. Missing is unverified. */
  counts_in_nutrition?: boolean;
}

export function cronometerNutritionCoverage(s: {
  onyx_behavioral_date: unknown; calories: unknown; protein_g: unknown; carbs_g: unknown;
  fat_g: unknown; sugars_g: unknown; sodium_mg: unknown;
}, day: string): boolean {
  // Unlike caffeine's COALESCE day, the nutrition rollup excludes rows without behavioral attribution.
  if (s.onyx_behavioral_date !== day) return false;
  return [s.calories, s.protein_g, s.carbs_g, s.fat_g, s.sugars_g, s.sodium_mg].every((v) =>
    (typeof v === "number" || (typeof v === "string" && v.trim() !== "")) && Number.isFinite(Number(v)) && Number(v) >= 0,
  );
}

/** Same-product drinks already saved near this one (another capture key): "that one, or another can?" */
export function recentSameProduct(rows: ReadonlyArray<DrinkRecord>, productId: string, key: string, atMs: number | null, day: string): DrinkRecord[] {
  return rows.filter((r) => {
    if (r.client_key === key || r.product_id !== productId) return false;
    if (atMs == null) return r.eaten_date === day;
    return Math.abs(Date.parse(r.eaten_at) - atMs) <= RECENT_SAME_MS;
  });
}

// ---- Nutrition: distinct drinks add on every kind of day -----------------------------------------------------

export interface DrinkDay {
  behavioral_date: string;
  drink_count: number | string;
  kcal: number | string | null;
  protein_g: number | string | null;
  carbs_g: number | string | null;
  fat_g: number | string | null;
  sugar_g: number | string | null;
  sodium_mg: number | string | null;
}

type Row = Record<string, unknown> & { calendar_date: string };

/**
 * getNutrition's last step. The Cronometer-or-estimate rows are final; a direct drink (pds.direct_drink_daily:
 * active, not marked as already in the diary) is a distinct item, so it ADDS to that day's row whatever its
 * source (it never goes through the fallback-only estimate merge, which a diary day suppresses). A day with only
 * drinks gets its own row tagged DRINK_SOURCE. Zero-kcal drinks still count (direct_drink_count). An unknown on
 * either side (the day's own protein, say, or a drink's sugar) keeps that day's total unknown (null): adding a
 * drink never turns an unknown diary value into a drink-only "known" total.
 */
export function addDirectDrinks(rows: ReadonlyArray<Row>, days: ReadonlyArray<DrinkDay>): Row[] {
  const out: Row[] = rows.map((r) => ({ ...r }));
  const byDate = new Map(out.map((r) => [r.calendar_date, r]));
  const n = (v: unknown) => (v == null || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null);
  for (const d of days) {
    const count = Number(d.drink_count) || 0;
    if (count <= 0) continue;
    const row = byDate.get(d.behavioral_date);
    if (!row) {
      const fresh: Row = {
        calendar_date: d.behavioral_date,
        nutrition_source: DRINK_SOURCE,
        calories: n(d.kcal) ?? 0,
        protein_g: n(d.protein_g) ?? 0,
        carbs_g: n(d.carbs_g) ?? 0,
        fat_g: n(d.fat_g) ?? 0,
        fiber_g: null,
        sugar_g: n(d.sugar_g),
        sodium_mg: n(d.sodium_mg),
        water_ml: null,
        direct_drink_count: count,
      };
      out.push(fresh);
      byDate.set(d.behavioral_date, fresh);
      continue;
    }
    const add = (k: string, v: number | null) => {
      const have = n(row[k]);
      row[k] = have == null || v == null ? null : r1(have + v);
    };
    add("calories", n(d.kcal));
    add("protein_g", n(d.protein_g));
    add("carbs_g", n(d.carbs_g));
    add("fat_g", n(d.fat_g));
    add("sugar_g", n(d.sugar_g));
    add("sodium_mg", n(d.sodium_mg));
    row.direct_drink_count = (Number(row.direct_drink_count) || 0) + count;
  }
  out.sort((a, b) => (a.calendar_date < b.calendar_date ? -1 : a.calendar_date > b.calendar_date ? 1 : 0));
  return out;
}

// ---- identity ------------------------------------------------------------------------------------------------

export function newUuid(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  const b = new Uint8Array(16);
  c!.getRandomValues(b);
  return uuidFromBytes(b, 4);
}

function uuidFromBytes(b: Uint8Array, version: number): string {
  b[6] = (b[6] & 0x0f) | (version << 4);
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b.slice(0, 16), (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/**
 * The stable key of one drink in one Say it capture: derived (SHA-256) from the capture id and the item's slot
 * (product or words + its occurrence), so a repeated Fill of the same words, a lost answer or a remounted section
 * gives the same key and the server answers with the same row. A new capture id gives new keys.
 */
export async function itemKey(captureId: string, slot: string): Promise<string> {
  const data = new TextEncoder().encode(`onyx-drink|${captureId}|${slot}`);
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", data));
  return uuidFromBytes(digest, 8);
}

/** Slots for a list of said drinks: "<product id or words>#<n-th occurrence>", stable under reordering. */
export function itemSlots(items: ReadonlyArray<{ product_id: string | null; said: string }>): string[] {
  const seen = new Map<string, number>();
  return items.map((i) => {
    const base = i.product_id ?? compact(i.said);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return `${base}#${n}`;
  });
}

// ---- telling mounted pages ------------------------------------------------------------------------------------

/** Fired on window after a drink was saved, edited or removed (Nutrition and Caffeine refetch, Log re-reads). */
export const DRINK_CHANGED_EVENT = "onyx:direct-drink-changed";

export function announceDrinkChange(): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new Event(DRINK_CHANGED_EVENT));
  } catch {
    /* never breaks a save */
  }
}

export function onDrinkChange(fn: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(DRINK_CHANGED_EVENT, fn);
  return () => window.removeEventListener(DRINK_CHANGED_EVENT, fn);
}

// ---- one drink in the editor (state kept by lib/drink-session.ts) ---------------------------------------------

/** A request whose answer has not been seen yet: kept (and persisted) BEFORE it is sent, cleared on an answer. */
export type PendingOp =
  | { op: "create"; body: DrinkSave }
  | { op: "edit"; body: DrinkEdit }
  | { op: "remove"; body: { client_key: string; expected_revision: number } };

/** What the editor holds for one drink item. */
export interface DrinkItemState {
  key: string;
  product_id: string | null;
  /** The short words the item came from: memory only, never persisted ("" after a reload). */
  said: string;
  issue: string | null;
  servings: number | null;
  /** "now" = the captured instant; "manual" = day + time typed or said. null time = not resolved yet. */
  timeMode: "now" | "manual";
  capturedAt: number;
  day: string | null;
  time: string | null;
  fold: "earlier" | "later" | null;
  zone: string;
  /**
   * A day or time was SAID but is not usable (malformed, impossible, future, too far back): the item never falls
   * back to today or Now; it waits until Riley picks the day / time himself (which clears this).
   */
  whenIssue: string | null;
  /** null = not asked yet / not needed; set by Riley's tap. */
  overlap: Overlap | null;
  /** "another" once Riley said a same-product drink nearby is a different one. */
  recent: "another" | null;
  status: "open" | "dismissed" | "removed";
  /** The capture the server acknowledged last (the autosave baseline after a remount or reload). */
  saved: DrinkSave | null;
  /**
   * Nothing is sent while set. "recover": restored after a reload, reading its key to see what the server holds.
   * "retry": restored and not found on the server (or the read failed): sent again only on Riley's explicit tap.
   * "conflict": the server holds a different version (shown); a new deliberate change or Undo is needed.
   */
  hold: "recover" | "retry" | "conflict" | null;
  /** A line for Riley about the last answer (conflict, removed elsewhere, recovered). */
  note: string | null;
  /** The request in flight or with an unknown outcome (see PendingOp). */
  pending: PendingOp | null;
}

/** What the editor says when a SAID day / time cannot be used (never replaced by today or Now). */
export const WHEN_ISSUE = {
  day: "The day said can't be used. Pick the day.",
  time: "The time said can't be used. Set the time.",
  both: "The day and time said can't be used. Pick both.",
} as const;

export function whenIssueOf(code: "bad_date" | "bad_time" | "bad_date_time" | null | undefined): string | null {
  return code === "bad_date" ? WHEN_ISSUE.day : code === "bad_time" ? WHEN_ISSUE.time : code === "bad_date_time" ? WHEN_ISSUE.both : null;
}

/** Riley set the day (or the time) himself: what is still unresolved. */
export function afterWhenEdit(issue: string | null, edited: "day" | "time"): string | null {
  if (issue === WHEN_ISSUE.both) return edited === "day" ? WHEN_ISSUE.time : WHEN_ISSUE.day;
  if (issue === WHEN_ISSUE.day) return edited === "day" ? null : issue;
  if (issue === WHEN_ISSUE.time) return edited === "time" ? null : issue;
  return issue;
}

/** Two save bodies describe the same capture (instants compared as instants, not strings). */
export function sameSave(a: DrinkSave | null | undefined, b: DrinkSave | null | undefined): boolean {
  if (!a || !b) return false;
  const t = (x: DrinkTime) =>
    x.mode === "now" ? `now|${Date.parse(x.at)}|${x.zone}` : `manual|${x.day}|${x.time}|${x.zone}|${x.fold ?? ""}`;
  return a.client_key === b.client_key && a.product_id === b.product_id && Math.abs(a.servings - b.servings) < 1e-9 && a.overlap === b.overlap && t(a.time) === t(b.time);
}

/** The editor fields of a stored drink (after a conflict or a recovery read: the server's version is shown). */
export function itemFieldsFromRecord(rec: DrinkRecord): Pick<DrinkItemState, "product_id" | "servings" | "timeMode" | "capturedAt" | "day" | "time" | "fold" | "zone" | "overlap" | "saved" | "whenIssue" | "issue"> {
  const save = saveFromRecord(rec);
  const now = save.time.mode === "now";
  return {
    product_id: rec.product_id,
    servings: rec.servings,
    timeMode: now ? "now" : "manual",
    capturedAt: Date.parse(rec.eaten_at),
    day: save.time.mode === "manual" ? save.time.day : null,
    time: save.time.mode === "manual" ? save.time.time : null,
    fold: save.time.mode === "manual" ? save.time.fold : null,
    zone: rec.time_zone,
    overlap: rec.overlap,
    saved: save,
    whenIssue: null,
    issue: null,
  };
}

/** A stored drink as a save body again (for edits of a listed drink: overlap toggle, amount). */
export function saveFromRecord(rec: DrinkRecord): DrinkSave {
  let time: DrinkTime;
  if (rec.time_source === "now") time = { mode: "now", at: rec.eaten_at, zone: rec.time_zone };
  else {
    const at = Date.parse(rec.eaten_at);
    const all = instantsForWallClock(clockDateOf(rec.eaten_date, rec.eaten_time), rec.eaten_time, rec.time_zone);
    const fold = all.length > 1 ? (all[all.length - 1] === at ? "later" : "earlier") : null;
    time = { mode: "manual", day: rec.eaten_date, time: rec.eaten_time, zone: rec.time_zone, fold };
  }
  return { client_key: rec.client_key, product_id: rec.product_id, servings: rec.servings, time, overlap: rec.overlap };
}

/** What the drinks GET says is already logged that day (null = not loaded yet). */
export interface DayCheck {
  candidates: OverlapCandidate[];
  /** Sources that could not be checked completely (failed or truncated): never read as "nothing there". */
  unchecked: string[];
  drinks: DrinkRecord[];
}

/** The device's IANA zone (falls back to New York, the project's home zone). */
export function deviceZone(): string {
  try {
    const z = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidZone(z) ? z : "America/New_York";
  } catch {
    return "America/New_York";
  }
}

/**
 * "Already counted there" is only offered (and only accepted by the route) when the logged entry counts in BOTH
 * channels a drink capture would: a Cronometer serving on that behavioral day counts in Nutrition (the diary day)
 * AND in Caffeine (when its caffeine_mg > 0). A supplement intake counts caffeine only and an Uber Eats dish
 * Nutrition only, so for those (or a Cronometer entry without caffeine) Onyx cannot exclude the drink truthfully
 * from both: Riley either counts this drink here or does not add it. Not a durable link to that serving (its id is
 * replaced on re-import): a later import of the same drink is not detected.
 */
export function dualChannelOverlaps(p: DrinkProduct, check: DayCheck): OverlapCandidate[] {
  return check.candidates.filter((o) => o.source === "cronometer" && o.counts_in_nutrition === true && (o.caffeine_mg ?? 0) > 0 && likelySameDrink(p, o.name));
}

/** The save body an item stands for, or why it cannot be saved yet (shown, nothing sent). */
export function itemSave(
  it: DrinkItemState,
  ctx: { today: string | null; nowMs: number; dayCheck: (day: string) => DayCheck | null; acknowledged: boolean; blocked?: string | null },
):
  | { ok: true; save: DrinkSave; resolved: Extract<ResolvedTime, { ok: true }> }
  | { ok: false; reason: string; problem?: TimeProblem; choices?: string[]; ask?: "overlap" | "recent"; day?: string } {
  const p = drinkProduct(it.product_id);
  if (!p) return { ok: false, reason: it.issue ?? "Pick the drink." };
  if (it.servings == null || !isServings(it.servings)) return { ok: false, reason: "How much? Pick an amount." };
  if (ctx.blocked) return { ok: false, reason: ctx.blocked };
  if (!ctx.today) return { ok: false, reason: "Loading today…" };
  // A day or time that was said but is not usable never becomes today or Now.
  if (it.whenIssue) return { ok: false, reason: it.whenIssue, problem: "bad_time" };
  let time: DrinkTime;
  if (it.timeMode === "now") time = { mode: "now", at: new Date(it.capturedAt).toISOString(), zone: it.zone };
  else {
    // A clock time said with NO day (absent, not invalid) is for the Say it day: today.
    const day = it.day ?? ctx.today;
    if (!it.time) return { ok: false, reason: "When? Set the time.", problem: "bad_time" };
    time = { mode: "manual", day, time: it.time, zone: it.zone, fold: it.fold };
  }
  const resolved = resolveDrinkTime(time, ctx.nowMs, ctx.today);
  if (!resolved.ok) return { ok: false, reason: resolved.error, problem: resolved.problem, choices: resolved.choices };
  const check = ctx.dayCheck(resolved.eaten_date);
  if (check == null) return { ok: false, reason: "Checking what is already logged…", day: resolved.eaten_date };
  if (!ctx.acknowledged) {
    const likely = check.candidates.some((o) => likelySameDrink(p, o.name));
    if (it.overlap == null && (likely || check.unchecked.length > 0)) {
      return { ok: false, reason: likely ? "Already logged elsewhere? Choose below." : "Couldn't check the other logs. Choose below.", ask: "overlap", day: resolved.eaten_date };
    }
    if (it.overlap === "in_diary" && dualChannelOverlaps(p, check).length === 0) {
      return { ok: false, reason: "Only a Cronometer entry with caffeine can count instead. Choose below.", ask: "overlap", day: resolved.eaten_date };
    }
    if (it.recent == null && recentSameProduct(check.drinks, p.id, it.key, resolved.eaten_ms, resolved.eaten_date).length > 0) {
      return { ok: false, reason: "Same drink logged earlier. Choose below.", ask: "recent", day: resolved.eaten_date };
    }
  }
  return {
    ok: true,
    resolved,
    save: { client_key: it.key, product_id: p.id, servings: it.servings, time, overlap: it.overlap ?? "none" },
  };
}
