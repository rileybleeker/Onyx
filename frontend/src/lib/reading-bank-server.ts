import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  approvalCapCents,
  bankCode,
  bankHeartbeatMessage,
  bankHeartbeatRecords,
  bankHeartbeatStatus,
  BANK_CHECKS_FILE,
  BANK_SQL_FILE,
  buildInputHash,
  buildNeedsModel,
  chapterHash,
  chapterTarget,
  citedNotes,
  cutAtWord,
  EMPTY_STRUCTURE,
  estimateBookCents,
  estimateRemainingCents,
  highlightsInputHash,
  isBlockedUrl,
  mapInputHash,
  mergeHighlightLinks,
  monthlyCapCents,
  normalizeTocTitle,
  PER_CHAPTER_CENTS,
  planBankJobs,
  PRIORITY,
  researchInputHash,
  STEP_ESTIMATE_CENTS,
  STEP_MAX_SECONDS,
  titleJaccard,
  validateBuild,
  type BankRunSummary,
  type BankStep,
  type BuildEvidence,
  type BuildHighlight,
  type ChapterRunCount,
  type CitedNotes,
  type Plan,
  type PlanInput,
  type StructureOutput,
  type VerifyOutput,
  type WebSource,
} from "./reading-bank";
import {
  BANK_OPUS,
  BANK_SONNET,
  bankModelCall,
  defaultBankClient,
  webFetchTool,
  webSearchTool,
  ZERO_USAGE,
  type BankCallResult,
  type BankCallSpec,
  type BankClient,
  type UsageTotals,
} from "./reading-model";
import {
  BANK_PROMPT_VERSION,
  HIGHLIGHTS_SCHEMA,
  HIGHLIGHTS_SYSTEM,
  highlightsUser,
  MAP_SCHEMA,
  MAP_STRUCT_SYSTEM,
  MAP_SYSTEM,
  mapStructUser,
  mapUser,
  parseHighlightsOutput,
  parseMapOutput,
  parseStructureOutput,
  parseVerifyOutput,
  RESEARCH_SYSTEM,
  researchUser,
  STRUCTURE_SCHEMA,
  STRUCTURE_SYSTEM,
  structureUser,
  VERIFY_SCHEMA,
  VERIFY_SYSTEM,
  verifyUser,
  type MapOutput,
  type ParsedIdea,
  type PromptEvidence,
  type PromptHighlight,
  type VerifyMaterialIdea,
} from "./reading-bank-prompts";
import { bankFailure, repairDirtyStates, runGradeJob, SLUG_RE, type BankAnswer } from "./reading-recall-server";
import { isMissingSchema } from "./reading-practice";
import { sha256Hex } from "./reading-recall";

/**
 * Reading question bank: the generator, its triggers and the worker (READ-QUIZ-01 S2; docs/reading-question-bank.md
 * "Generation pipeline"). The client MUST be the service-role client scoped to schema "pds" (every bank table is
 * service-role only).
 *
 * - planBook: pds.reading_bank_plan_input -> planForBook (lib/reading-bank.ts planBankJobs + a pending map rebuild) ->
 *   pds.reading_bank_enqueue.
 * - runBank: claim -> step -> finish, while the step's budget (stepBudgetMs: STEP_MAX_SECONDS x scale, a build at
 *   least 225 s) still fits before the deadline; after a map, research or build is done, the book is planned again so
 *   the next stage can be claimed in the same run. A finish the database did not record is never counted. The claim
 *   reserves the step's estimate; every model request is reserved again first (pds.reading_bank_reserve through
 *   bankModelCall's `reserve`), so neither the book's cap nor the monthly cap can be passed; finish charges the real
 *   cost (a call that may have been billed without a usage report is charged its reservation).
 *   Steps: map (Sonnet + web search / fetch, then Sonnet to JSON), research (Sonnet + web tools: cited notes),
 *   build (Opus structure -> Sonnet verify -> code gates -> pds.reading_bank_store), highlights (Sonnet links new
 *   highlights or adds highlight-backed ideas -> verify -> store), grade (lib/reading-recall-server.ts runGradeJob).
 * - kickBank: what the write routes run in after() (the Kindle import, Riley's session and highlight writes, the
 *   approval and Build now): preflight, plan, run for up to 240 s, repair up to 20 dirty states, heartbeat. Never
 *   from a GET; nothing is started on mount or by scrolling.
 * - runWorker: the hourly GitHub Actions job (frontend/scripts/reading-bank-run.cjs): every approved book planned,
 *   pending grades older than 2 minutes swept, generation for up to 10 minutes, repairs, and once a day T07's
 *   pds.reading_clear_question_answers.
 * - Route helpers for /api/reading/bank (overview + estimate), /approval, /run, /chapter/[n] and /export.
 *
 * Privacy (spec D15): the web-enabled calls (map, research) get public book details only; highlight passages go only
 * to the tool-less structure / highlights / verify calls; comments, recall notes and answers never reach a
 * generation call. Logs and heartbeats carry counts, chapter numbers and codes from lib/reading-bank.ts BANK_CODES
 * only: never a title, a chapter title, an idea, a question, a highlight or an answer.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Supa = SupabaseClient<any, any, any>;

/* ------------------------------------------------------------------ */
/* Constants                                                            */
/* ------------------------------------------------------------------ */

export const HEARTBEAT_SOURCE = "reading_bank";
export const HEARTBEAT_TYPE = "generate";
/** A heartbeat with nothing claimed repeats the last one at most this often (same status). */
export const HEARTBEAT_MIN_GAP_MS = 50 * 60 * 1000;
/** A kick's run budget from its own start (the routes' maxDuration is 300 s). */
export const KICK_DEADLINE_MS = 240_000;
/**
 * A kick also ends this long after the REQUEST started: after() shares the route's maxDuration (300 s) with the
 * request itself and the route's other after() callbacks (a long Kindle import, a Notion mirror, a second kick), and a
 * function stopped mid-call loses the model's work and charges its reservation. 20 s are left for the repairs and the
 * heartbeat.
 */
export const KICK_REQUEST_BUDGET_MS = 280_000;
/** The worker's generation budget (the job's timeout is 20 minutes). */
export const WORKER_DEADLINE_MS = 10 * 60_000;
/** The worker gives each step twice its STEP_MAX_SECONDS (an Opus build can be slow); a kick gives it once. */
export const WORKER_STEP_SCALE = 2;
/**
 * The least time a step is given in any run. STEP_MAX_SECONDS.build (150 s) has to hold the Opus structure call (a
 * long JSON answer at medium effort) AND the Sonnet verify call, which a kick's single scale does not fit: a build
 * stopped by its deadline is charged its whole reservation and tried again. So a kick claims a build only with 225 s
 * left (in practice its first claim) and gives it all of them; the worker's 2x gives 300 s.
 */
export const STEP_FLOOR_SECONDS: Partial<Record<BankStep, number>> = { build: 225 };
/** The worker grades answers still pending this long after they were stored (the attempt route's after() runs first). */
export const GRADE_SWEEP_AGE_MS = 2 * 60_000;
export const GRADE_SWEEP_MAX = 20;
/**
 * Minutes before a failed step is tried again, by attempt. pds.reading_bank_finish fails a retry at its third attempt
 * (and pds.reading_bank_claim an expired lease at its third), so only 5 and 30 are used today; the 180 is the next
 * rung if that limit is raised to 4 (docs/reading-question-bank.md "Failure handling" lists 5 min / 30 min / 3 h).
 */
export const RETRY_MINUTES = [5, 30, 180] as const;
/** The steps whose finish can unlock the next stage (research after the map, the build after research, highlights after the build). */
const REPLAN_AFTER: ReadonlySet<BankStep> = new Set<BankStep>(["map", "research", "build"]);
/** Ideas of one chapter read to find Riley's Wrong flags (active and retired, every rebuild). */
const NOT_IN_BOOK_SCAN = 1000;
/** The source map: at most this many URLs (pds.reading_bank_books.map_urls allows 8). */
export const MAP_URLS_MAX = 8;
/**
 * reading_bank_jobs.output is at most 60,000 characters as `output::text` (jsonb's own spacing, measured by
 * jsonbTextLength); notes are trimmed to stay below this.
 */
export const OUTPUT_MAX_CHARS = 55_000;
/** Highlights a build sends (the chapter's newest live highlights). */
export const BUILD_HIGHLIGHTS_MAX = 80;
export const EXISTING_TITLES_MAX = 400;
/** Active idea rows read to find the current-edition titles (stale-edition rows are skipped after the read). */
export const EXISTING_TITLES_SCAN = 1500;
/**
 * PostgREST filter for the rows that count as Riley's highlights. A Kindle note with no highlight under it is stored as
 * a row whose passage is the note's own text (highlighted_at NULL, note_at set; tools/kindle_harvest/harvest.mjs): that
 * is his comment, which never reaches a generation call (spec D15). Keep equal to the filter in
 * pds.reading_bank_plan_input, the store and lib/reading-kindle.ts (a note = no highlighted_at and a note_at).
 */
export const LIVE_HIGHLIGHT_FILTER = "highlighted_at.not.is.null,note_at.is.null";
export const NOT_IN_BOOK_MAX = 20;
/** The mapping check: the titles must match for at least this share of the titled chapters. */
export const MAP_TITLE_SHARE = 0.7;
/** T07's raw-answer retention (Riley's decision): the worker clears answers older than this once a day; 0 = off. */
export const CLEAR_ANSWERS_DAYS_DEFAULT = 180;
/** The ET hour in which the hourly worker runs the daily answer clearing. */
export const CLEAR_ANSWERS_ET_HOUR = 4;

export const GENERATION_STEPS: readonly BankStep[] = ["map", "research", "build", "highlights"];
/**
 * Riley's own highlight edits kick without the highlights step: the /reading highlight form autosaves while he types,
 * and each saved passage is new content (a new highlights job). Those jobs wait for the next Kindle import kick or the
 * hourly worker, so a half-typed passage is never paid for.
 */
export const HIGHLIGHT_EDIT_STEPS: readonly BankStep[] = ["map", "research", "build"];

export type KickReason = "kindle" | "session" | "highlight" | "approval" | "run" | "worker";

/* ------------------------------------------------------------------ */
/* Small helpers                                                        */
/* ------------------------------------------------------------------ */

const plainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const num = (v: unknown, fallback = 0) => {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const round2 = (n: number) => Math.round(n * 100) / 100;
const uniqueInts = (vs: Iterable<unknown>) => [...new Set([...vs].map(Number).filter((n) => Number.isInteger(n) && n > 0))];
type DbError = { code?: string; message?: string } | null | undefined;
const errCode = (e: DbError) => (isMissingSchema(e) ? "schema_missing" : "other");
/** A database error answer seen while running: a failed run (never a quiet code), with a safe code. */
function recordDbFailure(summary: BankRunSummary, code: string): void {
  summary.failed += 1;
  summary.codes.push(code);
}
const chunks = <T>(list: T[], size: number) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));

/** A step's time budget in a run (ms): STEP_MAX_SECONDS x scale, never below the step's floor (STEP_FLOOR_SECONDS). */
export function stepBudgetMs(step: BankStep, scale = 1): number {
  return Math.max((STEP_MAX_SECONDS[step] ?? 60) * scale, STEP_FLOOR_SECONDS[step] ?? 0) * 1000;
}

/** A kick's deadline: 240 s after it started, and never later than 280 s after the request that kicked it started. */
export function kickDeadline(startedAtMs: number, requestStartedAtMs?: number | null): number {
  const own = startedAtMs + KICK_DEADLINE_MS;
  return typeof requestStartedAtMs === "number" && Number.isFinite(requestStartedAtMs) ? Math.min(own, requestStartedAtMs + KICK_REQUEST_BUDGET_MS) : own;
}

/**
 * The length of a value as Postgres prints jsonb (`output::text`, which the column CHECK measures): JSON with a space
 * after every ':' and every ','. JavaScript counts UTF-16 units, at least Postgres's characters, so this never
 * undercounts.
 */
