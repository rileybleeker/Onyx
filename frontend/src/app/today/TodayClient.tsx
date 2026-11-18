"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { lapseDelay } from "@/lib/today-lapse";
import Link from "next/link";
import styles from "./Today.module.css";
import { ArrowUpRight, BookOpen, CalendarClock, CalendarDays, ClipboardCheck, FlaskConical, ListChecks, Mail, Package, RefreshCw, TabletSmartphone, Wallet, X } from "lucide-react";
import { agentsApi, clearDeviceNotifications, setBadge, type InboxResponse, type InboxItem } from "@/lib/agents-api";
import type { ReadingOverview } from "@/lib/reading";
import { actionHref, actionText, nextAction } from "@/lib/learning-pacing";
import { useLearningPrefs } from "@/lib/use-learning-prefs";
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
import { MONEY_FRESH_URL, MONEY_RECHECK_MS, MONEY_URL, moneyIncomplete, moneyNote, parseMoneyAnswer, showMoneyPanel, type MoneyView } from "@/lib/money-alerts-view";
// Import-free too: the first load takes the reads the page's HTML already started (app/today/EarlyReads.tsx).
import { earlyOr } from "@/lib/early-fetch";
// Import-free too: "Practice · N ready" is the overview's own helper (bundled by name in the same test).
import { practiceReady } from "@/lib/reading-practice-ready";
// One card per area of the app under Today's own panels (loaded as its own chunk; components/overview/).
import TodayOverview from "@/components/overview/TodayOverview";
// Import-free too (bundled by name in the same test): the attention model (PROD-T04) and the quiet view settings,
// snooze / hide marks and row widths (PROD-T05).
import { MAX_BUDGET, MIN_BUDGET, SOURCE_LABEL, URGENCY_LABEL, canSetAside, easternDate, fullList, markFor, markKey, parseMarks, pruneMarks, selectQuiet, snoozeEnd, syncLateness, todayAttention,
  type AttentionMark, type Obligation, type SourceProbe, type SourceStatus } from "@/lib/today-attention";
import { adoptQuiet, lifeLayout, pushQuiet, quietBootScript, quietUnsent, readMarks, readQuiet, removeQuietBoot, serverQuiet, setQuiet, subscribeQuiet, syncQuiet,
  writeMarks, type QuietSettings } from "@/lib/today-view";
import InfoHint from "@/components/InfoHint";
// Personalize: every panel of Today is a part. Today is rendered on the server (static) and hydrates, so the grid
// runs in CSS mode: the DOM keeps the default order and a saved order / hidden part is painted before React runs.
// One container holds every panel and the three section headings, so a panel can be moved into another section.
import { Part, PartGrid, usePartOrder } from "@/components/personalize/PartGrid";
// The wind-down streak (PROD-SLEEP-01, set up on Log): the same panel as on Log, and one quiet-view source once set up.
import WindDownPanel, { useWindDownToday } from "@/components/sleep/WindDownPanel";
import HomeResetPanel from "@/components/HomeResetPanel";
import { useHomeResetToday } from "@/lib/use-home-reset";
import { useIphoneUpdate } from "@/lib/use-iphone-update";
import { showUpdateCard } from "@/lib/iphone-update";

type Load<T> = { state: "loading" } | { state: "error" } | { state: "ready"; value: T; stale?: boolean };
type RequestCard = Extract<InboxItem, { kind: "card" }>;
// GET /api/orders/summary (online orders read from shipping emails; see /orders).
type OrdersSummary = { status: "not_connected" } | { status: "ready"; attention: number; arrivingToday: number; onTheWay: number;
  top: { merchant: string; label: string; reason: string }[]; attentionVersion?: string; arrivingVersion?: string;
  lastSync?: { at: string; status: string } | null };
// Roles (PROD-T05): the page title, then section headings (Today.module.css .sectionLabel), then card titles
// (titleStyle), then metadata (text-xs, secondary). Secondary links are plain underlined text; the one filled
// accent control is the primary Log action. Every card has the same padding (20 px on a phone, 24 px wider).
const linkStyle = "text-sm text-text-primary underline decoration-text-secondary underline-offset-4 hover:text-accent hover:decoration-accent focus-visible:outline-2 focus-visible:outline-accent";
const panelStyle = `${styles.panel} rounded-card border border-border-default bg-surface-card p-5 sm:p-6`; // shadow-card via styles.panel
const titleStyle = "text-base font-semibold text-text-primary";
const iconStyle = "h-5 w-5 shrink-0 text-text-secondary";
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
// The package email check runs every 3 h (same threshold as /orders).
const ORDERS_SYNC_STALE_MS = 6 * 3_600_000;
// Today's parts in default order (the "Keep life moving" ones are added when the data shows them).
const TODAY_HEAD_PARTS = ["start-here", "quick-log", "jump-links"];
const TODAY_MID_PARTS = ["heading-needs-you", "requests", "urgent-email", "heading-your-day", "calendar", "heading-keep-moving"];
// While Today stays on screen it checks again this often (the app is often left open on the desktop).
const VISIBLE_REFRESH_MS = 5 * 60_000;
// The three "Keep life moving" checks that show a panel only when something is due. Their state is tracked so
// "nothing due" (checked) never looks the same as "not checked" (Codex #191 UI 3).
type LifeCheck = { state: "checking" | "ok" | "failed"; at: number | null };
type LifeChecks = { orders: LifeCheck; renewals: LifeCheck; money: LifeCheck };
const NOT_CHECKED: LifeCheck = { state: "checking", at: null };
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
// The renewals answer and how current it is, like the money alerts: `updating` = an older stored detection is being
// recomputed (asOf = when it was computed), so "nothing renews" is not confirmed until the ?fresh=1 follow-up read
// answers; `refreshFailed` = that follow-up failed.
type RenewalsView = RenewalSummary & { asOf: string | null; updating: boolean; refreshFailed: boolean };
function parseRenewals(data: unknown): RenewalsView {
  const v = data as (RenewalSummary & { asOf?: unknown; updating?: unknown }) | null;
  if (!v || (v.status !== "empty" && !(v.status === "ready" && Array.isArray(v.soon) && typeof v.count === "number"))) throw new Error("Invalid renewals");
  const asOf = typeof v.asOf === "string" && Number.isFinite(Date.parse(v.asOf)) ? v.asOf : null;
  return { ...v, asOf, updating: v.updating === true, refreshFailed: false };
}
function parseExperiment(data: unknown): ExperimentToday {
  if (!isExperimentToday(data)) throw new Error("Invalid experiment arm");
  return data;
}
// The same URLs are started early by the page's HTML (lib/today-early.ts; tests/early-fetch.test.cjs keeps them equal).
const READING_URL = "/api/reading";
const URGENT_URL = "/api/urgent-email";
const ORDERS_URL = "/api/orders/summary";
const RENEWALS_URL = "/api/procurement/renewals/summary";
// The follow-up read after an `updating` renewals answer (computed before answering; never started early).
const RENEWALS_FRESH_URL = "/api/procurement/renewals/summary?fresh=1";
const EXPERIMENT_URL = "/api/experiments/today";
// Today and tomorrow in this device's zone; the server pads the range by a day on each side.
function calendarUrl(): string {
  const firstDay = localDate(new Date());
  return `/api/calendar/events?from=${firstDay}&to=${shiftDate(firstDay, 1)}`;
}
// GET a JSON answer. "Gone" (404 / 410 / 204) removes the cached copy instead of keeping it. `early`: the first load
// of a full page visit, which takes the GET the page's HTML already started for this URL, if any (lib/today-early.ts).
async function getJson(url: string, early = false): Promise<unknown> {
  const get = () => fetch(url, { cache: "no-store" });
  const res = await (early ? earlyOr(url, get) : get());
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
// "the check 2 h ago": how old a stored server answer is (`iso`: when it was computed).
function checkAge(iso: string | null, nowMs: number): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return "an earlier check";
  const min = Math.max(0, Math.floor((nowMs - t) / 60_000));
  if (min < 2) return "the check just now";
  if (min < 60) return `the check ${min} min ago`;
  if (min < 48 * 60) return `the check ${Math.floor(min / 60)} h ago`;
  return `the check ${Math.floor(min / 1440)} d ago`;
}
// A copy read from the device fills a panel that has nothing yet (or only an error); it never replaces a
// fresher answer.
function fromDevice<T>(value: T) {
  return (previous: Load<T>): Load<T> => previous.state === "loading" ? { state: "ready", value } : previous.state === "error" ? { state: "ready", value, stale: true } : previous;
}

