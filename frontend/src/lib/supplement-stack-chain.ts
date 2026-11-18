import { AutosaveRefused, plainSaveFailure } from "@/lib/autosave";

/**
 * The stack editor's side of the versioned save (audit PROD-07; server: lib/supplement-stack-save.ts and
 * sql/supplement_stack_atomic_save.sql). No React, no DOM: tests/supplement-stack-save.test.cjs.
 *
 * Each save carries:
 *  - expected_version: the version the editor last saw (from GET, then from each successful save);
 *  - save_id: a UUID per save. A resend of the same body whose answer never came keeps its id, so the server can
 *    answer it as a replay instead of writing it twice;
 *  - after_save_ids: the earlier saves whose answer never came. The server accepts a save when the stack is still at
 *    expected_version, or when its last write was one of these (then every write since was this editor's own).
 * Anything else means another window (or a late request) changed the stack: the server answers 409 and the editor
 * offers to load the latest version instead of overwriting it. An update with a save_id but no version is refused by
 * the server (409 "reload"), handled the same way; the editor reads the stack's version before such a save (see
 * components/StackEditorModal.tsx), so this happens only when the server has no versions at all.
 */

export interface StackSaveFields {
  save_id: string;
  expected_version: number | null;
  after_save_ids: string[];
}

/** At most this many unanswered saves are remembered (a longer outage can only cause a false 409, never a lost edit). */
export const STACK_PENDING_MAX = 20;

export class StackSaveChain {
  private version: number | null;
  private pending: { id: string; body: string }[] = [];
  private newId: () => string;

  constructor(version: number | null | undefined, newId: () => string) {
    this.version = typeof version === "number" && Number.isSafeInteger(version) && version > 0 ? version : null;
    this.newId = newId;
  }

  /** The version the editor last saw (null = not known yet: a new stack, or a server without versions). */
  get knownVersion(): number | null {
    return this.version;
  }

  /** Saves sent whose outcome is unknown (offline, server error). */
  get unanswered(): string[] {
    return this.pending.map((p) => p.id);
  }

  /** Fields for the next request carrying `body`. */
  next(body: unknown): StackSaveFields {
    const json = JSON.stringify(body);
    const last = this.pending[this.pending.length - 1];
    let id: string;
    if (last && last.body === json) {
      id = last.id; // a resend of the newest unanswered save: same id, so a save that went through is not repeated
    } else {
      id = this.newId();
      this.pending.push({ id, body: json });
      if (this.pending.length > STACK_PENDING_MAX) this.pending.shift();
    }
    return { save_id: id, expected_version: this.version, after_save_ids: this.pending.filter((p) => p.id !== id).map((p) => p.id) };
  }

  /** A version read from the server, taken only when this editor holds none yet (pending saves are kept). */
  learnVersion(version: unknown): void {
    if (this.version === null && typeof version === "number" && Number.isSafeInteger(version) && version > 0) this.version = version;
  }

  /** The server saved it (or recognised it as already saved): this is now the version the editor holds. */
  accepted(version: unknown): void {
    if (typeof version === "number" && Number.isSafeInteger(version) && version > 0) this.version = version;
    this.pending = [];
  }

  /** The server refused it (4xx): it wrote nothing, so it can never be the stack's last write. */
  refused(fields: StackSaveFields): void {
    this.pending = this.pending.filter((p) => p.id !== fields.save_id);
  }
}

/** The server answered 409 stale: the stack changed somewhere else since this editor loaded it. */
export class StackConflict extends AutosaveRefused {
  constructor(message: string) {
    super(message);
    this.name = "StackConflict";
  }
}

/** The guidance the editor shows when the stack changed somewhere else (its conflict panel offers the same action). */
export const STACK_CHANGED_ELSEWHERE = "This stack was changed somewhere else. Load the latest version, then make your change again.";

/**
 * The autosave status text for a failed stack save (the editor's describeError): a conflict keeps its own guidance,
 * every other failure gets the fixed plain copy (no server words).
 */
export function stackSaveFailureText(e: unknown): string {
  return e instanceof StackConflict ? STACK_CHANGED_ELSEWHERE : plainSaveFailure(e);
}

/** Shown when no clear answer came back (mirrors STACK_UNCONFIRMED_MESSAGE in lib/supplement-stack-save.ts). */
export const STACK_UNCONFIRMED_TEXT =
  "No clear answer came back, so this change may or may not have been saved. Retry sends the same save again; it is never saved twice.";

/**
 * No clear answer came back (the request failed in transit, the server said "unconfirmed", a gateway error page, or a
 * reply that is not a saved stack): the save may have gone through. NOT a refusal, so autosave retries it and shows
 * Retry; the save id stays unanswered, so the resend carries the same id and a save that went through is answered as
 * a replay, never written twice.
 */
export class StackSaveUnconfirmed extends Error {
  constructor(message: string = STACK_UNCONFIRMED_TEXT) {
    super(message);
    this.name = "StackSaveUnconfirmed";
  }
}

/**
 * For the editor's Autosaver (lib/autosave.ts unknownOutcome): after an unconfirmed save the stack may hold that value,
 * so changing back to the values the editor loaded is sent too (as the newest save, after the unanswered one) instead
 * of being dropped as "unchanged" while the unwanted change stays stored.
 */
export function stackSaveUnknownOutcome(e: unknown): boolean {
  return e instanceof StackSaveUnconfirmed;
}

const isPositiveInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

/**
 * The editor's fetch: like lib/autosave.ts saveRequest (a 4xx is a refusal, a 5xx or a network failure is retried),
 * plus a StackConflict for the 409 stale / reload answers. A 503 "not_set_up" (the database function is missing) is a
 * refusal too: nothing was written and retrying cannot help until the migration is applied, so the editor shows the
 * message with Retry instead of retrying on its own. A 503 "conflict" wrote nothing and is retried as it is. Every
 * other failure where the outcome is not known (no answer at all, a 5xx that is not one of those, a 408 / 429 from
 * something between the browser and the route, a success whose body is not a saved stack) is a StackSaveUnconfirmed:
 * retried with the same save id, never "nothing was changed".
 * Answers the parsed JSON of a successful save.
 */
export async function stackSaveRequest(
  method: "POST" | "PATCH",
  body: Record<string, unknown>,
  keepalive: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetchImpl("/api/supplements/stacks", {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      keepalive,
    });
  } catch {
    throw new StackSaveUnconfirmed(); // offline, or the connection dropped: the request may have reached the server
  }
  const parsed: unknown = await res.json().catch(() => null);
  const json = (parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}) as Record<string, unknown>;
  if (res.ok) {
    // A success must name the saved stack; anything else (a cut-off or foreign reply) leaves the outcome unknown.
    if (!isPositiveInt(json.stack_id)) throw new StackSaveUnconfirmed();
    return json;
  }
  const text = typeof json.error === "string" && json.error ? json.error : `Save failed (${res.status}).`;
  if (res.status === 409 && (json.code === "stale" || json.code === "reload")) throw new StackConflict(text);
  if (res.status === 503 && json.code === "not_set_up") throw new AutosaveRefused(text);
  if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) throw new AutosaveRefused(text);
  if (res.status === 503 && json.code === "conflict") throw new Error(text); // two saves met; nothing was written
  // 408 / 429 never come from the route; whatever sent one may have done so after forwarding the save. Not known.
  throw new StackSaveUnconfirmed(json.code === "unconfirmed" && typeof json.error === "string" && json.error ? json.error : STACK_UNCONFIRMED_TEXT);
}