export function jsonbTextLength(value: unknown): number {
  const json = JSON.stringify(value);
  if (json === undefined) return 0;
  let separators = 0;
  const walk = (x: unknown) => {
    if (Array.isArray(x)) {
      if (x.length > 1) separators += x.length - 1;
      x.forEach(walk);
    } else if (x && typeof x === "object") {
      const values = Object.values(x).filter((y) => y !== undefined && typeof y !== "function");
      if (values.length) separators += values.length * 2 - 1;
      values.forEach(walk);
    }
  };
  walk(value);
  return json.length + separators;
}

/** The minutes a failed step waits before its next try, by the attempt that failed. */
export function retryMinutes(attempts: number): number {
  return RETRY_MINUTES[Math.min(Math.max(Math.trunc(attempts) || 1, 1), RETRY_MINUTES.length) - 1];
}

/** A whole-word Roman numeral up to 99 (lower case): "iv", "xl", "xcix". Not "civil" or "mix" (an ordinary word). */
const ROMAN_NUMERAL = /^(?=[ivxlc])(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3})$/;

/**
 * A chapter title for matching: the "Chapter 3:" style prefix and a leading number removed, then normalized. The
 * word after "chapter / part / book / section" is removed only when the whole word is a number (digits or a Roman
 * numeral), so "Section Civil Law" or "Book Value" keep their first word.
 */
function bareTitle(t: string | null | undefined): string {
  let out = normalizeTocTitle(t);
  const m = /^(?:chapter|part|book|section)\s+([^\s:.\-–—]+)\s*[:.\-–—]?\s*/i.exec(out);
  if (m && (/^\d+$/.test(m[1]) || ROMAN_NUMERAL.test(m[1]))) out = out.slice(m[0].length);
  return out.replace(/^\d+\s*[:.\-–—]\s*/, "").trim();
}

/** Whether a source's chapter title and the Kindle table of contents title name the same chapter. */
export function titlesMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = bareTitle(a);
  const y = bareTitle(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [s, l] = x.length <= y.length ? [x, y] : [y, x];
  if (s.length >= 4 && l.includes(s)) return true;
  return titleJaccard(x, y) >= 0.5;
}

/**
 * The source map's verdict on the book's mapping (spec §4 "Mapping check"): uncertain when the map found nothing,
 * when the book's chapter count is unknown, when the sources' count differs from it, or when the titles match for
 * fewer than 70% of the chapters that have a table of contents title. With no title to compare, the count decides.
 */
export function mapVerdict(map: MapOutput | null, input: Pick<PlanInput, "total_chapters" | "chapters">): "ok" | "uncertain" {
  if (!map) return "uncertain";
  const total = Math.trunc(Number(input.total_chapters) || 0);
  if (total <= 0) return "uncertain";
  const count = map.chapter_count > 0 ? map.chapter_count : new Set(map.chapters.filter((c) => c.chapter >= 1).map((c) => c.chapter)).size;
  if (count !== total) return "uncertain";
  const titled = (input.chapters ?? []).filter((c) => c.chapter >= 1 && c.chapter <= total && normalizeTocTitle(c.title));
  if (!titled.length) return "ok";
  let matched = 0;
  for (const c of titled) if (map.chapters.some((m) => m.chapter === c.chapter && titlesMatch(m.title, c.title))) matched++;
  return matched / titled.length >= MAP_TITLE_SHARE ? "ok" : "uncertain";
}

const urlKey = (u: string) => u.replace(/#.*$/, "").replace(/\/+$/, "").toLowerCase();

/**
 * The URLs the research step is given: only pages the map call actually cited (the second call cannot add a page),
 * none blocked, per-chapter guides first, at most 8. With no usable answer from the second call, the cited pages.
 */
export function mapUrls(map: MapOutput | null, cited: WebSource[]): string[] {
  const citedBy = new Map(cited.filter((s) => s.url.length <= 2000 && !isBlockedUrl(s.url, s.title)).map((s) => [urlKey(s.url), s.url]));
  const out: string[] = [];
  const add = (u: string | undefined) => {
    if (u && !out.includes(u) && out.length < MAP_URLS_MAX) out.push(u);
  };
  const ordered = [...(map?.sources ?? [])].sort((a, b) => (a.scope === b.scope ? 0 : a.scope === "per_chapter" ? -1 : 1));
  for (const s of ordered) add(citedBy.get(urlKey(s.url)));
  if (!out.length) for (const u of citedBy.values()) add(u);
  return out;
}

/** The cited notes as a job's `output` (the model's own cited words + the snippets), cut to fit the column. */
export function trimOutput(cited: Pick<CitedNotes, "notes" | "sources" | "unsure">): { v: 1; notes: CitedNotes["notes"]; sources: WebSource[]; unsure: string } {
  let notes = cited.notes.map((n) => ({ text: cutAtWord(n.text, 2000), sources: n.sources }));
  let sources = cited.sources;
  const unsure = cutAtWord(cited.unsure ?? "", 1000);
  const size = () => jsonbTextLength({ v: 1, notes, sources, unsure });
  while (size() > OUTPUT_MAX_CHARS && sources.length > 1) {
    const keep = Math.max(1, Math.floor(sources.length * 0.8));
    sources = sources.slice(0, keep);
    notes = notes.map((n) => ({ ...n, sources: n.sources.filter((i) => i < keep) })).filter((n) => n.sources.length);
  }
  while (size() > OUTPUT_MAX_CHARS && notes.length) notes = notes.slice(0, -1);
  return { v: 1, notes, sources, unsure };
}

/** A stored research / map output read back (anything malformed dropped). */
export function readOutput(raw: unknown): { notes: { text: string; sources: number[] }[]; sources: WebSource[] } {
  const o = plainObject(raw) ? raw : {};
  const sources = (Array.isArray(o.sources) ? o.sources : []).filter(plainObject).flatMap((s) => {
    const url = typeof s.url === "string" ? s.url : "";
    const cited = typeof s.cited_text === "string" ? s.cited_text : "";
    if (!url || !cited || isBlockedUrl(url, typeof s.title === "string" ? s.title : null)) return [];
    return [{ url, domain: typeof s.domain === "string" ? s.domain : "", title: typeof s.title === "string" ? s.title : null, cited_text: cited }];
  });
  const notes = (Array.isArray(o.notes) ? o.notes : []).filter(plainObject).flatMap((n) => {
    const text = typeof n.text === "string" ? n.text : "";
    const refs = (Array.isArray(n.sources) ? n.sources : []).map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < sources.length);
    return text && refs.length ? [{ text, sources: refs }] : [];
  });
  return { notes, sources };
}

/** Evidence ids E1..En for a build, and the notes with those ids. */
export function evidenceFrom(output: ReturnType<typeof readOutput>): { evidence: BuildEvidence[]; notes: { text: string; cites: string[] }[] } {
  const evidence = output.sources.map((s, i) => ({ ...s, id: `E${i + 1}` }));
  const notes = output.notes.map((n) => ({ text: n.text, cites: n.sources.map((i) => `E${i + 1}`) }));
  return { evidence, notes };
}

const promptEvidence = (e: BuildEvidence[]): PromptEvidence[] => e.map((x) => ({ id: x.id, url_title: x.title ?? x.domain, text: x.cited_text }));
const promptHighlights = (h: (BuildHighlight & { location?: string | null })[]): PromptHighlight[] =>
  h.map((x) => ({ id: x.id, passage: x.passage, location: x.location ?? null }));

/** The material the verify call checks: every idea and question with its index (what applyVerify reads back). */
export function verifyMaterial(ideas: StructureOutput["ideas"]): VerifyMaterialIdea[] {
  return ideas.map((idea, index) => ({
    index,
    importance: idea.importance,
    title: idea.title,
    statement: idea.statement,
    key_points: idea.key_points,
    facts: idea.facts,
    support: idea.support,
    questions: idea.questions.map((q, qi) => ({ index: qi, ...q })),
  }));
}

/** The table of contents a chapter's generation may see: chapters 1..N (all chapters for the whole-book chapter 0). */
function tocUpTo(input: PlanInput, chapter: number): { chapter: number; title: string | null }[] {
  return [...input.chapters]
    .filter((c) => c.chapter >= 1 && (chapter === 0 || c.chapter <= chapter))
    .sort((a, b) => a.chapter - b.chapter)
    .map((c) => ({ chapter: c.chapter, title: c.title ?? null }));
}

/** ET hour of an instant. */
function etHour(ms: number): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(new Date(ms)));
}

/** The answer-retention days from the environment: 0 = off, 30..3650 kept, anything else the default (180). */
export function clearAnswersDays(raw: string | undefined | null): number {
  if (raw === undefined || raw === null || raw === "") return CLEAR_ANSWERS_DAYS_DEFAULT;
  const n = Number(raw);
  if (n === 0) return 0;
  return Number.isInteger(n) && n >= 30 && n <= 3650 ? n : CLEAR_ANSWERS_DAYS_DEFAULT;
}

/* ------------------------------------------------------------------ */
/* Reads                                                                */
/* ------------------------------------------------------------------ */

async function readPlanInput(supabase: Supa, bookId: number): Promise<{ input: PlanInput | null; error: DbError }> {
  const { data, error } = await supabase.rpc("reading_bank_plan_input", { p_book: bookId });
  if (error) return { input: null, error };
  return { input: plainObject(data) ? (data as unknown as PlanInput) : null, error: null };
}

/** Preflight: the bank's SQL applied (schema_missing otherwise) and T07's two checks widened (schema_checks otherwise). */
export async function bankPreflight(supabase: Supa): Promise<"ok" | "schema_missing" | "schema_checks" | "other"> {
  const { data, error } = await supabase.rpc("reading_bank_schema_ok");
  if (error) return isMissingSchema(error) ? "schema_missing" : "other";
  return plainObject(data) && data.all_ok === true ? "ok" : "schema_checks";
}

/* ------------------------------------------------------------------ */
/* Planning                                                             */
/* ------------------------------------------------------------------ */

export type PlanResult =
  | { ok: true; off: boolean; input: PlanInput; jobs: number; enqueued: number }
  | { ok: false; code: string };

/**
 * The jobs a book needs (lib/reading-bank.ts planBankJobs) plus a pending map rebuild. Riley's book-level Rebuild
 * (chapter 0) counts a map rebuild (pds.reading_bank_rebuild), which is part of the map job's hash; but the planner
 * plans the map only for an unmapped book or a changed table of contents, so on a mapped book the Rebuild would count
 * and plan nothing (202, no work). Here the map job of the current count is added while none is stored yet for it, or
 * it is still waiting / running; the other stages keep going on the old map meanwhile (the map has the top priority,
 * and a book runs one job at a time). Once it is done, or failed for good (the old map stays in use; the next Rebuild
 * tries again), nothing more is planned for it. A queued map job of this very hash is not skipped by the same call
 * (a skip then re-queue would reset its attempts).
 */
export function planForBook(input: PlanInput, promptVersion: string): Plan {
  const plan = planBankJobs(input, promptVersion);
  const rebuilds = Math.max(0, Math.trunc(Number(input.map_rebuilds) || 0));
  if (!input.approved || input.paused_reason === "owner" || rebuilds === 0) return plan;
  const hash = mapInputHash(promptVersion, input);
  if (plan.jobs.some((j) => j.step === "map" && j.chapter === 0 && j.input_hash === hash)) return plan;
  const mine = input.jobs.find((j) => j.step === "map" && j.chapter === 0 && j.input_hash === hash);
  if (mine && (mine.status === "done" || mine.status === "failed")) return plan;
  plan.jobs.unshift({ step: "map", chapter: 0, input_hash: hash, prompt_version: promptVersion, priority: PRIORITY.map });
  if (mine) plan.skip_jobs = plan.skip_jobs.filter((id) => id !== mine.job_id);
  return plan;
}

/**
 * The plan input as pds.reading_bank_rebuild will leave it: the chapter's rebuild count one higher (chapter 0 also
 * the book-level map count). A Rebuild plans from this, so the call that raises the count queues the jobs of the
 * new count in the same transaction (the count and its jobs are never visible apart).
 */
