import { createClient } from "@supabase/supabase-js";
import { after, NextRequest, NextResponse } from "next/server";
import { fetchActiveHabits, NotionHabitsError, type NotionHabit } from "@/lib/habits-notion";
import {
  addDays,
  APP_HABITS,
  appHabitSuggestions,
  CHECKIN_MAX_DAYS_BACK,
  fallbackBehavioralToday,
  groupFor,
  journaledSuggestion,
  Q_JOURNALED,
  Q_SAME_BED,
  Q_SCREEN_IN_BED,
  sameBedSuggestion,
  screenInBedSuggestion,
  SLEEP_KIT,
  SLEEP_QUESTIONS,
  sleepNights,
  syncedAfter,
  usualKit,
  type CheckinAnswer,
  type CheckinItem,
  type CheckinNight,
  type CheckinPayload,
  type CheckinSuggestion,
} from "@/lib/checkin";

/**
 * Daily habit check-in (2026-11-07). One screen, one write for a whole behavior day.
 *
 * GET  /api/habits/checkin?date=YYYY-MM-DD → CheckinPayload (questions, saved answers, data-backed pre-fills,
 *      progress for today and the two days before, and `nights`). date defaults to behavioral today.
 *      Sleep questions (2026-11-13) are NOT part of a day tab: `nights` lists the finished nights (last night
 *      and the one before), each with its saved answers, pre-fills and usual kit. A night's answers are stored
 *      on the behavior day that night closes, so the screen POSTs them with that date. Tonight is never asked.
 *      Pre-fills (2026-11-13) are never written by this route: the screen shows them with their source and
 *      they are stored only when Riley saves. Rules and thresholds live in lib/checkin.ts.
 * POST /api/habits/checkin { date, answers: { [question]: 'Yes' | 'No' | null } } → upserts Yes/No rows and
 *      deletes nulls (row absence = not logged, as in /api/habits/complete). Notion "Last Completed" is mirrored
 *      after the response; the hourly habits-sync self-heals any miss.
 *
 * Dates: answers are written to the behavior day the check-in is FOR, never the clock day, so an evening check-in
 * finished after midnight (or the morning after) still lands on the right day. Only behavioral today and the two
 * days before are accepted; older days stay unlogged (the HRV pipeline treats them as unknown).
 *
 * Auth: under /api/habits/*, so middleware requires a Supabase session (or the CI token).
 */

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const WHOOP_JOURNAL_FROZEN_THROUGH = "2026-06-08";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
});

// Questions with a data-backed pre-fill. Titles are the frozen WHOOP question text.
const Q_ALCOHOL = "Have any alcoholic drinks?";
const Q_REST = "Took a rest day?";
// "Traveled on a plane?" was retired 2026-11-09 — flights come from pds.flights (sql/flight_day_unified.sql).
// WHOOP sports that don't make a day "not a rest day" on their own (yoga, auto-detected activity, sauna, ...).
const LIGHT_SPORTS = new Set(["yoga", "activity", "other", "walking", "sauna", "meditation", "stretching", "breathwork"]);

const isDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

async function behavioralToday(): Promise<string> {
  try {
    const { data } = await supabase.rpc("behavioral_today_now");
    if (data) return data as string;
  } catch {
    /* fall through */
  }
  return fallbackBehavioralToday(new Date());
}

function dateError(date: string, today: string): string | null {
  if (date > today) return "That day hasn't happened yet.";
  if (date < addDays(today, -CHECKIN_MAX_DAYS_BACK)) return `The check-in only covers today and the ${CHECKIN_MAX_DAYS_BACK} days before.`;
  if (date <= WHOOP_JOURNAL_FROZEN_THROUGH) return "That day is in the frozen WHOOP era.";
  return null;
}

async function loadItems(): Promise<{ items: CheckinItem[]; habits: NotionHabit[] }> {
  const [habits, { data: map }] = await Promise.all([fetchActiveHabits(), supabase.from("habit_name_map").select("habit_name, channel")]);
  const channel = new Map((map ?? []).map((r: { habit_name: string; channel: string }) => [r.habit_name, r.channel]));
  const items = habits
    .filter((h) => h.name)
    .map((h): CheckinItem => {
      const ch = channel.get(h.name) === "whoop" ? "whoop" : "habit";
      return {
        name: h.name,
        notionPageId: h.id,
        category: h.category,
        frequency: h.frequency,
        channel: ch,
        group: groupFor(h.name, ch, h.frequency),
        sleep: SLEEP_QUESTIONS.has(h.name),
      };
    });
  return { items, habits };
}

