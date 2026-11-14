/**
 * Waste flags for the subscriptions detected in the ledger (lib/procurement-recurring.ts).
 *
 * PURE and rule-based: no network, no clock, no Supabase, no model. Read-only advice: a flag is a
 * reason to look, nothing here cancels or changes a subscription. Three flags, each with its reason:
 *
 *  - price_increase: the last charge is above the usual amount of the charges before it by at
 *    least PRICE_INCREASE_MIN_RATIO and PRICE_INCREASE_MIN_CENTS;
 *  - duplicate: two or more ACTIVE subscriptions fall in the same service category
 *    (SERVICE_CATEGORIES below: small, explicit, edit it by hand);
 *  - no_recent_use: ONLY when Screen Time data backs it. The subscription is matched to an app or
 *    site in the iPhone usage data and the time over the last 30 days is under LOW_USE_MINUTES.
 *    Where there is no usage signal the answer is "usage unknown", never a guess.
 *
 * Riley can dismiss a flag; a dismissal is stored under (subscription id, flag key). The key of a
 * price flag includes the new amount and the key of a duplicate flag includes the other
 * subscriptions, so a LATER increase or a NEW duplicate shows up again.
 */
import { formatDate, money } from "./procurement";
import { stableId, type DetectedSubscription } from "./procurement-recurring";

// ─── thresholds ──────────────────────────────────────────────────────────────────────────────
/** A price increase is flagged at 5% or more ... */
export const PRICE_INCREASE_MIN_RATIO = 0.05;
/** ... and at least 50 cents, so rounding and tax wobble on a small charge do not flag. */
export const PRICE_INCREASE_MIN_CENTS = 50;
/** Usage window, in days. */
export const USAGE_WINDOW_DAYS = 30;
/** "No recent use" needs Screen Time data on at least this many of those days. */
export const MIN_USAGE_DAYS = 20;
/** Under this many minutes in the window counts as zero or tiny use. */
export const LOW_USE_MINUTES = 10;

// ─── service categories (edit by hand) ───────────────────────────────────────────────────────
export interface ServiceEntry {
  name: string;
  /** Lowercase words; the merchant matches when one of its words starts with any of these. */
  match: string[];
  /** iPhone bundle-id prefixes (lowercase). Leave out for a service that is not used through an app. */
  apps?: string[];
  /** Web domains (the domain itself or any subdomain). */
  sites?: string[];
}
export interface ServiceCategory {
  id: string;
  label: string;
  services: ServiceEntry[];
}

/**
 * Well-known services by category. Two active subscriptions in one category raise the duplicate
 * flag; `apps` / `sites` say what to look for in Screen Time. To add a service, add a line. A
 * merchant that matches nothing here gets no duplicate flag and falls back to a name match for usage.
 */
