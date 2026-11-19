/**
 * Rewards: points, miles and cash back across the programs Riley holds (REWARDS-01).
 *
 * PURE functions over plain rows: no I/O, no clock (callers pass `today` as an Eastern "YYYY-MM-DD"), so the whole
 * module runs under the offline unit tests with synthetic data. The server reader is lib/rewards-server.ts.
 *
 * Everything here is an ESTIMATE until a balance has been harvested: earn rates are the card's published ones as
 * far as they are known, valuations are Riley's to edit, and a program with no harvested balance is "not connected
 * yet", never 0. Nothing in this module places an order, moves points or signs in anywhere.
 */
import { classifyTxn } from "./finance-ledger";

// ─── Programs ────────────────────────────────────────────────────────────────────────────────────────────

export type ProgramId = "amex_mr" | "delta_skymiles" | "hilton_honors" | "marriott_bonvoy" | "uber_cash" | "uber_one";
export type Unit = "points" | "miles" | "usd";

export interface ProgramDef {
  id: ProgramId;
  name: string;
  unit: Unit;
  /** Default value of one point / mile in cents (usd programs: 100 = a dollar is a dollar). An estimate, editable. */
  defaultCpp: number;
  /** How the balance can run out; shown on the card. */
  expiry: "none" | "inactivity-24m" | "terms";
  expiryText: string;
}

export const PROGRAMS: readonly ProgramDef[] = [
  { id: "amex_mr", name: "Amex Membership Rewards", unit: "points", defaultCpp: 1.0, expiry: "none", expiryText: "No expiry while the card is open" },
  { id: "delta_skymiles", name: "Delta SkyMiles", unit: "miles", defaultCpp: 1.1, expiry: "none", expiryText: "Miles do not expire" },
  { id: "hilton_honors", name: "Hilton Honors", unit: "points", defaultCpp: 0.5, expiry: "inactivity-24m", expiryText: "Expire after 24 months with no qualifying activity" },
  { id: "marriott_bonvoy", name: "Marriott Bonvoy", unit: "points", defaultCpp: 0.8, expiry: "inactivity-24m", expiryText: "Expire after 24 months with no qualifying activity" },
  { id: "uber_cash", name: "Uber Cash", unit: "usd", defaultCpp: 100, expiry: "terms", expiryText: "Each credit has its own expiry in the Uber app" },
  { id: "uber_one", name: "Uber One", unit: "usd", defaultCpp: 100, expiry: "terms", expiryText: "Membership benefits renew with the plan" },
];
export const PROGRAM_IDS: readonly ProgramId[] = PROGRAMS.map((p) => p.id);
export const isProgramId = (v: unknown): v is ProgramId => typeof v === "string" && (PROGRAM_IDS as readonly string[]).includes(v);
export const programDef = (id: ProgramId): ProgramDef => PROGRAMS.find((p) => p.id === id) as ProgramDef;

/** A harvested balance older than this is flagged stale (the PC harvester runs daily). */
export const STALE_BALANCE_DAYS = 7;
/** A program whose points expire within this many days is "at risk". */
export const AT_RISK_DAYS = 90;
/** Today shows an expiry within this many days. */
export const TODAY_EXPIRY_DAYS = 60;
/** Today shows a credit with value left when this few days remain in its period. */
export const TODAY_CREDIT_DAYS = 7;

// ─── Dates (Eastern "YYYY-MM-DD" strings; never the clock) ───────────────────────────────────────────────

const isDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
export const addDays = (d: string, n: number): string => new Date(ms(d) + n * 86_400_000).toISOString().slice(0, 10);
export const daysBetween = (from: string, to: string): number => Math.round((ms(to) - ms(from)) / 86_400_000);
/** Add whole months to a day, clamping the day of month (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(d: string, n: number): string {
  const [y, m, dd] = d.split("-").map(Number);
  const idx = y * 12 + (m - 1) + n;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(dd, last)).padStart(2, "0")}`;
}
const monthOf = (d: string) => d.slice(0, 7);
const shiftMonth = (month: string, delta: number) => addMonths(`${month}-01`, delta).slice(0, 7);
export function trailingMonths(today: string, count = 12): string[] {
  const end = monthOf(today);
  return Array.from({ length: count }, (_, i) => shiftMonth(end, i - (count - 1)));
}
export function quarterOf(d: string): string {
  const q = Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1;
  return `${d.slice(0, 4)}-Q${q}`;
}
export const isQuarterKey = (s: unknown): s is string => typeof s === "string" && /^\d{4}-Q[1-4]$/.test(s);
export function dayLabel(d: string): string {
  return new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

// ─── Settings (pds.rewards_settings; Riley's editable values) ───────────────────────────────────────────

export interface RewardsSettings {
  /** Cents per point / mile by program id (valuations). Missing = the default. */
  cpp: Partial<Record<ProgramId, number>>;
  /** Cents of cash back per dollar's worth of points on the cash-back cards, by card id. Fixed at 1 per cent, listed for the table. */
  discoverQuarter: { quarter: string | null; keywords: string[] };
  /** Apple Card's 3% merchants (uppercase words) beyond Apple itself. */
  appleBoosted: string[];
  /** Credit amount overrides in cents, by credit id. */
  creditCents: Record<string, number>;
}
export const DEFAULT_APPLE_BOOSTED: readonly string[] = ["UBER", "NIKE", "WALGREENS", "T-MOBILE", "EXXON", "SHELL", "PANERA", "ACE HARDWARE"];
export const EMPTY_SETTINGS: RewardsSettings = { cpp: {}, discoverQuarter: { quarter: null, keywords: [] }, appleBoosted: [...DEFAULT_APPLE_BOOSTED], creditCents: {} };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const cleanWord = (s: string) => s.replace(/[^A-Za-z0-9 &'.\-]/g, "").trim().toUpperCase().slice(0, 40);

/** Valid cents-per-point: a finite number from 0.01 to 1000 (usd programs are 100). */
export const validCpp = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0.01 && v <= 1000;
export const validCreditCents = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 10_000_000;

/** Rows of pds.rewards_settings -> settings. A malformed value is ignored (the default stays), never thrown. */
export function parseSettings(rows: readonly { key: unknown; value: unknown }[]): RewardsSettings {
  const out: RewardsSettings = { cpp: {}, discoverQuarter: { quarter: null, keywords: [] }, appleBoosted: [...DEFAULT_APPLE_BOOSTED], creditCents: {} };
  for (const r of rows) {
    if (r.key === "valuations" && isObj(r.value)) {
      for (const [k, v] of Object.entries(r.value)) if (isProgramId(k) && validCpp(v)) out.cpp[k] = v;
    } else if (r.key === "discover_quarter" && isObj(r.value)) {
      const q = r.value.quarter;
      const kw = Array.isArray(r.value.keywords) ? r.value.keywords.filter((x): x is string => typeof x === "string").map(cleanWord).filter(Boolean).slice(0, 12) : [];
      out.discoverQuarter = { quarter: isQuarterKey(q) ? q : null, keywords: kw };
    } else if (r.key === "apple_boosted" && Array.isArray(r.value)) {
      out.appleBoosted = r.value.filter((x): x is string => typeof x === "string").map(cleanWord).filter(Boolean).slice(0, 30);
    } else if (r.key === "credits" && isObj(r.value)) {
      for (const [k, v] of Object.entries(r.value)) if (CREDIT_IDS.has(k) && validCreditCents(v)) out.creditCents[k] = v;
    }
  }
  return out;
}
export const cppOf = (s: RewardsSettings, id: ProgramId): number => s.cpp[id] ?? programDef(id).defaultCpp;

// ─── Balances ────────────────────────────────────────────────────────────────────────────────────────────

export interface BalanceRow {
  program: ProgramId;
  captured_at: string;
  balance: number;
  unit: Unit;
  status_tier: string | null;
  status_progress: Record<string, number> | null;
  expires_on: string | null;
  source: string;
}

/** A PostgREST row -> BalanceRow, or null when it is not usable (unknown program, non-finite balance, bad date). */
export function parseBalanceRow(raw: unknown): BalanceRow | null {
  if (!isObj(raw)) return null;
  const { program, captured_at, unit } = raw;
  const balance = typeof raw.balance === "string" ? Number(raw.balance) : raw.balance;
  if (!isProgramId(program) || typeof captured_at !== "string" || !Number.isFinite(Date.parse(captured_at))) return null;
  if (typeof balance !== "number" || !Number.isFinite(balance)) return null;
  if (unit !== "points" && unit !== "miles" && unit !== "usd") return null;
  let progress: Record<string, number> | null = null;
  if (isObj(raw.status_progress)) {
    progress = {};
    for (const [k, v] of Object.entries(raw.status_progress)) if (typeof v === "number" && Number.isFinite(v)) progress[k.slice(0, 30)] = v;
  }
  const expires = typeof raw.expires_on === "string" && isDay(raw.expires_on.slice(0, 10)) ? raw.expires_on.slice(0, 10) : null;
  return {
    program,
    captured_at,
    balance,
    unit,
    status_tier: typeof raw.status_tier === "string" ? raw.status_tier.slice(0, 60) : null,
    status_progress: progress && Object.keys(progress).length ? progress : null,
    expires_on: expires,
    source: typeof raw.source === "string" ? raw.source.slice(0, 30) : "harvest",
  };
}

/** The newest row per program. */
export function latestBalances(rows: readonly BalanceRow[]): Map<ProgramId, BalanceRow> {
  const out = new Map<ProgramId, BalanceRow>();
  for (const r of rows) {
    const cur = out.get(r.program);
    if (!cur || Date.parse(r.captured_at) > Date.parse(cur.captured_at)) out.set(r.program, r);
  }
  return out;
}

export interface ProgressBar {
  label: string;
  value: number;
  goal: number;
  pct: number;
}
/** {"mqd":..,"mqd_goal":..} / {"nights":..,"nights_goal":..} -> bars. A key with no `<key>_goal` partner is not a bar. */
export function progressBars(progress: Record<string, number> | null): ProgressBar[] {
  if (!progress) return [];
  const out: ProgressBar[] = [];
  for (const [k, v] of Object.entries(progress)) {
    if (k.endsWith("_goal")) continue;
    const goal = progress[`${k}_goal`];
    if (typeof goal === "number" && goal > 0) out.push({ label: k.replace(/_/g, " ").toUpperCase(), value: v, goal, pct: Math.max(0, Math.min(100, (v / goal) * 100)) });
  }
  return out;
}

// ─── Hotel activity (what keeps Hilton and Marriott points alive) ───────────────────────────────────────

/** Brand words. Strong ones count alone; weak ones are ordinary words and need a hotel word beside them. */
const HILTON_STRONG = ["HILTON", "HAMPTON", "HOMEWOOD", "DOUBLETREE", "EMBASSY SUITES", "CONRAD", "WALDORF"];
const HILTON_WEAK = ["CURIO", "TAPESTRY", "HOME2", "TRU", "CANOPY", "MOTTO", "SPARK", "LXR", "SIGNIA"];
const MARRIOTT_STRONG = [
  "MARRIOTT", "COURTYARD", "RESIDENCE INN", "SHERATON", "WESTIN", "W HOTEL", "ST REGIS", "RITZ", "RENAISSANCE", "FAIRFIELD",
  "SPRINGHILL", "TOWNEPLACE", "ALOFT", "MOXY", "AC HOTEL", "LE MERIDIEN", "GAYLORD", "JW MARRIOTT", "DELTA HOTELS", "FOUR POINTS",
];
const MARRIOTT_WEAK = ["ELEMENT", "AUTOGRAPH", "TRIBUTE", "EDITION"];
const HOTEL_WORD = /\b(HOTEL|HOTELS|INN|SUITES|RESORT|HILTON|MARRIOTT|STAY)\b/;

/** Words the server asks the database for before the pure matcher decides (weak words alone would flood the read). */
export const HOTEL_PREFILTER: readonly string[] = [...HILTON_STRONG, ...MARRIOTT_STRONG, "CURIO COLLECTION", "TAPESTRY COLLECTION", "AUTOGRAPH COLLECTION", "TRIBUTE PORTFOLIO"].filter((w) => w !== "W HOTEL" && w !== "RITZ");

const hasWord = (label: string, w: string) => new RegExp(`(^|[^A-Z0-9])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Z0-9]|$)`).test(label);

export function hotelFamily(label: string): "hilton_honors" | "marriott_bonvoy" | null {
  const l = label.toUpperCase();
  const near = HOTEL_WORD.test(l);
  if (HILTON_STRONG.some((w) => hasWord(l, w)) || (near && HILTON_WEAK.some((w) => hasWord(l, w)))) return "hilton_honors";
  if (MARRIOTT_STRONG.some((w) => hasWord(l, w)) || (near && MARRIOTT_WEAK.some((w) => hasWord(l, w)))) return "marriott_bonvoy";
  return null;
}

export interface Txn {
  account_key: string;
  txn_date: string;
  name: string | null;
  custom_name: string | null;
  amount_cents: number; // expense-positive, like the ledger
  category: string | null;
  ignored_from: string | null;
  /** ISO currency of amount_cents; missing = USD (the ledger's default). Non-USD rows never enter dollar math. */
  currency?: string | null;
}
/** Same rule as the finance ledger: a non-USD amount is never added to USD totals (no conversion is assumed). */
export const isUsd = (t: Pick<Txn, "currency">): boolean => ((t.currency ?? "USD").trim().toUpperCase() || "USD") === "USD";
export const labelOf = (t: Pick<Txn, "name" | "custom_name">): string => (t.custom_name || t.name || "").toUpperCase();
const isPurchase = (t: Txn) => t.amount_cents > 0 && classifyTxn(t) === "counted";

export interface ActivityResult {
  /** Newest counted purchase at a brand of the family; null = none in what was read. */
  lastDate: string | null;
}
export function lastHotelActivity(txns: readonly Txn[], family: "hilton_honors" | "marriott_bonvoy"): ActivityResult {
  let last: string | null = null;
  for (const t of txns) {
    if (!isPurchase(t) || !isDay(t.txn_date)) continue;
    if (hotelFamily(labelOf(t)) === family && (!last || t.txn_date > last)) last = t.txn_date;
  }
  return { lastDate: last };
}

export interface ExpiryInfo {
  /** The day the points expire: a harvested date wins over the estimate; null = not known. */
  date: string | null;
  basis: "harvested" | "estimated" | "none" | "unknown";
  daysLeft: number | null;
  atRisk: boolean;
  note: string;
}
/**
 * Expiry of one program. Hilton / Marriott: 24 months after the last stay seen on a card (an estimate, since
 * other activity also counts and the ledger does not hold every stay), unless the harvester read a date.
 * `earliest` = the first day of ledger history, so "no stay seen" is only claimed for what was read.
 */
export function expiryOf(def: ProgramDef, balance: BalanceRow | null, lastActivity: string | null, today: string, earliest: string | null): ExpiryInfo {
  const harvested = balance?.expires_on ?? null;
  const left = (d: string) => daysBetween(today, d);
  if (harvested) {
    const n = left(harvested);
    return { date: harvested, basis: "harvested", daysLeft: n, atRisk: n <= AT_RISK_DAYS, note: "Read from your account" };
  }
  if (def.expiry === "inactivity-24m") {
    if (lastActivity) {
      const d = addMonths(lastActivity, 24);
      const n = left(d);
      return { date: d, basis: "estimated", daysLeft: n, atRisk: n <= AT_RISK_DAYS, note: `Estimated from your last stay on a card (${dayLabel(lastActivity)})` };
    }
    return {
      date: null,
      basis: "unknown",
      daysLeft: null,
      atRisk: false,
      note: earliest ? `No stay on a card since ${dayLabel(earliest)}, so the expiry date is unknown` : "No card history to estimate from",
    };
  }
  return { date: null, basis: "none", daysLeft: null, atRisk: false, note: def.expiryText };
}

// ─── Cards and earn estimates ───────────────────────────────────────────────────────────────────────────

export type CardId = "amex_platinum" | "apple_card" | "discover_it" | "citi_simplicity" | "citi_diamond";
export interface CardDef {
  id: CardId;
  name: string;
  /** "points": Amex MR points; "cash": cash back in dollars. */
  earns: "points" | "cash" | "none";
  program?: ProgramId;
}
export const CARDS: readonly CardDef[] = [
  { id: "amex_platinum", name: "Amex Platinum", earns: "points", program: "amex_mr" },
  { id: "apple_card", name: "Apple Card", earns: "cash" },
  { id: "discover_it", name: "Discover it", earns: "cash" },
  { id: "citi_simplicity", name: "Citi Simplicity", earns: "none" },
  { id: "citi_diamond", name: "Citi Diamond Preferred", earns: "none" },
];
export const cardDef = (id: CardId): CardDef => CARDS.find((c) => c.id === id) as CardDef;

export interface AccountRow {
  account_key: string;
  institution: string;
  account_name: string;
}
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
/** Which card an account is, from its institution and name only (never a mask or an id). */
export function identifyCard(a: Pick<AccountRow, "institution" | "account_name">): CardId | null {
  const inst = squash(a.institution);
  const name = squash(a.account_name);
  if (inst.includes("american express") && name.includes("platinum")) return "amex_platinum";
  if (inst.includes("apple") && name.includes("apple card")) return "apple_card";
  if (inst.includes("discover") && name.includes("discover it")) return "discover_it";
  if (inst.includes("citi") && name.includes("simplicity")) return "citi_simplicity";
  if (inst.includes("citi") && name.includes("diamond")) return "citi_diamond";
  return null;
}
export function cardAccounts(accounts: readonly AccountRow[]): Map<string, CardId> {
  const out = new Map<string, CardId>();
  for (const a of accounts) {
    const c = identifyCard(a);
    if (c) out.set(a.account_key, c);
  }
  return out;
}

const AIRLINES = [
  "DELTA AIR", "UNITED AIR", "AMERICAN AIR", "SOUTHWEST", "JETBLUE", "ALASKA AIR", "SPIRIT AIR", "FRONTIER AIR", "AIR CANADA",
  "BRITISH AIRWAYS", "LUFTHANSA", "AIR FRANCE", "KLM", "IBERIA", "VIRGIN ATLANTIC", "EMIRATES", "QATAR AIR", "SINGAPORE AIR",
  "AIR LINGUS", "TAP AIR", "ICELANDAIR", "HAWAIIAN AIR", "WESTJET", "TURKISH AIR", "ANA ", "JAPAN AIR", "QANTAS",
];
export type SpendKind = "flight" | "hotel-amex-travel" | "apple" | "other";
export function spendKind(label: string, appleBoosted: readonly string[] = DEFAULT_APPLE_BOOSTED): SpendKind {
  const l = ` ${label.toUpperCase()} `;
  if (l.includes("AMEX TRAVEL") || l.includes("AMERICAN EXPRESS TRAVEL")) return "hotel-amex-travel";
  if (AIRLINES.some((a) => l.includes(` ${a.trim()}`)) && !l.includes("AMEX TRAVEL")) return "flight";
  if (l.includes("APPLE.COM") || l.includes(" APPLE STORE") || l.includes("APPLE ONE") || l.includes("ITUNES")) return "apple";
  if (appleBoosted.some((w) => l.includes(` ${w}`))) return "apple";
  return "other";
}

export interface EarnMonth {
  month: string;
  /** Points (Amex) or cents of cash back (cash cards). */
  earned: number;
  spendCents: number;
}
export interface CardEarn {
  card: CardId;
  months: EarnMonth[];
  total: number;
  spendCents: number;
  /** Every purchase counted, so "no activity" is distinguishable from "no card found". */
  txnCount: number;
}

/** The fraction of Discover's 5% that applies: only the stored quarter, only the listed keywords, up to $1,500 of spend. */
const DISCOVER_QUARTER_CAP_CENTS = 150_000;

/**
 * Points earned per card per month. Amex Platinum: 5x on airfare booked with an airline, 5x on prepaid hotels via
 * Amex Travel, 1x on the rest. Apple Card: 3% at Apple and the listed merchants, 2% on the rest (the 1% for a
 * purchase not made with Apple Pay cannot be seen, so 2% is assumed). Discover it: 1%, 5% on the stored quarter's
 * categories. Citi cards earn nothing. Refunds and non-purchases are never counted.
 */
export function estimateEarn(txns: readonly Txn[], accounts: readonly AccountRow[], settings: RewardsSettings, months: readonly string[]): CardEarn[] {
  const byAccount = cardAccounts(accounts);
  const acc = new Map<CardId, Map<string, EarnMonth>>();
  const counts = new Map<CardId, number>();
  const discoverSpent = new Map<string, number>(); // quarter-capped spend
  const sorted = [...txns].sort((a, b) => (a.txn_date < b.txn_date ? -1 : a.txn_date > b.txn_date ? 1 : 0));
  for (const t of sorted) {
    const card = byAccount.get(t.account_key);
    if (!card || !isPurchase(t) || !isDay(t.txn_date) || !isUsd(t)) continue;
    const month = monthOf(t.txn_date);
    if (!months.includes(month)) continue;
    const label = labelOf(t);
    let earned = 0;
    if (card === "amex_platinum") {
      const k = spendKind(label, settings.appleBoosted);
      earned = t.amount_cents / 100 * (k === "flight" || k === "hotel-amex-travel" ? 5 : 1);
    } else if (card === "apple_card") {
      earned = t.amount_cents * (spendKind(label, settings.appleBoosted) === "apple" ? 0.03 : 0.02);
    } else if (card === "discover_it") {
      const dq = settings.discoverQuarter;
      const bonus = !!dq.quarter && quarterOf(t.txn_date) === dq.quarter && dq.keywords.some((w) => label.includes(w) || (t.category ?? "").toUpperCase().includes(w));
      let five = 0;
      if (bonus) {
        const used = discoverSpent.get(dq.quarter as string) ?? 0;
        five = Math.max(0, Math.min(t.amount_cents, DISCOVER_QUARTER_CAP_CENTS - used));
        discoverSpent.set(dq.quarter as string, used + five);
      }
      earned = five * 0.05 + (t.amount_cents - five) * 0.01;
    }
    const m = acc.get(card) ?? new Map<string, EarnMonth>();
    const row = m.get(month) ?? { month, earned: 0, spendCents: 0 };
    row.earned += earned;
    row.spendCents += t.amount_cents;
    m.set(month, row);
    acc.set(card, m);
    counts.set(card, (counts.get(card) ?? 0) + 1);
  }
  return CARDS.filter((c) => c.earns !== "none" || acc.has(c.id)).map((c) => {
    const m = acc.get(c.id) ?? new Map<string, EarnMonth>();
    const rows = months.map((month) => {
      const r = m.get(month) ?? { month, earned: 0, spendCents: 0 };
      return { ...r, earned: Math.round(r.earned) };
    });
    return { card: c.id, months: rows, total: rows.reduce((s, r) => s + r.earned, 0), spendCents: rows.reduce((s, r) => s + r.spendCents, 0), txnCount: counts.get(c.id) ?? 0 };
  });
}

// ─── Best card for a purchase ────────────────────────────────────────────────────────────────────────────

export interface BestRow {
  category: string;
  best: CardId | null;
  /** Value in cents per $1 for each card that earns anything. */
  values: { card: CardId; centsPerDollar: number; rate: string }[];
  note: string | null;
}
/** Cents of value per $1 on each card, for six kinds of purchase. Points are valued at Riley's cents per point. */
export function bestCardTable(settings: RewardsSettings): BestRow[] {
  const mr = cppOf(settings, "amex_mr");
  const dq = settings.discoverQuarter;
  const dqHas = (words: string[]) => dq.keywords.some((k) => words.some((w) => k.includes(w) || w.includes(k)));
  const rows: { category: string; amex: number; apple: number; discover: number; discover5?: boolean; note?: string }[] = [
    { category: "Flights (booked with the airline)", amex: 5, apple: 2, discover: 1, note: "5x only when booked directly with the airline" },
    { category: "Hotels (prepaid, Amex Travel)", amex: 5, apple: 2, discover: 1, note: "5x only on prepaid hotels booked through Amex Travel; otherwise 1x" },
    { category: "Dining", amex: 1, apple: 2, discover: 1, discover5: dqHas(["DINING", "RESTAURANT"]) },
    { category: "Groceries", amex: 1, apple: 2, discover: 1, discover5: dqHas(["GROCER", "SUPERMARKET"]) },
    { category: "Apple and Apple Card partners", amex: 1, apple: 3, discover: 1, note: "Apple Card pays 3% at Apple and the merchants listed under Apple Card" },
    { category: "Everything else", amex: 1, apple: 2, discover: 1 },
  ];
  return rows.map((r) => {
    const values = [
      { card: "amex_platinum" as CardId, centsPerDollar: r.amex * mr, rate: `${r.amex}x` },
      { card: "apple_card" as CardId, centsPerDollar: r.apple, rate: `${r.apple}%` },
      { card: "discover_it" as CardId, centsPerDollar: r.discover5 ? 5 : r.discover, rate: r.discover5 ? "5% this quarter" : `${r.discover}%` },
    ];
    const top = values.reduce((m, v) => (v.centsPerDollar > m.centsPerDollar ? v : m), values[0]);
    // A tie is not a recommendation: with equal values the first card in the list would otherwise win by position.
    const tied = values.filter((v) => Math.abs(v.centsPerDollar - top.centsPerDollar) < 1e-9).length > 1;
    return { category: r.category, best: tied ? null : top.card, values, note: tied ? "Equal value, any of them" : r.note ?? null };
  });
}

// ─── Amex Platinum credits ───────────────────────────────────────────────────────────────────────────────

export type CreditPeriod = "monthly" | "quarterly" | "semiannual" | "annual";
export interface CreditDef {
  id: string;
  name: string;
  period: CreditPeriod;
  /** Default amount per period, in cents. An estimate: Amex changes these, so each is editable. */
  amountCents: number;
  /** Words of a credit row's description (uppercase). Empty = the credit is applied inside another app and leaves no row. */
  patterns: string[];
  note?: string;
}
export const CREDITS: readonly CreditDef[] = [
  { id: "uber_cash", name: "Uber Cash", period: "monthly", amountCents: 1500, patterns: [], note: "Added to Uber Cash, so it leaves no row on the card; check the Uber Cash balance" },
  { id: "airline_fee", name: "Airline fee credit", period: "annual", amountCents: 20000, patterns: ["AIRLINE FEE", "AIRLINE CREDIT"], note: "Incidental fees on the one airline you select" },
  { id: "hotel", name: "Hotel credit", period: "semiannual", amountCents: 30000, patterns: ["HOTEL CREDIT", "FINE HOTELS", "HOTEL COLLECTION"], note: "Prepaid Fine Hotels + Resorts or The Hotel Collection" },
  { id: "digital_entertainment", name: "Digital entertainment", period: "monthly", amountCents: 2500, patterns: ["DIGITAL ENTERTAINMENT"] },
  { id: "resy", name: "Resy dining", period: "quarterly", amountCents: 10000, patterns: ["RESY"] },
  { id: "lululemon", name: "lululemon", period: "quarterly", amountCents: 7500, patterns: ["LULULEMON"] },
  { id: "walmart_plus", name: "Walmart+", period: "monthly", amountCents: 1295, patterns: ["WALMART"] },
  { id: "clear_plus", name: "CLEAR Plus", period: "annual", amountCents: 20900, patterns: ["CLEAR PLUS", "CLEAR"] },
  { id: "equinox", name: "Equinox", period: "annual", amountCents: 30000, patterns: ["EQUINOX"] },
];
export const CREDIT_IDS: ReadonlySet<string> = new Set(CREDITS.map((c) => c.id));

export interface PeriodBounds {
  start: string;
  end: string; // inclusive last day
  label: string;
}
/** The calendar period of a credit that contains `today` (Amex Platinum credits run on the calendar year). */
export function periodBounds(period: CreditPeriod, today: string): PeriodBounds {
  const y = today.slice(0, 4);
  const m = Number(today.slice(5, 7));
  const span = period === "monthly" ? 1 : period === "quarterly" ? 3 : period === "semiannual" ? 6 : 12;
  const first = Math.floor((m - 1) / span) * span + 1;
  const start = `${y}-${String(first).padStart(2, "0")}-01`;
  const end = addDays(addMonths(start, span), -1);
  const label = period === "monthly" ? today.slice(0, 7) : period === "quarterly" ? quarterOf(today) : period === "semiannual" ? `${y} ${first === 1 ? "Jan-Jun" : "Jul-Dec"}` : y;
  return { start, end, label };
}

export type CreditState = "used" | "partly" | "unused" | "untracked";
export interface CreditStatus {
  id: string;
  name: string;
  period: CreditPeriod;
  periodLabel: string;
  amountCents: number;
  usedCents: number;
  leftCents: number;
  daysLeft: number; // days until the period's last day, 0 = ends today
  periodEnd: string;
  state: CreditState;
  /** The amount is the built-in estimate (not edited by Riley). */
  estimate: boolean;
  note: string | null;
}

/**
 * Used vs available this period. A credit counts as used only by a matching credit row (a negative amount on the
 * Amex Platinum card whose description names it) dated inside the period; no row = "not used yet". Credits that
 * leave no row (Uber Cash) are "untracked", never claimed either way. A row matched by two credits (WALMART and
 * CLEAR are short) goes to the one with the longest matching word.
 */
export function creditStatuses(txns: readonly Txn[], accounts: readonly AccountRow[], settings: RewardsSettings, today: string): CreditStatus[] {
  const platinum = new Set([...cardAccounts(accounts)].filter(([, c]) => c === "amex_platinum").map(([k]) => k));
  const credits = txns.filter((t) => platinum.has(t.account_key) && t.amount_cents < 0 && !(t.ignored_from ?? "").trim() && isDay(t.txn_date) && isUsd(t));
  const rowsBy = new Map<string, { date: string; cents: number }[]>();
  for (const t of credits) {
    const l = labelOf(t);
    let best: { id: string; len: number } | null = null;
    for (const c of CREDITS) for (const p of c.patterns) if (l.includes(p) && (!best || p.length > best.len)) best = { id: c.id, len: p.length };
    if (best) {
      const rows = rowsBy.get(best.id) ?? [];
      rows.push({ date: t.txn_date, cents: -t.amount_cents });
      rowsBy.set(best.id, rows);
    }
  }
  return CREDITS.map((c) => {
    const b = periodBounds(c.period, today);
    const amountCents = settings.creditCents[c.id] ?? c.amountCents;
    const used = (rowsBy.get(c.id) ?? []).filter((r) => r.date >= b.start && r.date <= b.end).reduce((s, r) => s + r.cents, 0);
    const state: CreditState = c.patterns.length === 0 ? "untracked" : used <= 0 ? "unused" : used >= amountCents * 0.99 ? "used" : "partly";
    return {
      id: c.id,
      name: c.name,
      period: c.period,
      periodLabel: b.label,
      amountCents,
      usedCents: used,
      leftCents: Math.max(0, amountCents - used),
      daysLeft: daysBetween(today, b.end),
      periodEnd: b.end,
      state,
      estimate: settings.creditCents[c.id] === undefined,
      note: c.note ?? null,
    };
  });
}

// ─── Flights (Delta context) ─────────────────────────────────────────────────────────────────────────────

export interface FlightRow {
  dep_local_date: string;
  dep_iata: string | null;
  arr_iata: string | null;
  carrier_code: string | null;
  status: string | null;
}
export interface FlightSummary {
  thisYear: number;
  next: { date: string; route: string } | null;
}
export function summarizeFlights(rows: readonly FlightRow[], today: string): FlightSummary {
  const live = rows.filter((r) => isDay(r.dep_local_date) && r.status !== "cancelled" && r.status !== "superseded");
  const thisYear = live.filter((r) => r.dep_local_date.slice(0, 4) === today.slice(0, 4) && r.dep_local_date <= today).length;
  const upcoming = live.filter((r) => r.dep_local_date >= today).sort((a, b) => (a.dep_local_date < b.dep_local_date ? -1 : 1))[0];
  return { thisYear, next: upcoming ? { date: upcoming.dep_local_date, route: `${upcoming.dep_iata ?? "?"} to ${upcoming.arr_iata ?? "?"}` } : null };
}

// ─── The page's view of everything ───────────────────────────────────────────────────────────────────────

export interface ProgramView {
  id: ProgramId;
  name: string;
  unit: Unit;
  expiryText: string;
  cpp: number;
  cppDefault: boolean;
  /** null = not connected yet (no harvested row), never 0. */
  balance: BalanceRow | null;
  stale: boolean;
  ageDays: number | null;
  /** Dollar value of the balance (cents), from the valuation; null without a balance. */
  valueCents: number | null;
  expiry: ExpiryInfo;
}
export interface RewardsData {
  today: string;
  programs: ProgramView[];
  credits: CreditStatus[];
  earn: CardEarn[];
  best: BestRow[];
  flights: FlightSummary | null;
  settings: RewardsSettings;
  /** The first day of the ledger history read, for "no stay seen since". */
  earliest: string | null;
  months: string[];
  /** Card-account rows read in the window that are not in USD: left out of earn and credits, and shown as a count. */
  nonUsdCount: number;
}

export interface RewardsInput {
  today: string;
  balances: readonly BalanceRow[];
  settings: RewardsSettings;
  accounts: readonly AccountRow[];
  windowTxns: readonly Txn[];
  /** Hotel-family purchases over all time (prefiltered by the server; the matcher decides). */
  hotelTxns: readonly Txn[];
  flights: readonly FlightRow[] | null;
  earliest: string | null;
}

export function buildRewards(i: RewardsInput): RewardsData {
  const latest = latestBalances(i.balances);
  const months = trailingMonths(i.today, 12);
  const all = [...i.windowTxns, ...i.hotelTxns];
  const programs = PROGRAMS.map((def): ProgramView => {
    const balance = latest.get(def.id) ?? null;
    const cpp = cppOf(i.settings, def.id);
    const age = balance ? Math.floor((Date.parse(`${i.today}T12:00:00Z`) - Date.parse(balance.captured_at)) / 86_400_000) : null;
    const activity = def.id === "hilton_honors" || def.id === "marriott_bonvoy" ? lastHotelActivity(all, def.id).lastDate : null;
    return {
      id: def.id,
      name: def.name,
      unit: def.unit,
      expiryText: def.expiryText,
      cpp,
      cppDefault: i.settings.cpp[def.id] === undefined,
      balance,
      stale: age !== null && age > STALE_BALANCE_DAYS,
      ageDays: age,
      valueCents: balance && def.id !== "uber_one" ? Math.round(def.unit === "usd" ? balance.balance * 100 : (balance.balance * cpp)) : null,
      expiry: expiryOf(def, balance, activity, i.today, i.earliest),
    };
  });
  return {
    today: i.today,
    programs,
    credits: creditStatuses(i.windowTxns, i.accounts, i.settings, i.today),
    earn: estimateEarn(i.windowTxns, i.accounts, i.settings, months),
    best: bestCardTable(i.settings),
    flights: i.flights ? summarizeFlights(i.flights, i.today) : null,
    settings: i.settings,
    earliest: i.earliest,
    months,
    nonUsdCount: countNonUsd(i.windowTxns, i.accounts),
  };
}

/** Rows on a known card account whose currency is not USD (each is excluded from the dollar estimates). */
export function countNonUsd(txns: readonly Txn[], accounts: readonly AccountRow[]): number {
  const cards = cardAccounts(accounts);
  return txns.filter((t) => cards.has(t.account_key) && !isUsd(t)).length;
}

// ─── Today ───────────────────────────────────────────────────────────────────────────────────────────────

export interface RewardsAlert {
  kind: "rewards";
  severity: "medium";
  title: string;
  detail: string;
  href: string;
  due: string;
}
/**
 * What Today shows: points expiring within 60 days, and a credit with value left and 7 or fewer days in its
 * period. A credit's own dollar value is the only amount shown. Untracked credits never alert (nothing to read).
 * Estimated expiries count too (they say "estimated"); an unknown expiry never alerts.
 */
export function rewardsAlerts(data: RewardsData): RewardsAlert[] {
  const out: RewardsAlert[] = [];
  for (const p of data.programs) {
    const d = p.expiry;
    if (d.date && d.daysLeft !== null && d.daysLeft <= TODAY_EXPIRY_DAYS && (p.balance?.balance ?? 1) > 0) {
      out.push({
        kind: "rewards",
        severity: "medium",
        title: `${p.name}: points expire ${dayLabel(d.date)}`,
        detail: d.basis === "estimated" ? "Estimated from your last stay; a stay or other qualifying activity resets it." : "Any qualifying activity resets the clock.",
        href: "/rewards",
        due: d.date < data.today ? data.today : d.date,
      });
    }
  }
  for (const c of data.credits) {
    if (c.state === "untracked" || c.leftCents <= 0 || c.daysLeft > TODAY_CREDIT_DAYS || c.daysLeft < 0) continue;
    const dollars = `$${Math.round(c.leftCents / 100).toLocaleString("en-US")}`;
    out.push({
      kind: "rewards",
      severity: "medium",
      title: `${c.name} credit: ${dollars} unused`,
      detail: `Ends ${dayLabel(c.periodEnd)}. Not seen on the card yet.`,
      href: "/rewards",
      due: c.periodEnd,
    });
  }
  return out;
}

// ─── Settings writes (PUT /api/rewards/settings) ─────────────────────────────────────────────────────────

export type SettingsPatch =
  | { key: "valuations"; value: Partial<Record<ProgramId, number>> }
  | { key: "discover_quarter"; value: { quarter: string | null; keywords: string[] } }
  | { key: "apple_boosted"; value: string[] }
  | { key: "credits"; value: Record<string, number> };

/** Validate a PUT body. Unknown keys / fields, bad numbers and oversize lists are refused; returns the clean patch. */
export function parseSettingsPatch(body: unknown): { ok: true; patch: SettingsPatch } | { ok: false; error: string } {
  if (!isObj(body)) return { ok: false, error: "bad_body" };
  const keys = Object.keys(body);
  if (keys.some((k) => k !== "key" && k !== "value") || !("value" in body)) return { ok: false, error: "unknown_field" };
  const v = body.value;
  if (body.key === "valuations") {
    if (!isObj(v)) return { ok: false, error: "bad_value" };
    const out: Partial<Record<ProgramId, number>> = {};
    for (const [k, x] of Object.entries(v)) {
      if (!isProgramId(k) || !validCpp(x)) return { ok: false, error: "bad_value" };
      out[k] = x;
    }
    return { ok: true, patch: { key: "valuations", value: out } };
  }
  if (body.key === "discover_quarter") {
    if (!isObj(v) || Object.keys(v).some((k) => k !== "quarter" && k !== "keywords")) return { ok: false, error: "bad_value" };
    const quarter = v.quarter === null || v.quarter === "" ? null : v.quarter;
    if (quarter !== null && !isQuarterKey(quarter)) return { ok: false, error: "bad_quarter" };
    if (!Array.isArray(v.keywords) || v.keywords.length > 12 || v.keywords.some((x) => typeof x !== "string")) return { ok: false, error: "bad_value" };
    return { ok: true, patch: { key: "discover_quarter", value: { quarter, keywords: (v.keywords as string[]).map(cleanWord).filter(Boolean) } } };
  }
  if (body.key === "apple_boosted") {
    if (!Array.isArray(v) || v.length > 30 || v.some((x) => typeof x !== "string")) return { ok: false, error: "bad_value" };
    return { ok: true, patch: { key: "apple_boosted", value: (v as string[]).map(cleanWord).filter(Boolean) } };
  }
  if (body.key === "credits") {
    if (!isObj(v)) return { ok: false, error: "bad_value" };
    const out: Record<string, number> = {};
    for (const [k, x] of Object.entries(v)) {
      if (!CREDIT_IDS.has(k) || !validCreditCents(x)) return { ok: false, error: "bad_value" };
      out[k] = x;
    }
    return { ok: true, patch: { key: "credits", value: out } };
  }
  return { ok: false, error: "unknown_key" };
}
