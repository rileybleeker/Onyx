// The autosaving reading forms (/log Reading, /reading "Log a session" and "Highlight + comment"), pure parts: what
// a form's fields are worth as a request, and why it cannot be sent yet. No React, no fetch; tested in
// tests/reading-autosave.test.cjs. The first save of a form creates (POST), every later one edits the same row
// (PATCH /api/reading/sessions/[id], PATCH /api/reading/highlights/[id]): readingSaveTarget.
import type { HighlightSource, Medium } from "./reading";

export interface SessionFields {
  from: string;
  through: string;
  minutes: string;
  recall: string;
  question?: string;
  medium: Medium;
}

/** The body POST /api/reading/sessions and PATCH /api/reading/sessions/[id] both take. */
export interface SessionBody {
  book: string;
  /** Only when Riley (or his Say it words) chose a day; null = the server's behavioral today (or, on an edit, the session's own day). */
  date: string | null;
  chapter_from: number | null;
  chapter_through: number;
  minutes: number | null;
  medium: Medium;
  recall: string;
  question?: string;
}

/** What the autosaver holds: a body to send, or the reason there is none yet. */
export type SessionValue = { body: SessionBody | null; reason: string | null };

const isYmd = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s);

/**
 * The session the fields describe. `total` = the book's chapter count when known (null for another book than the
 * one on screen: the server checks it). Same rules and messages the old Save button used.
 */
export function sessionValue(f: SessionFields, ctx: { book: string; chosenDay: string | null; today: string; total: number | null }): SessionValue {
  const no = (reason: string): SessionValue => ({ body: null, reason });
  const throughText = f.through.trim();
  const through = Number(throughText);
  if (throughText === "" || !/^\d+$/.test(throughText) || !Number.isInteger(through)) return no("Enter the chapter you read through to save.");
  if (ctx.total && through > ctx.total) return no(`This book has ${ctx.total} chapters.`);
  const fromText = f.from.trim();
  const from = fromText === "" ? null : Number(fromText);
  if (from !== null && (!/^\d+$/.test(fromText) || from > through)) return no("The first chapter must be at most the last one.");
  const minText = f.minutes.trim();
  const minutes = minText === "" ? null : Number(minText);
  if (minutes !== null && (!Number.isFinite(minutes) || minutes < 0)) return no("Minutes must be 0 or more.");
  if (ctx.chosenDay !== null && (!isYmd(ctx.chosenDay) || (ctx.today && ctx.chosenDay > ctx.today))) return no("Pick today or an earlier day.");
  const body: SessionBody = {
    book: ctx.book,
    date: ctx.chosenDay,
    chapter_from: from,
    chapter_through: through,
    minutes: minutes === null ? null : Math.round(minutes),
    medium: f.medium,
    recall: f.recall,
  };
  if (f.question !== undefined) body.question = f.question;
  return { body, reason: null };
}

/** Two values send the same request (the reason text alone never triggers a save). */
export const sameReadingValue = <T extends { body: unknown }>(a: T, b: T) => JSON.stringify(a.body) === JSON.stringify(b.body);

/** Nothing typed or tapped yet: such a form is never sent (and an incomplete one is not "unsaved work"). */
export function isBlankSession(f: SessionFields, defaults: { medium: Medium }): boolean {
  return !f.from.trim() && !f.through.trim() && !f.minutes.trim() && !f.recall.trim() && !(f.question ?? "").trim() && f.medium === defaults.medium;
}

/** First save creates, later saves edit the row the first one made. */
export function readingSaveTarget(kind: "sessions" | "highlights", id: number | null): { url: string; method: "POST" | "PATCH" } {
  return id === null ? { url: `/api/reading/${kind}`, method: "POST" } : { url: `/api/reading/${kind}/${id}`, method: "PATCH" };
}

export interface HighlightFields {
  passage: string;
  comment: string;
  chapter: string;
  concept: string;
  source: HighlightSource;
}

export interface HighlightBody {
  book?: string;
  passage: string;
  comment: string;
  chapter: number | null;
  concept: string | null;
  source: HighlightSource;
}

export type HighlightValue = { body: HighlightBody | null; reason: string | null };

/** The highlight the fields describe: sent once the passage is not empty. `book` only on the create. */
export function highlightValue(f: HighlightFields): HighlightValue {
  const passage = f.passage.trim();
  if (!passage) return { body: null, reason: "Add the passage to save." };
  const chText = f.chapter.trim();
  const chapter = chText === "" ? null : Number(chText);
  if (chapter !== null && (!/^\d+$/.test(chText) || !Number.isInteger(chapter))) return { body: null, reason: "The chapter must be a whole number." };
  return { body: { passage, comment: f.comment, chapter, concept: f.concept.trim() || null, source: f.source }, reason: null };
}

/** A random UUID v4: the idempotency key of one new session (POST /api/reading/sessions `client_key`). */
export function newClientKey(rand: (bytes: Uint8Array) => Uint8Array = (b) => globalThis.crypto.getRandomValues(b)): string {
  const b = rand(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * The highlight a create answered with is this form's own when the form sent the same passage before without
 * hearing back (a lost answer: the retry finds the row the first send made), and the row is no older than that
 * first send (two minutes of clock slack). Otherwise it was saved before (e.g. by the Kindle harvester).
 */
export function ownRetriedHighlight(
  row: { passage?: string; created_at?: string },
  unconfirmed: { passage: string; at: number } | null,
  slackMs = 120_000,
): boolean {
  if (!unconfirmed || !row.passage || row.passage !== unconfirmed.passage) return false;
  const created = row.created_at ? Date.parse(row.created_at) : NaN;
  return Number.isFinite(created) && created >= unconfirmed.at - slackMs;
}
