import type { Book, Highlight, ReadingSession } from "./reading";

/**
 * Notion mirror for the reading module. Best-effort, server-only: every
 * function swallows errors (logs them) and returns null, so a Notion outage
 * never fails a Supabase write. Callers run these inside Next's `after()`.
 *
 * Target page = books.notion_page_id (the per-book "reading log" page). The
 * page has a callout at the top ("Progress: chapter X of N …"), a "## Session
 * log" heading followed by a "Newest first." paragraph, and (created here on
 * first use) a "## Highlights" heading. New entries are inserted right after
 * those anchors with the blocks API `after` parameter, so both lists stay
 * newest-first without rewriting the page.
 *
 * The Onyx Notion integration must have access to the page (it lives under
 * Project Onyx; share the parent with the integration once if a 404 shows up
 * in the logs).
 */

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_VERSION = "2022-06-28";

/** Whether the mirror can write at all (an API key is configured). */
export function notionMirrorEnabled(): boolean {
  return !!NOTION_API_KEY;
}

type RichText = Record<string, unknown>;
interface NotionBlock {
  id: string;
  type: string;
  has_children?: boolean;
  [k: string]: unknown;
}

async function notion(path: string, init: RequestInit = {}): Promise<Response> {
  if (!NOTION_API_KEY) throw new Error("NOTION_API_KEY not configured");
  return fetch(`https://api.notion.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

async function listChildren(blockId: string): Promise<NotionBlock[]> {
  const out: NotionBlock[] = [];
  let cursor: string | null = null;
  do {
    const qs = new URLSearchParams({ page_size: "100" });
    if (cursor) qs.set("start_cursor", cursor);
    const res = await notion(`/blocks/${blockId}/children?${qs}`);
    if (!res.ok) throw new Error(`Notion list children ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { results: NotionBlock[]; has_more: boolean; next_cursor: string | null };
    out.push(...data.results);
    cursor = data.has_more ? data.next_cursor : null;
  } while (cursor);
  return out;
}

function plainText(block: NotionBlock): string {
  const inner = block[block.type] as { rich_text?: Array<{ plain_text?: string }> } | undefined;
  return (inner?.rich_text ?? []).map((r) => r.plain_text ?? "").join("");
}

function text(content: string, annotations?: Record<string, boolean>): RichText {
  // Notion caps a rich_text segment at 2000 chars.
  const c = content.length > 1990 ? content.slice(0, 1987) + "…" : content;
  return { type: "text", text: { content: c }, ...(annotations ? { annotations } : {}) };
}

function dateMention(date: string): RichText {
  return { type: "mention", mention: { type: "date", date: { start: date } } };
}

