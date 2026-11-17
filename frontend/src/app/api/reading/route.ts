import { after, NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getOverview, listBooks } from "@/lib/reading";
import { sweepPendingRemovals } from "@/lib/reading-removal";

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
  db: { schema: "pds" },
});

/**
 * GET /api/reading?book=<slug>
 * The full "quest" overview for one book (default: the book with status
 * 'reading'): progress, pace, streak, XP, badges, checkpoints, sessions,
 * highlights, due reviews, burn-up series. Everything is derived in
 * lib/reading.ts from the raw rows. Also returns the book list for the
 * switcher.
 */
export async function GET(req: NextRequest) {
  try {
    // Finishes Notion cleanup a removal still owes after a failure (at most once a minute; a removal's own work
    // already ran or failed before this). Nothing of the reader's data is written.
    after(() => sweepPendingRemovals(supabase));
    const slug = req.nextUrl.searchParams.get("book");
    const [overview, books] = await Promise.all([getOverview(supabase, slug), listBooks(supabase)]);
    if (!overview) return NextResponse.json({ overview: null, books }, { status: 200 });
    return NextResponse.json({ overview, books });
  } catch (e) {
    console.error("GET /api/reading failed:", e);
    return NextResponse.json({ error: "Couldn't load your reading. Try again." }, { status: 500 });
  }
}
