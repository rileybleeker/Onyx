import { createClient } from "@supabase/supabase-js";
import { after, NextRequest, NextResponse } from "next/server";
import { fetchActiveHabits, NotionHabitsError, type NotionHabit } from "@/lib/habits-notion";
import {
  addDays,
  CHECKIN_MAX_DAYS_BACK,
  type CheckinAnswer,
  type CheckinItem,
  type CheckinPayload,
  type CheckinSuggestion,
} from "@/lib/checkin";

/**
 * Daily habit check-in (2026-11-07). One screen, one write for a whole behavior day.
 *
 * GET  /api/habits/checkin?date=YYYY-MM-DD → CheckinPayload (questions, saved answers, data-backed pre-fills,
 *      progress for today and the two days before). date defaults to behavioral today.
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
const Q_PLANE = "Traveled on a plane?";
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
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
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
      const daily = h.frequency === "daily" || h.frequency === "weekdays";
      return { name: h.name, notionPageId: h.id, category: h.category, frequency: h.frequency, channel: ch, group: ch === "whoop" || daily ? "core" : "extra" };
    });
  return { items, habits };
}

/** Pre-fills from other sources. Each one is only offered when the data is clear; otherwise the question stays blank. */
async function suggestionsFor(date: string, names: Set<string>): Promise<Record<string, CheckinSuggestion>> {
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

  if (names.has(Q_PLANE)) {
    tasks.push(
      (async () => {
        // 1) A parsed Delta segment departing or landing on this behavior day (pds.flights, from the
        //    confirmation-email ETL). This also catches same-offset trips (ATL↔YYZ) the tz diff can't see.
        // 2) Fallback: the time zone the user_tz_log ladder resolves changed across the day.
        //    Behavior day ≈ 06:00 that day → 06:00 the next (the −6h rule); ET offsets are close enough.
        const [f, a, b] = await Promise.all([
          supabase
            .from("flights")
            .select("flight_number, dep_iata, arr_iata")
            .in("status", ["confirmed", "changed"])
            .or(`onyx_behavioral_date.eq.${date},arr_behavioral_date.eq.${date},dep_local_date.eq.${date}`)
            .order("dep_local_date")
            .limit(3),
          supabase.rpc("tz_for_instant", { ts: `${date}T10:00:00Z` }),
          supabase.rpc("tz_for_instant", { ts: `${addDays(date, 1)}T10:00:00Z` }),
        ]);
        const flights = (f.data ?? []) as { flight_number: string; dep_iata: string | null; arr_iata: string | null }[];
        if (flights.length) {
          const route = flights.map((x) => `${x.flight_number} ${x.dep_iata ?? "?"}→${x.arr_iata ?? "?"}`).join(", ");
          out[Q_PLANE] = { answer: "Yes", source: `Flight: ${route}` };
        } else if (a.data && b.data && a.data !== b.data) {
          out[Q_PLANE] = { answer: "Yes", source: `Time zone changed to ${String(b.data).split("/").pop()?.replace(/_/g, " ")}` };
        }
      })()
    );
  }

  await Promise.all(tasks.map((t) => t.catch((e) => console.error("[checkin] suggestion failed", e))));
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

    const [{ data: rows, error }, suggestions] = await Promise.all([
      supabase.from("habit_journal").select("cycle_date, question, answer").gte("cycle_date", from).lte("cycle_date", today).in("question", names),
      suggestionsFor(date, new Set(names)),
    ]);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const answers: Record<string, CheckinAnswer> = {};
    const answeredByDay = new Map<string, number>();
    for (const r of (rows ?? []) as { cycle_date: string; question: string; answer: CheckinAnswer }[]) {
      if (r.cycle_date === date) answers[r.question] = r.answer;
      if (core.has(r.question)) answeredByDay.set(r.cycle_date, (answeredByDay.get(r.cycle_date) || 0) + 1);
    }
    const days = Array.from({ length: CHECKIN_MAX_DAYS_BACK + 1 }, (_, i) => addDays(today, -i))
      .filter((d) => d > WHOOP_JOURNAL_FROZEN_THROUGH)
      .map((d) => ({ date: d, answered: answeredByDay.get(d) || 0, total: core.size }));

    const payload: CheckinPayload = { date, today, items, answers, suggestions, days };
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof NotionHabitsError) return NextResponse.json({ error: e.message }, { status: 502 });
    throw e;
  }
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => ({}))) as { date?: unknown; answers?: unknown };
  const today = await behavioralToday();
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
