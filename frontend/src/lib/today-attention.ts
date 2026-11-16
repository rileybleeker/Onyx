/**
 * Today's attention model (PROD-T04): every open obligation Today already reads, from every source, as one
 * normalized list that can be ranked and budgeted (the quiet view, lib/today-view.ts) without replacing any system
 * of record. The Agent Inbox, the email labels, the calendar, the finance ledger, the renewals and the orders
 * still decide what is open; this file only lines their answers up.
 *
 * Rules:
 * - Identity: every obligation has a stable id `<source>:<the source's own identity>` (card code, email thread
 *   key, calendar event key, renewal merchant + date ...). Duplicates are folded by that id ONLY: two items with the
 *   same wording but different ids always stay two (`collectObligations`).
 * - Ranking is deterministic and explainable: urgency tier, then due time, then a fixed source order, then id;
 *   every obligation carries the plain-words reason for its tier (`rankObligations`).
 * - Urgent items bypass the ordinary budget and say so (`selectQuiet`: `overBudget`, `urgentOver`).
 * - Snooze and "hide here" are display marks on this device, keyed by a hash of the id and of the obligation's
 *   `version`; a mark stops applying when its snooze ends or the circumstance changes (new message, nearer
 *   deadline, higher urgency ...). A marked item stays open: the full Today view lists it as before.
 * - A source that is checking, failed, stale or partial is "unknown": the quiet view never calls such a day clear.
 *
 * IMPORT-FREE at run time (tests/today-regression.cjs bundles it by name; type imports only).
 * Tests: frontend/tests/today-attention.test.cjs (synthetic data only).
 */
import type { EmailItemLike, TodayUrgentItem } from "./urgent-email";
import type { MoneyAlert } from "./finance-alerts";
import type { RenewalSummary } from "./procurement-renewals";
import type { CalendarEvent } from "./calendar-events";

export type AttentionSource = "urgent-email" | "agents" | "experiment" | "calendar" | "money" | "renewals" | "packages" | "reading";
/** Ties within a tier and a due time break in this order (then by id). */
export const SOURCE_ORDER: readonly AttentionSource[] = ["urgent-email", "agents", "experiment", "calendar", "money", "renewals", "packages", "reading"];
export const SOURCE_LABEL: Readonly<Record<AttentionSource, string>> = {
  "urgent-email": "Urgent email",
  agents: "Agent requests",
  experiment: "Experiment",
  calendar: "Calendar",
  money: "Money",
  renewals: "Renewals",
  packages: "Packages",
  reading: "Reading",
};

export type Urgency = "urgent" | "high" | "normal" | "low";
const TIER: Readonly<Record<Urgency, number>> = { urgent: 0, high: 1, normal: 2, low: 3 };
export const URGENCY_LABEL: Readonly<Record<Urgency, string>> = { urgent: "Urgent", high: "Soon", normal: "Open", low: "Later" };

export interface Obligation {
  /** `<source>:<the source's own identity>`: the only key duplicates are folded by. */
  id: string;
  source: AttentionSource;
  title: string;
  detail: string | null;
  /** Where to act on it; null when the item itself is the instruction (today's experiment arm). */
  href: string | null;
  /** The link leaves Onyx (Gmail): opened in a new tab. */
  external: boolean;
  urgency: Urgency;
  /** When it is due (ms), null when it has no due time. */
  dueAt: number | null;
  /** Why it is in its tier, in plain words. */
  reason: string;
  /** Changes when the circumstance changes materially; a snooze or "hide here" made on another version lapses. */
  version: string;
  /** An optional learning action (reading): at most one in the quiet view, never in the ordinary budget. */
  learning: boolean;
}

export type SourceState = "ok" | "checking" | "stale" | "partial" | "failed" | "not_connected";

/** What the page knows about one source's answer. */
export interface SourceProbe {
  /** "loading" before any answer, "error" when no answer could be read. */
  load: "loading" | "ready" | "error";
  /** The shown answer is from an earlier check: the last refresh failed. */
  refreshFailed?: boolean;
  /** A check is running and the shown answer came from an earlier visit. */
  checking?: boolean;
  /** false: the source is not connected yet (a normal answer, not a failure). */
  connected?: boolean;
  /** The sync behind the answer is late or failing (email labels, calendar): newer items may be missing. */
  syncLate?: boolean;
  /** Part of the answer could not be read (or was cut off): an item may be missing. */
  partial?: boolean;
  /** When the source's data was last confirmed (ISO), when known. */
  asOf?: string | null;
}

