// Urgent-email rules for the Today page.
//
// What is urgent is decided by inbox-triage (personal-agents): its Gmail labels
// Agent/Action and Agent/Deadline, and its "Urgent: ..." Agent Inbox questions. This file
// adds what Today needs on top: the deadline a subject/snippet names (daysUntilDeadline),
// a few plain-words reasons (assessEmail's keyword rules), Gmail links, and the merge of
// the two sources into one deduplicated list (mergeUrgent).
//
// Deterministic and offline: no model calls, no network, no imports, so it runs unchanged
// in the browser, in the API route, in frontend/scripts/test-urgent-email.mjs (Node strips
// the type annotations) and in tests/today-regression.cjs. Keep this file to erasable
// TypeScript (no enums, no parameter properties) and import-free for that reason.
//
// Scope: email only. Text-message ingestion stays disabled; nothing here reads or models it.

export interface EmailForUrgency {
  id: string;
  fromName: string | null;
  fromAddress: string;
  subject: string;
  snippet: string | null;
  /** ISO 8601 instant the message arrived. */
  receivedAt: string;
  isUnread: boolean;
}

export interface UrgencyAssessment {
  urgent: boolean;
  score: number;
  /** Plain-words reasons, strongest first, at most MAX_REASONS. */
  reasons: string[];
}

export interface RankedEmail {
  email: EmailForUrgency;
  score: number;
  reasons: string[];
}

export interface UrgentSelection {
  /** Unread messages inside the window that were actually assessed. */
  scanned: number;
  /** How many of them look urgent (can exceed items.length). */
  total: number;
  /** The top `limit` urgent messages, best first. */
  items: RankedEmail[];
}

/** A message is urgent at or above this score. One strong phrase (3) qualifies; one medium (2) does not. */
export const URGENT_THRESHOLD = 3;
/** Today shows at most this many urgent emails. */
export const MAX_URGENT_SHOWN = 5;
/** Only mail received in the last this-many days is considered. */
export const WINDOW_DAYS = 7;
/** Reasons listed per email. */
export const MAX_REASONS = 3;
/** Keyword points are capped so a stuffed subject cannot outrank a real deadline. */
const CONTENT_POINTS_CAP = 6;
const DAY_MS = 86_400_000;
/** Mail dated further ahead than this is treated as junk, not as "just arrived". */
export const FUTURE_SKEW_MS = DAY_MS;

/**
 * Domains whose mail always counts for a little more (+2). Empty on purpose: add the
 * bank, employer or landlord domains here. Subdomains match (mail.example.com matches
 * example.com); lookalikes (evilexample.com) do not.
 */
export const PRIORITY_SENDER_DOMAINS: readonly string[] = [];

interface PhraseRule {
  reason: string;
  points: number;
  pattern: RegExp;
  /** A hit here is never overridden by the promotional veto (real alerts that happen to name a shop or deal). */
  keepsPastPromoVeto?: boolean;
}