/** Pre-fills from other sources. Each one is only offered when the data is clear; otherwise the question stays blank. */
async function suggestionsFor(date: string, today: string, names: Set<string>): Promise<Record<string, CheckinSuggestion>> {
  const out: Record<string, CheckinSuggestion> = {};
  const tasks: Promise<void>[] = [];

  if (names.has(Q_ALCOHOL)) {
    tasks.push(
      (async () => {
        const { data } = await supabase.from("cronometer_servings").select("alcohol_g").eq("onyx_behavioral_date", date).gt("alcohol_g", 0);
        const grams = (data ?? []).reduce((s, r: { alcohol_g: number | null }) => s + Number(r.alcohol_g || 0), 0);
        if (grams > 0) out[Q_ALCOHOL] = { answer: "Yes", source: `Cronometer: ${Math.round(grams)} g alcohol` };
      })()
    );
  }

  // Screen Time (the Onyx iPhone app): minutes in habit apps that day.
  if (Object.keys(APP_HABITS).some((h) => names.has(h))) {
    tasks.push(
      (async () => {
        const { data } = await supabase.from("phone_usage_daily").select("minutes_by_app").eq("behavioral_date", date).maybeSingle();
        if (!data) return;
        Object.assign(out, appHabitSuggestions((data as { minutes_by_app: Record<string, unknown> | null }).minutes_by_app, names));
      })()
    );
  }

  // Notion journal: an entry on the day answers "Journaled your thoughts?".
  if (names.has(Q_JOURNALED)) {
    tasks.push(
      (async () => {
        const { count, error } = await supabase
          .from("journal_entries")
          .select("notion_page_id", { count: "exact", head: true })
          .eq("onyx_behavioral_date", date)
          .eq("archived", false);
        if (error || count == null) return;
        const s = journaledSuggestion(date, today, count);
        if (s) out[Q_JOURNALED] = s;
      })()
    );
  }

  if (names.has(Q_REST)) {
    tasks.push(
      (async () => {
        const [w, g] = await Promise.all([
          supabase.from("whoop_workouts").select("sport_name").eq("onyx_behavioral_date", date).eq("is_excluded", false).eq("is_sauna", false),
          supabase.from("garmin_activities").select("activity_type").eq("onyx_behavioral_date", date).eq("is_excluded", false).eq("is_sauna", false),
        ]);
        const whoop = (w.data ?? []).map((r: { sport_name: string | null }) => (r.sport_name || "").toLowerCase());
        const garmin = (g.data ?? []).map((r: { activity_type: string | null }) => (r.activity_type || "").toLowerCase());
        const training = [...whoop.filter((s) => !LIGHT_SPORTS.has(s)), ...garmin.filter((s) => s && !s.includes("walk"))];
        if (training.length) out[Q_REST] = { answer: "No", source: `Workout: ${training[0].replace(/_/g, " ")}` };
        else if (!whoop.length && !garmin.length && !w.error && !g.error) out[Q_REST] = { answer: "Yes", source: "No workouts recorded" };
      })()
    );
  }

  await Promise.all(tasks.map((t) => t.catch((e) => console.error("[checkin] suggestion failed", e))));
  return out;
}

/**
 * Pre-fills for one finished night. `night` = the behavior day that night closes (its answers are stored on that
 * day). Same contract as suggestionsFor: only when the data is clear, never written here.
 */
