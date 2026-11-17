/**
 * Write authority for /chat (SEC-05).
 *
 * The model reads untrusted text: journal entries, highlights, tool results, earlier turns. Telling it not to obey
 * that text (CHAT_SCOPE, WRITE_GATE) is guidance, not a boundary. The boundary is here: before any write tool runs, the
 * server checks the call against a grant computed from the conversation the user sent, BEFORE the first model call
 * and without any model. Only the user's own latest message can grant a write (plus, for a short "yes", the one write
 * offer in the assistant turn right before it, and for a quiz result, the quiz the user asked for and is answering).
 * Tool results never reach the grant, so retrieved text cannot mint or widen it.
 *
 * The latest message is read as a list of ACTIONS. An action is one thing the user asks for or reports ("log 15 mg of
 * X at 8:30", "I skipped Y"), in a clause that is not a question, a condition ("if I take…"), a plan, a hedge or quoted
 * text, with the argument-only clauses that follow it ("…and noon"). Each write call has to match one action:
 *   - the action names the call's record (product, stack, habit), with the same polarity: "I skipped X" allows the
 *     answer No for X and nothing that says X was done, "I didn't take X" / "don't log X" logs nothing for X, and a
 *     record named both ways is refused;
 *   - every argument is bound to THAT action: the amount with its unit kind exactly as lib/supplement-intake.ts reads
 *     it (servings, pills, a weight; "15 mg" never becomes 15 servings, "2 servings" never 2 capsules), the clock
 *     times, the chapters and minutes; an amount or a time the action states cannot be left out;
 *   - the day the call would write (its date, or the tool's default when it sends none) has to be the day the action
 *     names (else its list, else its sentence), or today when none is named: "yesterday" with no date is refused;
 *   - the values have the type the tool reads: a number that arrives as a string is refused, never coerced;
 *   - each action authorizes one write of each record: a repeated intake needs its own words ("…at 8 and again at 9"
 *     is one call with two times, or two actions);
 *   - a reading write goes to the book the user named, or the book being read when the user names none; naming another
 *     known book refuses a call that would write to the book being read;
 *   - text stored as the user's words (a recall note, a question, a passage, a comment) has to be a verbatim span of
 *     the user's words (case, spacing and punctuation aside), so a negation cannot be dropped or added;
 *   - a playlist only on an explicit request (never a report), a quiz result only for a quiz the user asked for and
 *     answered (score within the questions asked and answered, not already recorded) or that the user states, each at
 *     most once per request.
 * Quoted text is someone else's words and grants nothing: "double quotes" and curly quotes (also over several lines;
 * an opening quote that is never closed masks the rest), block quotes (with their continuation lines), fenced code
 * blocks and inline code. A refused call never runs; its receipt says why. Pure and import-free (types only), so it
 * runs in the node tests. No personal data.
 */
import type { WriteToolName } from "@/lib/chat-receipts";

export interface IntentMessage { role: "user" | "assistant"; content: string }

/**
 * A clause of the latest message (or the offer a "yes" accepts) that asks for or reports a write, normalized, with
 * quoted text masked out. `negated`: it says the thing was not done ("I didn't…", "skipped", "don't log…").
 * `action`: the action it belongs to (a clause naming a record and the argument-only clauses after it share one).
 * `chain`: the request or report it continues (a list is one chain). `sentence`: its masked sentence.
 */
interface IntentClause { text: string; imperative: boolean; negated: boolean; action: number; chain: number; sentence: string }

/** What the conversation says about a reading quiz. */
interface QuizState {
  /** A user message asked for a quiz ("quiz me", "give me a quiz"), not negated, not a plan. */
  requested: boolean;
  /** Questions the assistant asked since that request. */
  asked: number;
  /** User messages since that request that answer a question the assistant asked right before them. */
  answers: number;
  /** An assistant turn since that request already reported the result as recorded. */
  recorded: boolean;
  /** The latest message answers a question the assistant asked right before it, inside that quiz. */
  answering: boolean;
  /** The user's own words since the request (masked), where a book the quiz names has to appear. */
  userText: string;
}

export interface WriteGrant {
  /** Every chat write is off (CHAT_WRITES=off): chat stays read-only and capture goes through Log. */
  off: boolean;
  /** The latest user message as sent. */
  latest: string;
  /**
   * The user's own words a stored passage / recall / comment may come from: the latest message, and when it is a "yes"
   * to an offer, also the user message that offer answered.
   */
  ownWords: string;
  /** The clauses that ask for or report a write (empty: nothing was asked for). */
  clauses: IntentClause[];
  /** The latest message is a short "yes" to the one write offer the assistant made right before it. */
  confirmed: boolean;
  quiz: QuizState;
}

/** The books a reading write may go to: the one being read (its slug) and every known book. */
export interface ReadingBooks {
  active: string | null;
  list: ReadonlyArray<{ slug: string; title: string; total_chapters?: number | null }>;
}

/**
 * What this request has already been allowed: calls per tool, and the actions (each authorizes one write of each
 * record it names). Made with newWriteUsage(); the caller records every allowed call with commitWrite().
 */
export interface WriteUsage { perTool: Map<string, number>; consumed: Set<string> }

export function newWriteUsage(): WriteUsage {
  return { perTool: new Map(), consumed: new Set() };
}

export type WriteDecision =
  | { allowed: true; tool: WriteToolName; use: string | null }
  | { allowed: false; code: RefusalCode; reason: string };

/** Records an allowed call, so the action it used cannot authorize the same write again in this request. */
export function commitWrite(usage: WriteUsage, decision: WriteDecision): void {
  if (!decision.allowed) return;
  usage.perTool.set(decision.tool, (usage.perTool.get(decision.tool) ?? 0) + 1);
  if (decision.use) usage.consumed.add(decision.use);
}

export type RefusalCode =
  | "writes_off"
  | "no_request"
  | "not_named"
  | "contradicts"
  | "invalid_value"
  | "amount_not_stated"
  | "amount_omitted"
  | "time_not_stated"
  | "time_omitted"
  | "day_not_stated"
  | "not_your_words"
  | "other_book"
  | "book_unknown"
  | "already_written"
  | "playlist_not_requested"
  | "quiz_not_asked"
  | "quiz_not_answered"
  | "quiz_already_recorded"
  | "quiz_score_invalid"
  | "once_per_request";

/** Why a call was refused (shown on its receipt and to the model). At most 240 characters each. */
export const REFUSAL_TEXT: Record<RefusalCode, string> = {
  writes_off: "Logging from chat is turned off. Nothing was written; use the Log screen instead.",
  no_request: "Not written: your latest message did not ask for this. Onyx only writes what you ask for or report in your own message, never what a record, a tool result or an earlier turn says.",
  not_named: "Not written: this item is not named in your latest message. Onyx only writes the items you name yourself; say it directly to log it.",
  contradicts: "Not written: your latest message says the opposite of this (for example that you did not do it). Say it directly to record it the other way.",
  invalid_value: "Not written: a value in this call is not in the form Onyx stores (a number, a YYYY-MM-DD day, an HH:MM time). Nothing was guessed.",
  amount_not_stated: "Not written: this amount is not in your latest message with that unit. Say the amount with its unit yourself, or leave it out for one standard serving.",
  amount_omitted: "Not written: your message gives an amount for this, and the call left it out. Onyx logs the amount you said, never one serving instead.",
  time_not_stated: "Not written: this time is not in your latest message. Say the time yourself, or leave it out.",
  time_omitted: "Not written: your message gives a time for this, and the call left it out. Onyx logs the time you said, never the current time instead.",
  day_not_stated: "Not written: this would be saved on a day your latest message does not name for it. Say the day yourself, or leave it out for today.",
  not_your_words: "Not written: this text is not word for word from your latest message. Onyx stores notes, passages and comments only in your own words.",
  other_book: "Not written: your message names a different book than the one this would be saved to. Say which book directly.",
  book_unknown: "Not written: Onyx could not read your books to check which one this is for. Try again in a moment, or use the Log screen.",
  already_written: "Not written: your message asks for this once, and it was already written for this message. Say it again in your own words to log it twice.",
  playlist_not_requested: "Not created: your latest message did not ask for a playlist. Ask for one directly to create it.",
  quiz_not_asked: "Not recorded: you did not ask for a quiz in this conversation.",
  quiz_not_answered: "Not recorded: your latest message is not an answer to a quiz question. Say your score to record it.",
  quiz_already_recorded: "Not recorded: this quiz's result was already recorded. Ask for a new quiz to record another.",
  quiz_score_invalid: "Not recorded: this score does not fit the quiz questions asked and answered in this conversation.",
  once_per_request: "Not written: this can be done once per message, and it was already done for this one.",
};

