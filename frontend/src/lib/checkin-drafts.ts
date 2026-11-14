import type { CheckinAnswer, CheckinPayload } from "./checkin";
import { draftSettled, draftWith, parseDraft, type Draft, type Patch } from "./checkin-cells";

export const dayDraftKey = (date: string) => `onyx:checkin:${date}`;
export const nightDraftKey = (date: string) => `onyx:checkin:night:${date}`;
export type DatedDraft = { key: string; date: string; night: boolean; draft: Draft };
type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

function draftDate(key: string) {
  const match = /^onyx:checkin:(night:)?(\d{4}-\d{2}-\d{2})$/.exec(key);
  if (!match || !Number.isFinite(Date.parse(`${match[2]}T12:00:00Z`))) return null;
  return { date: match[2], night: !!match[1] };
}

/** A recovery action may only use the original date and the questions currently offered for that part. */
export function recoveryTarget(entry: DatedDraft, page: CheckinPayload | null) {
  if (!page) return null;
  const night = page.nights?.find((n) => n.date === entry.date);
  if (entry.night ? !night || entry.date >= page.today : entry.date !== page.date) return null;
  if (!page.days.some((d) => d.date === entry.date)) return null;
  const names = new Set(page.items.filter((i) => i.sleep === entry.night).map((i) => i.name));
  if (Object.keys(entry.draft).some((name) => !names.has(name))) return null;
  return { saved: entry.night ? night!.answers : page.answers };
}

/**
 * Local drafts only; never submits anything. Healthy storage is reread so another tab's taps survive.
 * After a storage failure memory is authoritative (including empty tombstones), so a failed write/removal
 * cannot resurrect settled answers or erase pending taps.
 * Reopened drafts require explicit dated review. The existing storage keys and Draft format are unchanged.
 */
export class CheckinDraftStore {
  private memory = new Map<string, Draft>();
  private held = new Set<string>();
  private unread = new Set<string>();
  private memoryOnly = new Set<string>();
  private today: string | null = null;
  storageFailed = false;

  constructor(private storage: () => DraftStorage) {}

  read(key: string): Draft {
    if (!this.memoryOnly.has(key)) {
      const previous = this.memory.get(key);
      let draft = previous ?? {};
      try {
        draft = parseDraft(JSON.parse(this.storage().getItem(key) || "{}"));
        // Preserve snapshot identity for unchanged entries; newer taps still get a new object.
        for (const [name, entry] of Object.entries(draft)) {
          const old = previous?.[name];
          if (old && old.a === entry.a && old.base === entry.base) draft[name] = old;
        }
      } catch {
        this.storageFailed = true;
        this.unread.add(key);
        this.memoryOnly.add(key);
      }
      this.memory.set(key, draft);
      if (!previous && Object.keys(draft).length) this.held.add(key);
    }
    return this.memory.get(key)!;
  }

  private store(key: string, draft: Draft) {
    this.memory.set(key, draft);
    // Never overwrite an existing record we could not read (including malformed JSON).
    if (this.unread.has(key)) return;
    try {
      if (Object.keys(draft).length) this.storage().setItem(key, JSON.stringify(draft));
      else this.storage().removeItem(key);
    } catch { this.storageFailed = true; this.memoryOnly.add(key); }
  }

  scan() {
    try {
      const storage = this.storage();
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (key && draftDate(key)) this.read(key);
      }
    } catch { this.storageFailed = true; }
  }

  holdAll() {
    for (const [key, draft] of this.memory) if (Object.keys(draft).length) this.held.add(key);
  }

  prepare(page: CheckinPayload) {
    this.scan();
    if (this.today && this.today !== page.today) this.holdAll();
    this.today = page.today;
    const saved = new Map<string, Record<string, CheckinAnswer>>([
      [dayDraftKey(page.date), page.answers],
      ...(page.nights ?? []).map((n) => [nightDraftKey(n.date), n.answers] as const),
    ]);
    for (const key of saved.keys()) this.read(key);
    for (const [key, draft] of this.memory) {
      const answers = saved.get(key);
      if (Object.keys(draft).length && (!answers || Object.entries(draft).some(([name, e]) => e.base !== undefined && e.base !== (answers[name] ?? null)))) this.held.add(key);
    }
  }

  needsReview(key: string) { return this.held.has(key) && Object.keys(this.read(key)).length > 0; }
  active(key: string): Draft {
    const draft = this.read(key);
    return this.needsReview(key) ? {} : draft;
  }

  write(key: string, patch: Patch, saved: Record<string, CheckinAnswer>) {
    const draft = this.read(key);
    if (this.needsReview(key)) return false;
    this.held.delete(key); // an empty, previously held part accepts fresh taps normally
    this.store(key, draftWith(draft, patch, saved));
    return true;
  }

  settle(key: string, posted: Patch, sent: Draft) {
    this.store(key, draftSettled(this.read(key), posted, sent));
  }

  recover(key: string, page: CheckinPayload): boolean {
    const identity = draftDate(key);
    if (!identity) return false;
    const draft = this.read(key);
    const target = recoveryTarget({ key, ...identity, draft }, page);
    if (!target) return false;
    const patch = Object.fromEntries(Object.entries(draft).map(([name, entry]) => [name, entry.a]));
    // Explicit review adopts the current baseline; the original day/night date never changes.
    this.store(key, draftWith({}, patch, target.saved));
    this.held.delete(key);
    return true;
  }

  discard(key: string) {
    this.store(key, {});
    this.held.delete(key);
  }

  recovery(): DatedDraft[] {
    return [...this.memory].flatMap(([key, draft]) => {
      const identity = draftDate(key);
      return identity && this.needsReview(key) ? [{ key, ...identity, draft }] : [];
    }).sort((a, b) => a.key.localeCompare(b.key));
  }

  hasPending() { return [...this.memory.values()].some((draft) => Object.keys(draft).length > 0); }
}
