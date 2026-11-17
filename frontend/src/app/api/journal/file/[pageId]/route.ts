import { NextRequest, NextResponse } from "next/server";
import { checkVoiceRequest } from "@/lib/checkin-voice";
import { JOURNAL_MAX_REQUEST_BYTES } from "@/lib/journal-entry";
import { normalizePageId, validateJournalUpdate } from "@/lib/journal-file";
import {
  bodySha,
  inferJournalLabels,
  JournalEntryChanged,
  JournalEntryGone,
  notionConfigured,
  notionRefusalMessage,
  NotionRefused,
  updateJournalPage,
} from "@/lib/journal-file-server";

// PATCH /api/journal/file/[pageId]
// Body: { body, source, known_sha: [sha...], known_paras?: [hash16...], force?, relabel?, last_labels?, title?, mood?,
//         confidence?, topics? }
//
// The /log Journal section's autosave keeps the entry it filed (POST /api/journal/file) up to date while Riley goes
// on writing in the same box: ONE page per entry, never a second one.
//   - body: replaces the page's words VERBATIM (only the paragraphs that changed are rewritten: old ones removed,
//     then new ones added). The date never changes.
//   - known_sha: hashes (SHA-256 of the words as written) of the versions this box filed or sent (the box registers
//     each one before sending). known_paras: short hashes of those versions' paragraphs. The page must hold one of
//     those versions, or only those paragraphs (an update of the box's own that Notion stopped halfway, e.g. a 429
//     between removing and adding: the retry finishes it). Anything else was edited in Notion meanwhile: nothing is
//     written (409 `changed`), unless `force` (Riley chose "Replace it with these words"). A page that already holds
//     the new words gets only its properties.
//   - source: always set. title / mood / confidence / topics: set when sent (Riley's own).
//   - relabel: re-infer the labels in ONE model call, written only where the page still holds `last_labels` (the
//     labels this box wrote), so a label changed in Notion is never overwritten. The box asks only when the entry
//     changed a lot (shouldRelabel). A failed model call keeps the labels and still saves the words.
// Refuses a page outside the Entries database or in the trash (410 `gone`). Unknown fields are refused (400).
// Answers: 200 { id, url, sha, title, mood, confidence, topics, relabeled } (`sha` = hash of the words the page now
// holds, the box's next known_sha), 400, 404, 409 { changed }, 410 { gone },
// 502 when Notion fails (nothing is lost: the words stay in the box).
// Privacy: the text goes to Notion, and to Anthropic only for a relabel. Never logged; errors log a short code.
// Auth: session only (middleware; NOT in isCiRoute), plus a same-origin JSON check and the journal's size cap.

export const maxDuration = 60;

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ pageId: string }> }) {
  const refused = checkVoiceRequest(req.headers, req.nextUrl.origin, JOURNAL_MAX_REQUEST_BYTES);
  if (refused) return NextResponse.json({ error: refused.error }, { status: refused.status });

  const pageId = normalizePageId((await params).pageId);
  if (!pageId) return NextResponse.json({ error: "not found" }, { status: 404 });

  // Read as text first so the cap holds even without a Content-Length header.
  const rawBody = await req.text().catch(() => "");
  if (Buffer.byteLength(rawBody, "utf8") > JOURNAL_MAX_REQUEST_BYTES) return NextResponse.json({ error: "body too large" }, { status: 413 });
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const v = validateJournalUpdate(parsed);
  if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
  if (!notionConfigured()) {
    console.error("journal route: NOTION_API_KEY is not set");
    return NextResponse.json({ error: "Journal isn't connected yet. Try again later." }, { status: 500 });
  }

  try {
    const out = await updateJournalPage(pageId, v.input, inferJournalLabels);
    return NextResponse.json({ id: out.id, url: out.url, sha: bodySha(v.input.body), ...out.labels, relabeled: out.relabeled });
  } catch (e) {
    if (e instanceof JournalEntryGone) {
      console.error("[journal-file] update gone");
      return NextResponse.json({ error: "This entry is no longer in your journal (deleted in Notion).", gone: true }, { status: 410 });
    }
    if (e instanceof JournalEntryChanged) {
      console.error("[journal-file] update changed");
      return NextResponse.json({ error: "This entry was changed in Notion since, so Onyx did not overwrite it.", changed: true }, { status: 409 });
    }
    if (e instanceof NotionRefused) {
      console.error("[journal-file] notion update", e.status);
      return NextResponse.json({ error: notionRefusalMessage(e.status) }, { status: 502 });
    }
    console.error("[journal-file] update unreachable");
    return NextResponse.json({ error: "Couldn't reach Notion. The entry is still here; try again." }, { status: 502 });
  }
}
