// Urgent-email rules for the Today page.
//
// Deterministic and offline: keyword, sender and deadline rules over email METADATA
// (sender, subject, a short plain-text snippet, received time, unread flag). No model
// calls, no network, no imports, so it runs unchanged in the browser, in the API route
// and in frontend/scripts/test-urgent-email.mjs (Node strips the type annotations).
// Keep this file to erasable TypeScript (no enums, no parameter properties) for that reason.
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
}

// Strong (3): the sender is saying something is wrong or must happen now.
// Medium (2): time pressure or a request with a date. Weak (1): generic emphasis.
const PHRASE_RULES: readonly PhraseRule[] = [
  { reason: "marked urgent or action required", points: 3,
    pattern: /\b(urgent|urgently|immediate action|action (?:is )?(?:required|needed)|response (?:is )?(?:required|needed))\b/i },
  { reason: "overdue or final notice", points: 3,
    pattern: /\b(?:final|last|second|third) (?:notice|reminder|warning)\b|\bpast due\b|\boverdue\b|\bdelinquent\b/i },
  { reason: "payment problem", points: 3,
    pattern: /\bpayment (?:has )?(?:failed|was declined|declined|unsuccessful|could not be processed)\b|\bcard (?:was )?declined\b|\bunable to (?:process|charge) your (?:payment|card)\b/i },
  { reason: "security or fraud alert", points: 3,
    pattern: /\b(?:unauthorized|suspicious|unusual) (?:activity|sign-?in|log-?in|charge|transaction|access)\b|\bfraud(?:ulent)?\b|\bsecurity alert\b|\baccount (?:has been |was )?(?:compromised|hacked)\b/i },
  { reason: "account at risk", points: 3,
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

// Promotional mail is never urgent: a match is a hard veto, whatever else the message says.
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
  for (const rule of PHRASE_RULES) {
    if (rule.pattern.test(text)) { content += rule.points; hits.push({ reason: rule.reason, points: rule.points }); }
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

  if (PROMO_SUBJECT.test(email.subject) || PROMO_SENDER.test(senderLocalPart(email.fromAddress))) {
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
  const latest = now.getTime() + DAY_MS; // tolerate small clock skew, drop obviously future rows
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

export function isGmailHref(href: string): boolean {
  return href.startsWith("https://mail.google.com/mail/");
}