export const SERVICE_CATEGORIES: readonly ServiceCategory[] = [
  {
    id: "video",
    label: "Video streaming",
    services: [
      { name: "Netflix", match: ["netflix"], apps: ["com.netflix."], sites: ["netflix.com"] },
      { name: "Hulu", match: ["hulu"], apps: ["com.hulu."], sites: ["hulu.com"] },
      { name: "Disney+", match: ["disney+", "disneyplus", "disney plus"], apps: ["com.disney.disneyplus"], sites: ["disneyplus.com"] },
      { name: "Max", match: ["hbo", "max.com"], apps: ["com.wbd.stream", "com.hbo."], sites: ["max.com", "hbomax.com"] },
      { name: "Paramount+", match: ["paramount+", "paramountplus", "paramount plus"], apps: ["com.cbsvideo.", "com.cbs."], sites: ["paramountplus.com"] },
      { name: "Peacock", match: ["peacock"], apps: ["com.peacocktv."], sites: ["peacocktv.com"] },
      { name: "YouTube", match: ["youtube"], apps: ["com.google.ios.youtube"], sites: ["youtube.com"] },
    ],
  },
  {
    id: "music",
    label: "Music streaming",
    services: [
      { name: "Spotify", match: ["spotify"], apps: ["com.spotify."], sites: ["spotify.com"] },
      { name: "Tidal", match: ["tidal"], apps: ["com.aspiro.tidal"], sites: ["tidal.com"] },
      { name: "Pandora", match: ["pandora"], apps: ["com.pandora"], sites: ["pandora.com"] },
      { name: "SiriusXM", match: ["sirius", "siriusxm"], apps: ["com.sirius"], sites: ["siriusxm.com"] },
      { name: "Amazon Music", match: ["amazon music"], apps: ["com.amazon.mp3."], sites: ["music.amazon.com"] },
    ],
  },
  {
    id: "ai",
    label: "AI assistants",
    services: [
      { name: "ChatGPT", match: ["openai", "chatgpt"], apps: ["com.openai."], sites: ["chatgpt.com", "openai.com"] },
      { name: "Claude", match: ["anthropic", "claude"], apps: ["com.anthropic."], sites: ["claude.ai"] },
      { name: "Perplexity", match: ["perplexity"], apps: ["ai.perplexity."], sites: ["perplexity.ai"] },
      { name: "Gemini", match: ["gemini"], apps: ["com.google.gemini"], sites: ["gemini.google.com"] },
    ],
  },
  {
    id: "storage",
    label: "Cloud storage",
    // Storage is not "used" through an app, so no apps / sites: usage stays unknown.
    services: [
      { name: "iCloud", match: ["icloud"] },
      { name: "Google One", match: ["google one"] },
      { name: "Dropbox", match: ["dropbox"] },
      { name: "OneDrive", match: ["onedrive"] },
    ],
  },
  {
    id: "news",
    label: "News",
    services: [
      { name: "The New York Times", match: ["nytimes", "ny times", "new york times"], apps: ["com.nytimes."], sites: ["nytimes.com"] },
      { name: "The Wall Street Journal", match: ["wsj", "wall street journal"], apps: ["com.dowjones."], sites: ["wsj.com"] },
      { name: "The Washington Post", match: ["washington post", "washpost"], apps: ["com.washingtonpost."], sites: ["washingtonpost.com"] },
      { name: "The Athletic", match: ["the athletic", "theathletic"], apps: ["com.theathletic."], sites: ["theathletic.com"] },
    ],
  },
  {
    id: "mindfulness",
    label: "Meditation and sleep",
    services: [
      { name: "Calm", match: ["calm.com", "calm "], apps: ["com.calm."], sites: ["calm.com"] },
      { name: "Headspace", match: ["headspace"], apps: ["com.getsomeheadspace."], sites: ["headspace.com"] },
    ],
  },
  {
    id: "language",
    label: "Language learning",
    services: [
      { name: "Duolingo", match: ["duolingo"], apps: ["com.duolingo."], sites: ["duolingo.com"] },
      { name: "Babbel", match: ["babbel"], apps: ["com.lesson-nine.", "com.babbel."], sites: ["babbel.com"] },
    ],
  },
  {
    id: "delivery",
    label: "Delivery memberships",
    services: [
      { name: "Uber One", match: ["uber one"] },
      { name: "DashPass", match: ["dashpass"] },
      { name: "Instacart+", match: ["instacart+", "instacart plus"] },
    ],
  },
];

export interface ServiceMatch {
  category: ServiceCategory;
  service: ServiceEntry;
}

/** Lowercase words of a merchant label: " openai chatgpt subscr " (padded so word starts are easy to test). */
function words(label: string): string {
  return ` ${label.toLowerCase().replace(/[^a-z0-9+.]+/g, " ").trim()} `;
}

/** The catalog entry a merchant belongs to, or null. A keyword matches at the start of a word. */
export function matchService(merchant: string, categories: readonly ServiceCategory[] = SERVICE_CATEGORIES): ServiceMatch | null {
  const text = words(merchant);
  for (const category of categories) {
    for (const service of category.services) {
      if (service.match.some((kw) => text.includes(` ${kw.toLowerCase()}`))) return { category, service };
    }
  }
  return null;
}

