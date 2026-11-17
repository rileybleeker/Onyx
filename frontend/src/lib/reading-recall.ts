/**
 * Reading question bank: the practice engine (READ-QUIZ-01; docs/reading-question-bank.md).
 *
 * Pure and import-free apart from lib/reading-practice.ts (the ONE scheduler, scheduleAfterGrade), so the routes,
 * the runner and the tests all run the same code:
 *
 * - buildRound(deck, opts): the day's round of 8 cards (Quick 3 = its first 3), built from what
 *   pds.reading_bank_round answered. Deterministic for a given deck and day, so the GET writes nothing, and a
 *   reopened round resumes: cards answered in it are marked done, never asked again, never penalised.
 * - gradeLocal(): the code grade (cued short answers, a hinted choice, an order, "I don't know"). The server
 *   re-grades with this same function and its verdict wins; anything code cannot judge goes to the model.
 * - explainScore / chapterRecallScore / verdictFromScore: how a model's point-by-point marks become a score.
 * - replayIdeaState(events, today): an idea's schedule and stage, rebuilt from its answers. The incremental write
 *   and the repair path are this same function (compare-and-set on state_version in SQL), so they cannot drift,
 *   and previewAnswer() (the "Next: in 3 days" line) is this replay with the answer appended: preview = commit.
 */

import { addDaysYmd, scheduleAfterGrade, type PracticeGrade } from "./reading-practice";

/* ------------------------------------------------------------------ */
/* Constants                                                            */
/* ------------------------------------------------------------------ */

/** A daily round; Quick 3 is its first 3 cards. Fixed constants, deliberately not tied to the PROD-T06 reading pacing preference (which governs weekly sessions and minutes, not round composition). */
export const ROUND_SIZE = 8;
export const QUICK_SIZE = 3;
/** Chapter sheet "Practice 5". */
export const CHAPTER_ROUND_SIZE = 5;
/** Composition caps (docs: "The round"). */
export const ROUND_MAX_RECALL = 1;
export const ROUND_MAX_DUE = 5;
export const ROUND_MAX_NEW = 3;
/** New ideas allowed when fewer than ROUND_LOW_DUE are due. */
export const ROUND_MAX_NEW_LOW_DUE = 5;
export const ROUND_LOW_DUE = 3;
export const ROUND_MAX_HIGHLIGHTS = 2;
/** At most this many cards of one format in a row (when the pool allows it). */
export const ROUND_MAX_SAME_FORMAT = 2;
/** A chapter recall card: the day after the chapter became quizzable, then day 7, then day 21. */
export const CHAPTER_RECALL_DAYS = [1, 7, 21] as const;
/** Kept = a correct explanation at least this many days after the one that reached Explained. */
export const KEPT_AFTER_DAYS = 7;
/** Score thresholds of a model grade, and the cap when an explanation misses its `must` point. */
export const SCORE_CORRECT = 0.8;
export const SCORE_PARTIAL = 0.4;
export const MUST_MISSED_CAP = 0.39;
/** A right option picked after "Show choices", or an order with one adjacent swap. */
export const PARTIAL_SCORE = 0.6;
/** The answer text "I don't know" stores (any format). */
export const DONT_KNOW_ANSWER = "I don't know";

export type BankFormat = "cued" | "explain" | "order" | "chapter_recall";
export type Verdict = "correct" | "partial" | "incorrect" | "dont_know";
export type ModelVerdict = Exclude<Verdict, "dont_know">;
export type Hit = "yes" | "partial" | "no";
export type Importance = "core" | "supporting" | "detail";
export type RoundKind = "daily" | "extra" | "chapter" | "checkpoint" | "chat";

export const STAGES = ["new", "seen", "recalled", "explained", "kept"] as const;
export type StageName = (typeof STAGES)[number];
export const STAGE_LABEL: Record<StageName, string> = { new: "New", seen: "Seen", recalled: "Recalled", explained: "Explained", kept: "Kept" };
export const stageName = (stage: number): StageName => STAGES[Math.max(0, Math.min(4, Math.trunc(stage) || 0))];

