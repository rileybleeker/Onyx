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
 * A grant is bound to the capability (which write tool, which record) and to the request:
 *   - the latest message has to ask for a write ("log…", "mark…", "save…", "create…") or report one ("I took…",
 *     "I meditated", "finished chapter 4") in a clause that is not a question, a condition ("if I take…"), a plan or a
 *     hedge, and not quoted text (quoted text grants nothing, also inside an accepted sentence);
 *   - the record the call writes has to be named in such a clause, with the same polarity: "I skipped X" allows the
 *     answer No for X and nothing that says X was done, "I didn't take X" logs nothing for X;
 *   - an amount has to be stated with its unit ("15 mg" never becomes 15 servings), a clock time and another day have
 *     to be stated (the day is resolved against the request's day: "yesterday" allows yesterday, not any date);
 *   - a book the call names has to be named by the user, or be the book being read;
 *   - text stored as the user's words (a recall note, a question, a passage, a comment) has to be a verbatim span of
 *     the user's words (case, spacing and punctuation aside), so a negation cannot be dropped or added;
 *   - a playlist only on an explicit request (never a report), a quiz result only for a quiz the user asked for and is
 *     answering (score within the questions asked, not already recorded) or that the user states, each at most once
 *     per request.
 * A refused call never runs; its receipt says why. Pure and import-free (types only), so it runs in the node tests.
 * No personal data.
 */
import type { WriteToolName } from "@/lib/chat-receipts";

export interface IntentMessage { role: "user" | "assistant"; content: string }

/**
 * A clause of the latest message (or the offer a "yes" accepts) that asks for or reports a write, normalized, with
 * quoted text masked out. `negated`: it says the thing was not done ("I didn't…", "skipped", "not done").
 */
interface IntentClause { text: string; imperative: boolean; negated: boolean }

/** What the conversation says about a reading quiz. */
interface QuizState {
  /** A user message asked for a quiz ("quiz me", "give me a quiz"), not negated, not a plan. */
  requested: boolean;
  /** Questions the assistant asked since that request. */
  asked: number;
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

export type WriteDecision = { allowed: true } | { allowed: false; code: RefusalCode; reason: string };

export type RefusalCode =
  | "writes_off"
  | "no_request"
  | "not_named"
  | "contradicts"
  | "amount_not_stated"
  | "time_not_stated"
  | "day_not_stated"
  | "not_your_words"
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
  amount_not_stated: "Not written: this amount is not in your latest message. Say the amount with its unit yourself, or leave it out for one standard serving.",
  time_not_stated: "Not written: this time is not in your latest message. Say the time yourself, or leave it out.",
  day_not_stated: "Not written: your latest message does not name this day. Say the day yourself to log it there.",
  not_your_words: "Not written: this text is not word for word from your latest message. Onyx stores notes, passages and comments only in your own words.",
  playlist_not_requested: "Not created: your latest message did not ask for a playlist. Ask for one directly to create it.",
  quiz_not_asked: "Not recorded: you did not ask for a quiz in this conversation.",
  quiz_not_answered: "Not recorded: your latest message is not an answer to a quiz question. Say your score to record it.",
  quiz_already_recorded: "Not recorded: this quiz's result was already recorded. Ask for a new quiz to record another.",
  quiz_score_invalid: "Not recorded: this score does not fit the quiz questions asked in this conversation.",
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
  s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[\u2018\u2019\u02bc]/g, "'").toLowerCase();

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
 * `text` names `item`. A product or stack: every identifying word of it occurs in the text (the tools ask for the
 * product as the user named it, so "magnesium" names "magnesium" but not "Magnesium Citrate", and "Synthetic Focus"
 * never names "Synthetic Calm"). A habit (`loose`): at least half of its words do, because habit names are long
 * questions ("Journaled your thoughts?" from "I journaled"); every short or numeric word still has to ("Vitamin D"
 * never names "Vitamin C", "B12" never "B6").
 */
function names(item: string, text: string, loose = false): boolean {
  const want = significant(item);
  if (want.length === 0) return false;
  const have = tokens(text);
  const found = want.filter((w) => have.some((h) => sameWord(w, h)));
  if (found.length < (loose ? Math.ceil(want.length / 2) : want.length)) return false;
  return want.every((w) => (w.length > 3 && !/\d/.test(w)) || found.includes(w));
}

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
  for (const m of norm(text).matchAll(/\d+(?:\.\d+)?/g)) out.add(Number(m[0]));
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

/** A unit word → its kind ("mg", "mcg", "g", "iu", "ml" or "count"); undefined for a word that is not a unit. */
function knownUnit(word: string | undefined): string | undefined {
  if (word === undefined) return undefined;
  if (/^(?:mg|milligrams?)$/.test(word)) return "mg";
  if (/^(?:mcg|ug|micrograms?)$/.test(word)) return "mcg";
  if (/^(?:g|grams?)$/.test(word)) return "g";
  if (/^(?:iu|ius)$/.test(word)) return "iu";
  if (/^(?:ml|milliliters?|millilitres?)$/.test(word)) return "ml";
  if (/^(?:capsules?|caps?|tablets?|tabs?|pills?|scoops?|servings?|softgels?|gummies|gummy|drops?|sprays?|packets?|chews?|doses?|lozenges?|units?)$/.test(word)) return "count";
  return undefined;
}

/** The kind of the unit a tool call sends (unknown units keep their own word; no unit = servings). */
const callUnit = (unit: string | null): string => {
  if (!unit) return "count";
  const word = flat(unit).split(" ").pop() ?? "";
  return knownUnit(word) ?? word;
};

/** Words after a number that make it something other than an amount (a duration, a chapter, a clock time). */
const NOT_AMOUNT_AFTER = /^(?:min|mins|minutes?|hours?|hrs?|h|days?|weeks?|months?|years?|chapters?|pages?|times?|am|pm|percent|o'clock|ago|th|st|nd|rd)$/;
/** Words before a bare number that make it a clock time, a chapter or a date. */
const NOT_AMOUNT_BEFORE = /^(?:at|around|about|by|after|before|until|till|since|from|to|chapter|chapters|ch|page|pages|jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)$/;

interface Quantity { value: number; unit: string | null; word: string | undefined }

/** The amounts a text states, each with the unit said right after it ("15 mg", "2 capsules", "half a tablet"). */
function quantities(text: string): Quantity[] {
  const toks = norm(text).match(/\d+(?:\.\d+)?|[a-z]+(?:'[a-z]+)?|:/g) ?? [];
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
    const word = toks[j];
    if (word !== undefined && NOT_AMOUNT_AFTER.test(word)) continue;
    const unit = knownUnit(word) ?? null;
    if (unit === null && prev !== undefined && NOT_AMOUNT_BEFORE.test(prev)) continue;
    out.push({ value, unit, word: word !== undefined && !/^\d/.test(word) ? word : undefined });
  }
  return out;
}

/** `amount` of `unit` (as a tool call sends them) was stated in `text`. One standard serving needs no words. */
function amountStated(amount: number, unit: string | null, text: string): boolean {
  const kind = callUnit(unit);
  if (amount === 1 && kind === "count") return true;
  return quantities(text).some((q) =>
    q.value === amount && (q.unit === kind || (q.unit === null && (kind === "count" || (q.word !== undefined && sameWord(q.word, kind))))));
}

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
 * The days other than the request day a text names, resolved against that day: "yesterday" is the day before it,
 * "Tuesday" the last Tuesday, "Nov 9" the last Nov 9 on or before it, "3 days ago" three days before it.
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
  out.delete(requestDay);
  return out;
}

/** The day before a YYYY-MM-DD date. */
function dayBefore(day: string): string | null {
  const t = Date.parse(`${day}T12:00:00Z`);
  return Number.isFinite(t) ? new Date(t - 86_400_000).toISOString().slice(0, 10) : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Sentences and clauses
// ---------------------------------------------------------------------------------------------------------------

/**
 * The text with quoted spans masked out (same length, so positions line up): "double quotes", curly quotes and
 * lines starting with ">" are someone else's words (a quote, a pasted record), never a request.
 */
function maskQuotes(text: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  return text
    .replace(/^[ \t]*>.*$/gm, blank)
    .replace(/"[^"\n]*"/g, blank)
    .replace(/\u201c[^\u201d\n]*\u201d/g, blank)
    .replace(/\u2018[^\u2019\n]{3,}\u2019/g, blank);
}

/** [start, end, terminator] of each sentence, split on the masked text so punctuation inside quotes never splits. */
function sentenceRanges(masked: string): Array<[number, number, string]> {
  const out: Array<[number, number, string]> = [];
  let start = 0;
  for (let i = 0; i <= masked.length; i++) {
    const c = masked[i];
    if (i === masked.length || c === "." || c === "!" || c === "?" || c === "\n" || c === ";") {
      // A dot inside a number ("1.5 mg", "8.30") is not the end of a sentence.
      if (c === "." && /\d/.test(masked[i - 1] ?? "") && /\d/.test(masked[i + 1] ?? "")) continue;
      if (masked.slice(start, i).trim()) out.push([start, i, c ?? ""]);
      start = i + 1;
    }
  }
  return out;
}

const IMPERATIVE =
  /(?:^|\b(?:please|pls|can you|could you|would you|will you|go ahead and|and|also|then|now|just|ok|okay|yes|so|want to|wanted to|like to)[\s,]+)(log|record|mark|save|add|track|enter|create|make|build|generate|highlight|start)\b/;

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
  /\b(?:not|no|never|none|nothing|didn't|didnt|don't|dont|doesn't|haven't|havent|hasn't|hadn't|wasn't|weren't|won't|wont|isn't|aren't|can't|cannot|couldn't|skipped|skip|skipping|forgot|forget|missed|miss|without|neither|nor)\b/g;
/** Phrases with "no" that do not say anything was not done. */
const NOT_NEGATION = /\bno (?:rush|worries|problem|problems|hurry|biggie|pressure)\b/g;
const negated = (s: string) => (s.replace(NOT_NEGATION, " ").match(NEGATION)?.length ?? 0) % 2 === 1;

/** A clause that starts its own statement (a subject, a question word, another command): it does not continue a list. */
const OWN_START =
  /^(?:i|i'm|im|i've|ive|i'd|i'll|it|it's|its|that|this|these|those|he|she|they|we|you|there|here|what|how|why|when|where|who|which|is|was|are|were|will|would|could|should|can|do|does|did|has|have|had|let's|lets|tell|show|explain|give|help|find|check|compare|summarize|list|remind|thanks|thank)\b/;

/** A verb: a clause that has one says something of its own ("the Synthetic Focus was great"), it is not a list item. */
const HAS_VERB =
  /\b(?:is|was|were|are|be|been|being|has|have|had|does|did|do|feel|feels|felt|seem|seems|seemed|help|helps|helped|work|works|worked|make|makes|made|say|says|said|go|goes|went|get|gets|got|need|needs|want|wants|like|likes|think|thinks|know|knows)\b/;

/** Clause boundaries inside a sentence: commas, a colon (not in "8:30"), "and", "but", "then", "plus". */
const CLAUSE_SEP = /(\s*,\s*|\s*:\s*|\s+(?:and|but|then|plus)\s+)/;

/**
 * The clauses of `text` that ask for or report a write. A clause with no verb of its own ("…and Synthetic Calm",
 * "…and noon", "6 on my run", the next line of a list) continues the clause before it, keeping its kind and its
 * polarity; a clause with a verb of its own does not. A sentence that is a
 * condition grants nothing; a clause that is a plan or a hedge grants nothing and ends the list; after a colon a
 * request cannot start ("Here is my journal: log X" is a pasted record), only continue one.
 */
function intentClauses(text: string): IntentClause[] {
  const masked = maskQuotes(text);
  const out: IntentClause[] = [];
  let chain: { imperative: boolean; negated: boolean } | null = null;
  for (const [start, end, term] of sentenceRanges(masked)) {
    const sentence = norm(masked.slice(start, end)).replace(/(\d):(\d)/g, "$1\u0001$2");
    if (conditional(sentence)) { chain = null; continue; }
    let afterColon = false;
    const parts = sentence.split(CLAUSE_SEP);
    for (let k = 0; k < parts.length; k++) {
      if (k % 2 === 1) { if (parts[k].includes(":")) afterColon = true; continue; }
      const clause = parts[k].replace(/\u0001/g, ":").replace(/^[\s,:;\-\u2013\u2014*\u2022]+/, "").trim();
      if (!clause) continue;
      const imperative = !afterColon && IMPERATIVE.test(clause);
      // A report phrased as a question ("I had two coffees, is that why…?") is a question, not a logging request.
      const report = !imperative && term !== "?" && isReport(clause);
      if (imperative || report) {
        const hedged = imperative ? HEDGED_REQUEST.test(clause) : false;
        if (hedged) { chain = null; continue; }
        chain = { imperative, negated: negated(clause) };
        out.push({ text: clause, ...chain });
      } else if (chain && !OWN_START.test(clause) && !HYPOTHETICAL.test(clause) && !HAS_VERB.test(clause)) {
        out.push({ text: clause, imperative: chain.imperative, negated: chain.negated || negated(clause) });
      } else {
        chain = null;
      }
    }
    // A list may go on over lines ("Log:" then one item per line); a sentence end closes it.
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
 * offer a write. Any other question ("Want a summary?") or two questions at once accept nothing.
 */
function acceptedOffer(text: string): IntentClause | null {
  const questions = sentenceRanges(text).filter(([, , term]) => term === "?");
  if (questions.length !== 1) return null;
  const [start, end] = questions[0];
  const offer = norm(maskQuotes(text.slice(start, end)));
  if (!WRITE_OFFER.test(offer) || conditional(offer)) return null;
  return { text: offer, imperative: true, negated: negated(offer) };
}

// --- Quiz ------------------------------------------------------------------------------------------------------

/** "Quiz me", "test me", "give me a quiz", "let's do a checkpoint quiz". */
const QUIZ_REQUEST = /\b(?:quiz|test) me\b|\b(?:give|run|start|do|begin|ask)\b[^.?!\n]*\bquiz\b|\bquiz time\b/;

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
  if (request < 0) return { requested: false, asked: 0, recorded: false, answering: false, userText: "" };
  let asked = 0;
  let recorded = false;
  const userText: string[] = [];
  for (let i = request; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "user") { userText.push(maskQuotes(m.content)); continue; }
    asked += sentenceRanges(m.content).filter(([, , term]) => term === "?").length;
    const t = norm(m.content);
    if (/\b(?:recorded|saved|logged)\b/.test(t) && /\b(?:quiz|score|checkpoint)\b/.test(t)) recorded = true;
  }
  const n = messages.length;
  const previous = n >= 2 ? messages[n - 2] : null;
  const answering = n - 2 > request && previous?.role === "assistant" && sentenceRanges(previous.content).some(([, , term]) => term === "?");
  return { requested: true, asked, recorded, answering: !!answering && messages[n - 1]?.role === "user", userText: userText.join("\n") };
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

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

const deny = (code: RefusalCode): WriteDecision => ({ allowed: false, code, reason: REFUSAL_TEXT[code] });
const ALLOW: WriteDecision = { allowed: true };

const READING = /\b(read|reading|listened|listening|chapters?|book|audiobook|session|pages?)\b/;
const FINISHED_BOOK = /\b(finished|completed|done with)\b[^.!?\n]*\bbook\b/;
const HIGHLIGHT = /\b(highlight|quote|passage|line|excerpt|save|keep|note)\b/;
const PLAYLIST_VERB = /\b(create|make|build|generate|save|start|put together|turn)\b/;
const QUIZ_WORD = /\b(quiz|score|checkpoint)\b/;

/** The text of the clauses that pass `filter`. */
const clauseText = (grant: WriteGrant, filter: (c: IntentClause) => boolean) =>
  grant.clauses.filter(filter).map((c) => c.text).join("\n");

/** A book a reading call names: the user named it, or it is the book being read (what a call naming none uses). */
function bookAllowed(input: Record<string, unknown>, text: string, activeBook: string | null | undefined): boolean {
  const book = str(input.book);
  if (!book) return true;
  if (activeBook && book === activeBook) return true;
  return names(book.replace(/[-_]+/g, " "), text);
}

/**
 * Whether one write-tool call may run. `used` counts the calls of each tool already allowed in this request (the
 * caller adds one after an allowed call); `requestDay` is the behavioral day the request runs on; `activeBook` is the
 * slug of the book being read, when the call names a book.
 */
export function authorizeWrite(
  grant: WriteGrant,
  tool: WriteToolName,
  input: Record<string, unknown>,
  ctx: { requestDay: string; used: ReadonlyMap<string, number>; activeBook?: string | null },
): WriteDecision {
  if (grant.off) return deny("writes_off");
  const done = clauseText(grant, (c) => !c.negated);
  const notDone = clauseText(grant, (c) => c.negated);

  // A quiz result: either the user states it ("I got 4 out of 5 on the quiz"), or it closes a quiz the user asked
  // for and is answering, with no more questions than were asked and not recorded already.
  if (tool === "record_reading_quiz") {
    const score = num(input.score), total = num(input.total);
    if (score == null || total == null || !Number.isInteger(score) || !Number.isInteger(total) || total < 1 || score < 0 || score > total) {
      return deny("quiz_score_invalid");
    }
    if ((ctx.used.get(tool) ?? 0) >= 1) return deny("once_per_request");
    const stated = QUIZ_WORD.test(done) && numbersIn(done).has(score) && numbersIn(done).has(total);
    if (!stated) {
      const q = grant.quiz;
      if (!q.requested) return deny("quiz_not_asked");
      if (q.recorded) return deny("quiz_already_recorded");
      if (!q.answering) return deny("quiz_not_answered");
      if (total > q.asked) return deny("quiz_score_invalid");
    }
    if (!bookAllowed(input, stated ? done : grant.quiz.userText, ctx.activeBook)) return deny("not_named");
    return ALLOW;
  }

  if (grant.clauses.length === 0) return deny("no_request");

  // Habits: "I skipped X" / "mark X as not done" is a No for X, never a Yes; "I did X" is a Yes, never a No.
  const habitNo = tool === "mark_habit_complete" && str(input.answer) === "No";
  const said = habitNo ? notDone : done;

  // The day: today needs no words, nor does yesterday for a habit (sleep questions describe last night and are stored
  // on yesterday); any other day has to be the one the user named.
  const date = str(input.date);
  if (date && date !== ctx.requestDay && !statedDays(said, ctx.requestDay).has(date)) {
    if (!(tool === "mark_habit_complete" && date === dayBefore(ctx.requestDay))) return deny("day_not_stated");
  }

  switch (tool) {
    case "create_spotify_playlist": {
      const asked = clauseText(grant, (c) => c.imperative && !c.negated);
      if (!/\bplaylists?\b/.test(asked) || !PLAYLIST_VERB.test(asked)) return deny("playlist_not_requested");
      if ((ctx.used.get(tool) ?? 0) >= 1) return deny("once_per_request");
      return ALLOW;
    }

    case "mark_habit_complete": {
      const habit = str(input.habit);
      if (!habit) return deny("not_named");
      if (names(habit, said, true)) return ALLOW;
      return deny(names(habit, habitNo ? done : notDone, true) ? "contradicts" : "not_named");
    }

    case "log_supplement_stack": {
      const stack = str(input.stack);
      if (!stack) return deny("not_named");
      // "my morning stack" names the stack; "my stack" with no name names a stack only when it has no other words.
      const named = (text: string) => (significant(stack).length > 0 ? names(stack, text) : /\bstack\b/.test(text));
      if (named(done)) return ALLOW;
      return deny(named(notDone) ? "contradicts" : "not_named");
    }

    case "log_supplement_intake": {
      const product = str(input.product);
      if (!product) return deny("not_named");
      if (!names(product, done)) return deny(names(product, notDone) ? "contradicts" : "not_named");
      const amount = num(input.amount);
      if (amount != null && !amountStated(amount, str(input.unit), done)) return deny("amount_not_stated");
      const times = Array.isArray(input.times) ? input.times : [];
      const clock = clockTimes(done);
      for (const t of times) if (typeof t !== "string" || !timeStated(t, clock)) return deny("time_not_stated");
      return ALLOW;
    }

    case "log_reading_session": {
      if (!READING.test(done) && !FINISHED_BOOK.test(done)) return deny(READING.test(notDone) ? "contradicts" : "no_request");
      if (!bookAllowed(input, done, ctx.activeBook)) return deny("not_named");
      const numbers = numbersIn(done);
      const through = num(input.chapter_through);
      if (through == null || !(numbers.has(through) || FINISHED_BOOK.test(done))) return deny("not_named");
      const from = num(input.chapter_from);
      if (from != null && from !== through && !numbers.has(from)) return deny("not_named");
      const minutes = num(input.minutes);
      if (minutes != null && !numbers.has(minutes) && !numbers.has(minutes / 60)) return deny("amount_not_stated");
      for (const field of ["recall", "question"]) {
        const text = str(input[field]);
        if (text && !verbatimIn(text, grant.ownWords)) return deny("not_your_words");
      }
      return ALLOW;
    }

    case "add_book_highlight": {
      if (!HIGHLIGHT.test(done)) return deny("no_request");
      if (!bookAllowed(input, done, ctx.activeBook)) return deny("not_named");
      const passage = str(input.passage);
      if (!passage || significant(passage).length === 0 || !verbatimIn(passage, grant.ownWords)) return deny("not_your_words");
      const comment = str(input.comment);
      if (comment && !verbatimIn(comment, grant.ownWords)) return deny("not_your_words");
      return ALLOW;
    }

    // A write tool added without a rule here is refused, never allowed by default.
    default:
      return deny("no_request");
  }
}