// Strong (3): the sender is saying something is wrong or must happen now.
// Medium (2): time pressure or a request with a date. Weak (1): generic emphasis.
const PHRASE_RULES: readonly PhraseRule[] = [
  { reason: "marked urgent or action required", points: 3,
    pattern: /\b(urgent|urgently|immediate action|action (?:is )?(?:required|needed)|response (?:is )?(?:required|needed))\b/i },
  { reason: "overdue or final notice", points: 3,
    pattern: /\b(?:final|last|second|third) (?:notice|reminder|warning)\b|\bpast due\b|\boverdue\b|\bdelinquent\b/i },
  { reason: "payment problem", points: 3, keepsPastPromoVeto: true,
    pattern: /\b(?:payment|charge)(?: to [^,.:;!?\n]{1,60}?)?\s+(?:(?:has|have|had|was|is) (?:been )?)?(?:failed|declined|unsuccessful|rejected|returned|could not be processed|couldn't be processed|did not go through|didn't go through)\b|\b(?:failed|declined|returned) payment\b|\bpayment failure\b|\bcard (?:was )?declined\b|\bunable to (?:process|charge) your (?:payment|card)\b/i },
  { reason: "rent or loan payment due", points: 3,
    pattern: /\b(?:rent|mortgage|tuition|property tax(?:es)?|loan payment|car payment|insurance premium)(?: payment)?\s+(?:is\s+|are\s+)?(?:now\s+|almost\s+)?(?:due|late|overdue)\b|\b(?:late|overdue)\s+(?:rent|mortgage|tuition|loan payment)\b/i },
  { reason: "security or fraud alert", points: 3, keepsPastPromoVeto: true,
    pattern: /\b(?:unauthorized|suspicious|unusual) (?:activity|sign-?in|log-?in|charge|transaction|access)\b|\bfraud(?:ulent)?\b|\bsecurity alert\b|\baccount (?:has been |was )?(?:compromised|hacked)\b/i },
  { reason: "account at risk", points: 3, keepsPastPromoVeto: true,
    pattern: /\baccount (?:has been |was |is |will be )?(?:suspended|locked|disabled|deactivated|terminated)\b/i },
  { reason: "service about to end", points: 3,
    pattern: /\b(?:will be|about to be|at risk of being) (?:cancell?ed|terminated|shut off|disconnected|suspended)\b|\bwill lapse\b/i },
  { reason: "time-sensitive", points: 2,
    pattern: /\b(?:time[- ]sensitive|asap|as soon as possible)\b/i },
  { reason: "due or expiring soon", points: 2,
    pattern: /\b(?:due|expires?|expiring|closes|ends)\s+(?:today|tonight|tomorrow|soon|this week|by (?:end of day|eod|noon|midnight|close of business|cob))\b|\bdeadline\b/i },
  { reason: "asks for a reply by a date", points: 2,
    pattern: /\b(?:respond|reply|confirm|sign|review|approve)\s+(?:by|before|within)\b/i },
  { reason: "payment due", points: 2,
    pattern: /\b(?:invoice|payment|bill|statement)\s+(?:is\s+)?(?:due|outstanding|pending)\b/i },
  { reason: "asks you to verify or confirm", points: 2,
    pattern: /\b(?:verify|confirm|update) your (?:account|identity|payment|billing|information|details)\b/i },
  { reason: "marked important", points: 1,
    pattern: /\b(?:important|reminder|required)\b/i },
];

// Promotional mail is never urgent: a match is a hard veto, whatever else the message says,
// EXCEPT when a payment-problem, security/fraud or account-at-risk phrase also matched
// (keepsPastPromoVeto): "Suspicious charge at Big Sale Outlet" must still surface.
// Checked against the subject and sender only, so a marketing footer in a body snippet
// cannot bury a real alert. Deliberately narrow words ("deals", not "deal"; named sales,
// not "sale") so ordinary business mail ("bill of sale due tomorrow") is not swallowed.
const PROMO_SUBJECT = /\b(?:\d{1,3}% off|(?:flash|big|annual|summer|winter|holiday|clearance|weekend) sale|sale (?:ends|starts)|on sale|coupons?|promo(?:tion|code)?|deals|discounts?|free shipping|newsletter|limited[- ]time offer|exclusive offer|webinar|weekly digest|daily digest|sweepstakes|giveaway|save up to|shop now)\b/i;
const PROMO_SENDER = /^(?:newsletter|news|marketing|promo|promos|promotions|offers|deals|digest|mailer)\b/i;
const SECURITY_SENDER = /^(?:security|fraud|billing|payments?|alerts?|accounts?|invoices?|collections|account-security)\b/i;

export function senderDomain(address: string): string {
  const at = address.lastIndexOf("@");
  return at < 0 ? "" : address.slice(at + 1).trim().toLowerCase();
}

function senderLocalPart(address: string): string {
  const at = address.lastIndexOf("@");
  return (at < 0 ? address : address.slice(0, at)).trim().toLowerCase();
}

export function domainMatches(domain: string, listed: string): boolean {
  const d = domain.toLowerCase();
  const l = listed.toLowerCase().replace(/^\.+/, "");
  return l !== "" && (d === l || d.endsWith(`.${l}`));
}

// ---- Deadlines ---------------------------------------------------------------------
// Day arithmetic is done on Eastern calendar days (Riley's day), never on raw 24 h spans.

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3, may: 4,
  jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8,
  oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};
