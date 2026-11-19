/**
 * Sign-in registry: every credential Onyx depends on, who renews it, and how its health is read.
 * Pure and import-free (the /status route, the /status page and the tests all load it). It holds
 * NO secret values, ids or accounts: only labels, mechanisms, dates and where Riley clicks.
 * Policy: docs/signins.md. Every new credential adds an entry in the same PR.
 */

export type SigninMechanism =
  | "no-auth"
  | "api-key"
  | "oauth-refresh"
  | "app-password"
  | "url-secret"
  | "headless-login"
  | "browser-session"
  | "signing-cert"
  | "scheduled-export";

export type SigninState = "ok" | "due_soon" | "needs_riley" | "unknown";

/** Where the hard expiry date comes from. "none" = only the heartbeats tell. */
export type ExpirySource =
  | { kind: "none" }
  /** Last day to renew, fixed in the registry (a certificate, a yearly subscription). */
  | { kind: "fixed"; date: string }
  /** Computed by /api/status from a timestamp it already reads (key into facts.expiry). */
  | { kind: "derived"; key: string };

export interface SigninEntry {
  id: string;
  label: string;
  mechanism: SigninMechanism;
  /** "self" renews without Riley; "riley" needs him. */
  renewal: "self" | "riley";
  /** One short sentence: how Riley renews it (or what to do when a self-renewing chain breaks). */
  howTo: string;
  /** In-app page to start from, when there is one. */
  link?: string;
  /** Plain-words lifetime rule. */
  lifetime: string;
  /** Keys of `sources` in /api/status whose card status reflects this credential's health. */
  sources: string[];
  expiry: ExpirySource;
  /** false = built but not connected yet: shown as unknown, never counted or listed. */
  live?: boolean;
}

export const DUE_SOON_DAYS = 21;
export const MONTHLY_WINDOW_DAYS = 45;

