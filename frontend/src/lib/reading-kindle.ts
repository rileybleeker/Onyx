import type { SupabaseClient } from "@supabase/supabase-js";
import { type Book, type ChapterSpan, type ReadingSession, behavioralToday } from "./reading";

/**
 * Automatic reading progress from Kindle (2026-11-08).
 *
 * The local harvester (tools/kindle_harvest/harvest.mjs) reads the Kindle for Web reader and
 * posts, per book: the table of contents (chapter → start position), the print page map, every
 * highlight/note with its Kindle position + timestamp, and the Whispersync "most recent position
 * read". From that, `syncKindleSessions` derives ONE source='kindle' session per behavioral day
 * so Riley never logs a Kindle session by hand:
 *
 *   • a highlight that ends on a chapter's last page (or within END_MARGIN positions of its end)
 *     completes that chapter; a highlight inside chapter N proves chapters 1..N-1 are done;
 *   • the reading position completes chapters the same way (covers reading days with no
 *     highlights, and Audible progress when Whispersync for Voice is linked);
 *   • every day with a new highlight or note gets a session even when no chapter was completed —
 *     chapter_from/through stay NULL, `in_chapter` records where he was, and `recall` is that
 *     day's notes verbatim (so the retention XP and the streak both count it).
 *
 * The sync is a pure recomputation over all evidence (idempotent: the harvester re-posts every
 * run), never touches manual/chat sessions, and never lowers the cumulative chapter count.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Supa = SupabaseClient<any, any, any>;

export interface BookChapter extends ChapterSpan {
  book_id: number;
  title: string | null;
}

export interface ChapterInput {
  chapter: number;
  title?: string | null;
  start_position: number;
  end_position?: number | null;
  start_page?: number | null;
  end_page?: number | null;
}

/** ~800 Kindle positions ≈ a third of a print page: an annotation ending this close to a chapter's end counts as finishing it. */
export const END_MARGIN = 800;

export function chapterAt(chapters: ChapterSpan[], pos: number | null | undefined): ChapterSpan | null {
  if (pos == null) return null;
  let found: ChapterSpan | null = null;
  for (const c of chapters) {
    if (c.start_position <= pos) found = c;
    else break;
  }
  if (found && found.end_position != null && pos > found.end_position) return found; // past the last chapter: still "in" it
  return found;
}

/** Highest chapter proven complete by an annotation/position ending at `end` (and, if known, on print page `page`). */
export function chaptersDoneAt(chapters: ChapterSpan[], end: number | null | undefined, page?: number | null): number {
  const c = chapterAt(chapters, end);
  if (!c || end == null) return 0;
  const nearEnd = c.end_position != null && end >= c.end_position - END_MARGIN;
  const onLastPage = page != null && c.end_page != null && page >= c.end_page;
  return nearEnd || onLastPage ? c.chapter : Math.max(0, c.chapter - 1);
}

export async function loadChapters(supabase: Supa, book_id: number): Promise<BookChapter[]> {
  const { data, error } = await supabase.from("book_chapters").select("*").eq("book_id", book_id).order("start_position");
  if (error) throw new Error(error.message);
  return (data ?? []) as BookChapter[];
}

export async function upsertChapters(supabase: Supa, book: Book, chapters: ChapterInput[]): Promise<number> {
  const rows = chapters
    .filter((c) => Number.isInteger(c.chapter) && c.chapter >= 0 && Number.isFinite(c.start_position))
    .map((c) => ({
      book_id: book.book_id,
      chapter: c.chapter,
      title: c.title ?? null,
      start_position: Math.round(c.start_position),
      end_position: c.end_position != null ? Math.round(c.end_position) : null,
      start_page: c.start_page ?? null,
      end_page: c.end_page ?? null,
      updated_at: new Date().toISOString(),
    }));
  if (!rows.length) return 0;
  const { error } = await supabase.from("book_chapters").upsert(rows, { onConflict: "book_id,chapter" });
  if (error) throw new Error(error.message);
  return rows.length;
}

