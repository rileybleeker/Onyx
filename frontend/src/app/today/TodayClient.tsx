"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import styles from "./Today.module.css";
import { ArrowUpRight, BookOpen, CalendarClock, CalendarDays, ClipboardCheck, FlaskConical, Mail, Package, RefreshCw, Wallet, X } from "lucide-react";
import { agentsApi, clearDeviceNotifications, setBadge, type InboxResponse, type InboxItem } from "@/lib/agents-api";
import type { ReadingOverview } from "@/lib/reading";
import type { UrgentEmailResponse } from "@/lib/urgent-email-query";
import { ageLabel, isEmailCard, isGmailHref, mergeUrgent } from "@/lib/urgent-email";
import { dayLabel, isExperimentToday, type ExperimentToday } from "@/lib/experiments";
import type { RenewalSummary } from "@/lib/procurement-renewals";
// Import-free helpers (tests/today-regression.cjs bundles this module by name).
import { type CalendarEventsResponse, CALENDAR_SOURCE_LABEL, eventTitle, eventsByDay, localDate, readCalendarResponse, shiftDate, syncHealth, timeLabel } from "@/lib/calendar-events";
// Import-free too (bundled by name in the same test).
import { type EmailClearMark, MAX_CLEAR_ITEMS, clearedLabel, hiddenEmailKey } from "@/lib/today-clear";
// Import-free too: the shared client cache (Today renders from it at once, then revalidates) and sameJson.
import { CACHE_KEYS, clientCache, isGoneStatus } from "@/lib/client-cache";
import { sameJson } from "@/lib/format";
// Import-free too: how current the money alerts are (bundled by name in the same test).
import { MONEY_FRESH_URL, MONEY_RECHECK_MS, MONEY_URL, moneyNote, parseMoneyAnswer, showMoneyPanel, type MoneyView } from "@/lib/money-alerts-view";
// One card per area of the app under Today's own panels (loaded as its own chunk; components/overview/).
import TodayOverview from "@/components/overview/TodayOverview";

type Load<T> = { state: "loading" } | { state: "error" } | { state: "ready"; value: T; stale?: boolean };
type RequestCard = Extract<InboxItem, { kind: "card" }>;
// GET /api/orders/summary (online orders read from shipping emails; see /orders).
type OrdersSummary = { status: "not_connected" } | { status: "ready"; attention: number; arrivingToday: number; onTheWay: number;
  top: { merchant: string; label: string; reason: string }[] };
const linkStyle = "text-sm text-accent underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-accent";
const panelStyle = `${styles.panel} rounded-card border border-border-default bg-surface-card p-5 sm:p-6`; // shadow-card via styles.panel
const clearAllStyle = "text-sm text-accent focus-visible:outline-2 focus-visible:outline-accent";
const clearOneStyle = "inline-flex min-h-11 min-w-11 items-center justify-center shrink-0 rounded-control p-2 text-text-secondary hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent";
// The Worker's /onyx/dismiss takes at most this many card codes per call.
const MAX_DISMISS = 200;
// How long the "Cleared N · Undo" bar stays (same as the Agents inbox).
const UNDO_MS = 8000;
type Cleared = { cards: string[]; emails: EmailClearMark[]; text: string };

async function postEmailClear(marks: EmailClearMark[], undo: boolean): Promise<void> {
  const res = await fetch("/api/urgent-email/clear", {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(undo ? { items: marks.map((m) => ({ key: m.key })), undo: true } : { items: marks.map((m) => ({ key: m.key, receivedAt: m.receivedAt })) }),
  });
  if (!res.ok) throw new Error("Clear failed");
}

// Bound a slow upstream without treating a timeout as an empty inbox.
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Timed out")), 12000);
    })]);
  } finally { clearTimeout(timer!); }
}
// The email label sync runs hourly; older than this and Today says newer labels may be missing.
const LABEL_SYNC_STALE_MS = 3 * 3_600_000;
const URGENT_SHOWN = 5;
// Calendar panel: today and tomorrow, at most this many events listed per day.
const CALENDAR_SHOWN = 6;
function calendarDayLabel(day: string): string {
  return new Date(`${day}T12:00:00`).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}
function requestHref(item: RequestCard): string {
  return `/agents?${new URLSearchParams({ t: item.thread })}#m${item.messageId}`;
}

