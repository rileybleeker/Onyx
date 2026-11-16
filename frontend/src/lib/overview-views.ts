/**
 * What each overview card shows, computed from the raw answers it reads (components/overview/sources.ts).
 * Every card uses one small layout: up to three numbers, then one small chart or up to two lines, then one
 * note. A fixed layout lets the card and its loading skeleton share one height, so nothing moves when the
 * data arrives.
 *
 * Pure: no I/O, no React. Imports only import-free helpers (tests/overview-cards.test.cjs runs it in plain
 * node; tests/today-regression.cjs bundles it).
 */
import { mergeDailySteps } from "./steps";
import { dueSoon, todayLocal, type CareItem } from "./care-planner";
import { eventTitle, eventsByDay, localDate, readCalendarResponse, shiftDate, timeLabel, type CalendarEvent } from "./calendar-events";
import { formatMinutes } from "./screen-time";

// ---- the layout ----

export type Tone = "up" | "mid" | "down";
export interface Metric {
  label: string;
  value: string;
  unit?: string;
  /** One short line under the number. A status color always comes with a word here (theme rule). */
  sub?: string;
  tone?: Tone;
}
export interface MiniChart {
  kind: "bars" | "line";
  values: (number | null)[];
  /** One short label per value (weekday). */
  labels: string[];
  /** The last value is still growing (today so far): drawn dimmed. */
  partialLast?: boolean;
  /** What the chart is, also read to screen readers. */
  caption: string;
}
/** Plain text (the card's Open link and its footer links are the tap targets). */
export interface Line {
  text: string;
  tone?: Tone;
}
export interface CardView {
  metrics: Metric[];
  chart?: MiniChart;
  lines?: Line[];
  note?: string;
}

/** One source's answer as the card holds it. */
export type Part = { state: "loading" } | { state: "error" } | { state: "ready"; value: unknown; stale?: boolean };
export type CardState = { kind: "loading" } | { kind: "error" } | { kind: "ready"; view: CardView; stale: boolean };

// ---- small helpers ----

