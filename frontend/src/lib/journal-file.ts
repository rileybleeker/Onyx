// Pure rules for filing a journal entry from the /log Journal section (POST /api/journal/file): the request
// check, how labels Riley gave and labels the model inferred combine, the "journal:" prefix of the Say-it box,
// the verbatim check on an excerpt the model points at, and the text of a saved Notion page (to spot a retry).
// No network, no React, so they are tested for real (frontend/tests/journal-file.test.cjs).
//
// The journal rules are AGENTS.md "When creating a journal entry in Notion": Title, Date, Source, Confidence,
// Mood and Topics are always set, and the body is the person's own words. Nothing here ever changes the body:
// the final entry goes through validateJournalEntry (lib/journal-entry.ts), the same check POST
// /api/journal/entry applies, which only drops the whitespace around it.
import {
  bodyParagraphs,
  easternDate,
  journalDraftFrom,
  normalizeTopic,
  validateJournalEntry,
  JOURNAL_CONFIDENCES,
  JOURNAL_MAX_BODY_CHARS,
  JOURNAL_MAX_TITLE_CHARS,
  JOURNAL_MAX_TOPICS,
  JOURNAL_MOODS,
  JOURNAL_SOURCES,
  type JournalConfidence,
  type JournalDraft,
  type JournalEntryInput,
  type JournalMood,
  type JournalSource,
} from "./journal-entry";
import type { JournalLogDraft } from "./log-drafts";

/**
 * The /log Journal section's one read: today's entries already in Onyx (New York date, the journal's Date rule).
 * The same URL is the client-cache key and the warm-up's (components/AppData.tsx DATA["/log"]).
 */
export const journalTodayUrl = (now: Date) => {
  const day = easternDate(now);
  return `/api/journal/list?from=${day}&to=${day}&limit=20`;
};

/** What /log sends: the words and how they were captured; any label Riley set; the day (default today, ET). */
export interface JournalFileInput {
  date: string;
  source: JournalSource;
  body: string;
  title: string; // "" = infer
  mood: JournalMood | null; // null = infer
  confidence: JournalConfidence | null; // null = infer
  topics: string[]; // [] = infer
}

const isDate = (s: unknown): s is string => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * A POSTed /log entry -> what to file, or why not. Body and source are required; date defaults to today (ET)
 * and may not be in the future; title, mood, confidence and topics are optional (blank = the model fills them).
 */
export function validateJournalFile(raw: unknown, todayEt: string): { ok: true; input: JournalFileInput } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "invalid JSON" };
  const r = raw as Record<string, unknown>;
  const date = r.date == null || r.date === "" ? todayEt : r.date;
  if (!isDate(date)) return { ok: false, error: "date must be a real YYYY-MM-DD date" };
  if (date > todayEt) return { ok: false, error: "That day hasn't happened yet." };
  if (date < "2000-01-01") return { ok: false, error: "date is too far back" };
  if (typeof r.source !== "string" || !(JOURNAL_SOURCES as readonly string[]).includes(r.source)) return { ok: false, error: "source must be voice or typed" };
  if (typeof r.body !== "string") return { ok: false, error: "body must be text" };
  const body = r.body.trim();
  if (!body) return { ok: false, error: "The entry is empty." };
  if (body.length > JOURNAL_MAX_BODY_CHARS) return { ok: false, error: `The entry must be at most ${JOURNAL_MAX_BODY_CHARS} characters.` };

  const title = typeof r.title === "string" ? oneLine(r.title) : "";
  if (title.length > JOURNAL_MAX_TITLE_CHARS) return { ok: false, error: `The title must be at most ${JOURNAL_MAX_TITLE_CHARS} characters.` };
  if (r.mood != null && !(JOURNAL_MOODS as readonly string[]).includes(r.mood as string)) return { ok: false, error: "mood must be low, neutral, good or great" };
  if (r.confidence != null && !(JOURNAL_CONFIDENCES as readonly string[]).includes(r.confidence as string)) return { ok: false, error: "confidence must be high, medium or low" };
  const topics: string[] = [];
  if (r.topics != null) {
    if (!Array.isArray(r.topics)) return { ok: false, error: "topics must be a list" };
    for (const t of r.topics) {
      const n = normalizeTopic(t);
      if (!n || topics.includes(n) || topics.length >= JOURNAL_MAX_TOPICS) return { ok: false, error: `Topics must be distinct lowercase tags (at most ${JOURNAL_MAX_TOPICS}).` };
      topics.push(n);
    }
  }
  return {
    ok: true,
    input: {
      date,
      source: r.source as JournalSource,
      body,
      title,
      mood: (r.mood as JournalMood | null | undefined) ?? null,
      confidence: (r.confidence as JournalConfidence | null | undefined) ?? null,
      topics,
    },
  };
}