// Each answer is checked before it is shown or cached; a cached copy is checked again before it is used.
function parseInbox(data: unknown): InboxResponse {
  const v = data as InboxResponse | null;
  if (!v || !Array.isArray(v.items) || !Array.isArray(v.threads)) throw new Error("Invalid inbox");
  return v;
}
function parseReading(data: unknown): ReadingOverview | null {
  const v = data as { overview?: ReadingOverview | null } | null;
  if (!v || !("overview" in v) || (v.overview !== null && !v.overview?.book?.title)) throw new Error("Invalid reading");
  return v.overview ?? null;
}
function parseUrgent(data: unknown): UrgentEmailResponse {
  const v = data as UrgentEmailResponse | null;
  if (!v || (v.status !== "not_connected" && !(v.status === "ready" && Array.isArray(v.items)))) throw new Error("Invalid urgent email");
  return v;
}
function parseOrders(data: unknown): OrdersSummary {
  const v = data as OrdersSummary | null;
  if (!v || (v.status !== "not_connected" && !(v.status === "ready" && Array.isArray(v.top)))) throw new Error("Invalid orders");
  return v;
}
function parseRenewals(data: unknown): RenewalSummary {
  const v = data as RenewalSummary | null;
  if (!v || (v.status !== "empty" && !(v.status === "ready" && Array.isArray(v.soon) && typeof v.count === "number"))) throw new Error("Invalid renewals");
  return v;
}
function parseExperiment(data: unknown): ExperimentToday {
  if (!isExperimentToday(data)) throw new Error("Invalid experiment arm");
  return data;
}
const READING_URL = "/api/reading";
const URGENT_URL = "/api/urgent-email";
const ORDERS_URL = "/api/orders/summary";
const RENEWALS_URL = "/api/procurement/renewals/summary";
const EXPERIMENT_URL = "/api/experiments/today";
// Today and tomorrow in this device's zone; the server pads the range by a day on each side.
function calendarUrl(): string {
  const firstDay = localDate(new Date());
  return `/api/calendar/events?from=${firstDay}&to=${shiftDate(firstDay, 1)}`;
}
// GET a JSON answer. "Gone" (404 / 410 / 204) removes the cached copy instead of keeping it.
async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { cache: "no-store" });
  if (isGoneStatus(res.status)) { clientCache.remove(url); throw new Error("Gone"); }
  if (!res.ok) throw new Error("Unavailable");
  return res.json();
}
// The cached copy in memory (an instant revisit), checked like a fresh answer.
function cachedLoad<T>(key: string, parse: (data: unknown) => T): Load<T> {
  const raw = clientCache.peek(key);
  if (raw === undefined) return { state: "loading" };
  try { return { state: "ready", value: parse(raw) }; } catch { return { state: "loading" }; }
}
function cachedValue<T>(key: string, parse: (data: unknown) => T): T | null {
  const v = cachedLoad(key, parse);
  return v.state === "ready" ? v.value : null;
}
// A fresh answer replaces what is shown; an identical one keeps the same object so React skips the render.
function fresh<T>(value: T) {
  return (previous: Load<T>): Load<T> => previous.state === "ready" && !previous.stale && sameJson(previous.value, value) ? previous : { state: "ready", value };
}
// A copy read from the device fills a panel that has nothing yet (or only an error); it never replaces a
// fresher answer.
function fromDevice<T>(value: T) {
  return (previous: Load<T>): Load<T> => previous.state === "loading" ? { state: "ready", value } : previous.state === "error" ? { state: "ready", value, stale: true } : previous;
}