const WEEKDAYS: Record<string, number> = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};
const MONTH_NAMES = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
const CUE = "(?:due|by|before|until|expires?|expiring|deadline|closes|ends|on or before)";
const DEADLINE_ABSOLUTE = new RegExp(
  `\\b${CUE}\\s+(?:on\\s+)?(?:(?:${Object.keys(WEEKDAYS).join("|")}),?\\s+)?(?:(${MONTH_NAMES})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?|(\\d{1,2})/(\\d{1,2})(?:/(\\d{2,4}))?)\\b`, "gi");
const DEADLINE_WEEKDAY = new RegExp(`\\b${CUE}\\s+(?:on\\s+)?(?:this\\s+|next\\s+)?(${Object.keys(WEEKDAYS).join("|")})\\b`, "gi");
const DEADLINE_RELATIVE_DAY = new RegExp(`\\b${CUE}\\s+(today|tonight|tomorrow)\\b`, "gi");
const DEADLINE_IN_SPAN = /\b(?:(?:due|expires?|expiring|ends|closes)\s+in|within)\s+(\d{1,3})\s+(hour|day)s?\b/gi;

const ET_PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric", weekday: "short",
});
const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

interface EtDay { year: number; month: number; day: number; weekday: number }

function etDay(instant: Date): EtDay {
  const parts = ET_PARTS.formatToParts(instant);
  const pick = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    year: Number(pick("year")), month: Number(pick("month")) - 1, day: Number(pick("day")),
    weekday: Math.max(0, WEEKDAY_SHORT.indexOf(pick("weekday"))),
  };
}

/** Whole-day index of a calendar date (timezone free). */
function dayIndex(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month, day) / DAY_MS);
}

