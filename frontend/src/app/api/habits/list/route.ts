import { NextResponse } from "next/server";
import { fetchActiveHabitsCached, NotionHabitsError } from "@/lib/habits-notion";

export type { NotionHabit } from "@/lib/habits-notion";

export async function GET() {
  try {
    return NextResponse.json({ habits: await fetchActiveHabitsCached() });
  } catch (e) {
    if (e instanceof NotionHabitsError) {
      console.error("habits/list", e);
      return NextResponse.json({ error: "Couldn't load your habits. Try again." }, { status: 500 });
    }
    throw e;
  }
}
