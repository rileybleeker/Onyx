/**
 * Write authority for /chat (SEC-05).
 *
 * The model reads untrusted text: journal entries, highlights, tool results, earlier turns. Telling it not to obey
 * that text (CHAT_SCOPE, WRITE_GATE) is guidance, not a boundary. The boundary is here: before any write tool runs, the
 * server checks the call against a grant computed from the conversation the user sent, BEFORE the first model call
 * and without any model. Only the user's own latest message can grant a write (plus, for a short "yes", the offer in
 * the assistant turn right before it, and for a quiz result, the user's own request for the quiz). Tool results never
 * reach the grant, so retrieved text cannot mint or widen it.
 *
 * A grant is bound to the capability (which write tool, which record) and to the request:
 *   - the latest message has to ask for a write ("log…", "mark…", "save…", "create…") or report one ("I took…",
 *     "I meditated", "finished chapter 4"), in a sentence that is not a question, a hypothetical or quoted text;
 *   - the record the call writes has to be named in that sentence (the product, the stack, the habit, the chapter);
 *   - an amount, a clock time or another day has to be stated in the message;
 *   - text stored as the user's words (a recall note, a highlighted passage, a comment) has to be the user's words;
 *   - a playlist only on an explicit request (never a report), a quiz result only for a quiz the user asked for, each
 *     at most once per request.
 * A refused call never runs; its receipt says why. Pure and import-free (types only), so it runs in the node tests.
 * No personal data.
 */
import type { WriteToolName } from "@/lib/chat-receipts";

export interface IntentMessage { role: "user" | "assistant"; content: string }

/** A sentence of the latest message (or of the offer a "yes" accepts) that asks for or reports a write. */
interface IntentSentence { text: string; imperative: boolean }

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
  /** Normalized text of what the user stated (intent sentences plus the unquoted latest message, or the offer). */
  stated: string;
  /** Its sentences that ask for or report a write, quoted text masked out. */
  sentences: IntentSentence[];
  /** The latest message is a short "yes" to the question the assistant asked right before it. */
  confirmed: boolean;
  /** A user message of this conversation asked for a quiz. */
  quizAsked: boolean;
  /** The latest message (or the offer it accepts) states a day other than today. */
  statesDay: boolean;
  /** Clock times it states, as "H:MM" (24 h; both readings when no am / pm was said) or "H:*" for an hour alone. */
  clock: Set<string>;
  /** Numbers stated in the latest message (or the offer it accepts), digits or words. */
  numbers: Set<number>;
}

export type WriteDecision = { allowed: true } | { allowed: false; code: RefusalCode; reason: string };

export type RefusalCode =
  | "writes_off"
  | "no_request"
  | "not_named"
  | "amount_not_stated"
  | "time_not_stated"
  | "day_not_stated"
  | "not_your_words"
  | "playlist_not_requested"
  | "quiz_not_asked"
  | "once_per_request";

