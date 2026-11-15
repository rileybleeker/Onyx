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
  richText,
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
 * (blank ones are filled in when filed). `source` is "voice": the box is the "say it" path (the journal's default).
 */
export function sayItJournalDraft(text: string, raw: unknown): JournalLogDraft | null {
  const note = text.trim();
  if (!note) return null;
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const prefixed = journalPrefixText(note);
  if (!prefixed && r.is_journal !== true) return null;
  const body = prefixed ?? verbatimExcerpt(note, r.excerpt) ?? note;
  const l = journalDraftFrom(r);
  const confidence = (JOURNAL_CONFIDENCES as readonly unknown[]).includes(r.confidence) ? l.confidence : null; // null = inferred when filed
  // asked: the note started with "journal:", so Riley asked for an entry and the Journal section files it by itself.
  // A reflection the model picked out is only offered there (filed after Keep or an edit).
  return { body: body.slice(0, JOURNAL_MAX_BODY_CHARS), source: "voice", title: l.title || null, mood: l.mood, confidence, topics: l.topics, asked: !!prefixed };
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

// ---------------------------------------------------------------------------------------------------------------
// Autosave (2026-11-15). The /log Journal section files the entry by itself (POST /api/journal/file) a few seconds
// after Riley stops typing, then keeps that ONE page up to date (PATCH /api/journal/file/[pageId]) while he goes on
// writing. Below: the hashes that identify the words a page holds, when labels are worth re-inferring, the strict
// update request, which labels an update may write, the smallest block edit, and the device copy of unsaved words.

/** A version of an entry = the words as written to Notion (bodyAsWritten); identified by their SHA-256, hex. */
export const SHA_RE = /^[0-9a-f]{64}$/;
/** At most this many hashes of earlier, unconfirmed versions ride along (saves whose answer was lost). */
export const JOURNAL_MAX_KNOWN_SHA = 5;

/** `known_sha` of a request: SHA-256 hex strings (empty when absent), or null when malformed. */
export function parseKnownSha(raw: unknown): string[] | null {
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.length > JOURNAL_MAX_KNOWN_SHA) return null;
  const out: string[] = [];
  for (const s of raw) {
    if (typeof s !== "string" || !SHA_RE.test(s)) return null;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

/** A Notion page id (32 hex digits, with or without dashes) -> the dashed lowercase form, or null. */
export function normalizePageId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const hex = raw.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export const journalWordCount = (s: string) => (s.trim().match(/\S+/g) ?? []).length;

/**
 * Labels are inferred once, from the words filed first (often only the first sentences). An update asks for them
 * again only when the entry changed size by at least a quarter of its words, and by 8 words or more, since they
 * were inferred: one model call per real change, not one per pause.
 */
export function shouldRelabel(labeledWords: number, words: number): boolean {
  const diff = Math.abs(words - labeledWords);
  return diff >= 8 && diff >= labeledWords * 0.25;
}

export interface JournalLabels {
  title: string;
  mood: JournalMood | null;
  confidence: JournalConfidence | null;
  topics: string[];
}

/** An update of a filed entry: the words (verbatim), how they were captured, and how to check the page. */
export interface JournalUpdateInput {
  body: string;
  source: JournalSource;
  /** Hashes of versions this box filed: the page must hold one of them (or already the new words). */
  known: string[];
  /** Write over the page even when it holds none of them (Riley chose "Replace it with these words"). */
  force: boolean;
  /** Re-infer the labels this box wrote (never a label changed in Notion). */
  relabel: boolean;
  /** The labels the last answer reported: a label still equal to it on the page was written by this box. */
  last: JournalLabels | null;
  /** Labels Riley set himself ("" / null / [] = not set). */
  explicit: JournalLabels;
}

const UPDATE_KEYS = new Set(["body", "source", "known_sha", "force", "relabel", "last_labels", "title", "mood", "confidence", "topics"]);
const LABEL_KEYS = new Set(["title", "mood", "confidence", "topics"]);

function parseLabels(r: Record<string, unknown>): { ok: true; labels: JournalLabels } | { ok: false; error: string } {
  const title = r.title == null ? "" : typeof r.title === "string" ? oneLine(r.title) : null;
  if (title === null) return { ok: false, error: "title must be text" };
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
    labels: { title, mood: (r.mood as JournalMood | null | undefined) ?? null, confidence: (r.confidence as JournalConfidence | null | undefined) ?? null, topics },
  };
}

/** A PATCH body -> what to write, or why not. Strict: unknown fields are refused. The entry's date never changes. */
export function validateJournalUpdate(raw: unknown): { ok: true; input: JournalUpdateInput } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "invalid JSON" };
  const r = raw as Record<string, unknown>;
  const extra = Object.keys(r).find((k) => !UPDATE_KEYS.has(k));
  if (extra) return { ok: false, error: `unknown field: ${extra.slice(0, 40)}` };
  if (typeof r.source !== "string" || !(JOURNAL_SOURCES as readonly string[]).includes(r.source)) return { ok: false, error: "source must be voice or typed" };
  if (typeof r.body !== "string") return { ok: false, error: "body must be text" };
  const body = r.body.trim();
  if (!body) return { ok: false, error: "An entry can't be empty. Type something, or start a new entry." };
  if (body.length > JOURNAL_MAX_BODY_CHARS) return { ok: false, error: `The entry must be at most ${JOURNAL_MAX_BODY_CHARS} characters.` };
  const known = parseKnownSha(r.known_sha);
  if (!known) return { ok: false, error: "known_sha must be a list of SHA-256 hex strings" };
  if (r.force != null && typeof r.force !== "boolean") return { ok: false, error: "force must be true or false" };
  if (r.relabel != null && typeof r.relabel !== "boolean") return { ok: false, error: "relabel must be true or false" };
  if (r.force !== true && !known.length) return { ok: false, error: "known_sha is required" };
  const explicit = parseLabels(r);
  if (!explicit.ok) return explicit;
  let last: JournalLabels | null = null;
  if (r.last_labels != null) {
    if (typeof r.last_labels !== "object" || Array.isArray(r.last_labels)) return { ok: false, error: "last_labels must be an object" };
    const l = r.last_labels as Record<string, unknown>;
    if (Object.keys(l).some((k) => !LABEL_KEYS.has(k))) return { ok: false, error: "last_labels: unknown field" };
    const parsed = parseLabels(l);
    if (!parsed.ok) return { ok: false, error: `last_labels: ${parsed.error}` };
    last = parsed.labels;
  }
  if (r.relabel === true && !last) return { ok: false, error: "relabel needs last_labels" };
  return {
    ok: true,
    input: { body, source: r.source as JournalSource, known, force: r.force === true, relabel: r.relabel === true, last, explicit: explicit.labels },
  };
}