export function withRebuild(input: PlanInput, chapter: number): PlanInput {
  const has = input.bank.some((b) => b.chapter === chapter);
  const bank = has
    ? input.bank.map((b) => (b.chapter === chapter ? { ...b, rebuilds: b.rebuilds + 1 } : b))
    : [...input.bank, { chapter, status: "pending", chapter_hash: null, rebuilds: 1, built_rebuilds: 0, built_at: null, quizzable_since: null }];
  return { ...input, bank, map_rebuilds: chapter === 0 ? Math.max(0, Math.trunc(Number(input.map_rebuilds) || 0)) + 1 : input.map_rebuilds };
}

/** Plan one book and enqueue its jobs. A book that is off is not enqueued (nothing to do, nothing written). */
export async function planBook(supabase: Supa, bookId: number): Promise<PlanResult> {
  const { input, error } = await readPlanInput(supabase, bookId);
  if (error) return { ok: false, code: errCode(error) };
  if (!input) return { ok: false, code: "other" };
  const plan = planForBook(input, BANK_PROMPT_VERSION);
  if (!input.approved || input.paused_reason === "owner") return { ok: true, off: true, input, jobs: 0, enqueued: 0 };
  const { data, error: e2 } = await supabase.rpc("reading_bank_enqueue", { p: plan });
  if (e2) return { ok: false, code: errCode(e2) };
  return { ok: true, off: false, input, jobs: plan.jobs.length, enqueued: num(data, 0) };
}

/* ------------------------------------------------------------------ */
/* One claimed job                                                      */
/* ------------------------------------------------------------------ */

export interface ClaimedJob {
  job_id: number;
  book_id: number;
  step: BankStep;
  chapter: number;
  input_hash: string;
  prompt_version: string;
  attempt_key: string | null;
  attempts: number;
  /** The claim's claim_seq (never reset): with attempts, the fence the store and finish calls send. */
  claim_seq: number;
  reserved_cents?: number | string | null;
  error_code?: string | null;
  store_receipt?: unknown;
}

export interface StepOutcome {
  step: BankStep;
  outcome: "done" | "retry" | "failed" | "skipped";
  code: string | null;
  chapter?: ChapterRunCount;
  /** Short counts-only parts for the heartbeat message (e.g. "map ok 6 urls"). */
  note?: string;
  graded?: boolean;
  /** Ideas a highlights step added (counted in records_synced). */
  ideasAdded?: number;
  costCents: number;
  /**
   * The finish was not recorded (pds.reading_bank_finish refused it, not_running / lease_lost, or never answered):
   * the job is still running until its lease runs out, then claimed again. Reported as a retry with that code, never
   * as done, and nothing it produced is counted.
   */
  lost?: boolean;
}

export interface RunCtx {
  client: BankClient;
  monthCapCents: number;
  now: () => number;
  /** The run's absolute deadline (epoch ms). */
  deadline: number;
  stepScale: number;
}

const stepMs = (step: BankStep, scale: number) => stepBudgetMs(step, scale);

/**
 * Money and the finish of one job: every request is reserved first (pds.reading_bank_reserve: both caps, every
 * running job's reservation counted, the book paused at its cap, in one step under the claim lock), with the job's
 * cost so far as priorCostCents; finish charges what was spent (or the reservation, when a call may have been billed
 * with no usage report). The claim's headroom is not used as a separate pre-check: a request it would stop is one
 * the reservation also refuses, and only the reservation pauses the book, so the card can say "Paused · budget".
 */
class JobRun {
  cost = 0;
  usage: UsageTotals = { ...ZERO_USAGE };
  reserved: number;
  reserveCode: string | null = null;
  readonly deadlineAt: number;
  constructor(
    readonly supabase: Supa,
    readonly job: ClaimedJob,
    readonly ctx: RunCtx,
  ) {
    this.reserved = num(job.reserved_cents, 0);
    this.deadlineAt = Math.min(ctx.deadline, ctx.now() + stepMs(job.step, ctx.stepScale));
  }

  private async reserve(total: number): Promise<boolean> {
    const { data, error } = await this.supabase.rpc("reading_bank_reserve", {
      p: { job_id: this.job.job_id, attempts: this.job.attempts, claim_seq: this.job.claim_seq, total_cents: total, month_cap_cents: this.ctx.monthCapCents },
    });
    if (error || !plainObject(data) || data.ok !== true) {
      this.reserveCode = plainObject(data) && typeof data.code === "string" ? bankCode(data.code) : "other";
      return false;
    }
    this.reserved = Math.max(this.reserved, num(data.reserved_cents, total));
    return true;
  }

  async call(spec: Omit<BankCallSpec, "maxCostCents" | "priorCostCents" | "reserve" | "deadlineAt" | "timeoutMs">): Promise<BankCallResult> {
    const timeoutMs = Math.max(1, this.deadlineAt - this.ctx.now());
    const r = await bankModelCall(this.ctx.client, {
      ...spec,
      timeoutMs,
      deadlineAt: this.deadlineAt,
      priorCostCents: this.cost,
      reserve: (total) => this.reserve(total),
    });
    this.usage = {
      input_tokens: this.usage.input_tokens + r.usage.input_tokens,
      output_tokens: this.usage.output_tokens + r.usage.output_tokens,
      cache_read_input_tokens: this.usage.cache_read_input_tokens + r.usage.cache_read_input_tokens,
      cache_creation_input_tokens: this.usage.cache_creation_input_tokens + r.usage.cache_creation_input_tokens,
      web_search_requests: this.usage.web_search_requests + r.usage.web_search_requests,
      web_fetch_requests: this.usage.web_fetch_requests + r.usage.web_fetch_requests,
      calls: this.usage.calls + r.usage.calls,
    };
    this.cost = !r.ok && r.maybeBilled ? Math.max(this.cost + r.costCents, this.reserved) : this.cost + r.costCents;
    return r;
  }

  async finish(
    outcome: StepOutcome["outcome"],
    code: string | null,
    extra: { result?: string | null; counts?: Record<string, unknown> | null; output?: unknown } = {},
  ): Promise<StepOutcome> {
    const safe = code ? bankCode(code) : null;
    const p = {
      job_id: this.job.job_id,
      attempts: this.job.attempts,
      claim_seq: this.job.claim_seq,
      outcome,
      cost_cents: round2(this.cost),
      usage: this.usage,
      result: extra.result ?? null,
      counts: extra.counts ?? null,
      output: extra.output ?? null,
      // A done job carries no error code (pds.reading_bank_enqueue reads it to decide what to try again).
      error_code: outcome === "done" ? null : safe,
      retry_minutes: outcome === "retry" ? retryMinutes(this.job.attempts) : null,
    };
    type Sent = { answered: boolean; ok: boolean; code: string; status: string | null };
    const send = async (): Promise<Sent> => {
      try {
        const { data, error } = await this.supabase.rpc("reading_bank_finish", { p });
        if (error) return { answered: false, ok: false, code: errCode(error), status: null };
        if (plainObject(data) && data.ok === true) return { answered: true, ok: true, code: "", status: typeof data.status === "string" ? data.status : null };
        return { answered: true, ok: false, code: plainObject(data) && typeof data.code === "string" ? bankCode(data.code) : "other", status: null };
      } catch {
        return { answered: false, ok: false, code: "other", status: null };
      }
    };
    let r = await send();
    if (!r.answered) {
      // No answer (a transport error): one more try. When the first one did commit, this one answers not_running; so
      // does a job whose lease ran out and was settled meanwhile, which the job's own row tells apart.
      const again = await send();
      if (again.answered && !again.ok && again.code === "not_running") {
        const status = await this.recordedStatus(outcome);
        r = status ? { answered: true, ok: true, code: "", status } : again;
      } else r = again;
    }
    if (!r.ok) {
      // Not recorded: the job stays running until its lease runs out (its reservation is then charged) and is
      // claimed again; a build or highlights batch already stored is then finished from its store receipt without a
      // model call. Never reported as done.
      const lostCode = r.code === "lease_lost" || r.code === "not_running" || r.code === "schema_missing" ? r.code : "other";
      return { step: this.job.step, outcome: "retry", code: lostCode, costCents: round2(this.cost), lost: true, note: `${this.job.step} ch ${this.job.chapter} not recorded` };
    }
    // pds.reading_bank_finish fails a retry at the job's third attempt: report what the database stored, so the run's
    // summary counts it as failed (the heartbeat, and the card's failed_24h, agree).
    const settled = outcome === "retry" && r.status === "failed" ? "failed" : outcome;
    return { step: this.job.step, outcome: settled, code: safe, costCents: round2(this.cost) };
  }

  /**
   * Whether the job's own row shows THIS attempt's finish (the first, unanswered call committed): the status it would
   * have stored, else null. A done, skipped or failed row can only come from a finish; a retry shows as queued (or
   * failed at the third attempt), and a lease that ran out is told by its own error code (and a new attempt number once
   * the job was claimed again), so a settled-by-expiry job is never taken for a recorded one.
   */
  private async recordedStatus(outcome: StepOutcome["outcome"]): Promise<string | null> {
    try {
      const { data, error } = await this.supabase.from("reading_bank_jobs").select("status,attempts,error_code").eq("job_id", this.job.job_id).limit(1);
      const row = (data as { status?: unknown; attempts?: unknown; error_code?: unknown }[] | null)?.[0];
      if (error || !row || Number(row.attempts) !== this.job.attempts || row.error_code === "lease_expired") return null;
      const status = String(row.status ?? "");
      return (outcome === "retry" ? status === "queued" || status === "failed" : status === outcome) ? status : null;
    } catch {
      return null;
    }
  }

  /** A model call that did not answer, as the job's outcome (spec §7.5). */
  failCall(r: Extract<BankCallResult, { ok: false }>): Promise<StepOutcome> {
    if (r.code === "cost_limit") {
      // The reservation refused the request before it was sent (the book's cap, which paused the book, or the monthly
      // cap): skipped, so it is queued again when planned again (after "Allow more", or next month), never a failed try.
      return this.finish("skipped", this.reserveCode === "monthly_cap" ? "monthly_cap" : this.reserveCode === "budget" ? "budget" : "cost_limit");
    }
    if (r.code === "refusal" || r.code === "web_search_disabled" || !r.retryable) return this.finish("failed", r.code);
    if (r.code === "bad_output" && this.job.attempts >= 2) return this.finish("failed", "bad_output");
    return this.finish("retry", r.code);
  }

  /** The model answered, but not in the shape asked for: one more try, then failed. */
  badOutput(): Promise<StepOutcome> {
    return this.finish(this.job.attempts >= 2 ? "failed" : "retry", "bad_output");
  }
}

/**
 * The previous try ran out of tokens or time: the map and research halve their web tool uses (fewer searches and
 * fetches = a shorter call).
 */
const halveTools = (job: ClaimedJob) => job.error_code === "max_tokens" || job.error_code === "timeout";
/**
 * A build halves its target only after max_tokens (spec §7.5). A timeout says the run's budget was short (a kick),
 * not that the answer was too long: the next try (a kick's first claim, or the worker's 300 s) keeps the full target,
 * so the chapter is not stored with half its ideas for good.
 */
const halveTarget = (job: ClaimedJob) => job.error_code === "max_tokens";

/* ---- map ---- */

