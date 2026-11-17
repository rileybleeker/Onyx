import "server-only";

// Sleep wind-down streak (PROD-SLEEP-01): the database reads and writes behind /api/sleep/winddown/*. Takes the
// service-role client as an argument so tests/sleep-winddown.test.cjs can run it against a fake. Errors carry a short
// step or a database code only: never a habit name, an answer or a sleep value. Writes happen ONLY through the
// functions in sql/sleep_winddown.sql (each a single transaction with its own checks); the GET writes nothing.

import {
  MAX_HISTORY_NIGHTS,
  SLEEP_FEEDBACK_NIGHTS,
  WINDDOWN_PREF_KEY,
  addDays,
  isDate,
  isMissingStorage,
  type WindDownAnswerFact,
  type WindDownPause,
  type WindDownPayload,
  type WindDownRule,
  type WindDownSleepNight,
  type WindDownStart,
} from "@/lib/sleep-winddown";

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface WindDownDb {
  from(table: string): any;
  rpc(fn: string, args?: Record<string, unknown>): any;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

export class WindDownReadError extends Error {
  constructor(readonly step: string, readonly code: string | null = null) {
    super(`wind-down: ${step} failed`);
  }
}

const PAGE = 1000;

type Row = Record<string, unknown>;
const s = (v: unknown): string | null => (typeof v === "string" ? v : null);
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);

/** Behavioral today on the server (pds.behavioral_today_now(): travel-aware, −6 h awake tail). */
export async function behavioralToday(db: WindDownDb): Promise<string> {
  const { data, error } = await db.rpc("behavioral_today_now");
  if (error || !isDate(data)) throw new WindDownReadError("behavioral_today", error?.code ?? null);
  return data;
}

export function ruleFromRow(r: Row): WindDownRule {
  return {
    id: n(r.rule_id) as number,
    effectiveFrom: s(r.effective_from) ?? "",
    habitPageId: s(r.habit_page_id) ?? "",
    habitName: s(r.habit_name) ?? "",
    habitCategory: s(r.habit_category),
    targetTime: s(r.target_time) ?? "",
    tz: s(r.tz) ?? "",
    winsNeeded: n(r.wins_needed) ?? 0,
    windowNights: n(r.window_nights) ?? 0,
    ruleVersion: n(r.rule_version) ?? 1,
    createdAt: s(r.created_at) ?? "",
  };
}
function pauseFromRow(r: Row): WindDownPause {
  return { id: n(r.pause_id) as number, startDate: s(r.start_date) ?? "", endDate: s(r.end_date), createdAt: s(r.created_at) ?? "", endedAt: s(r.ended_at) };
}

