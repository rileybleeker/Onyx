/**
 * Client data cache shared by every page (stale-while-revalidate).
 *
 * A page renders at once from the cached value, then revalidates against the server, which stays the source
 * of truth: every cached read is followed by a fetch, and an answer of "gone" (404 / 410 / 204, or a fetcher
 * returning null) removes the entry instead of keeping it. Rules (AGENTS.md, "Client cache"):
 *
 * - Persisted copies live in IndexedDB, scoped to the signed-in Supabase user and to CACHE_SCHEMA_VERSION:
 *   another user or another schema deletes the whole store before anything is read (attach()).
 * - Sensitive data (finance, procurement, medical, screen time, experiments, tokens and auth routes) is kept
 *   in memory only, so it is gone when the tab or app closes (isSensitiveKey()).
 * - Every entry carries a timestamp and a max age (7 days by default). Expired entries are deleted when read
 *   and by the sweep that runs at startup and once a day.
 * - The persisted store has a size cap (25 MB) with least-recently-used eviction; a quota error evicts and
 *   retries once, then gives up on that one entry. Nothing here throws into a page.
 * - Signing out, a 401 or a redirect to /login wipes everything (wipeClientData()).
 *
 * Import-free on purpose: tests/today-regression.cjs bundles this file by name and the unit tests run it in
 * plain node. The IndexedDB backend lives in client-cache-idb.ts.
 */

export const CACHE_SCHEMA_VERSION = 1;
export const CACHE_DB_NAME = "onyx-client-cache";
export const DEFAULT_MAX_AGE_MS = 7 * 24 * 3_600_000;
export const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
export const MEMORY_MAX_ENTRIES = 300;
export const SWEEP_EVERY_MS = 24 * 3_600_000;
/** How long a read waits for the persisted store to be attached before answering from memory only. */
export const READY_TIMEOUT_MS = 1500;

/** localStorage keys this app owns (wiped on sign-out). Anything else on the origin is left alone. */
export const APP_STORAGE_PREFIXES = ["onyx", "chartCard."];

// Keys whose data never touches the disk. URL keys are the GET path + query; other keys are "<area>:<name>".
const SENSITIVE: RegExp[] = [
  // journal: the personal journal's titles, moods and snippets (the /log Journal section's read).
  /^\/api\/(finance|procurement|medical|screen-time|spotify|focus|experiments|journal)(\/|\?|$)/,
  /^\/(financials|procurement|screen-time|health\/records)(\/|\?|$)/,
  /^(finance|procurement|medical|screen-time|spotify|experiments):/,
  /token|auth|secret|session|password|callback|exchange|credential|install/i,
];

/** Non-URL keys shared by a page and the warm-up (URL keys are the GET path + query itself). */
export const CACHE_KEYS = {
  agentsInbox: "agents:inbox",
  agentsThread: (thread: string) => `agents:thread:${thread}`,
  habitsJournal: "habits:journal:365",
  habitsHistory: "habits:history",
} as const;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE.some((re) => re.test(key));
}

export function isAppStorageKey(key: string): boolean {
  return APP_STORAGE_PREFIXES.some((p) => key.startsWith(p));
}

const NO_INVALIDATE = [
  "/api/habits/sync", // /habits re-reads what the sync changed and stores it
  "/api/habits/checkin/voice", // maps dictation to draft answers, writes nothing
  "/api/activities/suggest-tags", // proposals only
];

/**
 * Which cache entries a successful write makes stale. `/api/<area>/...` invalidates every `/api/<area>` key
 * and every `<area>:` key; agent Worker writes (`/onyx/...` on another origin) invalidate `agents:`.
 */