/** Record the Whispersync position (monotonic) + book identity. Returns the refreshed book. */
export async function updateReadingPosition(
  supabase: Supa,
  book: Book,
  input: { asin?: string | null; last_position?: number | null; total_positions?: number | null },
): Promise<{ book: Book; advanced: boolean }> {
  const patch: Record<string, unknown> = {};
  let advanced = false;
  if (input.asin && input.asin !== book.asin) patch.asin = input.asin;
  if (input.total_positions && input.total_positions !== book.total_positions) patch.total_positions = input.total_positions;
  const pos = input.last_position;
  if (pos != null && Number.isFinite(pos) && (book.last_position == null || pos > book.last_position)) {
    patch.last_position = Math.round(pos);
    patch.last_position_at = new Date().toISOString();
    advanced = true;
  }
  if (!Object.keys(patch).length) return { book, advanced };
  const { data, error } = await supabase.from("books").update(patch).eq("book_id", book.book_id).select("*").single();
  if (error) throw new Error(error.message);
  return { book: data as Book, advanced };
}

interface EvidenceHighlight {
  highlight_id: number;
  position: number | null;
  position_end: number | null;
  page: number | null;
  comment: string | null;
  passage: string;
  highlighted_at: string | null;
  note_at: string | null;
  behavioral_date: string | null;
}

export interface KindleSyncResult {
  created: ReadingSession[];
  updated: ReadingSession[];
  unchanged: number;
  chaptersDone: number;
  finished: boolean;
  habitDays: string[];
  skipped?: string;
}

function sessionDiffers(a: ReadingSession, b: Partial<ReadingSession>): boolean {
  return (
    (a.chapter_from ?? null) !== (b.chapter_from ?? null) ||
    (a.chapter_through ?? null) !== (b.chapter_through ?? null) ||
    (a.in_chapter ?? null) !== (b.in_chapter ?? null) ||
    (a.recall ?? null) !== (b.recall ?? null) ||
    (a.highlight_count ?? null) !== (b.highlight_count ?? null)
  );
}