export interface SourceStatus {
  source: AttentionSource;
  label: string;
  state: SourceState;
  /** Plain words: "checked 20 min ago", "couldn't check", "its sync is late; newer items may be missing". */
  note: string;
}

const MIN = 60_000;
const HOUR = 3_600_000;

function ago(iso: string | null | undefined, now: Date): string | null {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return null;
  const min = Math.max(0, Math.floor((now.getTime() - t) / MIN));
  if (min < 2) return "just now";
  if (min < 60) return `${min} min ago`;
  if (min < 48 * 60) return `${Math.floor(min / 60)} h ago`;
  return `${Math.floor(min / 1440)} d ago`;
}

/** One source's state, most serious first: an unread answer, then not connected, then a failed refresh, ... */
export function sourceStatus(source: AttentionSource, p: SourceProbe, now: Date): SourceStatus {
  const label = SOURCE_LABEL[source];
  const at = ago(p.asOf, now);
  if (p.load === "loading") return { source, label, state: "checking", note: "checking..." };
  if (p.load === "error") return { source, label, state: "failed", note: "couldn't check" };
  if (p.connected === false) return { source, label, state: "not_connected", note: "not connected yet" };
  if (p.refreshFailed) return { source, label, state: "stale", note: `couldn't refresh; showing ${at ? `the check from ${at}` : "an earlier check"}` };
  if (p.partial) return { source, label, state: "partial", note: "part of it couldn't be read, so an item may be missing" };
  if (p.syncLate) return { source, label, state: "stale", note: `its sync is late${at ? ` (last ${at})` : ""}; newer items may be missing` };
  if (p.checking) return { source, label, state: "checking", note: "checking; showing an earlier check" };
  return { source, label, state: "ok", note: at ? `checked ${at}` : "checked" };
}

/** A source state that cannot confirm "nothing here". */
export function isUnknown(state: SourceState): boolean {
  return state === "checking" || state === "stale" || state === "partial" || state === "failed";
}

// ─── Adapters: one per source, each keeps the source's own identity ─────────────────────────────────────────

/**
 * A card's expiry as an instant (ms). The Worker sends a date-only expiry as "YYYY-MM-DDT23:59:59" with no zone
 * (the end of that day where Riley is), a bare "YYYY-MM-DD" means the same, "YYYY-MM-DD HH:MM:SS" (its database
 * form) is UTC, and anything else is an ISO instant.
 */
export function expiryInstant(s: string | null | undefined): number | null {
  if (!s) return null;
  let t: number;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (day) t = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]), 23, 59, 59).getTime();
  else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/.test(s)) t = Date.parse(s); // no zone: local time
  else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s)) t = Date.parse(`${s.replace(" ", "T")}Z`);
  else t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** The end of the local day `days` after `now` (0 = today). */
function endOfLocalDay(now: Date, days: number): number {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, 23, 59, 59, 999);
  return d.getTime();
}

/** The part of an Agent Inbox card (lib/agents-api.ts) a request obligation reads. */
export interface RequestLike {
  thread: string;
  messageId: number;
  created_at: string;
  card: { code: string; agent: string; name: string; expires?: string | null; updated?: boolean };
}

/** Agent requests waiting for an answer (email questions are handled with urgent email). */
export function requestObligations(requests: readonly RequestLike[], now: Date): Obligation[] {
  return requests.map((r) => {
    const code = r.card.code.toUpperCase();
    const due = expiryInstant(r.card.expires);
    const left = due === null ? null : due - now.getTime();
    let urgency: Urgency = "normal";
    let reason = `${r.card.agent || "An agent"} is waiting for your answer`;
    if (left !== null && left > 0 && left <= 12 * HOUR) {
      urgency = "urgent";
      reason = `Expires in ${left < HOUR ? `${Math.max(1, Math.round(left / MIN))} min` : `${Math.round(left / HOUR)} h`}`;
    } else if (left !== null && left > 0 && left <= 48 * HOUR) {
      urgency = "high";
      reason = `Expires in ${Math.round(left / HOUR)} h`;
    }
    return {
      id: `agents:${code}`,
      source: "agents",
      title: r.card.name,
      detail: r.card.agent ? `From ${r.card.agent}` : null,
      href: `/agents?${new URLSearchParams({ t: r.thread }).toString()}#m${r.messageId}`,
      external: false,
      urgency,
      dueAt: due,
      reason,
      version: [urgency, r.card.expires ?? "", r.card.updated ? "updated" : "", r.card.name].join("|"),
      learning: false,
    };
  });
}