function validDate(year: number, month: number, day: number): boolean {
  const d = new Date(Date.UTC(year, month, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month && d.getUTCDate() === day;
}

/** Resolve a month/day with no year to the occurrence nearest the received day (rolls into next year near year end). */
function resolveYear(month: number, day: number, received: EtDay, explicitYear: number | null): number | null {
  if (explicitYear !== null) return validDate(explicitYear, month, day) ? explicitYear : null;
  for (const year of [received.year, received.year + 1]) {
    if (!validDate(year, month, day)) continue;
    if (dayIndex(year, month, day) >= dayIndex(received.year, received.month, received.day) - 30) return year;
  }
  return null;
}

/**
 * Whole Eastern days from `now` to the earliest deadline the text names, or null.
 * Relative phrases ("due tomorrow") are anchored to when the email was RECEIVED, so a
 * week-old "due tomorrow" is correctly in the past. Negative results mean already passed.
 */
export function daysUntilDeadline(text: string, receivedAt: Date, now: Date): number | null {
  const received = etDay(receivedAt);
  const receivedIdx = dayIndex(received.year, received.month, received.day);
  const nowDay = etDay(now);
  const nowIdx = dayIndex(nowDay.year, nowDay.month, nowDay.day);
  const found: number[] = [];

  for (const m of text.matchAll(DEADLINE_RELATIVE_DAY)) {
    found.push(receivedIdx + (m[1].toLowerCase() === "tomorrow" ? 1 : 0));
  }
  for (const m of text.matchAll(DEADLINE_IN_SPAN)) {
    const n = Number(m[1]);
    const end = new Date(receivedAt.getTime() + n * (m[2].toLowerCase() === "hour" ? 3_600_000 : DAY_MS));
    const d = etDay(end);
    found.push(dayIndex(d.year, d.month, d.day));
  }
  for (const m of text.matchAll(DEADLINE_WEEKDAY)) {
    const target = WEEKDAYS[m[1].toLowerCase()];
    found.push(receivedIdx + ((target - received.weekday + 7) % 7));
  }
  for (const m of text.matchAll(DEADLINE_ABSOLUTE)) {
    let month: number; let day: number; let year: number | null;
    if (m[1]) {
      month = MONTHS[m[1].toLowerCase()]; day = Number(m[2]); year = m[3] ? Number(m[3]) : null;
    } else {
      month = Number(m[4]) - 1; day = Number(m[5]);
      year = m[6] ? (m[6].length === 2 ? 2000 + Number(m[6]) : Number(m[6])) : null;
      if (month < 0 || month > 11) continue;
    }
    const resolved = resolveYear(month, day, received, year);
    if (resolved !== null) found.push(dayIndex(resolved, month, day));
  }
  if (found.length === 0) return null;
  // Earliest deadline that has not passed; if all have passed, the latest of them.
  const upcoming = found.map((i) => i - nowIdx).filter((d) => d >= 0);
  return upcoming.length > 0 ? Math.min(...upcoming) : Math.max(...found) - nowIdx;
}

// ---- Scoring -----------------------------------------------------------------------

/** Score one email. Pure: the same email and `now` always give the same answer. */
export function assessEmail(email: EmailForUrgency, now: Date): UrgencyAssessment {
  const received = new Date(email.receivedAt);
  const text = `${email.subject} ${email.snippet ?? ""}`;
  const hits: { reason: string; points: number }[] = [];

  let content = 0;
  let keepsPastPromoVeto = false;
  for (const rule of PHRASE_RULES) {
    if (rule.pattern.test(text)) {
      content += rule.points;
      hits.push({ reason: rule.reason, points: rule.points });
      if (rule.keepsPastPromoVeto) keepsPastPromoVeto = true;
    }
  }
  let score = Math.min(content, CONTENT_POINTS_CAP);

  if (!Number.isNaN(received.getTime())) {
    const days = daysUntilDeadline(text, received, now);
    if (days !== null && days >= 0 && days <= 1) {
      const points = 3;
      score += points;
      hits.push({ reason: days === 0 ? "deadline today" : "deadline tomorrow", points });
    } else if (days !== null && days >= 2 && days <= 7) {
      score += 1;
      hits.push({ reason: `deadline in ${days} days`, points: 1 });
    }
  }

  const domain = senderDomain(email.fromAddress);
  if (domain && PRIORITY_SENDER_DOMAINS.some((d) => domainMatches(domain, d))) {
    score += 2;
    hits.push({ reason: "from a priority sender", points: 2 });
  } else if (SECURITY_SENDER.test(senderLocalPart(email.fromAddress))) {
    score += 1;
    hits.push({ reason: "from a billing or security address", points: 1 });
  }

  if (!keepsPastPromoVeto && (PROMO_SUBJECT.test(email.subject) || PROMO_SENDER.test(senderLocalPart(email.fromAddress)))) {
    score = Math.min(score, URGENT_THRESHOLD - 1);
  }

  const reasons = hits.sort((a, b) => b.points - a.points).map((h) => h.reason).slice(0, MAX_REASONS);
  return { urgent: score >= URGENT_THRESHOLD, score, reasons };
}

/**
 * Pick the urgent emails to show. Only unread mail inside the window is considered
 * (read mail is already handled), future-dated or malformed rows are ignored, and the
 * result is bounded to `limit`. Best score first, newest first on ties.
 */
export function selectUrgent(
  emails: readonly EmailForUrgency[],
  now: Date,
  limit: number = MAX_URGENT_SHOWN,
): UrgentSelection {
  const earliest = now.getTime() - WINDOW_DAYS * DAY_MS;
  const latest = now.getTime() + FUTURE_SKEW_MS; // tolerate small clock skew, drop obviously future rows
  const ranked: RankedEmail[] = [];
  let scanned = 0;
  for (const email of emails) {
    const at = new Date(email.receivedAt).getTime();
    if (!email.isUnread || Number.isNaN(at) || at < earliest || at > latest) continue;
    scanned++;
    const result = assessEmail(email, now);
    if (result.urgent) ranked.push({ email, score: result.score, reasons: result.reasons });
  }
  ranked.sort((a, b) =>
    b.score - a.score ||
    new Date(b.email.receivedAt).getTime() - new Date(a.email.receivedAt).getTime() ||
    (a.email.id < b.email.id ? -1 : a.email.id > b.email.id ? 1 : 0));
  return { scanned, total: ranked.length, items: ranked.slice(0, Math.max(0, limit)) };
}

/**
 * Link to the message in Gmail. Search by RFC 5322 Message-ID so it works for archived
 * mail and needs no Gmail API. Only ever builds a mail.google.com URL; returns null when
 * there is no usable Message-ID.
 */
export function gmailMessageHref(account: string | null | undefined, messageId: string): string | null {
  const id = messageId.trim().replace(/^<|>$/g, "");
  if (!id || id.length > 500 || /[\s<>]/.test(id)) return null;
  const query = `#search/${encodeURIComponent(`rfc822msgid:${id}`)}`;
  const acct = (account ?? "").trim();
  const authuser = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(acct) ? encodeURIComponent(acct) : "0";
  return `https://mail.google.com/mail/?authuser=${authuser}${query}`;
}

/**
 * Link to a Gmail thread by its decimal thread id (IMAP X-GM-THRID), the same
 * `#all/thread-f:<n>` form Gmail's own links and inbox-triage's Agent Inbox rows use.
 */
export function gmailThreadHref(account: string | null | undefined, threadId: string | null | undefined): string | null {
  const id = (threadId ?? "").trim();
  if (!/^\d{1,20}$/.test(id)) return null;
  const acct = (account ?? "").trim();
  const authuser = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(acct) ? encodeURIComponent(acct) : "0";
  return `https://mail.google.com/mail/?authuser=${authuser}#all/thread-f:${id}`;
}

/** "Thu, Nov 12": the Eastern calendar day `days` after the Eastern day of `now`. */
export function etDayLabel(now: Date, days: number): string {
  const today = etDay(now);
  return new Date(Date.UTC(today.year, today.month, today.day + days, 12)).toLocaleDateString("en-US", {
    timeZone: "UTC", weekday: "short", month: "short", day: "numeric",
  });
}

export function isGmailHref(href: string): boolean {
  return href.startsWith("https://mail.google.com/mail/");
}

// ---- Today: one list from the email labels and the Agent Inbox ---------------------
// inbox-triage reports urgent mail two ways: it labels the thread (Agent/Action,
// Agent/Deadline; read by urgent_email_etl.py into GET /api/urgent-email) and, for the
// rare same-day items, it posts an Agent Inbox question named "Urgent: <what>" whose
// Link is the Gmail thread (/onyx/inbox card, already fetched by Today). The same
// thread can arrive both ways, so Today merges them here and shows it once.

/** The part of an /onyx/inbox card (lib/agents-api.ts) this file reads. */
export interface InboxCardLike {
  thread: string;
  messageId: number;
  created_at: string;
  card: { code: string; agent: string; name: string; link?: string | null };
}

/** The part of a GET /api/urgent-email item (lib/urgent-email-query.ts) this file reads. */
export interface EmailItemLike {
  key: string;
  threadId: string | null;
  messageId: string;
  account: string;
  from: string;
  subject: string;
  receivedAt: string;
  labels: readonly string[];
  deadline: { daysLeft: number; label: string } | null;
  reasons: string[];
  nextStep: string;
  href: string | null;
}

export interface TodayUrgentItem {
  key: string;
  /** Where Today learned about it: "Gmail", "Agent Inbox", or both. */
  sources: ("Gmail" | "Agent Inbox")[];
  /** e.g. "Gmail, owner@: Agent/Deadline" or "Agent Inbox: inbox-triage". */
  sourceDetail: string;
  title: string;
  from: string | null;
  reasons: string[];
  nextStep: string;
  /** Item age anchor: when the email arrived, or when the agent posted the request. */
  at: string;
  atVerb: "Received" | "Posted";
  gmailHref: string | null;
  requestHref: string | null;
}

const URGENT_PREFIX = /^\s*urgent\s*:\s*/i;

/** Decimal Gmail thread id from a hex id (the Gmail API / old web-link form). */
function hexToDecimal(hex: string): string {
  let digits = [0];
  for (const ch of hex.toLowerCase()) {
    let carry = parseInt(ch, 16);
    for (let i = 0; i < digits.length; i++) {
      const v = digits[i] * 16 + carry;
      digits[i] = v % 10;
      carry = Math.floor(v / 10);
    }
    while (carry > 0) { digits.push(carry % 10); carry = Math.floor(carry / 10); }
  }
  digits = digits.reverse();
  return digits.join("");
}

/**
 * Account and decimal thread id named by a Gmail web link, e.g.
 * `https://mail.google.com/mail/?authuser=me@example.com#all/thread-f:1234` or `#inbox/18c2...`.
 * A `#search/...` link names no thread (threadId null). Anything not on mail.google.com → null.
 */
export function parseGmailLink(link: string | null | undefined): { account: string | null; threadId: string | null } | null {
  if (!link || !isGmailHref(link)) return null;
  let url: URL;
  try { url = new URL(link); } catch { return null; }
  if (url.origin !== "https://mail.google.com") return null;
  const user = (url.searchParams.get("authuser") ?? "").trim().toLowerCase();
  const account = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(user) ? user : null;
  let hash = url.hash;
  try { hash = decodeURIComponent(hash); } catch { /* keep raw */ }
  const decimal = hash.match(/thread-f:(\d{1,20})\b/);
  if (decimal) return { account, threadId: decimal[1] };
  const hex = hash.match(/^#(?:all|inbox|starred|imp|sent|label\/[^/]+)\/([0-9a-f]{16})$/i);
  return { account, threadId: hex ? hexToDecimal(hex[1]) : null };
}

/** One term of a Gmail search, reduced to what Today can check: the subject and the sender. */
export interface GmailSearchTerm {
  /** `subject:` → the subject; `from:` → the sender; a plain word or phrase → either. */
  field: "any" | "subject" | "from";
  /** Lowercase whole words. More than one = a quoted phrase: they must sit next to each other, in this order. */
  words: string[];
  /** A leading "-": an email holding these words there is NOT a match. */
  negated: boolean;
}

// -?  then  op:"phrase" | op:(words) | op:word | "phrase" | word
const SEARCH_TERM = /(-)?(?:([A-Za-z][A-Za-z0-9_]*):(?:"([^"]*)"?|\(([^)]*)\)?|([^\s"]*))|"([^"]*)"?|([^\s"]+))/g;

