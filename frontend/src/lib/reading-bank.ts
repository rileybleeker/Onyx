/**
 * Reading question bank: the pure core of generation (READ-QUIZ-01; docs/reading-question-bank.md).
 *
 * Import-free apart from lib/reading-recall.ts (hashing, normalization), so the worker, the routes and the tests run
 * the same rules. Nothing here calls a model, the network or the database:
 *
 * - Cost: estimateBookCents / capCents / approvalCapCents (Riley's one tap per book approves the cap).
 * - Edition binding: chapterHash / tocHash (mirrors of the SQL; the planner uses the database's own values).
 * - Sources: BLOCKED_DOMAINS + isBlockedUrl (piracy and full-text hosts), citedNotes (API citations -> evidence;
 *   a sentence without a citation is thrown away), cutAtWord, registrableDomain.
 * - Before verify: mergeHighlightLinks (the structure call's highlight links become support the verifier checks);
 *   buildNeedsModel / EMPTY_STRUCTURE (a build with nothing to cite stores no_sources without a model call).
 * - After the build: applyVerify (the second model can only take things away) and validateBuild (the code gates:
 *   evidence exists, exact-fact gate, copy guard at 12 words, answer not in the prompt, choice / order / explain
 *   shapes, length limits, rubric size, title dedupe, chapter status) -> the payload of pds.reading_bank_store.
 * - Planning: planBankJobs(pds.reading_bank_plan_input) -> the payload of pds.reading_bank_enqueue.
 * - The heartbeat: bankHeartbeatMessage / bankHeartbeatStatus (counts, chapter numbers and codes only).
 *
 * The public repo rule: no book title, chapter title, idea, question, highlight or answer ever reaches a log or a
 * heartbeat; the message builders below take numbers and codes only.
 */

import { normalizeAnswer, sha256Hex } from "./reading-recall";

/* ------------------------------------------------------------------ */
/* Files, steps, money                                                  */
/* ------------------------------------------------------------------ */

export const BANK_SQL_FILE = "sql/reading_question_bank.sql";
export const BANK_CHECKS_FILE = "sql/reading_question_bank_checks.sql";

export type BankStep = "map" | "research" | "build" | "highlights" | "grade";
export const BANK_STEPS: readonly BankStep[] = ["map", "research", "build", "highlights", "grade"];

/** Reserved at claim (cents), charged with the real usage at finish. build = structure 20 + verify 5. */
export const STEP_ESTIMATE_CENTS: Record<BankStep, number> = { map: 20, research: 12, build: 25, highlights: 5, grade: 1 };
/** The longest a step may take; the worker claims a step only with at least this much time left. */
export const STEP_MAX_SECONDS: Record<BankStep, number> = { map: 120, research: 120, build: 150, highlights: 60, grade: 30 };

export const PRIORITY = { grade: 5, map: 10, newest: 20, next: 30, older: 40, highlights: 60, ahead: 80, wholeBook: 90 } as const;

/** Book estimate: 20¢ for the source map + 37¢ per chapter (research 12 + build 25). */
export const BOOK_BASE_CENTS = 20;
export const PER_CHAPTER_CENTS = STEP_ESTIMATE_CENTS.research + STEP_ESTIMATE_CENTS.build;
/** The per-book approval cap: estimate x 1.25, rounded up to whole dollars, at most $25 (and at least $1). */
export const BOOK_CAP_MAX_CENTS = 2500;
export const BOOK_CAP_MIN_CENTS = 100;
export const CAP_FACTOR = 1.25;
/** The monthly cap across generation and grading (env READING_BANK_MONTHLY_CAP_CENTS overrides it). */
export const MONTHLY_CAP_CENTS = 3000;

export function estimateBookCents(chapters: number, withMap = true): number {
  const n = Math.max(0, Math.trunc(Number(chapters) || 0));
  return (withMap ? BOOK_BASE_CENTS : 0) + PER_CHAPTER_CENTS * n;
}

const roundUpDollar = (cents: number) => Math.ceil(cents / 100) * 100;

export function capCents(estimateCents: number): number {
  return Math.max(BOOK_CAP_MIN_CENTS, Math.min(BOOK_CAP_MAX_CENTS, roundUpDollar(Math.max(0, estimateCents) * CAP_FACTOR)));
}

/** The cap after "Allow $N more": what is spent plus the remaining estimate x 1.25, same rounding and bounds. */
export function approvalCapCents(spentCents: number, remainingEstimateCents: number): number {
  const want = roundUpDollar(Math.max(0, Number(spentCents) || 0) + Math.max(0, remainingEstimateCents) * CAP_FACTOR);
  return Math.max(BOOK_CAP_MIN_CENTS, Math.min(BOOK_CAP_MAX_CENTS, want));
}

/** The monthly cap from the environment value (cents), falling back to MONTHLY_CAP_CENTS. */
export function monthlyCapCents(raw: string | undefined | null): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 100_000 ? n : MONTHLY_CAP_CENTS;
}

/** "$15" / "$1.50" for the approval line. */
export function dollars(cents: number): string {
  const d = Math.max(0, cents) / 100;
  return Number.isInteger(d) ? `$${d}` : `$${d.toFixed(2)}`;
}

/* ------------------------------------------------------------------ */
/* Edition binding (mirrors pds.reading_bank_chapter_hash / _toc_hash)   */
/* ------------------------------------------------------------------ */

export const normalizeTocTitle = (title: string | null | undefined) => String(title ?? "").replace(/\s+/g, " ").trim().toLowerCase();

export function chapterHash(chapter: number, title: string | null | undefined): string {
  return sha256Hex(`chapter|${chapter}|${normalizeTocTitle(title)}`);
}

export function tocHash(total: number | null | undefined, chapters: { chapter: number; title: string | null; start_position?: number | null }[]): string {
  const ordered = [...chapters].sort((a, b) => (a.start_position ?? 0) - (b.start_position ?? 0) || a.chapter - b.chapter);
  return sha256Hex(`${Math.trunc(Number(total) || 0)}|${ordered.map((c) => `${c.chapter}:${normalizeTocTitle(c.title)}`).join("|")}`);
}

/* ------------------------------------------------------------------ */
/* Sources: blocked hosts, citations                                    */
/* ------------------------------------------------------------------ */

/**
 * Hosts the web tools never search or open (`blocked_domains`, at most 64, subdomains covered): e-reader hosts,
 * and shadow-library / full-text-copy hosts (generic names only).
 */