/**
 * Urgent email as Today merged it (lib/urgent-email.ts mergeUrgent: labelled threads + inbox-triage's questions,
 * each once). `emails` are the label answer's items, read for their deadline.
 */
export function urgentEmailObligations(items: readonly TodayUrgentItem[], emails: readonly EmailItemLike[], now: Date): Obligation[] {
  const byKey = new Map<string, EmailItemLike>();
  for (const e of emails) byKey.set(`email:${e.key}`, e);
  return items.map((item) => {
    const deadline = byKey.get(item.key)?.deadline ?? null;
    const asked = item.sources.includes("Agent Inbox");
    let urgency: Urgency = "normal";
    let reason = "Labelled for a reply or decision";
    if (deadline && deadline.daysLeft <= 0) { urgency = "urgent"; reason = `Deadline today (${deadline.label})`; }
    else if (deadline && deadline.daysLeft === 1) { urgency = "urgent"; reason = `Deadline tomorrow (${deadline.label})`; }
    else if (asked) { urgency = "urgent"; reason = "inbox-triage flagged it as urgent"; }
    else if (deadline && deadline.daysLeft <= 3) { urgency = "high"; reason = `Deadline ${deadline.label}`; }
    else if (deadline) reason = `Deadline ${deadline.label}`;
    const href = item.requestHref ?? item.gmailHref;
    return {
      id: `urgent-email:${item.key}`,
      source: "urgent-email",
      title: item.title,
      detail: item.nextStep,
      href,
      external: !item.requestHref && !!item.gmailHref,
      urgency,
      dueAt: deadline ? endOfLocalDay(now, Math.max(0, deadline.daysLeft)) : null,
      reason,
      version: [urgency, deadline ? deadline.daysLeft : "", item.at, item.sources.join("+")].join("|"),
      learning: false,
    };
  });
}

/** Today's arm of a running N-of-1 trial: the instruction for the day (nothing to open). */
export interface TrialLike { status: string; experimentId?: string; behavioralDate?: string; arm?: string; instruction?: string }
export function experimentObligations(trial: TrialLike | null): Obligation[] {
  if (!trial || trial.status !== "active" || !trial.experimentId || !trial.behavioralDate) return [];
  return [{
    id: `experiment:${trial.experimentId}:${trial.behavioralDate}`,
    source: "experiment",
    title: `Arm ${trial.arm ?? "?"}: ${trial.instruction ?? ""}`.trim(),
    detail: null,
    href: null,
    external: false,
    urgency: "high",
    dueAt: null,
    reason: "Today's experiment arm",
    version: `${trial.arm ?? ""}|${trial.instruction ?? ""}`,
    learning: false,
  }];
}

/** Timed events starting within this long count as something to get ready for. */
export const CALENDAR_SOON_MS = 2 * HOUR;
/** Today's calendar events that start soon (all-day, ongoing and later events are the schedule, not a to-do). */
export function calendarObligations(events: readonly CalendarEvent[], now: Date): Obligation[] {
  const out: Obligation[] = [];
  for (const e of events) {
    if (e.allDay || !e.startAt) continue;
    const start = Date.parse(e.startAt);
    if (!Number.isFinite(start)) continue;
    const left = start - now.getTime();
    if (left <= 0 || left > CALENDAR_SOON_MS) continue;
    out.push({
      id: `calendar:${e.key}`,
      source: "calendar",
      title: e.title || "(No title)",
      detail: e.location ?? null,
      href: "/health",
      external: false,
      urgency: "high",
      dueAt: start,
      reason: `Starts in ${left < HOUR ? `${Math.max(1, Math.round(left / MIN))} min` : `${Math.round((left / HOUR) * 10) / 10} h`}${e.status === "tentative" ? " (tentative)" : ""}`,
      version: `${e.startAt}|${e.status}`,
      learning: false,
    });
  }
  return out;
}

