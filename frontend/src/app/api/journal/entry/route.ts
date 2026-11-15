import { NextRequest, NextResponse } from "next/server";
import { checkVoiceRequest } from "@/lib/checkin-voice";
import { easternDate, JOURNAL_MAX_REQUEST_BYTES, notionJournalPage, sameEntryQuery, validateJournalEntry } from "@/lib/journal-entry";

// POST /api/journal/entry   Body: { date, title, mood, confidence, source, topics, body }
//
// Creates ONE entry in the personal Notion journal ("Entries", the database journal_etl.py syncs into
// pds.journal_entries hourly at :35). Notion stays the journal's single write surface: this route never writes
// pds.journal_entries itself, so the entry reaches /journal and the chat's journal search on the next sync.
// Used by the /check-in journal draft, only when Riley presses "Save to journal" after reviewing it.
//
// Journal rules (AGENTS.md "When creating a journal entry in Notion"): Title, Date, Source, Confidence, Mood and
// Topics are all required here, and the body is written exactly as sent (paragraphs at blank lines).
// A save repeated with the same date and title returns the entry already there instead of a second copy.
//
// Answers: 200 { url, existing? }, 400 with the reason, 502 when Notion refuses.
// Privacy: the text goes only to Notion. It is never logged; errors log a short code only.
// Auth: session only (middleware; NOT in isCiRoute), plus a same-origin JSON check against cross-site posts.

export const maxDuration = 30;

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_JOURNAL_DB = process.env.NOTION_JOURNAL_DB || "96541038264d45aba2a9601d9b175a7e";
const NOTION_VERSION = "2022-06-28";

const notion = (path: string, body: unknown) =>
  fetch(`https://api.notion.com/v1/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${NOTION_API_KEY}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });

const pageUrl = (page: unknown): string | null => {
  const url = (page as { url?: unknown } | null)?.url;
  return typeof url === "string" && url.startsWith("https://") ? url : null;
};

function refusedByNotion(status: number) {
  console.error("[journal-entry] notion", status);
  const error =
    status === 401 || status === 403 || status === 404
      ? "Notion refused: share the Journal database with the Onyx Notion integration, then try again."
      : `Notion didn't take the entry (${status}). It is still here; try again.`;
  return NextResponse.json({ error }, { status: 502 });
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
  if (!NOTION_API_KEY) return NextResponse.json({ error: "NOTION_API_KEY not configured" }, { status: 500 });

  try {
    // Already saved (a retry after a lost answer, or a second tap)? Return that entry.
    const found = await notion(`databases/${NOTION_JOURNAL_DB}/query`, sameEntryQuery(v.entry));
    if (!found.ok) return refusedByNotion(found.status);
    const existing = ((await found.json()) as { results?: unknown[] }).results?.[0];
    if (existing) return NextResponse.json({ url: pageUrl(existing), existing: true });

    const created = await notion("pages", notionJournalPage(v.entry, NOTION_JOURNAL_DB));
    if (!created.ok) return refusedByNotion(created.status);
    return NextResponse.json({ url: pageUrl(await created.json()) });
  } catch {
    console.error("[journal-entry] unreachable");
    return NextResponse.json({ error: "Couldn't reach Notion. The entry is still here; try again." }, { status: 502 });
  }
}