export const BLOCKED_DOMAINS: readonly string[] = [
  "read.amazon.com", "read.amazon.co.uk", "read.amazon.ca", "read.amazon.com.au", "read.amazon.de", "read.amazon.in",
  "read.amazon.co.jp", "audible.com", "audible.co.uk", "audible.ca", "audible.de",
  "libgen.rs", "libgen.is", "libgen.li", "libgen.st", "libgen.gs", "library.lol", "z-lib.org", "z-lib.io", "z-library.sk",
  "z-library.se", "1lib.sk", "b-ok.cc", "singlelogin.re", "annas-archive.org", "annas-archive.li", "annas-archive.se",
  "pdfdrive.com", "oceanofpdf.com", "dokumen.pub", "epdf.pub", "vdoc.pub", "ebin.pub", "pdfcoffee.com", "pdfroom.com",
  "idoc.pub", "docplayer.net", "studylib.net", "pdfslide.net", "vdocuments.mx", "scribd.com", "archive.org",
  "readanybook.net", "readonlinefree.net", "allfreenovel.com", "novelfull.com", "freebookcentre.net", "ebook3000.com",
  "bookfrom.net", "readfrom.net",
];

/** Publisher hosts whose downloadable files (sample chapters, guides) are not treated as full-text copies. */
export const PUBLISHER_HOSTS: readonly string[] = [
  "penguinrandomhouse.com", "harpercollins.com", "simonandschuster.com", "macmillan.com", "us.macmillan.com",
  "hachettebookgroup.com", "wiley.com", "routledge.com", "oup.com", "cambridge.org", "hbr.org",
];

const FILE_EXT_RE = /\.(pdf|epub|mobi|azw|azw3|txt)$/i;
const BAD_PHRASES = ["free download", "pdf download", "full text", "read online"];

const hostMatches = (host: string, list: readonly string[]) => list.some((d) => host === d || host.endsWith(`.${d}`));

