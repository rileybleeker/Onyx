// Pure rules of the /check-in "Say it once" box (POST /api/habits/checkin/voice): request checks, the allowed
// question list, and the validator for what the model returns. No network, no database, no React, so they are
// tested for real (frontend/tests/checkin-voice.test.cjs). The route only READS: it never writes an answer.
import { SLEEP_QUESTIONS, type CheckinAnswer, type CheckinItem } from "./checkin";

export const VOICE_MAX_TEXT_CHARS = 4000;
export const VOICE_MAX_BODY_BYTES = 8 * 1024;

type HeaderGetter = { get(name: string): string | null };

/** CSRF + shape checks before the body is read: same-origin Origin, JSON content type, small body. */
export function checkVoiceRequest(headers: HeaderGetter, requestOrigin: string): { status: number; error: string } | null {
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
  if (len != null && (!/^[0-9]+$/.test(len) || Number(len) > VOICE_MAX_BODY_BYTES)) return { status: 413, error: "body too large" };
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

/** The questions the box may fill: the day's daytime questions only. Sleep answers belong to a night, never a day. */
export function voiceQuestionNames(items: CheckinItem[]): string[] {
  return items.filter((i) => !i.sleep && !SLEEP_QUESTIONS.has(i.name)).map((i) => i.name);
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

export type VoiceResult = { answers: Record<string, CheckinAnswer> } | { failed: true };

/** Runs the model call and validates it. Any throw or unusable output becomes {failed: true}: nothing is filled. */
export async function voiceResult(ask: () => Promise<unknown>, allowedNames: Iterable<string>): Promise<VoiceResult> {
  try {
    const answers = parseVoiceAnswers(await ask(), allowedNames);
    return answers ? { answers } : { failed: true };
  } catch {
    return { failed: true };
  }
}
