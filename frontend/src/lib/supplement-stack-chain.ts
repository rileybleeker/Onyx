import { AutosaveRefused } from "@/lib/autosave";

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
 * offers to load the latest version instead of overwriting it. An update the editor cannot give a version for (its
 * list was read before the migration) gets 409 "reload", handled the same way.
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

/**
 * The editor's fetch: like lib/autosave.ts saveRequest (a 4xx is a refusal, a 5xx or a network failure is retried),
 * plus a StackConflict for the 409 stale / reload answers. A 503 "not_set_up" (the database function is missing) is a
 * refusal too: nothing was written and retrying cannot help until the migration is applied, so the editor shows the
 * message with Retry instead of retrying on its own. Answers the parsed JSON of a successful save.
 */
export async function stackSaveRequest(
  method: "POST" | "PATCH",
  body: Record<string, unknown>,
  keepalive: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const res = await fetchImpl("/api/supplements/stacks", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    keepalive,
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok) return json;
  const text = typeof json.error === "string" && json.error ? json.error : `Save failed (${res.status}).`;
  if (res.status === 409 && (json.code === "stale" || json.code === "reload")) throw new StackConflict(text);
  if (res.status === 503 && json.code === "not_set_up") throw new AutosaveRefused(text);
  if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) throw new AutosaveRefused(text);
  throw new Error(text);
}