/** Whether a cited page must be thrown away: not http(s), a blocked host, a book file off a publisher, or a piracy phrase. */
export function isBlockedUrl(url: string, title?: string | null): boolean {
  let u: URL;
  try {
    u = new URL(String(url));
  } catch {
    return true;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return true;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (!host || hostMatches(host, BLOCKED_DOMAINS)) return true;
  let path = u.pathname;
  try {
    path = decodeURIComponent(path);
  } catch {
    /* keep the raw path */
  }
  if (FILE_EXT_RE.test(path) && !hostMatches(host, PUBLISHER_HOSTS)) return true;
  const hay = `${path} ${title ?? ""}`.toLowerCase().replace(/[-_+/]+/g, " ");
  return BAD_PHRASES.some((p) => hay.includes(p));
}

const TWO_PART_SUFFIXES = new Set(["co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au", "co.jp", "co.nz", "com.br", "co.in", "co.za", "com.mx"]);

/** eTLD+1 (an approximation good enough to count independent sites): news.example.co.uk -> example.co.uk. */
export function registrableDomain(hostOrUrl: string): string {
  let host = String(hostOrUrl ?? "").toLowerCase();
  try {
    if (host.includes("/")) host = new URL(host).hostname.toLowerCase();
  } catch {
    /* already a host */
  }
  host = host.replace(/^www\./, "").replace(/\.$/, "");
  const parts = host.split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const last2 = parts.slice(-2).join(".");
  return TWO_PART_SUFFIXES.has(last2) ? parts.slice(-3).join(".") : last2;
}

/** Whitespace collapsed, cut to `max` characters at a word boundary (a single over-long word is cut hard). */
export function cutAtWord(text: string, max: number): string {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const slice = t.slice(0, max + 1);
  const at = slice.lastIndexOf(" ");
  return (at > 0 ? slice.slice(0, at) : t.slice(0, max)).trim();
}

export const SNIPPET_MAX = 300;
export const SOURCE_TITLE_MAX = 300;

/** A web source as stored (pds.reading_bank_sources kind 'web'). */
export interface WebSource {
  url: string;
  domain: string;
  title: string | null;
  cited_text: string;
}

/** The content blocks this module reads from a model answer (a subset of the SDK's beta content blocks). */
export interface CitationLike {
  type: string;
  cited_text?: string;
  url?: string;
  title?: string | null;
  document_index?: number;
  document_title?: string | null;
}
export interface ContentBlockLike {
  type: string;
  text?: string;
  citations?: CitationLike[] | null;
  content?: unknown;
}

export interface CitedNotes {
  /** Each kept text segment and the indexes (into `sources`) of the citations it carries. */
  notes: { text: string; sources: number[] }[];
  sources: WebSource[];
  /** The "UNSURE:" lines the research step ends with (not evidence; context for the build). */
  unsure: string;
  /** Text segments thrown away for carrying no usable citation. */
  dropped: number;
  /** Web tool error objects seen (HTTP 200 results that carry an error code). */
  tool_errors: string[];
}

function fetchedDocuments(content: ContentBlockLike[]): { url: string; title: string | null }[] {
  const docs: { url: string; title: string | null }[] = [];
  for (const b of content) {
    if (b.type !== "web_fetch_tool_result" || !b.content || typeof b.content !== "object") continue;
    const c = b.content as { type?: string; url?: string; content?: { title?: string | null } };
    if (c.type === "web_fetch_result" && typeof c.url === "string") docs.push({ url: c.url, title: c.content?.title ?? null });
  }
  return docs;
}

/**
 * Evidence from a research / map answer: every API citation becomes one web source (snippet cut to 300 characters
 * at a word boundary); a text segment with no usable citation is thrown away, except the trailing UNSURE: note.
 * Citations to blocked pages are dropped as if absent.
 */
export function citedNotes(content: ContentBlockLike[]): CitedNotes {
  const docs = fetchedDocuments(content);
  const sources: WebSource[] = [];
  const index = new Map<string, number>();
  const notes: CitedNotes["notes"] = [];
  const toolErrors: string[] = [];
  let dropped = 0;
  let unsure = "";
  for (const b of content) {
    if ((b.type === "web_search_tool_result" || b.type === "web_fetch_tool_result") && b.content && typeof b.content === "object" && !Array.isArray(b.content)) {
      const c = b.content as { type?: string; error_code?: string };
      if (typeof c.error_code === "string") toolErrors.push(c.error_code.replace(/[^a-z0-9_]/gi, "_").slice(0, 40).toLowerCase());
    }
    if (b.type !== "text" || typeof b.text !== "string") continue;
    const text = b.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    const refs: number[] = [];
    for (const c of b.citations ?? []) {
      let url: string | undefined;
      let title: string | null | undefined;
      if (c.type === "web_search_result_location") {
        url = c.url;
        title = c.title;
      } else if (typeof c.document_index === "number" && docs[c.document_index]) {
        url = docs[c.document_index].url;
        title = c.document_title ?? docs[c.document_index].title;
      }
      const cited = cutAtWord(c.cited_text ?? "", SNIPPET_MAX);
      if (!url || !cited || isBlockedUrl(url, title)) continue;
      const k = `${url}|${cited}`;
      let i = index.get(k);
      if (i === undefined) {
        i = sources.length;
        index.set(k, i);
        sources.push({ url, domain: registrableDomain(url), title: title ? cutAtWord(title, SOURCE_TITLE_MAX) : null, cited_text: cited });
      }
      if (!refs.includes(i)) refs.push(i);
    }
    if (refs.length) notes.push({ text, sources: refs });
    else if (/^unsure\s*:/i.test(text) || unsure) unsure = cutAtWord(`${unsure} ${text}`, 1000);
    else dropped++;
  }
  // The copy guard (D23) on the notes, which are stored text (reading_bank_jobs.output): a segment that shares
  // COPY_RUN_WORDS consecutive words with any kept snippet is thrown away (counted in `dropped`), and so is an
  // UNSURE: note that does. The prompt asks for the model's own words; this is the check in code.
  const runs = wordRuns(sources.map((s) => s.cited_text));
  const kept = notes.filter((n) => !sharesRun(n.text, runs));
  dropped += notes.length - kept.length;
  if (unsure && sharesRun(unsure, runs)) {
    unsure = "";
    dropped++;
  }
  return { notes: kept, sources, unsure, dropped, tool_errors: toolErrors };
}

/* ------------------------------------------------------------------ */
/* The build: what the structure and verify calls answer                 */
/* ------------------------------------------------------------------ */

export const IDEA_KINDS = ["claim", "concept", "framework", "example", "term", "person", "event", "number", "lesson"] as const;
export type IdeaKind = (typeof IDEA_KINDS)[number];
export type Importance = "core" | "supporting" | "detail";
export type QuestionFormat = "cued" | "explain" | "order";

export interface StructureFact {
  claim: string;
  value: string;
  exact: boolean;
}
export interface StructureQuestion {
  format: QuestionFormat;
  prompt: string;
  answer: string;
  accept: string[];
  options: string[];
  correct_index: number;
  steps: string[];
  points: { text: string; must: boolean }[];
  explanation: string;
}
export interface StructureIdea {
  kind: IdeaKind;
  importance: Importance;
  title: string;
  statement: string;
  key_points: string[];
  facts: StructureFact[];
  support: string[];
  placement: "this_chapter" | "unsure";
  questions: StructureQuestion[];
}
export interface StructureOutput {
  ideas: StructureIdea[];
  highlight_links: { highlight: string; idea_index: number }[];
  rejected: number;
}
export type QuestionProblem = "none" | "answer_in_prompt" | "ambiguous" | "wrong_answer" | "not_from_idea" | "later_content";
export interface VerifyOutput {
  ideas: {
    index: number;
    supported: "yes" | "partly" | "no";
    placement: "this" | "earlier" | "later" | "unsure";
    later_content: boolean;
    questions: { index: number; ok: boolean; problem: QuestionProblem }[];
  }[];
}

/** A web snippet the build may cite as E<n>. */
export interface BuildEvidence extends WebSource {
  id: string;
}
/** One of Riley's highlights the build may cite as H<highlight_id> (the passage stays in book_highlights). */
export interface BuildHighlight {
  id: string;
  highlight_id: number;
  passage: string;
}

export const LIMITS = {
  title: 90,
  statement: 400,
  keyPoints: 5,
  keyPoint: 200,
  facts: 6,
  factClaim: 200,
  factValue: 60,
  prompt: 400,
  answerWords: 6,
  answerChars: 80,
  accept: 8,
  option: 120,
  step: 160,
  minSteps: 3,
  maxSteps: 7,
  minPoints: 2,
  maxPoints: 4,
  point: 200,
  explanation: 400,
  rubric: 1800,
  questionsPerIdea: 4,
  ideasPerChapter: 24,
} as const;

/** Copy guard: no stored text shares this many consecutive words with a snippet or a highlight. */
export const COPY_RUN_WORDS = 12;
/** Answer-in-prompt: no run of this many answer words in the prompt (shorter answers: the whole answer). */
export const ANSWER_RUN_WORDS = 3;
/** Dedupe: token Jaccard of normalized titles at or above this is the same idea. */
export const DEDUPE_JACCARD = 0.8;
/** ready when kept ideas reach this share of the chapter's target. */
export const READY_SHARE = 0.6;

export type ChapterResult = "ready" | "thin" | "anchors_only" | "no_sources";

/** Plain lower-case word tokens (letters and digits, diacritics removed). */
export function wordTokens(text: string): string[] {
  return String(text ?? "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/['‘’]/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** The set of `n`-word runs of the texts. */
export function wordRuns(texts: string[], n = COPY_RUN_WORDS): Set<string> {
  const set = new Set<string>();
  for (const t of texts) {
    const w = wordTokens(t);
    for (let i = 0; i + n <= w.length; i++) set.add(w.slice(i, i + n).join(" "));
  }
  return set;
}

/** Whether `text` shares a run of `n` consecutive words with the runs in `runs`. */
export function sharesRun(text: string, runs: Set<string>, n = COPY_RUN_WORDS): boolean {
  const w = wordTokens(text);
  for (let i = 0; i + n <= w.length; i++) if (runs.has(w.slice(i, i + n).join(" "))) return true;
  return false;
}

const UNIT_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS_WORDS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALE_WORDS: Record<string, number> = { thousand: 1_000, million: 1_000_000, billion: 1_000_000_000 };

/**
 * Text for the exact-fact gate: diacritics removed, lower case, "%" as "percent", thousands separators dropped,
 * number words (including compounds such as "twenty five" or "three thousand") as digits, units kept as words.
 */
export function normalizeFactText(text: string): string {
  const pre = String(text ?? "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/(\d),(?=\d{3}\b)/g, "$1")
    .replace(/%/g, " percent ")
    .replace(/(\d)\.(\d)/g, "$1\u0000$2")
    .replace(/[^\p{L}\p{N}\u0000]+/gu, " ")
    .replace(/\u0000/g, ".")
    .trim();
  if (!pre) return "";
  const out: string[] = [];
  let total = 0;
  let cur = 0;
  let inNum = false;
  const flush = () => {
    if (inNum) out.push(String(total + cur));
    total = 0;
    cur = 0;
    inNum = false;
  };
  for (const w of pre.split(" ")) {
    if (w in UNIT_WORDS || w in TENS_WORDS) {
      cur += UNIT_WORDS[w] ?? TENS_WORDS[w];
      inNum = true;
    } else if (w === "hundred" && inNum) {
      cur = (cur || 1) * 100;
    } else if (w in SCALE_WORDS && inNum) {
      total += (cur || 1) * SCALE_WORDS[w];
      cur = 0;
    } else if (/^\d+$/.test(w) && !inNum) {
      cur = Number(w);
      inNum = true;
    } else {
      flush();
      out.push(w);
    }
  }
  flush();
  return out.join(" ");
}

/** Whether a fact's value appears literally (after normalizeFactText) in one of the texts. */
export function factAppearsIn(value: string, texts: string[]): boolean {
  const v = normalizeFactText(value);
  if (!v) return false;
  return texts.some((t) => ` ${normalizeFactText(t)} `.includes(` ${v} `));
}

export function titleJaccard(a: string, b: string): number {
  const A = new Set(wordTokens(a));
  const B = new Set(wordTokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Ideas a chapter should yield, from its print page span (unknown span: 8): 4 + pages / 6, between 4 and 16. */
export function chapterTarget(span?: { start_page?: number | null; end_page?: number | null } | null, halve = false): number {
  const s = span?.start_page;
  const e = span?.end_page;
  let t = 8;
  if (Number.isFinite(s) && Number.isFinite(e) && (e as number) >= (s as number)) t = 4 + Math.round(((e as number) - (s as number) + 1) / 6);
  t = Math.max(4, Math.min(16, t));
  return halve ? Math.max(2, Math.ceil(t / 2)) : t;
}

/* ---- the store payload (pds.reading_bank_store) ---- */

export interface StoreSource {
  ref: string;
  kind: "web" | "highlight";
  url?: string;
  domain?: string;
  title?: string | null;
  cited_text?: string;
  highlight_id?: number;
  /** sha256 of the passage the build read: the store refuses (409 highlight_changed) when it changed since. */
  passage_sha?: string;
}
export interface StoreQuestion {
  format: QuestionFormat;
  prompt: string;
  rubric: Record<string, unknown>;
}
export interface StoreIdea {
  ref: string;
  unlock_chapter: number;
  kind: IdeaKind;
  importance: Importance;
  title: string;
  statement: string;
  key_points: string[];
  facts: StructureFact[];
  origin: "web" | "highlight" | "both";
  evidence: string[];
  questions: StoreQuestion[];
}
export interface StorePayload {
  book_id: number;
  chapter: number;
  /** The edition the job was planned for: the store refuses (409 chapter_changed) when the TOC changed since. */
  chapter_hash: string;
  /** Required by the store: its receipt makes a repeated store of the same job a replay. */
  job_id: number | null;
  /** The attempt number pds.reading_bank_claim answered: the store refuses (409 lease_lost / not_running) a run that no longer holds the lease. */
  attempts: number;
  /** The claim's claim_seq (never reset, unlike attempts): required with attempts, so a run from an earlier claim can never match a later one. */
  claim_seq: number;
  prompt_version: string;
  replace: boolean;
  status?: ChapterResult;
  /** The chapter's rebuild count the job was planned for: the store refuses (409 stale_generation) an older one. */
  rebuilds: number;
  counts: { sources: number; ideas: number; questions: number; rejected: number };
  sources: StoreSource[];
  ideas: StoreIdea[];
  links: { idea_id: number; source_ref: string }[];
  /** Every highlight the job sent to the model (id + passage sha256), so the planner offers it again only once edited. */
  seen: { highlight_id: number; passage_sha: string }[];
}

/** Why something was left out (counted, never logged with text). */
export type RejectReason =
  | "verify_missing" | "unsupported" | "partly_supported" | "later_content" | "later_placement" | "no_evidence"
  | "copy" | "limits" | "duplicate" | "no_questions" | "q_not_ok" | "q_copy" | "q_answer_in_prompt" | "q_options"
  | "q_order" | "q_explain" | "q_limits" | "q_rubric" | "q_exact_fact" | "q_format";

export interface VerifiedIdea {
  index: number;
  idea: StructureIdea;
  unlock_chapter: number;
  questions: StructureQuestion[];
}

const bump = (r: Partial<Record<RejectReason, number>>, k: RejectReason, by = 1) => {
  r[k] = (r[k] ?? 0) + by;
};

/**
 * "The end of the book" while the chapter count is unknown: never reached, so an unsure or whole-book idea can never
 * unlock early for want of a length (mirrors pds.reading_bank_end_chapter, which the store applies whatever is sent).
 */
export const UNKNOWN_END_CHAPTER = 2147483647;

/** The unlock chapter of "the end of the book": the chapter count (at least the chapter), or UNKNOWN_END_CHAPTER. */
export function endChapter(chapter: number, totalChapters: number): number {
  const total = Math.trunc(Number(totalChapters)) || 0;
  return total > 0 ? Math.max(Math.trunc(chapter) || 0, total) : UNKNOWN_END_CHAPTER;
}

/**
 * The verify pass's verdicts applied (it can only take things away): supported no / partly, later content or a
 * later placement -> the idea is not stored; earlier -> stored in this chapter; unsure (either pass) -> stored, but
 * unlocked only at the end of the book (endChapter: never, while the chapter count is unknown). A question verify
 * did not mark ok is not stored; an idea left without a question is not stored.
 */
export function applyVerify(
  structure: StructureOutput,
  verify: VerifyOutput | null,
  opts: { chapter: number; totalChapters: number },
): { ideas: VerifiedIdea[]; reasons: Partial<Record<RejectReason, number>> } {
  const reasons: Partial<Record<RejectReason, number>> = {};
  const out: VerifiedIdea[] = [];
  const total = endChapter(opts.chapter, opts.totalChapters);
  (structure?.ideas ?? []).forEach((idea, index) => {
    const v = verify?.ideas?.find((x) => x.index === index);
    if (!v) return bump(reasons, "verify_missing");
    if (v.supported === "no") return bump(reasons, "unsupported");
    if (v.supported === "partly") return bump(reasons, "partly_supported");
    if (v.later_content) return bump(reasons, "later_content");
    if (v.placement === "later") return bump(reasons, "later_placement");
    const unsure = v.placement === "unsure" || idea.placement === "unsure";
    const questions = (idea.questions ?? []).filter((q, qi) => {
      const vq = v.questions?.find((x) => x.index === qi);
      if (vq && vq.ok && vq.problem === "none") return true;
      bump(reasons, "q_not_ok");
      return false;
    });
    if (!questions.length) return bump(reasons, "no_questions");
    // Chapter 0 = whole-book ideas (uncertain mapping): they unlock at the end of the book, like unsure ones.
    out.push({ index, idea, unlock_chapter: unsure || opts.chapter === 0 ? total : opts.chapter, questions });
  });
  return { ideas: out, reasons };
}

/**
 * The structure call's `highlight_links` folded into the ideas' `support` lists (deduped, valid H<id> of this build
 * and existing idea indexes only), with `highlight_links` emptied. A highlight counts as evidence only for an idea it
 * states, and the verifier is what checks that: so the worker calls this on the structure output BEFORE the verify
 * call, which then sees (and can reject) each linked highlight as support. validateBuild itself never reads
 * highlight_links: a link verify did not see is never stored as evidence.
 */
export function mergeHighlightLinks(structure: StructureOutput, highlightIds: Iterable<string>): StructureOutput {
  const valid = new Set([...highlightIds].map((h) => clean(h)));
  const ideas = (structure?.ideas ?? []).map((idea) => ({ ...idea, support: [...(idea.support ?? [])] }));
  for (const l of structure?.highlight_links ?? []) {
    const ref = clean(l?.highlight);
    const i = l?.idea_index;
    if (!valid.has(ref) || !Number.isInteger(i) || i < 0 || i >= ideas.length) continue;
    if (!ideas[i].support.map(clean).includes(ref)) ideas[i].support.push(ref);
  }
  return { ...structure, ideas, highlight_links: [] };
}

/** An empty structure answer: what a build with nothing to cite stores (no model call; see buildNeedsModel). */
export const EMPTY_STRUCTURE: Readonly<StructureOutput> = Object.freeze({ ideas: [], highlight_links: [], rejected: 0 });

/**
 * Whether a build has anything to cite. With no web snippet and no highlight (an uncertain mapping on a chapter
 * without highlights, a research job that found no sources) the worker makes NO model call: it stores
 * validateBuild({...input, structure: EMPTY_STRUCTURE, verify: null}), i.e. status no_sources at no cost, so the
 * chapter still gets a status and a later highlight there is offered to the highlights step.
 */
export function buildNeedsModel(evidence: readonly unknown[], highlights: readonly unknown[]): boolean {
  return (evidence?.length ?? 0) > 0 || (highlights?.length ?? 0) > 0;
}

export interface BuildInput {
  bookId: number;
  chapter: number;
  /** pds.reading_bank_chapter_hash of the chapter when the job was planned (its input hash carries it). */
  chapterHash: string;
  totalChapters: number;
  target: number;
  jobId: number | null;
  /** The claim's attempt number (the job row's `attempts` as claimed). */
  attempts: number;
  /** The claim's `claim_seq` (the job row's, as claimed): the second number of the fence, never reset by a re-queue. */
  claimSeq: number;
  promptVersion: string;
  rebuilds: number;
  /** true for a build / rebuild; false for the highlights step (adds ideas, keeps the chapter status). */
  replace: boolean;
  /** The structure answer, with highlight_links already folded into support by mergeHighlightLinks before verify. */
  structure: StructureOutput;
  verify: VerifyOutput | null;
  evidence: BuildEvidence[];
  highlights: BuildHighlight[];
  /**
   * Titles to dedupe against: active ideas of earlier chapters, plus (for the highlights step, which adds to the
   * chapter) this chapter's own. A build that replaces the chapter leaves this chapter's current titles out.
   */
  existingTitles: string[];
  /** The highlights step: links from a new highlight to an idea already stored in this chapter. */
  links?: { highlight: string; idea_id: number }[];
  existingIdeaIds?: number[];
}

export interface BuildResult {
  payload: StorePayload;
  status: ChapterResult;
  kept: number;
  questions: number;
  rejected: number;
  reasons: Partial<Record<RejectReason, number>>;
}

const clean = (s: unknown) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "");
const words = (s: string) => s.split(" ").filter(Boolean).length;

/** Whether the answer (or an accepted form) leaks into the prompt: a run of 3+ answer words, or the whole short answer. */
export function answerInPrompt(prompt: string, forms: string[]): boolean {
  const p = normalizeAnswer(prompt).split(" ").filter(Boolean);
  const pj = ` ${p.join(" ")} `;
  for (const f of forms) {
    const a = normalizeAnswer(f).split(" ").filter(Boolean);
    if (!a.length) continue;
    if (a.length < ANSWER_RUN_WORDS) {
      if (pj.includes(` ${a.join(" ")} `)) return true;
      continue;
    }
    for (let i = 0; i + ANSWER_RUN_WORDS <= a.length; i++) if (pj.includes(` ${a.slice(i, i + ANSWER_RUN_WORDS).join(" ")} `)) return true;
  }
  return false;
}

/** One structure question -> its stored rubric, or the reason it is left out. */
export function questionRubric(q: StructureQuestion, runs: Set<string>, nonExactValues: string[]): { ok: true; question: StoreQuestion } | { ok: false; reason: RejectReason } {
  const prompt = clean(q.prompt);
  const explanation = clean(q.explanation);
  if (!prompt || prompt.length > LIMITS.prompt || explanation.length > LIMITS.explanation) return { ok: false, reason: "q_limits" };
  const texts: string[] = [prompt, explanation];
  let rubric: Record<string, unknown>;
  if (q.format === "cued") {
    const answer = clean(q.answer);
    if (!answer || answer.length > LIMITS.answerChars || words(answer) > LIMITS.answerWords) return { ok: false, reason: "q_limits" };
    const accept: string[] = [];
    for (const a of q.accept ?? []) {
      const c = clean(a);
      if (c && c.length <= LIMITS.answerChars && normalizeAnswer(c) !== normalizeAnswer(answer) && !accept.some((x) => normalizeAnswer(x) === normalizeAnswer(c))) accept.push(c);
    }
    if (accept.length > LIMITS.accept) accept.length = LIMITS.accept;
    if (answerInPrompt(prompt, [answer, ...accept])) return { ok: false, reason: "q_answer_in_prompt" };
    const nv = nonExactValues.map(normalizeFactText);
    if (nv.length && [answer, ...accept].some((f) => nv.includes(normalizeFactText(f)))) return { ok: false, reason: "q_exact_fact" };
    rubric = { v: 1, format: "cued", answer, accept, explanation };
    const options = (q.options ?? []).map(clean);
    if (options.length) {
      const norm = options.map(normalizeAnswer);
      const ci = q.correct_index;
      const forms = [answer, ...accept].map(normalizeAnswer);
      if (options.length !== 4 || new Set(norm).size !== 4 || norm.some((o) => !o) || options.some((o) => o.length > LIMITS.option)
          || !Number.isInteger(ci) || ci < 0 || ci > 3 || !forms.includes(norm[ci])) {
        return { ok: false, reason: "q_options" };
      }
      rubric = { ...rubric, options, correct: ci };
      texts.push(...options);
    }
    texts.push(answer, ...accept);
  } else if (q.format === "order") {
    const steps = (q.steps ?? []).map(clean).filter(Boolean);
    if (steps.length < LIMITS.minSteps || steps.length > LIMITS.maxSteps || new Set(steps.map(normalizeAnswer)).size !== steps.length) return { ok: false, reason: "q_order" };
    if (steps.some((s) => s.length > LIMITS.step)) return { ok: false, reason: "q_limits" };
    rubric = { v: 1, format: "order", steps, explanation };
    texts.push(...steps);
  } else if (q.format === "explain") {
    const points = (q.points ?? []).map((pt) => ({ text: clean(pt?.text), must: pt?.must === true })).filter((pt) => pt.text);
    if (points.length < LIMITS.minPoints || points.length > LIMITS.maxPoints || points.filter((pt) => pt.must).length !== 1) return { ok: false, reason: "q_explain" };
    if (points.some((pt) => pt.text.length > LIMITS.point)) return { ok: false, reason: "q_limits" };
    rubric = { v: 1, format: "explain", points: points.map((pt, i) => ({ id: `p${i + 1}`, text: pt.text, must: pt.must })), explanation };
    texts.push(...points.map((pt) => pt.text));
  } else {
    return { ok: false, reason: "q_format" };
  }
  if (texts.some((t) => sharesRun(t, runs))) return { ok: false, reason: "q_copy" };
  if (JSON.stringify(rubric).length > LIMITS.rubric) return { ok: false, reason: "q_rubric" };
  return { ok: true, question: { format: q.format, prompt, rubric } };
}

/** The chapter's status from what survived (docs "After the build"). */
export function chapterResult(kept: StoreIdea[], target: number): ChapterResult {
  if (!kept.length) return "no_sources";
  if (kept.every((i) => i.origin === "highlight")) return "anchors_only";
  return kept.length >= Math.ceil(READY_SHARE * Math.max(1, target)) ? "ready" : "thin";
}

/**
 * Verify verdicts + every code gate, then the store payload. Gates per idea: its support ids exist (E<n> / H<id>
 * of this build); exact facts appear literally in a cited snippet or highlight of the idea (else the fact becomes
 * non-exact and questions answered by its value are left out); no field shares 12 words with any snippet or
 * highlight; length limits; dedupe against existing titles and this batch. Questions: the shapes of
 * questionRubric. Only evidence an idea that is stored cites goes into the payload. `structure.highlight_links` is
 * ignored here (see mergeHighlightLinks: links become support before verify, or not at all).
 */
export function validateBuild(input: BuildInput): BuildResult {
  const { ideas: verified, reasons } = applyVerify(input.structure, input.verify, { chapter: input.chapter, totalChapters: input.totalChapters });
  const ev = new Map(input.evidence.map((e) => [e.id, e]));
  const hl = new Map(input.highlights.map((h) => [h.id, h]));
  const runs = wordRuns([...input.evidence.map((e) => e.cited_text), ...input.highlights.map((h) => h.passage)]);
  const kept: StoreIdea[] = [];
  const usedRefs = new Set<string>();
  const titles = [...input.existingTitles];
  let questions = 0;

  for (const v of verified) {
    const idea = v.idea;
    const support = [...new Set((idea.support ?? []).map((s) => clean(s)))].filter((s) => ev.has(s) || hl.has(s));
    if (!support.length) {
      bump(reasons, "no_evidence");
      continue;
    }
    const title = clean(idea.title);
    const statement = clean(idea.statement);
    const keyPoints = (idea.key_points ?? []).map(clean).filter(Boolean);
    if (!title || title.length > LIMITS.title || !statement || statement.length > LIMITS.statement || keyPoints.length < 1
        || keyPoints.length > LIMITS.keyPoints || keyPoints.some((k) => k.length > LIMITS.keyPoint) || !IDEA_KINDS.includes(idea.kind)
        || !["core", "supporting", "detail"].includes(idea.importance)) {
      bump(reasons, "limits");
      continue;
    }
    const supportTexts = support.map((s) => ev.get(s)?.cited_text ?? hl.get(s)?.passage ?? "");
    const facts: StructureFact[] = [];
    const nonExact: string[] = [];
    for (const f of (idea.facts ?? []).slice(0, LIMITS.facts)) {
      const claim = clean(f?.claim);
      const value = clean(f?.value);
      if (!claim || !value || claim.length > LIMITS.factClaim || value.length > LIMITS.factValue) continue;
      const exact = f.exact === true && factAppearsIn(value, supportTexts);
      if (f.exact === true && !exact) nonExact.push(value);
      facts.push({ claim, value, exact });
    }
    if ([title, statement, ...keyPoints, ...facts.map((f) => f.claim)].some((t) => sharesRun(t, runs))) {
      bump(reasons, "copy");
      continue;
    }
    if (titles.some((t) => titleJaccard(t, title) >= DEDUPE_JACCARD)) {
      bump(reasons, "duplicate");
      continue;
    }
    const qs: StoreQuestion[] = [];
    for (const q of v.questions.slice(0, LIMITS.questionsPerIdea)) {
      if (idea.importance === "detail" && q.format === "explain") {
        bump(reasons, "q_format");
        continue;
      }
      const r = questionRubric(q, runs, nonExact);
      if (r.ok) qs.push(r.question);
      else bump(reasons, r.reason);
    }
    if (!qs.length) {
      bump(reasons, "no_questions");
      continue;
    }
    const web = support.some((s) => ev.has(s));
    const high = support.some((s) => hl.has(s));
    support.forEach((s) => usedRefs.add(s));
    titles.push(title);
    questions += qs.length;
    kept.push({
      ref: `I${v.index}`,
      unlock_chapter: v.unlock_chapter,
      kind: idea.kind,
      importance: idea.importance,
      title,
      statement,
      key_points: keyPoints,
      facts,
      origin: web && high ? "both" : web ? "web" : "highlight",
      evidence: support,
      questions: qs,
    });
    if (kept.length >= LIMITS.ideasPerChapter) break;
  }

  const links: StorePayload["links"] = [];
  const existing = new Set(input.existingIdeaIds ?? []);
  for (const l of input.links ?? []) {
    const ref = clean(l.highlight);
    if (!hl.has(ref) || !existing.has(l.idea_id)) continue;
    usedRefs.add(ref);
    if (!links.some((x) => x.idea_id === l.idea_id && x.source_ref === ref)) links.push({ idea_id: l.idea_id, source_ref: ref });
  }

  const sources: StoreSource[] = [];
  for (const ref of usedRefs) {
    const e = ev.get(ref);
    if (e) sources.push({ ref, kind: "web", url: e.url, domain: e.domain, title: e.title, cited_text: e.cited_text });
    const h = hl.get(ref);
    if (h) sources.push({ ref, kind: "highlight", highlight_id: h.highlight_id, passage_sha: sha256Hex(h.passage) });
  }
  const status = chapterResult(kept, input.target);
  const rejected = Object.values(reasons).reduce((s, n) => s + (n ?? 0), 0) + Math.max(0, Math.trunc(input.structure?.rejected ?? 0));
  const payload: StorePayload = {
    book_id: input.bookId,
    chapter: input.chapter,
    chapter_hash: input.chapterHash,
    job_id: input.jobId,
    attempts: input.attempts,
    claim_seq: input.claimSeq,
    prompt_version: input.promptVersion,
    replace: input.replace,
    rebuilds: input.rebuilds,
    counts: { sources: sources.length, ideas: kept.length, questions, rejected },
    sources,
    ideas: kept,
    links,
    seen: input.highlights.map((h) => ({ highlight_id: h.highlight_id, passage_sha: sha256Hex(h.passage) })),
  };
  if (input.replace) payload.status = status;
  return { payload, status, kept: kept.length, questions, rejected, reasons };
}

/* ------------------------------------------------------------------ */
/* Planning (pds.reading_bank_plan_input -> pds.reading_bank_enqueue)    */
/* ------------------------------------------------------------------ */

export interface PlanChapter {
  chapter: number;
  title: string | null;
  start_page: number | null;
  end_page: number | null;
  chapter_hash: string;
}
export interface PlanBank {
  chapter: number;
  status: string;
  chapter_hash: string | null;
  rebuilds: number;
  built_rebuilds: number;
  built_at: string | null;
  quizzable_since: string | null;
}
export interface PlanJob {
  job_id: number;
  step: Exclude<BankStep, "grade">;
  chapter: number;
  input_hash: string;
  status: "queued" | "running" | "done" | "failed" | "skipped";
  result: string | null;
}
/**
 * A highlight to offer the highlights step. The database decides (pds.reading_bank_plan_input): live, not cited by
 * an active idea for its current passage, and whose content (id + sha256 of the passage) no job has looked at yet.
 * Freshness is keyed on content, never on updated_at, which a review or a Kindle re-import touches for free.
 */
export interface PlanHighlight {
  highlight_id: number;
  chapter: number | null;
  passage_sha: string;
}
export interface PlanInput {
  book_id: number;
  title: string;
  author: string | null;
  total_chapters: number;
  status: string;
  approved: boolean;
  paused_reason: "owner" | "budget" | null;
  mapping: "unknown" | "ok" | "uncertain";
  narrative: boolean | null;
  map_urls: unknown[];
  /** Book-level Rebuild taps (pds.reading_bank_rebuild with chapter 0): part of the map job's hash. */
  map_rebuilds?: number;
  toc_hash_stored: string | null;
  toc_hash: string;
  quiz_through: number;
  chapter0_hash: string;
  chapters: PlanChapter[];
  bank: PlanBank[];
  jobs: PlanJob[];
  highlights: PlanHighlight[];
}
export interface PlannedJob {
  step: Exclude<BankStep, "grade">;
  chapter: number;
  input_hash: string;
  prompt_version: string;
  priority: number;
}
export interface Plan {
  book_id: number;
  jobs: PlannedJob[];
  quizzable: number[];
  skip_jobs: number[];
}

export const BUILT_STATUSES = new Set(["ready", "thin", "anchors_only", "no_sources"]);

/**
 * The map job's hash carries the book-level rebuild count, so a source map that failed for good (refusal, bad
 * output, an expired lease) is planned again after Riley's Rebuild instead of blocking the book. (A map that
 * failed with web_search_disabled is also retried by pds.reading_bank_enqueue itself, 6 hours on.)
 */
export const mapInputHash = (v: string, i: Pick<PlanInput, "toc_hash" | "title" | "author" | "total_chapters" | "map_rebuilds">) =>
  sha256Hex(`${v}|${i.toc_hash}|${i.title}|${i.author ?? ""}|${i.total_chapters}|${Math.max(0, Math.trunc(Number(i.map_rebuilds) || 0))}`);
export const researchInputHash = (v: string, chapterHashHex: string, mapUrls: unknown[], rebuilds: number) =>
  sha256Hex(`${v}|${chapterHashHex}|${JSON.stringify(mapUrls ?? [])}|${rebuilds}`);
/** researchJobId = the done research job the build reads, or "anchors" (uncertain mapping: highlights only) / "whole" (chapter 0). */
export const buildInputHash = (v: string, chapterHashHex: string, researchJobId: number | string, rebuilds: number) =>
  sha256Hex(`${v}|${chapterHashHex}|${researchJobId}|${rebuilds}`);
/** Hashes the highlights' CONTENT (id:sha256(passage)), so an edited highlight is linked again. */
export const highlightsInputHash = (v: string, chapter: number, hs: { highlight_id: number; passage_sha: string }[]) =>
  sha256Hex(`${v}|${chapter}|${[...hs].sort((a, b) => a.highlight_id - b.highlight_id).map((h) => `${h.highlight_id}:${h.passage_sha}`).join(",")}`);

/** Whether a chapter's stored bank is current (built for this edition and this rebuild count). */
export function chapterBuilt(bank: PlanBank | undefined, chapterHashHex: string): boolean {
  return !!bank && BUILT_STATUSES.has(bank.status) && bank.chapter_hash === chapterHashHex && bank.built_rebuilds === bank.rebuilds;
}

/**
 * The jobs a book needs now (docs "Triggers and worker"). Nothing when the book is off. The source map first
 * (again when the table of contents changed); then, per chapter up to quiz_through + 2 that has no current bank,
 * research then build (build waits for its research job, except with an uncertain mapping, where chapters are
 * built from Riley's highlights only); a highlights job for a built chapter with highlights whose content no job
 * has looked at (new or edited; the database lists only those); a whole-book chapter 0 once an uncertainly mapped
 * book is finished. Queued jobs that are no longer planned are skipped (an obsolete input hash, a chapter that left
 * the window). A job that failed keeps its hash, so it is not planned again until Riley's Rebuild changes the hash
 * (the chapter's rebuild count; for the map, the book-level count `map_rebuilds`), except a web_search_disabled
 * failure, which pds.reading_bank_enqueue retries itself after 6 hours. A build with nothing to cite costs nothing
 * (buildNeedsModel), so an uncertainly mapped chapter without highlights is planned and stored as no_sources free.
 */
export function planBankJobs(input: PlanInput, promptVersion: string): Plan {
  const plan: Plan = { book_id: input.book_id, jobs: [], quizzable: [], skip_jobs: [] };
  if (!input.approved || input.paused_reason === "owner") return plan;
  const v = promptVersion;
  const through = Math.max(0, Math.trunc(input.quiz_through) || 0);
  const bankBy = new Map(input.bank.map((b) => [b.chapter, b]));
  const chapterBy = new Map(input.chapters.map((c) => [c.chapter, c]));
  const total = input.total_chapters > 0 ? input.total_chapters : Math.max(0, ...input.chapters.map((c) => c.chapter));
  const jobsFor = (step: PlanJob["step"], chapter: number, hash: string) => input.jobs.find((j) => j.step === step && j.chapter === chapter && j.input_hash === hash);
  const add = (step: PlannedJob["step"], chapter: number, input_hash: string, priority: number) => {
    if (!plan.jobs.some((j) => j.step === step && j.chapter === chapter && j.input_hash === input_hash)) plan.jobs.push({ step, chapter, input_hash, prompt_version: v, priority });
  };

  for (let n = 1; n <= Math.min(through, total); n++) if (!bankBy.get(n)?.quizzable_since) plan.quizzable.push(n);

  const needMap = input.mapping === "unknown" || input.toc_hash_stored !== input.toc_hash;
  if (needMap) {
    add("map", 0, mapInputHash(v, input), PRIORITY.map);
  } else {
    const last = Math.min(total, through + 2);
    const unbuilt: number[] = [];
    for (let n = 1; n <= last; n++) {
      const ch = chapterBy.get(n)?.chapter_hash ?? chapterHash(n, chapterBy.get(n)?.title);
      if (!chapterBuilt(bankBy.get(n), ch)) unbuilt.push(n);
    }
    const newestQuizzable = Math.max(-1, ...unbuilt.filter((n) => n <= through));
    for (const n of unbuilt) {
      const ch = chapterBy.get(n)?.chapter_hash ?? chapterHash(n, chapterBy.get(n)?.title);
      const rebuilds = bankBy.get(n)?.rebuilds ?? 0;
      const priority =
        n === newestQuizzable ? PRIORITY.newest : n === through + 1 ? PRIORITY.next : n <= through ? PRIORITY.older + n : PRIORITY.ahead;
      if (input.mapping === "uncertain") {
        add("build", n, buildInputHash(v, ch, "anchors", rebuilds), priority);
        continue;
      }
      const rHash = researchInputHash(v, ch, input.map_urls, rebuilds);
      const research = jobsFor("research", n, rHash);
      if (research?.status === "done") add("build", n, buildInputHash(v, ch, research.job_id, rebuilds), priority);
      else add("research", n, rHash, priority);
    }
    // Highlights for chapters whose bank is current.
    for (let n = 1; n <= last; n++) {
      const bank = bankBy.get(n);
      const ch = chapterBy.get(n)?.chapter_hash ?? chapterHash(n, chapterBy.get(n)?.title);
      if (!chapterBuilt(bank, ch)) continue;
      const fresh = input.highlights.filter((h) => h.chapter === n);
      if (fresh.length) add("highlights", n, highlightsInputHash(v, n, fresh), PRIORITY.highlights);
    }
    // Whole-book ideas once an uncertainly mapped book is finished.
    if (input.mapping === "uncertain" && input.status === "finished" && !chapterBuilt(bankBy.get(0), input.chapter0_hash)) {
      add("build", 0, buildInputHash(v, input.chapter0_hash, "whole", bankBy.get(0)?.rebuilds ?? 0), PRIORITY.wholeBook);
    }
  }

  const planned = new Set(plan.jobs.map((j) => `${j.step}|${j.chapter}|${j.input_hash}`));
  for (const j of input.jobs) if (j.status === "queued" && !planned.has(`${j.step}|${j.chapter}|${j.input_hash}`)) plan.skip_jobs.push(j.job_id);
  plan.jobs.sort((a, b) => a.priority - b.priority || a.chapter - b.chapter);
  return plan;
}

/** Estimated cents to finish the book from where it stands (the approval card's remaining estimate). */
export function estimateRemainingCents(input: Pick<PlanInput, "total_chapters" | "bank" | "chapters" | "mapping" | "toc_hash" | "toc_hash_stored">): number {
  const bankBy = new Map(input.bank.map((b) => [b.chapter, b]));
  const chapterBy = new Map(input.chapters.map((c) => [c.chapter, c]));
  let remaining = 0;
  for (let n = 1; n <= input.total_chapters; n++) {
    const ch = chapterBy.get(n)?.chapter_hash ?? chapterHash(n, chapterBy.get(n)?.title);
    if (!chapterBuilt(bankBy.get(n), ch)) remaining++;
  }
  const needMap = input.mapping === "unknown" || input.toc_hash_stored !== input.toc_hash;
  return estimateBookCents(remaining, needMap);
}

/* ------------------------------------------------------------------ */
/* Heartbeat (reading_bank|generate): counts, chapter numbers, codes     */
/* ------------------------------------------------------------------ */

/**
 * The only codes a heartbeat, a job row or a log line may carry. Anything else becomes "other", so no text (a title,
 * an API message) can ride along as a "code". Add a code here before using it.
 */
export const BANK_CODES: ReadonlySet<string> = new Set([
  "refusal", "max_tokens", "bad_output", "pause_limit", "rate_limited", "overloaded", "server_error", "connection", "timeout",
  "auth", "bad_request", "web_search_disabled", "failed", "budget", "monthly_cap", "uncertain", "schema_checks",
  "schema_missing", "lease_expired", "lease_lost", "not_running", "raced", "thin", "no_sources", "anchors_only", "ready",
  "no_citations", "store_failed", "verify_failed", "no_research", "invalidated", "already_graded", "cost_limit",
  "chapter_changed", "highlight_changed", "job_mismatch", "not_pending", "question_changed", "superseded", "stale_generation",
  "paused", "toc_changed", "finish_unrecorded", "finish_unconfirmed", "other",
]);

/** A safe error / outcome code from BANK_CODES ("other" for anything else), never message text. */
export function bankCode(raw: unknown): string {
  const s = String(raw ?? "").toLowerCase().trim();
  return BANK_CODES.has(s) ? s : "other";
}

export interface ChapterRunCount {
  chapter: number;
  result: ChapterResult | null;
  kept: number;
  target: number;
  questions: number;
  sources: number;
}
export interface BankRunSummary {
  chapters: ChapterRunCount[];
  graded: number;
  /** Run-level failures and failed steps (refusals excluded from step failures, see recordOutcome). */
  failed: number;
  /** Claimed steps that finished done. */
  done: number;
  /** Claimed steps that ended retry or failed (refusals and web-search-off failures excluded: partial codes, see recordOutcome). */
  unfinished: number;
  codes: string[];
}

/** Codes that make the heartbeat partial (a job that failed in the run makes it failed). */
export const PARTIAL_CODES = new Set(["budget", "monthly_cap", "uncertain", "schema_checks", "refusal", "thin", "no_sources", "web_search_disabled"]);

/**
 * success: no claimed step ended retry / failed (and no partial code or thin chapter).
 * partial: some step ended retry / failed, and at least one step finished done.
 * failed:  steps were claimed (or the run itself failed) and none finished done.
 */
export function bankHeartbeatStatus(s: BankRunSummary): "success" | "partial" | "failed" {
  const n = (x: unknown) => Math.max(0, Math.trunc(Number(x) || 0));
  if (n(s.failed) > 0 || n(s.unfinished) > 0) return n(s.done) > 0 ? "partial" : "failed";
  if (s.codes.some((c) => PARTIAL_CODES.has(bankCode(c)))) return "partial";
  if (s.chapters.some((c) => c.result === "thin" || c.result === "no_sources")) return "partial";
  return "success";
}

/** e.g. "ch 14 ready 12/14 ideas 31 q 5 src; graded 4; codes budget". Numbers and codes only, at most 500 characters. */
export function bankHeartbeatMessage(s: BankRunSummary): string {
  const n = (x: unknown) => Math.max(0, Math.trunc(Number(x) || 0));
  const parts = s.chapters.map(
    (c) => `ch ${n(c.chapter)} ${c.result ? bankCode(c.result) : "pending"} ${n(c.kept)}/${n(c.target)} ideas ${n(c.questions)} q ${n(c.sources)} src`,
  );
  if (n(s.graded)) parts.push(`graded ${n(s.graded)}`);
  if (n(s.failed)) parts.push(`failed ${n(s.failed)}`);
  if (n(s.unfinished)) parts.push(`unfinished ${n(s.unfinished)}`);
  const codes = [...new Set(s.codes.map(bankCode))];
  if (codes.length) parts.push(`codes ${codes.join(" ")}`);
  const msg = parts.join("; ") || "nothing to do";
  return msg.length > 500 ? `${msg.slice(0, 497)}...` : msg;
}

/** records_synced: ideas stored + answers graded. */
export const bankHeartbeatRecords = (s: BankRunSummary) =>
  s.chapters.reduce((sum, c) => sum + Math.max(0, Math.trunc(c.kept) || 0), 0) + Math.max(0, Math.trunc(s.graded) || 0);
