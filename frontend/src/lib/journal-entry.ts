// Pure rules for a journal entry Onyx writes to the personal Notion journal (the "Entries" database that
// journal_etl.py syncs into pds.journal_entries every hour at :35). Used by the /check-in journal draft and
// POST /api/journal/entry. No network, no React, so they are tested for real (frontend/tests/journal-entry.test.cjs).
//
// The field rules mirror AGENTS.md "When creating a journal entry in Notion" (and the "Reminders/Habits/Journal
// Entry" Claude.ai Project): all six properties are always set, and the page body is the person's own words.
// Change them together.

export const JOURNAL_MOODS = ["low", "neutral", "good", "great"] as const;
export type JournalMood = (typeof JOURNAL_MOODS)[number];
export const JOURNAL_CONFIDENCES = ["high", "medium", "low"] as const;
export type JournalConfidence = (typeof JOURNAL_CONFIDENCES)[number];
/** How the entry was captured. "remarkable" (the paper notebook) never comes from the check-in, so it is not offered. */
export const JOURNAL_SOURCES = ["voice", "typed"] as const;
export type JournalSource = (typeof JOURNAL_SOURCES)[number];

/** The journal's existing topic tags (2026-11-14). Prefer these; a new tag only when none fits. */
export const JOURNAL_TOPICS: readonly string[] = [
  "work",
  "relationships",
  "dating",
  "health",
  "gym",
  "running",
  "alcohol",
  "sobriety",
  "mental-health",
  "family",
  "travel",
  "reflection",
  "goals",
  "finance",
  "sleep",
];

export const JOURNAL_MAX_TITLE_CHARS = 120;
export const JOURNAL_MAX_BODY_CHARS = 8000;
export const JOURNAL_MAX_TOPICS = 6;
/** Request cap for POST /api/journal/entry (the body can hold multi-byte characters). */
export const JOURNAL_MAX_REQUEST_BYTES = 32 * 1024;
/** Notion: at most 2000 characters per text object and 100 blocks per create request. */
export const NOTION_TEXT_CHUNK = 2000;
export const NOTION_MAX_BLOCKS = 100;

const GENERIC_TITLES = /^(journal( entry)?|entry|note|notes|check-?in|daily check-?in|today)$/i;
const TOPIC_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

const isMood = (v: unknown): v is JournalMood => typeof v === "string" && (JOURNAL_MOODS as readonly string[]).includes(v);
const isConfidence = (v: unknown): v is JournalConfidence => typeof v === "string" && (JOURNAL_CONFIDENCES as readonly string[]).includes(v);
const isSource = (v: unknown): v is JournalSource => typeof v === "string" && (JOURNAL_SOURCES as readonly string[]).includes(v);

/** What the model suggests for the entry. The body is never part of it: the body is the person's own text. */
export interface JournalDraft {
  title: string; // "" when the suggestion was missing or generic: Riley writes one
  mood: JournalMood | null; // null: Riley picks one before saving
  confidence: JournalConfidence;
  topics: string[];
}

export interface JournalEntryInput {
  date: string;
  title: string;
  mood: JournalMood;
  confidence: JournalConfidence;
  source: JournalSource;
  topics: string[];
  body: string;
}

/** "Mental Health " -> "mental-health". Null when it cannot be a tag. */
export function normalizeTopic(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().toLowerCase().replace(/[\s_]+/g, "-");
  return TOPIC_RE.test(t) ? t : null;
}

function cleanTopics(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const t of raw) {
    const n = normalizeTopic(t);
    if (n && !out.includes(n)) out.push(n);
    if (out.length >= JOURNAL_MAX_TOPICS) break;
  }
  return out;
}

/** One line, inner whitespace collapsed. */
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** The model's journal labels -> a draft Riley reviews. Never throws: anything unusable becomes blank or the default. */
export function journalDraftFrom(raw: unknown): JournalDraft {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  let title = typeof r.title === "string" ? oneLine(r.title) : "";
  if (title.length > JOURNAL_MAX_TITLE_CHARS || GENERIC_TITLES.test(title)) title = "";
  return {
    title,
    mood: isMood(r.mood) ? r.mood : null,
    confidence: isConfidence(r.confidence) ? r.confidence : "medium", // the rule's default: never blank
    topics: cleanTopics(r.topics),
  };
}

/** A real calendar day as YYYY-MM-DD (2031-02-30 and 2031-13-01 are not). */
const isDate = (s: unknown): s is string => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + "T00:00:00Z");
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