/** A saved page's four labels. */
export function pageLabelSet(page: unknown): JournalLabels {
  const base = pageLabels(page);
  const props = ((page as { properties?: Record<string, { select?: { name?: string } | null }> } | null)?.properties ?? {});
  const c = props.Confidence?.select?.name;
  return {
    title: base.title,
    mood: (JOURNAL_MOODS as readonly string[]).includes(base.mood ?? "") ? (base.mood as JournalMood) : null,
    confidence: (JOURNAL_CONFIDENCES as readonly string[]).includes(c ?? "") ? (c as JournalConfidence) : null,
    topics: base.topics,
  };
}

const sameTopics = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");

/**
 * The labels an update writes. Riley's own (explicit) always. A re-inferred label only where the page still holds
 * the value this box wrote last (`last`), so a label changed in Notion is never overwritten, and only from a usable
 * model answer (journalDraftFrom: no generic title, a real mood, at least one topic).
 */
export function labelsToWrite(args: { explicit: JournalLabels; inferred: unknown; last: JournalLabels | null; current: JournalLabels }): Partial<JournalLabels> {
  const { explicit, last, current } = args;
  const out: Partial<JournalLabels> = {};
  if (explicit.title) out.title = explicit.title;
  if (explicit.mood) out.mood = explicit.mood;
  if (explicit.confidence) out.confidence = explicit.confidence;
  if (explicit.topics.length) out.topics = explicit.topics;
  if (args.inferred == null || !last) return out;
  const d = journalDraftFrom(args.inferred);
  if (out.title === undefined && d.title && current.title === last.title && d.title !== current.title) out.title = d.title;
  if (out.mood === undefined && d.mood && current.mood === last.mood && d.mood !== current.mood) out.mood = d.mood;
  if (out.confidence === undefined && d.confidence && current.confidence === last.confidence && d.confidence !== current.confidence) out.confidence = d.confidence;
  if (out.topics === undefined && d.topics.length && sameTopics(current.topics, last.topics) && !sameTopics(d.topics, current.topics)) out.topics = d.topics;
  return out;
}

/** The Notion properties for an update: Source always, plus the labels to write. */
export function notionUpdateProperties(source: JournalSource, labels: Partial<JournalLabels>) {
  const props: Record<string, unknown> = { Source: { select: { name: source } } };
  if (labels.title) props.Title = { title: richText(labels.title) };
  if (labels.mood) props.Mood = { select: { name: labels.mood } };
  if (labels.confidence) props.Confidence = { select: { name: labels.confidence } };
  if (labels.topics?.length) props.Topics = { multi_select: labels.topics.map((name) => ({ name })) };
  return props;
}