/** True when the model has to fill at least one label (Riley left it blank). */
export function needsLabels(input: Pick<JournalFileInput, "title" | "mood" | "confidence" | "topics">): boolean {
  return !input.title || !input.mood || !input.confidence || input.topics.length === 0;
}

/**
 * Riley's labels win; the model's fill the blanks. Returns the entry to write (checked by validateJournalEntry,
 * so the body is exactly the text sent, trimmed), or null when a required label is still missing (the model's
 * answer was unusable: generic title, no mood, no topic).
 */
export function completeEntry(input: JournalFileInput, inferred: unknown, todayEt: string): JournalEntryInput | null {
  const d: JournalDraft = journalDraftFrom(inferred);
  const v = validateJournalEntry(
    {
      date: input.date,
      title: input.title || d.title,
      mood: input.mood ?? d.mood,
      confidence: input.confidence ?? d.confidence,
      source: input.source,
      topics: input.topics.length ? input.topics : d.topics,
      body: input.body,
    },
    todayEt,
  );
  return v.ok ? v.entry : null;
}

/** The model's instructions for the labels (same rules as the /check-in "Say it once" journal labels). */
export const JOURNAL_LABEL_RULES = `Journal labels:
- title: short and specific, 3 to 8 words, easy to scan in a list. Never generic ("Journal entry", "Note", "Check-in", "Today").
- mood: low (negative), neutral (informational or flat), good (positive) or great (strongly positive), inferred from the text. If torn between two neighbouring values, pick the lower one.
- confidence: how sure the person sounds about what they said. high for conviction ("I know", "definitely"), low for hedging ("I think maybe", "could be wrong"), otherwise medium.
- topics: 1 to 4 tags. Use known_topics whenever one reasonably fits (gym or running rather than fitness, mental-health rather than anxiety). Add a new lowercase-hyphenated tag only when none fits.
- Do not summarize or rewrite the text: the entry's body is the person's own words and is not part of your output.`;

export const JOURNAL_LABEL_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    mood: { type: "string", enum: [...JOURNAL_MOODS] },
    confidence: { type: "string", enum: [...JOURNAL_CONFIDENCES] },
    topics: { type: "array", items: { type: "string" } },
  },
  required: ["title", "mood", "confidence", "topics"],
  additionalProperties: false,
} as const;

/**
 * "journal: today felt heavy" / "Journal entry - ..." -> the words after the prefix (the prefix routes the text,
 * it is not part of the entry). Null when the text does not start with such a prefix or nothing follows it.
 * "Dear journal, ..." is not a prefix: those words are the entry itself.
 */
export function journalPrefixText(text: string): string | null {
  const m = /^\s*journal(?:\s+entry)?\s*[:\-–—]\s*([\s\S]*)$/i.exec(text);
  if (!m) return null;
  const rest = m[1].trim();
  return rest || null;
}

/**
 * The model points at the reflective part of a longer note by quoting it. Only an exact quote counts (the entry
 * must be the person's words, never the model's): returns the quote as it appears in the text, or null.
 */
export function verbatimExcerpt(text: string, excerpt: unknown): string | null {
  if (typeof excerpt !== "string") return null;
  const q = excerpt.trim();
  if (q.length < 2) return null;
  return text.includes(q) ? q : null;
}

/**
 * What the /log Say it model call returns for the journal (one more property of its JSON-schema output):
 * `is_journal` = the note (or a clear part of it) is a reflection meant for the journal; `excerpt` = that part
 * QUOTED exactly, or "" for the whole note; plus the labels.
 */