const MONEY_REASON: Readonly<Record<MoneyAlert["kind"], string>> = {
  "low-cash": "Cash may run short on the cautious path",
  budget: "A budget is over or heading over",
  promo: "A 0% promo is ending",
  tax: "A tax payment is due",
};
/**
 * Money alerts. They carry no id of their own, so the identity is the alert kind plus what it names (the text
 * before the first ": ": the category, card or payment), numbered when two alerts of one answer share it, so
 * they are never folded together. Amounts are left out of the version: a dollar of drift is not a new
 * circumstance, a change of severity, status or date is.
 */
export function moneyObligations(alerts: readonly MoneyAlert[]): Obligation[] {
  const seen = new Map<string, number>();
  return alerts.map((a) => {
    const colon = a.title.indexOf(": ");
    const subject = colon > 0 ? a.title.slice(0, colon) : "";
    const base = `money:${a.kind}:${subject}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return {
      id: n === 1 ? base : `${base}#${n}`,
      source: "money",
      title: a.title,
      detail: a.detail,
      href: a.href,
      external: false,
      urgency: a.severity === "high" ? "high" : "normal",
      dueAt: null,
      reason: MONEY_REASON[a.kind] ?? "Money alert",
      version: `${a.severity}|${a.title.replace(/-?\$[\d,]+(?:\.\d+)?/g, "$")}`,
      learning: false,
    };
  });
}

/** Renewals due within the summary's window, named one by one; the unnamed rest as one count. */
export function renewalObligations(summary: RenewalSummary | null): Obligation[] {
  if (!summary || summary.status !== "ready" || summary.count <= 0) return [];
  const out: Obligation[] = summary.soon.map((r) => ({
    id: `renewals:${r.merchant}:${r.date}`,
    source: "renewals",
    title: `${r.merchant} ${r.label}`,
    detail: null,
    href: "/procurement",
    external: false,
    urgency: r.days <= 0 ? "high" : "normal",
    dueAt: /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? new Date(`${r.date}T00:00:00`).getTime() : null,
    reason: r.days <= 0 ? "Renews today" : `Renews within ${summary.withinDays} days`,
    // The daily countdown is not a new circumstance; reaching the renewal day is.
    version: r.days <= 0 ? "due" : "soon",
    learning: false,
  }));
  const rest = summary.count - summary.soon.length;
  if (rest > 0) {
    out.push({
      id: "renewals:more",
      source: "renewals",
      title: `${rest} more subscription${rest === 1 ? "" : "s"} renewing soon`,
      detail: null,
      href: "/procurement",
      external: false,
      urgency: "low",
      dueAt: null,
      reason: `Renew within ${summary.withinDays} days`,
      version: String(rest),
      learning: false,
    });
  }
  return out;
}

/** GET /api/orders/summary (what Today reads). */
export type PackagesLike = { status: "not_connected" } | { status: "ready"; attention: number; arrivingToday: number; onTheWay: number; top: { merchant: string; label: string; reason: string }[] };
/** Packages as two counts the orders page keeps (needs attention, arriving today): the orders themselves live there. */
export function packageObligations(summary: PackagesLike | null): Obligation[] {
  if (!summary || summary.status !== "ready") return [];
  const out: Obligation[] = [];
  if (summary.attention > 0) {
    const top = summary.top[0];
    out.push({
      id: "packages:attention",
      source: "packages",
      title: `${summary.attention} package${summary.attention === 1 ? " needs" : "s need"} attention`,
      detail: top ? `${top.merchant}: ${top.reason}` : null,
      href: "/orders",
      external: false,
      urgency: "normal",
      dueAt: null,
      reason: "Late, stuck or not shipped",
      version: String(summary.attention),
      learning: false,
    });
  }
  if (summary.arrivingToday > 0) {
    out.push({
      id: "packages:arriving",
      source: "packages",
      title: `${summary.arrivingToday} package${summary.arrivingToday === 1 ? "" : "s"} arriving today`,
      detail: null,
      href: "/orders",
      external: false,
      urgency: "low",
      dueAt: null,
      reason: "Expected today",
      version: String(summary.arrivingToday),
      learning: false,
    });
  }
  return out;
}