/** A page's blocks: its paragraphs, and ok false when anything else is there (edited in Notion). */
export function pageParagraphs(blocks: unknown): { ok: boolean; paras: { id: string; text: string }[] } {
  if (!Array.isArray(blocks)) return { ok: false, paras: [] };
  const paras: { id: string; text: string }[] = [];
  let ok = true;
  for (const b of blocks) {
    const block = b as { id?: unknown; type?: unknown } | null;
    if (!block || typeof block.id !== "string" || block.type !== "paragraph") {
      ok = false;
      continue;
    }
    paras.push({ id: block.id, text: pageBodyText([b]) });
  }
  return { ok, paras };
}

/**
 * The smallest edit from the page's paragraphs to the new body: paragraphs both share at the start stay, the old
 * ones after them are removed and the new ones appended (typing at the end touches only the tail).
 */
export function bodyEdit(current: { id: string; text: string }[], body: string): { keep: number; remove: string[]; append: string[] } {
  const next = bodyParagraphs(body);
  let keep = 0;
  while (keep < current.length && keep < next.length && current[keep].text === next[keep]) keep++;
  return { keep, remove: current.slice(keep).map((p) => p.id), append: next.slice(keep) };
}

/** Notion children for appended paragraphs (the same shape as notionJournalPage). */
export const paragraphBlocks = (paras: string[]) => paras.map((p) => ({ object: "block", type: "paragraph", paragraph: { rich_text: richText(p) } }));

/** localStorage key of the /log Journal box's words not saved yet (an "onyx" key, so signing out wipes it). */
export const JOURNAL_UNSAVED_KEY = "onyx.journal.unsaved";
export const JOURNAL_UNSAVED_MAX_AGE_MS = 30 * 24 * 3_600_000;

/** The entry the box is keeping up to date. Holds none of the entry's words: only how to find and check the page. */
export interface FiledJournalEntry {
  id: string;
  url: string | null;
  date: string;
  /** Hash of the words the page holds (bodyAsWritten). */
  sha: string;
  labels: JournalLabels;
  /** Word count of the words the labels were inferred from (shouldRelabel). */
  labeledWords: number;
}

/** The device copy of words not saved yet: restored after a reload or a closed tab, filed after Keep or an edit. */
export interface UnsavedJournal {
  v: 1;
  at: number;
  body: string;
  source: JournalSource;
  pinned: boolean;
  filed: FiledJournalEntry | null;
  /** Hashes of versions sent whose answer never came. */
  known: string[];
}

function parseFiled(raw: unknown): FiledJournalEntry | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const f = raw as Record<string, unknown>;
  const id = normalizePageId(f.id);
  if (!id || typeof f.sha !== "string" || !SHA_RE.test(f.sha) || !isDate(f.date)) return null;
  const labels = f.labels && typeof f.labels === "object" && !Array.isArray(f.labels) ? parseLabels(f.labels as Record<string, unknown>) : null;
  return {
    id,
    url: typeof f.url === "string" && f.url.startsWith("https://") ? f.url : null,
    date: f.date,
    sha: f.sha,
    labels: labels?.ok ? labels.labels : { title: "", mood: null, confidence: null, topics: [] },
    labeledWords: typeof f.labeledWords === "number" && Number.isFinite(f.labeledWords) && f.labeledWords >= 0 ? Math.floor(f.labeledWords) : 0,
  };
}

/** Whatever was stored -> a usable copy, or null (malformed, empty, or older than JOURNAL_UNSAVED_MAX_AGE_MS). */
export function parseUnsavedJournal(raw: unknown, now: number): UnsavedJournal | null {
  let v: unknown = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (r.v !== 1 || typeof r.at !== "number" || typeof r.body !== "string" || !r.body.trim()) return null;
  if (now - r.at > JOURNAL_UNSAVED_MAX_AGE_MS || r.at > now + 60_000) return null;
  if (typeof r.source !== "string" || !(JOURNAL_SOURCES as readonly string[]).includes(r.source)) return null;
  return {
    v: 1,
    at: r.at,
    body: r.body.slice(0, JOURNAL_MAX_BODY_CHARS),
    source: r.source as JournalSource,
    pinned: r.pinned === true,
    filed: parseFiled(r.filed),
    known: parseKnownSha(r.known) ?? [],
  };
}
