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
 * text, with the argument-only clauses that follow it ("…and noon"). A reason or circumstance ("…because I forgot",
 * "…since I couldn't sleep") is not part of the action. Each write call has to match one action:
 *   - the action names the call's record (product, stack, habit) as its object (not "I read about X"), with a verb
 *     that fits the write ("log"/"record"/"mark"… or "took"/"had" for an intake; "I bought X" logs nothing), and the
 *     same polarity, read from the action's own clause (never by counting negations): "I skipped X" allows the
 *     answer No for X and nothing that says X was done, "I didn't take X" logs nothing for X, a record named both ways
 *     is refused, and a statement whose polarity cannot be read ("I didn't skip X", "…without X") refuses it;
 *   - the kind of write is bound to the clause that carries the verb: a clause that writes something else (a
 *     playlist, a shopping-list item, a note about a topic) names no record, whatever record-shaped name it
 *     contains ("create a playlist called Synthetic Calm" authorizes the playlist, never an intake of a product
 *     named Synthetic Calm);
 *   - "don't log X" / "don't mark X" / "log Y, not X" is a request not to write X: it grants nothing (never a No) and
 *     refuses any write of X; "don't log it" refuses every write of the message;
 *   - every argument is bound to THAT action, read from that action's own clauses (its clause plus the
 *     argument-only clauses attached to it), never from another action's clause of the same list or sentence: the
 *     amount with its unit kind exactly as lib/supplement-intake.ts reads it (servings, pills, a weight; "15 mg"
 *     never becomes 15 servings, "2 servings" never 2 capsules, and one serving only when no other amount is
 *     stated), the clock times one to one (a time sent twice has to be said twice; every time said is sent; a time
 *     another action states never fits this one, except the one the list's last item shares with all of them), the
 *     chapters as chapter numbers covering exactly the chapters named (both of "chapters 3 and 4", every chapter of
 *     "ch. 5-7") and the minutes as a duration ("chapter 4 for 12 minutes" never gives chapter 12, and a stated
 *     duration is never dropped from the call); an amount or a time the action states cannot be left out;
 *   - the day the call would write (its date, or the tool's default when it sends none) has to be the day the action
 *     names (else its list, else its sentence), or today when none is named: "yesterday" with no date is refused;
 *   - the values have the type the tool reads: a number that arrives as a string is refused, never coerced;
 *   - each action authorizes one write of each record: a repeated intake needs its own words ("…at 8 and again at 9"
 *     is one call with two times, or two actions). Each granted write is consumed once per request under a canonical
 *     identity — the tool, the record as the user's own words name it, and the day, amount, times, chapters or answer
 *     the user's action itself states, never the call's arguments — so a second call for the same grant, in whatever
 *     form the model sends it (a changed optional argument, another name for the same record, a restatement in the
 *     user's message), is refused; a retry of the whole message starts with a fresh set here and reconciles through
 *     the replay ledger (SEC-04), which mints no new action either;
 *   - a reading write goes to the book the user named, or the book being read when the user names none; naming another
 *     known book refuses a call that would write to the book being read;
 *   - text stored as the user's words (a recall note, a question, a passage, a comment) has to be a verbatim span of
 *     the user's words (case, spacing and punctuation aside), so a negation cannot be dropped or added;
 *   - a playlist only on an explicit request (never a report), a quiz result only for the active quiz the user asked
 *     for: the request opens it, each question the assistant asks has to be a quiz question (not an offer, not
 *     "want a summary?"), a cancel ("stop the quiz") closes it for good, the one finalization — the user's last answer
 *     that answers every question asked — authorizes exactly one score out of exactly those questions, with the
 *     checkpoint the conversation bound (a different one is refused) and the book check; anything that cannot be
 *     established (no recognized question, an unanswered one, a later unrelated question) fails closed. A score the
 *     user states themselves ("I got 4 out of 5") is recorded without a quiz, each at most once per request, and never
 *     after "don't record a score".
 *   - a question-bank answer (record_reading_answer) only inside a quiz the user asked for and did not stop, when the
 *     latest message is the reply to the question just asked (the assistant's message right before it carries that
 *     question's label, "Q<id>"), with the answer a verbatim span of that reply, once per message; a question flag
 *     (flag_reading_question) only when the latest message itself says that question is wrong / unclear / not in that
 *     chapter / from a chapter not read yet, the kind the call sends, about the question just asked (or one the message
 *     names as "Q<id>"), never after "don't flag", once per message.
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
interface IntentClause {
  text: string; imperative: boolean; negated: boolean; action: number; chain: number; sentence: string;
  /** A request NOT to write ("don't log X", "do not mark Y"): grants nothing and refuses any write of what it names. */
  prohibition: boolean;
  /** Its polarity cannot be read (two negations, "without…"): refuses any write of what it names. */
  ambiguous: boolean;
  /** The verb of the request or report it belongs to ("log", "took", "read"), lower case; null when there is none. */
  verb: string | null;
}

/** What the conversation says about a reading quiz. */
interface QuizState {
  /** A user message asked for a quiz ("quiz me", "give me a quiz"), not negated, not a plan: it opens the active quiz. */
  requested: boolean;
  /** Quiz questions the assistant asked since that request (not offers, not questions about the quiz itself). */
  asked: number;
  /** User messages since that request that answer a quiz question the assistant asked right before them. */
  answers: number;
  /** Every quiz question asked has an answer (the quiz is complete). */
  answeredAll: boolean;
  /** An assistant turn since that request already reported the result as recorded: the quiz is closed. */
  recorded: boolean;
  /** The latest message answers a quiz question the assistant asked right before it: the quiz's one finalization. */
  answering: boolean;
  /** The latest message is a user message after the request, right after an assistant message (a reply to it). */
  follows: boolean;
  /** A user message since the request stopped the quiz or asked not to record it ("stop the quiz", "don't save it"). */
  cancelled: boolean;
  /** The checkpoint the conversation bound the quiz to ("ch4", "review"), or null when none was named. */
  checkpoint: string | null;
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
  /**
   * The question-bank questions the assistant's message right before the latest one labels ("Q1234"): the question
   * just asked. Read from the conversation only, never a tool result. Empty when that message labels none.
   */
  askedQuestions: number[];
}

/** The books a reading write may go to: the one being read (its slug) and every known book. */
export interface ReadingBooks {
  active: string | null;
  list: ReadonlyArray<{ slug: string; title: string; total_chapters?: number | null; id?: number }>;
}

/**
 * What this request has already been allowed: calls per tool, and the granted writes already consumed (each user
 * action authorizes one write of each record it names). Made with newWriteUsage(). A consumed key is the granted
 * write's canonical identity — the tool, the record as the user's own words name it, and the arguments the user's
 * action states — never the model's call arguments, so a repeated or varied call for the same grant maps to it and
 * is refused. The caller settles each allowed call around its execution: commitWrite() RESERVES it before the tool
 * runs; afterwards a definitive refusal (releaseWrite(), nothing was written) hands the action back so a corrected
 * call in the same request may run, while a success keeps the reservation as the completed write. An uncertain
 * result (a timeout, a network error, a lost answer) also keeps the reservation: a repeat in this request is
 * refused, and a retry of the message reconciles through the SEC-04 ledger under the same operation key instead of
 * executing again. Per request only: a retry of the whole message builds a fresh set.
 */
export interface WriteUsage { perTool: Map<string, number>; consumed: Set<string> }

export function newWriteUsage(): WriteUsage {
  return { perTool: new Map(), consumed: new Set() };
}

export type WriteDecision =
  | { allowed: true; tool: WriteToolName; use: string | null }
  | { allowed: false; code: RefusalCode; reason: string };

/**
 * Reserves an allowed call's part of the grant, before the tool runs, so the action it used cannot authorize the same
 * write again in this request while the call may still be executing. Settle it afterwards: releaseWrite() on a
 * definitive refusal, nothing on a success (the reservation is the completed write) or an uncertain result.
 */
export function commitWrite(usage: WriteUsage, decision: WriteDecision): void {
  if (!decision.allowed) return;
  usage.perTool.set(decision.tool, (usage.perTool.get(decision.tool) ?? 0) + 1);
  if (decision.use) usage.consumed.add(decision.use);
}

/**
 * Releases the reservation of a call whose tool definitively refused (a definitive error from the database, nothing
 * written): the action can authorize a corrected call in the same request again. Only the pair of a commitWrite and
 * a definitive refusal of that same call; a success or an uncertain result keeps the reservation.
 */
export function releaseWrite(usage: WriteUsage, decision: WriteDecision): void {
  if (!decision.allowed) return;
  const n = (usage.perTool.get(decision.tool) ?? 1) - 1;
  if (n > 0) usage.perTool.set(decision.tool, n);
  else usage.perTool.delete(decision.tool);
  if (decision.use) usage.consumed.delete(decision.use);
}

/**
 * Whether a write tool's answer is a definitive refusal: an error answer that says nothing was written (no
 * incomplete mark), so the call's reservation is released and a corrected call may run. A throw (`failed`), a lost
 * answer, an unparsable answer, or one that says it may be incomplete is uncertain: it may have written, so the
 * reservation stays and a retry reconciles through the ledger instead of executing again.
 */
export function definitiveRefusal(result: string, failed: boolean): boolean {
  if (failed) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const answer = parsed as Record<string, unknown>;
  return answer.error !== undefined && !answer.incomplete && !answer.uncertain && answer.success !== true;
}

export type RefusalCode =
  | "writes_off"
  | "no_request"
  | "not_named"
  | "contradicts"
  | "unclear"
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
  | "quiz_cancelled"
  | "quiz_score_invalid"
  | "question_not_asked"
  | "flag_not_stated"
  | "quiz_checkpoint_mismatch"
  | "once_per_request";

/** Why a call was refused (shown on its receipt and to the model). At most 240 characters each. */
export const REFUSAL_TEXT: Record<RefusalCode, string> = {
  writes_off: "Logging from chat is turned off. Nothing was written; use the Log screen instead.",
  no_request: "Not written: your latest message did not ask for this. Onyx only writes what you ask for or report in your own message, never what a record, a tool result or an earlier turn says.",
  not_named: "Not written: this item is not named in your latest message. Onyx only writes the items you name yourself; say it directly to log it.",
  contradicts: "Not written: your latest message says the opposite of this (that you did not do it, or not to log it). Say it directly to record it the other way.",
  unclear: "Not written: your latest message does not say clearly whether you did this (two negations, or \"without\"). Say it directly, for example \"I took X\" or \"I skipped X\".",
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
  quiz_cancelled: "Not recorded: you stopped this quiz or asked not to record it. Ask for a new quiz, or say your score, to record one.",
  quiz_score_invalid: "Not recorded: this score does not fit the quiz questions asked and answered in this conversation.",
  question_not_asked: "Not recorded: this is not the question just asked. Onyx records an answer only for the question you were asked right before your reply (the one labelled with its Q number).",
  flag_not_stated: "Not flagged: your latest message does not say this question is wrong, unclear, not in that chapter, or from a chapter you have not read. Say which, about that question, to flag it.",
  quiz_checkpoint_mismatch: "Not recorded: this checkpoint is not the one the quiz you asked for was about. Say the checkpoint yourself to record it there.",
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

export const tokens = (s: string): string[] => norm(s).match(/[a-z0-9]+(?:'[a-z]+)?/g) ?? [];

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

/**
 * The same whole word: equal, or the same stem ("calms" / "calm", "journals" / "journal", "meditated" / "meditation").
 * Never a longer word that starts with it: "Calm" is not "Calmly", "focus" is not "focusrin".
 */
function sameWord(a: string, b: string): boolean {
  if (a === b) return true;
  if (/\d/.test(a) || /\d/.test(b)) return false;
  return stem(a) === stem(b);
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

export const names =(item: string, text: string, loose = false) => namedSpan(item, text, loose) !== null;

/** Text reduced to words: case, spacing and punctuation aside. */
export const flat =(s: string) => norm(s).replace(/[^a-z0-9']+/g, " ").trim();

/** `part` occurs word for word in `whole` (case, spacing and punctuation aside). */
export function verbatimIn(part: string, whole: string): boolean {
  const p = flat(part);
  return p.length > 0 && ` ${flat(whole)} `.includes(` ${p} `);
}

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
  half: 0.5, a: 1, an: 1, single: 1, couple: 2, both: 2,
};

/** A number as written: digits with comma thousands groups ("5,000", "1,250,000") read as one number; "1,5" is not. */
const numberText = (s: string): number => Number(s.replace(/,/g, ""));

export function numbersIn(text: string): Set<number> {
  const out = new Set<number>();
  for (const m of norm(text).matchAll(/(?<![a-z\d])(?:\d{1,3}(?:,\d{3})+(?!\d)|\d+)(?:\.\d+)?/g)) out.add(numberText(m[0]));
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
/** Fraction words whose article ("half a tablet") is part of the fraction, never a second amount. */
const FRACTION_WORDS = new Set(["half", "quarter", "third"]);

interface Quantity { value: number; unit: string | null; word: string }

/**
 * The amounts a text states, each with the unit said after it ("15 mg", "2 capsules", "2 magnesium capsules", "half a
 * tablet"). A number glued into a word ("B12", "D3", "5-HTP" stays "5" with no unit) is not read as a unit amount.
 */
function quantities(text: string): Quantity[] {
  // A written date ("2026-11-10", "11/10") is a day, never amounts.
  const dateless = norm(text).replace(/\b\d{4}-\d{1,2}-\d{1,2}\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, " ");
  const toks = dateless.match(/[a-z]+\d[a-z\d]*|\d{1,3}(?:,\d{3})+(?!\d)(?:\.\d+)?|\d+(?:\.\d+)?|[a-z]+(?:'[a-z]+)?|:/g) ?? [];
  const out: Quantity[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const value = /^\d/.test(t) ? numberText(t) : own(NUMBER_WORDS, t);
    if (value === undefined) continue;
    const prev = toks[i - 1], next = toks[i + 1];
    if (prev === ":" || next === ":") continue; // 8:30
    if ((next === "a" || next === "p") && toks[i + 2] === "m") continue; // 8 a.m.
    // The bare article is the number one only when it directly precedes a unit or noun, and never inside a
    // fraction phrase: in "half a tablet" the article belongs to the fraction (one amount of 0.5), so it is
    // not a second quantity of one.
    if (t === "a" || t === "an") {
      if (prev !== undefined && FRACTION_WORDS.has(prev)) continue;
      if (next === undefined || NOT_AMOUNT_AFTER.test(next) || UNIT_SEARCH_STOP.test(next) || next === ":") continue;
    }
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
    out.push({ value, unit, word: t });
  }
  return out;
}

/**
 * `amount` of `unit` (as a tool call sends them) was stated in `text` with the same unit kind. A number said with no
 * unit is a number of servings ("I took 2 Synthetic Calm"). One serving needs no words (it is what no amount logs).
 */
function amountStated(amount: number, unit: string | null, text: string, record: string): boolean {
  const kind = callUnit(unit);
  // One serving is what no amount logs: it needs no words, unless the text states another amount ("30 mg").
  if (amount === 1 && kind === "serving") return !statesAmount(text, record);
  return quantities(text).some((q) => q.value === amount && (q.unit ?? "serving") === kind);
}

/**
 * The text states an amount for `record` that a call may not leave out or replace with one serving: a number with a
 * unit ("30 mg", "2 capsules"), or a bare number of servings ("2 Synthetic Calm"). One serving said in words is none,
 * a word like "both" is no amount, and a number that is part of the record's own name ("Omega 3") is not an amount.
 */
function statesAmount(text: string, record: string): boolean {
  const inName = numbersIn(record);
  return quantities(text).some((q) => {
    if ((q.unit === null || q.unit === "serving") && q.value === 1) return false;
    if (q.unit !== null) return true;
    return !/^(?:a|an|single|both|couple)$/.test(q.word) && !inName.has(q.value);
  });
}

// --- Clock times -----------------------------------------------------------------------------------------------

const UNIT_AFTER = /^\s*(?:mg|mcg|g|iu|ml|%|min|mins|minutes?|hours?|capsules?|tablets?|pills?|scoops?|servings?|caps?|tabs?|chapters?)\b/;

/**
 * The clock times a text states, one entry per time said (in the order said), each with its readings as "H:MM"
 * (24 h; both readings when no am / pm was said) or "H:*" for an hour alone. A time is read once even when two
 * patterns match it ("at 8 pm").
 */
function clockSlots(text: string): Array<Set<string>> {
  const found: Array<{ from: number; to: number; readings: Set<string> }> = [];
  const reading = (h: number, mm: string, meridiem: string | null): Set<string> => {
    const out = new Set<string>();
    if (!Number.isInteger(h) || h < 0 || h > 23) return out;
    if (meridiem) {
      const pm = meridiem.startsWith("p");
      if (h < 1 || h > 12) return out;
      out.add(`${(h % 12) + (pm ? 12 : 0)}:${mm}`);
    } else {
      out.add(`${h}:${mm}`);
      if (h >= 1 && h < 12) out.add(`${h + 12}:${mm}`);
      if (h === 12) out.add(`0:${mm}`);
    }
    return out;
  };
  const push = (m: RegExpMatchArray, readings: Set<string>) => {
    const from = m.index ?? 0, to = from + m[0].length;
    if (readings.size === 0 || found.some((f) => from < f.to && f.from < to)) return;
    found.push({ from, to, readings });
  };
  const t = norm(text);
  for (const m of t.matchAll(/\bhalf past (\d{1,2})(?:\s*(a\.?m\.?|p\.?m\.?)(?![a-z]))?/g)) push(m, reading(Number(m[1]), "30", m[2] ?? null));
  for (const m of t.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/g)) push(m, reading(Number(m[1]), m[2] ?? "*", m[3]));
  for (const m of t.matchAll(/\b(\d{1,2}):(\d{2})\b(?!\s*(?:a\.?m|p\.?m))/g)) push(m, reading(Number(m[1]), m[2], null));
  for (const m of t.matchAll(/\b(?:at|around|about|by|before|after)\s+(\d{1,2})\b(?![:.]\d)/g)) {
    if (!UNIT_AFTER.test(t.slice((m.index ?? 0) + m[0].length))) push(m, reading(Number(m[1]), "*", null));
  }
  for (const m of t.matchAll(/\b(\d{1,2})\s*o'clock\b/g)) push(m, reading(Number(m[1]), "*", null));
  for (const m of t.matchAll(/\b(?:noon|midday)\b/g)) push(m, new Set(["12:*"]));
  for (const m of t.matchAll(/\bmidnight\b/g)) push(m, new Set(["0:*"]));
  return found.sort((a, b) => a.from - b.from).map((f) => f.readings);
}

/** A "HH:MM" time the model sends is one reading of a stated time: the same hour (and minutes, when they were said). */
function timeFits(time: string, readings: Set<string>): boolean {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return false;
  const h = Number(m[1]);
  return readings.has(`${h}:${m[2]}`) || readings.has(`${h}:*`);
}

/**
 * The call's times matched one to one to the times stated: each call time to its own stated time (two copies of one
 * time need it said twice). `all`: every stated time has to be used (none left out). Small inputs: plain search.
 */
function timesMatch(times: string[], slots: Array<Set<string>>, all: boolean): boolean {
  if (times.length > slots.length || (all && times.length !== slots.length)) return false;
  const used = new Array<boolean>(slots.length).fill(false);
  const place = (i: number): boolean => {
    if (i === times.length) return true;
    for (let k = 0; k < slots.length; k++) {
      if (used[k] || !timeFits(times[i], slots[k])) continue;
      used[k] = true;
      if (place(i + 1)) return true;
      used[k] = false;
    }
    return false;
  };
  return place(0);
}

// --- Chapters and minutes --------------------------------------------------------------------------------------

/** A number word that can be a chapter ("four"), not one that only means a count ("a", "both"). */
const chapterNumber = (w: string): number | undefined => {
  if (/^\d+$/.test(w)) return Number(w);
  const n = own(NUMBER_WORDS, w);
  return n !== undefined && Number.isInteger(n) && n >= 1 && !/^(?:a|an|single|both|couple)$/.test(w) ? n : undefined;
};

/** The chapter numbers a text states: "chapter 4", "chapters 3 and 4", "ch. 5-7", "chapters three through five". */
function chapterNumbers(text: string): Set<number> {
  const out = new Set<number>();
  // A line break joins the clauses of one list ("chapters 3" / "4 for an hour" from "chapters 3 and 4 for an hour").
  const toks = norm(text).match(/\d+|[a-z]+(?:'[a-z]+)?|[-–&,\n]/g) ?? [];
  for (let i = 0; i < toks.length; i++) {
    if (!/^(?:chapters?|ch|chap)$/.test(toks[i])) continue;
    let expectNumber = true;
    for (let j = i + 1; j < toks.length; j++) {
      const w = toks[j];
      const n = expectNumber ? chapterNumber(w) : undefined;
      if (n !== undefined) { out.add(n); expectNumber = false; continue; }
      if (!expectNumber && /^(?:and|to|through|thru|or|-|–|&|,|\n)$/.test(w)) { expectNumber = true; continue; }
      break;
    }
  }
  return out;
}

/**
 * The chapters a reading action grants, with ranges expanded: "chapter 4" {4}, "chapters 3 and 4" {3, 4},
 * "ch. 5-7" / "chapters three through five" {5, 6, 7}. A call must cover exactly this set.
 */
function grantedChapters(text: string): Set<number> {
  const out = new Set<number>();
  const toks = norm(text).match(/\d+|[a-z]+(?:'[a-z]+)?|[-–&,\n]/g) ?? [];
  for (let i = 0; i < toks.length; i++) {
    if (!/^(?:chapters?|ch|chap)$/.test(toks[i])) continue;
    let expectNumber = true;
    let prev: number | undefined;
    let range = false;
    for (let j = i + 1; j < toks.length; j++) {
      const w = toks[j];
      const n = expectNumber ? chapterNumber(w) : undefined;
      if (n !== undefined) {
        if (range && prev !== undefined && n > prev) for (let c = prev; c <= n; c++) out.add(c);
        else out.add(n);
        prev = n;
        range = false;
        expectNumber = false;
        continue;
      }
      if (!expectNumber && /^(?:and|to|through|thru|or|-|–|&|,|\n)$/.test(w)) {
        range = /^(?:to|through|thru|-|–)$/.test(w);
        expectNumber = true;
        continue;
      }
      break;
    }
  }
  return out;
}

/** The durations a text states, in minutes: "40 minutes", "an hour", "1.5 hours", "half an hour", "twenty five min". */
function minuteValues(text: string): Set<number> {
  const out = new Set<number>();
  const t = norm(text);
  if (/\bhalf (?:an )?hour\b/.test(t)) out.add(30);
  if (/\b(?:an|one) hour and a half\b/.test(t)) out.add(90);
  for (const m of t.matchAll(/\b(\d+(?:\.\d+)?|[a-z]+(?: [a-z]+)?)\s*-?\s*(min|mins|minutes?|hours?|hrs?)\b/g)) {
    const words = m[1].split(" ");
    // "half an hour" and "an hour and a half" are read above, never as one hour.
    if (words.includes("half") || /^\s+and a half\b/.test(t.slice((m.index ?? 0) + m[0].length))) continue;
    let n: number | undefined;
    if (/^\d/.test(m[1])) n = Number(m[1]);
    else {
      // "twenty five", or the last word alone ("read for forty minutes").
      const first = own(NUMBER_WORDS, words[0]), second = own(NUMBER_WORDS, words[1]);
      if (words.length === 2 && first !== undefined && second !== undefined && first >= 20 && first % 10 === 0 && second < 10) n = first + second;
      else n = own(NUMBER_WORDS, words[words.length - 1]);
    }
    if (n === undefined || !(n > 0)) continue;
    out.add(/^h/.test(m[2]) ? n * 60 : n);
  }
  return out;
}

// --- Days ------------------------------------------------------------------------------------------------------

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** The day set of an action whose own words name two different days: it matches no real day, so every day check refuses it. */
const AMBIGUOUS_DAY = "ambiguous";

/** A day the text negates: "not the day before yesterday", "rather than yesterday", "instead of today". It names no day. */
const NEGATED_DAY =
  /\b(?:not|rather than|instead of|except)\s+(?:(?:on|the|for)\s+)*(?:day before yesterday|day before|yesterday|last night|today|tonight|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/g;

/**
 * The day phrases a text names, resolved against the request day, one set of days per phrase: "today" / "this morning"
 * is that day, "yesterday" the day before it, "day before yesterday" two days before it, "Tuesday" the last Tuesday,
 * "Nov 9" the last Nov 9 on or before it, "3 days ago" three days before it. "day before yesterday" is one phrase (its
 * "yesterday" and "the day before" do not count again); a negated day names none.
 */
function statedDayPhrases(text: string, requestDay: string): Array<Set<string>> {
  const phrases: Array<Set<string>> = [];
  const base = Date.parse(`${requestDay}T12:00:00Z`);
  if (!Number.isFinite(base)) return phrases;
  const daysBack = (n: number) => new Date(base - n * 86_400_000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  /** One phrase and the days it names (a phrase that names no day adds nothing). */
  const phrase = (days: Array<string | null>) => {
    const set = new Set(days.filter((d): d is string => d !== null));
    if (set.size > 0) phrases.push(set);
  };
  const back = (from: number, to: number, keep: (d: Date) => boolean = () => true) => {
    const days: string[] = [];
    for (let n = from; n <= to; n++) if (keep(daysBack(n))) days.push(iso(daysBack(n)));
    phrase(days);
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
    phrase([c && c <= requestDay ? c : ymd(year - 1, m, d)]);
  };
  const blankOut = (m: string) => " ".repeat(m.length);
  let t = norm(text).replace(NEGATED_DAY, blankOut);
  if (/\bday before yesterday\b/.test(t)) back(2, 2);
  t = t.replace(/\bday before yesterday\b/g, blankOut);
  if (/\b(?:today|tonight|this (?:morning|afternoon|evening)|earlier today)\b/.test(t)) back(0, 0);
  if (/\b(?:yesterday|last night)\b/.test(t)) back(1, 1);
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
  for (const m of t.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) phrase([ymd(Number(m[1]), Number(m[2]), Number(m[3]))]);
  for (const m of t.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?\b/g)) {
    if (m[3]) {
      const y = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
      phrase([ymd(y, Number(m[1]), Number(m[2]))]);
    } else latest(Number(m[1]), Number(m[2]));
  }
  for (const m of t.matchAll(/\bthe (\d{1,2})(?:st|nd|rd|th)\b/g)) {
    const d = Number(m[1]);
    const c = ymd(year, month, d);
    phrase([c && c <= requestDay ? c : month === 1 ? ymd(year - 1, 12, d) : ymd(year, month - 1, d)]);
  }
  return phrases;
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
 * that continue them up to a blank line, as Markdown shows them), "double quotes", curly quotes and 'straight single
 * quotes', also over several lines. An opening single quote sits at the start or after whitespace or an opening
 * bracket and closes at a quote that ends a word, so the apostrophe inside "don't" is never one. An opening quote or
 * fence that is never closed masks everything after it (fail closed).
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
    else if ((c === "‘" || c === "'") && (i === 0 || /[\s([{]/.test(s[i - 1]))) {
      // An opening single quote (curly or straight) closes at the same quote that ends a word
      // (not the apostrophe inside "don’t" / "don't").
      const closer = c === "‘" ? /’(?![a-z])/i : /'(?![a-z])/i;
      const rest = s.slice(i + 1);
      const m = closer.exec(rest);
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
  /^(took|had|did|didn't|didnt|read|ran|wore|ate|drank|slept|went|got|swam|rode|kept|made|put|skipped|finished|completed|listened|meditated|journaled|journalled|stretched|exercised|walked|used|wrote|studied|practiced|practised|played|lifted|trained|done|used|forgot|taken)$/;

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

/** The verb of a clause that reports something the user did ("took", "meditated", "didn't"), or null: not a report. */
function reportVerb(s: string): string | null {
  if (HYPOTHETICAL.test(s)) return null;
  const words = tokens(s);
  // "I took…", "I've just finished…", "today I meditated…"
  for (let i = 0; i < words.length; i++) {
    if (words[i] !== "i" && words[i] !== "i've" && words[i] !== "ive") continue;
    let j = i + 1;
    while (["just", "already", "also", "have", "finally", "actually", "really"].includes(words[j])) j++;
    const verb = words[j];
    if (verb && (PAST.test(verb) || (verb.length > 4 && verb.endsWith("ed")))) return verb;
    if (verb === "did" && words[j + 1] === "not") return "did";
  }
  // Elliptical: "Finished chapters 3 and 4", "Took my evening stack".
  const first = words[0];
  return first && first !== "did" && PAST.test(first) ? first : null;
}

/** Verbs that introduce what someone else said or wrote: "she said…", "the app told me…", "my note says…". */
const REPORT_FRAME = new Set(["said", "says", "told", "tells", "wrote", "writes", "asked", "asks", "reminded", "reminds", "noted"]);

/**
 * A clause that reports someone else's words without quotation marks ("she said please log it", "the app told me to
 * mark it done", "my note says log two"): it is not the user's request, whatever it contains. The words before the
 * frame name the reporter; an "I" before it means the user is speaking ("I said log it"), so it is not reported speech.
 */
function reportedSpeech(s: string): boolean {
  const words = tokens(s);
  const frame = words.findIndex((w) => REPORT_FRAME.has(w));
  return frame >= 0 && !words.slice(0, frame).some((w) => w === "i" || w === "i've" || w === "ive");
}

/** Words that say something was not done. */
const NEGATION =
  /\b(?:not|no|never|none|nothing|didn't|didnt|don't|dont|doesn't|haven't|havent|hasn't|hadn't|wasn't|weren't|won't|wont|isn't|aren't|can't|cannot|couldn't|skipped|skip|skipping|forgot|forget|missed|miss)\b/g;
/** Words that leave part of a statement out; only a clause that starts with one ("not X", "except X") reads as a No. */
const PARTIAL_NEGATION = /\b(?:without|neither|nor|except|excluding|minus)\b/g;
/** Phrases with "no" that do not say anything was not done. */
const NOT_NEGATION = /\bno (?:rush|worries|problem|problems|hurry|biggie|pressure)\b/g;
/**
 * The words after these give a reason or a circumstance ("…because I forgot", "…since I couldn't sleep"): they are
 * not the action, so they never change its polarity, name its record or carry its arguments.
 */
const SUBORDINATE = /\b(?:because|since|cause|cuz|cos|though|although|while|whereas|so that)\b/;

type Polarity = "pos" | "neg" | "ambiguous";

/**
 * What a clause says about its action: done ("pos"), not done ("neg"), or not clear ("ambiguous": two negations,
 * "I didn't skip it"; or "without" / "except" inside it, "I meditated without music"). Read from the clause before any
 * reason or circumstance (SUBORDINATE), never by counting negations over the whole clause.
 */
export function polarity(s: string): Polarity {
  const main = mainPart(s).replace(NOT_NEGATION, " ");
  const strong = main.match(NEGATION)?.length ?? 0;
  const partial = main.match(PARTIAL_NEGATION)?.length ?? 0;
  if (partial > 0) return partial === 1 && strong === 0 && EXCLUDES.test(main) ? "neg" : "ambiguous";
  return strong === 0 ? "pos" : strong === 1 ? "neg" : "ambiguous";
}
/** The clause up to its first reason or circumstance: the part that states the action. */
function mainPart(s: string): string {
  return s.split(SUBORDINATE)[0].trim();
}
export const negated = (s: string) => polarity(s) !== "pos";

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
  /^(?:\d+(?:\.\d+)?|\d+(?:st|nd|rd|th|am|pm)|am|pm|a|p|m|noon|midday|midnight|o'clock|half|past|quarter|at|around|about|by|before|after|on|the|this|last|of|ago|again|too|yesterday|today|tonight|morning|afternoon|evening|night|day|days|week|weeks|weekend|for|min|mins|minutes?|hours?|hrs?|chapters?|ch|pages?|through|thru|to|and|or|st|nd|rd|th|another|more|each|other|earlier|later)$/;

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
  type Chain = { imperative: boolean; negated: boolean; prohibition: boolean; verb: string | null; id: number; actionNegated: boolean };
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
      const whole = parts[k].replace(/\u0001/g, ":").replace(/^[\s,:;\-–—*•]+/, "").trim();
      if (!whole) continue;
      // The action is what the clause says before any reason or circumstance ("…because I forgot"): only that part
      // gives its polarity, names its record and carries its arguments. A clause that is only a reason ends the list.
      const clause = mainPart(whole);
      if (!clause) { chain = null; continue; }
      // Someone else's words, unquoted ("she said please log it"): neither a request nor a report by the user.
      if (reportedSpeech(clause)) { chain = null; continue; }
      const pol = polarity(clause);
      const negMatch = afterColon ? null : NEG_IMPERATIVE.exec(clause);
      const posMatch = afterColon || negMatch ? null : IMPERATIVE.exec(clause);
      const imperative = negMatch !== null || posMatch !== null;
      // A report phrased as a question ("I had two coffees, is that why…?") is a question, not a logging request.
      const reported = !imperative && term !== "?" ? reportVerb(clause) : null;
      if (imperative || reported) {
        if (posMatch && HEDGED_REQUEST.test(clause)) { chain = null; continue; }
        // "Don't log X" asks for nothing and refuses X; "mark X as not done" asks for a No.
        const prohibition = negMatch !== null;
        const verb = negMatch?.[1] ?? posMatch?.[1] ?? reported;
        const neg = prohibition || pol !== "pos";
        chain = { imperative, negated: neg, prohibition, verb, id: ++chains, actionNegated: neg };
        out.push({ text: clause, imperative, negated: neg, prohibition, ambiguous: !prohibition && pol === "ambiguous", verb, action: ++action, chain: chain.id, sentence: sentenceText });
        continue;
      }
      // "Not Synthetic Focus though." after a list in the sentence before it.
      const base: Chain | null = chain ?? (k === 0 && lastChain && EXCLUDES.test(clause) ? lastChain : null);
      if (base && !OWN_START.test(clause) && !HYPOTHETICAL.test(clause) && !HAS_VERB.test(clause)) {
        chain = base;
        const neg = base.negated || pol !== "pos";
        // An item left out of a request ("log X, not Y") is not to be logged, never a request to record a No.
        const prohibition = base.prohibition || (base.imperative && !base.negated && neg);
        const ambiguous = !prohibition && pol === "ambiguous";
        if (argumentOnly(clause)) {
          if (!ambiguous && neg === base.actionNegated && action >= 0) {
            out.push({ text: clause, imperative: base.imperative, negated: neg, prohibition, ambiguous, verb: base.verb, action, chain: base.id, sentence: sentenceText });
          }
        } else {
          base.actionNegated = neg;
          out.push({ text: clause, imperative: base.imperative, negated: neg, prohibition, ambiguous, verb: base.verb, action: ++action, chain: base.id, sentence: sentenceText });
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
  const pol = polarity(offer);
  const verb = new RegExp(`\\b${WRITE_VERB}\\b`).exec(offer)?.[1] ?? null;
  return { text: offer, imperative: true, negated: pol !== "pos", prohibition: false, ambiguous: pol === "ambiguous", verb, action: 0, chain: 0, sentence: offer };
}

// --- Quiz ------------------------------------------------------------------------------------------------------

/** "Quiz me", "test me", "give me a quiz", "let's do a checkpoint quiz". */
const QUIZ_REQUEST = /\b(?:quiz|test) me\b|\b(?:give|run|start|do|begin|ask)\b[^.?!\n]*\bquiz\b|\bquiz time\b/;

/** Stopping a quiz: "stop the quiz", "cancel this", "forget it", "no more questions". */
const QUIZ_CANCEL =
  /\b(?:stop|cancel|end|quit|abort|skip|drop)\b[^.?!\n;]*\b(?:quiz|test)\b|\b(?:stop|cancel|quit|abort|forget|drop)\s+(?:about\s+)?(?:it|this|that)\b|\bno more (?:quiz|quizzes|questions)\b/;
/** Asking not to record a result: "don't record a score", "do not save it", "no need to log it". */
const QUIZ_NO_RECORD =
  /\b(?:don't|dont|do not|never|no need to)\s+(?:bother\s+)?(?:record|save|log|track|keep|store|recording|saving|logging)\b/;

/**
 * A question about the quiz itself rather than the book: an offer to write, to continue, to summarize, to go over the
 * answers ("Want a summary?", "Ready for the next one?"). It is not a quiz question, and a reply to it — including a
 * "yes" — is never a quiz answer.
 */
const QUIZ_META_QUESTION =
  /\b(?:would you like|do you want|want (?:a|an|another|more|to|me|it|the|that)|shall i|should i|may i|shall we|anything else|ready for|ready to|makes sense|make sense|clear so far|next question|another question|one more|continue|keep going|carry on|summar\w|recap|tl;dr|care for)\b/;

/**
 * The quiz questions one assistant message asked: its question sentences that are not about the quiz itself (not an
 * offer to write, not "want a summary?"). A question that cannot be recognized as a quiz question is not one, so a
 * later unrelated question never widens the quiz, and a reply to it never counts as a quiz answer (fail closed).
 */
function quizQuestions(content: string): number {
  const masked = maskQuotes(content);
  let n = 0;
  for (const [start, end, term] of sentenceRanges(masked)) {
    if (term !== "?") continue;
    const s = norm(masked.slice(start, end));
    if (WRITE_OFFER.test(s) || QUIZ_META_QUESTION.test(s) || conditional(s)) continue;
    n++;
  }
  return n;
}

/** The quiz questions of the assistant message right before index `i`, or 0 when there is no assistant message there. */
const quizQuestionsBefore = (messages: ReadonlyArray<IntentMessage>, i: number): number =>
  i > 0 && messages[i - 1]?.role === "assistant" ? quizQuestions(messages[i - 1].content) : 0;

/**
 * The checkpoint a quiz text binds the quiz to: "quiz me on chapter 4" / "checkpoint 12" / "ch 3" → "ch4" / "ch12" /
 * "ch3", "review" → "review"; null when the text names none. Only the request and the assistant's quiz turns bind it
 * (the quiz's authors), never the user's answers.
 */
function quizCheckpoint(text: string): string | null {
  const t = norm(text);
  const m = /\b(?:checkpoint|chapter)\s+(?:number\s+)?(?:ch\s*)?(\d+)\b/.exec(t) ?? /\bch\s*(\d+)\b/.exec(t);
  if (m) return `ch${Number(m[1])}`;
  return /\breview\b/.test(t) ? "review" : null;
}

function quizState(messages: ReadonlyArray<IntentMessage>): QuizState {
  let request = -1;
  let requestSentence = "";
  for (let i = messages.length - 1; i >= 0 && request < 0; i--) {
    if (messages[i].role !== "user") continue;
    const masked = maskQuotes(messages[i].content);
    for (const [start, end] of sentenceRanges(masked)) {
      const s = norm(masked.slice(start, end));
      if (QUIZ_REQUEST.test(s) && !negated(s) && !HEDGED_REQUEST.test(s) && !conditional(s)) { request = i; requestSentence = s; break; }
    }
  }
  const empty: QuizState =
    { requested: false, asked: 0, answers: 0, answeredAll: false, recorded: false, answering: false, follows: false, cancelled: false, checkpoint: null, userText: "" };
  if (request < 0) return empty;
  let asked = 0;
  let answers = 0;
  let recorded = false;
  let cancelled = false;
  // The active quiz is bound to the checkpoint its request (or the assistant's quiz turns) names, if any.
  let checkpoint = quizCheckpoint(requestSentence);
  const userText: string[] = [];
  for (let i = request; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === "user") {
      const masked = maskQuotes(m.content);
      userText.push(masked);
      if (i > request) {
        // "Stop the quiz", "don't record it", "no more questions": the quiz is closed permanently from here on.
        for (const [start, end] of sentenceRanges(masked)) {
          const s = norm(masked.slice(start, end));
          if (QUIZ_CANCEL.test(s) || QUIZ_NO_RECORD.test(s) || (QUIZ_REQUEST.test(s) && negated(s))) cancelled = true;
        }
        if (quizQuestionsBefore(messages, i) > 0) answers++;
      }
      continue;
    }
    asked += quizQuestions(m.content);
    const t = norm(m.content);
    if (/\b(?:recorded|saved|logged)\b/.test(t) && /\b(?:quiz|score|checkpoint)\b/.test(t)) recorded = true;
    if (checkpoint === null) checkpoint = quizCheckpoint(t);
  }
  const n = messages.length;
  const answering = n - 2 > request && messages[n - 1]?.role === "user" && quizQuestionsBefore(messages, n - 1) > 0;
  // The latest message replies to an assistant message after the request (a question-bank answer needs only this).
  const follows = n - 1 > request && messages[n - 1]?.role === "user" && messages[n - 2]?.role === "assistant";
  return { requested: true, asked, answers, answeredAll: answers >= asked, recorded, answering, follows, cancelled, checkpoint, userText: userText.join("\n") };
}

/** The question numbers a message labels, "(Q1234 · ch 3)": the question-bank questions it asks. */
function questionLabels(text: string): number[] {
  return [...new Set([...text.matchAll(/\bQ(\d{1,15})\b/g)].map((m) => Number(m[1])).filter((n) => Number.isSafeInteger(n) && n > 0))];
}

/** A request not to flag: "don't flag it", "no need to report that question". */
const FLAG_NO = /\b(?:don't|dont|do not|never|no need to|don't need to|dont need to)\s+(?:bother\s+)?(?:flag|report|retire|mark)\b/;
/** The sentence is about the question or the flag itself ("this question…", "Q12…", "flag it…", "that one…"). */
const FLAG_SUBJECT = /\b(?:question|q\d+|flag|this one|that one)\b/;
/** A hedge: the user is not saying it, so nothing is flagged. */
const FLAG_UNSURE = /\b(?:maybe|might|perhaps|possibly|not sure|i think|i guess|wonder|whether|could be)\b/;
const FLAG_ADVERB = "(?:really |just |totally |completely |simply |actually |factually |plainly )?";
/** Splits a sentence into clauses: a comma, colon or joining word ("but", "and", "which") starts a new one. */
const FLAG_CLAUSE = /[,:]|\b(?:but|and|or|although|though|while|whereas|however|which|because|so|except)\b/;
/** The "Q<id>" labels a clause names (norm: lower case), each a positive safe integer. */
const clauseLabels = (s: string): number[] =>
  [...new Set([...s.matchAll(/\bq(\d{1,15})\b/g)].map((m) => Number(m[1])).filter((n) => Number.isSafeInteger(n) && n > 0))];
/**
 * What the user has to say for each kind of flag, read from one clause of the latest message (norm: lower case,
 * plain apostrophes). "wrong" and "unclear" are about the question, never "my answer was wrong" (the clause also has
 * to be about the question, FLAG_SUBJECT) and never "not wrong" (the verb has to sit right before the word).
 */
const FLAG_SAYS: Record<string, RegExp> = {
  wrong: new RegExp(
    `\\b(?:is|was|seems|looks|sounds|feels|are|'s)\\s+${FLAG_ADVERB}(?:wrong|incorrect|false|inaccurate|mistaken|an error)\\b|\\b(?:flag|report|mark)\\b[^.!?\\n]*\\bas\\s+(?:wrong|incorrect|inaccurate)\\b`,
  ),
  unclear: new RegExp(
    `\\b(?:is|was|seems|looks|sounds|feels|are|'s)\\s+${FLAG_ADVERB}(?:unclear|confusing|ambiguous|vague|poorly worded|badly worded|nonsense)\\b|\\b(?:makes?|made) no sense\\b|\\b(?:doesn't|does not|didn't|did not) make (?:any )?sense\\b|\\b(?:flag|report|mark)\\b[^.!?\\n]*\\bas\\s+(?:unclear|confusing|ambiguous|vague)\\b`,
  ),
  not_in_chapter:
    /\b(?:not|isn't|wasn't|aren't)\s+(?:in|from|part of|covered in|about)\s+(?:this|that|the|that same)\s+chapter\b|\bnot (?:in|from) (?:chapter|ch\.?)\s*\d+\b|\bwrong chapter\b|\bfrom (?:another|a different|the wrong) chapter\b/,
  not_read_yet:
    /\b(?:haven't|have not|hasn't|didn't|did not|not)\s+(?:read|got to|gotten to|reached|finished)\s+(?:that|this|the|it|chapter|ch\.?)\b|\bnot read (?:that|this|it|the chapter)?\s*yet\b|\bfrom a chapter i (?:haven't|have not|didn't|did not) (?:read|reach|get to)\b|\b(?:later|future|upcoming) chapter\b/,
};

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
    askedQuestions: questionLabels(messages.length > 1 && messages[messages.length - 2].role === "assistant" ? messages[messages.length - 2].content : ""),
  };
}

/** One action of the grant: its clauses' text, the text of its chain (same polarity) and of its sentences. */
interface Action {
  id: number; chain: number; negated: boolean; imperative: boolean; prohibition: boolean; ambiguous: boolean; verb: string | null;
  text: string; chainText: string; sentence: string;
}

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
      prohibition: first.prohibition,
      ambiguous: first.ambiguous,
      verb: first.verb,
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
const QUIZ_WORD = /\b(quiz|score|checkpoint|result)\b/;
/**
 * The words of another thing a clause writes: a playlist, a list the user shops from, a cart, a note, a journal.
 * The kind of a write is read from the clause that carries its verb, so a clause with one of these ("add X to my
 * shopping list", "save a note about reading chapter 4", "save a playlist called X") writes that thing, not a
 * record: a record-shaped name in it (the playlist's name, the list item) authorizes no record write, highlight or
 * reading session, however well it matches one.
 */
const OTHER_WRITE =
  /\b(?:playlists?|(?:shopping|wish|watch)[ -]?lists?|carts?|baskets?|notes?|journals?)\b/;

/** The request verbs that ask to record a supplement, a stack or a habit (never "create", "make", "highlight"). */
const RECORD_REQUEST = /^(?:log|record|mark|save|add|track|enter)$/;
/** The report verbs that say a supplement or a stack was taken ("I read about X" or "I bought X" says no such thing). */
const INTAKE_REPORT =
  /^(?:took|taken|had|used|drank|ate|did|didn't|didnt|finished|completed|swallowed|popped|chewed|skipped|forgot|missed)$/;
/** Report verbs that are about a habit, not doing it ("I read about meditation", "I bought a yoga mat"). */
const MENTION_REPORT =
  /^(?:bought|ordered|researched|heard|learned|learnt|saw|found|asked|talked|discussed|looked|watched|mentioned|considered|searched|googled|wondered|noticed|wanted)$/;

/** Whether the action's verb asks for or reports this tool's write (an intake is taken, a habit is done). */
function verbFits(tool: WriteToolName, a: Action): boolean {
  const verb = a.verb ?? "";
  if (a.imperative) return RECORD_REQUEST.test(verb);
  if (tool === "log_supplement_intake" || tool === "log_supplement_stack") return INTAKE_REPORT.test(verb);
  if (tool === "mark_habit_complete") return !MENTION_REPORT.test(verb);
  return false;
}

/** The record is the topic of the action, not its object: "…about X", "…regarding X". */
function topicOnly(a: Action, span: [number, number]): boolean {
  const toks = tokens(a.text);
  for (let i = span[0] - 1; i >= 0 && i >= span[0] - 4; i--) {
    const w = toks[i];
    if (/^(?:about|regarding|concerning|re)$/.test(w)) return true;
    if (!/^(?:the|my|a|an|some|your|this|that|new|whole)$/.test(w)) return false;
  }
  return false;
}

/** A request not to write that names nothing but "it" / "that" / "anything": it refuses every write of the message. */
function refusesAll(a: Action): boolean {
  if (!a.prohibition) return false;
  const words = tokens(a.text);
  const rest = words.filter((w) => !STOP.has(w) && !GENERIC.has(w) && !RECORD_REQUEST.test(w)
    && !/^(?:don't|dont|do|not|never|no|need|to|please|but|actually|anything|everything|any|bother)$/.test(w));
  return rest.length === 0 && words.some((w) => /^(?:it|that|this|them|those|these|anything|everything)$/.test(w));
}

/** The refusal of a request not to write ("contradicts") or an unclear statement ("unclear") that `hit` matches. */
function blockedBy(actions: Action[], hit: (a: Action) => boolean): RefusalCode | null {
  if (actions.some((a) => a.prohibition && hit(a))) return "contradicts";
  if (actions.some((a) => a.ambiguous && hit(a))) return "unclear";
  return null;
}

/** A present value that is not a string (a field the tool reads as text). */
const notText = (v: unknown) => v !== undefined && v !== null && typeof v !== "string";
/** A present value that is not a finite number (a field the tool reads with Number(), which would coerce a string). */
const notNumber = (v: unknown) => v !== undefined && v !== null && !(typeof v === "number" && Number.isFinite(v));
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * The days an action allows: the days it names, else the days its list names, else its sentence's, else none (the
 * caller's default: today, or last night for a sleep question). One day from its own words: when the words that name
 * the action's day name two different days ("yesterday … the day before yesterday"), the action allows neither, so
 * every day check refuses it instead of guessing.
 */
function allowedDays(a: Action, requestDay: string): Set<string> {
  for (const text of [a.text, a.chainText, a.sentence]) {
    const phrases = statedDayPhrases(text, requestDay);
    if (phrases.length === 0) continue;
    const key = (s: Set<string>) => [...s].sort().join(",");
    if (phrases.some((p) => key(p) !== key(phrases[0]))) return new Set([AMBIGUOUS_DAY]);
    return phrases[0];
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
 * (null when they could not be read: reading writes are refused; on a retry the caller passes the book the earlier try
 * of the same call was pinned to as the one being read); `isSleepHabit` says which habits are sleep questions (stored
 * on last night when no date is sent).
 */
export function authorizeWrite(
  grant: WriteGrant,
  tool: WriteToolName,
  input: Record<string, unknown>,
  ctx: { requestDay: string; used: WriteUsage; books?: ReadingBooks | null; isSleepHabit?: (habit: string) => boolean },
): WriteDecision {
  if (grant.off) return deny("writes_off");
  const actions = actionsOf(grant);
  // Reports and requests that grant something. A request not to write ("don't log X") and a statement whose polarity
  // cannot be read grant nothing; they refuse what they name.
  const done = actions.filter((a) => !a.negated && !a.prohibition && !a.ambiguous);
  const notDone = actions.filter((a) => a.negated && !a.prohibition && !a.ambiguous);
  const fresh = (key: string) => !ctx.used.consumed.has(key);

  // Values the tool reads: a date has to be a real day, numbers numbers, text text. Nothing is coerced.
  if (notText(input.date) || (typeof input.date === "string" && input.date.trim() && !isDay(input.date.trim()))) return deny("invalid_value");

  // "Don't log it" / "don't save that": nothing in this message is written.
  if (actions.some(refusesAll)) return deny("contradicts");

  // A quiz result: either the user states it ("I got 4 out of 5 on the quiz"), or it closes the active quiz the user
  // asked for — every quiz question asked was answered, this last answer is the one finalization, the score is out of
  // exactly those questions, the checkpoint matches the one the conversation bound, and the quiz was not stopped and
  // not recorded already. Anything that cannot be established from the conversation fails closed.
  if (tool === "record_reading_quiz") {
    if (notNumber(input.score) || notNumber(input.total) || notText(input.book) || notText(input.checkpoint)) return deny("invalid_value");
    const score = num(input.score), total = num(input.total);
    if (score == null || total == null || !Number.isInteger(score) || !Number.isInteger(total) || total < 1 || score < 0 || score > total) {
      return deny("quiz_score_invalid");
    }
    if ((ctx.used.perTool.get(tool) ?? 0) >= 1) return deny("once_per_request");
    // "Don't record a score", "the quiz, not recorded".
    if (actions.some((a) => a.prohibition && QUIZ_WORD.test(a.text))) return deny("contradicts");
    const q = grant.quiz;
    // The quiz is bound to the checkpoint it named: a call recording another one is refused.
    const cp = str(input.checkpoint);
    if (q.checkpoint !== null && (cp === null || cp.toLowerCase() !== q.checkpoint)) return deny("quiz_checkpoint_mismatch");
    const stated = done.find((a) => QUIZ_WORD.test(a.text) && numbersIn(a.text).has(score) && numbersIn(a.text).has(total));
    if (!stated) {
      if (!q.requested) return deny("quiz_not_asked");
      if (q.cancelled) return deny("quiz_cancelled");
      if (q.recorded) return deny("quiz_already_recorded");
      if (!q.answering) return deny("quiz_not_answered");
      // Only the complete active quiz: recognized quiz questions exist, every one has an answer, and the score is
      // out of exactly those questions.
      if (q.asked < 1 || !q.answeredAll || total !== q.asked) return deny("quiz_score_invalid");
    }
    const bad = bookCheck(input, stated ? stated.text : grant.quiz.userText, ctx.books);
    if (bad) return deny(bad);
    return allow(tool, null);
  }

  // One answer to a question-bank question (READ-QUIZ-01): only inside a quiz the user asked for and did not stop, when
  // the latest message is the reply to the question the assistant asked right before it (that message carries the
  // question's label, "Q<id>", so a made-up id or an earlier question is refused), the answer a verbatim span of that
  // reply, once per message. The grade is the model's judgement; the answer itself is only ever the user's own words.
  if (tool === "record_reading_answer") {
    if (notNumber(input.question_id) || notNumber(input.version) || notText(input.answer) || notText(input.verdict) || notText(input.feedback)) return deny("invalid_value");
    const qid = num(input.question_id), version = num(input.version);
    if (qid == null || version == null || !Number.isInteger(qid) || !Number.isInteger(version) || qid < 1 || version < 1) return deny("invalid_value");
    if (input.verdict !== "correct" && input.verdict !== "partial" && input.verdict !== "incorrect") return deny("invalid_value");
    const answer = str(input.answer);
    if (!answer) return deny("invalid_value");
    if ((ctx.used.perTool.get(tool) ?? 0) >= 1) return deny("once_per_request");
    const q = grant.quiz;
    if (!q.requested) return deny("quiz_not_asked");
    if (q.cancelled) return deny("quiz_cancelled");
    if (!q.follows) return deny("quiz_not_answered");
    if (!grant.askedQuestions.includes(qid)) return deny("question_not_asked");
    if (!verbatimIn(answer, grant.latest)) return deny("not_your_words");
    return allow(tool, null);
  }

  // A question flag: the user's own latest message says that question is wrong / unclear / not in that chapter / from a
  // chapter not read yet, in the kind the call sends, about the question just asked (or one the message names as
  // "Q<id>"). "My answer was wrong", a question ("is it wrong?"), a condition and "don't flag it" flag nothing.
  if (tool === "flag_reading_question") {
    if (notNumber(input.question_id) || notText(input.kind)) return deny("invalid_value");
    const qid = num(input.question_id);
    if (qid == null || !Number.isInteger(qid) || qid < 1) return deny("invalid_value");
    const kind = str(input.kind);
    if (!kind || !Object.prototype.hasOwnProperty.call(FLAG_SAYS, kind)) return deny("invalid_value");
    if ((ctx.used.perTool.get(tool) ?? 0) >= 1) return deny("once_per_request");
    const masked = maskQuotes(grant.latest);
    const sentences = sentenceRanges(masked).map(([start, end, term]) => ({ s: norm(masked.slice(start, end)), term }));
    if (sentences.some(({ s }) => FLAG_NO.test(s))) return deny("contradicts");
    // Each clause is judged on its own: its complaint (FLAG_SAYS), its subject (the question, FLAG_SUBJECT) and any
    // "Q<id>" it names must all sit in that clause. A hedge or a "not wrong" in a clause disqualifies only that clause.
    const hits: number[][] = [];
    for (const { s, term } of sentences) {
      if (term === "?" || conditional(s)) continue;
      for (const clause of s.split(FLAG_CLAUSE)) {
        if (!FLAG_SUBJECT.test(clause) || FLAG_UNSURE.test(clause) || !FLAG_SAYS[kind].test(clause)) continue;
        // "not wrong", "not unclear": the word itself is negated.
        if ((kind === "wrong" || kind === "unclear") && /\b(?:not|isn't|wasn't|never)\s+(?:\w+\s+)?(?:wrong|incorrect|false|inaccurate|mistaken|unclear|confusing|ambiguous|vague)\b/.test(clause)) continue;
        hits.push(clauseLabels(clause));
      }
    }
    if (hits.length === 0) return deny("flag_not_stated");
    // The target is the "Q<id>" named in the same clause, or the question just asked when the clause names none.
    if (!hits.some((labels) => (labels.length > 0 ? labels : grant.askedQuestions).includes(qid))) return deny("question_not_asked");
    return allow(tool, null);
  }

  if (actions.length === 0) return deny("no_request");

  if (tool === "create_spotify_playlist") {
    const blocked = blockedBy(actions, (a) => /\bplaylists?\b/.test(a.text));
    if (blocked) return deny(blocked);
    const asked = done.filter((a) => a.imperative).map((a) => a.text).join("\n");
    if (!/\bplaylists?\b/.test(asked) || !PLAYLIST_VERB.test(asked)) return deny("playlist_not_requested");
    if ((ctx.used.perTool.get(tool) ?? 0) >= 1) return deny("once_per_request");
    return allow(tool, null);
  }

  if (tool === "add_book_highlight") {
    if (notText(input.passage) || notText(input.comment) || notNumber(input.chapter) || notText(input.book)) return deny("invalid_value");
    const blocked = blockedBy(actions, (a) => HIGHLIGHT.test(a.text));
    if (blocked) return deny(blocked);
    const asked = done.filter((a) => HIGHLIGHT.test(a.text) && !OTHER_WRITE.test(a.text));
    if (asked.length === 0) return deny("no_request");
    const passage = str(input.passage);
    if (!passage || significant(passage).length === 0 || !verbatimIn(passage, grant.ownWords)) return deny("not_your_words");
    const comment = str(input.comment);
    if (comment && !verbatimIn(comment, grant.ownWords)) return deny("not_your_words");
    const chapter = num(input.chapter);
    if (chapter != null && !asked.some((a) => chapterNumbers(a.chainText).has(chapter))) return deny("not_named");
    const bad = bookCheck(input, asked.map((a) => a.sentence).join("\n"), ctx.books);
    if (bad) return deny(bad);
    const key = `${tool}|${flat(passage)}`;
    return fresh(key) ? allow(tool, key) : deny("already_written");
  }

  if (tool === "log_reading_session") {
    for (const field of ["chapter_through", "chapter_from", "minutes"]) if (notNumber(input[field])) return deny("invalid_value");
    for (const field of ["recall", "question", "medium", "book"]) if (notText(input[field])) return deny("invalid_value");
    const blocked = blockedBy(actions, (a) => READING.test(a.chainText) || FINISHED_BOOK.test(a.chainText));
    if (blocked) return deny(blocked);
    // The kind of write is read from the clause that carries the verb (the chain's first): a chain that starts by
    // writing something else ("save a note about reading chapter 4") is not a reading report, however well its
    // words match one. A later item that only writes a note ("…and took a note") does not un-read the chain.
    const firstOfChain = new Map<number, Action>();
    for (const a of done) if (!firstOfChain.has(a.chain)) firstOfChain.set(a.chain, a);
    // Each reading action is checked against its own clause, never another action's of the same list ("chapter 3
    // of this book and chapter 4 of that one" gives each chapter its own book).
    const readings = done.filter((a) => !OTHER_WRITE.test(firstOfChain.get(a.chain)!.text) && (READING.test(a.text) || FINISHED_BOOK.test(a.text)));
    if (readings.length === 0) return deny(notDone.some((a) => READING.test(a.chainText)) ? "contradicts" : "no_request");
    // The granted session's canonical identity: the book the grant binds (the one the user names — bookCheck refuses
    // any other — else the one being read), the day, the chapters and the minutes the user's own action states
    // (that action's own clauses, never the rest of its list), never the call's arguments, so a repeated or varied
    // call for the same session is refused and another chapter range or day is another session.
    const sessionIdentity = (a: Action): string => {
      const days = [...allowedDays(a, ctx.requestDay)].sort();
      const chapters = [...chapterNumbers(a.text)].sort((x, y) => x - y).join(",");
      const minutes = [...minuteValues(a.text)].sort((x, y) => x - y).join(",");
      const book = str(input.book) ?? ctx.books?.active ?? "";
      return [tool, book, days.length > 0 ? days.join(",") : ctx.requestDay, chapters, minutes].join("|");
    };
    let refusal: RefusalCode = "not_named";
    for (const a of readings) {
      const r = readingSessionFits(a, input, grant, ctx);
      if (r) { refusal = r; continue; }
      const key = sessionIdentity(a);
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
  // "Don't mark X" / "log Y, not X" refuses any write of X (a Yes or a No); so does a statement about X whose polarity
  // cannot be read ("I didn't skip X").
  const blocked = blockedBy(actions, (a) => span(a) !== null);
  if (blocked) return deny(blocked);
  // "I skipped X" / "mark X as not done" is a No for X, never a Yes; "I did X" is a Yes, never a No. A record named
  // both ways ("log X… actually don't log X") is refused.
  const [same, opposite] = answerNo ? [notDone, done] : [done, notDone];
  if (opposite.some((a) => span(a) !== null)) return deny("contradicts");
  // The action has to name the record as its object ("I read about X" names X as a topic), with a verb that asks for
  // or reports this kind of write ("I took X" logs an intake; "I bought X" does not).
  const candidates = same.filter((a) => {
    const at = span(a);
    return at !== null && !topicOnly(a, at) && !OTHER_WRITE.test(a.text) && verbFits(tool, a);
  });
  if (candidates.length === 0) return deny("not_named");

  // The granted write's canonical identity: the tool, the record as the user's own words name it, and the arguments
  // the user's action itself states — the day (the days it names, else the default), the amounts with their unit kind
  // and the clock times (an intake), a habit's answer. Never the call's arguments, so a second call for the same
  // grant is refused whatever the model sends (a changed optional argument cannot mint a new write), two actions
  // that grant the same write are one, and actions with different stated arguments remain one write each. Per request
  // only; a retry of the whole message starts fresh here and reconciles through the replay ledger (SEC-04).
  const mention = (a: Action): string => {
    const at = span(a)!;
    const toks = tokens(a.text);
    // A word continues the record's mention when it is part of its name, not an argument or glue: "synthetic
    // magnesium" and "synthetic magnesium glycinate" are the mention "synthetic magnesium glycinate".
    const word = (w: string) =>
      !STOP.has(w) && !GENERIC.has(w) && (!ARGUMENT_WORD.test(w) || /^\d+(?:\.\d+)?$/.test(w));
    let [from, to] = at;
    while (from > 0 && word(toks[from - 1])) from -= 1;
    while (to + 1 < toks.length && word(toks[to + 1])) to += 1;
    return flat(toks.slice(from, to + 1).join(" "));
  };
  const grantIdentity = (a: Action): string => {
    const days = [...allowedDays(a, ctx.requestDay)].sort();
    const parts = [tool, mention(a), days.length > 0 ? days.join(",") : defaultDay(tool, record!, ctx)];
    if (tool === "log_supplement_intake") {
      parts.push(quantities(a.text).map((q) => `${q.value}:${q.unit ?? "serving"}`).sort().join(";"));
      parts.push(actionTimes(a, actions).slots.map((s) => [...s].sort().join("/")).join(";"));
    }
    if (tool === "mark_habit_complete") parts.push(a.negated ? "no" : "yes");
    return parts.join("|");
  };
  let refusal: RefusalCode = "not_named";
  for (const a of candidates) {
    const r = argumentsFit(tool, a, actions, input, record, ctx);
    if (r) { refusal = r; continue; }
    const key = grantIdentity(a);
    if (!fresh(key)) { refusal = "already_written"; continue; }
    return allow(tool, key);
  }
  return deny(refusal);
}

/** The day a grant names none: today, or last night for a sleep question (lib/checkin sleepAnswerDate). */
function defaultDay(tool: WriteToolName, record: string, ctx: { requestDay: string; isSleepHabit?: (habit: string) => boolean }): string {
  if (tool === "mark_habit_complete" && ctx.isSleepHabit?.(record)) return dayBefore(ctx.requestDay) ?? ctx.requestDay;
  return ctx.requestDay;
}

/** The day a call writes, when it sends none: the grant's default day. */
function effectiveDay(tool: WriteToolName, input: Record<string, unknown>, record: string, ctx: { requestDay: string; isSleepHabit?: (habit: string) => boolean }): string {
  return str(input.date) ?? defaultDay(tool, record, ctx);
}

/** The day check: the day the call writes is one the action names, or the default day when it names none. */
function dayFits(
  day: string, a: Action, tool: WriteToolName, record: string, input: Record<string, unknown>,
  ctx: { requestDay: string; isSleepHabit?: (habit: string) => boolean },
): boolean {
  const sleepDefault = tool === "mark_habit_complete" && !!ctx.isSleepHabit?.(record) && !str(input.date);
  const days = allowedDays(a, ctx.requestDay);
  // A sleep question sent with no date is stored on last night (the night that closed yesterday), which is what "I
  // wore my mask today" or "last night" means; any other day named refuses it.
  if (sleepDefault) return days.size === 0 || days.has(day) || days.has(ctx.requestDay);
  if (days.size > 0) return days.has(day);
  // No day named: today, or last night for a sleep question.
  if (day === ctx.requestDay) return true;
  return tool === "mark_habit_complete" && !!ctx.isSleepHabit?.(record) && day === dayBefore(ctx.requestDay);
}

/**
 * The times an action states, and whether the call has to send all of them. Its own times, which it must send. With
 * none of its own, the one time its list's LAST item states and shares with every item ("Log X and Y at 9pm" is
 * both at 9pm). Nothing else: a time another action of the list states on its own ("Log X at 8 and Y") is that
 * action's, never this one's, so this one sends no time at all.
 */
function actionTimes(a: Action, actions: Action[]): { slots: Array<Set<string>>; required: boolean } {
  const own = clockSlots(a.text);
  if (own.length > 0) return { slots: own, required: true };
  const list = actions.filter((b) => b.chain === a.chain && b.negated === a.negated && !b.prohibition && !b.ambiguous);
  const last = list.reduce<Action | null>((m, b) => (m === null || b.id > m.id ? b : m), null);
  if (last && last.id !== a.id && list.every((b) => b.id === last.id || clockSlots(b.text).length === 0)) {
    const shared = clockSlots(last.text);
    if (shared.length > 0) return { slots: shared, required: true };
  }
  return { slots: [], required: false };
}

/** Whether the call's arguments are the ones action `a` states (null) or why not. */
function argumentsFit(
  tool: WriteToolName,
  a: Action,
  actions: Action[],
  input: Record<string, unknown>,
  record: string,
  ctx: { requestDay: string; isSleepHabit?: (habit: string) => boolean },
): RefusalCode | null {
  if (!dayFits(effectiveDay(tool, input, record, ctx), a, tool, record, input, ctx)) return "day_not_stated";
  if (tool !== "log_supplement_intake") return null;

  // The amount, in the unit kind the intake would be counted in, stated in this action (never another item's). One
  // serving, sent or left out, only when the action states no other amount.
  const amount = num(input.amount);
  if (amount != null && !amountStated(amount, str(input.unit), a.text, record)) return "amount_not_stated";
  if (amount == null && statesAmount(a.text, record)) return "amount_omitted";

  // The times, one to one: each time sent is a time said (said twice to be sent twice), and every time the action
  // states is sent (no intake of "at 8 and noon" left out).
  const { slots, required } = actionTimes(a, actions);
  const times = Array.isArray(input.times) ? (input.times as string[]) : [];
  if (!timesMatch(times, slots, false)) return "time_not_stated";
  if (required && times.length < slots.length) return "time_omitted";
  return null;
}

/**
 * Whether a reading session call fits reading action `a`: the call covers EXACTLY the chapters the action grants
 * (both of "chapters 3 and 4", every chapter of "ch. 5-7"), the minutes are the duration said and are sent when one
 * is stated ("chapter 4 for 12 minutes" never gives chapter 12 or 4 minutes, and never drops the 12), the day, the
 * book, the user's words — each read from that action's own clauses, never another action's of the same list.
 */
function readingSessionFits(
  a: Action,
  input: Record<string, unknown>,
  grant: WriteGrant,
  ctx: { requestDay: string; books?: ReadingBooks | null },
): RefusalCode | null {
  const text = a.text;
  const book = bookCheck(input, a.text, ctx.books);
  if (book) return book;
  const chapters = grantedChapters(text);
  const through = num(input.chapter_through);
  const finished = FINISHED_BOOK.test(text);
  if (through == null) return "not_named";
  // The endpoints are the call's own numbers: each has to be a whole chapter (an integer >= 1). A hostile or
  // malformed endpoint (a float, a 0, a huge negative "from") is refused here, before anything is expanded.
  if (!Number.isInteger(through) || through < 1) return "not_named";
  if (!chapters.has(through)) {
    // "I finished the book": the last chapter of the book written to, when it is known.
    const slug = str(input.book) ?? ctx.books?.active ?? null;
    const total = ctx.books?.list.find((b) => b.slug === slug)?.total_chapters;
    if (!finished || total == null || through !== total) return "not_named";
  }
  const from = num(input.chapter_from);
  if (from !== null && (!Number.isInteger(from) || from < 1)) return "not_named";
  if (from !== null && from > through) return "not_named";
  if (chapters.size > 0) {
    // The call must cover exactly the granted chapters: not a subset, not more. Compared by endpoint and
    // cardinality, never by expanding the call's range: the range written (chapter_from .. chapter_through, or
    // the single chapter when no from is sent) has to be exactly the chapters the user granted. Counting it by
    // subtraction first means a hostile range (e.g. from -1000000000 to a named chapter 4) is refused by its
    // size before anything is enumerated, and the only values ever iterated are the user's own granted chapters.
    const fromCh = from ?? through;
    if (through - fromCh + 1 !== chapters.size) return "not_named";
    for (const c of chapters) if (c < fromCh || c > through) return "not_named";
  } else if (from !== null && from !== through) {
    return "not_named";
  }
  const minutes = num(input.minutes);
  const statedMinutes = minuteValues(text);
  if (statedMinutes.size > 0) {
    if (minutes == null || !statedMinutes.has(minutes)) return "amount_not_stated";
  } else if (minutes != null) {
    return "amount_not_stated";
  }
  const day = str(input.date) ?? ctx.requestDay;
  const days = allowedDays(a, ctx.requestDay);
  if (days.size > 0 ? !days.has(day) : day !== ctx.requestDay) return "day_not_stated";
  for (const field of ["recall", "question"]) {
    const words = str(input[field]);
    if (words && !verbatimIn(words, grant.ownWords)) return "not_your_words";
  }
  return null;
}