export default function TodayClient({ headingTestId = "page-heading", feed = false }: { headingTestId?: string; feed?: boolean } = {}) {
  // headingTestId: "feed-page-heading" when shown inside the continuous scroll (components/ContinuousScroll.tsx).
  // feed: drawn inside that scroll (FeedSection.tsx). Scrolling never writes, and reading today's experiment arm
  // stamps it as revealed, so the scroll's Today never asks; it shows the copy /today read this session, if any.
  // Each panel starts from the cached copy when there is one (a revisit is instant), then revalidates.
  const [inbox, setInbox] = useState<Load<InboxResponse>>(() => cachedLoad(CACHE_KEYS.agentsInbox, parseInbox));
  const [reading, setReading] = useState<Load<ReadingOverview | null>>(() => cachedLoad(READING_URL, parseReading));
  // Voluntary learning pacing (PROD-T06): GET only; one optional suggested action under the reading progress.
  const learning = useLearningPrefs();
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
  // An `updating` answer is followed by one ?fresh=1 read (renewalsRecheck), like the money alerts.
  const [renewals, setRenewals] = useState<RenewalsView | null>(() => cachedValue(RENEWALS_URL, parseRenewals));
  const renewalsRecheck = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Money alerts (GET /api/finance/alerts): shown when there is something to act on, or when "nothing to act on"
  // is not verified (an older answer that could not be updated, or part of the check missing); every shown answer
  // says how current it is (lib/money-alerts-view.ts). A failed check keeps the last answer, marked.
  const [money, setMoney] = useState<MoneyView | null>(() => cachedValue(MONEY_URL, parseMoneyAnswer));
  // The one follow-up read after an `updating` (older, being recomputed) answer.
  const moneyRecheck = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [lifeChecks, setLifeChecks] = useState<LifeChecks>({ orders: NOT_CHECKED, renewals: NOT_CHECKED, money: NOT_CHECKED });
  const markCheck = useCallback((key: keyof LifeChecks, ok: boolean) => {
    setLifeChecks((previous) => {
      const next: LifeCheck = ok ? { state: "ok", at: Date.now() } : { state: "failed", at: previous[key].at };
      return { ...previous, [key]: next };
    });
  }, []);
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
  // When each source last answered (ms), for the quiet view's freshness lines. Set only after a successful read.
  // A ref, not state: an identical revalidation must keep its sameJson bail-out (no re-render); every load ends
  // with setRefreshing(false), which renders the current values.
  const freshAt = useRef<Record<string, number>>({});
  // Quiet view (lib/today-view.ts): off by default. A newer copy read from another device on an earlier visit
  // applies as the routed Today opens (never mid-visit); the copy in the continuous scroll only shows it.
  useState(() => {
    if (!feed) adoptQuiet();
    return 0;
  });
  const quiet = useSyncExternalStore(subscribeQuiet, readQuiet, serverQuiet);
  // "Show the full Today page" while the quiet view is on: this visit only.
  const [showFull, setShowFull] = useState(false);
  // Snooze / "hide here" marks: this device only, hashes only, written only after a tap (lib/today-attention.ts).
  const [marks, setMarks] = useState<Readonly<Record<string, AttentionMark>>>(() => readMarks(parseMarks, pruneMarks));
  const [quietNote, setQuietNote] = useState("");
  const [quietSave, setQuietSave] = useState<"idle" | "saving" | "failed">("idle");
  const quietHeading = useRef<HTMLHeadingElement>(null);
  // Bumped when a snooze ends or an item becomes due, so the quiet view renders again on time (no request).
  const [lapseTick, setLapseTick] = useState(0);
  const load = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    lastStarted.current = Date.now();
    setRefreshing(true);
    const current = ++sequence.current;
    const stamp = (source: string) => { freshAt.current[source] = Date.now(); };
    setInbox((previous) => previous.state === "ready" ? previous : { state: "loading" });
    setReading((previous) => previous.state === "ready" ? previous : { state: "loading" });
    setUrgent((previous) => previous.state === "ready" ? previous : { state: "loading" });
    setCalendar((previous) => previous.state === "ready" ? previous : { state: "loading" });
    if (!feed) setExperiment((previous) => previous.state === "ready" ? previous : { state: "loading" });
    const inboxRequest = bounded(Promise.resolve().then(() => agentsApi.inbox({ early: !feed }))).then((data) => {
      const value = parseInbox(data);
      if (sequence.current !== current) return;
      clientCache.put(CACHE_KEYS.agentsInbox, value);
      setInbox(fresh(value));
      stamp("agents");
      setCheckedAt(new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
    }).catch(() => { if (sequence.current === current) setInbox((previous) => previous.state === "ready" ? { ...previous, stale: true } : { state: "error" }); });
    // Each GET below: check the answer, cache the raw JSON under its URL (shared with the other pages and the
    // warm-up), then show it. Finance, procurement and experiment answers stay in memory only (lib/client-cache.ts).
    // The routed page's reads take the answers its HTML started (once each); the scroll's copy never does.
    function request<T>(url: string, parse: (data: unknown) => T): Promise<T> {
      return bounded(getJson(url, !feed).then((data) => {
        const value = parse(data);
        clientCache.put(url, data);
        return value;
      }));
    }
    const readingRequest = request(READING_URL, parseReading).then((value) => {
      if (sequence.current === current) { setReading(fresh(value)); stamp("reading"); }
    }).catch(() => { if (sequence.current === current) setReading((previous) => previous.state === "ready" ? { ...previous, stale: true } : { state: "error" }); });
    const urgentRequest = request(URGENT_URL, parseUrgent).then((value) => {
      if (sequence.current === current) { setUrgent(fresh(value)); stamp("urgent-email"); }
    }).catch(() => { if (sequence.current === current) setUrgent((previous) => previous.state === "ready" ? { ...previous, stale: true } : { state: "error" }); });
    const ordersRequest = request(ORDERS_URL, parseOrders).then((value) => {
      if (sequence.current !== current) return;
      setOrders((previous) => sameJson(previous, value) ? previous : value);
      markCheck("orders", true);
    }).catch(() => { if (sequence.current === current) markCheck("orders", false); /* keep the last summary, marked */ });
    const renewalsRequest = request(RENEWALS_URL, parseRenewals).then((value) => {
      if (sequence.current !== current) return;
      setRenewals((previous) => sameJson(previous, value) ? previous : value);
      markCheck("renewals", true);
      if (!value.updating) return;
      // An older stored detection, recomputed on the server after it answered: not a confirmed answer. Ask once
      // more for the current one (?fresh=1 computes it first); if that fails, it stays marked as not confirmed.
      if (renewalsRecheck.current) clearTimeout(renewalsRecheck.current);
      renewalsRecheck.current = setTimeout(() => {
        renewalsRecheck.current = null;
        if (sequence.current !== current) return;
        void bounded(getJson(RENEWALS_FRESH_URL).then((data) => {
          const next = parseRenewals(data);
          clientCache.put(RENEWALS_URL, data);
          return next;
        })).then((next) => {
          if (sequence.current === current) setRenewals((previous) => sameJson(previous, next) ? previous : next);
        }).catch(() => {
          if (sequence.current === current) setRenewals((previous) => previous && previous.updating && !previous.refreshFailed ? { ...previous, refreshFailed: true } : previous);
        });
      }, MONEY_RECHECK_MS);
    }).catch(() => { if (sequence.current === current) markCheck("renewals", false); /* keep the last summary, marked */ });
    const keepMarked = (previous: MoneyView | null): MoneyView | null => previous && !previous.refreshFailed ? { ...previous, refreshFailed: true } : previous;
    const moneyRequest = request(MONEY_URL, parseMoneyAnswer).then((value) => {
      if (sequence.current !== current) return;
      setMoney((previous) => sameJson(previous, value) ? previous : value);
      markCheck("money", true);
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
    }).catch(() => { if (sequence.current === current) { setMoney(keepMarked); markCheck("money", false); } });
    const experimentRequest = feed ? Promise.resolve() : request(EXPERIMENT_URL, parseExperiment).then((value) => {
      if (sequence.current === current) { setExperiment(fresh(value)); stamp("experiment"); }
    }).catch(() => { if (sequence.current === current) setExperiment((previous) => previous.state === "ready" ? { ...previous, stale: true } : { state: "error" }); });
    const calendarRequest = request(calendarUrl(), readCalendarResponse).then((value) => {
      if (sequence.current === current) { setCalendar(fresh(value)); stamp("calendar"); }
    }).catch(() => { if (sequence.current === current) setCalendar((previous) => previous.state === "ready" ? { ...previous, stale: true } : { state: "error" }); });
    void Promise.allSettled([inboxRequest, readingRequest, urgentRequest, ordersRequest, renewalsRequest, moneyRequest, experimentRequest, calendarRequest]).then(() => {
      if (sequence.current === current) { inFlight.current = false; setRefreshing(false); }
    });
  }, [feed, markCheck]);
  // Reopening the app: fill empty panels from the copy kept on this device (IndexedDB) while the network
  // answers. Finance, procurement and experiment answers, the agents inbox and urgent email are never on the device
  // (memory-only keys, lib/client-cache.ts isSensitiveKey), so they wait for the network (most of those GETs start
  // with the HTML, app/today/EarlyReads.tsx).
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
    fill(READING_URL, parseReading, (v) => setReading(fromDevice(v)));
    fill(calendarUrl(), readCalendarResponse, (v) => setCalendar(fromDevice(v)));
    fill(ORDERS_URL, parseOrders, (v) => setOrders((previous) => previous ?? v));
    return () => { alive = false; };
  }, []);
  useEffect(() => {
    load();
    const visible = () => { if (document.visibilityState === "visible" && Date.now() - lastStarted.current > 60000) load(); };
    document.addEventListener("visibilitychange", visible);
    // Left open and visible: check again every few minutes (load() skips while a check is in flight).
    const tick = setInterval(() => {
      if (document.visibilityState === "visible" && Date.now() - lastStarted.current > VISIBLE_REFRESH_MS) load();
    }, 60_000);
    return () => {
      // Invalidate asynchronous work, not a DOM ref. Also supports Strict Mode remount.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      sequence.current++;
      inFlight.current = false;
      if (moneyRecheck.current) { clearTimeout(moneyRecheck.current); moneyRecheck.current = null; }
      if (renewalsRecheck.current) { clearTimeout(renewalsRecheck.current); renewalsRecheck.current = null; }
      document.removeEventListener("visibilitychange", visible);
      clearInterval(tick);
    };
  }, [load]);

  // The quiet view settings' server copy: read (GET only, nothing is written) once the page has settled, at most
  // every 15 minutes (lib/today-view.ts syncQuiet). A newer copy applies the next time Today opens.
  useEffect(() => {
    if (feed) return undefined;
    const timer = setTimeout(() => {
      void syncQuiet().then((result) => {
        // A newer copy from another device replaced a change made here that was not sent: nothing waits for Retry.
        if (result === "adopted" && !quietUnsent()) setQuietSave((s) => (s === "failed" ? "idle" : s));
      });
    }, 3000);
    return () => clearTimeout(timer);
  }, [feed]);
  // A setting changed here earlier whose send failed: say so (after hydration; the server render cannot know).
  useEffect(() => {
    if (quietUnsent()) setQuietSave("failed");
  }, []);
  // The pre-paint style (quietBootScript) goes once React shows the view this device's copy asked for.
  useEffect(() => {
    if (quiet.on === readQuiet().on) removeQuietBoot();
  });

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
  // Open cards Riley cleared from Unread: not obligations to rank, but still open, so All open items names them.
  const clearedOpen = inbox.state === "ready" ? (inbox.value.dismissedOpen ?? []).filter((item): item is RequestCard => item.kind === "card") : [];
  const pending = refreshing || inbox.state === "loading" || reading.state === "loading" || urgent.state === "loading" || calendar.state === "loading";
  const unavailable = inbox.state === "error" || reading.state === "error" || urgent.state === "error" || (inbox.state === "ready" && inbox.stale) || (reading.state === "ready" && reading.stale) || (urgent.state === "ready" && urgent.stale) || experiment.state === "error" || (experiment.state === "ready" && experiment.stale) || calendar.state === "error" || (calendar.state === "ready" && calendar.stale)
    || lifeChecks.orders.state === "failed" || lifeChecks.renewals.state === "failed" || lifeChecks.money.state === "failed"
    || !!renewals?.refreshFailed || !!money?.refreshFailed;
  // "none" (no trial registered, the usual case) and "not_connected" render nothing at all.
  const trial = experiment.state === "ready" && experiment.value.status !== "none" && experiment.value.status !== "not_connected" ? experiment.value : null;
  const email = urgent.state === "ready" && urgent.value.status === "ready" ? urgent.value : null;
  const emailItems = (email?.items ?? []).filter((item) => !hidden.has(hiddenEmailKey(item)));
  const merged = mergeUrgent(emailItems, emailCards, URGENT_SHOWN);
  // Clear all takes everything the panel knows about, not only the rows on screen.
  const allUrgent = merged.total > merged.items.length ? mergeUrgent(emailItems, emailCards, Infinity).items : merged.items;
  const now = new Date();
  const lastSync = email?.lastSync ?? null;
  // A sync that never ran, or whose heartbeat could not be read (lastSync null), is not a current answer either.
  const syncStale = !!email && syncLateness(lastSync, now.getTime(), LABEL_SYNC_STALE_MS);
  const book = reading.state === "ready" ? reading.value : null;
  // Only a successful read of both the sessions and the settings produces a suggestion (unknown is never "missed").
  const learningAction = book && Array.isArray(book.sessions) && Array.isArray(book.dueReviews) && learning.load !== "loading" ? nextAction({
    prefs: learning.prefs, configured: learning.configured, today: book.today, sessionDates: book.sessions.map((s) => s.session_date),
    dueReviews: book.dueReviews.length, book: { title: book.book.title, status: book.book.status, chaptersDone: book.chaptersDone, totalChapters: book.totalChapters },
  }) : null;
  const learningLine = learningAction ? actionText(learningAction) : "";
  // Chapter questions ready for today's round (READ-QUIZ-01): from the overview's own summary, so no extra request; 0 while the bank is off or an older cached overview has none.
  const practiceCount = practiceReady(book?.practice);
  const packages = orders?.status === "ready" && (orders.attention > 0 || orders.arrivingToday > 0) ? orders : null;
  // The package email check behind the summary is late or failing (an older answer without the field: not known yet,
  // and its fresh read is already running).
  const ordersLate = orders?.status === "ready" && orders.lastSync !== undefined && syncLateness(orders.lastSync, now.getTime(), ORDERS_SYNC_STALE_MS);
  const ordersLateText = "The package email check is late, so newer packages may be missing.";
  // The table can exist before the first sync run: no run and no events is "not connected yet", not "nothing on".
  const agenda = calendar.state === "ready" && calendar.value.status === "ready" && (calendar.value.lastSync || calendar.value.events.length > 0) ? calendar.value : null;
  const calendarOff = calendar.state === "ready" && !agenda;
  const todayDate = localDate(now);
  const calendarDays = [{ day: todayDate, name: "Today" }, { day: shiftDate(todayDate, 1), name: "Tomorrow" }];
  const agendaByDay = agenda ? eventsByDay(agenda.events, calendarDays[0].day, calendarDays[1].day) : null;
  const calendarSync = agenda ? syncHealth(agenda.lastSync, now.getTime()) : "never";
  const renewing = renewals?.status === "ready" && renewals.count > 0 ? renewals : null;
  const moneyStatus = money ? moneyNote(money, now) : null;
  const moneyPanel = !!money && showMoneyPanel(money);
  // "Also checked": one line per check that has no panel, saying what it found, or that it is still checking or
  // could not check. A panel that is shown carries its own "couldn't refresh" note instead.
  const clock = (t: number | null) => t ? new Date(t).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : null;
  type CheckLine = { key: string; label: string; href: string; text: string; warn: boolean; when: string };
  function checkLine(key: keyof LifeChecks, label: string, href: string, hasValue: boolean, found: string): CheckLine {
    const c = lifeChecks[key];
    const at = clock(c.at);
    if (!hasValue) {
      return { key, label, href, text: c.state === "failed" ? "Couldn't check. Try refreshing." : "Checking...", warn: c.state === "failed", when: "" };
    }
    if (c.state === "failed") return { key, label, href, text: `${found} Couldn't refresh; this is from ${at ? `the check at ${at}` : "an earlier visit"}.`, warn: true, when: "" };
    return { key, label, href, text: found, warn: false, when: c.state === "checking" && !at ? "from an earlier visit; checking..." : at ? `checked ${at}` : "" };
  }
  const checkLines: CheckLine[] = [];
  if (!packages) {
    const line = checkLine("orders", "Packages", "/orders", !!orders, orders?.status === "not_connected"
      ? "Package tracking isn't connected yet."
      : `Nothing needs attention or arrives today${orders?.status === "ready" && orders.onTheWay > 0 ? `; ${orders.onTheWay} on the way` : ""}.`);
    checkLines.push(ordersLate && orders ? { ...line, text: `${line.text} ${ordersLateText}`, warn: true } : line);
  }
  // An older stored renewals detection (`updating`) is never a confirmed "nothing renews": it says how old it is
  // while the follow-up read runs, and that it is not confirmed when that read failed.
  const renewalsNote = renewals?.updating && lifeChecks.renewals.state !== "failed"
    ? renewals.refreshFailed
      ? { text: `Not confirmed: this is from ${checkAge(renewals.asOf, now.getTime())} and couldn't be brought up to date.`, warn: true }
      : { text: `From ${checkAge(renewals.asOf, now.getTime())}. Updating...`, warn: false }
    : null;
  if (!renewing) {
    const line = checkLine("renewals", "Renewals", "/procurement", !!renewals, renewals?.status === "ready"
      ? `Nothing renews in the next ${renewals.withinDays} days.`
      : "No subscriptions found in your ledger.");
    checkLines.push(renewalsNote ? { ...line, text: `${line.text} ${renewalsNote.text}`, warn: renewalsNote.warn, when: "" } : line);
  }
  if (!moneyPanel) {
    checkLines.push(checkLine("money", "Money", "/financials/budgets", !!money, moneyStatus ? `No alerts to act on. ${moneyStatus.text}` : "No alerts to act on."));
  }
  const lifeFailed = (key: keyof LifeChecks) => lifeChecks[key].state === "failed";
  const windDown = useWindDownToday();
  const homeReset = useHomeResetToday();
  const everything = useIphoneUpdate();
  const iphoneUpdate = showUpdateCard(everything.status) ? everything.status : null;
  const [updateTapped, setUpdateTapped] = useState(false);
  // "Keep life moving" shows a different number of panels each day: widths that fill whole rows (lib/today-view.ts),
  // counted over the panels Riley's layout shows (a part hidden in Personalize leaves no empty track).
  const lifeParts = [checkLines.length > 0 ? "also-checked" : null, packages ? "packages" : null, money && moneyPanel ? "money" : null, renewing ? "renewals" : null, windDown.show ? "wind-down" : null, homeReset.show ? "home-reset" : null, "reading", "check-in"]
    .filter((id): id is string => id !== null);
  const renderedParts = TODAY_HEAD_PARTS.concat(experiment.state === "error" || trial ? ["experiment"] : [], TODAY_MID_PARTS, lifeParts);
  const lifeW = lifeLayout(usePartOrder("/today", renderedParts), lifeParts);
  const lifeWidth = (id: string) => lifeW[id] ?? "third";

  // ─── Quiet view (PROD-T05): a few ranked obligations from every source (lib/today-attention.ts), each with its
  // source and how current it is. Computed only while it is on; the full page is unchanged either way.
  const nowMs = now.getTime();
  const iso = (t: number | null | undefined) => (t ? new Date(t).toISOString() : null);
  function probe<T>(l: Load<T>, source: string, extra: Partial<SourceProbe> = {}): SourceProbe {
    if (l.state === "loading") return { load: "loading" };
    if (l.state === "error") return { load: "error" };
    // A copy from an earlier visit counts as "checking" until this visit's read lands.
    return { load: "ready", refreshFailed: !!l.stale, checking: refreshing && !freshAt.current[source], asOf: iso(freshAt.current[source]), ...extra };
  }
  function lifeProbe(key: keyof LifeChecks, has: boolean, extra: Partial<SourceProbe> = {}): SourceProbe {
    const c = lifeChecks[key];
    if (!has) return { load: c.state === "failed" ? "error" : "loading" };
    return { load: "ready", refreshFailed: c.state === "failed", checking: c.state === "checking", asOf: iso(c.at), ...extra };
  }
  // The experiment is a source only when it can matter: a trial is on, or the check has not answered (the scroll's
  // copy never asks, so there it counts only for an arm /today already read).
  const experimentSource = trial !== null || (!feed && (experiment.state !== "ready" || !!experiment.stale));
  const moneyGap = money ? moneyIncomplete(money) : null;
  const attention = quiet.on ? todayAttention({
    now,
    requests: { probe: probe(inbox, "agents"), items: requests },
    urgentEmail: {
      probe: probe(urgent, "urgent-email", { connected: !(urgent.state === "ready" && urgent.value.status === "not_connected"), syncLate: syncStale, syncAt: lastSync?.at ?? null, partial: inbox.state === "error" }),
      // Merged by identity only (same thread or message): a request whose Gmail search merely matches an email's
      // words stays its own obligation here (the Urgent email panel still shows them together).
      items: mergeUrgent(emailItems, emailCards, Infinity, { bySearch: false }).items,
      emails: emailItems,
      unreturned: email ? Math.max(0, email.total - email.items.length) : 0,
    },
    experiment: experimentSource ? { probe: probe(experiment, "experiment"), trial } : undefined,
    calendar: { probe: probe(calendar, "calendar", { connected: !calendarOff, syncLate: !!agenda && calendarSync !== "ok", syncAt: agenda?.lastSync?.at ?? null, partial: !!agenda?.truncated }), events: agenda?.events ?? [] },
    money: {
      // A part that could not be read, or a cash forecast whose input check failed (money.cash.eligible false), is
      // partial: "no low-cash alert" is then not an all-clear (moneyIncomplete names what is missing).
      probe: money
        ? { load: "ready", refreshFailed: money.refreshFailed, checking: (money.updating && !money.refreshFailed) || lifeChecks.money.state === "checking", partial: moneyGap !== null, ...(moneyGap ? { partialNote: moneyGap } : {}), asOf: money.asOf ?? iso(lifeChecks.money.at) }
        : lifeProbe("money", false),
      alerts: money?.alerts ?? [],
      // Budgets are monthly (the Eastern month the server computes them for): a budget alert hidden this month comes
      // back next month.
      period: easternDate(now).slice(0, 7),
    },
    // An `updating` answer is checking until its follow-up read lands, and stale (not confirmed) when that failed.
    renewals: { probe: lifeProbe("renewals", !!renewals, renewals?.updating ? { checking: !renewals.refreshFailed, refreshFailed: lifeChecks.renewals.state === "failed" || renewals.refreshFailed, asOf: renewals.asOf } : {}), summary: renewals },
    packages: { probe: lifeProbe("orders", !!orders, { connected: orders?.status !== "not_connected", syncLate: ordersLate, syncAt: orders?.status === "ready" ? orders.lastSync?.at ?? null : null }), summary: orders },
    reading: { probe: probe(reading, "reading"), overview: book },
    windDown: windDown.source ?? undefined,
  }) : null;
  const selection = attention ? selectQuiet(attention.obligations, attention.sources, { budget: quiet.budget, learning: quiet.learning, marks, nowMs }) : null;
  const listed = attention ? fullList(attention.obligations, marks, nowMs) : [];
  // Render again when the selection changes by itself (a snooze ends, an item becomes due): a set-aside item comes
  // back on time even while Today stays open between refreshes. Only a render: nothing is read or written.
  const nextChange = selection?.nextChange ?? null;
  useEffect(() => {
    // `lapseTick` is a dependency so a capped wait re-arms: a lapse more than `LAPSE_CAP_MS` away fires at the cap,
    // increments the tick, and this effect runs again to schedule the next capped wait until the real `nextChange`.
    const delay = lapseDelay(nextChange);
    if (delay === null) return undefined; // null nextChange, or nextChange already passed: nothing left to wait for.
    const timer = setTimeout(() => setLapseTick((n) => n + 1), delay);
    return () => clearTimeout(timer);
  }, [nextChange, lapseTick]);
  const statusOf = new Map<string, SourceStatus>((attention?.sources ?? []).map((st) => [st.source, st] as const));
  const sourceList = (list: SourceStatus[]) => list.map((st) => `${st.label} (${st.note})`).join("; ");
  // A time on another day than today names the day too ("Wed 6:00 AM").
  const clockTime = (t: number | null) => {
    if (!t) return "later";
    const d = new Date(t);
    const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return localDate(d) === todayDate ? time : `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
  };
  // A settings change shows at once and is stored under the UI preference today.quiet (never on open).
  function changeQuiet(next: QuietSettings) {
    setQuietSave("saving");
    void setQuiet(next).then((ok) => setQuietSave(ok ? "idle" : "failed"));
  }
  function retryQuiet() {
    setQuietSave("saving");
    void pushQuiet().then((ok) => setQuietSave(ok ? "idle" : "failed"));
  }
  // Snooze / hide: display only, on this device. The item stays open at its source and in All open items. Never past
  // its own due time: a snooze ends by then, a hide lapses then, and an item already due cannot be set aside.
  function setAside(o: Obligation, kind: "snooze" | "hide") {
    const at = Date.now();
    if (!canSetAside(o, at)) {
      setQuietNote(`${o.title} is due now, so it stays on the list.`);
      quietHeading.current?.focus();
      return;
    }
    const until = kind === "snooze" ? snoozeEnd(o, new Date(at)) : undefined;
    const next = pruneMarks({ ...marks, [markKey(o)]: markFor(o, kind, at, until) }, at);
    setMarks(next);
    const kept = writeMarks(next);
    const back = o.resurfaceAt ? `, back by ${clockTime(o.resurfaceAt)} when it is due` : "";
    setQuietNote(`${kind === "snooze" ? `Snoozed until ${clockTime(until ?? null)}` : `Hidden here until it changes${back}`}. Still open, and listed under All open items.${kept ? "" : " This device couldn't keep that, so it comes back when Today reloads."}`);
    quietHeading.current?.focus();
  }
  function showAgain(o: Obligation) {
    const next: Record<string, AttentionMark> = { ...marks };
    delete next[markKey(o)];
    setMarks(next);
    writeMarks(next);
    setQuietNote(`Shown again: ${o.title}`);
    // The button goes once the item is open again: keep focus on the list, not the page top.
    quietHeading.current?.focus();
  }
  const quietAction = "inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-control px-3 text-xs text-text-secondary hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent";
  const itemTitle = "break-words text-sm font-medium text-text-primary underline decoration-text-secondary underline-offset-4 hover:text-accent";
  function itemLink(o: Obligation) {
    if (o.href && o.external && isGmailHref(o.href)) return <a href={o.href} target="_blank" rel="noopener noreferrer" className={itemTitle}>{o.title}</a>;
    if (o.href && !o.external) return <Link href={o.href} className={itemTitle}>{o.title}</Link>;
    return <span className="break-words text-sm font-medium text-text-primary">{o.title}</span>;
  }
  function quietMeta(o: Obligation) {
    const st = statusOf.get(o.source);
    const warn = !!st && st.state !== "ok" && st.state !== "not_connected";
    return <p className={`break-words text-xs ${warn ? "text-mid" : "text-text-secondary"}`}>{URGENCY_LABEL[o.urgency]} · {SOURCE_LABEL[o.source]}{st ? ` · ${st.note}` : ""}</p>;
  }
  function quietRow(o: Obligation, overBudget: boolean) {
    return <li key={o.id} className="flex items-start gap-2 py-3">
      <div className="min-w-0 flex-1">
        {quietMeta(o)}
        <p className="mt-1">{itemLink(o)}</p>
        <p className="mt-1 break-words text-xs text-text-secondary">Why: {o.reason}{overBudget ? (o.pinned ? ". Today's instruction, so it is always shown" : ". Urgent, so it is shown past your number") : ""}{!o.aggregate && !o.pinned && !canSetAside(o, nowMs) ? ". Due now, so it can't be snoozed or hidden" : ""}</p>
        {o.detail && <p className="mt-0.5 break-words text-xs text-text-secondary">{o.detail}</p>}
      </div>
      {canSetAside(o, nowMs) && <div className="flex shrink-0 flex-col items-end sm:flex-row sm:items-center">
        <button type="button" onClick={() => setAside(o, "snooze")} aria-label={`Snooze until ${clockTime(snoozeEnd(o, now))}: ${o.title}`} className={quietAction}>Snooze</button>
        <button type="button" onClick={() => setAside(o, "hide")} aria-label={`Hide here: ${o.title}`} className={quietAction}>Hide</button>
      </div>}
    </li>;
  }
  const setAsideCount = selection ? selection.setAside.filter((x) => !x.item.learning).length + selection.more : 0;
  const stillChecking = !!selection && selection.unknown.length > 0 && selection.unknown.every((st) => st.state === "checking");
  const budgetChoices = Array.from({ length: MAX_BUDGET - MIN_BUDGET + 1 }, (_, i) => MIN_BUDGET + i);
  return (
    <div className={styles.today}>
      {/* Full page loads: when this device's copy says the quiet view is on, show its slot before React runs. */}
      {!feed && <script dangerouslySetInnerHTML={{ __html: quietBootScript() }} />}
      <header className={styles.header}>
        <div><p className={styles.eyebrow}>YOUR DAILY OVERVIEW</p>
          <h1 data-testid={headingTestId} className={styles.title}>Today</h1>
          <p className="mt-2 text-sm text-text-secondary">Less catching up. More moving forward.</p></div>
        <div className={styles.actions}>
          <button type="button" aria-pressed={quiet.on} onClick={() => changeQuiet({ ...quiet, on: !quiet.on })} className={styles.viewToggle}>
            <ListChecks aria-hidden="true" className="h-4 w-4" /><span>Quiet view</span>
          </button>
          <button type="button" onClick={() => { if (!pending) load(); }} aria-disabled={pending} aria-label="Refresh Today"
            className={styles.refresh}>
            <RefreshCw aria-hidden="true" className={`h-4 w-4 ${pending ? "animate-spin motion-reduce:animate-none" : ""}`} />
            <span>{pending ? "Refreshing" : "Refresh"}</span>
          </button>
        </div>
      </header>
      <p role="status" aria-live="polite" className="sr-only">{pending ? "Refreshing Today" : unavailable ? "Some information could not be refreshed. Check the section messages." : "Today refresh finished"}</p>
      {/* iPhone app update (Riley 2026-11-18: "I should be able to see that there is a new build to install"): a banner at
          the top of Today with one filled Install button, shown only when the phone is behind or has not reported. */}
      {(iphoneUpdate || everything.webBehind) && (() => {
        const parts = [iphoneUpdate ? `iPhone app ${iphoneUpdate.available ?? ""}`.trim() : null, everything.webBehind ? "Onyx web" : null].filter(Boolean).join(" � ");
        const url = iphoneUpdate?.installUrl ?? null;
        const needsTrust = !!iphoneUpdate?.needsTrust;
        // One tap: the install link opens iOS's own install prompt (no re-trust, Developer Mode stays on, because every
        // build is signed with the same certificate and bundle id). The web app reloads onto the newest deployment behind it.
        const onTap = () => {
          setUpdateTapped(true);
          if (everything.webBehind) window.setTimeout(() => window.location.reload(), url ? 2500 : 0);
        };
        const cls = "min-h-11 inline-flex items-center rounded-full bg-accent px-5 text-sm font-medium text-on-accent";
        return <section aria-labelledby="iphone-update-heading" className={`${panelStyle} flex flex-wrap items-center justify-between gap-3`}>
          <div className="flex items-center gap-2 min-w-0"><TabletSmartphone aria-hidden="true" className={iconStyle} />
            <div className="min-w-0"><h2 id="iphone-update-heading" className={titleStyle}>Update available</h2>
            <p className="text-sm text-text-secondary">{parts}</p>
            {updateTapped && needsTrust && <p className="text-sm text-mid">New signing certificate: after the install, open Settings, General, VPN &amp; Device Management and trust the developer. <a href="App-Prefs:General&path=ManagedConfigurationList" className="underline underline-offset-4">Open that Settings page</a></p>}</div></div>
          {url ? <a href={url} onClick={onTap} className={cls}>Update everything</a>
            : iphoneUpdate ? <Link href="/install" onClick={onTap} className={cls}>Update everything</Link>
            : <button type="button" onClick={onTap} className={cls}>Update everything</button>}
        </section>;
      })()}
      {quietSave === "failed" && !quiet.on && <p className="text-xs text-mid">Couldn&apos;t save the quiet view setting to your account; it is kept on this device. <button type="button" onClick={retryQuiet} className="underline underline-offset-4">Retry</button></p>}
      {selection ? <section data-today-quiet="" aria-labelledby="quiet-heading" aria-busy={pending} className={`${panelStyle} ${styles.quiet}`}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <div className="flex items-center gap-1">
            <h2 id="quiet-heading" ref={quietHeading} tabIndex={-1} className={styles.quietTitle}>Your priorities</h2>
            <InfoHint label="the quiet view">Snooze and Hide apply on this device only and never close anything: the item stays listed under All open items. Notifications are not affected.</InfoHint>
          </div>
          <p className="text-xs text-text-secondary">Top {quiet.budget}, most pressing first. Urgent items are always shown.</p>
        </div>
        <p aria-live="polite" className="mt-1 text-xs text-text-secondary">{quietNote}</p>
        {selection.verdict === "clear" && <p className="mt-2 text-sm text-text-primary">Nothing needs you right now. Every source answered.</p>}
        {selection.verdict === "set_aside" && <p className="mt-2 text-sm text-text-primary">Nothing new needs you. {setAsideCount === 1 ? "1 open item is" : `${setAsideCount} open items are`} snoozed, hidden here or past your number; see All open items.</p>}
        {selection.verdict === "unknown" && <p className="mt-2 text-sm text-mid">{stillChecking ? "Still checking your sources..." : "Nothing to show yet, but not every source could be checked, so this is not an all-clear."}</p>}
        {selection.shown.length > 0 && <ol className="mt-2 divide-y divide-border-subtle" aria-label="Priorities">
          {selection.shown.map(({ item, overBudget }) => quietRow(item, overBudget))}
        </ol>}
        {selection.urgentOver > 0 && <p className="mt-2 text-xs text-mid">{selection.urgentOver === 1 ? "1 urgent item is" : `${selection.urgentOver} urgent items are`} shown past your {quiet.budget}.</p>}
        {selection.more > 0 && <p className="mt-2 text-xs text-text-secondary">{selection.more} more open; see All open items.</p>}
        {selection.learning && <div className="mt-4 border-t border-border-subtle pt-3">
          <p className={styles.eyebrow}>OPTIONAL</p>
          <ul aria-label="Optional learning action">{quietRow(selection.learning, false)}</ul>
        </div>}
        <Link href="/log" className={`${styles.primaryAction} mt-4`}>Start your check-in <ArrowUpRight aria-hidden="true" className="h-4 w-4" /></Link>
        {selection.unknown.length > 0 && <p className="mt-3 break-words text-sm text-mid">Not confirmed: {sourceList(selection.unknown)}. Something from {selection.unknown.length === 1 ? "it" : "them"} may be missing.</p>}
        {selection.notConnected.length > 0 && <p className="mt-1 break-words text-xs text-text-secondary">Not connected yet: {selection.notConnected.map((st) => st.label).join(", ")}.</p>}
        <details className="mt-4">
          <summary>All open items ({listed.length})</summary>
          {listed.length === 0 ? <p className="mt-1 text-sm text-text-secondary">Nothing open from the sources that answered.</p>
            : <ul aria-label="All open items" className="mt-1 divide-y divide-border-subtle">
              {listed.map(({ item, state, until }) => <li key={item.id} className="flex items-start gap-2 py-3">
                <div className="min-w-0 flex-1">
                  {quietMeta(item)}
                  <p className="mt-1">{itemLink(item)}</p>
                  <p className="mt-1 break-words text-xs text-text-secondary">{state === "snoozed" ? `Snoozed until ${clockTime(until)}. ` : state === "hidden" ? `Hidden here until it changes${until ? `, back by ${clockTime(until)} when it is due` : ""}. ` : ""}{item.learning ? "Optional. " : ""}Why: {item.reason}</p>
                </div>
                {state !== "open" && <button type="button" onClick={() => showAgain(item)} aria-label={`Show again: ${item.title}`} className={quietAction}>Show again</button>}
              </li>)}
            </ul>}
          {clearedOpen.length > 0 && <div className="mt-3">
            <p className="text-xs text-text-secondary">Cleared from Unread, still waiting for an answer ({clearedOpen.length})</p>
            <ul aria-label="Cleared requests still open" className="mt-1 divide-y divide-border-subtle">
              {clearedOpen.map((item) => <li key={`${item.thread}:${item.messageId}:${item.card.code}`} className="py-2">
                <Link href={requestHref(item)} className="break-words text-sm text-text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-accent">{item.card.name}</Link>
                <span className="ml-2 text-xs text-text-secondary">{item.card.agent || "Agent"}</span>
              </li>)}
            </ul>
          </div>}
        </details>
        <details>
          <summary>Sources ({attention?.sources.length ?? 0})</summary>
          <ul aria-label="Sources" className="mt-1 space-y-1">
            {(attention?.sources ?? []).map((st) => <li key={st.source} className={`break-words text-xs ${st.state === "ok" || st.state === "not_connected" ? "text-text-secondary" : "text-mid"}`}>{st.label}: {st.note}</li>)}
          </ul>
        </details>
        <details>
          <summary>Quiet view settings</summary>
          <div className="mt-2 flex flex-col gap-2">
            <label className="flex min-h-11 items-center justify-between gap-3 text-sm text-text-primary">Priorities to show
              <select value={quiet.budget} onChange={(e) => changeQuiet({ ...quiet, budget: Number(e.target.value) })}
                className="min-h-11 rounded-control border border-border-default bg-surface-raised px-3 text-sm text-text-primary focus-visible:outline-2 focus-visible:outline-accent">
                {budgetChoices.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
            </label>
            <label className="flex min-h-11 items-center gap-3 text-sm text-text-primary">
              <input type="checkbox" checked={quiet.learning} onChange={(e) => changeQuiet({ ...quiet, learning: e.target.checked })} className="h-5 w-5 accent-accent" />
              Suggest one reading action
            </label>
            <button type="button" onClick={() => changeQuiet({ ...quiet, on: false })} className={`${linkStyle} min-h-11 self-start`}>Turn off the quiet view</button>
          </div>
        </details>
        {quietSave === "failed" && <p className="mt-2 text-xs text-mid">Couldn&apos;t save the quiet view settings to your account; they are kept on this device. <button type="button" onClick={retryQuiet} className="underline underline-offset-4">Retry</button></p>}
        <button type="button" onClick={() => setShowFull((v) => !v)} aria-expanded={showFull} aria-controls="today-full" className={`${linkStyle} mt-3 min-h-11`}>
          {showFull ? "Hide the full Today page" : "Show the full Today page"}
        </button>
      </section> : <div data-today-quiet="" className={`${panelStyle} ${styles.quiet} ${styles.quietBoot}`}>
        <h2 className={styles.quietTitle}>Your priorities</h2>
        <p className="mt-2 text-sm text-text-secondary">Checking your sources...</p>
      </div>}
      {/* The full page: every panel, unchanged. Hidden (not removed) while the quiet view is on, unless asked for or
          while personalizing (Today.module.css .full[data-quiet-off]). */}
      <div id="today-full" data-today-full="" data-quiet-off={selection && !showFull ? "" : undefined} className={styles.full}>
      {/* Default layout: section order, each heading full width; the panels of a section side by side. */}
      <PartGrid page="/today" title="Today" mode="css" gap={20}>
      <Part id="start-here" title="Start here: check-in" width="half">
      <section aria-label="Start here" className={styles.captureLead}>
          <span className={styles.captureIcon}><ClipboardCheck aria-hidden="true" className="h-6 w-6" /></span>
          <div><p className={styles.eyebrow}>START HERE</p><h2 className="mt-2 text-xl font-semibold text-text-primary">Log your day</h2>
            <p className="mt-1 max-w-md text-sm leading-relaxed text-text-secondary">Check-in, supplements, weight and reading on one screen.</p></div>
          {/* The Log screen: the check-in and every other daily entry on one page (app/log/jump.ts anchors). */}
          <Link href="/log" className={styles.primaryAction}>Start your check-in <ArrowUpRight aria-hidden="true" className="h-4 w-4" /></Link>
      </section>
      </Part>
      <Part id="quick-log" title="Log something quickly" width="half">
      <section aria-label="Quick capture" className={styles.captureOptions}>
          <p className={styles.eyebrow}>OR LOG SOMETHING QUICKLY</p>
          <Link href="/log#log-part-supplements" className={styles.captureLink}><span>Supplement<span className={styles.caption}>Your stack &amp; intake</span></span><ArrowUpRight aria-hidden="true" className="h-4 w-4" /></Link>
          <Link href="/log#log-part-check-in" className={styles.captureLink}><span>Habit<span className={styles.caption}>Record a daily habit</span></span><ArrowUpRight aria-hidden="true" className="h-4 w-4" /></Link>
          <Link href="/log#log-part-weight" className={styles.captureLink}><span>Weight<span className={styles.caption}>Log today&apos;s weight</span></span><ArrowUpRight aria-hidden="true" className="h-4 w-4" /></Link>
      </section>
      </Part>
      <Part id="jump-links" title="Section shortcuts">
      <nav aria-label="Today sections" className={styles.jumpLinks}>
        <a href="#requests-heading"><span>Needs your input</span><span>{inbox.state === "ready" ? requests.length : "—"}</span></a>
        <a href="#urgent-email-heading"><span>Urgent email</span><span>{urgent.state === "ready" && inbox.state === "ready" ? merged.total : "—"}</span></a>
        <a href="#calendar-heading"><span>Your schedule</span><CalendarDays aria-hidden="true" className="h-4 w-4" /></a>
        <a href="#reading-heading"><span>Keep reading</span><BookOpen aria-hidden="true" className="h-4 w-4" /></a>
      </nav>
      </Part>
      {(experiment.state === "error" || trial) && <Part id="experiment" title="Experiment arm">
      {experiment.state === "error" && <div role="region" aria-label="Experiment arm" className={panelStyle}>
        <p className="text-sm text-text-secondary">Couldn&apos;t check today&apos;s experiment arm. Try refreshing.</p>
      </div>}
      {trial && <div role="region" aria-labelledby="experiment-heading" className={panelStyle}>
        <div className="flex items-center gap-2"><FlaskConical aria-hidden="true" className={iconStyle} />
          <h2 id="experiment-heading" className={titleStyle}>{trial.status === "active" ? "Today's experiment arm" : "Experiment"}</h2></div>
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
      </Part>}
      <Part id="heading-needs-you" title="Heading: What needs you">
        <div className={styles.sectionLabel}><span>01</span><h2>What needs you</h2></div>
      </Part>
      <Part id="requests" title="Needs your input" width="half">
      <section className={panelStyle} aria-labelledby="requests-heading" aria-busy={inbox.state === "loading"}>
        <div className="flex items-center justify-between gap-4">
          <h3 id="requests-heading" className={titleStyle}>Needs your input</h3>
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
                    <span className="mt-1 block text-xs text-text-secondary">Review request</span></span>
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
      </Part>
      <Part id="urgent-email" title="Urgent email" width="half">
      <section className={panelStyle} aria-labelledby="urgent-email-heading" aria-busy={urgent.state === "loading"}>
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2"><Mail aria-hidden="true" className={iconStyle} />
            <h3 id="urgent-email-heading" className={titleStyle}>Urgent email</h3></div>
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
      </Part>
      <Part id="heading-your-day" title="Heading: Your day, at a glance">
        <div className={styles.sectionLabel}><span>02</span><h2>Your day, at a glance</h2></div>
      </Part>
      <Part id="calendar" title="Calendar">
      <section className={panelStyle} aria-labelledby="calendar-heading" aria-busy={calendar.state === "loading"}>
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-2"><CalendarDays aria-hidden="true" className={iconStyle} />
            <h3 id="calendar-heading" className={titleStyle}>Calendar</h3></div>
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
              <h4 className="text-xs font-medium text-text-secondary">{name} · {calendarDayLabel(day)}</h4>
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
      </Part>
      <Part id="heading-keep-moving" title="Heading: Keep life moving">
      <div className={styles.sectionLabel}><span>03</span><h2>Keep life moving</h2></div>
      </Part>
      {checkLines.length > 0 && <Part id="also-checked" title="Also checked" width={lifeWidth("also-checked")}>
      <section className={panelStyle} aria-labelledby="checks-heading">
        <h3 id="checks-heading" className={titleStyle}>Also checked</h3>
        <ul className="mt-3 divide-y divide-border-subtle" aria-label="Checks with nothing due">
          {checkLines.map((line) => <li key={line.key} className="py-3">
            <p className="text-xs text-text-secondary"><Link href={line.href} className="text-text-primary hover:underline">{line.label}</Link>{line.when ? ` · ${line.when}` : ""}</p>
            <p className={`mt-0.5 break-words text-sm ${line.warn ? "text-mid" : "text-text-secondary"}`}>{line.text}</p>
          </li>)}
        </ul>
      </section>
      </Part>}
      {packages && <Part id="packages" title="Packages" width={lifeWidth("packages")}>
      <section className={panelStyle} aria-labelledby="packages-heading">
        <div className="flex items-center gap-2"><Package aria-hidden="true" className={iconStyle} />
          <h3 id="packages-heading" className={titleStyle}>Packages</h3></div>
        <p className="mt-3 text-sm text-text-primary">{[
          packages.attention > 0 ? `${packages.attention} need${packages.attention === 1 ? "s" : ""} attention` : null,
          packages.arrivingToday > 0 ? `${packages.arrivingToday} arriving today` : null,
        ].filter(Boolean).join(" · ")}</p>
        {packages.top.length > 0 && <ul className="mt-2 space-y-2" aria-label="Packages that need attention">
          {packages.top.map((t, i) => <li key={i} className="text-xs text-text-secondary"><span className="text-text-primary">{t.merchant}: {t.label}.</span> {t.reason}</li>)}
        </ul>}
        {ordersLate && <p className="mt-3 text-sm text-mid">{ordersLateText}</p>}
        {lifeFailed("orders") && <p className="mt-3 text-sm text-mid">Couldn&apos;t refresh packages. Showing {clock(lifeChecks.orders.at) ? `the check at ${clock(lifeChecks.orders.at)}` : "an earlier check"}; it may have changed.</p>}
        <Link href="/orders" className={`${linkStyle} mt-4 inline-block`}>Open orders</Link>
      </section>
      </Part>}
      {money && moneyPanel && <Part id="money" title="Money" width={lifeWidth("money")}>
      <section className={panelStyle} aria-labelledby="money-heading" aria-busy={money.updating && !money.refreshFailed}>
        <div className="flex items-center gap-2"><Wallet aria-hidden="true" className={iconStyle} />
          <h3 id="money-heading" className={titleStyle}>Money</h3></div>
        {money.alerts.length > 0 && <ul className="mt-3 space-y-2" aria-label="Money alerts">
          {money.alerts.slice(0, 5).map((a, i) => <li key={i} className="break-words">
            <Link href={a.href} className={`text-sm ${a.severity === "high" ? "text-down" : "text-text-primary"} hover:underline`}>{a.title}</Link>
            <p className="text-xs text-text-secondary">{a.detail}</p>
          </li>)}
        </ul>}
        {moneyStatus && <p className={`mt-3 text-sm ${moneyStatus.tone === "warn" ? "text-mid" : "text-text-secondary"}`}>{moneyStatus.text}</p>}
        <p className="mt-2 text-xs text-text-secondary">From your forecast and budgets. Onyx never moves money.</p>
        {/* The cash forecast's check failed: its reasons (and Leave it out) are on the forecast page. */}
        {money.cash && !money.cash.eligible && <Link href="/financials/forecast" className={`${linkStyle} mt-4 mr-4 inline-block`}>Open cash forecast</Link>}
        <Link href="/financials/budgets" className={`${linkStyle} mt-4 inline-block`}>Open budgets</Link>
      </section>
      </Part>}
      {renewing && <Part id="renewals" title="Renewals" width={lifeWidth("renewals")}>
      <section className={panelStyle} aria-labelledby="renewals-heading">
        <div className="flex items-center gap-2"><CalendarClock aria-hidden="true" className={iconStyle} />
          <h3 id="renewals-heading" className={titleStyle}>Renewals</h3></div>
        <p className="mt-3 text-sm text-text-primary">{renewing.count === 1 ? "1 subscription is" : `${renewing.count} subscriptions are`} expected to renew in the next {renewing.withinDays} days.</p>
        <ul className="mt-2 space-y-1" aria-label="Subscriptions renewing soon">
          {renewing.soon.map((r, i) => <li key={i} className="break-words text-xs text-text-secondary"><span className="text-text-primary">{r.merchant}</span> {r.label}</li>)}
        </ul>
        {renewing.count > renewing.soon.length && <p className="mt-1 text-xs text-text-secondary">And {renewing.count - renewing.soon.length} more.</p>}
        <p className="mt-2 text-xs text-text-secondary">Estimated from past charges in your ledger. Onyx never pays or cancels anything.</p>
        {renewalsNote && <p className={`mt-3 text-sm ${renewalsNote.warn ? "text-mid" : "text-text-secondary"}`}>{renewalsNote.text}</p>}
        {lifeFailed("renewals") && <p className="mt-3 text-sm text-mid">Couldn&apos;t refresh renewals. Showing {clock(lifeChecks.renewals.at) ? `the check at ${clock(lifeChecks.renewals.at)}` : "an earlier check"}; it may have changed.</p>}
        <Link href="/procurement" className={`${linkStyle} mt-4 inline-block`}>Open procurement</Link>
      </section>
      </Part>}
      {windDown.show && <Part id="wind-down" title="Wind-down" width={lifeWidth("wind-down")}>
      <WindDownPanel surface="today" className={panelStyle} />
      </Part>}
      {homeReset.show && <Part id="home-reset" title="Apartment reset" width={lifeWidth("home-reset")}>
      <HomeResetPanel view={homeReset} now={now} className={panelStyle} titleClassName={titleStyle} />
      </Part>}
      <Part id="reading" title="Keep reading" width={lifeWidth("reading")}>
      <section className={panelStyle} aria-labelledby="reading-heading" aria-busy={reading.state === "loading"}>
        <div className="flex items-center gap-2"><BookOpen aria-hidden="true" className={iconStyle} />
          <h3 id="reading-heading" className={titleStyle}>Keep reading</h3></div>
        {reading.state === "loading" && <p className="mt-3 text-sm text-text-secondary">Loading reading progress...</p>}
        {reading.state === "error" && <p className="mt-3 text-sm text-text-secondary">Reading progress is unavailable right now.</p>}
        {reading.state === "ready" && reading.stale && <p className="mt-3 text-sm text-mid">Couldn&apos;t refresh reading. Showing previously loaded progress.</p>}
        {reading.state === "ready" && (book ? <>
          <p className="mt-3 text-base font-medium text-text-primary">{book.book.title}</p>
          <p className="mt-1 text-sm text-text-secondary">{Number.isFinite(book.chaptersDone) && Number.isFinite(book.totalChapters) && book.totalChapters > 0 && book.chaptersDone >= 0 && book.chaptersDone <= book.totalChapters ? `${book.chaptersDone} of ${book.totalChapters} chapters recorded.` : "Chapter progress is not available."}</p>
          {practiceCount > 0 && <p className="mt-1 text-sm"><Link href="/reading" className={linkStyle}>Practice · <span className="font-mono">{practiceCount}</span> ready</Link></p>}
          <p className="mt-1 text-xs text-text-secondary">Recorded progress may lag your latest reading.</p>
          {learningAction && learningLine && <p className="mt-2 text-sm text-text-primary" data-testid="reading-next-action">{learningLine}{(learningAction.kind === "review" || learningAction.kind === "read") && <> <Link href={actionHref(learningAction)} className={linkStyle}>Open</Link></>}</p>}
        </> : <p className="mt-3 text-sm text-text-secondary">No book is currently in progress.</p>)}
        <Link href="/reading" className={`${linkStyle} mt-4 inline-block`}>{book ? "Continue reading" : "Open reading"}</Link>
      </section>
      </Part>
      <Part id="check-in" title="A moment to check in" width={lifeWidth("check-in")}>
      <section className={panelStyle} aria-labelledby="checkin-heading">
        <div className="flex items-center gap-2"><ClipboardCheck aria-hidden="true" className={iconStyle} />
          <h3 id="checkin-heading" className={titleStyle}>A moment to check in</h3></div>
        <p className="mt-3 text-sm text-text-secondary">Start or continue your check-in. Answer what you know; leave the rest blank.</p>
        <Link href="/log#log-part-check-in" className={`${linkStyle} mt-4 inline-block`}>Open check-in</Link>
      </section>
      </Part>
      </PartGrid>
      <TodayOverview />
      </div>
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