/** Lowercase whole words in order, punctuation stripped. */
function wordList(s: string): string[] {
  return s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * The terms of a Gmail `#search/...` link (+ and %20 both separate words). Any other link → null.
 * Handled: plain words, "quoted phrases", `subject:` and `from:` (with a word, a "phrase" or a
 * (group of words)), and a leading "-" on any of those. Ignored, value included: every other
 * operator (`newer_than:`, `label:`, `in:`, `is:`, `has:`, `to:`, `rfc822msgid:` ...), since it
 * says nothing about the subject or sender. Not understood: `OR` / `AND` / `{ }` / `( )` grouping —
 * the operator words are dropped and every remaining word stays required, which is stricter than
 * Gmail and so can only miss a merge, never invent one.
 */
export function gmailSearchTerms(link: string | null | undefined): GmailSearchTerm[] | null {
  if (!link || !isGmailHref(link)) return null;
  let url: URL;
  try { url = new URL(link); } catch { return null; }
  if (url.origin !== "https://mail.google.com") return null;
  let hash = url.hash;
  try { hash = decodeURIComponent(hash); } catch { /* keep raw */ }
  const m = hash.match(/^#search\/(.*)$/i);
  if (!m) return null;
  const terms: GmailSearchTerm[] = [];
  for (const t of m[1].replace(/\+/g, " ").matchAll(SEARCH_TERM)) {
    const op = t[2]?.toLowerCase();
    const field = op === undefined ? "any" : op === "subject" || op === "from" ? op : null;
    if (field === null) continue;
    const negated = t[1] === "-";
    const phrase = t[3] ?? t[6];
    if (phrase !== undefined) {
      const words = wordList(phrase);
      if (words.length > 0) terms.push({ field, words, negated });
      continue;
    }
    const loose = t[4] ?? t[5] ?? t[7] ?? "";
    if (op === undefined && (loose === "OR" || loose === "AND")) continue;
    for (const w of wordList(loose)) terms.push({ field, words: [w], negated });
  }
  return terms;
}

/** Lowercase plain search words of a Gmail `#search/...` link (operators and "-" exclusions dropped). Any other link → null. */
export function gmailSearchWords(link: string | null | undefined): string[] | null {
  const terms = gmailSearchTerms(link);
  return terms && terms.filter((t) => t.field === "any" && !t.negated).flatMap((t) => t.words);
}

/** " word word word ": whole words (and phrases) can be looked up with includes(" x "). */
function wordText(words: string[]): string {
  return ` ${words.join(" ")} `;
}

/**
 * The sender as search words. With a display name: the name only. The address is not sent to the
 * browser then, so a `from:` term naming an address cannot match (a missed merge, never a wrong one).
 * With no display name `from` is the bare address: a plain word may match its domain labels, but not
 * the local part (billing, noreply, alerts ... are too generic to identify a sender) or the last
 * label (com, org); a `from:` term names the sender on purpose, so it sees the whole address.
 */
function senderText(from: string | null, forFromTerm: boolean): string {
  const s = (from ?? "").trim();
  if (forFromTerm || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(s)) return wordText(wordList(s));
  return wordText(s.slice(s.lastIndexOf("@") + 1).split(".").slice(0, -1).flatMap(wordList));
}

/**
 * Would this Gmail search find this email, judged on its subject and sender alone?
 * Every term must hold (a plain word in the subject OR the sender), no excluded term may,
 * and there must be at least one positive term.
 */
export function searchMatchesEmail(terms: readonly GmailSearchTerm[], subject: string, from: string | null): boolean {
  const subjectText = wordText(wordList(subject));
  const sender = senderText(from, false);
  const senderForFrom = senderText(from, true);
  const holds = (t: GmailSearchTerm): boolean => {
    const needle = wordText(t.words);
    if (t.field === "subject") return subjectText.includes(needle);
    if (t.field === "from") return senderForFrom.includes(needle);
    return subjectText.includes(needle) || sender.includes(needle);
  };
  return terms.some((t) => !t.negated) && terms.every((t) => holds(t) !== t.negated);
}

const SEARCH_MATCH_WINDOW_MS = 7 * 24 * 3_600_000;

/** An Agent Inbox card that is about email: inbox-triage's "Urgent: ..." questions, or any card linking Gmail. */
export function isEmailCard(card: InboxCardLike["card"]): boolean {
  return (card.agent === "inbox-triage" && URGENT_PREFIX.test(card.name)) || parseGmailLink(card.link) !== null;
}

/** The worker stores "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker. */
export function parseWorkerTime(s: string): string {
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s) ? `${s.replace(" ", "T")}Z` : s;
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? s : t.toISOString();
}

/** "just now", "25 min ago", "3 h ago", "2 d ago". */
export function ageLabel(iso: string | null | undefined, now: Date): string {
  const t = iso ? new Date(iso).getTime() : NaN;
  if (!Number.isFinite(t)) return "at an unknown time";
  const min = Math.max(0, Math.floor((now.getTime() - t) / 60_000));
  if (min < 2) return "just now";
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.floor(min / 60)} h ago`;
  return `${Math.floor(min / 1440)} d ago`;
}

function shortAccount(account: string): string {
  const at = account.indexOf("@");
  return at > 0 ? `${account.slice(0, at)}@` : account;
}

/** Lower sorts first: a deadline today/tomorrow, then anything inbox-triage asked about, then nearer deadlines, then Action, then undated. */
function emailRank(item: EmailItemLike): number {
  if (item.deadline && item.deadline.daysLeft <= 1) return item.deadline.daysLeft / 10;
  if (item.deadline) return 2 + item.deadline.daysLeft / 10;
  return item.labels.includes("Agent/Action") ? 3 : 4;
}

/**
 * Merge the label-sourced emails and the email cards of the Agent Inbox into one list,
 * each thing once: same Gmail thread (card link ↔ email thread id, same account when the
 * link names one) or same Message-ID in two mailboxes. Best first, bounded to `limit`.
 */
export function mergeUrgent(
  emails: readonly EmailItemLike[],
  cards: readonly InboxCardLike[],
  limit: number = MAX_URGENT_SHOWN,
): { items: TodayUrgentItem[]; total: number } {
  type Entry = { item: TodayUrgentItem; rank: number; threadId: string | null; account: string | null };
  const entries: Entry[] = [];
  const byMessageId = new Map<string, Entry>();
  for (const e of emails) {
    const mid = e.messageId.trim().toLowerCase();
    const twin = mid ? byMessageId.get(mid) : undefined;
    if (twin) {   // the same message delivered to both mailboxes
      if (!twin.item.reasons.some((r) => r.startsWith("Also in "))) twin.item.reasons.push(`Also in ${shortAccount(e.account)}`);
      continue;
    }
    const href = e.href && isGmailHref(e.href) ? e.href : null;
    const entry: Entry = {
      rank: emailRank(e),
      threadId: e.threadId,
      account: e.account.trim().toLowerCase() || null,
      item: {
        key: `email:${e.key}`,
        sources: ["Gmail"],
        sourceDetail: `Gmail, ${shortAccount(e.account)}: ${e.labels.join(" + ") || "labelled"}`,
        title: e.subject,
        from: e.from || null,
        reasons: [...e.reasons],
        nextStep: e.nextStep,
        at: e.receivedAt,
        atVerb: "Received",
        gmailHref: href,
        requestHref: null,
      },
    };
    entries.push(entry);
    if (mid) byMessageId.set(mid, entry);
  }

  const seenCodes = new Set<string>();
  for (const c of cards) {
    if (!isEmailCard(c.card)) continue;
    const code = c.card.code.toUpperCase();
    if (seenCodes.has(code)) continue;
    seenCodes.add(code);
    const ref = parseGmailLink(c.card.link);
    const ask = c.card.name.replace(URGENT_PREFIX, "").trim() || c.card.name;
    const requestHref = `/agents?${new URLSearchParams({ t: c.thread })}#m${c.messageId}`;
    let match: Entry | undefined;
    if (ref?.threadId) {
      match = entries.find((x) => x.threadId === ref.threadId && (!ref.account || !x.account || x.account === ref.account));
    } else if (ref) {
      // A Gmail search link names no thread: merge only into the ONE labelled email the search
      // would find (every word in its subject or sender name; searchMatchesEmail), from the
      // same account, received up to 7 days before the card. Two candidates = no merge.
      const terms = gmailSearchTerms(c.card.link) ?? [];
      const cardAt = new Date(parseWorkerTime(c.created_at)).getTime();
      if (terms.length > 0 && Number.isFinite(cardAt)) {
        const hits = entries.filter((x) => {
          if (!x.item.sources.includes("Gmail")) return false;
          if (ref.account && x.account !== ref.account) return false;
          const at = new Date(x.item.at).getTime();
          if (!Number.isFinite(at) || at > cardAt || cardAt - at > SEARCH_MATCH_WINDOW_MS) return false;
          return searchMatchesEmail(terms, x.item.title, x.item.from);
        });
        if (hits.length === 1) match = hits[0];
      }
    }
    if (match) {
      if (!match.item.sources.includes("Agent Inbox")) {
        match.item.sources.push("Agent Inbox");
        match.item.sourceDetail += ` + Agent Inbox (${c.card.agent})`;
        match.item.reasons.unshift(`${c.card.agent} asked you about it: ${ask}`);
        match.item.nextStep = `Answer the request, then ${match.item.nextStep.charAt(0).toLowerCase()}${match.item.nextStep.slice(1)}`;
        match.item.requestHref = requestHref;
        match.rank = Math.min(match.rank, 1);
      }
      continue;
    }
    entries.push({
      rank: 1,
      threadId: ref?.threadId ?? null,
      account: ref?.account ?? null,
      item: {
        key: `card:${code}`,
        sources: ["Agent Inbox"],
        sourceDetail: `Agent Inbox: ${c.card.agent}${ref?.account ? `, ${shortAccount(ref.account)}` : ""}`,
        title: ask,
        from: null,
        reasons: [`${c.card.agent} flagged it as urgent`],
        nextStep: "Answer the request in your inbox",
        at: parseWorkerTime(c.created_at),
        atVerb: "Posted",
        gmailHref: c.card.link && ref ? c.card.link : null,
        requestHref,
      },
    });
  }

  const time = (iso: string) => { const t = new Date(iso).getTime(); return Number.isFinite(t) ? t : 0; };
  entries.sort((a, b) => a.rank - b.rank || time(b.item.at) - time(a.item.at) || (a.item.key < b.item.key ? -1 : a.item.key > b.item.key ? 1 : 0));
  return { items: entries.slice(0, Math.max(0, limit)).map((e) => e.item), total: entries.length };
}