export const SIGNIN_REGISTRY: SigninEntry[] = [
  {
    id: "spotify", label: "Spotify", mechanism: "oauth-refresh", renewal: "riley",
    howTo: "/status Spotify card, Reconnect, paste the callback address.", link: "/status",
    lifetime: "Refresh token dies 180 days after the sign-in; a refresh does not extend it.",
    sources: ["spotify"], expiry: { kind: "derived", key: "spotify" },
  },
  {
    id: "kindle-amazon", label: "Kindle / Amazon session", mechanism: "browser-session", renewal: "riley",
    howTo: "On the PC: node tools/kindle_harvest/harvest.mjs --login, then close the window.",
    lifetime: "Amazon ends the browser session at times of its choosing.",
    sources: ["kindle", "amazon_orders"], expiry: { kind: "none" },
  },
  {
    id: "ubereats", label: "Uber Eats session", mechanism: "browser-session", renewal: "riley",
    howTo: "On the PC: sign in again in a plain Chrome window on the harvester profile (QR code), then close it.",
    lifetime: "Uber ends the browser session at times of its choosing.",
    sources: ["ubereats"], expiry: { kind: "none" },
  },
  {
    id: "rewards-sites", label: "Rewards sites (Amex, Delta, Hilton, Marriott, Uber)", mechanism: "browser-session", renewal: "riley",
    howTo: "On the PC: node tools/rewards_harvest/harvest.mjs --login <program>, sign in, close the window (README lists the five).",
    lifetime: "Each site ends the browser session at times of its choosing.",
    sources: ["rewards"], expiry: { kind: "none" },
  },
  {
    id: "gmail-imap", label: "Gmail app passwords (both accounts)", mechanism: "app-password", renewal: "riley",
    howTo: "Google account, Security, App passwords: make a new one and update the GitHub secret.",
    lifetime: "No expiry; revoked when the Google password changes or 2-Step Verification is turned off.",
    sources: ["flights", "delivery", "online_orders", "urgent_email"], expiry: { kind: "none" },
  },
  {
    id: "simplefin", label: "SimpleFIN Bridge", mechanism: "url-secret", renewal: "riley",
    howTo: "Renew the yearly subscription on the SimpleFIN site; after a lapse make a new setup token and run simplefin_etl.py --claim --set-github-secret.",
    lifetime: "Yearly subscription (about November 14); banks may also need reconnecting on the SimpleFIN site.",
    sources: ["simplefin"], expiry: { kind: "fixed", date: "2027-11-14" },
  },
  {
    id: "apple-signing", label: "Apple signing certificate + profiles", mechanism: "signing-cert", renewal: "riley",
    howTo: "Renew the certificate and profiles per tools/screentime_ios/README.md, then rebuild.",
    lifetime: "Expires 2027-11-10; the iPhone apps stop opening after that.",
    sources: [], expiry: { kind: "fixed", date: "2027-11-10" },
  },
  {
    id: "youtube-takeout", label: "YouTube Takeout schedule", mechanism: "scheduled-export", renewal: "riley",
    howTo: "Create a new scheduled Takeout (history only, JSON, every 2 months) per docs/youtube-watch-history.md.",
    lifetime: "Google ends the schedule one year after it was created.",
    sources: ["youtube"], expiry: { kind: "none" },
  },
  {
    id: "google-calendar-ics", label: "Google Calendar secret addresses", mechanism: "url-secret", renewal: "riley",
    howTo: "Calendar settings, Integrate calendar: copy the new secret address into the GOOGLE_CALENDAR_ICS_SECRET secret.",
    lifetime: "No expiry; stops (HTTP 404) only if the address is reset.",
    sources: ["google_calendar"], expiry: { kind: "none" },
  },
  {
    id: "care-calendar", label: "Google Calendar (care items)", mechanism: "oauth-refresh", renewal: "riley", live: false,
    howTo: "Follow docs/health-google-calendar.md steps 1 to 3. Not connected yet.", link: "/health",
    lifetime: "Refresh token; Google may revoke it after long disuse.",
    sources: ["care_calendar"], expiry: { kind: "none" },
  },
  {
    id: "whoop", label: "WHOOP", mechanism: "oauth-refresh", renewal: "self",
    howTo: "If it fails: python whoop_etl.py --auth, then ci_token_helper.py upload whoop.",
    lifetime: "Refresh chain renews itself every run; WHOOP rarely invalidates it.",
    sources: ["whoop"], expiry: { kind: "none" },
  },
  {
    id: "garmin", label: "Garmin", mechanism: "oauth-refresh", renewal: "self",
    howTo: "If it fails: run garmin_etl.py locally, then ci_token_helper.py upload garmin.",
    lifetime: "Token chain renews itself every run.",
    sources: ["garmin"], expiry: { kind: "none" },
  },
  {
    id: "tanita", label: "Tanita Health Planet", mechanism: "oauth-refresh", renewal: "self",
    howTo: "If it fails: python tanita_etl.py --auth, then ci_token_helper.py upload tanita.",
    lifetime: "30-day access token, refreshed inside its last 7 days.",
    sources: ["tanita"], expiry: { kind: "none" },
  },
  {
    id: "eight-sleep", label: "Eight Sleep", mechanism: "headless-login", renewal: "self",
    howTo: "If it fails: check the EIGHTSLEEP_* secrets.",
    lifetime: "Logs in with email and password each run.",
    sources: ["eight_sleep"], expiry: { kind: "none" },
  },
  {
    id: "cronometer", label: "Cronometer", mechanism: "headless-login", renewal: "self",
    howTo: "If it fails: python cronometer_etl.py --auth, then ci_token_helper.py upload cronometer.",
    lifetime: "Saved session reused; a fresh login happens when it lapses.",
    sources: ["cronometer"], expiry: { kind: "none" },
  },
  {
    id: "notion", label: "Notion integration key", mechanism: "api-key", renewal: "self",
    howTo: "If it fails: share the database with the integration again, or rotate the key.",
    lifetime: "No expiry.",
    sources: ["notion_journal"], expiry: { kind: "none" },
  },
  {
    id: "open-data", label: "Open-Meteo + Atlanta Allergy (air, weather, pollen)", mechanism: "no-auth", renewal: "self",
    howTo: "Nothing to renew.",
    lifetime: "No credential.",
    sources: ["air_quality", "weather", "pollen"], expiry: { kind: "none" },
  },
];

// ---------------------------------------------------------------------------------- state

export interface SigninFacts {
  /** `sources[key].status` from /api/status ("success" | "partial" | "failed" | "unknown"). */
  sourceStatus: Record<string, string | undefined>;
  /** Derived expiry dates (YYYY-MM-DD, last day to renew) by ExpirySource.derived key. */
  expiry: Record<string, string | null | undefined>;
}

const DAY_MS = 86_400_000;