/** WHOOP's "-04:00" offset applied to an instant: the local wall clock "HH:MM", or null. */
export function localClock(iso: string | null, offset: string | null): string | null {
  const t = iso ? Date.parse(iso) : NaN;
  const m = offset ? /^([+-])(\d{2}):?(\d{2})$/.exec(offset) : null;
  if (!Number.isFinite(t) || !m) return null;
  const mins = (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  const d = new Date(t + mins * 60_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/**
 * The main WHOOP sleep after each evening (feedback only): the longest scored non-nap sleep per behavioral day, its
 * time asleep (light + deep + REM) and onset in the zone WHOOP recorded. A failed read is `failed`, never zeros.
 */
export async function readSleepNights(db: WindDownDb, today: string): Promise<{ nights: WindDownSleepNight[]; failed: boolean }> {
  try {
    const { data, error } = await db
      .from("whoop_sleep")
      .select("onyx_behavioral_date,start_time,end_time,timezone_offset,total_light_sleep_time_milli,total_slow_wave_sleep_time_milli,total_rem_sleep_time_milli,synced_at")
      .gte("onyx_behavioral_date", addDays(today, -SLEEP_FEEDBACK_NIGHTS))
      .lt("onyx_behavioral_date", today)
      .eq("is_nap", false)
      .eq("score_state", "SCORED")
      .order("onyx_behavioral_date", { ascending: true })
      .order("start_time", { ascending: true });
    if (error) return { nights: [], failed: true };
    const best = new Map<string, { span: number; night: WindDownSleepNight }>();
    for (const r of (data ?? []) as Row[]) {
      const night = s(r.onyx_behavioral_date);
      if (!night || !isDate(night)) continue;
      const start = Date.parse(s(r.start_time) ?? "");
      const end = Date.parse(s(r.end_time) ?? "");
      const span = Number.isFinite(start) && Number.isFinite(end) ? end - start : 0;
      const parts = [n(r.total_light_sleep_time_milli), n(r.total_slow_wave_sleep_time_milli), n(r.total_rem_sleep_time_milli)];
      const asleep = parts.every((x) => x !== null) ? Math.round((parts as number[]).reduce((a, b) => a + b, 0) / 60_000) : null;
      const view: WindDownSleepNight = { night, asleepMin: asleep, onset: localClock(s(r.start_time), s(r.timezone_offset)), syncedAt: s(r.synced_at) };
      const had = best.get(night);
      if (!had || span > had.span) best.set(night, { span, night: view });
    }
    return { nights: Array.from(best.values()).map((b) => b.night), failed: false };
  } catch {
    return { nights: [], failed: true };
  }
}

/** Every answer of these habits from `from` to `to` (both inclusive), paged in a fixed order. */
async function readAnswers(db: WindDownDb, questions: string[], from: string, to: string): Promise<WindDownAnswerFact[]> {
  const out: WindDownAnswerFact[] = [];
  if (!questions.length) return out;
  // At most one row per (night, habit): enough pages for all of them, plus one to see the end.
  const nights = Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
  const maxPages = Math.ceil((questions.length * Math.max(1, nights)) / PAGE) + 1;
  for (let page = 0; page < maxPages; page++) {
    const { data, error } = await db
      .from("habit_journal")
      .select("cycle_date,question,answer")
      .in("question", questions)
      .gte("cycle_date", from)
      .lte("cycle_date", to)
      .order("cycle_date", { ascending: true })
      .order("question", { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new WindDownReadError("habit_answers", error.code ?? null);
    const rows = (data ?? []) as Row[];
    for (const r of rows) {
      const date = s(r.cycle_date);
      const question = s(r.question);
      const answer = r.answer === "Yes" || r.answer === "No" ? r.answer : null;
      if (date && question && answer) out.push({ date, question, answer });
    }
    if (rows.length < PAGE) return out;
  }
  // More history than the streak reads: refuse rather than show a personal best computed from part of it.
  throw new WindDownReadError("habit_answers_truncated");
}

/**
 * GET /api/sleep/winddown: everything Today and Log show, read-only. `not_connected` when the tables are not in
 * the database yet (sql/sleep_winddown.sql not applied), `not_set_up` before the first goal version.
 */
export async function readWindDown(db: WindDownDb, nowIso: string = new Date().toISOString()): Promise<WindDownPayload> {
  // Round trip 1: everything that does not depend on another read (the day, the goal, the pauses, the preference).
  const [today, rulesRes, pausesRes, prefRes] = await Promise.all([
    behavioralToday(db),
    db.from("sleep_winddown_rules").select("rule_id,effective_from,habit_page_id,habit_name,habit_category,target_time,tz,wins_needed,window_nights,rule_version,created_at").order("effective_from", { ascending: true }).order("rule_id", { ascending: true }),
    db.from("sleep_winddown_pauses").select("pause_id,start_date,end_date,created_at,ended_at").is("removed_at", null).order("start_date", { ascending: true }),
    db.from("ui_preferences").select("value").eq("key", WINDDOWN_PREF_KEY).maybeSingle(),
  ]);
  const base = { today, rules: [], pauses: [], answers: [], starts: [], habitNames: {}, sleep: { source: "WHOOP" as const, nights: [], failed: false }, asOf: nowIso };
  const hiddenValue = prefRes.error ? null : (prefRes.data as { value?: { hidden?: unknown } } | null)?.value;
  const hidden = hiddenValue?.hidden === true;
  if (isMissingStorage(rulesRes.error) || isMissingStorage(pausesRes.error)) return { status: "not_connected", hidden, ...base };
  if (rulesRes.error) throw new WindDownReadError("rules", rulesRes.error.code ?? null);
  if (pausesRes.error) throw new WindDownReadError("pauses", pausesRes.error.code ?? null);
  // A failed preference read shows the panel (hidden = false): it never blocks the streak itself.
  const rules = ((rulesRes.data ?? []) as Row[]).map(ruleFromRow);
  const pauses = ((pausesRes.data ?? []) as Row[]).map(pauseFromRow);
  if (!rules.length) return { status: "not_set_up", hidden, ...base, pauses };

  const pageIds = Array.from(new Set(rules.map((r) => r.habitPageId)));
  const first = rules[0].effectiveFrom;
  const from = first > addDays(today, -MAX_HISTORY_NIGHTS) ? first : addDays(today, -MAX_HISTORY_NIGHTS);
  // Round trip 2: the habits' current names, the starts, WHOOP, and the answers under the names the goal versions
  // stored (the habit's name in Notion is the answers' key; a rename is picked up below).
  const storedQuestions = Array.from(new Set(rules.map((r) => r.habitName)));
  const [namesRes, startsRes, sleep, storedAnswers] = await Promise.all([
    db.from("habit_name_map").select("notion_page_id,habit_name").in("notion_page_id", pageIds),
    db.from("sleep_winddown_starts").select("night,started_at,local_time,tz,rule_id,habit_page_id").gte("night", addDays(today, -60)).order("night", { ascending: true }),
    readSleepNights(db, today),
    readAnswers(db, storedQuestions, from, today),
  ]);
  if (namesRes.error) throw new WindDownReadError("habit_names", namesRes.error.code ?? null);
  const habitNames: Record<string, string> = {};
  for (const r of (namesRes.data ?? []) as Row[]) {
    const id = s(r.notion_page_id);
    const name = s(r.habit_name);
    if (id && name) habitNames[id] = name;
  }
  // Round trip 3, only after a rename: the answers under the habit's current name.
  const questions = Array.from(new Set(rules.map((r) => habitNames[r.habitPageId] || r.habitName)));
  const renamed = questions.filter((q) => !storedQuestions.includes(q));
  const answers = renamed.length ? storedAnswers.concat(await readAnswers(db, renamed, from, today)) : storedAnswers;
  if (startsRes.error) throw new WindDownReadError("starts", startsRes.error.code ?? null);
  const starts: WindDownStart[] = ((startsRes.data ?? []) as Row[]).map((r) => ({
    night: s(r.night) ?? "", startedAt: s(r.started_at) ?? "", localTime: s(r.local_time) ?? "", tz: s(r.tz) ?? "", ruleId: n(r.rule_id),
    habitPageId: s(r.habit_page_id),
  }));
  return { status: "ready", today, hidden, rules, pauses, answers, starts, habitNames, sleep: { source: "WHOOP", ...sleep }, asOf: nowIso };
}

/** The answer of pds.sleep_winddown_set_night (sql/sleep_winddown.sql). */
export interface SetNightResult {
  night: string;
  answer: "Yes" | "No" | null;
  previous: "Yes" | "No" | null;
  changed: boolean;
  question: string;
  channel: string | null;
  habitPageId: string;
  startedAt: string | null;
  localTime: string | null;
  /** The server answered a repeat of a tap that had already landed: nothing was written this time. */
  replayed: boolean;
}
export function setNightResult(raw: unknown): SetNightResult | null {
  const r = raw && typeof raw === "object" ? (raw as Row) : null;
  if (!r || !isDate(r.night) || typeof r.question !== "string" || typeof r.changed !== "boolean") return null;
  const ans = (v: unknown) => (v === "Yes" || v === "No" ? v : null);
  return {
    night: r.night, answer: ans(r.answer), previous: ans(r.previous), changed: r.changed, question: r.question,
    channel: s(r.channel), habitPageId: s(r.habit_page_id) ?? "", startedAt: s(r.started_at), localTime: s(r.local_time),
    replayed: r.replayed === true,
  };
}

/** The answer of pds.sleep_winddown_cancel_op: did the tap land (and with what answer), or can it now never land. */
export interface CancelResult { night: string; landed: boolean; answer: "Yes" | "No" | null }
export function cancelResult(raw: unknown): CancelResult | null {
  const r = raw && typeof raw === "object" ? (raw as Row) : null;
  if (!r || !isDate(r.night) || typeof r.landed !== "boolean") return null;
  return { night: r.night, landed: r.landed, answer: r.landed && (r.answer === "Yes" || r.answer === "No") ? r.answer : null };
}

/** WHOOP-derived questions have frozen rows through this date (same rule as /api/habits/complete). */
const WHOOP_JOURNAL_FROZEN_THROUGH = "2026-06-08";

/**
 * Keep the habit's Notion "Last Completed" = its newest Yes day (same rule as /api/habits/complete: Yes rows only,
 * post-freeze only for WHOOP-derived questions). Best effort, after the response; the hourly sync heals a miss.
 */
export async function mirrorLastCompleted(db: WindDownDb, result: SetNightResult, notionKey: string | undefined): Promise<void> {
  if (!notionKey || !result.changed || !result.habitPageId) return;
  try {
    let q = db.from("habit_journal").select("cycle_date").eq("question", result.question).eq("answer", "Yes").order("cycle_date", { ascending: false }).limit(1);
    if (result.channel === "whoop") q = q.gt("cycle_date", WHOOP_JOURNAL_FROZEN_THROUGH);
    const { data, error } = await q;
    if (error) return;
    const latest = (data as Row[] | null)?.[0]?.cycle_date;
    await fetch(`https://api.notion.com/v1/pages/${result.habitPageId}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${notionKey}`, "Content-Type": "application/json", "Notion-Version": "2022-06-28" },
      body: JSON.stringify({ properties: { "Last Completed": { date: typeof latest === "string" ? { start: latest } : null } } }),
    });
  } catch {
    console.error("[sleep winddown] Notion Last Completed update failed (Supabase already saved)");
  }
}

/** A write's JSON body, at most `max` bytes (the declared length is checked first by checkPortionRequest). */
export async function readJsonBody(req: Request, max: number): Promise<{ ok: true; body: unknown } | { ok: false; status: number; error: string }> {
  let text: string;
  try {
    text = await req.text();
  } catch {
    return { ok: false, status: 400, error: "could not read body" };
  }
  if (text.length > max) return { ok: false, status: 413, error: "body too large" };
  try {
    return { ok: true, body: JSON.parse(text) };
  } catch {
    return { ok: false, status: 400, error: "body must be JSON" };
  }
}