async function runMapJob(supabase: Supa, run: JobRun): Promise<StepOutcome> {
  const { job } = run;
  const { input, error } = await readPlanInput(supabase, job.book_id);
  if (error) return run.finish("retry", errCode(error));
  if (!input) return run.finish("failed", "other");
  if (mapInputHash(job.prompt_version, input) !== job.input_hash) return run.finish("skipped", "superseded");
  const toc = tocUpTo(input, 0);
  const r1 = await run.call({
    model: BANK_SONNET,
    effort: "medium",
    system: MAP_SYSTEM,
    user: mapUser({ title: input.title, author: input.author, total_chapters: input.total_chapters, toc_titles: toc }),
    maxTokens: 16000,
    tools: [webSearchTool(halveTools(job) ? 3 : 6), webFetchTool(halveTools(job) ? 2 : 3, 12000)],
    step: "map",
  });
  if (!r1.ok) return run.failCall(r1);
  const cited = citedNotes(r1.content);
  let map: MapOutput | null = null;
  if (cited.sources.length) {
    const r2 = await run.call({
      model: BANK_SONNET,
      effort: "low",
      system: MAP_STRUCT_SYSTEM,
      user: mapStructUser({
        total_chapters: input.total_chapters,
        toc_titles: toc,
        notes: cited.notes,
        sources: cited.sources.map((s, index) => ({ index, url: s.url, title: s.title })),
      }),
      maxTokens: 4000,
      schema: MAP_SCHEMA,
      step: "map",
    });
    if (!r2.ok) return run.failCall(r2);
    map = parseMapOutput(r2.json);
    if (!map) return run.badOutput();
  }
  const urls = mapUrls(map, cited.sources);
  const mapping = mapVerdict(map, input);
  const { data, error: e2 } = await supabase.rpc("reading_bank_set_map", {
    p: {
      // The claim fence: pds.reading_bank_set_map refuses a call without it (400 bad_request), as the store does.
      job_id: job.job_id,
      attempts: job.attempts,
      claim_seq: job.claim_seq,
      book_id: job.book_id,
      mapping,
      narrative: map ? map.narrative : null,
      source_chapter_count: map ? (map.chapter_count > 0 ? map.chapter_count : map.chapters.length) : null,
      map_urls: urls,
      toc_hash: input.toc_hash,
    },
  });
  if (e2 || !plainObject(data) || data.ok !== true) return run.finish("retry", e2 ? errCode(e2) : "other");
  const out = await run.finish("done", null, {
    result: urls.length ? "ready" : "no_sources",
    counts: { sources: cited.sources.length, urls: urls.length, chapters: map?.chapters.length ?? 0, dropped: cited.dropped, tool_errors: cited.tool_errors.length },
    output: trimOutput(cited),
  });
  if (out.lost) return out;
  return { ...out, code: mapping === "uncertain" ? "uncertain" : null, note: `map ${mapping} ${urls.length} urls` };
}

/* ---- research ---- */

async function runResearchJob(supabase: Supa, run: JobRun): Promise<StepOutcome> {
  const { job } = run;
  const n = job.chapter;
  const { input, error } = await readPlanInput(supabase, job.book_id);
  if (error) return run.finish("retry", errCode(error));
  if (!input) return run.finish("failed", "other");
  const ch = input.chapters.find((c) => c.chapter === n);
  const hash = ch?.chapter_hash ?? chapterHash(n, null);
  const rebuilds = input.bank.find((b) => b.chapter === n)?.rebuilds ?? 0;
  if (researchInputHash(job.prompt_version, hash, input.map_urls, rebuilds) !== job.input_hash) return run.finish("skipped", "superseded");
  const titleOf = (k: number) => input.chapters.find((c) => c.chapter === k)?.title ?? null;
  const uses = halveTools(job) ? 1 : 2;
  const r = await run.call({
    model: BANK_SONNET,
    effort: "medium",
    system: RESEARCH_SYSTEM,
    user: researchUser({
      title: input.title,
      author: input.author,
      chapter: n,
      chapter_title: titleOf(n),
      previous_title: n > 1 ? titleOf(n - 1) : null,
      next_title: titleOf(n + 1),
      total_chapters: input.total_chapters,
      urls: (input.map_urls ?? []).filter((u): u is string => typeof u === "string"),
    }),
    maxTokens: 16000,
    tools: [webSearchTool(uses), webFetchTool(uses, 12000)],
    step: "research",
  });
  if (!r.ok) return run.failCall(r);
  const cited = citedNotes(r.content);
  const out = await run.finish("done", null, {
    result: cited.sources.length ? "ready" : "no_sources",
    counts: { sources: cited.sources.length, notes: cited.notes.length, dropped: cited.dropped, tool_errors: cited.tool_errors.length },
    output: trimOutput(cited),
  });
  if (out.lost) return out;
  return { ...out, code: cited.sources.length ? null : "no_citations", note: `research ch ${n} ${cited.sources.length} src` };
}

/* ---- build ---- */

interface ChapterContext {
  input: PlanInput;
  hash: string;
  rebuilds: number;
  span: { start_page: number | null; end_page: number | null } | null;
}

function chapterContext(input: PlanInput, n: number): ChapterContext {
  const ch = input.chapters.find((c) => c.chapter === n);
  return {
    input,
    hash: n === 0 ? input.chapter0_hash : (ch?.chapter_hash ?? chapterHash(n, ch?.title ?? null)),
    rebuilds: input.bank.find((b) => b.chapter === n)?.rebuilds ?? 0,
    span: ch ? { start_page: ch.start_page, end_page: ch.end_page } : null,
  };
}

/** Live highlights of a chapter, passage only (never the comment). */
async function chapterHighlights(supabase: Supa, bookId: number, chapter: number): Promise<(BuildHighlight & { location: string | null })[]> {
  const { data, error } = await supabase
    .from("book_highlights")
    .select("highlight_id,passage,location")
    .eq("book_id", bookId)
    .eq("chapter", chapter)
    .eq("archived", false)
    .or(LIVE_HIGHLIGHT_FILTER)
    .order("highlight_id", { ascending: false })
    .limit(BUILD_HIGHLIGHTS_MAX);
  if (error) throw Object.assign(new Error("read"), { code: errCode(error) });
  return ((data ?? []) as { highlight_id: unknown; passage: unknown; location: unknown }[])
    .filter((h) => typeof h.passage === "string" && h.passage.trim())
    .map((h) => ({ id: `H${Number(h.highlight_id)}`, highlight_id: Number(h.highlight_id), passage: String(h.passage), location: typeof h.location === "string" ? h.location : null }));
}

/**
 * The current edition of each chapter: its table of contents row's hash, else the hash of a chapter with no row (a book
 * tracked by hand has none), the same fallback as generation and pds.reading_bank_chapter_hash. Chapter 0 is the
 * whole-book hash.
 */
export function currentHashOf(input: Pick<PlanInput, "chapters" | "chapter0_hash">): (chapter: number) => string {
  const hashOf = new Map(input.chapters.map((c) => [c.chapter, c.chapter_hash]));
  return (n) => (n === 0 ? input.chapter0_hash : (hashOf.get(n) ?? chapterHash(n, null)));
}

/**
 * Titles of active ideas to dedupe against: earlier chapters (a build, which replaces this chapter's own), or up to
 * and including this one (the highlights step, which adds to it). The whole-book chapter 0 dedupes against every
 * chapter (and, for the highlights step, itself). Only ideas of the CURRENT edition of their chapter count: after a
 * table of contents change an old edition's ideas stay `active` until their chapter is rebuilt, but they are hidden
 * everywhere else (practice, the export, the chapter sheet), so they must not suppress a replacement.
 */
async function existingTitles(supabase: Supa, bookId: number, chapter: number, includeThis: boolean, currentHash: (chapter: number) => string): Promise<string[]> {
  let q = supabase.from("reading_ideas").select("title,chapter,chapter_hash").eq("book_id", bookId).eq("status", "active");
  if (chapter > 0) q = includeThis ? q.lte("chapter", chapter) : q.lt("chapter", chapter);
  else if (!includeThis) q = q.gt("chapter", 0);
  const { data, error } = await q.order("chapter", { ascending: false }).limit(EXISTING_TITLES_SCAN);
  if (error) throw Object.assign(new Error("read"), { code: errCode(error) });
  return ((data ?? []) as { title: unknown; chapter: unknown; chapter_hash: unknown }[])
    .filter((r) => r.chapter_hash === currentHash(Number(r.chapter)))
    .map((r) => String(r.title ?? ""))
    .filter(Boolean)
    .slice(0, EXISTING_TITLES_MAX);
}

/**
 * Statements of this chapter's ideas Riley flagged Wrong (and did not restore): the build must not restate them.
 * This chapter's ideas are read first (any status: a Wrong flag retires its idea), then only their flags, so flags on
 * other books and chapters can never push this chapter's out of the list. Newest ideas first.
 */
async function notInBook(supabase: Supa, bookId: number, chapter: number): Promise<string[]> {
  const { data: rows, error } = await supabase
    .from("reading_ideas")
    .select("idea_id,statement")
    .eq("book_id", bookId)
    .eq("chapter", chapter)
    .order("idea_id", { ascending: false })
    .limit(NOT_IN_BOOK_SCAN);
  if (error) throw Object.assign(new Error("read"), { code: errCode(error) });
  const statementOf = new Map<number, string>();
  for (const r of (rows ?? []) as { idea_id: unknown; statement: unknown }[]) {
    const id = Number(r.idea_id);
    if (Number.isInteger(id) && id > 0 && typeof r.statement === "string" && r.statement) statementOf.set(id, r.statement);
  }
  if (!statementOf.size) return [];
  const flagged = new Set<number>();
  for (const part of chunks([...statementOf.keys()], 200)) {
    const { data: flags, error: e2 } = await supabase
      .from("reading_question_flags")
      .select("idea_id")
      .in("idea_id", part)
      .eq("kind", "wrong")
      .is("restored_at", null);
    if (e2) throw Object.assign(new Error("read"), { code: errCode(e2) });
    for (const f of (flags ?? []) as { idea_id: unknown }[]) flagged.add(Number(f.idea_id));
  }
  return [...statementOf].filter(([id]) => flagged.has(id)).map(([, s]) => s).slice(0, NOT_IN_BOOK_MAX);
}

/** What the build reads: the research job its input hash names, the map (chapter 0), or highlights only. */
async function buildSource(
  supabase: Supa,
  job: ClaimedJob,
  c: ChapterContext,
): Promise<{ mode: "research" | "anchors" | "whole"; output: ReturnType<typeof readOutput> } | null> {
  const v = job.prompt_version;
  const empty = { notes: [], sources: [] };
  if (buildInputHash(v, c.hash, "anchors", c.rebuilds) === job.input_hash) return { mode: "anchors", output: empty };
  if (job.chapter === 0 && buildInputHash(v, c.hash, "whole", c.rebuilds) === job.input_hash) {
    const { data, error } = await supabase
      .from("reading_bank_jobs")
      .select("output")
      .eq("book_id", job.book_id)
      .eq("step", "map")
      .eq("status", "done")
      .order("job_id", { ascending: false })
      .limit(1);
    if (error) throw Object.assign(new Error("read"), { code: errCode(error) });
    return { mode: "whole", output: readOutput(((data ?? []) as { output?: unknown }[])[0]?.output) };
  }
  const { data, error } = await supabase
    .from("reading_bank_jobs")
    .select("job_id,output")
    .eq("book_id", job.book_id)
    .eq("step", "research")
    .eq("chapter", job.chapter)
    .eq("status", "done")
    .order("job_id", { ascending: false })
    .limit(20);
  if (error) throw Object.assign(new Error("read"), { code: errCode(error) });
  for (const r of (data ?? []) as { job_id: unknown; output?: unknown }[]) {
    if (buildInputHash(v, c.hash, Number(r.job_id), c.rebuilds) === job.input_hash) return { mode: "research", output: readOutput(r.output) };
  }
  return null;
}

