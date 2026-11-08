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

function sessionBlock(s: ReadingSession): Record<string, unknown> {
  const head = `${s.session_date} · ch ${s.chapter_from ?? "?"}–${s.chapter_through ?? "?"}${s.minutes ? ` · ${s.minutes} min` : ""}${s.medium ? ` · ${s.medium}` : ""}`;
  const rich: RichText[] = [text(head, { bold: true })];
  if (s.recall) rich.push(text(`\n${s.recall}`));
  if (s.question) rich.push(text(`\nQ: ${s.question}`, { italic: true }));
  return { object: "block", type: "quote", quote: { rich_text: rich } };
}

function highlightBlock(h: Highlight): Record<string, unknown> {
  const rich: RichText[] = [text(`“${h.passage}”`)];
  if (h.comment) rich.push(text(`\n— ${h.comment}`, { italic: true }));
  const meta = [h.chapter != null ? `ch ${h.chapter}` : null, h.location, h.concept, h.source !== "manual" ? h.source : null].filter(Boolean).join(" · ");
  if (meta) rich.push(text(`\n${meta}`, { code: true }));
  return { object: "block", type: "quote", quote: { rich_text: rich } };
}

/** Append a session entry under "Session log". Returns the new block id or null. */
export async function mirrorSession(book: Book, session: ReadingSession): Promise<string | null> {
  if (!book.notion_page_id || !NOTION_API_KEY) return null;
  try {
    const blocks = await listChildren(book.notion_page_id);
    const after = await sessionAnchor(blocks);
    return await insertAfter(book.notion_page_id, after, [sessionBlock(session)]);
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
