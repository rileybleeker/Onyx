import { NextResponse } from "next/server";
import { fetchActiveHabits, NotionHabitsError } from "@/lib/habits-notion";

export type { NotionHabit } from "@/lib/habits-notion";

export async function GET() {
  try {
    return NextResponse.json({ habits: await fetchActiveHabits() });
  } catch (e) {
    if (e instanceof NotionHabitsError) {
      return NextResponse.json({ error: e.message, status: e.status, detail: e.detail }, { status: 500 });
    }
    throw e;
  }
}
