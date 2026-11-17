import type { ReadingOverview } from "./reading";

/**
 * The receipt a Reading removal must answer before the /log form lets an entry go (PROD-T01, Codex T01-R8).
 * Import-free (types only), so the form and its tests can use it without the server code.
 *
 * A removal is confirmed only by:
 *  - DELETE /api/reading/sessions/[id]: 200 { success: true, removed: <that id> }, or 404 { code: "session_gone" }
 *    (the session is gone and no removal of it is on record);
 *  - DELETE /api/reading/sessions?client_key=: 200 { success: true, discarded: true, client_key: <that key>,
 *    removed: <id> | null }.
 * Anything else, including a 200 whose body is empty, not JSON, or missing those fields, a redirect (a sign-in page),
 * or a 404 page from somewhere else, is "unconfirmed" and retried: the entry, its draft and its key stay. A definite
 * refusal (a 4xx other than 408 / 429, with or without our JSON) is shown and not retried.
 */
export const SESSION_GONE_CODE = "session_gone";

export type RemovalReply =
  | { kind: "confirmed"; overview: ReadingOverview | null | undefined }
  | { kind: "refused"; error: string }
  | { kind: "unconfirmed"; error: string; why?: string };

export type RemovalTarget = { sessionId: number } | { clientKey: string };

type ReplyShape = {
  ok: boolean;
  status: number;
  redirected?: boolean;
  text: () => Promise<string>;
};

function objectOf(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function overviewOf(v: unknown): ReadingOverview | null | undefined {
  if (v === null) return null;
  return v && typeof v === "object" && !Array.isArray(v) ? (v as ReadingOverview) : undefined;
}

export function removalReceipt(
  res: { ok: boolean; status: number; redirected?: boolean },
  body: Record<string, unknown> | null,
  target: RemovalTarget,
  label = "Discard",
): RemovalReply {
  // `why` is for the tests and a debugger; the status line shows the plain sentence.
  const unconfirmed = (why: string): RemovalReply => ({ kind: "unconfirmed", error: "Onyx did not confirm it.", why });
  if (res.redirected) return unconfirmed("redirected");
  if (res.ok) {
    if (res.status !== 200 || !body || body.success !== true) return unconfirmed("no receipt");
    if ("sessionId" in target) {
      if (body.removed !== target.sessionId) return unconfirmed("another session");
    } else {
      const removed = body.removed;
      const removedOk = removed === null || (typeof removed === "number" && Number.isInteger(removed) && removed > 0);
      if (body.discarded !== true || body.client_key !== target.clientKey.toLowerCase() || !removedOk) return unconfirmed("no receipt");
    }
    return { kind: "confirmed", overview: overviewOf(body.overview) };
  }
  if (res.status === 404 && "sessionId" in target && body?.code === SESSION_GONE_CODE) return { kind: "confirmed", overview: undefined };
  const error = typeof body?.error === "string" && body.error ? body.error : `${label} failed (${res.status}).`;
  if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) return { kind: "refused", error };
  return { kind: "unconfirmed", error };
}

/** Reads the response once and checks it (removalReceipt). A body that cannot be read counts as no receipt. */
export async function readRemovalReply(res: ReplyShape, target: RemovalTarget, label = "Discard"): Promise<RemovalReply> {
  const text = await res.text().catch(() => null);
  return removalReceipt(res, objectOf(text), target, label);
}
