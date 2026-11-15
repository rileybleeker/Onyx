import { NextRequest, NextResponse } from "next/server";
import { checkVoiceRequest } from "@/lib/checkin-voice";
import { easternDate, JOURNAL_MAX_REQUEST_BYTES } from "@/lib/journal-entry";
import { completeEntry, needsLabels, validateJournalFile } from "@/lib/journal-file";
import { createJournalPage, findRetriedEntry, inferJournalLabels, notionConfigured, notionRefusalMessage, NotionRefused } from "@/lib/journal-file-server";

// POST /api/journal/file   Body: { body, source: "voice" | "typed", date?, title?, mood?, confidence?, topics? }
//
// The /log Journal section's Save: files ONE entry in the personal Notion journal ("Entries", synced into
// pds.journal_entries hourly at :35 by journal_etl.py; this route never writes pds.journal_entries).
//   - body: written exactly as sent (paragraphs at blank lines; only the whitespace around it is dropped).
//   - date: today in America/New_York unless sent (never a future day).
//   - source: as sent (the section sets voice when the words were dictated, else typed).
//   - title, mood, confidence, topics: Riley's when sent; any left blank are inferred in ONE model call
//     (structured output, existing topic tags preferred). The model only labels: its output never touches the body.
// A save repeated within 15 minutes with the same day and words returns the entry already there (`existing`).
//
// Answers: 200 { url, title, mood, confidence, topics, date, existing? }, 400 with the reason, 502 when the
// labels or Notion fail (nothing written; the text stays on the screen).
// Privacy: the text goes to Anthropic (labels) and Notion only. It is never logged; errors log a short code.
// Auth: session only (middleware; NOT in isCiRoute), plus a same-origin JSON check and a size cap.

export const maxDuration = 60;

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
  const now = new Date();
  const today = easternDate(now);
  const v = validateJournalFile(parsed, today);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
  if (!notionConfigured()) return NextResponse.json({ error: "NOTION_API_KEY not configured" }, { status: 500 });
  const input = v.input;

  // The retry check and the labels run side by side: a retry is rare, so the common save does not wait twice.
  const [retry, labels] = await Promise.allSettled([
    findRetriedEntry(input.date, input.body, now),
    needsLabels(input) ? inferJournalLabels(input.body) : Promise.resolve(null),
  ]);

  if (retry.status === "rejected") {
    const status = retry.reason instanceof NotionRefused ? retry.reason.status : 0;
    console.error("[journal-file] notion query", status || "unreachable");
    return NextResponse.json({ error: status ? notionRefusalMessage(status) : "Couldn't reach Notion. The entry is still here; try again." }, { status: 502 });
  }
  if (retry.value) return NextResponse.json({ ...retry.value, date: input.date, existing: true });

  if (labels.status === "rejected") {
    console.error("[journal-file] labels failed");
    return NextResponse.json({ error: "Couldn't label the entry. It is still here; try again." }, { status: 502 });
  }
  const entry = completeEntry(input, labels.value, today);
  if (!entry) {
    console.error("[journal-file] labels unusable");
    return NextResponse.json({ error: "Couldn't label the entry. It is still here; try again." }, { status: 502 });
  }

  try {
    const url = await createJournalPage(entry);
    return NextResponse.json({ url, title: entry.title, mood: entry.mood, confidence: entry.confidence, topics: entry.topics, date: entry.date });
  } catch (e) {
    if (e instanceof NotionRefused) {
      console.error("[journal-file] notion create", e.status);
      return NextResponse.json({ error: notionRefusalMessage(e.status) }, { status: 502 });
    }
    console.error("[journal-file] unreachable");
    return NextResponse.json({ error: "Couldn't reach Notion. The entry is still here; try again." }, { status: 502 });
  }
}