async function sleepSuggestionsFor(night: string, names: Set<string>): Promise<Record<string, CheckinSuggestion>> {
  const out: Record<string, CheckinSuggestion> = {};
  const tasks: Promise<void>[] = [];

  // Screen Time: phone use in the hour before that night's sleep onset.
  if (names.has(Q_SCREEN_IN_BED)) {
    tasks.push(
      (async () => {
        const { data } = await supabase
          .from("phone_usage_daily")
          .select("minutes_last_hour_before_sleep_est, sleep_start, synced_at")
          .eq("behavioral_date", night)
          .maybeSingle();
        if (!data) return;
        const row = data as { minutes_last_hour_before_sleep_est: number | string | null; sleep_start: string | null; synced_at: string | null };
        const s = screenInBedSuggestion(row.minutes_last_hour_before_sleep_est, syncedAfter(row.synced_at, row.sleep_start));
        if (s) out[Q_SCREEN_IN_BED] = s;
      })()
    );
  }

  // Eight Sleep: was that night spent in the usual bed? (Eight Sleep keys a night by its wake-up date = night + 1)
  if (names.has(Q_SAME_BED)) {
    tasks.push(
      (async () => {
        const [rowsRes, newest] = await Promise.all([
          supabase.from("eight_sleep_trends").select("time_slept_seconds").eq("calendar_date", addDays(night, 1)).neq("bed_side", "away"),
          supabase.from("eight_sleep_trends").select("calendar_date").neq("bed_side", "away").order("calendar_date", { ascending: false }).limit(1),
        ]);
        if (rowsRes.error || newest.error) return;
        const rows = (rowsRes.data ?? []) as { time_slept_seconds: number | null }[];
        const slept = rows.length ? Math.max(...rows.map((r) => Number(r.time_slept_seconds || 0))) : null;
        const s = sameBedSuggestion(night, slept, (newest.data?.[0] as { calendar_date: string } | undefined)?.calendar_date ?? null);
        if (s) out[Q_SAME_BED] = s;
      })()
    );
  }

  await Promise.all(tasks.map((t) => t.catch((e) => console.error("[checkin] sleep suggestion failed", e))));
  return out;
}