/* ------------------------------------------------------------------ */
/* SHA-256 (synchronous, pure; the same bytes as node:crypto)           */
/* ------------------------------------------------------------------ */

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01,
  0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08,
  0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/** SHA-256 of the text's UTF-8 bytes, lower-case hex (equals node:crypto and Postgres sha256(convert_to(t, 'UTF8'))). */
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
      const t1 = (k + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
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

/** A UUID (version 4 layout) derived from a hash: the same inputs always give the same key. */
export function uuidFromHash(hex: string): string {
  const v = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${v}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The round key: sha256(`book|today|kind|n`) as a UUID. n = 0 for the daily round, 1.. for extra rounds, the chapter for a chapter round. */
export function roundKey(bookId: number, today: string, kind: RoundKind, n = 0): string {
  return uuidFromHash(sha256Hex(`${bookId}|${today}|${kind}|${n}`));
}

/* ------------------------------------------------------------------ */
/* Normalization                                                        */
/* ------------------------------------------------------------------ */

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};

/**
 * Answer normalization: NFKD with diacritics removed, lower case, apostrophes dropped, other punctuation to spaces,
 * spaces collapsed, a leading a / an / the removed, number words 0-20 mapped to digits.
 */
export function normalizeAnswer(text: string): string {
  const base = String(text ?? "")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/['‘’ʼ`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
  if (!base) return "";
  const words = base.split(" ").map((w) => (w in NUMBER_WORDS ? String(NUMBER_WORDS[w]) : w));
  if (words.length > 1 && (words[0] === "a" || words[0] === "an" || words[0] === "the")) words.shift();
  return words.join(" ");
}

export const answerTokens = (text: string): string[] => {
  const n = normalizeAnswer(text);
  return n ? n.split(" ") : [];
};

/** Levenshtein distance, stopping early once it passes `max` (returns max + 1 then). */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

const DONT_KNOW_FORMS = new Set(["i dont know", "dont know", "i do not know", "no idea", "idk", "not sure"]);
export const isDontKnow = (answer: string): boolean => DONT_KNOW_FORMS.has(normalizeAnswer(answer));

/* ------------------------------------------------------------------ */
/* Rubrics (questions.rubric = the canonical jsonb text)                 */
/* ------------------------------------------------------------------ */

export interface CuedRubric {
  v: 1;
  format: "cued";
  answer: string;
  accept: string[];
  /** The optional hint: 4 options, `correct` is the index of the right one. */
  options?: string[];
  correct?: number;
  explanation: string;
}
export interface ExplainPoint {
  id: string;
  text: string;
  must: boolean;
}
export interface ExplainRubric {
  v: 1;
  format: "explain";
  points: ExplainPoint[];
  explanation: string;
}
export interface OrderRubric {
  v: 1;
  format: "order";
  steps: string[];
  explanation: string;
}
export interface ChapterRecallIdea {
  idea_id: number;
  title: string;
  importance: Importance;
}
export interface ChapterRecallRubric {
  v: 1;
  format: "chapter_recall";
  ideas: ChapterRecallIdea[];
}
export type Rubric = CuedRubric | ExplainRubric | OrderRubric | ChapterRecallRubric;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const strArr = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** A stored rubric (object or jsonb text), checked for its format's shape; null when it is not one. */
export function parseRubric(raw: unknown): Rubric | null {
  let r: unknown = raw;
  if (typeof raw === "string") {
    try {
      r = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isObj(r) || r.v !== 1) return null;
  if (r.format === "cued") {
    if (typeof r.answer !== "string" || !strArr(r.accept)) return null;
    if (r.options !== undefined && (!strArr(r.options) || !Number.isInteger(r.correct))) return null;
    return r as unknown as CuedRubric;
  }
  if (r.format === "explain") {
    if (!Array.isArray(r.points) || !r.points.every((p) => isObj(p) && typeof p.id === "string" && typeof p.text === "string" && typeof p.must === "boolean")) return null;
    return r as unknown as ExplainRubric;
  }
  if (r.format === "order") return strArr(r.steps) ? (r as unknown as OrderRubric) : null;
  if (r.format === "chapter_recall") {
    if (!Array.isArray(r.ideas) || !r.ideas.every((i) => isObj(i) && Number.isInteger(i.idea_id))) return null;
    return r as unknown as ChapterRecallRubric;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Local grading                                                        */
/* ------------------------------------------------------------------ */

export type LocalGrade = { kind: "graded"; verdict: Verdict; score: number } | { kind: "model" };

const graded = (verdict: Verdict, score: number): LocalGrade => ({ kind: "graded", verdict, score });

const hasDigit = (s: string): boolean => /\d/.test(s);
const isLetters = (s: string): boolean => /^\p{L}+$/u.test(s);

/**
 * A typo of one normalized form: the same number of words, and only words of 6 or more letters may differ (by at
 * most 1 edit per 6 letters, 1 per 6 characters of the form in all). A short word, a name under 6 letters and
 * anything with a digit must match exactly, so a year, a count or a short name is never "close enough".
 */
function typoMatches(given: string, form: string): boolean {
  const allowed = Math.floor(form.length / 6);
  if (allowed < 1) return false;
  const gt = given.split(" ");
  const ft = form.split(" ");
  if (gt.length !== ft.length) return false;
  let used = 0;
  for (let i = 0; i < ft.length; i++) {
    if (gt[i] === ft[i]) continue;
    if (ft[i].length < 6 || !isLetters(ft[i]) || !isLetters(gt[i])) return false;
    const per = Math.floor(ft[i].length / 6);
    const d = editDistance(gt[i], ft[i], per);
    if (d > per) return false;
    used += d;
    if (used > allowed) return false;
  }
  return used > 0;
}

/** Whether a typed short answer matches the expected answer or an accepted form. */
export function cuedMatches(rubric: Pick<CuedRubric, "answer" | "accept">, answer: string): boolean {
  const given = normalizeAnswer(answer);
  if (!given) return false;
  const givenTokens = given.split(" ");
  const forms = [rubric.answer, ...(rubric.accept ?? [])].map(normalizeAnswer).filter(Boolean);
  for (const form of forms) {
    if (given === form) return true;
    const ft = form.split(" ");
    // Every token of a 2+ token form is present and the answer is at most 4 tokens longer. For a form with a
    // number in it, any other number in the answer is a different fact: that is left to the model.
    if (ft.length >= 2 && ft.every((t) => givenTokens.includes(t)) && givenTokens.length <= ft.length + 4
        && (!hasDigit(form) || givenTokens.every((t) => !hasDigit(t) || ft.includes(t)))) return true;
    if (typoMatches(given, form)) return true;
  }
  return false;
}

/** The steps of an order answer: one step per line, in the order Riley put them. */
export const orderAnswerText = (steps: string[]): string => steps.join("\n");

/**
 * The code grade of one answer. `answer` is the stored text: what was typed, the option picked after "Show
 * choices" (`hinted`), the steps one per line (order), or DONT_KNOW_ANSWER. `{kind: "model"}` = the model grades it.
 */
export function gradeLocal(format: BankFormat, rubricRaw: unknown, answer: string, hinted = false): LocalGrade {
  const rubric = parseRubric(rubricRaw);
  if (normalizeAnswer(answer) === normalizeAnswer(DONT_KNOW_ANSWER)) return graded("dont_know", 0);
  if (format === "explain" || format === "chapter_recall") return isDontKnow(answer) ? graded("dont_know", 0) : { kind: "model" };
  if (format === "order") {
    if (!rubric || rubric.format !== "order") return graded("incorrect", 0);
    return gradeOrder(rubric.steps, answer);
  }
  if (!rubric || rubric.format !== "cued") return graded("incorrect", 0);
  if (hinted && rubric.options && Number.isInteger(rubric.correct)) {
    const right = rubric.options[rubric.correct as number];
    return right !== undefined && normalizeAnswer(answer) === normalizeAnswer(right) ? graded("partial", PARTIAL_SCORE) : graded("incorrect", 0);
  }
  if (cuedMatches(rubric, answer)) return hinted ? graded("partial", PARTIAL_SCORE) : graded("correct", 1);
  if (isDontKnow(answer)) return graded("dont_know", 0);
  // A miss of 3 or more words may be a paraphrase: the model checks it. Shorter is simply wrong.
  return answerTokens(answer).length >= 3 ? { kind: "model" } : graded("incorrect", 0);
}

/** All pairs in order = correct; exactly one adjacent swap = partial; anything else = incorrect. */
export function gradeOrder(steps: string[], answer: string): LocalGrade {
  const want = steps.map(normalizeAnswer);
  const lines = String(answer ?? "").split(/\r?\n/).map(normalizeAnswer).filter(Boolean);
  if (lines.length !== want.length) return graded("incorrect", 0);
  const idx = lines.map((l) => want.indexOf(l));
  if (idx.some((i) => i < 0) || new Set(idx).size !== idx.length) return graded("incorrect", 0);
  const wrong = idx.map((v, i) => (v === i ? -1 : i)).filter((i) => i >= 0);
  if (wrong.length === 0) return graded("correct", 1);
  if (wrong.length === 2 && wrong[1] === wrong[0] + 1 && idx[wrong[0]] === wrong[1] && idx[wrong[1]] === wrong[0]) {
    return graded("partial", PARTIAL_SCORE);
  }
  return graded("incorrect", 0);
}

/* ------------------------------------------------------------------ */
/* Model grade -> score                                                 */
/* ------------------------------------------------------------------ */

export interface PointHit {
  id: string;
  hit: Hit;
}

const hitValue = (h: Hit | undefined): number => (h === "yes" ? 1 : h === "partial" ? 0.5 : 0);
const round2 = (x: number) => Math.round(x * 100) / 100;
const hitMap = (hits: PointHit[] | null | undefined): Map<string, Hit> => {
  const m = new Map<string, Hit>();
  for (const h of hits ?? []) if (h && typeof h.id === "string" && !m.has(h.id)) m.set(h.id, h.hit);
  return m;
};

export function verdictFromScore(score: number): ModelVerdict {
  return score >= SCORE_CORRECT ? "correct" : score >= SCORE_PARTIAL ? "partial" : "incorrect";
}

/** Explain: points weighted yes 1 / partial 0.5, divided by the count; at most 0.39 when the `must` point is missed. */
export function explainScore(points: ExplainPoint[], hits: PointHit[] | null | undefined): number {
  if (!points.length) return 0;
  const m = hitMap(hits);
  let score = points.reduce((s, p) => s + hitValue(m.get(p.id)), 0) / points.length;
  if (points.some((p) => p.must && (m.get(p.id) ?? "no") === "no")) score = Math.min(score, MUST_MISSED_CAP);
  return round2(score);
}

/** The point id of a covered idea in a chapter recall grade. */
export const recallPointId = (ideaId: number) => `i${ideaId}`;

/**
 * The verdict a graded chapter recall answer gives ONE covered idea (mirrors pds.reading_bank_events): "I don't
 * know" for every idea; else the idea's own hit (yes correct, partial partial, no incorrect); else, when the grade
 * carries no hit for it (a self grade after a failed model grade, the chat tool's single verdict), the answer's own
 * verdict, so a "correct" self grade is never a lapse for every idea.
 */
export function recallEventVerdict(attemptVerdict: Verdict, hits: PointHit[] | null | undefined, ideaId: number): Verdict {
  if (attemptVerdict === "dont_know") return "dont_know";
  const h = hitMap(hits).get(recallPointId(ideaId));
  return h === "yes" ? "correct" : h === "partial" ? "partial" : h === "no" ? "incorrect" : attemptVerdict;
}

/** Chapter recall: (2 x core hits + supporting hits) / (2 x core + supporting), partial = 0.5. */
export function chapterRecallScore(ideas: ChapterRecallIdea[], hits: PointHit[] | null | undefined): number {
  const m = hitMap(hits);
  let num = 0;
  let den = 0;
  for (const i of ideas) {
    const w = i.importance === "core" ? 2 : 1;
    den += w;
    num += w * hitValue(m.get(recallPointId(i.idea_id)));
  }
  return den ? round2(num / den) : 0;
}

/** The point id of a cued answer the model checks as a paraphrase (one point: the expected answer). */
export const CUED_POINT_ID = "answer";

/** Score of a model grade for any format, from its rubric and the point marks. */
export function modelScore(format: BankFormat, rubricRaw: unknown, hits: PointHit[] | null | undefined): number {
  const r = parseRubric(rubricRaw);
  if (format === "explain" && r?.format === "explain") return explainScore(r.points, hits);
  if (format === "chapter_recall" && r?.format === "chapter_recall") return chapterRecallScore(r.ideas, hits);
  if (format === "cued") return round2(hitValue(hitMap(hits).get(CUED_POINT_ID)));
  return 0;
}

/* ------------------------------------------------------------------ */
/* Replay: schedule and stage from an idea's answers                    */
/* ------------------------------------------------------------------ */

/** One answer event of an idea (pds.reading_bank_events). */
export interface BankEvent {
  attempt_key: string;
  question_id: number;
  attempt_date: string;
  answered_at: string;
  grading_status: "pending" | "graded" | "invalidated";
  verdict: Verdict | null;
  format: BankFormat;
  hinted: boolean;
  round_kind?: string | null;
}

export interface IdeaState {
  stage: number;
  ease: number;
  interval_days: number;
  review_count: number;
  next_review: string | null;
  last_reviewed: string | null;
  lapses: number;
  last_verdict: Verdict | null;
  stage_success_on: string | null;
  last_question_ids: number[];
}

export const NEW_IDEA_STATE: Readonly<IdeaState> = Object.freeze({
  stage: 0,
  ease: 2.5,
  interval_days: 0,
  review_count: 0,
  next_review: null,
  last_reviewed: null,
  lapses: 0,
  last_verdict: null,
  stage_success_on: null,
  last_question_ids: [],
});

/** The grade the scheduler gets for a counted verdict. */
export function scheduleGrade(verdict: Verdict, format: BankFormat, previousVerdict: Verdict | null): PracticeGrade {
  if (verdict === "correct") return previousVerdict === "correct" && (format === "explain" || format === "chapter_recall") ? "easy" : "good";
  if (verdict === "partial") return "good";
  return "again";
}

const cmpEvent = (a: BankEvent, b: BankEvent) =>
  a.attempt_date.localeCompare(b.attempt_date) || String(a.answered_at).localeCompare(String(b.answered_at)) || a.attempt_key.localeCompare(b.attempt_key);

/** The events that count: the first non-invalidated event of each day, when it is graded (a pending one holds its day). */
export function countedEvents(events: BankEvent[], today?: string): BankEvent[] {
  const sorted = events.filter((e) => e.grading_status !== "invalidated" && (!today || e.attempt_date <= today)).sort(cmpEvent);
  const out: BankEvent[] = [];
  let day = "";
  for (const e of sorted) {
    if (e.attempt_date === day) continue;
    day = e.attempt_date;
    if (e.grading_status === "graded" && e.verdict) out.push(e);
  }
  return out;
}

/** Apply one counted event to a state (the transition rules of docs "Schedule and stages"). */
export function applyEvent(state: IdeaState, e: BankEvent): IdeaState {
  const verdict = e.verdict as Verdict;
  const sched = scheduleAfterGrade(state, scheduleGrade(verdict, e.format, state.last_verdict), e.attempt_date);
  let stage = Math.max(state.stage, 1);
  let successOn = state.stage_success_on;
  let lapses = state.lapses;
  const recallFormat = e.format === "cued" || e.format === "order";
  const explainFormat = e.format === "explain" || e.format === "chapter_recall";
  if (verdict === "correct" && explainFormat) {
    const keptReady = state.stage >= 3 && !!state.stage_success_on && state.stage_success_on <= addDaysYmd(e.attempt_date, -KEPT_AFTER_DAYS);
    stage = keptReady ? 4 : Math.max(stage, 3);
    successOn = e.attempt_date;
  } else if (verdict === "correct" && recallFormat && !e.hinted) {
    stage = Math.max(stage, 2);
  } else if ((verdict === "incorrect" || verdict === "dont_know") && state.stage >= 2) {
    lapses += 1;
    stage = Math.max(1, state.stage - 1);
    successOn = null;
  }
  return {
    stage,
    ease: sched.ease,
    interval_days: sched.interval_days,
    review_count: sched.review_count,
    next_review: sched.next_review,
    last_reviewed: sched.last_reviewed,
    lapses,
    last_verdict: verdict,
    stage_success_on: successOn,
    last_question_ids: state.last_question_ids,
  };
}

/**
 * The state of one idea rebuilt from all its events (any order; invalidated ones ignored). Only the first
 * non-invalidated event per behavioral day counts; a pending first event holds its day and counts once graded.
 * last_question_ids = the last 2 of the idea's own questions asked (chapter recall answers are not variants).
 */
export function replayIdeaState(events: BankEvent[], today?: string): IdeaState {
  let state: IdeaState = { ...NEW_IDEA_STATE, last_question_ids: [] };
  for (const e of countedEvents(events, today)) state = applyEvent(state, e);
  const asked = events
    .filter((e) => e.grading_status !== "invalidated" && e.format !== "chapter_recall" && (!today || e.attempt_date <= today))
    .sort(cmpEvent)
    .map((e) => e.question_id);
  return { ...state, last_question_ids: asked.slice(-2) };
}

/** The `next` object pds.reading_bank_states_write takes for one idea. */
export function stateRow(ideaId: number, basisVersion: number, state: IdeaState) {
  return {
    idea_id: ideaId,
    basis_version: basisVersion,
    next: {
      stage: state.stage,
      ease: state.ease,
      interval_days: state.interval_days,
      review_count: state.review_count,
      next_review: state.next_review ?? "",
      last_reviewed: state.last_reviewed ?? "",
      lapses: state.lapses,
      last_verdict: state.last_verdict ?? "",
      stage_success_on: state.stage_success_on ?? "",
      last_question_ids: state.last_question_ids,
    },
  };
}

export interface AnswerPreview {
  /** False when the idea already had an answer today: this one changes no schedule (only the first answer of a day counts). */
  counts: boolean;
  next: Record<ModelVerdict | "dont_know", { next_review: string | null; interval_days: number; stage: number }>;
}

/** What each verdict would schedule if this answer were stored now: the commit's own replay (preview = commit). */
export function previewAnswer(events: BankEvent[], today: string, question: { question_id: number; format: BankFormat }, hinted = false): AnswerPreview {
  const alreadyToday = events.some((e) => e.grading_status !== "invalidated" && e.attempt_date === today);
  const next = {} as AnswerPreview["next"];
  for (const v of ["correct", "partial", "incorrect", "dont_know"] as const) {
    const s = replayIdeaState(
      [...events, { attempt_key: "~preview", question_id: question.question_id, attempt_date: today, answered_at: "9999-12-31T23:59:59Z", grading_status: "graded", verdict: v, format: question.format, hinted }],
      today,
    );
    next[v] = { next_review: s.next_review, interval_days: s.interval_days, stage: s.stage };
  }
  return { counts: !alreadyToday, next };
}

/* ------------------------------------------------------------------ */
/* The deck (pds.reading_bank_round) and the round                      */
/* ------------------------------------------------------------------ */

export interface DeckQuestion {
  question_id: number;
  version: number;
  format: BankFormat;
  prompt: string;
  rubric: unknown;
}
export interface DeckSource {
  kind: "web" | "highlight";
  url: string | null;
  domain: string | null;
  title: string | null;
  cited_text: string | null;
  highlight_id: number | null;
  passage: string | null;
  location: string | null;
  page?: number | null;
}
export interface DeckIdea {
  idea_id: number;
  chapter: number;
  importance: Importance;
  kind: string;
  title: string;
  statement: string;
  key_points: string[];
  stage: number;
  next_review: string | null;
  state_version: number;
  dirty: boolean;
  last_question_ids: number[];
  last_verdict: Verdict | null;
  ease: number | string;
  interval_days: number;
  review_count: number;
  lapses: number;
  stage_success_on: string | null;
  last_reviewed: string | null;
  why: string[] | null;
  questions: DeckQuestion[];
  sources: DeckSource[];
}
export interface DeckRecall {
  chapter: number;
  question_id: number;
  version: number;
  prompt: string;
  rubric: unknown;
  done_n: number;
  due_on: string;
}
export interface DeckHighlight {
  highlight_id: number;
  chapter: number | null;
  passage: string;
  comment: string | null;
  location: string | null;
  page?: number | null;
  review_count: number;
  interval_days: number;
  ease: number | string;
  next_review: string | null;
  last_reviewed: string | null;
}
export interface DeckAnswered {
  attempt_key: string;
  question_id: number;
  idea_id: number | null;
  covers?: number[] | null;
  round_key: string | null;
  round_kind: string | null;
  verdict: Verdict | null;
  grading_status: string;
}
export interface Deck {
  book_id: number;
  today: string;
  quiz_through: number;
  chapter?: number | null;
  enabled?: boolean;
  ideas: DeckIdea[];
  chapter_recall: DeckRecall[];
  highlights: DeckHighlight[];
  answered_today: DeckAnswered[];
}

export type CardFormat = BankFormat | "highlight";

export interface RoundCard {
  /** Stable id of the card inside the round. */
  key: string;
  kind: "idea" | "chapter_recall" | "highlight";
  chapter: number | null;
  format: CardFormat;
  /** Why it is in the round: recall | due | new | newest | detail | highlight | practice. */
  slot: string;
  idea?: DeckIdea;
  question?: DeckQuestion;
  recall?: DeckRecall;
  highlight?: DeckHighlight;
  /** Answered in this round today (shown as done; never asked again today). */
  done: boolean;
  attempt_key?: string;
  /** An "Again" repeat (never touches the schedule). */
  again?: boolean;
}

export interface Round {
  round_key: string;
  today: string;
  kind: "daily" | "extra" | "chapter";
  n: number;
  cards: RoundCard[];
  /** Candidates left for "One more round" after this one. */
  extra_available: number;
}

export interface RoundOptions {
  kind?: "daily" | "extra" | "chapter";
  size?: number;
  /** Extra round number (1, 2, ...); ignored for daily. */
  n?: number;
}

const importanceRank = (i: Importance) => (i === "core" ? 0 : i === "supporting" ? 1 : 2);
const tieHash = (id: string | number, today: string) => sha256Hex(`${id}|${today}`);

/**
 * The question to ask for an idea, by stage: 0-1 cued (or order), 2 explain, 3-4 explain and cued alternating;
 * detail ideas never get explain. Never one of the last 2 questions asked when another exists (that rule ranks
 * above the stage's preferred format, so a variant just asked is not repeated because its format fits), and a
 * format other than the last one used is preferred.
 */
export function pickQuestion(idea: Pick<DeckIdea, "stage" | "importance" | "questions" | "last_question_ids">, exclude: number[] = []): DeckQuestion | null {
  const qs = (idea.questions ?? []).filter((q) => !(idea.importance === "detail" && q.format === "explain"));
  if (!qs.length) return null;
  const last = idea.last_question_ids ?? [];
  const lastQ = qs.find((q) => q.question_id === last[last.length - 1]) ?? (idea.questions ?? []).find((q) => q.question_id === last[last.length - 1]);
  const lastFormat = lastQ?.format ?? null;
  const stage = idea.stage ?? 0;
  const desired: BankFormat[] =
    stage <= 1 ? ["cued", "order"] : stage === 2 ? ["explain"] : lastFormat === "explain" ? ["cued", "order"] : ["explain"];
  const rank = (q: DeckQuestion) => {
    const d = desired.indexOf(q.format);
    return [
      exclude.includes(q.question_id) ? 1 : 0,
      last.includes(q.question_id) ? 1 : 0,
      d < 0 ? 1 : 0,
      q.format === lastFormat ? 1 : 0,
      d < 0 ? 9 : d,
      q.question_id,
    ];
  };
  const sorted = [...qs].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] - rb[i];
    return 0;
  });
  return sorted[0];
}

/** Whether an idea answered today was new (its only counted answer is today's) rather than due. */
const wasNewToday = (idea: DeckIdea, today: string) => idea.review_count <= 1 && (idea.last_reviewed === today || idea.last_reviewed === null);

function ideaCard(idea: DeckIdea, slot: string, question: DeckQuestion, done = false, attemptKey?: string): RoundCard {
  return { key: `idea:${idea.idea_id}`, kind: "idea", chapter: idea.chapter, format: question.format, slot, idea, question, done, attempt_key: attemptKey };
}
function recallCard(r: DeckRecall, done = false, attemptKey?: string): RoundCard {
  return { key: `recall:${r.chapter}`, kind: "chapter_recall", chapter: r.chapter, format: "chapter_recall", slot: "recall", recall: r, question: { question_id: r.question_id, version: r.version, format: "chapter_recall", prompt: r.prompt, rubric: r.rubric }, done, attempt_key: attemptKey };
}
function highlightCard(h: DeckHighlight, today: string): RoundCard {
  return { key: `highlight:${h.highlight_id}`, kind: "highlight", chapter: h.chapter, format: "highlight", slot: "highlight", highlight: h, done: h.last_reviewed === today };
}

/**
 * Greedy interleaving: each next card is the one farthest (by chapter) from the previous card, never the same
 * chapter twice in a row when avoidable, at most ROUND_MAX_SAME_FORMAT of one format in a row; ties by
 * sha256(card|today). A chapter recall card, when present, stays first.
 */
export function interleave(cards: RoundCard[], today: string): RoundCard[] {
  const first = cards.filter((c) => c.kind === "chapter_recall").slice(0, 1);
  const rest = cards.filter((c) => !first.includes(c)).map((c) => ({ c, h: tieHash(c.key, today) }));
  rest.sort((a, b) => a.h.localeCompare(b.h));
  const out: RoundCard[] = [...first];
  while (rest.length) {
    const prev = out[out.length - 1];
    const runFormat =
      out.length >= ROUND_MAX_SAME_FORMAT && out.slice(-ROUND_MAX_SAME_FORMAT).every((c) => c.format === out[out.length - 1].format)
        ? out[out.length - 1].format
        : null;
    let best = -1;
    let bestScore: number[] = [];
    rest.forEach(({ c }, i) => {
      const formatBreak = runFormat !== null && c.format === runFormat ? 1 : 0;
      const sameChapter = prev && prev.chapter !== null && c.chapter !== null && prev.chapter === c.chapter ? 1 : 0;
      const dist = prev && prev.chapter !== null && c.chapter !== null ? Math.abs(prev.chapter - c.chapter) : 0;
      const score = [formatBreak, sameChapter, -dist];
      if (best < 0 || compareArr(score, bestScore) < 0) {
        best = i;
        bestScore = score;
      }
    });
    out.push(rest.splice(best, 1)[0].c);
  }
  return out;
}
function compareArr(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

interface Pools {
  recall: DeckRecall[];
  due: DeckIdea[];
  fresh: DeckIdea[];
  newest: DeckIdea[];
  detail: DeckIdea[];
  later: DeckIdea[];
  highlights: DeckHighlight[];
}

function pools(deck: Deck, exclude: Set<number>, excludeRecall: Set<number>, excludeHighlights: Set<number>): Pools {
  const today = deck.today;
  const ideas = deck.ideas.filter((i) => !exclude.has(i.idea_id) && pickQuestion(i) !== null);
  const byDue = (a: DeckIdea, b: DeckIdea) => String(a.next_review).localeCompare(String(b.next_review)) || a.chapter - b.chapter || a.idea_id - b.idea_id;
  const byNew = (a: DeckIdea, b: DeckIdea) => importanceRank(a.importance) - importanceRank(b.importance) || a.chapter - b.chapter || a.idea_id - b.idea_id;
  const isDue = (i: DeckIdea) => i.next_review !== null && i.next_review <= today;
  const isNew = (i: DeckIdea) => i.next_review === null;
  const newestChapter = Math.max(-1, ...deck.ideas.filter((i) => i.chapter >= 1).map((i) => i.chapter));
  return {
    recall: [...(deck.chapter_recall ?? [])].filter((r) => !excludeRecall.has(r.question_id)).sort((a, b) => a.due_on.localeCompare(b.due_on) || a.chapter - b.chapter),
    due: ideas.filter((i) => isDue(i) && i.importance !== "detail").sort(byDue),
    fresh: ideas.filter((i) => isNew(i) && i.importance !== "detail").sort(byNew),
    newest: ideas.filter((i) => isNew(i) && i.importance === "core" && i.chapter === newestChapter).sort(byNew),
    detail: [...ideas.filter((i) => isDue(i) && i.importance === "detail").sort(byDue), ...ideas.filter((i) => isNew(i) && i.importance === "detail").sort(byNew)],
    later: ideas.filter((i) => i.next_review !== null && i.next_review > today).sort(byDue),
    highlights: (deck.highlights ?? []).filter((h) => !excludeHighlights.has(h.highlight_id) && h.last_reviewed !== today),
  };
}

/**
 * The round. Composition (docs "The round"): at most 1 chapter recall (the oldest due, placed first); due ideas,
 * up to 5, most overdue first; new ideas, up to 3 (5 when fewer than 3 are due), core before supporting, earliest
 * chapter first, one slot for the newest unlocked chapter's core idea; at most 2 unlinked highlight reviews; detail
 * ideas only in slots left over. A backlog never makes it longer. Cards answered in this round today are kept in
 * place, marked done; ideas answered today in another round are not asked again.
 */
export function buildRound(deck: Deck, opts: RoundOptions = {}): Round {
  const kind = opts.kind ?? "daily";
  const today = deck.today;
  const n = kind === "daily" ? 0 : kind === "chapter" ? (deck.chapter ?? 0) : Math.max(1, opts.n ?? 1);
  const size = Math.max(1, opts.size ?? (kind === "chapter" ? CHAPTER_ROUND_SIZE : ROUND_SIZE));
  const key = roundKey(deck.book_id, today, kind, n);
  const answered = deck.answered_today ?? [];
  const here = answered.filter((a) => a.round_key === key);
  const ideaById = new Map(deck.ideas.map((i) => [i.idea_id, i]));
  const answeredIdeas = new Set(answered.map((a) => a.idea_id).filter((x): x is number => typeof x === "number"));
  const answeredQuestions = new Set(answered.map((a) => a.question_id));

  if (kind === "chapter") {
    const cards: RoundCard[] = [];
    for (const a of here) {
      const idea = a.idea_id !== null ? ideaById.get(a.idea_id) : undefined;
      const q = idea?.questions.find((x) => x.question_id === a.question_id);
      if (idea && q && !cards.some((c) => c.key === `idea:${idea.idea_id}`)) cards.push(ideaCard(idea, "practice", q, true, a.attempt_key));
    }
    const ordered = [...deck.ideas]
      .filter((i) => !answeredIdeas.has(i.idea_id))
      .sort((a, b) => {
        const ra = a.next_review === null ? 1 : a.next_review <= today ? 0 : 2;
        const rb = b.next_review === null ? 1 : b.next_review <= today ? 0 : 2;
        return ra - rb || importanceRank(a.importance) - importanceRank(b.importance) || String(a.next_review).localeCompare(String(b.next_review)) || a.idea_id - b.idea_id;
      });
    for (const i of ordered) {
      if (cards.length >= size) break;
      const q = pickQuestion(i);
      if (q) cards.push(ideaCard(i, "practice", q));
    }
    return { round_key: key, today, kind, n, cards: interleave(cards, today), extra_available: 0 };
  }

  // Ideas, recall questions and highlights that belong to the daily round (an extra round excludes them).
  const daily = kind === "extra" ? buildRound(deck, { kind: "daily", size }) : null;
  const priorIdeas = new Set<number>();
  const priorRecall = new Set<number>();
  const priorHighlights = new Set<number>();
  if (daily) {
    for (const c of daily.cards) {
      if (c.idea) priorIdeas.add(c.idea.idea_id);
      if (c.recall) priorRecall.add(c.recall.question_id);
      if (c.highlight) priorHighlights.add(c.highlight.highlight_id);
    }
  }

  // Done cards of this round.
  const doneRecall: RoundCard[] = [];
  const doneDue: RoundCard[] = [];
  const doneNew: RoundCard[] = [];
  const doneDetail: RoundCard[] = [];
  const seenIdea = new Set<number>();
  for (const a of [...here].sort((x, y) => x.attempt_key.localeCompare(y.attempt_key))) {
    const r = (deck.chapter_recall ?? []).find((x) => x.question_id === a.question_id);
    if (r && !doneRecall.length) {
      doneRecall.push(recallCard(r, true, a.attempt_key));
      continue;
    }
    if (a.idea_id === null || seenIdea.has(a.idea_id)) continue;
    const idea = ideaById.get(a.idea_id);
    const q = idea?.questions.find((x) => x.question_id === a.question_id);
    if (!idea || !q) continue;
    seenIdea.add(idea.idea_id);
    if (idea.importance === "detail") doneDetail.push(ideaCard(idea, "detail", q, true, a.attempt_key));
    else if (wasNewToday(idea, today)) doneNew.push(ideaCard(idea, "new", q, true, a.attempt_key));
    else doneDue.push(ideaCard(idea, "due", q, true, a.attempt_key));
  }

  const exclude = new Set<number>([...answeredIdeas, ...priorIdeas]);
  const excludeRecall = new Set<number>([...answeredQuestions, ...priorRecall]);
  const p = pools(deck, exclude, excludeRecall, priorHighlights);
  const newestChapter = Math.max(-1, ...deck.ideas.filter((i) => i.chapter >= 1).map((i) => i.chapter));
  const doneHighlights = kind === "daily" ? (deck.highlights ?? []).filter((h) => h.last_reviewed === today && !priorHighlights.has(h.highlight_id)) : [];

  const cards: RoundCard[] = [];
  const room = () => size - cards.length;
  const used = new Set<number>();
  const addIdea = (i: DeckIdea, slot: string) => {
    const q = pickQuestion(i);
    if (!q || used.has(i.idea_id) || room() <= 0) return false;
    used.add(i.idea_id);
    cards.push(ideaCard(i, slot, q));
    return true;
  };
  const allDone = [...doneRecall, ...doneDue, ...doneNew, ...doneDetail];
  for (const c of allDone) if (c.idea) used.add(c.idea.idea_id);

  // 1. Chapter recall.
  if (doneRecall.length) cards.push(...doneRecall);
  else if (p.recall.length && room() > 0) cards.push(recallCard(p.recall[0]));
  // 2. Due.
  cards.push(...doneDue);
  for (const i of p.due) {
    if (cards.filter((c) => c.slot === "due").length >= ROUND_MAX_DUE) break;
    addIdea(i, "due");
  }
  // 3. New: core before supporting, earliest chapter first; one slot goes to the newest unlocked chapter's core idea.
  const dueCount = doneDue.length + p.due.length;
  const newCap = dueCount < ROUND_LOW_DUE ? ROUND_MAX_NEW_LOW_DUE : ROUND_MAX_NEW;
  cards.push(...doneNew);
  // The slots new ideas can still take: the cap, and the room the recall and due cards left. The newest chapter's
  // slot is reserved inside that space (it takes the last pick), so it is never pushed out of a full round.
  const newSlots = Math.min(newCap - doneNew.length, room());
  if (newSlots > 0) {
    const newest = p.newest[0];
    const doneHasNewest = doneNew.some((c) => c.idea && c.idea.chapter === newestChapter && c.idea.importance === "core");
    let picks = p.fresh.slice(0, newSlots);
    if (newest && !doneHasNewest && !picks.some((i) => i.idea_id === newest.idea_id)) picks = [...picks.slice(0, newSlots - 1), newest];
    for (const i of picks) addIdea(i, newest && i.idea_id === newest.idea_id ? "newest" : "new");
  }
  // 4. Highlights.
  for (const h of doneHighlights) if (cards.filter((c) => c.kind === "highlight").length < ROUND_MAX_HIGHLIGHTS) cards.push(highlightCard(h, today));
  for (const h of p.highlights) {
    if (cards.filter((c) => c.kind === "highlight").length >= ROUND_MAX_HIGHLIGHTS || room() <= 0) break;
    cards.push(highlightCard(h, today));
  }
  // 5. Leftover slots: detail ideas (answered ones first), then more due ideas.
  cards.push(...doneDetail);
  for (const i of p.detail) {
    if (room() <= 0) break;
    addIdea(i, "detail");
  }
  for (const i of p.due) {
    if (room() <= 0) break;
    addIdea(i, "due");
  }

  const ordered = interleave(cards, today);
  // What is left for "One more round": ideas not in this round and not answered today, recall + highlights left.
  const inRound = new Set(ordered.filter((c) => c.idea).map((c) => c.idea!.idea_id));
  const left =
    [...p.due, ...p.fresh, ...p.detail].filter((i, idx, arr) => !inRound.has(i.idea_id) && arr.findIndex((x) => x.idea_id === i.idea_id) === idx).length +
    Math.max(0, p.recall.length - (ordered.some((c) => c.kind === "chapter_recall" && !c.done) ? 1 : 0)) +
    p.highlights.filter((h) => !ordered.some((c) => c.highlight?.highlight_id === h.highlight_id)).length;
  return { round_key: key, today, kind, n, cards: ordered, extra_available: left };
}

/** Quick 3: the first 3 cards of the day's round, in the same order. */
export const quickCards = (round: Round): RoundCard[] => round.cards.slice(0, QUICK_SIZE);

/** "Again": an idea answered incorrectly comes back once at the end with another variant (or null when it has none). */
export function againCard(card: RoundCard): RoundCard | null {
  if (card.kind !== "idea" || !card.idea || !card.question || card.again) return null;
  const q = pickQuestion(card.idea, [card.question.question_id]);
  if (!q || q.question_id === card.question.question_id) return null;
  return { ...card, key: `${card.key}:again`, format: q.format, question: q, done: false, attempt_key: undefined, again: true };
}

/** Rough minutes for a set of cards (the "about 4 min" line). */
export function roundMinutes(cards: RoundCard[]): number {
  const secs: Record<CardFormat, number> = { cued: 20, order: 30, explain: 60, chapter_recall: 120, highlight: 15 };
  const total = cards.filter((c) => !c.done).reduce((s, c) => s + secs[c.format], 0);
  return Math.max(1, Math.round(total / 60));
}

/** The next chapter recall date after `doneN` answers (null after the third). */
export function chapterRecallDueOn(quizzableSince: string, doneN: number): string | null {
  return doneN < CHAPTER_RECALL_DAYS.length ? addDaysYmd(quizzableSince, CHAPTER_RECALL_DAYS[doneN]) : null;
}
