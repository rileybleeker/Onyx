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

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/**
 * SHA-256 of the text's UTF-8 bytes, hex. Synchronous on purpose: the browser must register a version's hash on the
 * device BEFORE sending it, and a send started from `pagehide` cannot wait for Web Crypto's promise. The server
 * hashes with node:crypto; tests/journal-file.test.cjs checks the two agree.
 */
export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const padded = (((bytes.length + 9 + 63) / 64) | 0) * 64;
  const buf = new Uint8Array(padded);
  buf.set(bytes);
  buf[bytes.length] = 0x80;
  const view = new DataView(buf.buffer);
  const bits = bytes.length * 8;
  view.setUint32(padded - 8, Math.floor(bits / 0x100000000));
  view.setUint32(padded - 4, bits >>> 0);
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, k] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA256_K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      k = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + k) >>> 0;
  }
  return h.map((x) => x.toString(16).padStart(8, "0")).join("");
}

/** The hash that identifies a version of an entry (its words as written to Notion). */
export const journalVersionSha = (body: string) => sha256Hex(bodyAsWritten(body));

/** A paragraph's short hash (64 bits): what a partly finished update is recognised by (see pageHoldsOwnWrite). */
export const PARA_HASH_RE = /^[0-9a-f]{16}$/;
export const JOURNAL_MAX_KNOWN_PARAS = 200;
export const paraHash = (paragraph: string) => sha256Hex(paragraph).slice(0, 16);
/** The paragraph hashes of a body, in order (the paragraphs as written to Notion). */
export const journalParaHashes = (body: string) => bodyParagraphs(body).map(paraHash);

/** `known_paras` of a request: short paragraph hashes (empty when absent), or null when malformed. */
export function parseKnownParas(raw: unknown): string[] | null {
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.length > JOURNAL_MAX_KNOWN_PARAS) return null;
  const out = new Set<string>();
  for (const s of raw) {
    if (typeof s !== "string" || !PARA_HASH_RE.test(s)) return null;
    out.add(s);
  }
  return [...out];
}

/** Merge hash lists, newest last, without repeats, keeping at most `max` (the newest). */
export function mergeHashes(lists: string[][], max: number): string[] {
  const out: string[] = [];
  for (const list of lists) for (const s of list) {
    const i = out.indexOf(s);
    if (i >= 0) out.splice(i, 1);
    out.push(s);
  }
  return out.slice(-max);
}

/**
 * May an update write over what the page holds now? "new": it already holds the new words (a retry after a lost
 * answer: properties only). "known": exactly a version this box filed or sent. "partial": only paragraphs this box
 * filed or sent, so an update of its own that stopped halfway (Notion failed between removing and adding paragraphs,
 * e.g. a 429). null: anything else, i.e. edited in Notion (a changed or added paragraph, a heading, a list), which is
 * never overwritten without `force`. (A paragraph deleted in Notion still reads as "partial": the update puts it back.)
 */
export function pageHoldsOwnWrite(args: {
  ok: boolean;
  holdsSha: string;
  newSha: string;
  paraHashes: string[];
  known: string[];
  knownParas: string[];
}): "new" | "known" | "partial" | null {
  if (!args.ok) return null;
  if (args.holdsSha === args.newSha) return "new";
  if (args.known.includes(args.holdsSha)) return "known";
  if (args.knownParas.length && args.paraHashes.every((h) => args.knownParas.includes(h))) return "partial";
  return null;
}

/**
 * The query for every page of one day (a restored entry's lost save is looked for by its hash on its own date,
 * without the 15-minute limit of a plain retry). Newest first; a day rarely holds more than a few entries.
 */
export function dayEntriesQuery(date: string) {
  return {
    filter: { property: "Date", date: { equals: date } },
    sorts: [{ timestamp: "created_time", direction: "descending" }],
    page_size: 20,
  };
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
  /** Hashes of versions this box filed or sent: the page must hold one of them (or already the new words). */
  known: string[];
  /** Short hashes of the paragraphs of those versions: a page holding only these is an update that stopped halfway. */
  knownParas: string[];
  /** Write over the page even when it holds none of them (Riley chose "Replace it with these words"). */
  force: boolean;
  /** Re-infer the labels this box wrote (never a label changed in Notion). */
  relabel: boolean;
  /** The labels the last answer reported: a label still equal to it on the page was written by this box. */
  last: JournalLabels | null;
  /** Labels Riley set himself ("" / null / [] = not set). */
  explicit: JournalLabels;
}

const UPDATE_KEYS = new Set(["body", "source", "known_sha", "known_paras", "force", "relabel", "last_labels", "title", "mood", "confidence", "topics"]);
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
  const knownParas = parseKnownParas(r.known_paras);
  if (!knownParas) return { ok: false, error: "known_paras must be a list of paragraph hashes" };
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
    input: { body, source: r.source as JournalSource, known, knownParas, force: r.force === true, relabel: r.relabel === true, last, explicit: explicit.labels },
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
  /** Short hashes of those words' paragraphs (journalParaHashes). */
  paras: string[];
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
  /** The entry's day once a first save was sent (a restored entry is filed on it, not on the day it is restored). */
  date: string | null;
  /** Hashes of versions sent and not confirmed yet: written here BEFORE each send, so a page saved by a send whose
   *  answer never came (a closed tab) is found again by its hash. */
  known: string[];
  /** Short hashes of those versions' paragraphs (pageHoldsOwnWrite). */
  knownParas: string[];
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
    paras: parseKnownParas(f.paras) ?? [],
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
    date: isDate(r.date) ? r.date : null,
    known: parseKnownSha(r.known) ?? [],
    knownParas: parseKnownParas(r.knownParas) ?? [],
  };
}
