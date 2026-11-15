import { NextRequest, NextResponse } from "next/server";
import { checkVoiceRequest } from "@/lib/checkin-voice";
import { easternDate, JOURNAL_MAX_REQUEST_BYTES, sameEntryQuery, validateJournalEntry } from "@/lib/journal-entry";
import { createJournalPage, notionConfigured, notionPost, notionRefusalMessage, NotionRefused, NOTION_JOURNAL_DB, pageUrl } from "@/lib/journal-file-server";

// POST /api/journal/entry   Body: { date, title, mood, confidence, source, topics, body }
//
// Creates ONE entry in the personal Notion journal ("Entries", the database journal_etl.py syncs into
// pds.journal_entries hourly at :35). Notion stays the journal's single write surface: this route never writes
// pds.journal_entries itself, so the entry reaches /journal and the chat's journal search on the next sync.
// Used by the /check-in journal draft, only when Riley presses "Save to journal" after reviewing it.
// (The /log Journal section uses POST /api/journal/file, which also fills blank labels; same Notion calls.)
//
// Journal rules (AGENTS.md "When creating a journal entry in Notion"): Title, Date, Source, Confidence, Mood and
// Topics are all required here, and the body is written exactly as sent (paragraphs at blank lines).
// A save repeated with the same date and title returns the entry already there instead of a second copy.
//
// Answers: 200 { url, existing? }, 400 with the reason, 502 when Notion refuses.
// Privacy: the text goes only to Notion. It is never logged; errors log a short code only.
// Auth: session only (middleware; NOT in isCiRoute), plus a same-origin JSON check against cross-site posts.

export const maxDuration = 30;

function refusedByNotion(status: number) {
  console.error("[journal-entry] notion", status);
  return NextResponse.json({ error: notionRefusalMessage(status) }, { status: 502 });
}

export async function POST(req: NextRequest) {
  const refused = checkVoiceRequest(req.headers, req.nextUrl.origin, JOURNAL_MAX_REQUEST_BYTES);
  if (refused) return NextResponse.json({ error: refused.error }, { status: refused.status });

  // Read as text first so the cap holds even without a Content-Length header.
  const rawBody = await req.text().catch(() => "");
  if (Buffer.byteLength(rawBody, "utf8") > JOURNAL_MAX_REQUEST_BYTES) return NextResponse.json({ error: "body too large" }, { status: 413 });
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const v = validateJournalEntry(parsed, easternDate(new Date()));
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
  if (!notionConfigured()) return NextResponse.json({ error: "NOTION_API_KEY not configured" }, { status: 500 });

  try {
    // Already saved (a retry after a lost answer, or a second tap)? Return that entry.
    const found = await notionPost(`databases/${NOTION_JOURNAL_DB}/query`, sameEntryQuery(v.entry));
    if (!found.ok) return refusedByNotion(found.status);
    const existing = ((await found.json()) as { results?: unknown[] }).results?.[0];
    if (existing) return NextResponse.json({ url: pageUrl(existing), existing: true });

    return NextResponse.json({ url: await createJournalPage(v.entry) });
  } catch (e) {
    if (e instanceof NotionRefused) return refusedByNotion(e.status);
    console.error("[journal-entry] unreachable");
    return NextResponse.json({ error: "Couldn't reach Notion. The entry is still here; try again." }, { status: 502 });
  }
}