async function behavioralDateFor(supabase: Supa, iso: string): Promise<string> {
  try {
    const { data } = await supabase.rpc("behavioral_date_for", { ts: iso });
    if (typeof data === "string" && data) return data;
  } catch {
    /* fall through */
  }
  // ET, −6h rule.
  const d = new Date(new Date(iso).getTime() - 6 * 3600_000);
  return d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

/**
 * Recompute the book's source='kindle' sessions from all highlight/position evidence.
 * Side effects: upserts sessions, stamps the book's habit (Yes) on new session days, and flips
 * the book to finished when the last chapter is proven. Notion mirroring is left to the caller.
 */
export async function syncKindleSessions(supabase: Supa, bookIn: Book): Promise<KindleSyncResult> {
  const book = bookIn;
  const today = await behavioralToday(supabase);
  const chapters = await loadChapters(supabase, book.book_id);

  const { data: sessRows, error: sErr } = await supabase
    .from("reading_sessions")
    .select("*")
    .eq("book_id", book.book_id)
    .order("session_date")
    .order("session_id");
  if (sErr) throw new Error(sErr.message);
  const sessions = (sessRows ?? []) as ReadingSession[];
  const manual = sessions.filter((s) => s.source !== "kindle");
  const autos = new Map(sessions.filter((s) => s.source === "kindle").map((s) => [s.session_date, s]));
  const cumAll = sessions.reduce((m, s) => Math.max(m, s.chapter_through ?? 0), 0);

  if (!chapters.length) {
    return { created: [], updated: [], unchanged: autos.size, chaptersDone: cumAll, finished: false, habitDays: [], skipped: "no chapter map yet" };
  }

  const { data: hlRows, error: hErr } = await supabase
    .from("book_highlights")
    .select("highlight_id,position,position_end,page,comment,passage,highlighted_at,note_at,behavioral_date")
    .eq("book_id", book.book_id)
    .eq("archived", false)
    .eq("source", "kindle")
    .not("position", "is", null)
    .order("position");
  if (hErr) throw new Error(hErr.message);
  const highlights = (hlRows ?? []) as EvidenceHighlight[];

  // Evidence per behavioral day.
  type DayEvidence = { highlights: EvidenceHighlight[]; lpr: number | null };
  const days = new Map<string, DayEvidence>();
  const dayOf = (d: string) => days.get(d) ?? days.set(d, { highlights: [], lpr: null }).get(d)!;
  for (const h of highlights) dayOf(h.behavioral_date ?? today).highlights.push(h);
  if (book.last_position != null && book.last_position_at) {
    dayOf(await behavioralDateFor(supabase, book.last_position_at)).lpr = book.last_position;
  }

  const allDays = [...new Set([...days.keys(), ...manual.map((s) => s.session_date)])].sort();
  const total = book.total_chapters ?? Infinity;
  let cum = 0; // chapters proven done before this day, all sources
  let evidenceMax = 0; // chapters proven by Kindle evidence so far
  const created: ReadingSession[] = [];
  const updated: ReadingSession[] = [];
  const habitDays: string[] = [];
  let unchanged = 0;

  for (const d of allDays) {
    const manualThrough = manual.filter((s) => s.session_date === d).reduce((m, s) => Math.max(m, s.chapter_through ?? 0), 0);
    const ev = days.get(d);
    if (!ev) {
      cum = Math.max(cum, manualThrough);
      continue;
    }
    for (const h of ev.highlights) evidenceMax = Math.max(evidenceMax, chaptersDoneAt(chapters, h.position_end ?? h.position, h.page));
    if (ev.lpr != null) evidenceMax = Math.max(evidenceMax, chaptersDoneAt(chapters, ev.lpr, null));

    const base = Math.max(cum, manualThrough);
    const through = Math.min(total, Math.max(base, evidenceMax));
    const advanced = through > base;
    const positions = ev.highlights.map((h) => h.position_end ?? h.position ?? -1);
    if (ev.lpr != null) positions.push(ev.lpr);
    const inChapter = chapterAt(chapters, positions.length ? Math.max(...positions) : null)?.chapter ?? null;
    const notes = [...ev.highlights]
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      .map((h) => (h.comment?.trim() ? h.comment.trim() : !h.highlighted_at && h.note_at ? h.passage.trim() : ""))
      .filter(Boolean);

    const row = {
      book_id: book.book_id,
      session_date: d,
      source: "kindle" as const,
      medium: "kindle" as const,
      chapter_from: advanced ? base + 1 : null,
      chapter_through: advanced ? through : null,
      in_chapter: inChapter,
      recall: notes.length ? notes.join("\n\n") : null,
      highlight_count: ev.highlights.length,
    };

    const existing = autos.get(d);
    if (!existing) {
      const { data, error } = await supabase.from("reading_sessions").insert(row).select("*").single();
      if (error) throw new Error(error.message);
      created.push(data as ReadingSession);
      habitDays.push(d);
    } else if (sessionDiffers(existing, row)) {
      const { data, error } = await supabase.from("reading_sessions").update(row).eq("session_id", existing.session_id).select("*").single();
      if (error) throw new Error(error.message);
      updated.push(data as ReadingSession);
    } else unchanged += 1;

    cum = Math.max(base, through);
  }

  const chaptersDone = Math.max(cumAll, cum);

  // Habit stamp (Yes) for each new session day — /habits + the HRV habit_* columns see the reading.
  if (book.habit_name && habitDays.length) {
    const { error } = await supabase
      .from("habit_journal")
      .upsert(
        habitDays.map((d) => ({ cycle_date: d, question: book.habit_name, category: "learning", answer: "Yes" })),
        { onConflict: "cycle_date,question" },
      );
    if (error) console.error("reading-kindle: habit stamp failed:", error.message);
  }

  let finished = false;
  if (book.total_chapters && chaptersDone >= book.total_chapters && book.status !== "finished") {
    const lastDay = [...created, ...updated].map((s) => s.session_date).sort().pop() ?? today;
    await supabase.from("books").update({ status: "finished", finished_on: lastDay }).eq("book_id", book.book_id);
    finished = true;
  }

  return { created, updated, unchanged, chaptersDone, finished, habitDays };
}