export const SAY_IT_JOURNAL_SCHEMA = {
  type: "object",
  properties: {
    is_journal: { type: "boolean" },
    excerpt: { type: "string" },
    ...JOURNAL_LABEL_SCHEMA.properties,
  },
  required: ["is_journal", "excerpt", ...JOURNAL_LABEL_SCHEMA.required],
  additionalProperties: false,
} as const;

export const SAY_IT_JOURNAL_RULES = `Journal (journal):
- is_journal: true when the note, or a clear part of it, is a reflection for the person's journal: how the day felt, thoughts, feelings, worries, what they learned, or anything they introduce with "journal" ("journal: ..."). Plain logging (what they ate, took, weighed, read, did) is not a journal entry.
- excerpt: when only part of the note is the reflection, copy that part EXACTLY as written, character for character; never reword, shorten or fix it. Use "" when the whole note is the reflection, or when is_journal is false.
${JOURNAL_LABEL_RULES.replace(/^Journal labels:\n/, "")}`;

/**
 * The Say it box's journal draft from one note, or null. A "journal:" prefix makes the rest the entry with no model
 * needed; otherwise the model's journal answer counts only when `is_journal` is true, and the entry is its excerpt
 * only when that is an exact quote of the note (verbatimExcerpt), else the whole note. The labels are suggestions
 * (blank ones are filled in at Save). `source` is "voice": the box is the "say it" path (the journal's default).
 */
export function sayItJournalDraft(text: string, raw: unknown): JournalLogDraft | null {
  const note = text.trim();
  if (!note) return null;
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const prefixed = journalPrefixText(note);
  if (!prefixed && r.is_journal !== true) return null;
  const body = prefixed ?? verbatimExcerpt(note, r.excerpt) ?? note;
  const l = journalDraftFrom(r);
  const confidence = (JOURNAL_CONFIDENCES as readonly unknown[]).includes(r.confidence) ? l.confidence : null; // null = inferred at Save
  return { body: body.slice(0, JOURNAL_MAX_BODY_CHARS), source: "voice", title: l.title || null, mood: l.mood, confidence, topics: l.topics };
}

/** The plain text of a saved journal page's paragraph blocks, joined like bodyParagraphs (to spot a retried save). */
export function pageBodyText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return "";
  const paras: string[] = [];
  for (const b of blocks) {
    const block = b as { type?: unknown; paragraph?: { rich_text?: unknown } } | null;
    if (!block || block.type !== "paragraph") continue;
    const rt = block.paragraph?.rich_text;
    if (!Array.isArray(rt)) continue;
    paras.push(rt.map((t) => {
      const piece = t as { plain_text?: unknown; text?: { content?: unknown } } | null;
      const s = piece?.plain_text ?? piece?.text?.content;
      return typeof s === "string" ? s : "";
    }).join(""));
  }
  return paras.join("\n\n");
}

/** The body as it is written to Notion, for comparing with pageBodyText. */
export const bodyAsWritten = (body: string) => bodyParagraphs(body).join("\n\n");

/** The query for this day's pages created in the last `minutes` (a retry after a lost answer is found among them). */
export function recentEntriesQuery(date: string, now: Date, minutes = 15) {
  return {
    filter: {
      and: [
        { property: "Date", date: { equals: date } },
        { timestamp: "created_time", created_time: { on_or_after: new Date(now.getTime() - minutes * 60_000).toISOString() } },
      ],
    },
    page_size: 10,
  };
}

/** The labels of a saved page (to show them after a save that turned out to be a retry). */
export function pageLabels(page: unknown): { title: string; mood: string | null; topics: string[] } {
  const props = ((page as { properties?: Record<string, unknown> } | null)?.properties ?? {}) as Record<string, {
    title?: { plain_text?: string }[];
    select?: { name?: string } | null;
    multi_select?: { name?: string }[];
  }>;
  const title = (props.Title?.title ?? []).map((t) => t?.plain_text ?? "").join("");
  const mood = props.Mood?.select?.name ?? null;
  const topics = (props.Topics?.multi_select ?? []).map((t) => t?.name ?? "").filter(Boolean);
  return { title, mood, topics };
}
