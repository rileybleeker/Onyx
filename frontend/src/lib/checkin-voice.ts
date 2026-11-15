// Pure rules of the /check-in "Say it once" box (POST /api/habits/checkin/voice): request checks, the allowed
// question lists (daytime, and last night's sleep), the validator for what the model returns, and the iPhone
// Shortcut hand-off (#say=). No network, no database, no React, so they are tested for real
// (frontend/tests/checkin-voice.test.cjs). The route only READS: it never writes an answer or a journal entry.
import { SLEEP_QUESTIONS, sleepDateError, type CheckinAnswer, type CheckinItem } from "./checkin";
import { journalDraftFrom, type JournalDraft } from "./journal-entry";

export const VOICE_MAX_TEXT_CHARS = 4000;
export const VOICE_MAX_BODY_BYTES = 8 * 1024;

type HeaderGetter = { get(name: string): string | null };

/** CSRF + shape checks before the body is read: same-origin Origin, JSON content type, small body. */
export function checkVoiceRequest(headers: HeaderGetter, requestOrigin: string, maxBytes: number = VOICE_MAX_BODY_BYTES): { status: number; error: string } | null {
  const origin = headers.get("origin");
  if (!origin) return { status: 403, error: "missing Origin" };
  let o: URL;
  let r: URL;
  try {
    o = new URL(origin);
    r = new URL(requestOrigin);
  } catch {
    return { status: 403, error: "bad Origin" };
  }
  const hosts = [headers.get("x-forwarded-host"), headers.get("host"), r.host].filter(Boolean);
  if (!hosts.includes(o.host)) return { status: 403, error: "cross-origin request refused" };
  const type = (headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (type !== "application/json") return { status: 415, error: "Content-Type must be application/json" };
  const len = headers.get("content-length");
  if (len != null && (!/^[0-9]+$/.test(len) || Number(len) > maxBytes)) return { status: 413, error: "body too large" };
  return null;
}

/** The dictated text from a parsed body: trimmed, 1 to VOICE_MAX_TEXT_CHARS characters. */
export function parseVoiceText(raw: unknown): { ok: true; text: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "text must be a string" };
  const text = raw.trim();
  if (!text) return { ok: false, error: "text is empty" };
  if (text.length > VOICE_MAX_TEXT_CHARS) return { ok: false, error: `text must be at most ${VOICE_MAX_TEXT_CHARS} characters` };
  return { ok: true, text };
}

/** The questions the box may fill for the DAY: the daytime questions only. Sleep answers belong to a night, never a day. */
export function voiceQuestionNames(items: CheckinItem[]): string[] {
  return items.filter((i) => !i.sleep && !SLEEP_QUESTIONS.has(i.name)).map((i) => i.name);
}

/** The sleep questions the box may fill for LAST NIGHT (the newest finished night, sleepAnswerDate(today)). */
export function voiceSleepNames(items: CheckinItem[]): string[] {
  return items.filter((i) => i.sleep || SLEEP_QUESTIONS.has(i.name)).map((i) => i.name);
}

/**
 * The model's JSON ({answers: [{question, answer}]}, as an object or as text) -> the answers worth showing.
 * Keeps only exact allowed names with exactly Yes or No; the first answer for a question wins; a sleep question is
 * dropped even if the list allowed it. Returns null when the output is not the expected shape at all.
 */
export function parseVoiceAnswers(raw: unknown, allowedNames: Iterable<string>): Record<string, CheckinAnswer> | null {
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  const list = (parsed as { answers?: unknown } | null)?.answers;
  if (!Array.isArray(list)) return null;
  const allowed = new Set(allowedNames);
  const out: Record<string, CheckinAnswer> = {};
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const { question, answer } = item as { question?: unknown; answer?: unknown };
    if (typeof question !== "string" || !allowed.has(question) || SLEEP_QUESTIONS.has(question)) continue;
    if (answer !== "Yes" && answer !== "No") continue;
    if (Object.prototype.hasOwnProperty.call(out, question)) continue; // first answer wins
    out[question] = answer;
  }
  return out;
}

/**
 * The model's sleep answers ({sleep_answers: [{question, answer}]}) for `night` -> the ones worth showing. Only exact
 * allowed SLEEP questions with exactly Yes or No; the first answer wins. Nothing at all unless `night` is a night
 * that already happened (sleepDateError: a sleep answer dated behavioral today or later would describe tonight).
 */
export function parseSleepAnswers(raw: unknown, allowedNames: Iterable<string>, night: string, today: string): Record<string, CheckinAnswer> {
  const list = (raw as { sleep_answers?: unknown } | null)?.sleep_answers;
  const out: Record<string, CheckinAnswer> = {};
  if (!Array.isArray(list)) return out;
  const allowed = new Set(allowedNames);
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const { question, answer } = item as { question?: unknown; answer?: unknown };
    if (typeof question !== "string" || !allowed.has(question) || !SLEEP_QUESTIONS.has(question)) continue;
    if (answer !== "Yes" && answer !== "No") continue;
    if (sleepDateError(question, night, today, answer)) continue;
    if (Object.prototype.hasOwnProperty.call(out, question)) continue; // first answer wins
    out[question] = answer;
  }
  return out;
}

/** Last night's part of a voice request: which questions, and which night (its date) with the behavioral today. */
export interface VoiceNight {
  names: Iterable<string>;
  date: string;
  today: string;
}

export type VoiceResult =
  | {
      answers: Record<string, CheckinAnswer>;
      /** Sleep answers for last night, stored under that night's date. null when no sleep question was asked. */
      night: { date: string; answers: Record<string, CheckinAnswer> } | null;
      /** Labels for a journal entry of the same words. The body is the text itself, never the model's. */
      journal: JournalDraft;
    }
  | { failed: true };

/**
 * Runs the model call and validates it. Any throw, or output without the daytime answers list, becomes
 * {failed: true}: nothing is filled. Missing sleep answers or journal labels just mean none (blank labels).
 */
export async function voiceResult(ask: () => Promise<unknown>, allowedNames: Iterable<string>, night?: VoiceNight): Promise<VoiceResult> {
  try {
    let raw = await ask();
    if (typeof raw === "string") raw = JSON.parse(raw);
    const answers = parseVoiceAnswers(raw, allowedNames);
    if (!answers) return { failed: true };
    const journal = journalDraftFrom((raw as { journal?: unknown }).journal);
    if (!night) return { answers, night: null, journal };
    return { answers, night: { date: night.date, answers: parseSleepAnswers(raw, night.names, night.date, night.today) }, journal };
  } catch {
    return { failed: true };
  }
}

/**
 * The iPhone Shortcut hand-off: /check-in#say=<URL-encoded text> puts the words in the box. A fragment never reaches
 * the server, so no request log holds them. Returns the text (trimmed, capped), or null when the hash is not one.
 */
export function sayFromHash(hash: string): string | null {
  const m = /^#say=([\s\S]*)$/.exec(hash);
  if (!m) return null;
  let text: string;
  try {
    text = decodeURIComponent(m[1].replace(/\+/g, "%20"));
  } catch {
    return null;
  }
  text = text.trim().slice(0, VOICE_MAX_TEXT_CHARS).trim();
  return text || null;
}