/** Today's calendar day in America/New_York as YYYY-MM-DD. */
export function etToday(nowMs: number): string {
  return new Date(nowMs).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function utcDay(ymd: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
}

/** Whole days from today (ET) to `ymd`; negative once the date has passed. NaN for a bad date. */
export function daysUntil(ymd: string, nowMs: number): number {
  return Math.round((utcDay(ymd) - utcDay(etToday(nowMs))) / DAY_MS);
}

/** The last day to renew, or null when no date is known. */
export function renewByDate(entry: SigninEntry, facts: SigninFacts): string | null {
  if (entry.expiry.kind === "fixed") return entry.expiry.date;
  if (entry.expiry.kind === "derived") return facts.expiry[entry.expiry.key] ?? null;
  return null;
}

const RANK: Record<SigninState, number> = { unknown: 0, ok: 1, due_soon: 2, needs_riley: 3 };

export function signinState(entry: SigninEntry, facts: SigninFacts, nowMs: number): SigninState {
  if (entry.live === false) return "unknown";
  if (entry.mechanism === "no-auth") return "ok";
  let state: SigninState = "unknown";
  const raise = (s: SigninState) => { if (RANK[s] > RANK[state]) state = s; };

  const by = renewByDate(entry, facts);
  let dated = false;
  if (by !== null) {
    const d = daysUntil(by, nowMs);
    if (Number.isFinite(d)) {
      dated = true;
      raise(d < 0 ? "needs_riley" : d <= DUE_SOON_DAYS ? "due_soon" : "ok");
    }
  }

  let seen = false;
  for (const key of entry.sources) {
    const s = facts.sourceStatus[key];
    if (s === undefined || s === "unknown") continue;
    seen = true;
    if (s === "failed") raise(entry.renewal === "riley" ? "needs_riley" : "due_soon");
    else if (s === "partial") raise(entry.renewal === "riley" ? "due_soon" : "ok");
    else raise("ok");
  }
  // Nothing readable at all (no date, no heartbeat) stays unknown.
  if (!seen && !dated) return "unknown";
  return state;
}

export interface SigninChecklistItem {
  id: string;
  label: string;
  howTo: string;
  link?: string;
  renewBy: string | null;
  state: SigninState;
}

export interface SigninChecklist {
  windowDays: number;
  items: SigninChecklistItem[];
}

/**
 * The one monthly list: Riley-renewed credentials that need him now, or whose date falls within
 * 45 days. Sorted by date (overdue and dateless first), then label.
 */
export function monthlyRenewals(entries: SigninEntry[], facts: SigninFacts, nowMs: number): SigninChecklist {
  return checklistFromStatuses(entries, signinStatuses(entries, facts, nowMs), nowMs);
}

/** Same list, from the statuses /api/status already returned (the page has no facts of its own). */
export function checklistFromStatuses(entries: SigninEntry[], statuses: SigninStatus[], nowMs: number): SigninChecklist {
  const byId = new Map(statuses.map((s) => [s.id, s]));
  const items: SigninChecklistItem[] = [];
  for (const e of entries) {
    if (e.renewal !== "riley" || e.live === false) continue;
    const st = byId.get(e.id);
    if (!st) continue;
    const inWindow = st.renewBy !== null && daysUntil(st.renewBy, nowMs) <= MONTHLY_WINDOW_DAYS;
    if (st.state === "needs_riley" || st.state === "due_soon" || inWindow) {
      items.push({ id: e.id, label: e.label, howTo: e.howTo, link: e.link, renewBy: st.renewBy, state: st.state });
    }
  }
  items.sort((a, b) => {
    const da = a.renewBy ?? "0000-00-00";
    const db = b.renewBy ?? "0000-00-00";
    return da === db ? a.label.localeCompare(b.label) : da < db ? -1 : 1;
  });
  return { windowDays: MONTHLY_WINDOW_DAYS, items };
}

/** What /api/status returns per entry: no token, id or account. */
export interface SigninStatus {
  id: string;
  label: string;
  state: SigninState;
  renewBy: string | null;
}

export function signinStatuses(entries: SigninEntry[], facts: SigninFacts, nowMs: number): SigninStatus[] {
  return entries.map((e) => ({
    id: e.id,
    label: e.label,
    state: signinState(e, facts, nowMs),
    renewBy: renewByDate(e, facts),
  }));
}