export default function TodayClient() {
  // Each panel starts from the cached copy when there is one (a revisit is instant), then revalidates.
  const [inbox, setInbox] = useState<Load<InboxResponse>>(() => cachedLoad(CACHE_KEYS.agentsInbox, parseInbox));
  const [reading, setReading] = useState<Load<ReadingOverview | null>>(() => cachedLoad(READING_URL, parseReading));
  const [urgent, setUrgent] = useState<Load<UrgentEmailResponse>>(() => cachedLoad(URGENT_URL, parseUrgent));
  // Packages are shown only when something needs attention or arrives today, and a failed check
  // just hides the panel: /orders is where package status lives.
  const [orders, setOrders] = useState<OrdersSummary | null>(() => cachedValue(ORDERS_URL, parseOrders));
  // Synced calendar events (read-only copies; see /health). Onyx never writes to the calendar.
  const [calendar, setCalendar] = useState<Load<CalendarEventsResponse>>(() => cachedLoad(calendarUrl(), readCalendarResponse));
  // Today's arm of the running N-of-1 trial (GET /api/experiments/today). Usually "none": no card.
  const [experiment, setExperiment] = useState<Load<ExperimentToday>>(() => cachedLoad(EXPERIMENT_URL, parseExperiment));
  // Subscription renewals (GET /api/procurement/renewals/summary) follow the same rule: shown only
  // when one is due within 3 days; a failed check hides the panel, /procurement has the details.
  const [renewals, setRenewals] = useState<RenewalSummary | null>(() => cachedValue(RENEWALS_URL, parseRenewals));
  // Money alerts (GET /api/finance/alerts): shown when there is something to act on, or when "nothing to act on"
  // is not verified (an older answer that could not be updated, or part of the check missing); every shown answer
  // says how current it is (lib/money-alerts-view.ts). A failed check keeps the last answer, marked.
  const [money, setMoney] = useState<MoneyView | null>(() => cachedValue(MONEY_URL, parseMoneyAnswer));
  // The one follow-up read after an `updating` (older, being recomputed) answer.
  const moneyRecheck = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const sequence = useRef(0);
  const inFlight = useRef(false);
  const lastStarted = useRef(0);
  const [refreshing, setRefreshing] = useState(false);
  // Cleared on this screen: card codes (upper case) and email hide keys. They stay hidden while the
  // servers catch up (a refresh can land before the clear), until Undo.
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const [cleared, setCleared] = useState<Cleared | null>(null);
  const [clearError, setClearError] = useState<string | null>(null);
  const hide = useCallback((cards: string[], emails: EmailClearMark[], on: boolean) => {
    setHidden((previous) => {
      const next = new Set(previous);
      for (const k of [...cards, ...emails.map(hiddenEmailKey)]) {
        if (on) next.add(k);
        else next.delete(k);
      }
      return next;
    });
  }, []);
  const load = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    lastStarted.current = Date.now();
    setRefreshing(true);
    const current = ++sequence.current;
    setInbox((previous) => previous.state === "ready" ? previous : { state: "loading" });
    setReading((previous) => previous.state === "ready" ? previous : { state: "loading" });
    setUrgent((previous) => previous.state === "ready" ? previous : { state: "loading" });
    setCalendar((previous) => previous.state === "ready" ? previous : { state: "loading" });
    setExperiment((previous) => previous.state === "ready" ? previous : { state: "loading" });
    const inboxRequest = bounded(Promise.resolve().then(() => agentsApi.inbox())).then((data) => {
      const value = parseInbox(data);
      if (sequence.current !== current) return;
      clientCache.put(CACHE_KEYS.agentsInbox, value);
      setInbox(fresh(value));
      setCheckedAt(new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
    }).catch(() => { if (sequence.current === current) setInbox((previous) => previous.state === "ready" ? { ...previous, stale: true } : { state: "error" }); });
    // Each GET below: check the answer, cache the raw JSON under its URL (shared with the other pages and the
    // warm-up), then show it. Finance, procurement and experiment answers stay in memory only (lib/client-cache.ts).
    function request<T>(url: string, parse: (data: unknown) => T): Promise<T> {
      return bounded(getJson(url).then((data) => {
        const value = parse(data);
        clientCache.put(url, data);
        return value;
      }));
    }
    const readingRequest = request(READING_URL, parseReading).then((value) => {
      if (sequence.current === current) setReading(fresh(value));
    }).catch(() => { if (sequence.current === current) setReading((previous) => previous.state === "ready" ? { ...previous, stale: true } : { state: "error" }); });
    const urgentRequest = request(URGENT_URL, parseUrgent).then((value) => {
      if (sequence.current === current) setUrgent(fresh(value));
    }).catch(() => { if (sequence.current === current) setUrgent((previous) => previous.state === "ready" ? { ...previous, stale: true } : { state: "error" }); });
    const ordersRequest = request(ORDERS_URL, parseOrders).then((value) => {
      if (sequence.current === current) setOrders((previous) => sameJson(previous, value) ? previous : value);
    }).catch(() => { /* keep the last summary; /orders has the details */ });
    const renewalsRequest = request(RENEWALS_URL, parseRenewals).then((value) => {
      if (sequence.current === current) setRenewals((previous) => sameJson(previous, value) ? previous : value);
    }).catch(() => { /* keep the last summary; /procurement has the details */ });
    const keepMarked = (previous: MoneyView | null): MoneyView | null => previous && !previous.refreshFailed ? { ...previous, refreshFailed: true } : previous;
    const moneyRequest = request(MONEY_URL, parseMoneyAnswer).then((value) => {
      if (sequence.current !== current) return;
      setMoney((previous) => sameJson(previous, value) ? previous : value);
      if (!value.updating) return;
      // An older stored answer, recomputed on the server after it answered: ask once more for the current one
      // (?fresh=1 computes it if the background refresh has not landed). A newer load cancels this.
      if (moneyRecheck.current) clearTimeout(moneyRecheck.current);
      moneyRecheck.current = setTimeout(() => {
        moneyRecheck.current = null;
        if (sequence.current !== current) return;
        void bounded(getJson(MONEY_FRESH_URL).then((data) => {
          const next = parseMoneyAnswer(data);
          clientCache.put(MONEY_URL, data);
          return next;
        })).then((next) => {
          if (sequence.current === current) setMoney((previous) => sameJson(previous, next) ? previous : next);
        }).catch(() => { if (sequence.current === current) setMoney(keepMarked); });
      }, MONEY_RECHECK_MS);
    }).catch(() => { if (sequence.current === current) setMoney(keepMarked); });
    const experimentRequest = request(EXPERIMENT_URL, parseExperiment).then((value) => {
      if (sequence.current === current) setExperiment(fresh(value));
    }).catch(() => { if (sequence.current === current) setExperiment((previous) => previous.state === "ready" ? { ...previous, stale: true } : { state: "error" }); });
    const calendarRequest = request(calendarUrl(), readCalendarResponse).then((value) => {
      if (sequence.current === current) setCalendar(fresh(value));
    }).catch(() => { if (sequence.current === current) setCalendar((previous) => previous.state === "ready" ? { ...previous, stale: true } : { state: "error" }); });
    void Promise.allSettled([inboxRequest, readingRequest, urgentRequest, ordersRequest, renewalsRequest, moneyRequest, experimentRequest, calendarRequest]).then(() => {
      if (sequence.current === current) { inFlight.current = false; setRefreshing(false); }
    });
  }, []);
  // Reopening the app: fill empty panels from the copy kept on this device (IndexedDB) while the network
  // answers. Finance, procurement and experiment answers are never on the device, so they wait for the network.
  useEffect(() => {
    let alive = true;
    function fill<T>(key: string, parse: (data: unknown) => T, apply: (value: T) => void) {
      void clientCache.read(key).then((raw) => {
        if (!alive || raw === undefined) return;
        let value: T;
        try { value = parse(raw); } catch { return; }
        apply(value);
      });
    }
    fill(CACHE_KEYS.agentsInbox, parseInbox, (v) => setInbox(fromDevice(v)));
    fill(READING_URL, parseReading, (v) => setReading(fromDevice(v)));
    fill(URGENT_URL, parseUrgent, (v) => setUrgent(fromDevice(v)));
    fill(calendarUrl(), readCalendarResponse, (v) => setCalendar(fromDevice(v)));
    fill(ORDERS_URL, parseOrders, (v) => setOrders((previous) => previous ?? v));
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    load();
    const visible = () => { if (document.visibilityState === "visible" && Date.now() - lastStarted.current > 60000) load(); };
    document.addEventListener("visibilitychange", visible);
    return () => {
      // Invalidate asynchronous work, not a DOM ref. Also supports Strict Mode remount.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      sequence.current++;
      inFlight.current = false;
      if (moneyRecheck.current) { clearTimeout(moneyRecheck.current); moneyRecheck.current = null; }
      document.removeEventListener("visibilitychange", visible);
    };
  }, [load]);

  useEffect(() => {
    if (!cleared) return;
    const timer = setTimeout(() => setCleared(null), UNDO_MS);
    return () => clearTimeout(timer);
  }, [cleared]);

  /**
   * Clear rows from Today. Cards go to the Worker (the same call as the Agents inbox's Clear), labelled
   * threads to /api/urgent-email/clear. Hidden at once; whichever part fails comes back with a message.
   */
  async function clear(cardCodes: string[], emailMarks: EmailClearMark[], count: number) {
    // Array.from, not spread: tests/today-regression.cjs transpiles this file to ES5.
    const codes = Array.from(new Set(cardCodes.map((c) => c.toUpperCase()))).slice(0, MAX_DISMISS);
    const marks = Array.from(new Map(emailMarks.map((m) => [hiddenEmailKey(m), m] as const)).values()).slice(0, MAX_CLEAR_ITEMS);
    if (codes.length === 0 && marks.length === 0) return;
    hide(codes, marks, true);
    setCleared(null);
    setClearError(null);
    void clearDeviceNotifications();
    const [cardsDone, emailsDone] = await Promise.allSettled([
      codes.length > 0 ? Promise.resolve().then(() => agentsApi.dismiss({ codes })) : Promise.resolve(null),
      marks.length > 0 ? postEmailClear(marks, false) : Promise.resolve(),
    ]);
    if (cardsDone.status === "fulfilled" && cardsDone.value) setBadge(cardsDone.value.badge);
    const okCards = cardsDone.status === "fulfilled" ? codes : [];
    const okEmails = emailsDone.status === "fulfilled" ? marks : [];
    if (cardsDone.status === "rejected") hide(codes, [], false);
    if (emailsDone.status === "rejected") hide([], marks, false);
    if (cardsDone.status === "rejected" || emailsDone.status === "rejected") {
      setClearError(okCards.length + okEmails.length > 0 ? "Some of that couldn't be cleared and is back on the list. Try again." : "Couldn't clear that. Try again.");
    }
    if (okCards.length + okEmails.length > 0) setCleared({ cards: okCards, emails: okEmails, text: clearedLabel(count) });
  }

  async function undoClear() {
    const last = cleared;
    setCleared(null);
    setClearError(null);
    if (!last) return;
    const [cardsBack, emailsBack] = await Promise.allSettled([
      last.cards.length > 0 ? Promise.resolve().then(() => agentsApi.dismiss({ codes: last.cards, undo: true })) : Promise.resolve(null),
      last.emails.length > 0 ? postEmailClear(last.emails, true) : Promise.resolve(),
    ]);
    if (cardsBack.status === "fulfilled") {
      hide(last.cards, [], false);
      if (cardsBack.value) setBadge(cardsBack.value.badge);
    }
    if (emailsBack.status === "fulfilled") hide([], last.emails, false);
    const failedCards = cardsBack.status === "rejected" ? last.cards : [];
    const failedEmails = emailsBack.status === "rejected" ? last.emails : [];
    if (failedCards.length + failedEmails.length > 0) {
      setClearError("Couldn't undo that. Try again.");
      setCleared({ cards: failedCards, emails: failedEmails, text: "Still cleared" });
    }
  }

  const cards = inbox.state === "ready" ? inbox.value.items.filter((item): item is RequestCard => item.kind === "card" && !hidden.has(item.card.code.toUpperCase())) : [];
  // inbox-triage's "Urgent: ..." email questions are shown once, under Urgent email.
  const emailCards = cards.filter((item) => isEmailCard(item.card));
  const requests = cards.filter((item) => !isEmailCard(item.card));
  const pending = refreshing || inbox.state === "loading" || reading.state === "loading" || urgent.state === "loading" || calendar.state === "loading";
  const unavailable = inbox.state === "error" || reading.state === "error" || urgent.state === "error" || (inbox.state === "ready" && inbox.stale) || (reading.state === "ready" && reading.stale) || (urgent.state === "ready" && urgent.stale) || experiment.state === "error" || (experiment.state === "ready" && experiment.stale) || calendar.state === "error" || (calendar.state === "ready" && calendar.stale);
  // "none" (no trial registered, the usual case) and "not_connected" render nothing at all.
  const trial = experiment.state === "ready" && experiment.value.status !== "none" && experiment.value.status !== "not_connected" ? experiment.value : null;
  const email = urgent.state === "ready" && urgent.value.status === "ready" ? urgent.value : null;
  const emailItems = (email?.items ?? []).filter((item) => !hidden.has(hiddenEmailKey(item)));
  const merged = mergeUrgent(emailItems, emailCards, URGENT_SHOWN);
  // Clear all takes everything the panel knows about, not only the rows on screen.
  const allUrgent = merged.total > merged.items.length ? mergeUrgent(emailItems, emailCards, Infinity).items : merged.items;
  const now = new Date();
  const lastSync = email?.lastSync ?? null;
  const syncStale = !!lastSync && (now.getTime() - new Date(lastSync.at).getTime() > LABEL_SYNC_STALE_MS || lastSync.status !== "success");
  const book = reading.state === "ready" ? reading.value : null;
  const packages = orders?.status === "ready" && (orders.attention > 0 || orders.arrivingToday > 0) ? orders : null;
  // The table can exist before the first sync run: no run and no events is "not connected yet", not "nothing on".
  const agenda = calendar.state === "ready" && calendar.value.status === "ready" && (calendar.value.lastSync || calendar.value.events.length > 0) ? calendar.value : null;
  const calendarOff = calendar.state === "ready" && !agenda;
  const todayDate = localDate(now);
  const calendarDays = [{ day: todayDate, name: "Today" }, { day: shiftDate(todayDate, 1), name: "Tomorrow" }];
  const agendaByDay = agenda ? eventsByDay(agenda.events, calendarDays[0].day, calendarDays[1].day) : null;
  const calendarSync = agenda ? syncHealth(agenda.lastSync, now.getTime()) : "never";
  const renewing = renewals?.status === "ready" && renewals.count > 0 ? renewals : null;
  const moneyStatus = money ? moneyNote(money, now) : null;
  return (
    <div className={styles.today}>
      <header className={styles.header}>
        <div><p className={styles.eyebrow}>YOUR DAILY OVERVIEW</p>
          <h1 data-testid="page-heading" className={styles.title}>Today</h1>
          <p className="mt-2 text-sm text-text-secondary">Less catching up. More moving forward.</p></div>
        <button type="button" onClick={() => { if (!pending) load(); }} aria-disabled={pending} aria-label="Refresh Today"
          className={styles.refresh}>
          <RefreshCw aria-hidden="true" className={`h-4 w-4 ${pending ? "animate-spin motion-reduce:animate-none" : ""}`} />
          <span>{pending ? "Refreshing" : "Refresh"}</span>
        </button>
      </header>
      <section aria-label="Quick capture" className={styles.capture}>
        <div className={styles.captureLead}>
          <span className={styles.captureIcon}><ClipboardCheck aria-hidden="true" className="h-6 w-6" /></span>
          <div><p className={styles.eyebrow}>START HERE</p><h2 className="mt-2 text-2xl font-medium text-text-primary">A moment for you.</h2>
            <p className="mt-2 max-w-md text-sm leading-relaxed text-text-secondary">Start or continue your check-in. Capture what you know, and leave the rest for later.</p></div>
          <Link href="/check-in" className={styles.primaryAction}>Start your check-in <ArrowUpRight aria-hidden="true" className="h-4 w-4" /></Link>
        </div>
        <div className={styles.captureOptions}>
          <p className={styles.eyebrow}>OR LOG SOMETHING QUICKLY</p>
          <Link href="/supplements" className={styles.captureLink}><span>Supplement<span className={styles.caption}>Your stack &amp; intake</span></span><ArrowUpRight aria-hidden="true" className="h-4 w-4" /></Link>
          <Link href="/habits" className={styles.captureLink}><span>Habit<span className={styles.caption}>Record a daily habit</span></span><ArrowUpRight aria-hidden="true" className="h-4 w-4" /></Link>
          <Link href="/nutrition?log=weight" className={styles.captureLink}><span>Weight<span className={styles.caption}>Log today&apos;s weight</span></span><ArrowUpRight aria-hidden="true" className="h-4 w-4" /></Link>
        </div>
      </section>
      <nav aria-label="Today sections" className={styles.jumpLinks}>
        <a href="#requests-heading"><span>Needs your input</span><span>{inbox.state === "ready" ? requests.length : "—"}</span></a>
        <a href="#urgent-email-heading"><span>Urgent email</span><span>{urgent.state === "ready" && inbox.state === "ready" ? merged.total : "—"}</span></a>
        <a href="#calendar-heading"><span>Your schedule</span><CalendarDays aria-hidden="true" className="h-4 w-4" /></a>
        <a href="#reading-heading"><span>Keep reading</span><BookOpen aria-hidden="true" className="h-4 w-4" /></a>
      </nav>
      <p role="status" aria-live="polite" className="sr-only">{pending ? "Refreshing Today" : unavailable ? "Some information could not be refreshed. Check the section messages." : "Today refresh finished"}</p>
      {experiment.state === "error" && <div role="region" aria-label="Experiment arm" className={panelStyle}>
        <p className="text-sm text-text-secondary">Couldn&apos;t check today&apos;s experiment arm. Try refreshing.</p>
      </div>}
      {trial && <div role="region" aria-labelledby="experiment-heading" className={panelStyle}>
        <div className="flex items-center gap-2"><FlaskConical aria-hidden="true" className="h-5 w-5 text-accent" />
          <h2 id="experiment-heading" className="text-lg font-medium text-text-primary">{trial.status === "active" ? "Today's experiment arm" : "Experiment"}</h2></div>
        {trial.status === "active" && <>
          <p className="mt-1 break-words text-xs text-text-secondary">{trial.experimentId}: {trial.title}. Day {trial.dayNumber} of {trial.nDays} ({dayLabel(trial.behavioralDate)}).</p>
          <p className="mt-3 text-base font-medium text-text-primary">Arm {trial.arm}</p>
          <p className="mt-1 break-words text-sm text-text-primary">{trial.instruction}</p>
          <p className="mt-3 text-xs text-text-secondary">It applies until you go to sleep, also after midnight. Tomorrow&apos;s arm is not shown until tomorrow. Opening Today does not record whether you followed it.</p>
        </>}
        {trial.status === "upcoming" && <p className="mt-3 break-words text-sm text-text-primary">{trial.experimentId}: {trial.title} starts {dayLabel(trial.startDate)} and runs {trial.nDays} days. No arm today.</p>}
        {trial.status === "paused" && <p className="mt-3 break-words text-sm text-text-primary">{trial.experimentId}: {trial.title} is paused. No arm today.</p>}
        {experiment.state === "ready" && experiment.stale && <p className="mt-3 text-sm text-mid">Couldn&apos;t refresh the experiment arm. Showing the last check.</p>}
      </div>}
      <div className={styles.workspace}>
      <div className={styles.attention}>
        <div className={styles.sectionLabel}><span>01</span><h2>What needs you</h2></div>
      <section className={panelStyle} aria-labelledby="requests-heading" aria-busy={inbox.state === "loading"}>
        <div className="flex items-center justify-between gap-4">
          <h2 id="requests-heading" className="text-lg font-medium text-text-primary">Needs your input</h2>
          <div className="flex items-center gap-4">
            {requests.length > 0 && <button type="button" onClick={() => void clear(requests.map((r) => r.card.code), [], requests.length)} aria-label="Clear all requests" className={clearAllStyle}>Clear all</button>}
            <Link href="/agents?view=unread" className={linkStyle}>Open inbox</Link>
          </div>
        </div>
        {inbox.state === "loading" && <p className="mt-4 text-sm text-text-secondary">Checking agent requests...</p>}
        {inbox.state === "error" && <p className="mt-4 text-sm text-text-secondary">Couldn&apos;t check requests. Open your inbox or try refreshing.</p>}
        {inbox.state === "ready" && <>
          {inbox.stale && <p className="mt-3 text-sm text-mid">Couldn&apos;t refresh requests. Showing the last check from {checkedAt}; these requests may have changed.</p>}
          {requests.length === 0 ? <p className="mt-4 text-sm text-text-secondary">The last check returned no open requests. Messages and updates are in your inbox.</p> : <>
            <p className="mt-2 text-xs text-text-secondary">Showing {Math.min(requests.length, 3)} of {requests.length} requests returned, in inbox order.</p>
            <ul className="mt-4 divide-y divide-border-subtle">
              {requests.slice(0, 3).map((item) => <li key={`${item.thread}:${item.messageId}:${item.card.code}`} className="flex items-center gap-1">
                <Link href={requestHref(item)} className="group flex min-w-0 flex-1 items-center justify-between gap-3 rounded-control py-4 focus-visible:outline-2 focus-visible:outline-accent">
                  <span className="min-w-0"><span className="block text-xs text-text-secondary">{item.card.agent || "Agent"}</span>
                    <span className="mt-1 block break-words text-sm font-medium text-text-primary">{item.card.name}</span>
                    <span className="mt-1 block text-xs text-accent">Review request</span></span>
                  <ArrowUpRight aria-hidden="true" className="h-4 w-4 shrink-0 text-text-secondary" />
                </Link>
                <button type="button" onClick={() => void clear([item.card.code], [], 1)} aria-label={`Clear: ${item.card.name}`} className={clearOneStyle}>
                  <X aria-hidden="true" className="h-4 w-4" />
                </button>
              </li>)}
            </ul>
            {requests.length > 3 && <Link href="/agents?view=unread" className={linkStyle}>See the rest in your inbox</Link>}
          </>}
          {emailCards.length > 0 && <p className="mt-3 text-xs text-text-secondary">{emailCards.length === 1 ? "1 email request is" : `${emailCards.length} email requests are`} listed under Urgent email instead.</p>}
          <p className="mt-4 text-xs text-text-secondary">Inbox checked at {checkedAt}. Opening Today does not mark anything read.{requests.length > 0 ? " Clearing a request also clears it from your inbox's Unread list; the agent still waits for an answer." : ""}</p>
        </>}
      </section>
      <section className={panelStyle} aria-labelledby="urgent-email-heading" aria-busy={urgent.state === "loading"}>
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2"><Mail aria-hidden="true" className="h-5 w-5 text-accent" />
            <h2 id="urgent-email-heading" className="text-lg font-medium text-text-primary">Urgent email</h2></div>
          {urgent.state !== "loading" && allUrgent.length > 0 && <button type="button" aria-label="Clear all urgent email"
            onClick={() => void clear(allUrgent.flatMap((i) => i.clear.cards), allUrgent.flatMap((i) => i.clear.emails), allUrgent.length)} className={clearAllStyle}>Clear all</button>}
        </div>
        <p className="mt-1 text-xs text-text-secondary">From inbox-triage: threads it labelled Agent/Action or Agent/Deadline, and its urgent questions in your agent inbox.</p>
        {urgent.state === "loading" && <p className="mt-3 text-sm text-text-secondary">Checking email...</p>}
        {urgent.state === "error" && <p className="mt-3 text-sm text-text-secondary">{emailCards.length > 0 ? "Couldn't check the email labels. Showing inbox-triage's requests only." : "Couldn't check urgent email. Try refreshing."}</p>}
        {urgent.state === "ready" && urgent.stale && <p className="mt-3 text-sm text-mid">Couldn&apos;t refresh the email labels. Showing the last check; it may have changed.</p>}
        {urgent.state === "ready" && urgent.value.status === "not_connected" && <p className="mt-3 text-sm text-text-primary">The email label sync isn&apos;t connected yet{emailCards.length > 0 ? ", so only inbox-triage's requests are shown." : "."}</p>}
        {inbox.state === "error" && urgent.state !== "loading" && <p className="mt-3 text-xs text-text-secondary">Agent requests couldn&apos;t be checked, so inbox-triage&apos;s urgent questions may be missing here.</p>}
        {urgent.state !== "loading" && (merged.items.length > 0 ? <>
          <p className="mt-2 text-xs text-text-secondary">Showing {merged.items.length} of {merged.total}, most pressing first.</p>
          <ul className="mt-2 divide-y divide-border-subtle" aria-label="Urgent email">
            {merged.items.map((item) => <li key={item.key} className="flex items-start gap-1 py-4"><div className="min-w-0 flex-1">
              <p className="break-words text-xs text-text-secondary">{item.sourceDetail}. {item.atVerb} {ageLabel(item.at, now)}.</p>
              <p className="mt-1 break-words text-sm font-medium text-text-primary">{item.title}</p>
              {item.from && <p className="mt-0.5 break-words text-xs text-text-secondary">From {item.from}</p>}
              {item.reasons.length > 0 && <p className="mt-1 break-words text-xs text-text-secondary">Why: {item.reasons.join("; ")}</p>}
              <p className="mt-1 break-words text-xs text-text-primary">Next: {item.nextStep}</p>
              {(item.gmailHref || item.requestHref) && <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                {item.gmailHref && isGmailHref(item.gmailHref) && <a href={item.gmailHref} target="_blank" rel="noopener noreferrer" aria-label={`Open in Gmail: ${item.title}`} className={linkStyle}>Open in Gmail</a>}
                {item.requestHref && <Link href={item.requestHref} aria-label={`Open request: ${item.title}`} className={linkStyle}>Open request</Link>}
              </p>}
            </div>
              <button type="button" onClick={() => void clear(item.clear.cards, item.clear.emails, 1)} aria-label={`Clear: ${item.title}`} className={`${clearOneStyle} -mt-1`}>
                <X aria-hidden="true" className="h-4 w-4" />
              </button>
            </li>)}
          </ul>
        </> : email && <>
          <p className="mt-3 text-sm text-text-secondary">Nothing urgent right now.</p>
          <p className="mt-1 text-xs text-text-secondary">{email.scanned === 0 ? `No labelled threads in the last ${email.windowDays} days.` : `${email.scanned} labelled thread${email.scanned === 1 ? "" : "s"} in the last ${email.windowDays} days; ${email.hidden} left out (archived, older, or past their date)${email.cleared ? `; ${email.cleared} cleared on Today` : ""}.`}</p>
        </>)}
        {email && <p className={`mt-3 text-xs ${syncStale ? "text-mid" : "text-text-secondary"}`}>{lastSync
          ? `Email labels last synced ${ageLabel(lastSync.at, now)}${lastSync.status !== "success" ? ` (that run: ${lastSync.status})` : ""}${syncStale ? "; newer labels may be missing." : "."}`
          : "The email label sync has not run yet."}</p>}
        {urgent.state !== "loading" && <p className="mt-1 text-xs text-text-secondary">Opening or clearing on Today does not mark email read or change any label. A cleared thread comes back if a newer message arrives in it.</p>}
      </section>
      </div>
      <div className={styles.agenda}>
        <div className={styles.sectionLabel}><span>02</span><h2>Your day, at a glance</h2></div>
      <section className={panelStyle} aria-labelledby="calendar-heading" aria-busy={calendar.state === "loading"}>
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2"><CalendarDays aria-hidden="true" className="h-5 w-5 text-accent" />
            <h2 id="calendar-heading" className="text-lg font-medium text-text-primary">Calendar</h2></div>
          <Link href="/health" className={linkStyle}>Open calendar</Link>
        </div>
        <p className="mt-1 text-xs text-text-secondary">Today and tomorrow from {CALENDAR_SOURCE_LABEL}, in this device&apos;s time zone.</p>
        {calendar.state === "loading" && <p className="mt-3 text-sm text-text-secondary">Checking your calendar...</p>}
        {calendar.state === "error" && <p className="mt-3 text-sm text-text-secondary">Couldn&apos;t check the calendar. Try refreshing.</p>}
        {calendar.state === "ready" && calendar.stale && <p className="mt-3 text-sm text-mid">Couldn&apos;t refresh the calendar. Showing the last check; it may have changed.</p>}
        {calendarOff && <p className="mt-3 text-sm text-text-primary">The calendar sync isn&apos;t connected yet.</p>}
        {agenda && agendaByDay && <>
          {calendarDays.map(({ day, name }) => {
            const events = agendaByDay.get(day) ?? [];
            return <div key={day} className="mt-4">
              <h3 className="text-xs font-medium text-text-secondary">{name} · {calendarDayLabel(day)}</h3>
              {events.length === 0 ? <p className="mt-2 text-sm text-text-secondary">Nothing on the calendar.</p>
                : <ul className="mt-1 divide-y divide-border-subtle" aria-label={`Calendar events ${name.toLowerCase()}`}>
                  {events.slice(0, CALENDAR_SHOWN).map((event) => <li key={event.key} className="py-3">
                    <p className="break-words text-xs text-text-secondary">{timeLabel(event, day)}{event.status === "tentative" ? " · Tentative" : ""} · {event.calendar}</p>
                    <p className="mt-0.5 break-words text-sm font-medium text-text-primary">{eventTitle(event)}</p>
                    {event.location && <p className="mt-0.5 break-words text-xs text-text-secondary">{event.location}</p>}
                  </li>)}
                </ul>}
              {events.length > CALENDAR_SHOWN && <p className="mt-1 text-xs text-text-secondary">And {events.length - CALENDAR_SHOWN} more {name.toLowerCase()}.</p>}
            </div>;
          })}
          <p className={`mt-4 text-xs ${calendarSync === "ok" ? "text-text-secondary" : "text-mid"}`}>{agenda.lastSync
            ? `Calendar last synced ${ageLabel(agenda.lastSync.at, now)}${agenda.lastSync.status !== "success" ? ` (that run: ${agenda.lastSync.status})` : ""}${calendarSync === "ok" ? "." : "; newer changes may be missing."}`
            : "The calendar sync has not reported a run yet; these events may be out of date."}</p>
        </>}
        {calendar.state !== "loading" && <p className="mt-1 text-xs text-text-secondary">Read-only: opening Today changes nothing on your calendar.</p>}
      </section>
      </div>
      </div>
      <div className={styles.sectionLabel}><span>03</span><h2>Keep life moving</h2></div>
      <div className={styles.lifeGrid}>
      {packages && <section className={panelStyle} aria-labelledby="packages-heading">
        <div className="flex items-center gap-2"><Package aria-hidden="true" className="h-5 w-5 text-accent" />
          <h2 id="packages-heading" className="text-lg font-medium text-text-primary">Packages</h2></div>
        <p className="mt-3 text-sm text-text-primary">{[
          packages.attention > 0 ? `${packages.attention} need${packages.attention === 1 ? "s" : ""} attention` : null,
          packages.arrivingToday > 0 ? `${packages.arrivingToday} arriving today` : null,
        ].filter(Boolean).join(" · ")}</p>
        {packages.top.length > 0 && <ul className="mt-2 space-y-2" aria-label="Packages that need attention">
          {packages.top.map((t, i) => <li key={i} className="text-xs text-text-secondary"><span className="text-text-primary">{t.merchant}: {t.label}.</span> {t.reason}</li>)}
        </ul>}
        <Link href="/orders" className={`${linkStyle} mt-4 inline-block`}>Open orders</Link>
      </section>}
      {money && showMoneyPanel(money) && <section className={panelStyle} aria-labelledby="money-heading" aria-busy={money.updating && !money.refreshFailed}>
        <div className="flex items-center gap-2"><Wallet aria-hidden="true" className="h-5 w-5 text-accent" />
          <h2 id="money-heading" className="text-lg font-medium text-text-primary">Money</h2></div>
        {money.alerts.length > 0 && <ul className="mt-3 space-y-2" aria-label="Money alerts">
          {money.alerts.slice(0, 5).map((a, i) => <li key={i} className="break-words">
            <Link href={a.href} className={`text-sm ${a.severity === "high" ? "text-down" : "text-text-primary"} hover:underline`}>{a.title}</Link>
            <p className="text-xs text-text-secondary">{a.detail}</p>
          </li>)}
        </ul>}
        {moneyStatus && <p className={`mt-3 text-sm ${moneyStatus.tone === "warn" ? "text-amber-300" : "text-text-secondary"}`}>{moneyStatus.text}</p>}
        <p className="mt-2 text-xs text-text-secondary">From your forecast and budgets. Onyx never moves money.</p>
        <Link href="/financials/budgets" className={`${linkStyle} mt-4 inline-block`}>Open budgets</Link>
      </section>}
      {renewing && <section className={panelStyle} aria-labelledby="renewals-heading">
        <div className="flex items-center gap-2"><CalendarClock aria-hidden="true" className="h-5 w-5 text-accent" />
          <h2 id="renewals-heading" className="text-lg font-medium text-text-primary">Renewals</h2></div>
        <p className="mt-3 text-sm text-text-primary">{renewing.count === 1 ? "1 subscription is" : `${renewing.count} subscriptions are`} expected to renew in the next {renewing.withinDays} days.</p>
        <ul className="mt-2 space-y-1" aria-label="Subscriptions renewing soon">
          {renewing.soon.map((r, i) => <li key={i} className="break-words text-xs text-text-secondary"><span className="text-text-primary">{r.merchant}</span> {r.label}</li>)}
        </ul>
        {renewing.count > renewing.soon.length && <p className="mt-1 text-xs text-text-secondary">And {renewing.count - renewing.soon.length} more.</p>}
        <p className="mt-2 text-xs text-text-secondary">Estimated from past charges in your ledger. Onyx never pays or cancels anything.</p>
        <Link href="/procurement" className={`${linkStyle} mt-4 inline-block`}>Open procurement</Link>
      </section>}
      <section className={panelStyle} aria-labelledby="reading-heading" aria-busy={reading.state === "loading"}>
        <div className="flex items-center gap-2"><BookOpen aria-hidden="true" className="h-5 w-5 text-accent" />
          <h2 id="reading-heading" className="text-lg font-medium text-text-primary">Keep reading</h2></div>
        {reading.state === "loading" && <p className="mt-3 text-sm text-text-secondary">Loading reading progress...</p>}
        {reading.state === "error" && <p className="mt-3 text-sm text-text-secondary">Reading progress is unavailable right now.</p>}
        {reading.state === "ready" && reading.stale && <p className="mt-3 text-sm text-mid">Couldn&apos;t refresh reading. Showing previously loaded progress.</p>}
        {reading.state === "ready" && (book ? <>
          <p className="mt-3 text-base font-medium text-text-primary">{book.book.title}</p>
          <p className="mt-1 text-sm text-text-secondary">{Number.isFinite(book.chaptersDone) && Number.isFinite(book.totalChapters) && book.totalChapters > 0 && book.chaptersDone >= 0 && book.chaptersDone <= book.totalChapters ? `${book.chaptersDone} of ${book.totalChapters} chapters recorded.` : "Chapter progress is not available."}</p>
          <p className="mt-1 text-xs text-text-secondary">Recorded progress may lag your latest reading.</p>
        </> : <p className="mt-3 text-sm text-text-secondary">No book is currently in progress.</p>)}
        <Link href="/reading" className={`${linkStyle} mt-4 inline-block`}>{book ? "Continue reading" : "Open reading"}</Link>
      </section>
      <section className={panelStyle} aria-labelledby="checkin-heading">
        <div className="flex items-center gap-2"><ClipboardCheck aria-hidden="true" className="h-5 w-5 text-accent" />
          <h2 id="checkin-heading" className="text-lg font-medium text-text-primary">A moment to check in</h2></div>
        <p className="mt-3 text-sm text-text-secondary">Start or continue your check-in. Answer what you know; leave the rest blank.</p>
        <Link href="/check-in" className={`${linkStyle} mt-4 inline-block`}>Open check-in</Link>
      </section>
      </div>
      <TodayOverview />
      <nav aria-label="More places" className={styles.footer}>
        <Link href="/status" className={linkStyle}>System status</Link>
        <Link href="/nyc" className={linkStyle}>NYC search</Link>
        <Link href="/sleep" className={linkStyle}>Sleep &amp; recovery</Link>
      </nav>
      {(cleared || clearError) && <div role="status" aria-label="Clear result"
        className="fixed left-1/2 z-40 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-4 rounded-full border border-border-default bg-surface-raised px-4 py-2 text-sm text-text-primary shadow-elevated bottom-[calc(env(safe-area-inset-bottom)+5.5rem)] md:bottom-6">
        <span className="min-w-0">{clearError ?? cleared?.text}</span>
        {cleared && (cleared.cards.length > 0 || cleared.emails.length > 0) && <button type="button" onClick={() => void undoClear()} className="shrink-0 font-medium text-accent focus-visible:outline-2 focus-visible:outline-accent">Undo</button>}
        {clearError && !cleared && <button type="button" onClick={() => setClearError(null)} aria-label="Dismiss message" className="shrink-0 text-text-secondary"><X aria-hidden="true" className="h-4 w-4" /></button>}
      </div>}
    </div>
  );
}