/** The part of GET /api/reading's overview (lib/reading.ts) the learning action reads. */
export interface ReadingLike {
  book: { slug: string; title: string; status?: string };
  today: string;
  chaptersDone: number;
  totalChapters: number;
  streak?: { current: number; loggedToday: boolean; atRisk: boolean };
  dueReviews?: readonly unknown[];
}
/** The book in progress as the optional learning action; none once today's reading is logged. */
export function readingObligations(overview: ReadingLike | null): Obligation[] {
  if (!overview || !overview.book?.title || overview.book.status === "finished" || overview.book.status === "abandoned") return [];
  if (overview.streak?.loggedToday) return [];
  const reviews = overview.dueReviews?.length ?? 0;
  const reason = overview.streak?.atRisk && overview.streak.current > 0
    ? `Keep your ${overview.streak.current}-day streak`
    : reviews > 0
      ? `${reviews} highlight${reviews === 1 ? "" : "s"} due for review`
      : Number.isFinite(overview.chaptersDone) && overview.totalChapters > 0
        ? `${overview.chaptersDone} of ${overview.totalChapters} chapters recorded`
        : "Your book in progress";
  return [{
    id: `reading:${overview.book.slug || overview.book.title}`,
    source: "reading",
    title: `Continue ${overview.book.title}`,
    detail: null,
    href: "/reading",
    external: false,
    urgency: "low",
    dueAt: null,
    reason,
    // A new behavioral day is a new day of reading: yesterday's snooze or hide lapses.
    version: `${overview.today}|${reviews > 0 ? "reviews" : ""}`,
    learning: true,
  }];
}

// ─── Fold, rank, budget ─────────────────────────────────────────────────────────────────────────────────────

/** Every list in one; an id that appears twice is kept once (its more urgent copy). Wording never merges. */
export function collectObligations(lists: readonly (readonly Obligation[])[]): Obligation[] {
  const byId = new Map<string, Obligation>();
  const order: string[] = [];
  for (const list of lists) {
    for (const o of list) {
      const had = byId.get(o.id);
      if (!had) { byId.set(o.id, o); order.push(o.id); }
      else if (TIER[o.urgency] < TIER[had.urgency]) byId.set(o.id, o);
    }
  }
  return order.map((id) => byId.get(id) as Obligation);
}

/** Urgency tier, then the nearest due time (none last), then the source order, then id: the same input always ranks the same. */
export function compareObligations(a: Obligation, b: Obligation): number {
  const tier = TIER[a.urgency] - TIER[b.urgency];
  if (tier) return tier;
  const ad = a.dueAt ?? Infinity;
  const bd = b.dueAt ?? Infinity;
  if (ad !== bd) return ad < bd ? -1 : 1;
  const src = SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source);
  if (src) return src;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function rankObligations(list: readonly Obligation[]): Obligation[] {
  return list.slice().sort(compareObligations);
}

// ─── Display marks: snooze and "hide here" (this device only) ───────────────────────────────────────────────

/** A deterministic short hash (cyrb53, base 36). The marks store hashes, never an obligation's own text. */
export function attentionHash(s: string): string {
  let h1 = 0xdeadbeef ^ 0;
  let h2 = 0x41c6ce57 ^ 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

export interface AttentionMark {
  /** Hash of the obligation's version when it was marked. */
  v: string;
  /** Snoozed until (ms). */
  until?: number;
  /** Hidden here until it changes. */
  hidden?: true;
  /** When the mark was set (ms): old marks are pruned. */
  at: number;
}
/** Keyed by attentionHash(obligation id). */
export type AttentionMarks = Readonly<Record<string, AttentionMark>>;

/** Most marks kept, and how long a mark is kept after it was set (or after its snooze ended). */
export const MAX_MARKS = 200;
export const MARK_KEEP_MS = 30 * 24 * HOUR;

export function markKey(o: Pick<Obligation, "id">): string {
  return attentionHash(o.id);
}
export function markFor(o: Pick<Obligation, "version">, kind: "snooze" | "hide", nowMs: number, untilMs?: number): AttentionMark {
  const v = attentionHash(o.version);
  return kind === "hide" ? { v, hidden: true, at: nowMs } : { v, until: untilMs ?? nowMs, at: nowMs };
}

/** Does this mark still set the obligation aside? Not once its snooze ended or the obligation's version changed. */
export function markApplies(mark: AttentionMark | undefined, o: Pick<Obligation, "version">, nowMs: number): "snoozed" | "hidden" | null {
  if (!mark || mark.v !== attentionHash(o.version)) return null;
  if (mark.hidden) return "hidden";
  return typeof mark.until === "number" && nowMs < mark.until ? "snoozed" : null;
}

/** Stored marks, checked: junk entries are dropped, never trusted. */
export function parseMarks(raw: unknown): Record<string, AttentionMark> {
  const out: Record<string, AttentionMark> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [k, m] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[0-9a-z]{1,16}$/.test(k) || !m || typeof m !== "object") continue;
    const r = m as Record<string, unknown>;
    if (typeof r.v !== "string" || !/^[0-9a-z]{1,16}$/.test(r.v) || typeof r.at !== "number" || !Number.isFinite(r.at)) continue;
    if (r.hidden === true) out[k] = { v: r.v, hidden: true, at: r.at };
    else if (typeof r.until === "number" && Number.isFinite(r.until)) out[k] = { v: r.v, until: r.until, at: r.at };
  }
  return out;
}