/** Today's date in America/New_York (the journal's Date rule). */
export function easternDate(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

/**
 * A POSTed entry -> the entry to write, or the reason it cannot be. Every property is required (the journal rules:
 * never create an entry with one unset). The body is kept as written: only the whitespace around it is dropped.
 */
export function validateJournalEntry(raw: unknown, todayEt: string): { ok: true; entry: JournalEntryInput } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "invalid JSON" };
  const r = raw as Record<string, unknown>;
  if (!isDate(r.date)) return { ok: false, error: "date must be a real YYYY-MM-DD date" };
  if (r.date > todayEt) return { ok: false, error: "That day hasn't happened yet." };
  if (r.date < "2000-01-01") return { ok: false, error: "date is too far back" };
  const title = typeof r.title === "string" ? oneLine(r.title) : "";
  if (!title) return { ok: false, error: "Add a title." };
  if (title.length > JOURNAL_MAX_TITLE_CHARS) return { ok: false, error: `The title must be at most ${JOURNAL_MAX_TITLE_CHARS} characters.` };
  if (!isMood(r.mood)) return { ok: false, error: "Pick a mood." };
  if (!isConfidence(r.confidence)) return { ok: false, error: "Pick how sure you are." };
  if (!isSource(r.source)) return { ok: false, error: "source must be voice or typed" };
  if (!Array.isArray(r.topics)) return { ok: false, error: "Add at least one topic." };
  const topics = cleanTopics(r.topics);
  if (topics.length !== r.topics.length) return { ok: false, error: `Topics must be distinct lowercase tags (at most ${JOURNAL_MAX_TOPICS}).` };
  if (!topics.length) return { ok: false, error: "Add at least one topic." };
  if (typeof r.body !== "string") return { ok: false, error: "body must be text" };
  const body = r.body.trim();
  if (!body) return { ok: false, error: "The entry is empty." };
  if (body.length > JOURNAL_MAX_BODY_CHARS) return { ok: false, error: `The entry must be at most ${JOURNAL_MAX_BODY_CHARS} characters.` };
  return { ok: true, entry: { date: r.date, title, mood: r.mood, confidence: r.confidence, source: r.source, topics, body } };
}

/**
 * The body as paragraphs: split at blank lines, each kept exactly as written (single line breaks included),
 * only the whitespace around a paragraph dropped. Past Notion's block limit the rest joins the last paragraph.
 */
export function bodyParagraphs(body: string): string[] {
  const paras = body
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paras.length <= NOTION_MAX_BLOCKS) return paras;
  return [...paras.slice(0, NOTION_MAX_BLOCKS - 1), paras.slice(NOTION_MAX_BLOCKS - 1).join("\n\n")];
}

type RichText = { type: "text"; text: { content: string } };

/** Text -> Notion rich text, split into chunks of at most 2000 characters (never between a surrogate pair). */
export function richText(s: string): RichText[] {
  const out: RichText[] = [];
  let i = 0;
  while (i < s.length) {
    let end = Math.min(i + NOTION_TEXT_CHUNK, s.length);
    const code = s.charCodeAt(end - 1);
    if (end < s.length && code >= 0xd800 && code <= 0xdbff) end -= 1; // keep a surrogate pair together
    out.push({ type: "text", text: { content: s.slice(i, end) } });
    i = end;
  }
  return out;
}

/** The Notion "create a page" request body (API 2022-06-28): every property set, the body as paragraph blocks. */
export function notionJournalPage(entry: JournalEntryInput, databaseId: string) {
  return {
    parent: { database_id: databaseId },
    properties: {
      Title: { title: richText(entry.title) },
      Date: { date: { start: entry.date } },
      Source: { select: { name: entry.source } },
      Confidence: { select: { name: entry.confidence } },
      Mood: { select: { name: entry.mood } },
      Topics: { multi_select: entry.topics.map((name) => ({ name })) },
    },
    children: bodyParagraphs(entry.body).map((p) => ({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: richText(p) },
    })),
  };
}

/** The query for entries already saved with the same date and title. A match counts as this save only when its words
 * are the same too (findSameTitleEntry): a retried save must not duplicate, a different entry must not be "saved". */
export function sameEntryQuery(entry: Pick<JournalEntryInput, "date" | "title">) {
  return {
    filter: {
      and: [
        { property: "Date", date: { equals: entry.date } },
        { property: "Title", title: { equals: entry.title } },
      ],
    },
    page_size: 5,
  };
}