async function insertAfter(pageId: string, afterBlockId: string | null, children: Record<string, unknown>[]): Promise<string | null> {
  const body: Record<string, unknown> = { children };
  if (afterBlockId) body.after = afterBlockId;
  const res = await notion(`/blocks/${pageId}/children`, { method: "PATCH", body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Notion append ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { results: NotionBlock[] };
  return data.results?.[0]?.id ?? null;
}

/** Returns the block id to insert a new session after (the "Newest first." paragraph, else the Session log heading). */
async function sessionAnchor(blocks: NotionBlock[]): Promise<string | null> {
  const heading = blocks.findIndex((b) => b.type.startsWith("heading") && /^session log/i.test(plainText(b)));
  if (heading < 0) return null;
  const next = blocks[heading + 1];
  if (next && next.type === "paragraph" && /^newest first/i.test(plainText(next))) return next.id;
  return blocks[heading].id;
}

async function highlightsAnchor(pageId: string, blocks: NotionBlock[]): Promise<string | null> {
  const heading = blocks.find((b) => b.type.startsWith("heading") && /^highlights/i.test(plainText(b)));
  if (heading) return heading.id;
  // Create the section at the end of the page: heading + explainer.
  const res = await notion(`/blocks/${pageId}/children`, {
    method: "PATCH",
    body: JSON.stringify({
      children: [
        { object: "block", type: "heading_2", heading_2: { rich_text: [text("Highlights")] } },
        {
          object: "block",
          type: "paragraph",
          paragraph: { rich_text: [text("Mirrored from Onyx /reading. Newest first. Edit comments in Onyx, not here.", { italic: true })] },
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`Notion create Highlights section ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { results: NotionBlock[] };
  // Insert after the explainer paragraph so the heading stays on top.
  return data.results?.[1]?.id ?? data.results?.[0]?.id ?? null;
}

/**
 * The claim marker (Codex review of PR 376, round 6): a session entry written under a claim in
 * pds.reading_mirror_claims ends with one zero-width character linked to MARKER_BASE + the claim's random id. It is
 * invisible on the page and is the entry's identity until its block id is stored: two sessions with identical text
 * get different markers, so a claim can only ever find its own entry. The id is a random UUID; nothing about the
 * session is in it. Rewriting the entry (updateMirroredSession) drops the marker, which is only needed until then.
 */
const MARKER_BASE = "https://onyx.invalid/reading-entry/";
const MARKER_TEXT = "​";

function sessionBlock(s: ReadingSession, marker: string | null = null): Record<string, unknown> {
  const span =
    s.chapter_through != null
      ? `ch ${s.chapter_from ?? "?"}–${s.chapter_through}`
      : s.in_chapter != null
        ? `in ch ${s.in_chapter} (notes, no chapter completed)`
        : "ch ?";
  const head = `${s.session_date} · ${span}${s.minutes ? ` · ${s.minutes} min` : ""}${s.medium ? ` · ${s.medium}` : ""}${s.source === "kindle" ? " · auto from Kindle" : ""}`;
  const rich: RichText[] = [text(head, { bold: true })];
  if (s.recall) rich.push(text(`
${s.recall}`));
  if (s.question) rich.push(text(`
Q: ${s.question}`, { italic: true }));
  if (marker) rich.push({ type: "text", text: { content: MARKER_TEXT, link: { url: MARKER_BASE + marker } } });
  return { object: "block", type: "quote", quote: { rich_text: rich } };
}

/** The claim marker an entry carries, or null (pure; exported for the tests). */
export function entryMarker(block: { type?: string; [k: string]: unknown }): string | null {
  const inner = block.type ? (block[block.type] as { rich_text?: Array<Record<string, unknown>> } | undefined) : undefined;
  for (const r of inner?.rich_text ?? []) {
    const href = typeof r.href === "string" ? r.href : ((r.text as { link?: { url?: string } | null } | undefined)?.link?.url ?? null);
    if (href && href.startsWith(MARKER_BASE)) return href.slice(MARKER_BASE.length);
  }
  return null;
}

function highlightBlock(h: Highlight): Record<string, unknown> {
  const rich: RichText[] = [text(`“${h.passage}”`)];
  if (h.comment) rich.push(text(`\n— ${h.comment}`, { italic: true }));
  const meta = [h.chapter != null ? `ch ${h.chapter}` : null, h.location, h.concept, h.source !== "manual" ? h.source : null].filter(Boolean).join(" · ");
  if (meta) rich.push(text(`\n${meta}`, { code: true }));
  return { object: "block", type: "quote", quote: { rich_text: rich } };
}

/**
 * The page's live session entries carrying this claim marker (normally one). null when the page could not be read.
 * Only top-level quote blocks are looked at: that is where mirrorSession puts entries.
 */
export async function findSessionBlocksByMarker(pageId: string, marker: string): Promise<string[] | null> {
  if (!NOTION_API_KEY) return null;
  try {
    const hits: string[] = [];
    for (const b of await listChildren(pageId)) {
      if (b.type !== "quote" || b.archived === true || b.in_trash === true) continue;
      if (entryMarker(b) === marker) hits.push(b.id);
    }
    return hits;
  } catch (e) {
    console.error("reading-notion: findSessionBlocksByMarker failed:", e instanceof Error ? e.name : "unknown");
    return null;
  }
}

/**
 * Append a session entry under "Session log". Returns the new block id or null. `marker` = the claim id the entry is
 * written under (pds.reading_mirror_claims), so the sweep can find it before its block id is stored.
 */
export async function mirrorSession(book: Book, session: ReadingSession, marker: string | null = null): Promise<string | null> {
  if (!book.notion_page_id || !NOTION_API_KEY) return null;
  try {
    const blocks = await listChildren(book.notion_page_id);
    const after = await sessionAnchor(blocks);
    return await insertAfter(book.notion_page_id, after, [sessionBlock(session, marker)]);
  } catch (e) {
    console.error("reading-notion: mirrorSession failed:", e);
    return null;
  }
}

/** Append a highlight under "Highlights" (section created on first use). Returns the new block id or null. */
export async function mirrorHighlight(book: Book, h: Highlight): Promise<string | null> {
  if (!book.notion_page_id || !NOTION_API_KEY) return null;
  try {
    const blocks = await listChildren(book.notion_page_id);
    const after = await highlightsAnchor(book.notion_page_id, blocks);
    return await insertAfter(book.notion_page_id, after, [highlightBlock(h)]);
  } catch (e) {
    console.error("reading-notion: mirrorHighlight failed:", e);
    return null;
  }
}

/**
 * The Notion entry an earlier, stopped try already made for this row: a try can append the entry and stop before
 * storing its block id, and the row then reads as "not mirrored". Read-only: the page's quote blocks are compared with
 * what mirrorSession / mirrorHighlight would write for the row now, ignoring blocks other rows already claim. Exactly
 * one match is the entry (its id); none, several (it cannot be told which), a Notion outage or no Notion access is
 * null, never a guess, and nothing is ever written here.
 */
export async function findMirroredEntry(
  book: Book,
  kind: "session" | "highlight",
  row: ReadingSession | Highlight,
  claimed: ReadonlySet<string>,
): Promise<string | null> {
  if (!book.notion_page_id || !NOTION_API_KEY) return null;
  try {
    const block = kind === "session" ? sessionBlock(row as ReadingSession) : highlightBlock(row as Highlight);
    const want = (((block.quote as { rich_text?: Array<{ text?: { content?: string } }> }).rich_text) ?? []).map((r) => r.text?.content ?? "").join("");
    if (!want) return null;
    const blocks = await listChildren(book.notion_page_id);
    const hits = blocks.filter((b) => b.type === "quote" && !claimed.has(b.id) && plainText(b) === want);
    return hits.length === 1 ? hits[0].id : null;
  } catch (e) {
    console.error("reading-notion: findMirroredEntry failed:", e);
    return null;
  }
}

/** Update an already-mirrored session block in place (Kindle-derived sessions grow as notes arrive). */
export async function updateMirroredSession(s: ReadingSession): Promise<boolean> {
  if (!s.notion_block_id || !NOTION_API_KEY) return false;
  try {
    const block = sessionBlock(s);
    const res = await notion(`/blocks/${s.notion_block_id}`, { method: "PATCH", body: JSON.stringify({ quote: block.quote }) });
    return res.ok;
  } catch (e) {
    console.error("reading-notion: updateMirroredSession failed:", e);
    return false;
  }
}

/**
 * Rewrites a session's entry from the session as it is now, for the claim sweep (Codex T01-R11): "updated" = Notion
 * accepted the rewrite; "archived" = the entry can be read and is archived or in the trash (removed in Notion by hand:
 * there is nothing left to bring up to date); "failed" = anything else (refused, unreadable, a 404, which can also
 * mean the page was unshared), to be tried again.
 */
export async function refreshMirroredSession(s: ReadingSession): Promise<"updated" | "archived" | "failed"> {
  if (!s.notion_block_id || !NOTION_API_KEY) return "failed";
  try {
    const block = sessionBlock(s);
    const res = await notion(`/blocks/${s.notion_block_id}`, { method: "PATCH", body: JSON.stringify({ quote: block.quote }) });
    if (res.ok) return "updated";
    const look = await notion(`/blocks/${s.notion_block_id}`, { method: "GET" });
    if (!look.ok) return "failed";
    const b = (await look.json()) as { archived?: boolean; in_trash?: boolean };
    return b.archived === true || b.in_trash === true ? "archived" : "failed";
  } catch (e) {
    console.error("reading-notion: refreshMirroredSession failed:", e instanceof Error ? e.name : "unknown");
    return "failed";
  }
}

/** Update an already-mirrored highlight block in place (comment / concept edits). */
export async function updateMirroredHighlight(h: Highlight): Promise<boolean> {
  if (!h.notion_block_id || !NOTION_API_KEY) return false;
  try {
    const block = highlightBlock(h);
    const res = await notion(`/blocks/${h.notion_block_id}`, { method: "PATCH", body: JSON.stringify({ quote: block.quote }) });
    return res.ok;
  } catch (e) {
    console.error("reading-notion: updateMirroredHighlight failed:", e);
    return false;
  }
}

/** True when the two rows would render a different Notion entry (pure; used after a create raced an edit). */
export function sessionMirrorDiffers(a: ReadingSession, b: ReadingSession): boolean {
  return a.book_id !== b.book_id || JSON.stringify(sessionBlock(a)) !== JSON.stringify(sessionBlock(b));
}
export function highlightMirrorDiffers(a: Highlight, b: Highlight): boolean {
  return JSON.stringify(highlightBlock(a)) !== JSON.stringify(highlightBlock(b));
}

/**
 * Move a mirrored entry to Notion's trash (a session removed in Onyx, or moved to another book's page). True only when
 * the removal is POSITIVELY confirmed: the delete succeeded, or the block can still be read and is archived / in the
 * trash. A 404 is NOT taken as "gone": Notion answers 404 for a page that was unshared from the integration too, so
 * the cleanup stays owed (and retried) until the block can be seen archived (Codex review of PR 376).
 */
export async function removeMirroredBlock(blockId: string | null): Promise<boolean> {
  if (!blockId || !NOTION_API_KEY) return false;
  try {
    const res = await notion(`/blocks/${blockId}`, { method: "DELETE" });
    if (res.ok) return true;
    // Already trashed: Notion refuses the delete (400) but still returns the block, flagged archived.
    const look = await notion(`/blocks/${blockId}`, { method: "GET" });
    if (!look.ok) return false;
    const b = (await look.json()) as { archived?: boolean; in_trash?: boolean };
    return b.archived === true || b.in_trash === true;
  } catch (e) {
    console.error("reading-notion: removeMirroredBlock failed:", e);
    return false;
  }
}

/** Rewrite the progress callout's title line at the top of the page. */
export async function mirrorProgress(book: Book, chaptersDone: number, lastSessionDate: string | null): Promise<boolean> {
  if (!book.notion_page_id || !NOTION_API_KEY) return false;
  try {
    const blocks = await listChildren(book.notion_page_id);
    const callout = blocks.find((b) => b.type === "callout");
    if (!callout) return false;
    const total = book.total_chapters ?? 0;
    const rich: RichText[] = [
      text("Progress: ", { bold: true }),
      text(`chapter ${chaptersDone}${total ? ` of ${total}` : ""} · last session: ${lastSessionDate ?? "none yet"} · `),
      text(book.status === "finished" ? "finished " : "finish by ", { bold: true }),
    ];
    if (book.status === "finished" && book.finished_on) rich.push(dateMention(book.finished_on));
    else if (book.target_date) rich.push(dateMention(book.target_date));
    const res = await notion(`/blocks/${callout.id}`, {
      method: "PATCH",
      body: JSON.stringify({ callout: { rich_text: rich } }),
    });
    if (!res.ok) throw new Error(`Notion callout update ${res.status}: ${await res.text()}`);
    return true;
  } catch (e) {
    console.error("reading-notion: mirrorProgress failed:", e);
    return false;
  }
}