/** pds.reading_bank_store's answer as the job's outcome. */
async function storeAndFinish(
  supabase: Supa,
  run: JobRun,
  built: ReturnType<typeof validateBuild>,
  target: number,
  kind: "build" | "highlights",
): Promise<StepOutcome> {
  const { data, error } = await supabase.rpc("reading_bank_store", { p: built.payload });
  if (error) {
    if (isMissingSchema(error)) return run.finish("failed", "schema_missing");
    // OXB*: the store refused the batch (a contract the gates should have caught): trying again would not help.
    if (/^OXB/.test(String(error.code ?? ""))) return run.finish("failed", "store_failed");
    return run.finish("retry", "store_failed");
  }
  if (!plainObject(data) || data.ok !== true) {
    const code = plainObject(data) && typeof data.code === "string" ? data.code : "store_failed";
    if (code === "chapter_changed") return run.finish("skipped", "chapter_changed");
    if (code === "highlight_changed") return run.finish("retry", "highlight_changed");
    return run.finish("failed", bankCode(code) === "other" ? "store_failed" : code);
  }
  const counts = { ...built.payload.counts, links: built.payload.links.length, reasons: built.reasons };
  const out = await run.finish("done", null, { result: kind === "build" ? built.status : null, counts });
  // The batch is stored (its receipt is on the job), but the job was not finished: counted when it is finished.
  if (out.lost) return out;
  if (kind === "highlights") {
    return { ...out, ideasAdded: num(data.ideas, built.kept), note: `highlights ch ${built.payload.chapter} +${num(data.ideas, built.kept)} ideas ${built.payload.links.length} links` };
  }
  return {
    ...out,
    chapter: { chapter: built.payload.chapter, result: built.status, kept: num(data.ideas, built.kept), target, questions: built.questions, sources: built.payload.counts.sources },
  };
}

async function runBuildJob(supabase: Supa, run: JobRun): Promise<StepOutcome> {
  const { job } = run;
  const n = job.chapter;
  if (plainObject(job.store_receipt)) return run.finish("done", null);
  const { input, error } = await readPlanInput(supabase, job.book_id);
  if (error) return run.finish("retry", errCode(error));
  if (!input) return run.finish("failed", "other");
  const c = chapterContext(input, n);
  const source = await buildSource(supabase, job, c);
  if (!source) return run.finish("skipped", "superseded");
  const { evidence, notes } = evidenceFrom(source.output);
  const highlights = n > 0 ? await chapterHighlights(supabase, job.book_id, n) : [];
  const target = chapterTarget(c.span, halveTarget(job));
  const titles = await existingTitles(supabase, job.book_id, n, false, currentHashOf(input));
  const base = {
    bookId: job.book_id,
    chapter: n,
    chapterHash: c.hash,
    totalChapters: input.total_chapters,
    target,
    jobId: job.job_id,
    attempts: job.attempts,
    claimSeq: job.claim_seq,
    promptVersion: job.prompt_version,
    rebuilds: c.rebuilds,
    replace: true,
    evidence,
    highlights,
    existingTitles: titles,
  };
  if (!buildNeedsModel(evidence, highlights)) {
    // Nothing to cite: no model call; the chapter gets its status (no_sources) for free.
    return storeAndFinish(supabase, run, validateBuild({ ...base, structure: { ...EMPTY_STRUCTURE, ideas: [], highlight_links: [] }, verify: null }), target, "build");
  }
  const toc = tocUpTo(input, n);
  const notIn = await notInBook(supabase, job.book_id, n);
  const r1 = await run.call({
    model: BANK_OPUS,
    effort: "medium",
    system: STRUCTURE_SYSTEM,
    user: structureUser({
      book: { title: input.title, author: input.author },
      chapter: n,
      toc,
      target,
      narrative: input.narrative === true,
      notes,
      evidence: promptEvidence(evidence),
      highlights: promptHighlights(highlights),
      existing_titles: titles,
      not_in_book: notIn,
    }),
    maxTokens: 32000,
    schema: STRUCTURE_SCHEMA,
    step: "build",
  });
  if (!r1.ok) return run.failCall(r1);
  const parsed = parseStructureOutput(r1.json);
  if (!parsed) return run.badOutput();
  const merged = mergeHighlightLinks(parsed as StructureOutput, highlights.map((h) => h.id));
  let verify: VerifyOutput | null = { ideas: [] };
  if (merged.ideas.length) {
    const r2 = await run.call({
      model: BANK_SONNET,
      effort: "medium",
      system: VERIFY_SYSTEM,
      user: verifyUser({ chapter: n, toc, evidence: promptEvidence(evidence), highlights: promptHighlights(highlights), material: verifyMaterial(merged.ideas) }),
      maxTokens: 16000,
      schema: VERIFY_SCHEMA,
      step: "build",
    });
    if (!r2.ok) return run.failCall(r2);
    verify = parseVerifyOutput(r2.json);
    if (!verify) return run.badOutput();
  }
  return storeAndFinish(supabase, run, validateBuild({ ...base, structure: merged, verify }), target, "build");
}

/* ---- highlights ---- */

async function runHighlightsJob(supabase: Supa, run: JobRun): Promise<StepOutcome> {
  const { job } = run;
  const n = job.chapter;
  if (plainObject(job.store_receipt)) return run.finish("done", null);
  const { input, error } = await readPlanInput(supabase, job.book_id);
  if (error) return run.finish("retry", errCode(error));
  if (!input) return run.finish("failed", "other");
  const fresh = (input.highlights ?? []).filter((h) => h.chapter === n);
  if (!fresh.length || highlightsInputHash(job.prompt_version, n, fresh) !== job.input_hash) return run.finish("skipped", "superseded");
  const c = chapterContext(input, n);
  const { data: rows, error: e1 } = await supabase
    .from("book_highlights")
    .select("highlight_id,passage,location")
    .eq("book_id", job.book_id)
    .eq("archived", false)
    .or(LIVE_HIGHLIGHT_FILTER)
    .in("highlight_id", fresh.map((h) => h.highlight_id));
  if (e1) return run.finish("retry", errCode(e1));
  const shaOf = new Map(fresh.map((h) => [h.highlight_id, h.passage_sha]));
  const hs = ((rows ?? []) as { highlight_id: unknown; passage: unknown; location: unknown }[])
    .filter((h) => typeof h.passage === "string" && shaOf.get(Number(h.highlight_id)) === sha256Hex(String(h.passage)))
    .map((h) => ({ id: `H${Number(h.highlight_id)}`, highlight_id: Number(h.highlight_id), passage: String(h.passage), location: typeof h.location === "string" ? h.location : null }));
  if (!hs.length) return run.finish("skipped", "superseded");

  const { data: ideaRows, error: e2 } = await supabase
    .from("reading_ideas")
    .select("idea_id,title,statement,chapter_hash")
    .eq("book_id", job.book_id)
    .eq("chapter", n)
    .eq("status", "active")
    .limit(60);
  if (e2) return run.finish("retry", errCode(e2));
  const ideas = ((ideaRows ?? []) as { idea_id: unknown; title: unknown; statement: unknown; chapter_hash: unknown }[])
    .filter((i) => i.chapter_hash === c.hash)
    .map((i) => ({ idea_id: Number(i.idea_id), title: String(i.title ?? ""), statement: String(i.statement ?? "") }));
  const titles = await existingTitles(supabase, job.book_id, n, true, currentHashOf(input));
  const notIn = await notInBook(supabase, job.book_id, n);
  const toc = tocUpTo(input, n);
  const target = chapterTarget(c.span);

  const r1 = await run.call({
    model: BANK_SONNET,
    effort: "low",
    system: HIGHLIGHTS_SYSTEM,
    user: highlightsUser({ book: { title: input.title, author: input.author }, chapter: n, toc, ideas, highlights: promptHighlights(hs), not_in_book: notIn }),
    maxTokens: 8000,
    schema: HIGHLIGHTS_SCHEMA,
    step: "highlights",
  });
  if (!r1.ok) return run.failCall(r1);
  const parsed = parseHighlightsOutput(r1.json);
  if (!parsed) return run.badOutput();

  const hIds = new Set(hs.map((h) => h.id));
  const existing = new Map(ideas.map((i) => [i.idea_id, i]));
  // A new idea rests on exactly one of the new highlights.
  const newIdeas: ParsedIdea[] = parsed.ideas.flatMap((idea) => {
    const sup = [...new Set(idea.support.map((s) => s.replace(/\s+/g, "")).filter(Boolean))];
    return sup.length === 1 && hIds.has(sup[0]) ? [{ ...idea, support: sup }] : [];
  });
  const links = parsed.links.filter((l) => hIds.has(l.highlight.replace(/\s+/g, "")) && existing.has(l.idea_id));
  // The verifier checks the new ideas AND each link (a highlight is evidence only for an idea it states).
  const linkChecks: StructureOutput["ideas"] = links.map((l) => {
    const i = existing.get(l.idea_id)!;
    return { kind: "concept", importance: "supporting", title: i.title, statement: i.statement, key_points: [], facts: [], support: [l.highlight], placement: "this_chapter", questions: [] };
  });
  const material = [...newIdeas, ...linkChecks];
  let verify: VerifyOutput = { ideas: [] };
  if (material.length) {
    const r2 = await run.call({
      model: BANK_SONNET,
      effort: "low",
      system: VERIFY_SYSTEM,
      user: verifyUser({ chapter: n, toc, evidence: [], highlights: promptHighlights(hs), material: verifyMaterial(material) }),
      maxTokens: 8000,
      schema: VERIFY_SCHEMA,
      step: "highlights",
    });
    if (!r2.ok) return run.failCall(r2);
    const v = parseVerifyOutput(r2.json);
    if (!v) return run.badOutput();
    verify = v;
  }
  const k = newIdeas.length;
  const verifiedLinks = links.filter((_, j) => {
    const v = verify.ideas.find((x) => x.index === k + j);
    return !!v && v.supported === "yes" && !v.later_content && (v.placement === "this" || v.placement === "earlier");
  });
  const built = validateBuild({
    bookId: job.book_id,
    chapter: n,
    chapterHash: c.hash,
    totalChapters: input.total_chapters,
    target,
    jobId: job.job_id,
    attempts: job.attempts,
    claimSeq: job.claim_seq,
    promptVersion: job.prompt_version,
    rebuilds: c.rebuilds,
    replace: false,
    structure: { ideas: newIdeas, highlight_links: [], rejected: parsed.ideas.length - newIdeas.length },
    verify: { ideas: verify.ideas.filter((x) => x.index < k) },
    evidence: [],
    highlights: hs,
    existingTitles: titles,
    links: verifiedLinks,
    existingIdeaIds: ideas.map((i) => i.idea_id),
  });
  return storeAndFinish(supabase, run, built, target, "highlights");
}

/* ---- dispatch ---- */

/** Run one claimed job (pds.reading_bank_claim's answer). Never throws: a failure inside is a retry with a code. */
export async function runClaimedJob(supabase: Supa, claim: { job: ClaimedJob; headroom_cents?: unknown }, ctx: RunCtx): Promise<StepOutcome> {
  const job = claim.job;
  const head = claim.headroom_cents == null ? null : num(claim.headroom_cents, NaN);
  const headroom = head !== null && Number.isFinite(head) && head >= 0 ? head : null;
  if (job.step === "grade") {
    try {
      // S3's runGradeJob reserves, calls, writes the grade and finishes the job itself.
      const g = await runGradeJob(supabase, { job, headroom_cents: headroom }, { client: ctx.client, monthCapCents: ctx.monthCapCents });
      return { step: "grade", outcome: g.outcome, code: g.code, graded: g.graded, costCents: g.cost_cents };
    } catch {
      return { step: "grade", outcome: "retry", code: "other", costCents: 0 };
    }
  }
  const run = new JobRun(supabase, job, ctx);
  try {
    if (job.step === "map") return await runMapJob(supabase, run);
    if (job.step === "research") return await runResearchJob(supabase, run);
    if (job.step === "build") return await runBuildJob(supabase, run);
    if (job.step === "highlights") return await runHighlightsJob(supabase, run);
    return await run.finish("failed", "bad_request");
  } catch (e) {
    const code = plainObject(e) && typeof (e as { code?: unknown }).code === "string" ? String((e as { code: string }).code) : "other";
    return run.finish(code === "schema_missing" ? "failed" : "retry", code);
  }
}

/* ------------------------------------------------------------------ */
/* The run loop                                                         */
/* ------------------------------------------------------------------ */

export interface RunBankOptions {
  client?: BankClient;
  monthCapCents?: number;
  now?: () => number;
  /** Absolute deadline (epoch ms); default now + KICK_DEADLINE_MS. */
  deadline?: number;
  steps?: readonly BankStep[];
  stepScale?: number;
  /** At most this many jobs in one run. */
  maxJobs?: number;
}