/** Drop marks that can no longer matter (old, or a snooze that ended a while ago); keep at most MAX_MARKS, newest first. */
export function pruneMarks(marks: AttentionMarks, nowMs: number): Record<string, AttentionMark> {
  const live = Object.entries(marks).filter(([, m]) => {
    const last = typeof m.until === "number" ? Math.max(m.at, m.until) : m.at;
    return nowMs - last <= MARK_KEEP_MS;
  });
  live.sort((a, b) => b[1].at - a[1].at || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return Object.fromEntries(live.slice(0, MAX_MARKS));
}

/**
 * "Snooze until tomorrow": 06:00 local on the next behavioral day (the app's day runs to 06:00; ADR-0001's −6 h
 * rule). At 22:00 Monday or 01:00 Tuesday that is 06:00 Tuesday; at 07:00 Tuesday it is 06:00 Wednesday.
 */
export function snoozeUntil(now: Date): number {
  const behavioral = new Date(now.getTime() - 6 * HOUR);
  return new Date(behavioral.getFullYear(), behavioral.getMonth(), behavioral.getDate() + 1, 6, 0, 0, 0).getTime();
}

// ─── The quiet selection ────────────────────────────────────────────────────────────────────────────────────

export interface QuietOptions {
  /** Ordinary items shown (urgent items are shown beyond it). */
  budget: number;
  /** Show one learning action. */
  learning: boolean;
  marks: AttentionMarks;
  nowMs: number;
}
export interface QuietItem {
  item: Obligation;
  /** An urgent item shown beyond the budget. */
  overBudget: boolean;
}
export interface SetAside {
  item: Obligation;
  state: "snoozed" | "hidden";
  until: number | null;
}
export interface QuietSelection {
  shown: QuietItem[];
  /** The optional learning action (not an obligation: it never makes a day "not clear"). */
  learning: Obligation | null;
  /** Open obligations beyond the budget: listed in the full list. */
  more: number;
  /** Snoozed or hidden here: still open, still listed in the full list (learning actions included). */
  setAside: SetAside[];
  /** Urgent items beyond the budget (shown anyway). */
  urgentOver: number;
  /** Sources that could not confirm their answer. */
  unknown: SourceStatus[];
  notConnected: SourceStatus[];
  /**
   * Judged on obligations only. items: something to show. unknown: nothing to show and at least one source could
   * not confirm its answer: never a clear day. set_aside: nothing to show, but open obligations are snoozed,
   * hidden here or beyond the budget. clear: nothing open and every connected source answered.
   */
  verdict: "items" | "clear" | "set_aside" | "unknown";
}

export const MIN_BUDGET = 1;
export const MAX_BUDGET = 5;
export const DEFAULT_BUDGET = 3;
export function clampBudget(n: unknown): number {
  const v = typeof n === "number" && Number.isFinite(n) ? Math.round(n) : DEFAULT_BUDGET;
  return Math.min(MAX_BUDGET, Math.max(MIN_BUDGET, v));
}

export function selectQuiet(obligations: readonly Obligation[], sources: readonly SourceStatus[], opts: QuietOptions): QuietSelection {
  const budget = clampBudget(opts.budget);
  const ranked = rankObligations(obligations);
  const open: Obligation[] = [];
  const setAside: SetAside[] = [];
  for (const o of ranked) {
    const mark = opts.marks[markKey(o)];
    const state = markApplies(mark, o, opts.nowMs);
    if (state) setAside.push({ item: o, state, until: state === "snoozed" ? mark?.until ?? null : null });
    else open.push(o);
  }
  const urgent = open.filter((o) => o.urgency === "urgent" && !o.learning);
  const ordinary = open.filter((o) => o.urgency !== "urgent" && !o.learning);
  // Urgent items are never cut by the budget: each one past it is shown and says so.
  const shown: QuietItem[] = urgent.map((item, i) => ({ item, overBudget: i >= budget }));
  const room = Math.max(0, budget - urgent.length);
  for (const item of ordinary.slice(0, room)) shown.push({ item, overBudget: false });
  const learning = opts.learning ? open.find((o) => o.learning) ?? null : null;
  const more = Math.max(0, ordinary.length - room);
  const unknown = sources.filter((s) => isUnknown(s.state));
  const notConnected = sources.filter((s) => s.state === "not_connected");
  const setAsideObligations = setAside.filter((s) => !s.item.learning).length;
  const verdict = shown.length > 0
    ? "items"
    : unknown.length > 0
      ? "unknown"
      : setAsideObligations + more > 0 ? "set_aside" : "clear";
  return { shown, learning, more, setAside, urgentOver: Math.max(0, urgent.length - budget), unknown, notConnected, verdict };
}

export interface ListedItem {
  item: Obligation;
  /** open, or set aside on this device (still open at its source). */
  state: "open" | "snoozed" | "hidden";
  until: number | null;
}
/** The full list: every open obligation and learning action, ranked, each with its display state. Nothing is left out. */
export function fullList(obligations: readonly Obligation[], marks: AttentionMarks, nowMs: number): ListedItem[] {
  return rankObligations(obligations).map((item) => {
    const mark = marks[markKey(item)];
    const state = markApplies(mark, item, nowMs);
    return { item, state: state ?? "open", until: state === "snoozed" ? mark?.until ?? null : null };
  });
}

// ─── Today's sources in one call ────────────────────────────────────────────────────────────────────────────

export interface TodayAttentionInput {
  now: Date;
  requests: { probe: SourceProbe; items: readonly RequestLike[] };
  urgentEmail: { probe: SourceProbe; items: readonly TodayUrgentItem[]; emails: readonly EmailItemLike[] };
  /** Omitted when no trial is registered or the check is not made here (the scroll's copy of Today). */
  experiment?: { probe: SourceProbe; trial: TrialLike | null };
  calendar: { probe: SourceProbe; events: readonly CalendarEvent[] };
  money: { probe: SourceProbe; alerts: readonly MoneyAlert[] };
  renewals: { probe: SourceProbe; summary: RenewalSummary | null };
  packages: { probe: SourceProbe; summary: PackagesLike | null };
  reading: { probe: SourceProbe; overview: ReadingLike | null };
}

export function todayAttention(input: TodayAttentionInput): { obligations: Obligation[]; sources: SourceStatus[] } {
  const { now } = input;
  const sources: SourceStatus[] = [
    sourceStatus("urgent-email", input.urgentEmail.probe, now),
    sourceStatus("agents", input.requests.probe, now),
    ...(input.experiment ? [sourceStatus("experiment", input.experiment.probe, now)] : []),
    sourceStatus("calendar", input.calendar.probe, now),
    sourceStatus("money", input.money.probe, now),
    sourceStatus("renewals", input.renewals.probe, now),
    sourceStatus("packages", input.packages.probe, now),
    sourceStatus("reading", input.reading.probe, now),
  ];
  const obligations = collectObligations([
    urgentEmailObligations(input.urgentEmail.items, input.urgentEmail.emails, now),
    requestObligations(input.requests.items, now),
    experimentObligations(input.experiment?.trial ?? null),
    calendarObligations(input.calendar.events, now),
    moneyObligations(input.money.alerts),
    renewalObligations(input.renewals.summary),
    packageObligations(input.packages.summary),
    readingObligations(input.reading.overview),
  ]);
  return { obligations, sources };
}