export async function GET(req: NextRequest) {
  try {
    const today = await behavioralToday();
    const date = req.nextUrl.searchParams.get("date") || today;
    if (!isDate(date)) return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
    const bad = dateError(date, today);
    if (bad) return NextResponse.json({ error: bad, today }, { status: 400 });

    const { items } = await loadItems();
    const names = items.map((i) => i.name);
    const core = new Set(items.filter((i) => i.group === "core").map((i) => i.name));
    const from = addDays(today, -CHECKIN_MAX_DAYS_BACK);

    // Sleep questions are asked per finished NIGHT (sleepNights), never per day tab: the day's own lists leave them out.
    const sleepNames = new Set(items.filter((i) => i.sleep).map((i) => i.name));
    const dayCore = new Set([...core].filter((n) => !sleepNames.has(n)));
    const dayNames = new Set(names.filter((n) => !sleepNames.has(n)));
    const nightDates = sleepNames.size ? sleepNights(today, WHOOP_JOURNAL_FROZEN_THROUGH) : [];
    const kitNames = SLEEP_KIT.filter((q) => sleepNames.has(q));

    const [{ data: rows, error }, suggestions, kitRows, nightSuggestions] = await Promise.all([
      supabase.from("habit_journal").select("cycle_date, question, answer").gte("cycle_date", from).lte("cycle_date", today).in("question", names),
      suggestionsFor(date, today, dayNames),
      // Newest answers to the sleep-kit questions before the newest night asked (200 rows = 40 fully answered days).
      kitNames.length && nightDates.length
        ? supabase.from("habit_journal").select("cycle_date, question, answer").in("question", kitNames).lt("cycle_date", nightDates[0]).order("cycle_date", { ascending: false }).limit(200)
        : Promise.resolve({ data: [], error: null }),
      Promise.all(nightDates.map((n) => sleepSuggestionsFor(n, sleepNames))),
    ]);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    const kitHistory = kitRows.error ? [] : ((kitRows.data ?? []) as { cycle_date: string; question: string; answer: string }[]);

    const answers: Record<string, CheckinAnswer> = {};
    const nightAnswers = new Map<string, Record<string, CheckinAnswer>>(nightDates.map((n) => [n, {}]));
    const answeredByDay = new Map<string, number>();
    for (const r of (rows ?? []) as { cycle_date: string; question: string; answer: CheckinAnswer }[]) {
      if (sleepNames.has(r.question)) {
        const night = nightAnswers.get(r.cycle_date);
        if (night) night[r.question] = r.answer;
        continue;
      }
      if (r.cycle_date === date) answers[r.question] = r.answer;
      if (dayCore.has(r.question)) answeredByDay.set(r.cycle_date, (answeredByDay.get(r.cycle_date) || 0) + 1);
    }
    const days = Array.from({ length: CHECKIN_MAX_DAYS_BACK + 1 }, (_, i) => addDays(today, -i))
      .filter((d) => d > WHOOP_JOURNAL_FROZEN_THROUGH)
      .map((d) => ({ date: d, answered: answeredByDay.get(d) || 0, total: dayCore.size }));
    const nights: CheckinNight[] = nightDates.map((n, i) => ({
      date: n,
      answers: nightAnswers.get(n) ?? {},
      suggestions: nightSuggestions[i] ?? {},
      usualKit: usualKit(kitHistory, n, kitNames),
    }));

    const payload: CheckinPayload = { date, today, items, answers, suggestions, nights, days };
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof NotionHabitsError) return NextResponse.json({ error: e.message }, { status: 502 });
    throw e;
  }
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { date?: unknown; answers?: unknown; today?: unknown };
  const today = await behavioralToday();
  // The screen sends the `today` it was drawn with. If the day has rolled over since (a page left open
  // overnight), its "Last night" is now the night before: refuse, and the screen reloads. Optional field.
  if (isDate(body.today) && body.today !== today) {
    return NextResponse.json({ error: "A new day started since this page loaded. Check the nights and days, then save again.", today, stale: true }, { status: 409 });
  }
  if (!isDate(body.date)) return NextResponse.json({ error: "date must be YYYY-MM-DD" }, { status: 400 });
  const date = body.date;
  const bad = dateError(date, today);
  if (bad) return NextResponse.json({ error: bad }, { status: 400 });
  if (!body.answers || typeof body.answers !== "object") return NextResponse.json({ error: "answers is required" }, { status: 400 });

  let items: CheckinItem[];
  let habits: NotionHabit[];
  try {
    ({ items, habits } = await loadItems());
  } catch (e) {
    if (e instanceof NotionHabitsError) return NextResponse.json({ error: e.message }, { status: 502 });
    throw e;
  }
  const byName = new Map(items.map((i) => [i.name, i]));

  const upserts: { cycle_date: string; question: string; category: string | null; answer: CheckinAnswer }[] = [];
  const clears: string[] = [];
  for (const [name, raw] of Object.entries(body.answers as Record<string, unknown>)) {
    const item = byName.get(name);
    if (!item) return NextResponse.json({ error: `"${name}" is not an active habit` }, { status: 400 });
    if (raw === null) clears.push(name);
    else if (raw === "Yes" || raw === "No") upserts.push({ cycle_date: date, question: name, category: item.category || null, answer: raw });
    else return NextResponse.json({ error: `answer for "${name}" must be 'Yes', 'No' or null` }, { status: 400 });
  }

  if (upserts.length) {
    const { error } = await supabase.from("habit_journal").upsert(upserts, { onConflict: "cycle_date,question" });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (clears.length) {
    const { error } = await supabase.from("habit_journal").delete().eq("cycle_date", date).in("question", clears);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (NOTION_API_KEY) after(() => mirrorLastCompleted(date, upserts, clears, habits, byName));

  return NextResponse.json({ success: true, date, saved: upserts.length, cleared: clears.length });
}

/**
 * Keep Notion "Last Completed" = latest Yes day, touching only habits whose value actually moves (Notion allows
 * ~3 requests/s). Same rules as /api/habits/complete: Yes rows only, post-freeze only for WHOOP-derived questions.
 */
async function mirrorLastCompleted(
  date: string,
  upserts: { question: string; answer: CheckinAnswer }[],
  clears: string[],
  habits: NotionHabit[],
  byName: Map<string, CheckinItem>
) {
  const lc = new Map(habits.map((h) => [h.name, h.lastCompleted]));
  const updates = new Map<string, string | null>();
  const recompute: string[] = [];
  for (const u of upserts) {
    const current = lc.get(u.question) ?? null;
    if (u.answer === "Yes" && (!current || date > current)) updates.set(u.question, date);
    if (u.answer === "No" && current === date) recompute.push(u.question);
  }
  for (const name of clears) if ((lc.get(name) ?? null) === date) recompute.push(name);

  for (const name of recompute) {
    let q = supabase.from("habit_journal").select("cycle_date").eq("question", name).eq("answer", "Yes").order("cycle_date", { ascending: false }).limit(1);
    if (byName.get(name)?.channel === "whoop") q = q.gt("cycle_date", WHOOP_JOURNAL_FROZEN_THROUGH);
    const { data } = await q;
    updates.set(name, data?.[0]?.cycle_date ?? null);
  }

  for (const [name, value] of updates) {
    const pageId = byName.get(name)?.notionPageId;
    if (!pageId) continue;
    try {
      await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${NOTION_API_KEY}`, "Content-Type": "application/json", "Notion-Version": "2022-06-28" },
        body: JSON.stringify({ properties: { "Last Completed": { date: value ? { start: value } : null } } }),
      });
    } catch (e) {
      console.error("[checkin] Notion Last Completed update failed (Supabase already saved):", name, e);
    }
    await new Promise((r) => setTimeout(r, 350));
  }
}