export interface BankRunResult {
  summary: BankRunSummary;
  claimed: number;
  outcomes: StepOutcome[];
  costCents: number;
}

/** Outcome codes that say nothing worth a heartbeat (an obsolete job, an answer graded meanwhile). */
const QUIET_CODES = new Set(["superseded", "not_pending", "already_graded", "invalidated"]);
/** Failures the heartbeat reports as partial, not failed (spec §7.6: refusal; §7.5 web search off is Riley's switch). */
const PARTIAL_FAILURES = new Set(["refusal", "web_search_disabled"]);

export function emptySummary(): BankRunSummary {
  return { chapters: [], graded: 0, failed: 0, codes: [] };
}

/** Fold one job's outcome into the run summary. */
export function recordOutcome(summary: BankRunSummary, out: StepOutcome): void {
  if (out.chapter) summary.chapters.push(out.chapter);
  if (out.graded) summary.graded += 1;
  if (out.outcome === "failed" && !(out.code && PARTIAL_FAILURES.has(out.code))) summary.failed += 1;
  if (out.code && !QUIET_CODES.has(out.code)) summary.codes.push(out.code);
}

/** Claim -> run -> finish, while the longest allowed step still fits before the deadline. */
export async function runBank(supabase: Supa, opts: RunBankOptions = {}): Promise<BankRunResult> {
  const now = opts.now ?? Date.now;
  const deadline = opts.deadline ?? now() + KICK_DEADLINE_MS;
  const scale = opts.stepScale ?? 1;
  const steps = opts.steps ?? GENERATION_STEPS;
  const monthCap = opts.monthCapCents ?? monthlyCapCents(process.env.READING_BANK_MONTHLY_CAP_CENTS);
  const summary = emptySummary();
  const outcomes: StepOutcome[] = [];
  let claimed = 0;
  let cost = 0;
  let client = opts.client ?? null;
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) {
      // Nothing can run without the key (a Vercel / GitHub secret): a failed heartbeat says so.
      summary.failed += 1;
      summary.codes.push("auth");
      return { summary, claimed, outcomes, costCents: 0 };
    }
    client = defaultBankClient();
  }
  for (let i = 0; i < (opts.maxJobs ?? 40); i++) {
    const left = deadline - now();
    const fit = steps.filter((s) => stepMs(s, scale) <= left);
    if (!fit.length) break;
    const lease = Math.min(1800, Math.ceil(Math.max(...fit.map((s) => stepMs(s, scale))) / 1000) + 60);
    const { data, error } = await supabase.rpc("reading_bank_claim", {
      p: { lease_seconds: lease, month_cap_cents: monthCap, estimates: STEP_ESTIMATE_CENTS, steps: fit },
    });
    if (error) {
      // Any claim error (not only a missing schema) is a failed run: nothing can be processed, and a quiet `other`
      // code would publish a success heartbeat and let the worker exit 0.
      recordDbFailure(summary, errCode(error));
      break;
    }
    const answer = plainObject(data) ? data : {};
    if (!plainObject(answer.job)) {
      if (answer.code === "budget") {
        summary.codes.push("budget");
        continue; // that book is paused now; another book's job may still be claimable
      }
      if (answer.code === "monthly_cap") summary.codes.push("monthly_cap");
      break;
    }
    claimed += 1;
    const job = answer.job as unknown as ClaimedJob;
    const out = await runClaimedJob(supabase, { job, headroom_cents: answer.headroom_cents }, {
      client,
      monthCapCents: monthCap,
      now,
      deadline,
      stepScale: scale,
    });
    outcomes.push(out);
    cost += out.costCents;
    recordOutcome(summary, out);
    if (out.code === "monthly_cap") break;
    // The planner adds a stage only once the one before it is stored (research after the map, the build after its
    // research job is done, highlights after the build): plan the book again, so the next claim of this same run can
    // take it instead of waiting for the next trigger. One plan read + one enqueue, under the claim lock.
    if (out.outcome === "done" && REPLAN_AFTER.has(job.step)) {
      try {
        const p = await planBook(supabase, job.book_id);
        if (!p.ok) recordDbFailure(summary, p.code);
      } catch {
        recordDbFailure(summary, "other");
      }
    }
  }
  return { summary, claimed, outcomes, costCents: round2(cost) };
}

/* ------------------------------------------------------------------ */
/* Heartbeat (reading_bank|generate)                                    */
/* ------------------------------------------------------------------ */

export interface HeartbeatInput {
  startedAt: Date;
  endedAt: Date;
  summary: BankRunSummary;
  /** Short counts-only parts (map / research / highlights notes, repairs, cleared answers). */
  notes?: string[];
  /** Ideas added by highlights steps (records_synced counts them with the build ideas and the grades). */
  extraRecords?: number;
  claimed: number;
  /** Whether any book is turned on: with nothing claimed, a heartbeat is written only then (or on a failure). */
  anyApproved: boolean;
  /** "failed" on a crash. */
  forceStatus?: "failed";
}

/** The heartbeat text: counts, chapter numbers and codes only (and a SQL file name for a schema code). */
export function heartbeatMessage(summary: BankRunSummary, notes: string[] = []): string {
  const base = bankHeartbeatMessage(summary);
  const parts = [...notes.filter(Boolean), ...(base === "nothing to do" && notes.length ? [] : [base])];
  if (summary.codes.includes("schema_missing")) parts.push(`apply ${BANK_SQL_FILE}`);
  if (summary.codes.includes("schema_checks")) parts.push(`run ${BANK_CHECKS_FILE}`);
  const msg = parts.join("; ");
  return msg.length > 500 ? `${msg.slice(0, 497)}...` : msg;
}

/** Write the heartbeat. Never throws. With nothing claimed it repeats an equal status at most every 50 minutes. */
export async function logBankHeartbeat(supabase: Supa, p: HeartbeatInput): Promise<"written" | "skipped" | "failed"> {
  const status = p.forceStatus ?? bankHeartbeatStatus(p.summary);
  try {
    if (p.claimed === 0) {
      if (!p.anyApproved && status === "success") return "skipped";
      const { data: last } = await supabase
        .from("sync_log")
        .select("status,sync_start")
        .eq("source", HEARTBEAT_SOURCE)
        .eq("data_type", HEARTBEAT_TYPE)
        .order("sync_start", { ascending: false })
        .limit(1);
      const prev = (last as { status?: string; sync_start?: string }[] | null)?.[0];
      if (prev && prev.status === status && prev.sync_start && p.endedAt.getTime() - Date.parse(prev.sync_start) < HEARTBEAT_MIN_GAP_MS) return "skipped";
    }
    const { error } = await supabase.from("sync_log").insert({
      source: HEARTBEAT_SOURCE,
      data_type: HEARTBEAT_TYPE,
      status,
      records_synced: bankHeartbeatRecords(p.summary) + Math.max(0, Math.trunc(p.extraRecords ?? 0)),
      sync_start: p.startedAt.toISOString(),
      sync_end: p.endedAt.toISOString(),
      duration_seconds: Math.max(0, Math.round((p.endedAt.getTime() - p.startedAt.getTime()) / 1000)),
      error_message: heartbeatMessage(p.summary, p.notes),
    });
    return error ? "failed" : "written";
  } catch {
    return "failed";
  }
}

function notesOf(outcomes: StepOutcome[]): { notes: string[]; extra: number } {
  return {
    notes: outcomes.map((o) => o.note).filter((x): x is string => !!x),
    extra: outcomes.reduce((s, o) => s + (o.ideasAdded ?? 0), 0),
  };
}

/* ------------------------------------------------------------------ */
/* Kick (the write routes' after())                                     */
/* ------------------------------------------------------------------ */

export interface KickOptions {
  bookId: number;
  reason: KickReason;
  steps?: readonly BankStep[];
  /** false: the route has planned already (Build now). */
  plan?: boolean;
  client?: BankClient;
  now?: () => number;
  monthCapCents?: number;
  /**
   * When the request that kicks started (epoch ms; the route's Date.now() at its top). The kick then also ends by
   * requestStartedAt + KICK_REQUEST_BUDGET_MS, so a slow request (a long Kindle import), the route's other after()
   * callbacks or a second kick cannot push a step past the route's maxDuration.
   */
  requestStartedAt?: number;
}
export interface KickResult {
  ran: boolean;
  code: string | null;
  claimed: number;
  heartbeat: "written" | "skipped" | "failed" | null;
}

/**
 * What a write route runs in after(): preflight, plan the book, run for up to 240 s (and never past 280 s after the
 * request started: kickDeadline), repair up to 20 dirty states, heartbeat. Each finished stage plans the book again
 * (runBank), so one kick can take a chapter from the source map to its research and, given a build's 225 s, its build.
 * Quiet (no heartbeat) while the SQL is not applied or the book is off. Never throws.
 */
export async function kickBank(supabase: Supa, opts: KickOptions): Promise<KickResult> {
  const now = opts.now ?? Date.now;
  const startedAt = new Date(now());
  const summary = emptySummary();
  try {
    if (!Number.isInteger(opts.bookId) || opts.bookId <= 0) return { ran: false, code: "bad_request", claimed: 0, heartbeat: null };
    const pre = await bankPreflight(supabase);
    if (pre === "schema_missing" || pre === "other") return { ran: false, code: pre, claimed: 0, heartbeat: null };
    if (opts.plan !== false) {
      const plan = await planBook(supabase, opts.bookId);
      if (!plan.ok) return { ran: false, code: plan.code, claimed: 0, heartbeat: null };
      if (plan.off) return { ran: false, code: "off", claimed: 0, heartbeat: null };
    }
    if (pre === "schema_checks") {
      summary.codes.push("schema_checks");
      const hb = await logBankHeartbeat(supabase, { startedAt, endedAt: new Date(now()), summary, claimed: 0, anyApproved: true });
      return { ran: false, code: "schema_checks", claimed: 0, heartbeat: hb };
    }
    const r = await runBank(supabase, {
      client: opts.client,
      now,
      deadline: kickDeadline(startedAt.getTime(), opts.requestStartedAt),
      steps: opts.steps ?? GENERATION_STEPS,
      monthCapCents: opts.monthCapCents,
    });
    const repair = await repairDirtyStates(supabase, { limit: 20 }).catch(() => ({ repaired: 0, raced: 0, failed: 1 }));
    const { notes, extra } = notesOf(r.outcomes);
    if (repair.repaired) notes.push(`repaired ${repair.repaired}`);
    const hb = await logBankHeartbeat(supabase, { startedAt, endedAt: new Date(now()), summary: r.summary, notes, extraRecords: extra, claimed: r.claimed, anyApproved: true });
    return { ran: true, code: null, claimed: r.claimed, heartbeat: hb };
  } catch {
    summary.failed += 1;
    summary.codes.push("other");
    const hb = await logBankHeartbeat(supabase, { startedAt, endedAt: new Date(now()), summary, claimed: 0, anyApproved: true, forceStatus: "failed" });
    return { ran: false, code: "other", claimed: 0, heartbeat: hb };
  }
}

/* ------------------------------------------------------------------ */
/* The hourly worker                                                    */
/* ------------------------------------------------------------------ */

export interface WorkerOptions {
  client?: BankClient;
  now?: () => number;
  deadlineMs?: number;
  monthCapCents?: number;
  /** T07 answer retention in days (0 = off); default from READING_BANK_CLEAR_ANSWERS_DAYS (180). */
  clearAnswersDays?: number;
}
export interface WorkerResult {
  status: "success" | "partial" | "failed";
  books: number;
  enqueued: number;
  claimed: number;
  graded: number;
  ideas: number;
  repaired: number;
  cleared: number | null;
  codes: string[];
  heartbeat: "written" | "skipped" | "failed" | null;
}

/**
 * Sweep: grade jobs still queued 2 minutes after their answer (the attempt route's after() did not run them), and
 * grade jobs whose run stopped (a crash, a function at its maxDuration) and whose lease ran out. Those stay `running`
 * until a claim settles their lease, and claims otherwise run only in kicks and generation runs, so with every book
 * off nothing would: claimed here by id, pds.reading_bank_claim settles the lease first (queued again, or failed after
 * 3 attempts) and then claims it.
 */
