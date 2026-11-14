// Server-only helpers shared by the check-in routes (GET/POST /api/habits/checkin and POST
// /api/habits/checkin/voice): behavioral today, the date window, and the active question list.
import { createClient } from "@supabase/supabase-js";
import { fetchActiveHabits, type NotionHabit } from "@/lib/habits-notion";
import { addDays, CHECKIN_MAX_DAYS_BACK, fallbackBehavioralToday, groupFor, SLEEP_QUESTIONS, type CheckinItem } from "@/lib/checkin";

export const WHOOP_JOURNAL_FROZEN_THROUGH = "2026-06-08";

export const checkinSupabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
});

export const isDate = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);

export async function behavioralToday(): Promise<string> {
  try {
    const { data } = await checkinSupabase.rpc("behavioral_today_now");
    if (data) return data as string;
  } catch {
    /* fall through */
  }
  return fallbackBehavioralToday(new Date());
}

export function dateError(date: string, today: string): string | null {
  if (date > today) return "That day hasn't happened yet.";
  if (date < addDays(today, -CHECKIN_MAX_DAYS_BACK)) return `The check-in only covers today and the ${CHECKIN_MAX_DAYS_BACK} days before.`;
  if (date <= WHOOP_JOURNAL_FROZEN_THROUGH) return "That day is in the frozen WHOOP era.";
  return null;
}

export async function loadItems(): Promise<{ items: CheckinItem[]; habits: NotionHabit[] }> {
  const [habits, { data: map }] = await Promise.all([fetchActiveHabits(), checkinSupabase.from("habit_name_map").select("habit_name, channel")]);
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