type Row = Record<string, unknown>;
const DASH = "—";

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}
function rowsOf(value: unknown, field = "rows"): Row[] {
  const v = value as Record<string, unknown> | null | undefined;
  const rows = v && Array.isArray(v[field]) ? (v[field] as unknown[]) : [];
  return rows.filter((r): r is Row => !!r && typeof r === "object");
}
function mean(xs: (number | null)[]): number | null {
  const v = xs.filter((x): x is number => x !== null);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
const round = (n: number | null): string => (n === null ? DASH : Math.round(n).toLocaleString("en-US"));
const byText = (k: string) => (a: Row, b: Row) => String(a[k] ?? "").localeCompare(String(b[k] ?? ""));
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Today", "Yesterday", else the weekday ("Tue"). Dates are YYYY-MM-DD. */
export function dayLabel(date: string | null, today: string): string {
  if (!date) return "";
  if (date === today) return "Today";
  if (date === shiftDate(today, -1)) return "Yesterday";
  if (date === shiftDate(today, 1)) return "Tomorrow";
  const d = new Date(`${date}T12:00:00`);
  if (Number.isNaN(d.getTime())) return date;
  return date >= shiftDate(today, -6) && date <= today
    ? d.toLocaleDateString("en-US", { weekday: "short" })
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
function weekday(date: string): string {
  const d = new Date(`${date}T12:00:00`);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { weekday: "narrow" });
}
/** The seven days ending today (YYYY-MM-DD, oldest first). */
function lastSevenDays(today: string): string[] {
  return Array.from({ length: 7 }, (_, i) => shiftDate(today, i - 6));
}
function hoursMinutes(ms: number | null): string {
  if (ms === null || ms <= 0) return DASH;
  const m = Math.round(ms / 60000);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
function clock(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
function hourLabel(h: number | null): string | null {
  if (h === null || h < 0 || h >= 24) return null;
  const hh = Math.floor(h);
  const mm = Math.round((h - hh) * 60);
  const d = new Date(2000, 0, 1, hh, mm === 60 ? 59 : mm);
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}
function localDay(iso: unknown): string | null {
  const s = str(iso);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : localDate(d);
}

// ---- checks: a source's answer (fresh or cached) is checked before it is used ----

function needObject(v: unknown): Row {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("Invalid answer");
  return v as Row;
}
export const CHECKS = {
  rows(v: unknown) { if (!Array.isArray(needObject(v).rows)) throw new Error("Invalid rows"); },
  prediction(v: unknown) { const o = needObject(v); if (!("prediction" in o) || (o.prediction !== null && typeof o.prediction !== "object")) throw new Error("Invalid forecast"); },
  supplements(v: unknown) { if (!Array.isArray(needObject(v).intakes)) throw new Error("Invalid intakes"); },
  checkin(v: unknown) { const o = needObject(v); if (typeof o.today !== "string" || !Array.isArray(o.days)) throw new Error("Invalid check-in"); },
  reading(v: unknown) { const o = needObject(v); if (!("overview" in o)) throw new Error("Invalid reading"); },
  alerts(v: unknown) { const o = needObject(v); if (o.status !== "ready" || !Array.isArray(o.alerts)) throw new Error("Invalid alerts"); },
  renewals(v: unknown) { const o = needObject(v); if (o.status !== "empty" && !(o.status === "ready" && Array.isArray(o.soon) && typeof o.count === "number")) throw new Error("Invalid renewals"); },
  orders(v: unknown) { const o = needObject(v); if (o.status !== "not_connected" && !(o.status === "ready" && Array.isArray(o.top))) throw new Error("Invalid orders"); },
  calendar(v: unknown) { readCalendarResponse(v); },
  care(v: unknown) { if (!Array.isArray(needObject(v).items)) throw new Error("Invalid care items"); },
  screenTime(v: unknown) { const o = needObject(v); if (o.status !== "empty" && !(o.status === "ready" && Array.isArray(o.days))) throw new Error("Invalid screen time"); },
  inbox(v: unknown) { const o = needObject(v); if (!Array.isArray(o.items) || !Array.isArray(o.threads)) throw new Error("Invalid inbox"); },
  leads(v: unknown) { if (!Array.isArray(needObject(v).leads)) throw new Error("Invalid leads"); },
  status(v: unknown) { const o = needObject(v); if (!o.sources || typeof o.sources !== "object") throw new Error("Invalid status"); },
} as const;

// ---- the cards ----

type View = (values: unknown[], now: Date) => CardView;

function zone(score: number): { word: string; tone: Tone } {
  return score >= 67 ? { word: "Green", tone: "up" } : score >= 34 ? { word: "Yellow", tone: "mid" } : { word: "Red", tone: "down" };
}

const recovery: View = ([recoveryRows, forecast], now) => {
  const today = localDate(now);
  const rows = rowsOf(recoveryRows).filter((r) => num(r.recovery_score) !== null).sort(byText("created_at"));
  const last7 = rows.slice(-7);
  const latest = rows[rows.length - 1];
  const score = num(latest?.recovery_score);
  const hrv = num(latest?.hrv_rmssd_milli);
  const avg = mean(last7.map((r) => num(r.hrv_rmssd_milli)));
  const p = forecast === undefined ? undefined : ((forecast as Row | null)?.prediction as Row | null);
  const pred = num(p?.predicted_hrv);
  const lo = num(p?.prediction_lower);
  const hi = num(p?.prediction_upper);
  return {
    metrics: [
      score === null
        ? { label: "Recovery", value: DASH, sub: "Not scored yet" }
        : { label: "Recovery", value: String(Math.round(score)), unit: "%", sub: `${zone(score).word} · ${dayLabel(localDay(latest?.created_at), today)}`, tone: zone(score).tone },
      { label: "HRV", value: round(hrv), unit: hrv === null ? undefined : "ms", sub: avg === null ? "WHOOP" : `7-night avg ${Math.round(avg)}` },
      p === undefined
        ? { label: "Tonight", value: DASH, sub: "Couldn't check the forecast" }
        : pred === null
          ? { label: "Tonight", value: DASH, sub: "No forecast yet" }
          : { label: "Tonight", value: String(Math.round(pred)), unit: "ms", sub: lo !== null && hi !== null ? `forecast ${Math.round(lo)}–${Math.round(hi)}` : "HRV forecast" },
    ],
    chart: last7.length >= 2 ? { kind: "line", values: last7.map((r) => num(r.hrv_rmssd_milli)), labels: last7.map((r) => weekday(localDay(r.created_at) ?? "")), caption: "HRV, last 7 nights (WHOOP)" } : undefined,
    note: rows.length === 0 ? "No WHOOP recovery in the last week." : undefined,
  };
};

const sleep: View = ([sleepRows], now) => {
  const today = localDate(now);
  const rows = rowsOf(sleepRows).filter((r) => r.is_nap !== true).sort(byText("end_time"));
  const asleep = (r: Row) => {
    const parts = [num(r.total_light_sleep_time_milli), num(r.total_slow_wave_sleep_time_milli), num(r.total_rem_sleep_time_milli)];
    return parts.every((x) => x === null) ? null : parts.reduce<number>((a, b) => a + (b ?? 0), 0);
  };
  const last7 = rows.slice(-7);
  const latest = rows[rows.length - 1];
  const wake = localDay(latest?.end_time);
  const perf = num(latest?.sleep_performance_percentage);
  const eff = num(latest?.sleep_efficiency_percentage);
  return {
    metrics: [
      { label: wake === today ? "Last night" : "Latest sleep", value: latest ? hoursMinutes(asleep(latest)) : DASH, sub: latest ? `asleep · woke ${dayLabel(wake, today).toLowerCase()}` : "No sleep scored" },
      { label: "Performance", value: round(perf), unit: perf === null ? undefined : "%", sub: "of sleep needed" },
      { label: "Efficiency", value: round(eff), unit: eff === null ? undefined : "%", sub: "asleep while in bed" },
    ],
    chart: last7.length >= 2 ? { kind: "bars", values: last7.map((r) => { const ms = asleep(r); return ms === null ? null : ms / 3_600_000; }), labels: last7.map((r) => weekday(localDay(r.end_time) ?? "")), caption: "Hours asleep, last 7 nights (WHOOP)" } : undefined,
    note: rows.length === 0 ? "No WHOOP sleep scored in the last week." : undefined,
  };
};

const activity: View = ([cycleRows, garminRows], now) => {
  const today = localDate(now);
  const cycles = rowsOf(cycleRows);
  const days = mergeDailySteps(rowsOf(garminRows) as never[], cycles as never[]);
  const week = lastSevenDays(today);
  const byDay = new Map(days.map((d) => [d.day, d]));
  const shown = week.map((d) => byDay.get(d) ?? null);
  const latest = days.length ? days[days.length - 1] : null;
  const done = shown.filter((d) => d && !d.partial).map((d) => d!.steps);
  const latestCycle = [...cycles].sort(byText("start_time")).pop();
  const strain = num(latestCycle?.strain);
  return {
    metrics: [
      { label: "Steps", value: latest ? latest.steps.toLocaleString("en-US") : DASH, sub: latest ? `${latest.partial ? "so far · " : ""}${dayLabel(latest.day, today)} · ${latest.source === "WHOOP" ? "WHOOP" : "Garmin"}` : "No steps this week" },
      { label: "7-day avg", value: done.length ? round(mean(done)) : DASH, sub: done.length ? plural(done.length, "full day") : "steps per day" },
      { label: "Strain", value: strain === null ? DASH : strain.toFixed(1), unit: strain === null ? undefined : "/ 21", sub: latestCycle ? (latestCycle.end_time ? dayLabel(localDay(latestCycle.start_time), today) : "so far today") : "WHOOP" },
    ],
    chart: days.length ? { kind: "bars", values: shown.map((d) => (d ? d.steps : null)), labels: week.map(weekday), partialLast: !!shown[6]?.partial, caption: "Steps, last 7 days (larger of Garmin and WHOOP)" } : undefined,
  };
};

const nutrition: View = ([nutritionRows, weight, caffeineRows], now) => {
  const today = localDate(now);
  const nut = rowsOf(nutritionRows).filter((r) => num(r.calories) !== null).sort(byText("calendar_date"));
  const lastNut = nut[nut.length - 1];
  const weights = rowsOf(weight).filter((r) => num(r.weight_kg) !== null).sort(byText("log_date"));
  const lastWeight = weights[weights.length - 1];
  const caf = rowsOf(caffeineRows).sort(byText("calendar_date"));
  const lastCaf = caf[caf.length - 1];
  const week = lastSevenDays(today);
  const kcalByDay = new Map(nut.map((r) => [String(r.calendar_date), num(r.calories)]));
  const source = str(lastNut?.nutrition_source);
  const kg = num(lastWeight?.weight_kg);
  const mg = num(lastCaf?.total_caffeine_mg);
  const lastAt = hourLabel(num(lastCaf?.last_caffeine_hour));
  return {
    metrics: [
      { label: "Calories", value: round(num(lastNut?.calories)), unit: lastNut ? "kcal" : undefined, sub: lastNut ? `${dayLabel(str(lastNut.calendar_date), today)} · ${source === "uber_eats" ? "Uber Eats estimate" : source === "photo" ? "Photo estimate" : source === "uber_eats+photo" ? "Uber Eats + photo estimate" : source === "mfp" ? "MyFitnessPal" : "Cronometer"}` : "Nothing logged this week" },
      { label: "Weight", value: kg === null ? DASH : (kg / 0.45359237).toFixed(1), unit: kg === null ? undefined : "lb", sub: lastWeight ? dayLabel(str(lastWeight.log_date), today) : "No weigh-in in 90 days" },
      { label: "Caffeine", value: round(mg), unit: mg === null ? undefined : "mg", sub: lastCaf ? `${dayLabel(str(lastCaf.calendar_date), today)}${lastAt ? ` · last ${lastAt}` : ""}` : "None this week" },
    ],
    chart: nut.length ? { kind: "bars", values: week.map((d) => kcalByDay.get(d) ?? null), labels: week.map(weekday), caption: "Calories, last 7 days" } : undefined,
  };
};

const supplements: View = ([today]) => {
  const intakes = rowsOf(today, "intakes");
  const compounds = rowsOf(today, "compounds");
  const doses = intakes.reduce((a, r) => a + (num(r.doses) ?? 1), 0);
  const products = new Set(intakes.map((r) => String(r.product_id ?? ""))).size;
  return {
    metrics: [
      { label: "Doses", value: doses ? String(Math.round(doses * 10) / 10) : "0", sub: "logged today" },
      { label: "Products", value: String(products), sub: "different" },
      { label: "Compounds", value: String(compounds.length), sub: "in today's total" },
    ],
    lines: intakes.slice(0, 2).map((r) => ({ text: `${clock(str(r.intake_time)) ?? "No time"} · ${str(r.full_name) ?? str(r.brand_name) ?? "Supplement"}` })),
    note: intakes.length ? undefined : "Nothing logged for today yet.",
  };
};

const habits: View = ([checkin, reading], now) => {
  const today = localDate(now);
  const c = checkin as { today?: string; days?: { date: string; answered: number; total: number }[] } | undefined;
  const day = c?.days?.find((d) => d.date === c.today);
  const ov = (reading as { overview?: Row | null } | undefined)?.overview;
  const book = ov ? (ov.book as Row | undefined) : null;
  const streak = ov ? (ov.streak as Row | undefined) : null;
  const pct = num(ov?.percent);
  const lines: Line[] = [];
  for (const d of c?.days ?? []) {
    if (d.date !== c?.today && d.total > 0 && d.answered < d.total) lines.push({ text: `${dayLabel(d.date, c?.today ?? today)}: ${d.answered} of ${d.total} answered` });
  }
  if (book && str(book.title)) lines.push({ text: `${str(book.title)} · chapter ${num(ov?.chaptersDone) ?? 0} of ${num(ov?.totalChapters) ?? "?"}` });
  const complete = !!day && day.total > 0 && day.answered >= day.total;
  const current = num(streak?.current);
  return {
    metrics: [
      checkin === undefined
        ? { label: "Check-in", value: DASH, sub: "Couldn't check" }
        : { label: "Check-in", value: day ? `${day.answered}/${day.total}` : DASH, sub: complete ? "Done today" : "answered today", tone: complete ? "up" : undefined },
      reading === undefined
        ? { label: "Reading", value: DASH, sub: "Couldn't check" }
        : { label: "Reading", value: pct === null ? DASH : String(Math.round(pct)), unit: pct === null ? undefined : "%", sub: book ? "of the book" : "No book in progress" },
      { label: "Streak", value: current === null ? DASH : String(current), unit: current === null ? undefined : current === 1 ? "day" : "days", sub: streak ? (streak.loggedToday ? "read today" : streak.atRisk ? "at risk today" : `best ${num(streak.best) ?? 0}`) : "reading", tone: streak?.atRisk && !streak.loggedToday ? "mid" : undefined },
    ],
    lines: lines.slice(0, 2),
  };
};

const money: View = ([alertsAnswer, renewalsAnswer]) => {
  const alerts = alertsAnswer === undefined ? null : rowsOf(alertsAnswer, "alerts");
  const r = renewalsAnswer as { status?: string; count?: number; withinDays?: number; soon?: Row[] } | undefined;
  const high = alerts ? alerts.filter((a) => a.severity === "high").length : 0;
  // The cash forecast's input check (the gate behind safe to move): not eligible = "nothing to act on" is unverified.
  const cashIncomplete = (alertsAnswer as { cash?: { eligible?: unknown } } | undefined)?.cash?.eligible === false;
  const renewals = r?.status === "ready" ? r.count ?? 0 : r?.status === "empty" ? 0 : null;
  const lines: Line[] = (alerts ?? []).slice(0, 2).map((a) => ({ text: str(a.title) ?? "Money alert", tone: a.severity === "high" ? "down" : undefined }));
  if (r?.status === "ready") for (const s of r.soon ?? []) if (lines.length < 2) lines.push({ text: `${str(s.merchant) ?? "A subscription"} ${str(s.label) ?? ""}`.trim() });
  return {
    metrics: [
      alerts === null
        ? { label: "Alerts", value: DASH, sub: "Couldn't check" }
        : { label: "Alerts", value: String(alerts.length), sub: high ? `${high} need action now` : cashIncomplete ? "cash forecast incomplete" : alerts.length ? "from forecast & budgets" : "nothing to act on", tone: high ? "down" : cashIncomplete ? "mid" : undefined },
      { label: "Renewals", value: renewals === null ? DASH : String(renewals), sub: renewals === null ? "Couldn't check" : `in the next ${r?.status === "ready" ? r.withinDays ?? 3 : 3} days` },
    ],
    lines,
    note: "Read-only: Onyx never moves money.",
  };
};

const orders: View = ([summary]) => {
  const s = summary as { status?: string; attention?: number; arrivingToday?: number; onTheWay?: number; top?: Row[] } | undefined;
  if (s?.status !== "ready") return { metrics: [{ label: "Needs attention", value: DASH }, { label: "Arriving today", value: DASH }, { label: "On the way", value: DASH }], note: "Order emails aren't connected yet." };
  const attention = s.attention ?? 0;
  return {
    metrics: [
      { label: "Needs attention", value: String(attention), sub: attention ? "check these" : "all fine", tone: attention ? "down" : undefined },
      { label: "Arriving today", value: String(s.arrivingToday ?? 0) },
      { label: "On the way", value: String(s.onTheWay ?? 0) },
    ],
    lines: (s.top ?? []).slice(0, 2).map((t) => ({ text: `${str(t.merchant) ?? "Order"}: ${str(t.label) ?? ""}`.replace(/: $/, "") })),
  };
};

const calendar: View = ([events, care], now) => {
  const today = localDate(now);
  const tomorrow = shiftDate(today, 1);
  const cal = events === undefined ? null : readCalendarResponse(events);
  const ready = cal && cal.status === "ready" ? cal : null;
  const byDay = ready ? eventsByDay(ready.events, today, tomorrow) : null;
  const todays = byDay?.get(today) ?? [];
  const lines: Line[] = [];
  const next = todays.find((e: CalendarEvent) => e.allDay || !e.endAt || new Date(e.endAt).getTime() > now.getTime());
  if (next) lines.push({ text: `${timeLabel(next, today)} · ${eventTitle(next)}` });
  const items = care === undefined ? null : (rowsOf(care, "items") as unknown as CareItem[]);
  const due = items ? dueSoon(items, todayLocal(now), 30).filter((e) => e.status !== "booked") : [];
  const overdue = due.filter((e) => e.status === "overdue").length;
  if (due[0]) lines.push({ text: `${due[0].item.title} · ${due[0].daysAway < 0 ? `${plural(-due[0].daysAway, "day")} overdue` : due[0].daysAway === 0 ? "due today" : `due in ${plural(due[0].daysAway, "day")}`}`, tone: due[0].status === "overdue" ? "down" : undefined });
  return {
    metrics: [
      { label: "Today", value: ready ? String(todays.length) : DASH, sub: ready ? (todays.length === 1 ? "event" : "events") : cal ? "calendar not connected" : "Couldn't check" },
      { label: "Tomorrow", value: ready ? String(byDay?.get(tomorrow)?.length ?? 0) : DASH, sub: ready ? "events" : "" },
      { label: "Care due", value: items ? String(due.length) : DASH, sub: items ? (overdue ? `${overdue} overdue` : "next 30 days, not booked") : "Couldn't check", tone: overdue ? "down" : undefined },
    ],
    lines: lines.slice(0, 2),
    note: lines.length ? undefined : "Nothing left on the calendar today.",
  };
};

const screenTime: View = ([summary], now) => {
  const today = localDate(now);
  const s = summary as { status?: string; days?: Row[]; avgTotalMin?: number | null; avgLateNightMin?: number | null; completeDays?: number } | undefined;
  if (s?.status !== "ready") return { metrics: [{ label: "Latest day", value: DASH }, { label: "7-day avg", value: DASH }, { label: "Late night", value: DASH }], note: "The iPhone app hasn't sent any days yet." };
  const days = (s.days ?? []).slice(-7);
  const complete = days.filter((d) => d.complete === true);
  const last = complete[complete.length - 1];
  return {
    metrics: [
      { label: "Latest day", value: last ? formatMinutes(num(last.totalMin)) : DASH, sub: last ? dayLabel(str(last.date), today) : "no full day yet" },
      { label: "7-day avg", value: formatMinutes(num(s.avgTotalMin)), sub: `${plural(s.completeDays ?? 0, "full day")}` },
      { label: "Late night", value: formatMinutes(num(s.avgLateNightMin)), sub: "avg after 10 PM" },
    ],
    chart: days.length >= 2 ? { kind: "bars", values: days.map((d) => num(d.totalMin)), labels: days.map((d) => weekday(str(d.date) ?? "")), partialLast: days[days.length - 1]?.complete !== true, caption: "Minutes on the iPhone, last 7 days" } : undefined,
  };
};

const agents: View = ([inbox]) => {
  const items = rowsOf(inbox, "items");
  const threads = rowsOf(inbox, "threads");
  const cards = items.filter((i) => i.kind === "card").length;
  const unread = threads.reduce((a, t) => a + (num(t.unread) ?? 0), 0);
  const withUnread = threads.filter((t) => (num(t.unread) ?? 0) > 0).sort((a, b) => (num((b.last as Row | undefined)?.id) ?? 0) - (num((a.last as Row | undefined)?.id) ?? 0));
  return {
    metrics: [
      { label: "Requests", value: String(cards), sub: cards ? "waiting for you" : "none open" },
      { label: "Unread", value: String(unread), sub: "messages" },
      { label: "Conversations", value: String(withUnread.length), sub: "with unread" },
    ],
    lines: withUnread.slice(0, 2).map((t) => ({ text: `${str(t.id) ?? "agent"}: ${str((t.last as Row | undefined)?.preview) ?? ""}` })),
    note: withUnread.length ? undefined : "Nothing unread.",
  };
};

const nyc: View = ([answer]) => {
  const leads = rowsOf(answer, "leads");
  const live = leads.filter((l) => l.status === "Live" && l.riley !== "Passed");
  const interested = leads.filter((l) => l.riley === "Interested").length;
  const toured = leads.filter((l) => l.riley === "Toured").length;
  const newest = [...live].sort(byText("firstSeen")).reverse().slice(0, 2);
  return {
    metrics: [
      { label: "Live leads", value: String(live.length), sub: "not passed" },
      { label: "Interested", value: String(interested) },
      { label: "Toured", value: String(toured) },
    ],
    lines: newest.map((l) => {
      const price = num(l.price);
      return { text: [str(l.neighborhood) ?? str(l.lead) ?? "Lead", price !== null ? `$${price.toLocaleString("en-US")}` : null, str(l.layout)].filter(Boolean).join(" · ") };
    }),
    note: leads.length ? undefined : "The scout hasn't found any leads yet.",
  };
};

const status: View = ([answer]) => {
  const sources = Object.values(((answer as Row | undefined)?.sources ?? {}) as Record<string, Row>);
  const ok = sources.filter((s) => s.status === "success").length;
  const partial = sources.filter((s) => s.status === "partial" || s.status === "unknown");
  const failed = sources.filter((s) => s.status === "failed");
  const lines: Line[] = [
    ...failed.map((s) => ({ text: `${str(s.label) ?? "A source"}: failed`, tone: "down" as Tone })),
    ...partial.map((s) => ({ text: `${str(s.label) ?? "A source"}: ${s.status === "unknown" ? "unknown" : "degraded"}`, tone: "mid" as Tone })),
  ];
  const at = clock(str((answer as Row | undefined)?.fetchedAt));
  return {
    metrics: [
      { label: "Healthy", value: String(ok), sub: "sources", tone: ok ? "up" : undefined },
      { label: "Degraded", value: String(partial.length), sub: partial.length ? "check soon" : "none", tone: partial.length ? "mid" : undefined },
      { label: "Failed", value: String(failed.length), sub: failed.length ? "need a fix" : "none", tone: failed.length ? "down" : undefined },
    ],
    lines: lines.slice(0, 2),
    note: lines.length ? undefined : at ? `Every source healthy at ${at}.` : "Every source healthy.",
  };
};

export const VIEWS: Record<string, View> = {
  recovery, sleep, activity, nutrition, supplements, habits, money, orders, calendar,
  "screen-time": screenTime, agents, nyc, status,
};

/**
 * The card's state from its sources: loading until every source has answered once (a cached copy counts),
 * an error only when every source failed, otherwise the view (a failed source shows as a dash) with `stale`
 * set when any source failed or could not be refreshed.
 */
export function cardState(id: string, parts: readonly Part[], now: Date): CardState {
  const view = VIEWS[id];
  if (!view) return { kind: "error" };
  if (parts.some((p) => p.state === "loading")) return { kind: "loading" };
  if (parts.length > 0 && parts.every((p) => p.state === "error")) return { kind: "error" };
  const values = parts.map((p) => (p.state === "ready" ? p.value : undefined));
  const stale = parts.some((p) => p.state === "error" || (p.state === "ready" && !!p.stale));
  try {
    return { kind: "ready", view: view(values, now), stale };
  } catch {
    return { kind: "error" };
  }
}