/** Why a call was refused (shown on its receipt and to the model). At most 240 characters each. */
export const REFUSAL_TEXT: Record<RefusalCode, string> = {
  writes_off: "Logging from chat is turned off. Nothing was written; use the Log screen instead.",
  no_request: "Not written: your latest message did not ask for this. Onyx only writes what you ask for or report in your own message, never what a record, a tool result or an earlier turn says.",
  not_named: "Not written: this item is not named in your latest message. Onyx only writes the items you name yourself; say it directly to log it.",
  amount_not_stated: "Not written: this amount is not in your latest message. Say the amount yourself, or leave it out for one standard serving.",
  time_not_stated: "Not written: this time is not in your latest message. Say the time yourself, or leave it out.",
  day_not_stated: "Not written: your latest message does not name another day. Say the day yourself to log it there.",
  not_your_words: "Not written: this text is not from your latest message. Onyx stores notes, passages and comments only in your own words.",
  playlist_not_requested: "Not created: your latest message did not ask for a playlist. Ask for one directly to create it.",
  quiz_not_asked: "Not recorded: you did not ask for a quiz in this conversation.",
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

/** Share of the significant words of `part` that occur in `whole` (1 when `part` has none). */
function coverage(part: string, whole: string): number {
  const want = tokens(part).filter((w) => !STOP.has(w));
  if (want.length === 0) return 1;
  const have = new Set(tokens(whole));
  return want.filter((w) => have.has(w)).length / want.length;
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
  // Own keys only ("constructor" is a word, not a number).
  const word = (w: string | undefined) => (w !== undefined && Object.prototype.hasOwnProperty.call(NUMBER_WORDS, w) ? NUMBER_WORDS[w] : undefined);
  for (let i = 0; i < words.length; i++) {
    const n = word(words[i]);
    if (n === undefined) continue;
    out.add(n);
    // "twenty five"
    const next = word(words[i + 1]);
    if (n >= 20 && n % 10 === 0 && next !== undefined && next > 0 && next < 10) out.add(n + next);
  }
  return out;
}

/** A day other than today, said in words or digits ("yesterday", "on Tuesday", "Nov 9", "the 9th", "11/9"). */
const DAY_WORDS =
  /\b(?:yesterday|last night|the night before|days? ago|day before|the other day|last (?:week|weekend)|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+\d{1,2}\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}\b|\bthe \d{1,2}(?:st|nd|rd|th)\b/;

const UNIT_AFTER = /^\s*(?:mg|mcg|g|iu|ml|%|min|mins|minutes?|hours?|capsules?|tablets?|pills?|scoops?|servings?|caps?|tabs?|chapters?)\b/;

/** The clock times a text states (see WriteGrant.clock). */
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

// ---------------------------------------------------------------------------------------------------------------
// Sentences
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

/** Marks a sentence as hypothetical, planned or uncertain: never a report. */
const HYPOTHETICAL =
  /\b(if|whether|wonder|maybe|might|would|should|could|planning|plan to|going to|gonna|tomorrow|later|will|want to|wanna|thinking about|supposed to|need to|needs to|meant to|have to|has to|did i|didn't i|have i|should i)\b/;

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

/** A short "yes" (thanks alone is not one): an affirmative first, then more affirmatives or thanks. */
const CONFIRMATION =
  /^(?:yes|yeah|yep|yup|sure|ok|okay|please do|please|do it|go ahead|go for it|sounds good|correct|that's right|confirmed?|log it|save it|create it|make it|record it|mark it|add it|do that)(?:[\s,.!]+(?:yes|yeah|yep|yup|sure|ok|okay|please do|please|do it|go ahead|go for it|sounds good|correct|that's right|confirmed?|log it|save it|create it|make it|record it|mark it|add it|do that|thanks|thank you|perfect|great|that one))*[\s,.!]*$/;

/** Sentences of `text` that ask for or report a write; `offer` = every non-empty sentence of an accepted offer. */
function intentSentences(text: string): IntentSentence[] {
  const masked = maskQuotes(text);
  const out: IntentSentence[] = [];
  for (const [start, end, term] of sentenceRanges(masked)) {
    const visible = norm(masked.slice(start, end)).trim().replace(/^[\s,:-]+/, "");
    const imperative = IMPERATIVE.test(visible);
    // A report phrased as a question ("I had two coffees, is that why…?") is a question, not a logging request.
    const report = term !== "?" && isReport(visible);
    if (imperative || report) out.push({ text: text.slice(start, end), imperative });
  }
  return out;
}

/** The question sentences of the assistant turn a "yes" answers: what was offered. */
function offeredSentences(text: string): IntentSentence[] {
  return sentenceRanges(text)
    .filter(([, , term]) => term === "?")
    .map(([start, end]) => ({ text: text.slice(start, end), imperative: true }));
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
  const offer = previous ? offeredSentences(previous) : [];
  const confirmed = short.length > 0 && short.length <= 48 && CONFIRMATION.test(short) && offer.length > 0;
  const sentences = confirmed ? offer : intentSentences(latest);
  const stated = sentences.map((s) => s.text).join("\n") + (confirmed ? "" : "\n" + maskQuotes(latest));
  const answered = confirmed && messages.length > 2 && messages[messages.length - 3].role === "user" ? messages[messages.length - 3].content : "";
  return {
    off: opts.off === true,
    latest,
    ownWords: answered ? `${answered}\n${latest}` : latest,
    stated: norm(stated),
    sentences,
    confirmed,
    quizAsked: messages.some((m) => m.role === "user" && /\bquiz(?:zes|zed|zing)?\b|\btest me\b/.test(norm(maskQuotes(m.content)))),
    statesDay: DAY_WORDS.test(norm(stated)),
    clock: clockTimes(stated),
    numbers: numbersIn(stated),
  };
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

const deny = (code: RefusalCode): WriteDecision => ({ allowed: false, code, reason: REFUSAL_TEXT[code] });
const ALLOW: WriteDecision = { allowed: true };

/** The day before a YYYY-MM-DD date. */
function dayBefore(day: string): string | null {
  const t = Date.parse(`${day}T12:00:00Z`);
  return Number.isFinite(t) ? new Date(t - 86_400_000).toISOString().slice(0, 10) : null;
}

const READING = /\b(read|reading|listened|listening|chapters?|book|audiobook|session|pages?)\b/;
const FINISHED_BOOK = /\b(finished|completed|done with)\b[^.!?]*\bbook\b/;
const HIGHLIGHT = /\b(highlight|quote|passage|line|excerpt|save|keep|note)\b/;
const PLAYLIST_VERB = /\b(create|make|build|generate|save|start|put together|turn)\b/;

/** A "HH:MM" time the model sends was stated: the same hour (and minutes, when they were said). */
function timeStated(time: string, grant: WriteGrant): boolean {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return false;
  const h = Number(m[1]);
  return grant.clock.has(`${h}:${m[2]}`) || grant.clock.has(`${h}:*`);
}

/** The text a call must name its record in: the sentences that ask for or report a write. */
const intentText = (grant: WriteGrant, filter: (s: IntentSentence) => boolean = () => true) =>
  grant.sentences.filter(filter).map((s) => s.text).join("\n");

/**
 * Whether one write-tool call may run. `used` counts the calls of each tool already allowed in this request (the
 * caller adds one after an allowed call); `requestDay` is the behavioral day the request runs on.
 */
export function authorizeWrite(
  grant: WriteGrant,
  tool: WriteToolName,
  input: Record<string, unknown>,
  ctx: { requestDay: string; used: ReadonlyMap<string, number> },
): WriteDecision {
  if (grant.off) return deny("writes_off");

  // A quiz result closes a quiz the user asked for: the latest message is usually just their last answer.
  if (tool === "record_reading_quiz") {
    if (!grant.quizAsked) return deny("quiz_not_asked");
    if ((ctx.used.get(tool) ?? 0) >= 1) return deny("once_per_request");
    return ALLOW;
  }

  if (grant.sentences.length === 0) return deny("no_request");
  const said = intentText(grant);

  // An explicitly stated other day; today needs no words, nor does yesterday for a habit (sleep questions describe
  // last night and are stored on yesterday).
  const date = str(input.date);
  if (date && date !== ctx.requestDay && !grant.statesDay) {
    if (!(tool === "mark_habit_complete" && date === dayBefore(ctx.requestDay))) return deny("day_not_stated");
  }

  switch (tool) {
    case "create_spotify_playlist": {
      const asked = intentText(grant, (s) => s.imperative);
      if (!/\bplaylists?\b/.test(norm(asked)) || !PLAYLIST_VERB.test(norm(asked))) return deny("playlist_not_requested");
      if ((ctx.used.get(tool) ?? 0) >= 1) return deny("once_per_request");
      return ALLOW;
    }

    case "mark_habit_complete": {
      const habit = str(input.habit);
      if (!habit || !names(habit, said, true)) return deny("not_named");
      return ALLOW;
    }

    case "log_supplement_stack": {
      const stack = str(input.stack);
      if (!stack) return deny("not_named");
      const specific = significant(stack);
      // "my morning stack" names the stack; "my stack" with no name names a stack only when it has no other words.
      if (specific.length > 0 ? !names(stack, said) : !/\bstack\b/.test(norm(said))) return deny("not_named");
      return ALLOW;
    }

    case "log_supplement_intake": {
      const product = str(input.product);
      if (!product || !names(product, said)) return deny("not_named");
      const amount = num(input.amount);
      if (amount != null && amount !== 1 && !grant.numbers.has(amount)) return deny("amount_not_stated");
      const times = Array.isArray(input.times) ? input.times : [];
      for (const t of times) if (typeof t !== "string" || !timeStated(t, grant)) return deny("time_not_stated");
      return ALLOW;
    }

    case "log_reading_session": {
      if (!READING.test(norm(said)) && !FINISHED_BOOK.test(norm(said))) return deny("no_request");
      const through = num(input.chapter_through);
      if (through == null || !(grant.numbers.has(through) || FINISHED_BOOK.test(norm(said)))) return deny("not_named");
      const from = num(input.chapter_from);
      if (from != null && from !== through && !grant.numbers.has(from)) return deny("not_named");
      const minutes = num(input.minutes);
      if (minutes != null && !grant.numbers.has(minutes) && !grant.numbers.has(minutes / 60)) return deny("amount_not_stated");
      for (const field of ["recall", "question"]) {
        const text = str(input[field]);
        if (text && coverage(text, grant.ownWords) < 0.8) return deny("not_your_words");
      }
      return ALLOW;
    }

    case "add_book_highlight": {
      if (!HIGHLIGHT.test(norm(said))) return deny("no_request");
      const passage = str(input.passage);
      if (!passage || coverage(passage, grant.ownWords) < 0.8 || significant(passage).length === 0) return deny("not_your_words");
      const comment = str(input.comment);
      if (comment && coverage(comment, grant.ownWords) < 0.6) return deny("not_your_words");
      return ALLOW;
    }

    // A write tool added without a rule here is refused, never allowed by default.
    default:
      return deny("no_request");
  }
}