export function writeInvalidates(path: string): string[] {
  if (path.startsWith("/onyx/")) return ["agents:"];
  // POSTs that change no cached data, or whose page refreshes what changed itself.
  if (NO_INVALIDATE.includes(path)) return [];
  // A /habits tap: that page keeps its own cached journal in step (a 365-day re-read per tap would be waste);
  // the check-in screen and the habit list still re-read.
  if (path === "/api/habits/complete") return ["/api/habits/checkin", "/api/habits/list"];
  // Chat write tools log habits, supplements, reading and playlists.
  if (path === "/api/chat") return ["/api/habits", "habits:", "/api/supplements", "/api/reading", "/api/delivery"];
  const m = /^\/api\/([^/?#]+)/.exec(path);
  if (!m) return [];
  const area = m[1];
  const out = [`/api/${area}`, `${area}:`];
  // A check-in or habit write also changes what Today and the delivery portions show.
  if (area === "habits") out.push("/api/delivery");
  if (area === "delivery") out.push("/api/habits/checkin");
  return out;
}

/** True when a response means the session has ended: a 401, or a redirect to the login page. */
export function sessionEnded(res: { status?: number; redirected?: boolean; url?: string }): boolean {
  if (res.status === 401) return true;
  if (res.redirected && res.url) {
    try { return new URL(res.url, "https://onyx.invalid").pathname === "/login"; } catch { return false; }
  }
  return false;
}

/** True when the server says the resource no longer exists, or answered with no content. */
export function isGoneStatus(status: number | undefined): boolean {
  return status === 404 || status === 410 || status === 204;
}

export interface PersistedRow {
  key: string;
  /** When the value was fetched (ms since epoch). */
  at: number;
  maxAge: number;
  lastUsed: number;
  /** Approximate stored size in bytes. */
  size: number;
}

export interface CacheScope {
  userId: string;
  schema: number;
  lastSweep: number;
}

/** Storage behind the cache. client-cache-idb.ts implements it; tests use an in-memory fake. */
export interface CacheBackend {
  readScope(): Promise<CacheScope | null>;
  writeScope(scope: CacheScope): Promise<void>;
  listRows(): Promise<PersistedRow[]>;
  getValue(key: string): Promise<unknown>;
  put(row: PersistedRow, value: unknown): Promise<void>;
  touch(rows: PersistedRow[]): Promise<void>;
  remove(keys: string[]): Promise<void>;
  /** Delete the whole store (every row and the scope). The backend may be reused after this. */
  destroy(): Promise<void>;
}

export interface PutOptions {
  maxAgeMs?: number;
  /** false keeps this entry in memory only. Sensitive keys are never persisted whatever this says. */
  persist?: boolean;
  /** When the value was fetched; defaults to now. */
  at?: number;
}

export interface CacheOptions {
  now?: () => number;
  maxBytes?: number;
  defaultMaxAgeMs?: number;
  memoryMaxEntries?: number;
  readyTimeoutMs?: number;
  /** Runs persistence work off the critical path. Defaults to an idle callback. */
  schedule?: (task: () => void) => void;
}

/** A fetcher's way of saying the resource no longer exists. */
export const GONE = Symbol("client-cache-gone");

export class GoneError extends Error {
  constructor() { super("Gone"); this.name = "GoneError"; }
}

export class SessionEndedError extends Error {
  constructor() { super("Session ended"); this.name = "SessionEndedError"; }
}

interface MemEntry { value: unknown; at: number; maxAge: number; lastUsed: number; persist: boolean }
type Listener = (value: unknown) => void;
type Fetcher = () => Promise<unknown>;

function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

function sizeOf(value: unknown): number {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? 0 : text.length * 2;
  } catch {
    return -1;
  }
}

export function isQuotaError(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name ?? "";
  return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED" || /quota/i.test(String((error as Error | null)?.message ?? ""));
}

function defaultSchedule(task: () => void) {
  const g = globalThis as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void };
  if (typeof g.requestIdleCallback === "function") g.requestIdleCallback(task, { timeout: 2000 });
  else setTimeout(task, 50);
}

export class ClientCache {
  private mem = new Map<string, MemEntry>();
  private rows = new Map<string, PersistedRow>();
  private backend: CacheBackend | null = null;
  private scope: CacheScope | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private inflight = new Map<string, Promise<unknown>>();
  private fetchers = new Map<string, Fetcher>();
  private pending = new Map<string, unknown>();
  private dirty = new Set<string>();
  private flushQueued = false;
  private flushing: Promise<void> = Promise.resolve();
  /** Bumped by wipe(): async work started before a wipe never writes after it. */
  private generation = 0;
  private readyResolved = false;
  private resolveReady!: () => void;
  private readyPromise: Promise<void>;
  private now: () => number;
  private maxBytes: number;
  private defaultMaxAge: number;
  private memoryMax: number;
  private readyTimeout: number;
  private schedule: (task: () => void) => void;