// ─── Screen Time usage ───────────────────────────────────────────────────────────────────────
export interface UsageItem {
  kind: "app" | "web";
  /** Bundle id or web domain, as stored. */
  identifier: string;
  minutes: number;
}
/** iPhone usage over the last USAGE_WINDOW_DAYS days, already summed per app / site. */
export interface UsageTotals {
  daysCovered: number;
  items: UsageItem[];
}
export type UsageNote =
  | { state: "known"; minutes: number; matched: string[]; basis: "service list" | "name match"; daysCovered: number }
  | { state: "unknown"; why: string };

/** Sum per (kind, identifier) rows into UsageTotals; rows that are not usable are skipped. */
export function sumUsage(rows: readonly unknown[], daysCovered: number): UsageTotals {
  const totals = new Map<string, UsageItem>();
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const kind = r.kind === "app" || r.kind === "web" ? r.kind : null;
    const identifier = typeof r.identifier === "string" ? r.identifier.trim() : "";
    const seconds = typeof r.seconds === "number" ? r.seconds : typeof r.seconds === "string" ? Number(r.seconds) : NaN;
    if (!kind || !identifier || !Number.isFinite(seconds) || seconds < 0) continue;
    const key = `${kind}|${identifier.toLowerCase()}`;
    const item = totals.get(key);
    if (item) item.minutes += seconds / 60;
    else totals.set(key, { kind, identifier, minutes: seconds / 60 });
  }
  return { daysCovered, items: [...totals.values()] };
}

/** Words too generic to tie a merchant to an app by name. */
const GENERIC_WORDS = new Set([
  "apple", "google", "amazon", "microsoft", "paypal", "stripe", "square", "store", "online", "payment", "payments",
  "premium", "subscription", "subscr", "member", "membership", "monthly", "annual", "yearly", "service", "services",
  "company", "limited", "digital", "media", "group", "global", "international", "mobile", "wireless", "health",
  "fitness", "music", "video", "cloud", "games", "studio", "studios", "labs", "software", "systems", "tech", "technologies",
  "bill", "billing", "recurring", "purchase", "inc", "llc", "corp", "www", "com", "http", "https",
]);
/** Bundle-id parts that say nothing about which app it is. */
const GENERIC_SEGMENTS = new Set(["com", "org", "net", "io", "co", "app", "apps", "ios", "iphone", "mobile", "client", "inc", "www"]);
const MIN_NAME_WORD = 5;

function siteMatches(identifier: string, site: string): boolean {
  const id = identifier.toLowerCase();
  return id === site || id.endsWith(`.${site}`);
}

/** How much one subscription was used on the iPhone, or why that is unknown. Never a guess. */
export function usageFor(merchant: string, service: ServiceEntry | null, usage: UsageTotals | null): UsageNote {
  if (!usage) return { state: "unknown", why: "Screen Time data is not available" };
  if (usage.daysCovered < MIN_USAGE_DAYS) {
    return { state: "unknown", why: `Screen Time covers only ${usage.daysCovered} of the last ${USAGE_WINDOW_DAYS} days` };
  }
  if (service) {
    const apps = service.apps ?? [];
    const sites = service.sites ?? [];
    if (apps.length === 0 && sites.length === 0) return { state: "unknown", why: "this kind of service is not used through an app" };
    const hits = usage.items.filter((i) =>
      i.kind === "app" ? apps.some((p) => i.identifier.toLowerCase().startsWith(p)) : sites.some((s) => siteMatches(i.identifier, s)),
    );
    return {
      state: "known",
      minutes: hits.reduce((sum, i) => sum + i.minutes, 0),
      matched: hits.map((i) => i.identifier).sort(),
      basis: "service list",
      daysCovered: usage.daysCovered,
    };
  }
  // Not in the service list: tie it to an app only when a distinctive word of the merchant IS a
  // part of a bundle id or domain that appears in the data. No such app: unknown.
  const names = words(merchant).trim().split(" ").filter((w) => w.length >= MIN_NAME_WORD && !GENERIC_WORDS.has(w));
  if (names.length === 0) return { state: "unknown", why: "the merchant name is too generic to match an app" };
  const hits = usage.items.filter((i) => {
    const parts = i.identifier.toLowerCase().split(/[.\-_]/).filter((p) => p && !GENERIC_SEGMENTS.has(p));
    return names.some((n) => parts.includes(n));
  });
  if (hits.length === 0) return { state: "unknown", why: "no app or site in Screen Time matches this merchant" };
  return {
    state: "known",
    minutes: hits.reduce((sum, i) => sum + i.minutes, 0),
    matched: hits.map((i) => i.identifier).sort(),
    basis: "name match",
    daysCovered: usage.daysCovered,
  };
}