/** Whether chat writes are on. Off only by explicit configuration (`CHAT_WRITES=off`), never by a missing value. */
export function chatWritesOff(env: Record<string, string | undefined>): boolean {
  return (env.CHAT_WRITES ?? "").trim().toLowerCase() === "off";
}

// ---------------------------------------------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------------------------------------------

const norm = (s: string) =>
  s.normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[‘’ʼ]/g, "'").toLowerCase();

const tokens = (s: string): string[] => norm(s).match(/[a-z0-9]+(?:'[a-z]+)?/g) ?? [];

const own = <T>(table: Record<string, T>, key: string | undefined): T | undefined =>
  key !== undefined && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;

/** Words that never identify a record. */
const STOP = new Set([
  "a", "an", "the", "my", "your", "our", "of", "for", "to", "in", "on", "at", "and", "or", "with", "by", "from", "as",
  "is", "it", "its", "this", "that", "these", "those", "i", "me", "you", "we", "be", "was", "were", "am", "are", "do",
  "did", "done", "have", "had", "has", "just", "so", "some", "any", "all", "one", "per", "mg", "mcg", "g", "iu", "ml",
  "today", "yesterday", "now", "please", "log", "logged",
  "record", "mark", "save", "add", "track", "took", "take", "taken", "yes", "no", "not", "usual", "your", "you're",
  "what", "how", "why", "when", "where", "which", "who", "if", "then", "also", "up", "out", "about", "into",
]);

/** Generic words of a record kind that never pick out one record by themselves. */
const GENERIC = new Set([
  "stack", "stacks", "supplement", "supplements", "medication", "medications", "pill", "pills", "capsule", "capsules",
  "tablet", "tablets", "scoop", "scoops", "serving", "servings", "dose", "doses", "habit", "habits", "routine",
  "book", "books",
]);

/** The words that identify a record. Single letters and numbers count ("Vitamin C", "B12", "D3"). */
const significant = (s: string) => tokens(s).filter((w) => !STOP.has(w) && !GENERIC.has(w));

/** A light stem: "meditated", "meditating", "meditation" and "meditate" share a prefix. */
function stem(w: string): string {
  const base = w.replace(/'s$/, "");
  for (const suffix of ["ation", "ing", "ed", "es", "s", "e"]) {
    if (base.length - suffix.length >= 4 && base.endsWith(suffix)) return base.slice(0, -suffix.length);
  }
  return base;
}

function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (/\d/.test(a) || /\d/.test(b)) return false;
  const sa = stem(a), sb = stem(b);
  if (sa === sb) return true;
  const [short, long] = sa.length <= sb.length ? [sa, sb] : [sb, sa];
  // A word form ("meditat" / "meditation"), not another word that starts the same ("focus" / "focusrin").
  return short.length >= 4 && long.length - short.length <= 3 && long.startsWith(short);
}

/**
 * Where `text` names `item`: the span of word positions its words were found at ([first, last]; the occurrences
 * nearest its least frequent word), or null. An action names a record once, there: two calls whose spans overlap
 * name the same words ("magnesium" and "magnesium glycinate" in "log magnesium glycinate"). A product or stack: every identifying word of it occurs in the text (the tools
 * ask for the product as the user named it, so "magnesium" names "magnesium" but not "Magnesium Citrate", and
 * "Synthetic Focus" never names "Synthetic Calm"). A habit (`loose`): at least half of its words do, because habit
 * names are long questions ("Journaled your thoughts?" from "I journaled"); every short or numeric word still has to
 * ("Vitamin D" never names "Vitamin C", "B12" never "B6").
 */
function namedSpan(item: string, text: string, loose = false): [number, number] | null {
  const want = significant(item);
  if (want.length === 0) return null;
  const have = tokens(text);
  const at = want.map((w) => have.flatMap((h, i) => (sameWord(w, h) ? [i] : [])));
  const found = want.filter((_, i) => at[i].length > 0);
  if (found.length < (loose ? Math.ceil(want.length / 2) : want.length)) return null;
  if (!want.every((w) => (w.length > 3 && !/\d/.test(w)) || found.includes(w))) return null;
  const present = at.filter((p) => p.length > 0);
  const anchor = present.reduce((a, b) => (b.length < a.length ? b : a))[0];
  const near = present.map((p) => p.reduce((a, b) => (Math.abs(b - anchor) < Math.abs(a - anchor) ? b : a)));
  return [Math.min(...near), Math.max(...near)];
}

const names = (item: string, text: string, loose = false) => namedSpan(item, text, loose) !== null;

/** Text reduced to words: case, spacing and punctuation aside. */
const flat = (s: string) => norm(s).replace(/[^a-z0-9']+/g, " ").trim();

/** `part` occurs word for word in `whole` (case, spacing and punctuation aside). */
function verbatimIn(part: string, whole: string): boolean {
  const p = flat(part);
  return p.length > 0 && ` ${flat(whole)} `.includes(` ${p} `);
}

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
  half: 0.5, a: 1, an: 1, single: 1, couple: 2, both: 2,
};

function numbersIn(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of norm(text).matchAll(/(?<![a-z\d])\d+(?:\.\d+)?/g)) out.add(Number(m[0]));
  const words = tokens(text);
  for (let i = 0; i < words.length; i++) {
    const n = own(NUMBER_WORDS, words[i]);
    if (n === undefined) continue;
    out.add(n);
    // "twenty five"
    const next = own(NUMBER_WORDS, words[i + 1]);
    if (n >= 20 && n % 10 === 0 && next !== undefined && next > 0 && next < 10) out.add(n + next);
  }
  return out;
}

// --- Amounts with their unit -----------------------------------------------------------------------------------

/** Pill-like units lib/supplement-intake.ts treats as one another (PILL_WORDS there). */
const PILL = new Set(["pill", "tablet", "tab", "capsule", "cap", "softgel", "gel", "caplet"]);

/** "Capsules" / "gummies" / "Vegetable Capsule" → "capsule" / "gummy" (countUnit in lib/supplement-intake.ts). */
function singular(word: string): string {
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  return word.endsWith("s") && word.length > 2 ? word.slice(0, -1) : word;
}

/**
 * The kind of a unit word, as lib/supplement-intake.ts dosesFor reads the unit: "serving" (no unit, serving(s),
 * dose(s): the amount is the servings), "mg" / "mcg" / "g" / "iu" (a weight or IU, converted from the label),
 * "pill" (pill, tablet, capsule, softgel…: one another, divided by the serving size), or any other count word in its
 * singular ("scoop", "gummy", "drop": only itself). undefined: not a unit word.
 */
function unitKind(word: string | undefined): string | undefined {
  if (word === undefined) return undefined;
  if (/^(?:mg|milligrams?)$/.test(word)) return "mg";
  if (/^(?:mcg|ug|micrograms?)$/.test(word)) return "mcg";
  if (/^(?:g|grams?)$/.test(word)) return "g";
  if (/^(?:iu|ius)$/.test(word)) return "iu";
  if (/^(?:ml|milliliters?|millilitres?)$/.test(word)) return "ml";
  if (/^(?:servings?|doses?)$/.test(word)) return "serving";
  const one = singular(word);
  if (PILL.has(one)) return "pill";
  if (/^(?:scoop|gummy|drop|spray|packet|chew|lozenge|unit|stick|sachet|teaspoon|tsp|tablespoon|tbsp)$/.test(one)) return one;
  return undefined;
}

/** The kind of the unit a tool call sends (dosesFor: no unit = servings; an unknown word keeps its own singular). */
function callUnit(unit: string | null): string {
  if (!unit) return "serving";
  const word = norm(unit).replace(/\([^)]*\)/g, "").trim().split(/\s+/).pop() ?? "";
  if (!word) return "serving";
  return unitKind(word) ?? singular(word);
}

/** Words after a number that make it something other than an amount (a duration, a chapter, a clock time). */
const NOT_AMOUNT_AFTER = /^(?:min|mins|minutes?|hours?|hrs?|h|days?|weeks?|months?|years?|chapters?|pages?|times?|am|pm|percent|o'clock|ago|th|st|nd|rd)$/;
/** Words before a bare number that make it a clock time, a chapter or a date. */
const NOT_AMOUNT_BEFORE = /^(?:at|around|about|by|after|before|until|till|since|from|to|chapter|chapters|ch|page|pages|jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)$/;
/** Words that end the search for the unit of a number ("2 of the magnesium capsules" looks past "of the magnesium"). */
const UNIT_SEARCH_STOP = /^(?:and|or|but|then|plus|at|with|around|by|before|after|on|yesterday|today|tonight|this|last)$/;

interface Quantity { value: number; unit: string | null }

/**
 * The amounts a text states, each with the unit said after it ("15 mg", "2 capsules", "2 magnesium capsules", "half a
 * tablet"). A number glued into a word ("B12", "D3", "5-HTP" stays "5" with no unit) is not read as a unit amount.
 */
function quantities(text: string): Quantity[] {
  const toks = norm(text).match(/[a-z]+\d[a-z\d]*|\d+(?:\.\d+)?|[a-z]+(?:'[a-z]+)?|:/g) ?? [];
  const out: Quantity[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const value = /^\d/.test(t) ? Number(t) : own(NUMBER_WORDS, t);
    if (value === undefined) continue;
    const prev = toks[i - 1], next = toks[i + 1];
    if (prev === ":" || next === ":") continue; // 8:30
    if ((next === "a" || next === "p") && toks[i + 2] === "m") continue; // 8 a.m.
    // "half a tablet"
    let j = i + 1;
    if (t === "half" && (toks[j] === "a" || toks[j] === "an")) j += 1;
    if (toks[j] !== undefined && NOT_AMOUNT_AFTER.test(toks[j])) continue;
    let unit: string | null = null;
    for (let k = j; k < Math.min(toks.length, j + 4); k++) {
      const w = toks[k];
      if (/^\d/.test(w) || w === ":" || (k > j && own(NUMBER_WORDS, w) !== undefined) || UNIT_SEARCH_STOP.test(w) || NOT_AMOUNT_AFTER.test(w)) break;
      const kind = unitKind(w);
      if (kind) { unit = kind; break; }
    }
    if (unit === null && prev !== undefined && NOT_AMOUNT_BEFORE.test(prev)) continue;
    out.push({ value, unit });
  }
  return out;
}

/**
 * `amount` of `unit` (as a tool call sends them) was stated in `text` with the same unit kind. A number said with no
 * unit is a number of servings ("I took 2 Synthetic Calm"). One serving needs no words (it is what no amount logs).
 */
function amountStated(amount: number, unit: string | null, text: string): boolean {
  const kind = callUnit(unit);
  if (amount === 1 && kind === "serving") return true;
  return quantities(text).some((q) => q.value === amount && (q.unit ?? "serving") === kind);
}

/** The text states an amount with a unit (an amount the call may not leave out). One serving said in words is none. */
const statesAmount = (text: string) => quantities(text).some((q) => q.unit !== null && !(q.unit === "serving" && q.value === 1));

// --- Clock times -----------------------------------------------------------------------------------------------

const UNIT_AFTER = /^\s*(?:mg|mcg|g|iu|ml|%|min|mins|minutes?|hours?|capsules?|tablets?|pills?|scoops?|servings?|caps?|tabs?|chapters?)\b/;

/** The clock times a text states, as "H:MM" (24 h; both readings when no am / pm was said) or "H:*" for an hour alone. */
function clockTimes(text: string): Set<string> {
  const out = new Set<string>();
  const add = (h: number, mm: string, meridiem: string | null) => {
    if (!Number.isInteger(h) || h < 0 || h > 23) return;
    if (meridiem) {
      const pm = meridiem.startsWith("p");
      if (h < 1 || h > 12) return;
      out.add(`${(h % 12) + (pm ? 12 : 0)}:${mm}`);
    } else {
      out.add(`${h}:${mm}`);
      if (h >= 1 && h < 12) out.add(`${h + 12}:${mm}`);
      if (h === 12) out.add(`0:${mm}`);
    }
  };
  const t = norm(text);
  for (const m of t.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/g)) add(Number(m[1]), m[2] ?? "*", m[3]);
  for (const m of t.matchAll(/\b(\d{1,2}):(\d{2})\b(?!\s*(?:a\.?m|p\.?m))/g)) add(Number(m[1]), m[2], null);
  for (const m of t.matchAll(/\b(?:at|around|about|by|before|after)\s+(\d{1,2})\b(?![:.]\d)/g)) {
    if (!UNIT_AFTER.test(t.slice((m.index ?? 0) + m[0].length))) add(Number(m[1]), "*", null);
  }
  for (const m of t.matchAll(/\b(\d{1,2})\s*o'clock\b/g)) add(Number(m[1]), "*", null);
  for (const m of t.matchAll(/\bhalf past (\d{1,2})\b/g)) add(Number(m[1]), "30", null);
  if (/\b(?:noon|midday)\b/.test(t)) out.add("12:*");
  if (/\bmidnight\b/.test(t)) out.add("0:*");
  return out;
}

/** A "HH:MM" time the model sends was stated: the same hour (and minutes, when they were said). */
function timeStated(time: string, clock: Set<string>): boolean {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return false;
  const h = Number(m[1]);
  return clock.has(`${h}:${m[2]}`) || clock.has(`${h}:*`);
}

// --- Days ------------------------------------------------------------------------------------------------------

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * The days a text names, resolved against the request day: "today" / "this morning" is that day, "yesterday" the day
 * before it, "Tuesday" the last Tuesday, "Nov 9" the last Nov 9 on or before it, "3 days ago" three days before it.
 */
function statedDays(text: string, requestDay: string): Set<string> {
  const out = new Set<string>();
  const base = Date.parse(`${requestDay}T12:00:00Z`);
  if (!Number.isFinite(base)) return out;
  const daysBack = (n: number) => new Date(base - n * 86_400_000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const back = (from: number, to: number, keep: (d: Date) => boolean = () => true) => {
    for (let n = from; n <= to; n++) if (keep(daysBack(n))) out.add(iso(daysBack(n)));
  };
  const ymd = (y: number, m: number, d: number): string | null => {
    const dt = new Date(Date.UTC(y, m - 1, d, 12));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? iso(dt) : null;
  };
  const year = Number(requestDay.slice(0, 4));
  const month = Number(requestDay.slice(5, 7));
  /** The month / day on or before the request day (this year, else last year). */
  const latest = (m: number, d: number) => {
    const c = ymd(year, m, d);
    const pick = c && c <= requestDay ? c : ymd(year - 1, m, d);
    if (pick) out.add(pick);
  };
  const t = norm(text);
  if (/\b(?:today|tonight|this (?:morning|afternoon|evening)|earlier today)\b/.test(t)) back(0, 0);
  if (/\b(?:yesterday|last night)\b/.test(t)) back(1, 1);
  if (/\bday before yesterday\b/.test(t)) back(2, 2);
  if (/\bthe (?:night|day) before\b/.test(t)) back(1, 2);
  for (const m of t.matchAll(/\b(\d{1,2}|[a-z]+) days? ago\b/g)) {
    const n = /^\d+$/.test(m[1]) ? Number(m[1]) : own(NUMBER_WORDS, m[1]);
    if (n !== undefined && Number.isInteger(n) && n >= 1 && n <= 60) back(n, n);
  }
  if (/\b(?:few|several) days ago\b/.test(t)) back(2, 5);
  if (/\bthe other day\b/.test(t)) back(1, 6);
  if (/\blast week\b/.test(t)) back(1, 13);
  if (/\blast weekend\b/.test(t)) back(1, 9, (d) => d.getUTCDay() === 0 || d.getUTCDay() === 6);
  WEEKDAYS.forEach((w, i) => {
    if (new RegExp(`\\b${w}\\b`).test(t)) back(1, 7, (d) => d.getUTCDay() === i);
  });
  for (const m of t.matchAll(new RegExp(`\\b${MONTH}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "g"))) latest(MONTHS.indexOf(m[1].slice(0, 3)) + 1, Number(m[2]));
  for (const m of t.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\b`, "g"))) latest(MONTHS.indexOf(m[2].slice(0, 3)) + 1, Number(m[1]));
  for (const m of t.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const d = ymd(Number(m[1]), Number(m[2]), Number(m[3]));
    if (d) out.add(d);
  }
  for (const m of t.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?\b/g)) {
    if (m[3]) {
      const y = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
      const d = ymd(y, Number(m[1]), Number(m[2]));
      if (d) out.add(d);
    } else latest(Number(m[1]), Number(m[2]));
  }
  for (const m of t.matchAll(/\bthe (\d{1,2})(?:st|nd|rd|th)\b/g)) {
    const d = Number(m[1]);
    const c = ymd(year, month, d);
    const pick = c && c <= requestDay ? c : month === 1 ? ymd(year - 1, 12, d) : ymd(year, month - 1, d);
    if (pick) out.add(pick);
  }
  return out;
}

/** The day before a YYYY-MM-DD date. */
function dayBefore(day: string): string | null {
  const t = Date.parse(`${day}T12:00:00Z`);
  return Number.isFinite(t) ? new Date(t - 86_400_000).toISOString().slice(0, 10) : null;
}

/** A real YYYY-MM-DD calendar day. */
function isDay(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = Date.parse(`${v}T12:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v;
}

// ---------------------------------------------------------------------------------------------------------------
// Quoted text
// ---------------------------------------------------------------------------------------------------------------

/**
 * The text with quoted spans masked out (same length, so positions line up). Someone else's words, never a request:
 * fenced code blocks (``` or ~~~, to the closing fence or the end), inline code, block quotes ("> …" and the lines
 * that continue them up to a blank line, as Markdown shows them), "double quotes" and curly quotes, also over
 * several lines. An opening quote or fence that is never closed masks everything after it (fail closed).
 */
function maskQuotes(text: string): string {
  const chars = text.split("");
  const blank = (from: number, to: number) => {
    for (let i = from; i < to && i < chars.length; i++) if (chars[i] !== "\n") chars[i] = " ";
  };

  // Fenced code blocks and block quotes, line by line.
  let pos = 0;
  let fence: string | null = null;
  let inQuote = false;
  for (const line of text.split("\n")) {
    const end = pos + line.length;
    const open = /^[ \t]{0,3}(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      blank(pos, end);
      // A closing fence: the same character, at least as long, nothing after it.
      const close = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
    } else if (open) {
      fence = open[1];
      blank(pos, end);
      inQuote = false;
    } else if (/^[ \t]*>/.test(line)) {
      blank(pos, end);
      inQuote = true;
    } else if (inQuote && line.trim() !== "") {
      blank(pos, end);
    } else {
      inQuote = false;
    }
    pos = end + 1;
  }

  // Inline code: a run of backticks to the next run of the same length.
  const afterBlocks = chars.join("");
  for (const m of afterBlocks.matchAll(/(`+)[\s\S]*?\1/g)) blank(m.index ?? 0, (m.index ?? 0) + m[0].length);

  // Double and curly quotes, in order, over any number of lines.
  const s = chars.join("");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    let close: number | null = null;
    if (c === '"') close = s.indexOf('"', i + 1);
    else if (c === "“") close = s.indexOf("”", i + 1);
    else if (c === "‘" && (i === 0 || /[\s([{]/.test(s[i - 1]))) {
      // An opening single quote closes at a ’ that ends a word (not the apostrophe inside "don’t").
      const rest = s.slice(i + 1);
      const m = /’(?![a-z])/i.exec(rest);
      close = m ? i + 1 + (m.index ?? 0) : -1;
    } else continue;
    const to = close === null || close < 0 ? s.length : close + 1;
    blank(i, to);
    i = to - 1;
  }
  return chars.join("");
}

// ---------------------------------------------------------------------------------------------------------------
// Sentences and clauses
// ---------------------------------------------------------------------------------------------------------------

/** [start, end, terminator] of each sentence, split on the masked text so punctuation inside quotes never splits. */
function sentenceRanges(masked: string): Array<[number, number, string]> {
  const out: Array<[number, number, string]> = [];
  let start = 0;
  for (let i = 0; i <= masked.length; i++) {
    const c = masked[i];
    if (i === masked.length || c === "." || c === "!" || c === "?" || c === "\n" || c === ";") {
      if (c === ".") {
        // A dot inside a number ("1.5 mg", "8.30") is not the end of a sentence.
        if (/\d/.test(masked[i - 1] ?? "") && /\d/.test(masked[i + 1] ?? "")) continue;
        // Nor is the first dot of "a.m." / "p.m.", nor the second unless a new sentence (a capital) starts after it.
        if (/^[ap]$/i.test(masked[i - 1] ?? "") && /^m$/i.test(masked[i + 1] ?? "") && !/[a-z]/i.test(masked[i - 2] ?? "")) continue;
        if (/^m$/i.test(masked[i - 1] ?? "") && masked[i - 2] === "." && /^[ap]$/i.test(masked[i - 3] ?? "")) {
          const rest = masked.slice(i + 1);
          if (rest.trim() !== "" && !/^\s+[A-Z]/.test(rest)) continue;
        }
      }
      if (masked.slice(start, i).trim()) out.push([start, i, c ?? ""]);
      start = i + 1;
    }
  }
  return out;
}

const WRITE_VERB = "(log|record|mark|save|add|track|enter|create|make|build|generate|highlight|start)";

const IMPERATIVE = new RegExp(
  `(?:^|\\b(?:please|pls|can you|could you|would you|will you|go ahead and|and|also|then|now|just|ok|okay|yes|so|want to|wanted to|like to)[\\s,]+)${WRITE_VERB}\\b`,
);

/** A request NOT to write: "don't log X", "do not mark Y", "no need to record Z". A negated request, never a grant. */
const NEG_IMPERATIVE = new RegExp(`^(?:please\\s+|and\\s+|but\\s+|actually[\\s,]+)*(?:don't|dont|do not|never|no need to|don't need to|dont need to)\\s+${WRITE_VERB}\\b`);

/** Verbs that report something the user did. */
const PAST =
  /^(took|had|did|didn't|didnt|read|ran|wore|ate|drank|slept|went|got|swam|rode|kept|made|put|skipped|finished|completed|listened|meditated|journaled|journalled|stretched|exercised|walked|used|wrote|studied|practiced|practised|played|lifted|trained|done|used|forgot)$/;

/** Marks a report clause as planned, uncertain or a question: never a report. */
const HYPOTHETICAL =
  /\b(if|whether|wonder|maybe|might|perhaps|probably|possibly|would|should|could|planning|plan to|going to|gonna|tomorrow|later|will|i'll|want to|wanna|thinking about|thinking of|supposed to|need to|needs to|meant to|have to|has to|did i|didn't i|have i|should i|i think|not sure|i guess)\b/;

/** Marks a request clause as a plan or a hedge ("log it tomorrow", "maybe log…"); "could you log…" is a request. */
const HEDGED_REQUEST =
  /\b(maybe|might|perhaps|probably|possibly|tomorrow|later|next time|next week|i'll|i will|planning|plan to|going to|gonna|thinking about|thinking of|not sure|wonder|whether|did i|have i|should i)\b/;

/** The whole sentence is a condition on something the user has not done: "if I take X, log it", "log it once I do". */
function conditional(s: string): boolean {
  if (/\b(?:if|unless|in case|suppose|supposing|assuming|hypothetically|imagine|provided)\b(?!\s+you\b)/.test(s)) return true;
  for (const m of s.matchAll(/\b(?:when|whenever|once|after|as soon as)\s+i\s+([a-z']+)/g)) {
    const verb = m[1];
    if (!(PAST.test(verb) || (verb.length > 4 && verb.endsWith("ed")))) return true;
  }
  return false;
}

function isReport(s: string): boolean {
  if (HYPOTHETICAL.test(s)) return false;
  const words = tokens(s);
  // "I took…", "I've just finished…", "today I meditated…"
  for (let i = 0; i < words.length; i++) {
    if (words[i] !== "i" && words[i] !== "i've" && words[i] !== "ive") continue;
    let j = i + 1;
    while (["just", "already", "also", "have", "finally", "actually", "really"].includes(words[j])) j++;
    const verb = words[j];
    if (verb && (PAST.test(verb) || (verb.length > 4 && verb.endsWith("ed")))) return true;
    if (verb === "did" && words[j + 1] === "not") return true;
  }
  // Elliptical: "Finished chapters 3 and 4", "Took my evening stack".
  const first = words[0];
  return !!first && first !== "did" && PAST.test(first);
}

/** Words that say something was not done. An even count cancels out ("I didn't skip it"). */
const NEGATION =
  /\b(?:not|no|never|none|nothing|didn't|didnt|don't|dont|doesn't|haven't|havent|hasn't|hadn't|wasn't|weren't|won't|wont|isn't|aren't|can't|cannot|couldn't|skipped|skip|skipping|forgot|forget|missed|miss|without|neither|nor|except|excluding|minus)\b/g;
/** Phrases with "no" that do not say anything was not done. */
const NOT_NEGATION = /\bno (?:rush|worries|problem|problems|hurry|biggie|pressure)\b/g;
const negated = (s: string) => (s.replace(NOT_NEGATION, " ").match(NEGATION)?.length ?? 0) % 2 === 1;

/** A clause that starts its own statement (a subject, a question word, another command): it does not continue a list. */
const OWN_START =
  /^(?:i|i'm|im|i've|ive|i'd|i'll|it|it's|its|that|this|these|those|he|she|they|we|you|there|here|what|how|why|when|where|who|which|is|was|are|were|will|would|could|should|can|do|does|did|has|have|had|let's|lets|tell|show|explain|give|help|find|check|compare|summarize|list|remind|thanks|thank)\b/;

/** A verb: a clause that has one says something of its own ("the Synthetic Focus was great"), it is not a list item. */
const HAS_VERB =
  /\b(?:is|was|were|are|be|been|being|has|have|had|does|did|do|feel|feels|felt|seem|seems|seemed|help|helps|helped|work|works|worked|make|makes|made|say|says|said|go|goes|went|get|gets|got|need|needs|want|wants|like|likes|think|thinks|know|knows)\b/;

/** A fragment that excludes something from the list before it: "Not Synthetic Focus though." */
const EXCLUDES = /^(?:not|except|excluding|minus|without|but not)\b/;

/** Clause boundaries inside a sentence: commas, a colon (not in "8:30"), "and", "but", "then", "plus". */
const CLAUSE_SEP = /(\s*,\s*|\s*:\s*|\s+(?:and|but|then|plus)\s+)/;

/** Words that only carry an argument (a time, a day, an amount, a chapter), never a record. */
const ARGUMENT_WORD =
  /^(?:\d+(?:\.\d+)?|\d+(?:st|nd|rd|th)|am|pm|a|p|m|noon|midday|midnight|o'clock|half|past|quarter|at|around|about|by|before|after|on|the|this|last|of|ago|again|too|yesterday|today|tonight|morning|afternoon|evening|night|day|days|week|weeks|weekend|for|min|mins|minutes?|hours?|hrs?|chapters?|ch|pages?|through|thru|to|and|or|st|nd|rd|th|another|more|each|other|earlier|later)$/;

/** The clause only carries arguments of the action before it ("…and noon", "…and 4", "40 minutes"). */
function argumentOnly(clause: string): boolean {
  return tokens(clause).every((w) =>
    ARGUMENT_WORD.test(w) || STOP.has(w) || own(NUMBER_WORDS, w) !== undefined || unitKind(w) !== undefined
    || WEEKDAYS.includes(w) || MONTHS.some((m) => w.startsWith(m)));
}

/**
 * The clauses of `text` that ask for or report a write, each with its action and chain. A clause that asks for or
 * reports something starts an action and a chain. A clause with no verb of its own after it continues the chain
 * ("…and Synthetic Calm", the next line of a list), keeping its kind and polarity: it starts a new action when it
 * names something, and joins the action before it when it only carries arguments ("…and noon"; dropped when its
 * polarity differs: "at 8, not at 9"). A clause with a verb of its own ends the chain. A sentence that is a condition
 * grants nothing; a clause that is a plan or a hedge grants nothing and ends the list; after a colon a request cannot
 * start ("Here is my journal: log X" is a pasted record), only continue one.
 */
function intentClauses(text: string): IntentClause[] {
  const masked = maskQuotes(text);
  const out: IntentClause[] = [];
  type Chain = { imperative: boolean; negated: boolean; id: number; actionNegated: boolean };
  let chain: Chain | null = null;
  let lastChain: Chain | null = null;
  let action = -1;
  let chains = -1;
  for (const [start, end, term] of sentenceRanges(masked)) {
    const sentence = norm(masked.slice(start, end)).replace(/(\d):(\d)/g, "$1\u0001$2");
    const sentenceText = sentence.replace(/\u0001/g, ":");
    if (conditional(sentence)) { chain = null; lastChain = null; continue; }
    let afterColon = false;
    const parts = sentence.split(CLAUSE_SEP);
    for (let k = 0; k < parts.length; k++) {
      if (k % 2 === 1) { if (parts[k].includes(":")) afterColon = true; continue; }
      const clause = parts[k].replace(/\u0001/g, ":").replace(/^[\s,:;\-–—*•]+/, "").trim();
      if (!clause) continue;
      const negRequest = !afterColon && NEG_IMPERATIVE.test(clause);
      const imperative = negRequest || (!afterColon && IMPERATIVE.test(clause));
      // A report phrased as a question ("I had two coffees, is that why…?") is a question, not a logging request.
      const report = !imperative && term !== "?" && isReport(clause);
      if (imperative || report) {
        if (imperative && !negRequest && HEDGED_REQUEST.test(clause)) { chain = null; continue; }
        const neg = negRequest || negated(clause);
        chain = { imperative, negated: neg, id: ++chains, actionNegated: neg };
        out.push({ text: clause, imperative, negated: neg, action: ++action, chain: chain.id, sentence: sentenceText });
        continue;
      }
      // "Not Synthetic Focus though." after a list in the sentence before it.
      const base: Chain | null = chain ?? (k === 0 && lastChain && EXCLUDES.test(clause) ? lastChain : null);
      if (base && !OWN_START.test(clause) && !HYPOTHETICAL.test(clause) && !HAS_VERB.test(clause)) {
        chain = base;
        const neg = base.negated || negated(clause);
        if (argumentOnly(clause)) {
          if (neg === base.actionNegated && action >= 0) out.push({ text: clause, imperative: base.imperative, negated: neg, action, chain: base.id, sentence: sentenceText });
        } else {
          base.actionNegated = neg;
          out.push({ text: clause, imperative: base.imperative, negated: neg, action: ++action, chain: base.id, sentence: sentenceText });
        }
      } else {
        chain = null;
      }
    }
    // A list may go on over lines ("Log:" then one item per line); a sentence end closes it.
    lastChain = chain;
    if (term !== "\n") chain = null;
  }
  return out;
}

/** A short "yes" (thanks alone is not one): an affirmative first, then more affirmatives or thanks. */
const CONFIRMATION =
  /^(?:yes|yeah|yep|yup|sure|ok|okay|please do|please|do it|go ahead|go for it|sounds good|correct|that's right|confirmed?|log it|save it|create it|make it|record it|mark it|add it|do that)(?:[\s,.!]+(?:yes|yeah|yep|yup|sure|ok|okay|please do|please|do it|go ahead|go for it|sounds good|correct|that's right|confirmed?|log it|save it|create it|make it|record it|mark it|add it|do that|thanks|thank you|perfect|great|that one))*[\s,.!]*$/;

/** A question offering to write something: "Want me to log…?", "Should I create a playlist?". */
const WRITE_OFFER =
  /\b(?:want me to|shall i|should i|would you like me to|do you want me to|like me to|can i|may i|ok(?:ay)? if i|go ahead and)\b.*\b(?:log|record|mark|save|add|track|enter|create|make|build|generate|highlight)\b/;

/**
 * What a "yes" accepts: the assistant turn right before it has to ask exactly one question, and that question has to
 * offer a write. Any other question ("Want a summary?") or two questions at once accept nothing. The offer is one
 * action: it authorizes what it says, once.
 */
function acceptedOffer(text: string): IntentClause | null {
  const masked = maskQuotes(text);
  const questions = sentenceRanges(masked).filter(([, , term]) => term === "?");
  if (questions.length !== 1) return null;
  const [start, end] = questions[0];
  const offer = norm(masked.slice(start, end));
  if (!WRITE_OFFER.test(offer) || conditional(offer)) return null;
  return { text: offer, imperative: true, negated: negated(offer), action: 0, chain: 0, sentence: offer };
}

// --- Quiz ------------------------------------------------------------------------------------------------------

/** "Quiz me", "test me", "give me a quiz", "let's do a checkpoint quiz". */
const QUIZ_REQUEST = /\b(?:quiz|test) me\b|\b(?:give|run|start|do|begin|ask)\b[^.?!\n]*\bquiz\b|\bquiz time\b/;

const asksQuestion = (m: IntentMessage | undefined) =>
  m?.role === "assistant" && sentenceRanges(maskQuotes(m.content)).some(([, , term]) => term === "?");

function quizState(messages: ReadonlyArray<IntentMessage>): QuizState {
  let request = -1;
  for (let i = messages.length - 1; i >= 0 && request < 0; i--) {
    if (messages[i].role !== "user") continue;
    const masked = maskQuotes(messages[i].content);
    for (const [start, end] of sentenceRanges(masked)) {
      const s = norm(masked.slice(start, end));
      if (QUIZ_REQUEST.test(s) && !negated(s) && !HEDGED_REQUEST.test(s) && !conditional(s)) { request = i; break; }
    }
  }
  if (request < 0) return { requested: false, asked: 0, answers: 0, recorded: false, answering: false, userText: "" };
  let asked = 0;
  let answers = 0;
  let recorded = false;
  const userText: string[] = [];
  for (let i = request; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "user") {
      userText.push(maskQuotes(m.content));
      if (i > request && asksQuestion(messages[i - 1])) answers++;
      continue;
    }
    asked += sentenceRanges(maskQuotes(m.content)).filter(([, , term]) => term === "?").length;
    const t = norm(m.content);
    if (/\b(?:recorded|saved|logged)\b/.test(t) && /\b(?:quiz|score|checkpoint)\b/.test(t)) recorded = true;
  }
  const n = messages.length;
  const answering = n - 2 > request && messages[n - 1]?.role === "user" && asksQuestion(messages[n - 2]);
  return { requested: true, asked, answers, recorded, answering, userText: userText.join("\n") };
}

// ---------------------------------------------------------------------------------------------------------------
// The grant
// ---------------------------------------------------------------------------------------------------------------

/**
 * The write grant of one request, from the conversation the user sent and nothing else (no tool result, no record).
 * Deterministic, so a retry of the same message gets the same grant.
 */
export function writeGrantFor(messages: ReadonlyArray<IntentMessage>, opts: { off?: boolean } = {}): WriteGrant {
  const latest = messages.length > 0 && messages[messages.length - 1].role === "user" ? messages[messages.length - 1].content : "";
  const previous = messages.length > 1 && messages[messages.length - 2].role === "assistant" ? messages[messages.length - 2].content : "";
  const short = norm(maskQuotes(latest)).trim();
  const offer = previous && short.length > 0 && short.length <= 48 && CONFIRMATION.test(short) ? acceptedOffer(previous) : null;
  const confirmed = offer !== null;
  const answered = confirmed && messages.length > 2 && messages[messages.length - 3].role === "user" ? messages[messages.length - 3].content : "";
  return {
    off: opts.off === true,
    latest,
    ownWords: answered ? `${answered}\n${latest}` : latest,
    clauses: offer ? [offer] : latest ? intentClauses(latest) : [],
    confirmed,
    quiz: quizState(messages),
  };
}

/** One action of the grant: its clauses' text, the text of its chain (same polarity) and of its sentences. */
interface Action { id: number; chain: number; negated: boolean; imperative: boolean; text: string; chainText: string; sentence: string }

function actionsOf(grant: WriteGrant): Action[] {
  const byId = new Map<number, IntentClause[]>();
  for (const c of grant.clauses) byId.set(c.action, [...(byId.get(c.action) ?? []), c]);
  return [...byId.entries()].map(([id, cs]) => {
    const first = cs[0];
    return {
      id,
      chain: first.chain,
      negated: first.negated,
      imperative: first.imperative,
      text: cs.map((c) => c.text).join("\n"),
      chainText: grant.clauses.filter((c) => c.chain === first.chain && c.negated === first.negated).map((c) => c.text).join("\n"),
      sentence: [...new Set(grant.clauses.filter((c) => c.chain === first.chain).map((c) => c.sentence))].join("\n"),
    };
  });
}

const deny = (code: RefusalCode): WriteDecision => ({ allowed: false, code, reason: REFUSAL_TEXT[code] });
const allow = (tool: WriteToolName, use: string | null): WriteDecision => ({ allowed: true, tool, use });

const READING = /\b(read|reading|listened|listening|chapters?|book|audiobook|session|pages?)\b/;
const FINISHED_BOOK = /\b(finished|completed|done with)\b[^.!?\n]*\bbook\b/;
const HIGHLIGHT = /\b(highlight|quote|passage|line|excerpt|save|keep|note)\b/;
const PLAYLIST_VERB = /\b(create|make|build|generate|save|start|put together|turn)\b/;
const QUIZ_WORD = /\b(quiz|score|checkpoint)\b/;

/** A present value that is not a string (a field the tool reads as text). */
const notText = (v: unknown) => v !== undefined && v !== null && typeof v !== "string";
/** A present value that is not a finite number (a field the tool reads with Number(), which would coerce a string). */
const notNumber = (v: unknown) => v !== undefined && v !== null && !(typeof v === "number" && Number.isFinite(v));
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * The days an action allows: the days it names, else the days its list names, else its sentence's, else none (the
 * caller's default: today, or last night for a sleep question).
 */
function allowedDays(a: Action, requestDay: string): Set<string> {
  for (const text of [a.text, a.chainText, a.sentence]) {
    const days = statedDays(text, requestDay);
    if (days.size > 0) return days;
  }
  return new Set();
}

/** Whether `book` is named in `text`, and how specifically (the number of its identifying words; 0 = not named). */
function bookNamed(book: { slug: string; title: string }, text: string): number {
  const best = (s: string) => (names(s, text) ? significant(s).length : 0);
  return Math.max(best(book.title), best(book.slug.replace(/[-_]+/g, " ")));
}

/**
 * The book check of a reading write: the book the call would write to (the one it names, else the one being read) has
 * to be the one the user means. A call that names a book other than the one being read needs the user to name it;
 * a user who names another known book (more specifically than the one written to) refuses the call.
 */
function bookCheck(input: Record<string, unknown>, text: string, books: ReadingBooks | null | undefined): RefusalCode | null {
  if (!books) return "book_unknown";
  const named = str(input.book);
  const effective = named ?? books.active;
  const known = books.list.find((b) => b.slug === effective);
  if (named && named !== books.active && !(known ? bookNamed(known, text) > 0 : names(named.replace(/[-_]+/g, " "), text))) return "not_named";
  const mentions = books.list.map((b) => ({ slug: b.slug, score: bookNamed(b, text) })).filter((b) => b.score > 0);
  if (mentions.length === 0) return null;
  const top = Math.max(...mentions.map((b) => b.score));
  return mentions.some((b) => b.slug === effective && b.score === top) ? null : "other_book";
}

/**
 * Whether one write-tool call may run. `used` is what this request was already allowed (commitWrite records each
 * allowed call); `requestDay` is the behavioral day the request runs on; `books` the books a reading write may go to
 * (null when they could not be read: reading writes are refused); `isSleepHabit` says which habits are sleep
 * questions (stored on last night when no date is sent).
 */
export function authorizeWrite(
  grant: WriteGrant,
  tool: WriteToolName,
  input: Record<string, unknown>,
  ctx: { requestDay: string; used: WriteUsage; books?: ReadingBooks | null; isSleepHabit?: (habit: string) => boolean },
): WriteDecision {
  if (grant.off) return deny("writes_off");
  const actions = actionsOf(grant);
  const done = actions.filter((a) => !a.negated);
  const notDone = actions.filter((a) => a.negated);
  const fresh = (key: string) => !ctx.used.consumed.has(key);

  // Values the tool reads: a date has to be a real day, numbers numbers, text text. Nothing is coerced.
  if (notText(input.date) || (typeof input.date === "string" && input.date.trim() && !isDay(input.date.trim()))) return deny("invalid_value");

  // A quiz result: either the user states it ("I got 4 out of 5 on the quiz"), or it closes a quiz the user asked
  // for and answered, with no more questions than were asked and answered, and not recorded already.
  if (tool === "record_reading_quiz") {
    if (notNumber(input.score) || notNumber(input.total) || notText(input.book)) return deny("invalid_value");
    const score = num(input.score), total = num(input.total);
    if (score == null || total == null || !Number.isInteger(score) || !Number.isInteger(total) || total < 1 || score < 0 || score > total) {
      return deny("quiz_score_invalid");
    }
    if ((ctx.used.perTool.get(tool) ?? 0) >= 1) return deny("once_per_request");
    const stated = done.find((a) => QUIZ_WORD.test(a.text) && numbersIn(a.text).has(score) && numbersIn(a.text).has(total));
    if (!stated) {
      const q = grant.quiz;
      if (!q.requested) return deny("quiz_not_asked");
      if (q.recorded) return deny("quiz_already_recorded");
      if (!q.answering) return deny("quiz_not_answered");
      if (total > q.asked || total > q.answers) return deny("quiz_score_invalid");
    }
    const bad = bookCheck(input, stated ? stated.text : grant.quiz.userText, ctx.books);
    if (bad) return deny(bad);
    return allow(tool, null);
  }

  if (actions.length === 0) return deny("no_request");

  if (tool === "create_spotify_playlist") {
    const asked = done.filter((a) => a.imperative).map((a) => a.text).join("\n");
    if (!/\bplaylists?\b/.test(asked) || !PLAYLIST_VERB.test(asked)) return deny("playlist_not_requested");
    if ((ctx.used.perTool.get(tool) ?? 0) >= 1) return deny("once_per_request");
    return allow(tool, null);
  }

  if (tool === "add_book_highlight") {
    if (notText(input.passage) || notText(input.comment) || notNumber(input.chapter) || notText(input.book)) return deny("invalid_value");
    const asked = done.filter((a) => HIGHLIGHT.test(a.text));
    if (asked.length === 0) return deny("no_request");
    const passage = str(input.passage);
    if (!passage || significant(passage).length === 0 || !verbatimIn(passage, grant.ownWords)) return deny("not_your_words");
    const comment = str(input.comment);
    if (comment && !verbatimIn(comment, grant.ownWords)) return deny("not_your_words");
    const chapter = num(input.chapter);
    if (chapter != null && !asked.some((a) => numbersIn(a.chainText).has(chapter))) return deny("not_named");
    const bad = bookCheck(input, asked.map((a) => a.sentence).join("\n"), ctx.books);
    if (bad) return deny(bad);
    const key = `${tool}|${flat(passage)}`;
    return fresh(key) ? allow(tool, key) : deny("already_written");
  }

  if (tool === "log_reading_session") {
    for (const field of ["chapter_through", "chapter_from", "minutes"]) if (notNumber(input[field])) return deny("invalid_value");
    for (const field of ["recall", "question", "medium", "book"]) if (notText(input[field])) return deny("invalid_value");
    const chains = [...new Map(done.filter((a) => READING.test(a.chainText) || FINISHED_BOOK.test(a.chainText)).map((a) => [a.chain, a])).values()];
    if (chains.length === 0) return deny(notDone.some((a) => READING.test(a.chainText)) ? "contradicts" : "no_request");
    let refusal: RefusalCode = "not_named";
    for (const a of chains) {
      const r = readingSessionFits(a, input, grant, ctx);
      if (r) { refusal = r; continue; }
      const key = `${tool}|c${a.chain}`;
      if (!fresh(key)) { refusal = "already_written"; continue; }
      return allow(tool, key);
    }
    return deny(refusal);
  }

  // A record named by an action: a habit, a stack or a product.
  let record: string | null;
  let loose = false;
  let answerNo = false;
  if (tool === "mark_habit_complete") {
    if (notText(input.habit) || notText(input.answer) || notText(input.category)) return deny("invalid_value");
    record = str(input.habit);
    loose = true;
    // lib route: any answer that is not "no" (case aside) is stored as Yes.
    answerNo = typeof input.answer === "string" && input.answer.toLowerCase() === "no";
  } else if (tool === "log_supplement_stack") {
    if (notText(input.stack)) return deny("invalid_value");
    record = str(input.stack);
  } else if (tool === "log_supplement_intake") {
    if (notText(input.product) || notNumber(input.amount) || notText(input.unit)) return deny("invalid_value");
    if (input.times !== undefined && input.times !== null && !(Array.isArray(input.times) && input.times.every((t) => typeof t === "string"))) return deny("invalid_value");
    const amount = num(input.amount);
    if (amount != null && amount <= 0) return deny("invalid_value");
    record = str(input.product);
  } else {
    // A write tool added without a rule here is refused, never allowed by default.
    return deny("no_request");
  }
  if (!record) return deny("not_named");

  // "my stack" with no name names a stack only when the stack has no other words.
  const span = (a: Action): [number, number] | null => {
    if (tool === "log_supplement_stack" && significant(record!).length === 0) {
      const i = tokens(a.text).indexOf("stack");
      return i >= 0 ? [i, i] : null;
    }
    return namedSpan(record!, a.text, loose);
  };
  // "I skipped X" / "mark X as not done" is a No for X, never a Yes; "I did X" is a Yes, never a No. A record named
  // both ways ("log X… actually don't log X") is refused.
  const [same, opposite] = answerNo ? [notDone, done] : [done, notDone];
  const candidates = same.filter((a) => span(a) !== null);
  if (opposite.some((a) => span(a) !== null)) return deny("contradicts");
  if (candidates.length === 0) return deny("not_named");

  let refusal: RefusalCode = "not_named";
  for (const a of candidates) {
    const r = argumentsFit(tool, a, input, record, ctx);
    if (r) { refusal = r; continue; }
    const [from, to] = span(a)!;
    const prefix = `${tool}|a${a.id}|`;
    // The words this call names were already used by an allowed call of this action: the same record again.
    const taken = [...ctx.used.consumed].some((k) => {
      if (!k.startsWith(prefix)) return false;
      const [f, t] = k.slice(prefix.length).split("-").map(Number);
      return f <= to && from <= t;
    });
    if (taken) { refusal = "already_written"; continue; }
    return allow(tool, `${prefix}${from}-${to}`);
  }
  return deny(refusal);
}

/** The day a call writes, when it sends none: today, or last night for a sleep question (lib/checkin sleepAnswerDate). */
function effectiveDay(tool: WriteToolName, input: Record<string, unknown>, record: string, ctx: { requestDay: string; isSleepHabit?: (habit: string) => boolean }): string {
  const date = str(input.date);
  if (date) return date;
  if (tool === "mark_habit_complete" && ctx.isSleepHabit?.(record)) return dayBefore(ctx.requestDay) ?? ctx.requestDay;
  return ctx.requestDay;
}

/** The day check: the day the call writes is one the action names, or the default day when it names none. */
function dayFits(day: string, a: Action, tool: WriteToolName, record: string, ctx: { requestDay: string; isSleepHabit?: (habit: string) => boolean }): boolean {
  const days = allowedDays(a, ctx.requestDay);
  if (days.size > 0) return days.has(day);
  // No day named: today, or last night for a sleep question (it describes the night that closed yesterday).
  if (day === ctx.requestDay) return true;
  return tool === "mark_habit_complete" && !!ctx.isSleepHabit?.(record) && day === dayBefore(ctx.requestDay);
}

/** Whether the call's arguments are the ones action `a` states (null) or why not. */
function argumentsFit(
  tool: WriteToolName,
  a: Action,
  input: Record<string, unknown>,
  record: string,
  ctx: { requestDay: string; isSleepHabit?: (habit: string) => boolean },
): RefusalCode | null {
  if (!dayFits(effectiveDay(tool, input, record, ctx), a, tool, record, ctx)) return "day_not_stated";
  if (tool !== "log_supplement_intake") return null;

  // The amount, in the unit kind the intake would be counted in, stated in this action (never another item's).
  const amount = num(input.amount);
  if (amount != null && !amountStated(amount, str(input.unit), a.text)) return "amount_not_stated";
  if (amount == null && statesAmount(a.text)) return "amount_omitted";

  // The times: stated in this action, or, when it states none, in its list ("Log X and Y at 9pm").
  const stated = clockTimes(a.text);
  const clock = stated.size > 0 ? stated : clockTimes(a.chainText);
  const times = Array.isArray(input.times) ? (input.times as string[]) : [];
  for (const t of times) if (!timeStated(t, clock)) return "time_not_stated";
  if (times.length === 0 && stated.size > 0) return "time_omitted";
  return null;
}

/** Whether a reading session call fits reading action `a` (its list): chapters, minutes, day, book, the user's words. */
function readingSessionFits(
  a: Action,
  input: Record<string, unknown>,
  grant: WriteGrant,
  ctx: { requestDay: string; books?: ReadingBooks | null },
): RefusalCode | null {
  const text = a.chainText;
  const book = bookCheck(input, a.sentence, ctx.books);
  if (book) return book;
  const numbers = numbersIn(text);
  const through = num(input.chapter_through);
  const finished = FINISHED_BOOK.test(text);
  if (through == null) return "not_named";
  if (!numbers.has(through)) {
    // "I finished the book": the last chapter of the book written to, when it is known.
    const slug = str(input.book) ?? ctx.books?.active ?? null;
    const total = ctx.books?.list.find((b) => b.slug === slug)?.total_chapters;
    if (!finished || total == null || through !== total) return "not_named";
  }
  const from = num(input.chapter_from);
  if (from != null && from !== through && !numbers.has(from)) return "not_named";
  const minutes = num(input.minutes);
  if (minutes != null && !numbers.has(minutes) && !numbers.has(minutes / 60)) return "amount_not_stated";
  const day = str(input.date) ?? ctx.requestDay;
  const days = allowedDays(a, ctx.requestDay);
  if (days.size > 0 ? !days.has(day) : day !== ctx.requestDay) return "day_not_stated";
  for (const field of ["recall", "question"]) {
    const words = str(input[field]);
    if (words && !verbatimIn(words, grant.ownWords)) return "not_your_words";
  }
  return null;
}