  constructor(options: CacheOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.defaultMaxAge = options.defaultMaxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.memoryMax = options.memoryMaxEntries ?? MEMORY_MAX_ENTRIES;
    this.readyTimeout = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
    this.schedule = options.schedule ?? defaultSchedule;
    this.readyPromise = new Promise((resolve) => { this.resolveReady = resolve; });
  }

  private markReady() {
    if (this.readyResolved) return;
    this.readyResolved = true;
    this.resolveReady();
  }

  private waitReady(): Promise<void> {
    if (this.readyResolved) return Promise.resolve();
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      this.readyPromise,
      new Promise<void>((resolve) => { timer = setTimeout(resolve, this.readyTimeout); }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
  }

  private expired(at: number, maxAge: number): boolean {
    return this.now() - at > maxAge;
  }

  private persistable(key: string, persist: boolean | undefined): boolean {
    return persist !== false && !isSensitiveKey(key);
  }

  /** Persisted store attached for this user (false: memory only). */
  get persistent(): boolean { return this.backend !== null; }

  /**
   * Attach the persisted store for the signed-in user. A store written for another user or another schema
   * version is deleted before anything is read from it. Then expired rows go and the size cap is applied.
   */
  async attach(backend: CacheBackend, userId: string): Promise<void> {
    const gen = this.generation;
    try {
      let scope = await backend.readScope().catch(() => null);
      if (!scope || scope.userId !== userId || scope.schema !== CACHE_SCHEMA_VERSION) {
        await backend.destroy();
        scope = { userId, schema: CACHE_SCHEMA_VERSION, lastSweep: 0 };
        await backend.writeScope(scope);
      }
      if (gen !== this.generation) return;
      const rows = await backend.listRows();
      if (gen !== this.generation) return;
      this.backend = backend;
      this.scope = scope;
      this.rows = new Map(rows.map((r) => [r.key, r]));
      await this.sweep(true);
      // Values fetched while the store was attaching.
      this.queueFlush();
    } catch {
      // A broken store is not fatal: carry on from memory and the network.
      this.backend = null;
      this.rows.clear();
    } finally {
      this.markReady();
    }
  }

  /** No persisted store this session (no session, or IndexedDB unavailable): reads answer from memory. */
  detach() {
    this.backend = null;
    this.scope = null;
    this.rows.clear();
    this.pending.clear();
    this.dirty.clear();
    this.markReady();
  }

  /** The cached value in memory, or undefined. Never touches the disk. */
  peek<T = unknown>(key: string): T | undefined {
    const entry = this.mem.get(key);
    if (!entry) return undefined;
    if (this.expired(entry.at, entry.maxAge)) {
      this.remove(key);
      return undefined;
    }
    entry.lastUsed = this.now();
    const row = this.rows.get(key);
    if (row) {
      // Recently used on disk too, so the size cap evicts something else first.
      row.lastUsed = entry.lastUsed;
      this.dirty.add(key);
      this.queueFlush();
    }
    // Map order doubles as the memory LRU order.
    this.mem.delete(key);
    this.mem.set(key, entry);
    return entry.value as T;
  }

  /** When the cached value was fetched, or undefined. */
  fetchedAt(key: string): number | undefined {
    return this.mem.get(key)?.at ?? this.rows.get(key)?.at;
  }

  /** The cached value from memory or the persisted store (waits briefly for the store to attach). */
  async read<T = unknown>(key: string): Promise<T | undefined> {
    const hit = this.peek<T>(key);
    if (hit !== undefined) return hit;
    if (isSensitiveKey(key)) return undefined;
    const gen = this.generation;
    await this.waitReady();
    if (gen !== this.generation) return undefined;
    const again = this.peek<T>(key);
    if (again !== undefined) return again;
    const row = this.rows.get(key);
    if (!row || !this.backend) return undefined;
    if (this.expired(row.at, row.maxAge)) {
      this.remove(key);
      return undefined;
    }
    let value: unknown;
    try { value = await this.backend.getValue(key); } catch { return undefined; }
    if (gen !== this.generation) return undefined;
    if (value === undefined || value === null) {
      this.remove(key);
      return undefined;
    }
    // A fresher value may have landed while the disk read was in flight.
    const landed = this.peek<T>(key);
    if (landed !== undefined) return landed;
    row.lastUsed = this.now();
    this.dirty.add(key);
    this.queueFlush();
    this.memSet(key, { value, at: row.at, maxAge: row.maxAge, lastUsed: row.lastUsed, persist: true });
    return value as T;
  }

  private memSet(key: string, entry: MemEntry) {
    this.mem.delete(key);
    this.mem.set(key, entry);
    while (this.mem.size > this.memoryMax) {
      const oldest = this.mem.keys().next().value as string;
      this.mem.delete(oldest);
    }
  }

  /** Store a value. null / undefined removes the entry. Returns true when the stored value changed. */
  put(key: string, value: unknown, options: PutOptions = {}): boolean {
    if (value === undefined || value === null) {
      const had = this.mem.has(key) || this.rows.has(key);
      this.remove(key);
      return had;
    }
    const prev = this.mem.get(key);
    const changed = !prev || !sameJson(prev.value, value);
    const at = options.at ?? this.now();
    const maxAge = options.maxAgeMs ?? this.defaultMaxAge;
    const persist = this.persistable(key, options.persist);
    this.memSet(key, { value, at, maxAge, lastUsed: this.now(), persist });
    if (persist && (this.backend || !this.readyResolved)) {
      // Before the store attaches, queue it anyway: attach() flushes the queue (detach() drops it).
      this.pending.set(key, value);
      this.queueFlush();
    }
    if (changed) this.notify(key, value);
    return changed;
  }

  /** Delete one entry everywhere. */
  remove(key: string) {
    const had = this.mem.delete(key);
    this.pending.delete(key);
    this.dirty.delete(key);
    const persisted = this.rows.delete(key);
    if (persisted && this.backend) void this.backend.remove([key]).catch(() => {});
    if (had || persisted) this.notify(key, undefined);
  }

  keys(): string[] {
    return Array.from(new Set([...Array.from(this.mem.keys()), ...Array.from(this.rows.keys())]));
  }

  /**
   * A write succeeded: drop every entry under these prefixes and refetch in the background the ones that have
   * a registered fetcher, so the next visit shows the new state instead of the pre-write one.
   */
  invalidate(prefixes: string[]): string[] {
    if (!prefixes.length) return [];
    const hit = this.keys().filter((k) => prefixes.some((p) => k.startsWith(p)));
    for (const key of hit) this.remove(key);
    for (const key of hit) {
      const fetcher = this.fetchers.get(key);
      if (fetcher) this.schedule(() => { void this.revalidate(key, fetcher).catch(() => {}); });
    }
    return hit;
  }

  /** Remember how to refetch a key (used by invalidate() and the warm-up). */
  register(key: string, fetcher: Fetcher) {
    this.fetchers.set(key, fetcher);
  }

  /** Refetch a key, sharing one request between concurrent callers. The server's answer always wins. */
  revalidate<T = unknown>(key: string, fetcher: () => Promise<T | typeof GONE | null | undefined>, options: PutOptions = {}): Promise<T | undefined> {
    const running = this.inflight.get(key);
    if (running) return running as Promise<T | undefined>;
    const gen = this.generation;
    // Started on a microtask, so `job` is registered before the fetcher runs (even one that throws at once).
    const job: Promise<T | undefined> = Promise.resolve().then(async () => {
      try {
        const value = await fetcher();
        if (gen !== this.generation) return undefined;
        if (value === GONE || value === null || value === undefined) {
          this.remove(key);
          return undefined;
        }
        this.put(key, value, options);
        return value as T;
      } catch (error) {
        if (error instanceof GoneError && gen === this.generation) this.remove(key);
        throw error;
      } finally {
        if (this.inflight.get(key) === job) this.inflight.delete(key);
      }
    });
    this.inflight.set(key, job);
    return job;
  }

  subscribe(key: string, listener: Listener): () => void {
    let set = this.listeners.get(key);
    if (!set) this.listeners.set(key, (set = new Set()));
    set.add(listener);
    return () => { set!.delete(listener); };
  }

  private notify(key: string, value: unknown) {
    const set = this.listeners.get(key);
    if (!set) return;
    for (const fn of Array.from(set)) { try { fn(value); } catch { /* a listener never breaks the cache */ } }
  }

  private queueFlush() {
    if (this.flushQueued || !this.backend) return;
    this.flushQueued = true;
    this.schedule(() => {
      this.flushQueued = false;
      this.flushing = this.flushing.then(() => this.flush()).catch(() => {});
    });
  }

  /** Resolves when the persistence work queued so far has been written. */
  whenFlushed(): Promise<void> { return this.flushing; }

  /** Write queued values and last-used times to the persisted store. Never throws. */
  async flush(): Promise<void> {
    const backend = this.backend;
    if (!backend) return; // not attached yet: keep the queue for attach() (detach() and wipe() drop it)
    const gen = this.generation;
    const batch = Array.from(this.pending.entries());
    this.pending.clear();
    for (const [key, value] of batch) {
      if (gen !== this.generation || this.backend !== backend) return;
      const entry = this.mem.get(key);
      if (!entry || entry.value !== value) continue; // replaced or removed since it was queued
      const size = sizeOf(value);
      if (size < 0 || size > this.maxBytes / 4) continue; // unserialisable or too large: memory only
      const row: PersistedRow = { key, at: entry.at, maxAge: entry.maxAge, lastUsed: entry.lastUsed, size };
      const previous = this.rows.get(key);
      this.rows.delete(key);
      await this.evictTo(this.maxBytes - size);
      try {
        await backend.put(row, value);
        this.rows.set(key, row);
        this.dirty.delete(key);
      } catch (error) {
        if (!isQuotaError(error)) { if (previous) await backend.remove([key]).catch(() => {}); continue; }
        await this.evictTo(Math.min(this.maxBytes / 2, this.totalBytes() / 2));
        try {
          await backend.put(row, value);
          this.rows.set(key, row);
          this.dirty.delete(key);
        } catch {
          await backend.remove([key]).catch(() => {}); // give up on this one entry; memory still has it
        }
      }
    }
    const touched = Array.from(this.dirty).map((k) => this.rows.get(k)).filter((r): r is PersistedRow => !!r);
    this.dirty.clear();
    if (touched.length && gen === this.generation) await backend.touch(touched).catch(() => {});
  }

  totalBytes(): number {
    let total = 0;
    for (const row of Array.from(this.rows.values())) total += row.size;
    return total;
  }

  /** Remove least-recently-used persisted rows until the total is at most `target` bytes. */
  private async evictTo(target: number): Promise<void> {
    if (this.totalBytes() <= target) return;
    const order = Array.from(this.rows.values()).sort((a, b) => a.lastUsed - b.lastUsed);
    const gone: string[] = [];
    let total = this.totalBytes();
    for (const row of order) {
      if (total <= target) break;
      total -= row.size;
      gone.push(row.key);
      this.rows.delete(row.key);
      // Evicted from disk only: a value still in memory stays usable this session.
      const m = this.mem.get(row.key);
      if (m) m.persist = false;
    }
    const backend = this.backend;
    if (gone.length && backend) await backend.remove(gone).catch(() => {});
  }

  /** Delete expired entries (memory and disk) and apply the size cap. Runs at startup and once a day. */
  async sweep(force = false): Promise<void> {
    const now = this.now();
    for (const [key, entry] of Array.from(this.mem.entries())) if (this.expired(entry.at, entry.maxAge)) this.mem.delete(key);
    // Work on the store as it is now; a wipe during an await ends the sweep instead of touching a new store.
    const backend = this.backend;
    const scope = this.scope;
    const gen = this.generation;
    if (!backend || !scope) return;
    if (!force && now - scope.lastSweep < SWEEP_EVERY_MS) return;
    const stale = Array.from(this.rows.values()).filter((r) => this.expired(r.at, r.maxAge)).map((r) => r.key);
    for (const key of stale) this.rows.delete(key);
    if (stale.length) await backend.remove(stale).catch(() => {});
    if (gen !== this.generation || this.backend !== backend) return;
    await this.evictTo(this.maxBytes);
    if (gen !== this.generation || this.backend !== backend) return;
    const next = { ...scope, lastSweep: now };
    this.scope = next;
    await backend.writeScope(next).catch(() => {});
  }

  /** Forget everything: memory, queued writes and the whole persisted store. Persistence stays off until attach(). */
  async wipe(): Promise<void> {
    this.generation++;
    const backend = this.backend;
    const keys = this.keys();
    this.backend = null;
    this.scope = null;
    this.mem.clear();
    this.rows.clear();
    this.pending.clear();
    this.dirty.clear();
    this.inflight.clear();
    this.markReady();
    for (const key of keys) this.notify(key, undefined);
    if (backend) await backend.destroy().catch(() => {});
  }
}

/** The app-wide cache. */
export const clientCache = new ClientCache();

let onSessionEnded: () => void = () => { void wipeClientData(); };
/** The bootstrap decides what a session end does (wipe, then leave the page alone). */
export function setSessionEndedHandler(fn: () => void) { onSessionEnded = fn; }
export function reportSessionEnded() { onSessionEnded(); }

/**
 * GET a JSON endpoint through the cache. `check` throws on a malformed answer, which is then neither cached
 * nor returned. The raw JSON is cached under the URL, so every page reading the URL shares one entry.
 * 404 / 410 / 204 removes the entry (GoneError); 401 or a redirect to /login wipes the client (SessionEndedError).
 */
export async function cachedJson<T = unknown>(url: string, options: { check?: (data: unknown) => void; persist?: boolean; cache?: ClientCache } = {}): Promise<T> {
  const cache = options.cache ?? clientCache;
  const value = await cache.revalidate<T>(url, async () => {
    const data = await fetchJsonValue(url);
    if (data !== GONE) options.check?.(data);
    return data as T | typeof GONE;
  }, { persist: options.persist });
  if (value === undefined) throw new GoneError();
  return value;
}

/** GET a JSON endpoint: the parsed body, or GONE for 404 / 410 / 204. Throws on a session end or other errors. */
export async function fetchJsonValue(url: string): Promise<unknown> {
  const res = await fetch(url, { cache: "no-store" });
  if (sessionEnded(res)) { reportSessionEnded(); throw new SessionEndedError(); }
  if (isGoneStatus(res.status)) return GONE;
  if (!res.ok) throw new Error(`HTTP ${res.status ?? "error"}`);
  return res.json();
}

export interface WipeDeps {
  cache?: ClientCache;
  storage?: Pick<Storage, "length" | "key" | "removeItem"> | null;
  cacheStorage?: Pick<CacheStorage, "keys" | "delete"> | null;
  deleteDatabase?: ((name: string) => Promise<void>) | null;
  timeoutMs?: number;
}

function defaultDeleteDatabase(name: string): Promise<void> {
  const idb = (globalThis as unknown as { indexedDB?: IDBFactory }).indexedDB;
  if (!idb) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      const req = idb.deleteDatabase(name);
      req.onsuccess = req.onerror = req.onblocked = () => resolve();
    } catch { resolve(); }
  });
}