async function sweepGrades(supabase: Supa, ctx: { client: BankClient; monthCap: number; now: () => number; deadline: number }, summary: BankRunSummary, outcomes: StepOutcome[]): Promise<number> {
  const nowMs = ctx.now();
  const nowIso = new Date(nowMs).toISOString();
  const [queued, expired] = await Promise.all([
    supabase
      .from("reading_bank_jobs")
      .select("job_id,created_at")
      .eq("step", "grade")
      .eq("status", "queued")
      .lt("created_at", new Date(nowMs - GRADE_SWEEP_AGE_MS).toISOString())
      .lte("next_attempt_at", nowIso)
      .order("created_at", { ascending: true })
      .limit(GRADE_SWEEP_MAX),
    supabase
      .from("reading_bank_jobs")
      .select("job_id,created_at")
      .eq("step", "grade")
      .eq("status", "running")
      .lt("lease_until", nowIso)
      .order("created_at", { ascending: true })
      .limit(GRADE_SWEEP_MAX),
  ]);
  const error = queued.error ?? expired.error;
  if (error) recordDbFailure(summary, errCode(error));
  const seen = new Set<number>();
  const rows = ([...((queued.data ?? []) as { job_id: unknown; created_at: unknown }[]), ...((expired.data ?? []) as { job_id: unknown; created_at: unknown }[])])
    .filter((r) => {
      const id = Number(r.job_id);
      if (!Number.isInteger(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")))
    .slice(0, GRADE_SWEEP_MAX);
  let claimed = 0;
  for (const row of rows) {
    if (ctx.deadline - ctx.now() < stepMs("grade", 1)) break;
    const { data: claim, error: e2 } = await supabase.rpc("reading_bank_claim", {
      p: { job_id: Number(row.job_id), steps: ["grade"], lease_seconds: STEP_MAX_SECONDS.grade + 30, month_cap_cents: ctx.monthCap, estimates: { grade: STEP_ESTIMATE_CENTS.grade } },
    });
    if (e2) {
      recordDbFailure(summary, errCode(e2));
      break;
    }
    if (!plainObject(claim)) continue;
    if (!plainObject(claim.job)) {
      if (claim.code === "monthly_cap") {
        summary.codes.push("monthly_cap");
        break;
      }
      continue;
    }
    claimed += 1;
    const out = await runClaimedJob(supabase, { job: claim.job as unknown as ClaimedJob, headroom_cents: claim.headroom_cents }, {
      client: ctx.client,
      monthCapCents: ctx.monthCap,
      now: ctx.now,
      deadline: ctx.deadline,
      stepScale: 1,
    });
    outcomes.push(out);
    recordOutcome(summary, out);
  }
  return claimed;
}

/** Whether this pass runs the daily answer clearing (one ET hour of the day). */
export const clearAnswersDue = (nowMs: number) => etHour(nowMs) === CLEAR_ANSWERS_ET_HOUR;

/** The hourly worker pass. Never throws; the result carries counts and codes only. */
export async function runWorker(supabase: Supa, opts: WorkerOptions = {}): Promise<WorkerResult> {
  const now = opts.now ?? Date.now;
  const startedAt = new Date(now());
  const deadline = startedAt.getTime() + (opts.deadlineMs ?? WORKER_DEADLINE_MS);
  const monthCap = opts.monthCapCents ?? monthlyCapCents(process.env.READING_BANK_MONTHLY_CAP_CENTS);
  const summary = emptySummary();
  const outcomes: StepOutcome[] = [];
  const result: WorkerResult = { status: "success", books: 0, enqueued: 0, claimed: 0, graded: 0, ideas: 0, repaired: 0, cleared: null, codes: [], heartbeat: null };
  const notes: string[] = [];
  let anyApproved = false;
  const done = async (force?: "failed") => {
    const { notes: stepNotes, extra } = notesOf(outcomes);
    result.status = force ?? bankHeartbeatStatus(summary);
    result.graded = summary.graded;
    result.ideas = bankHeartbeatRecords(summary) - summary.graded + extra;
    result.codes = [...new Set(summary.codes.map(bankCode))];
    result.heartbeat = await logBankHeartbeat(supabase, {
      startedAt,
      endedAt: new Date(now()),
      summary,
      notes: [...stepNotes, ...notes],
      extraRecords: extra,
      claimed: result.claimed,
      anyApproved,
      forceStatus: force,
    });
    return result;
  };
  try {
    const pre = await bankPreflight(supabase);
    if (pre === "schema_missing") {
      summary.failed += 1;
      summary.codes.push("schema_missing");
      return await done();
    }
    if (pre === "other") {
      summary.failed += 1;
      summary.codes.push("other");
      return await done();
    }
    const { data: books, error } = await supabase
      .from("reading_bank_books")
      .select("book_id,paused_reason")
      .not("approved_at", "is", null)
      .limit(50);
    if (error) {
      summary.failed += 1;
      summary.codes.push(errCode(error));
      return await done();
    }
    const ids = ((books ?? []) as { book_id: unknown; paused_reason: unknown }[]).filter((b) => b.paused_reason !== "owner").map((b) => Number(b.book_id));
    anyApproved = ids.length > 0;
    result.books = ids.length;
    if (pre === "schema_checks") {
      summary.codes.push("schema_checks");
      return await done();
    }
    for (const id of ids) {
      const p = await planBook(supabase, id);
      if (p.ok) result.enqueued += p.enqueued;
      else recordDbFailure(summary, p.code);
    }
    let client = opts.client ?? null;
    if (!client && process.env.ANTHROPIC_API_KEY) client = defaultBankClient();
    if (client) {
      result.claimed += await sweepGrades(supabase, { client, monthCap, now, deadline }, summary, outcomes);
      if (anyApproved) {
        const r = await runBank(supabase, { client, now, deadline, steps: GENERATION_STEPS, stepScale: WORKER_STEP_SCALE, monthCapCents: monthCap });
        result.claimed += r.claimed;
        outcomes.push(...r.outcomes);
        summary.chapters.push(...r.summary.chapters);
        summary.graded += r.summary.graded;
        summary.failed += r.summary.failed;
        summary.codes.push(...r.summary.codes);
      }
    } else if (anyApproved) {
      summary.failed += 1;
      summary.codes.push("auth");
    }
    const repair = await repairDirtyStates(supabase, { limit: 20 }).catch(() => ({ repaired: 0, raced: 0, failed: 1 }));
    result.repaired = repair.repaired;
    if (repair.repaired) notes.push(`repaired ${repair.repaired}`);
    const days = opts.clearAnswersDays ?? clearAnswersDays(process.env.READING_BANK_CLEAR_ANSWERS_DAYS);
    if (days > 0 && clearAnswersDue(now())) {
      const { data: n, error: e3 } = await supabase.rpc("reading_clear_question_answers", { p_days: days });
      if (e3) recordDbFailure(summary, errCode(e3));
      else {
        result.cleared = num(n, 0);
        notes.push(`cleared ${result.cleared} answers`);
      }
    }
    return await done();
  } catch {
    summary.failed += 1;
    summary.codes.push("other");
    return await done("failed");
  }
}

/** The worker's one log line (the Actions log is public): counts and codes only. */
export function workerLogLine(r: WorkerResult): string {
  const codes = r.codes.length ? ` codes ${r.codes.map(bankCode).join(" ")}` : "";
  const cleared = r.cleared === null ? "" : ` cleared ${Math.max(0, Math.trunc(r.cleared))}`;
  return `reading bank: ${r.status} books ${r.books} enqueued ${r.enqueued} claimed ${r.claimed} graded ${r.graded} ideas ${r.ideas} repaired ${r.repaired}${cleared} heartbeat ${r.heartbeat ?? "none"}${codes}`;
}

/* ------------------------------------------------------------------ */
/* Route helpers                                                        */
/* ------------------------------------------------------------------ */

const ok = (body: Record<string, unknown>, status = 200): BankAnswer => ({ status, body });
const fail = (status: number, error: string): BankAnswer => ({ status, body: { error } });
const strictKeys = (o: Record<string, unknown>, allowed: string[]) => Object.keys(o).every((k) => allowed.includes(k));

export function parseBookQuery(sp: URLSearchParams): { ok: true; slug: string | null } | { ok: false; error: string } {
  const slug = sp.get("book") || null;
  if (slug !== null && !SLUG_RE.test(slug)) return { ok: false, error: "bad_book" };
  return { ok: true, slug };
}

export interface ApprovalInput {
  slug: string | null;
  on: boolean;
  capCents: number | null;
}
/** PUT /api/reading/bank/approval: {book?, on, cap_cents (required when on)}; unknown fields refused. */
export function parseApprovalBody(raw: unknown): { ok: true; input: ApprovalInput } | { ok: false; error: string } {
  if (!plainObject(raw) || !strictKeys(raw, ["book", "on", "cap_cents"])) return { ok: false, error: "bad_request" };
  const slug = raw.book == null ? null : raw.book;
  if (slug !== null && (typeof slug !== "string" || !SLUG_RE.test(slug))) return { ok: false, error: "bad_book" };
  if (typeof raw.on !== "boolean") return { ok: false, error: "bad_request" };
  const cap = raw.cap_cents == null ? null : raw.cap_cents;
  if (raw.on && !(typeof cap === "number" && Number.isInteger(cap) && cap >= 100 && cap <= 2500)) return { ok: false, error: "bad_cap" };
  if (!raw.on && cap !== null && !(typeof cap === "number" && Number.isInteger(cap))) return { ok: false, error: "bad_cap" };
  return { ok: true, input: { slug: slug as string | null, on: raw.on, capCents: raw.on ? (cap as number) : null } };
}

export interface RunInput {
  slug: string | null;
  chapter: number | null;
  rebuild: boolean;
}
/** POST /api/reading/bank/run: {book?, chapter?, rebuild?}; unknown fields refused. */
export function parseRunBody(raw: unknown): { ok: true; input: RunInput } | { ok: false; error: string } {
  if (!plainObject(raw) || !strictKeys(raw, ["book", "chapter", "rebuild"])) return { ok: false, error: "bad_request" };
  const slug = raw.book == null ? null : raw.book;
  if (slug !== null && (typeof slug !== "string" || !SLUG_RE.test(slug))) return { ok: false, error: "bad_book" };
  const chapter = raw.chapter == null ? null : raw.chapter;
  if (chapter !== null && !(typeof chapter === "number" && Number.isInteger(chapter) && chapter >= 0 && chapter <= 100000)) return { ok: false, error: "bad_chapter" };
  if (raw.rebuild != null && typeof raw.rebuild !== "boolean") return { ok: false, error: "bad_request" };
  return { ok: true, input: { slug: slug as string | null, chapter: chapter as number | null, rebuild: raw.rebuild === true } };
}

/** A path chapter number ("0".."100000"), or null. */
export function chapterParam(raw: string): number | null {
  if (!/^\d{1,6}$/.test(raw)) return null;
  const n = Number(raw);
  return n <= 100000 ? n : null;
}

interface OverviewRow {
  book_id: number;
  total_chapters: number;
  enabled: boolean;
  approved_cents: number | null;
  spent_cents: number | string;
  paused_reason: string | null;
  [k: string]: unknown;
}

async function readOverview(supabase: Supa, slug: string | null): Promise<{ row: OverviewRow | null; failure: BankAnswer | null }> {
  const { data, error } = await supabase.rpc("reading_bank_overview", { p_slug: slug });
  if (error) {
    const f = bankFailure(null, error)!;
    return { row: null, failure: fail(f.status, f.error) };
  }
  if (!plainObject(data)) return { row: null, failure: fail(404, "book_not_found") };
  return { row: data as unknown as OverviewRow, failure: null };
}

/** What finishing the book would cost from here, and the cap a "Turn on" / "Allow more" tap approves. */
export function bookEstimate(input: PlanInput, spentCents: number) {
  const remaining = estimateRemainingCents(input);
  return {
    book_cents: estimateBookCents(input.total_chapters),
    remaining_cents: remaining,
    cap_cents: approvalCapCents(spentCents, remaining),
    per_chapter_cents: PER_CHAPTER_CENTS,
  };
}

/**
 * GET /api/reading/bank?book=: the chapter map (pds.reading_bank_overview, spoiler gate in SQL) + the estimate.
 * The overview and the planner input the estimate needs are read in parallel (the planner input's book through
 * pds.reading_bank_book_id, the overview's own rule), so the page's warm-up read waits for the slower of the two, not
 * their sum; if the active book changed between the two reads, the overview's book is read again.
 */
export async function getBankOverview(supabase: Supa, slug: string | null): Promise<BankAnswer> {
  const planned = (async (): Promise<{ input: PlanInput | null; error: DbError; bookId: number | null }> => {
    const { data: id, error } = await supabase.rpc("reading_bank_book_id", { p_slug: slug });
    if (error) return { input: null, error, bookId: null };
    if (id == null) return { input: null, error: null, bookId: null };
    const r = await readPlanInput(supabase, Number(id));
    return { ...r, bookId: Number(id) };
  })();
  const [{ row, failure }, plan] = await Promise.all([readOverview(supabase, slug), planned]);
  if (failure || !row) return failure ?? fail(404, "book_not_found");
  let { input, error } = plan;
  if (!error && (!input || plan.bookId !== Number(row.book_id))) ({ input, error } = await readPlanInput(supabase, row.book_id));
  if (error) {
    const f = bankFailure(null, error)!;
    return fail(f.status, f.error);
  }
  if (!input) return fail(404, "book_not_found");
  return ok({
    ...row,
    estimate: bookEstimate(input, num(row.spent_cents, 0)),
    monthly_cap_cents: monthlyCapCents(process.env.READING_BANK_MONTHLY_CAP_CENTS),
  });
}

/**
 * PUT /api/reading/bank/approval: Riley's one tap per book is the spending approval. The cap is recomputed here
 * (spent + the remaining estimate x 1.25, rounded up, at most $25) and must equal what the card showed (409
 * estimate_changed with the new cap otherwise). Turning off keeps every stored row. Returns the book id to kick.
 */
export async function setApproval(supabase: Supa, input: ApprovalInput): Promise<BankAnswer & { kickBookId: number | null }> {
  const { row, failure } = await readOverview(supabase, input.slug);
  if (failure || !row) return { ...(failure ?? fail(404, "book_not_found")), kickBookId: null };
  let cap: number | null = null;
  if (input.on) {
    const { input: plan, error } = await readPlanInput(supabase, row.book_id);
    if (error) {
      const f = bankFailure(null, error)!;
      return { ...fail(f.status, f.error), kickBookId: null };
    }
    if (!plan) return { ...fail(404, "book_not_found"), kickBookId: null };
    const est = bookEstimate(plan, num(row.spent_cents, 0));
    if (input.capCents !== est.cap_cents) {
      return { status: 409, body: { error: "estimate_changed", cap_cents: est.cap_cents, remaining_cents: est.remaining_cents }, kickBookId: null };
    }
    cap = est.cap_cents;
  }
  const { data, error } = await supabase.rpc("reading_bank_approve", { p: { book_id: row.book_id, on: input.on, cap_cents: cap } });
  const f = bankFailure(data, error);
  if (f) return { ...fail(f.status, f.error), kickBookId: null };
  return { ...ok({ success: true, book_id: row.book_id, on: input.on, cap_cents: cap }), kickBookId: input.on ? row.book_id : null };
}

/**
 * POST /api/reading/bank/run: "Build now" (plan + enqueue) and "Rebuild chapter" (the rebuild counter first: new job
 * hashes, so a fresh research + build is queued; chapter 0 or none = the source map and the whole-book build).
 * A rebuild is counted once per round of work: while the chapter's research or build (for chapter 0, the map or the
 * whole-book build) is still queued or running, or another Rebuild was counted since this request read the count,
 * the request answers the same 202 with `pending: true` and does not count again, which would make the first
 * rebuild's jobs obsolete and pay for its research and build twice. The decision, the count and the queueing of the
 * new count's jobs happen in one transaction under the claim lock (pds.reading_bank_rebuild), so overlapping taps
 * cannot both count.
 * Answers 202 at once; the work runs in after() (kickBookId).
 */
export async function requestRun(supabase: Supa, input: RunInput): Promise<BankAnswer & { kickBookId: number | null }> {
  const { row, failure } = await readOverview(supabase, input.slug);
  if (failure || !row) return { ...(failure ?? fail(404, "book_not_found")), kickBookId: null };
  if (!row.enabled) return { ...fail(409, "bank_off"), kickBookId: null };
  const total = num(row.total_chapters, 0);
  if (input.chapter !== null && total > 0 && input.chapter > total) return { ...fail(400, "bad_chapter"), kickBookId: null };
  let rebuilds: number | null = null;
  let pending = false;
  if (input.rebuild) {
    const chapter = input.chapter ?? 0;
    const { input: before, error: e0 } = await readPlanInput(supabase, row.book_id);
    if (e0) {
      const f = bankFailure(null, e0)!;
      return { ...fail(f.status, f.error), kickBookId: null };
    }
    if (!before) return { ...fail(404, "book_not_found"), kickBookId: null };
    // The count, the pending check and the enqueue of the new count's jobs are ONE call under the claim lock
    // (pds.reading_bank_rebuild): a check made here, before the call, would let two overlapping taps both pass it.
    const expected = before.bank.find((b) => b.chapter === chapter)?.rebuilds ?? 0;
    const rebuildPlan = planForBook(withRebuild(before, chapter), BANK_PROMPT_VERSION);
    const { data, error } = await supabase.rpc("reading_bank_rebuild", { p: { book_id: row.book_id, chapter, expected, plan: rebuildPlan } });
    const f = bankFailure(data, error);
    if (f) return { ...fail(f.status, f.error), kickBookId: null };
    if ((data as { pending?: unknown }).pending === true) pending = true;
    else rebuilds = num((data as { rebuilds?: unknown }).rebuilds, 0);
  }
  const plan = await planBook(supabase, row.book_id);
  if (!plan.ok) return { ...fail(plan.code === "schema_missing" ? 503 : 500, plan.code === "schema_missing" ? "bank_unavailable" : "failed"), kickBookId: null };
  return { ...ok({ success: true, book_id: row.book_id, queued: plan.jobs, enqueued: plan.enqueued, rebuilds, pending }, 202), kickBookId: row.book_id };
}

/** GET /api/reading/bank/chapter/[n]?book=: one chapter's sheet (pds.reading_bank_chapter; null = locked -> 404). */
export async function getChapterSheet(supabase: Supa, slug: string | null, chapter: number): Promise<BankAnswer> {
  const { data: bookId, error } = await supabase.rpc("reading_bank_book_id", { p_slug: slug });
  if (error) {
    const f = bankFailure(null, error)!;
    return fail(f.status, f.error);
  }
  if (bookId == null) return fail(404, "book_not_found");
  const { data, error: e2 } = await supabase.rpc("reading_bank_chapter", { p_book: Number(bookId), p_chapter: chapter });
  if (e2) {
    const f = bankFailure(null, e2)!;
    return fail(f.status, f.error);
  }
  if (!plainObject(data)) return fail(404, "locked");
  return ok({ ...data, rebuild_cents: PER_CHAPTER_CENTS });
}

const EXPORT_PAGE = 1000;
const EXPORT_MAX_PAGES = 10;

async function pagedSelect<T>(
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: DbError }>,
): Promise<{ rows: T[]; error: DbError }> {
  const rows: T[] = [];
  for (let page = 0; page < EXPORT_MAX_PAGES; page++) {
    const { data, error } = await build(page * EXPORT_PAGE, page * EXPORT_PAGE + EXPORT_PAGE - 1);
    if (error) return { rows, error };
    const list = (data ?? []) as T[];
    rows.push(...list);
    if (list.length < EXPORT_PAGE) break;
  }
  return { rows, error: null };
}

/**
 * GET /api/reading/bank/export?book=: the book's ideas (active and retired) at or below the spoiler gate and of the
 * current edition, their evidence and sources, and job counts by step and status (never the research notes).
 * Questions and answers stay on T07's export (GET /api/reading/questions?book=).
 */
export async function getBankExport(supabase: Supa, slug: string | null): Promise<BankAnswer> {
  const { data: bookId, error } = await supabase.rpc("reading_bank_book_id", { p_slug: slug });
  if (error) {
    const f = bankFailure(null, error)!;
    return fail(f.status, f.error);
  }
  if (bookId == null) return fail(404, "book_not_found");
  const book = Number(bookId);
  const { input, error: e1 } = await readPlanInput(supabase, book);
  if (e1 || !input) {
    const f = e1 ? bankFailure(null, e1)! : { status: 404, error: "book_not_found" };
    return fail(f.status, f.error);
  }
  const through = Math.max(0, Math.trunc(input.quiz_through) || 0);
  // The current edition of each chapter: its table of contents row's hash, else the hash of a chapter with no row
  // (a book tracked by hand has none), the same fallback as generation and pds.reading_bank_chapter_hash.
  const currentHash = currentHashOf(input);
  type IdeaRow = { idea_id: number; chapter: number; unlock_chapter: number; chapter_hash: string; [k: string]: unknown };
  const ideasRead = await pagedSelect<IdeaRow>((from, to) =>
    supabase
      .from("reading_ideas")
      .select("idea_id,chapter,unlock_chapter,chapter_hash,kind,importance,title,statement,key_points,facts,origin,status,retired_reason,retired_at,prompt_version,created_at")
      .eq("book_id", book)
      .lte("unlock_chapter", through)
      .lte("chapter", through)
      .order("idea_id", { ascending: true })
      .range(from, to),
  );
  if (ideasRead.error) {
    const f = bankFailure(null, ideasRead.error)!;
    return fail(f.status, f.error);
  }
  const ideas = ideasRead.rows.filter((i) => currentHash(Number(i.chapter)) === i.chapter_hash);
  const evidence: { idea_id: number; source_id: number }[] = [];
  for (const part of chunks(ideas.map((i) => Number(i.idea_id)), 200)) {
    const { data, error: e2 } = await supabase.from("reading_idea_evidence").select("idea_id,source_id").in("idea_id", part);
    if (e2) {
      const f = bankFailure(null, e2)!;
      return fail(f.status, f.error);
    }
    evidence.push(...((data ?? []) as { idea_id: number; source_id: number }[]));
  }
  const sources: Record<string, unknown>[] = [];
  for (const part of chunks(uniqueInts(evidence.map((e) => e.source_id)), 200)) {
    const { data, error: e3 } = await supabase
      .from("reading_bank_sources")
      .select("source_id,chapter,kind,url,domain,title,cited_text,highlight_id,retrieved_at")
      .in("source_id", part);
    if (e3) {
      const f = bankFailure(null, e3)!;
      return fail(f.status, f.error);
    }
    sources.push(...((data ?? []) as Record<string, unknown>[]));
  }
  const jobsRead = await pagedSelect<{ step: string; status: string }>((from, to) =>
    supabase.from("reading_bank_jobs").select("step,status").eq("book_id", book).order("job_id", { ascending: true }).range(from, to),
  );
  if (jobsRead.error) {
    const f = bankFailure(null, jobsRead.error)!;
    return fail(f.status, f.error);
  }
  const jobs: Record<string, number> = {};
  for (const j of jobsRead.rows) jobs[`${j.step}|${j.status}`] = (jobs[`${j.step}|${j.status}`] ?? 0) + 1;
  const bySource = new Map<number, number[]>();
  for (const e of evidence) bySource.set(Number(e.idea_id), [...(bySource.get(Number(e.idea_id)) ?? []), Number(e.source_id)]);
  return ok({
    book_id: book,
    quiz_through: through,
    prompt_version: BANK_PROMPT_VERSION,
    ideas: ideas.map((i) => ({ ...i, source_ids: bySource.get(Number(i.idea_id)) ?? [] })),
    sources,
    jobs,
  });
}