/** "3 h 20 min" / "45 min" / "under a minute" / "no time". */
export function minutesLabel(minutes: number): string {
  if (minutes <= 0) return "no time";
  if (minutes < 1) return "under a minute";
  const whole = Math.round(minutes);
  const h = Math.floor(whole / 60);
  const m = whole % 60;
  return h === 0 ? `${m} min` : m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** One line for the page: what the usage data says about this subscription. */
export function usageLine(note: UsageNote): string {
  if (note.state === "unknown") return `iPhone use: unknown (${note.why}).`;
  const where = note.matched.length > 0 ? ` (${note.matched.join(", ")}${note.basis === "name match" ? ", matched by name" : ""})` : "";
  return `iPhone use, last ${USAGE_WINDOW_DAYS} days: ${minutesLabel(note.minutes)}${where}.`;
}

// ─── flags ───────────────────────────────────────────────────────────────────────────────────
export const FLAG_KINDS = ["price_increase", "duplicate", "no_recent_use"] as const;
export type FlagKind = (typeof FLAG_KINDS)[number];
export interface WasteFlag {
  /** `${kind}:${16 hex}`: what a dismissal is stored under. */
  key: string;
  kind: FlagKind;
  title: string;
  reason: string;
  dismissed: boolean;
}
export interface SubscriptionAdvice {
  subId: string;
  /** Catalog name and category, when the merchant is in SERVICE_CATEGORIES. */
  service: string | null;
  category: string | null;
  usage: UsageNote;
  flags: WasteFlag[];
}

/** What the page gets from the server (lib/procurement-flags-server.ts). */
export interface AdviceLoad {
  advice: SubscriptionAdvice[];
  /** Whether Screen Time data could be read at all (false: every usage line says unknown). */
  usageAvailable: boolean;
  /** Whether a dismissal can be saved (the dismissals table answered). */
  canDismiss: boolean;
}

const flagKey = (kind: FlagKind, signature: string): string => `${kind}:${stableId(`${kind}|${signature}`)}`;
export const dismissalKey = (subId: string, key: string): string => `${subId}|${key}`;

/** Price increase: the last charge against the usual amount of the charges before it. */
export function priceIncreaseFlag(sub: DetectedSubscription): Omit<WasteFlag, "dismissed"> | null {
  const before = sub.previousTypicalCents;
  if (before === null || before <= 0) return null;
  const rise = sub.lastCents - before;
  if (rise < PRICE_INCREASE_MIN_CENTS || rise < PRICE_INCREASE_MIN_RATIO * before) return null;
  const percent = Math.round((rise / before) * 100);
  return {
    key: flagKey("price_increase", String(sub.lastCents)),
    kind: "price_increase",
    title: "Price went up",
    reason:
      `The last charge, ${money(sub.lastCents)} on ${formatDate(sub.lastCharge)}, is ${percent}% above the usual ${money(before)} before it ` +
      `(flagged from ${Math.round(PRICE_INCREASE_MIN_RATIO * 100)}% and ${money(PRICE_INCREASE_MIN_CENTS)}).`,
  };
}

/**
 * Advice for every ACTIVE subscription (a lapsed one is no longer being paid for, so nothing to
 * flag). `dismissed` holds dismissalKey(subId, flagKey) of the flags Riley dismissed.
 */
export function buildAdvice(
  subs: readonly DetectedSubscription[],
  usage: UsageTotals | null,
  dismissed: ReadonlySet<string> = new Set(),
  categories: readonly ServiceCategory[] = SERVICE_CATEGORIES,
): SubscriptionAdvice[] {
  const active = subs.filter((s) => s.status === "active");
  const matches = new Map(active.map((s) => [s.id, matchService(s.merchant, categories)]));
  const byCategory = new Map<string, DetectedSubscription[]>();
  for (const s of active) {
    const m = matches.get(s.id);
    if (!m) continue;
    const list = byCategory.get(m.category.id);
    if (list) list.push(s);
    else byCategory.set(m.category.id, [s]);
  }
  return active.map((sub) => {
    const match = matches.get(sub.id) ?? null;
    const note = usageFor(sub.merchant, match?.service ?? null, usage);
    const flags: Omit<WasteFlag, "dismissed">[] = [];

    const price = priceIncreaseFlag(sub);
    if (price) flags.push(price);

    const others = match ? (byCategory.get(match.category.id) ?? []).filter((o) => o.id !== sub.id) : [];
    if (match && others.length > 0) {
      flags.push({
        key: flagKey("duplicate", `${match.category.id}|${others.map((o) => o.id).sort().join(",")}`),
        kind: "duplicate",
        title: "Possible duplicate",
        reason: `You also pay for ${others.map((o) => o.merchant).join(", ")} in the same category (${match.category.label}).`,
      });
    }

    if (note.state === "known" && note.minutes < LOW_USE_MINUTES) {
      const seen =
        note.matched.length > 0
          ? `${minutesLabel(note.minutes)} in ${note.matched.join(", ")}${note.basis === "name match" ? " (matched by name)" : ""}`
          : `no time in the ${match?.service.name ?? sub.merchant} app or site`;
      flags.push({
        key: flagKey("no_recent_use", "iphone"),
        kind: "no_recent_use",
        title: "No recent use on your iPhone",
        reason:
          `Screen Time shows ${seen} over the last ${USAGE_WINDOW_DAYS} days (${note.daysCovered} days of data; flagged under ${LOW_USE_MINUTES} minutes). ` +
          "Use on a computer or TV is not visible to Onyx.",
      });
    }

    return {
      subId: sub.id,
      service: match?.service.name ?? null,
      category: match?.category.label ?? null,
      usage: note,
      flags: flags.map((f) => ({ ...f, dismissed: dismissed.has(dismissalKey(sub.id, f.key)) })),
    };
  });
}

/** Flags still open (not dismissed) across all subscriptions. */
export function openFlagCount(advice: readonly SubscriptionAdvice[]): number {
  return advice.reduce((n, a) => n + a.flags.filter((f) => !f.dismissed).length, 0);
}

// ─── dismissing (PATCH /api/procurement/flags) ───────────────────────────────────────────────
export const MAX_FLAG_BODY_BYTES = 256;
const SUB_ID_RE = /^[0-9a-f]{16}$/;
const FLAG_KEY_RE = new RegExp(`^(${FLAG_KINDS.join("|")}):[0-9a-f]{16}$`);

export interface FlagMark {
  sub: string;
  flag: string;
  dismissed: boolean;
}

/** Validate the PATCH body: exactly {sub, flag, dismissed}; anything else is refused. */
export function parseFlagBody(body: unknown): { ok: true; mark: FlagMark } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body must be a JSON object" };
  const o = body as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => k !== "sub" && k !== "flag" && k !== "dismissed");
  if (extra.length > 0) return { ok: false, error: "unknown field" };
  if (typeof o.sub !== "string" || !SUB_ID_RE.test(o.sub)) return { ok: false, error: "invalid sub" };
  if (typeof o.flag !== "string" || !FLAG_KEY_RE.test(o.flag)) return { ok: false, error: "invalid flag" };
  if (typeof o.dismissed !== "boolean") return { ok: false, error: "dismissed must be true or false" };
  return { ok: true, mark: { sub: o.sub, flag: o.flag, dismissed: o.dismissed } };
}