/**
 * Sign-out / session end: wipe the in-memory cache, the IndexedDB store, every Cache Storage cache on this
 * origin and this app's localStorage keys (unrelated keys stay). Bounded by a timeout so a blocked delete
 * never holds up signing out. Never throws.
 */
export async function wipeClientData(deps: WipeDeps = {}): Promise<void> {
  const g = globalThis as unknown as { localStorage?: Storage; caches?: CacheStorage };
  const cache = deps.cache ?? clientCache;
  let storage: WipeDeps["storage"] = null;
  if (deps.storage !== undefined) storage = deps.storage;
  else { try { storage = g.localStorage ?? null; } catch { storage = null; } }
  const cacheStorage = deps.cacheStorage !== undefined ? deps.cacheStorage : g.caches ?? null;
  const deleteDatabase = deps.deleteDatabase !== undefined ? deps.deleteDatabase : defaultDeleteDatabase;
  const work = (async () => {
    await cache.wipe().catch(() => {});
    if (storage) {
      try {
        const mine: string[] = [];
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          if (key && isAppStorageKey(key)) mine.push(key);
        }
        for (const key of mine) storage.removeItem(key);
      } catch { /* storage unavailable */ }
    }
    if (cacheStorage) {
      try { for (const name of await cacheStorage.keys()) await cacheStorage.delete(name); } catch { /* none */ }
    }
    if (deleteDatabase) await deleteDatabase(CACHE_DB_NAME).catch(() => {});
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([work, new Promise<void>((resolve) => { timer = setTimeout(resolve, deps.timeoutMs ?? 2000); })]);
  if (timer) clearTimeout(timer);
}
