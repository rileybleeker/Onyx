import { CACHE_DB_NAME, type CacheBackend, type CacheScope, type PersistedRow } from "@/lib/client-cache";

/**
 * IndexedDB storage for the client cache (lib/client-cache.ts). Three object stores:
 * - "scope":  one record, which user and cache schema the store belongs to, and when it was last swept;
 * - "index":  per key, when it was fetched, its max age, its size and when it was last used (read at startup);
 * - "values": per key, the cached value (read only when a page asks for that key).
 * Splitting index and values keeps startup cheap: nothing large is deserialised until a page needs it.
 */
const DB_VERSION = 1;
const SCOPE = "scope";
const INDEX = "index";
const VALUES = "values";

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("Transaction aborted"));
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function idbAvailable(): boolean {
  try { return typeof indexedDB !== "undefined" && indexedDB !== null; } catch { return false; }
}

export class IdbCacheBackend implements CacheBackend {
  private db: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    this.db = new Promise<IDBDatabase>((resolve, reject) => {
      let req: IDBOpenDBRequest;
      try { req = indexedDB.open(CACHE_DB_NAME, DB_VERSION); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of [SCOPE, INDEX, VALUES]) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      };
      req.onsuccess = () => {
        const db = req.result;
        // Another tab deleting the store (sign-out there) must not be blocked by this connection.
        db.onversionchange = () => { db.close(); this.db = null; };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("IndexedDB open blocked"));
    });
    this.db.catch(() => { this.db = null; });
    return this.db;
  }

  async readScope(): Promise<CacheScope | null> {
    const db = await this.open();
    const tx = db.transaction(SCOPE, "readonly");
    const value = await request(tx.objectStore(SCOPE).get("scope"));
    return (value as CacheScope | undefined) ?? null;
  }

  async writeScope(scope: CacheScope): Promise<void> {
    const db = await this.open();
    const tx = db.transaction(SCOPE, "readwrite");
    tx.objectStore(SCOPE).put(scope, "scope");
    await done(tx);
  }

  async listRows(): Promise<PersistedRow[]> {
    const db = await this.open();
    const tx = db.transaction(INDEX, "readonly");
    return (await request(tx.objectStore(INDEX).getAll())) as PersistedRow[];
  }

  async getValue(key: string): Promise<unknown> {
    const db = await this.open();
    const tx = db.transaction(VALUES, "readonly");
    return request(tx.objectStore(VALUES).get(key));
  }

  async put(row: PersistedRow, value: unknown): Promise<void> {
    const db = await this.open();
    const tx = db.transaction([INDEX, VALUES], "readwrite");
    tx.objectStore(VALUES).put(value, row.key);
    tx.objectStore(INDEX).put(row, row.key);
    await done(tx);
  }

  async touch(rows: PersistedRow[]): Promise<void> {
    if (!rows.length) return;
    const db = await this.open();
    const tx = db.transaction(INDEX, "readwrite");
    for (const row of rows) tx.objectStore(INDEX).put(row, row.key);
    await done(tx);
  }

  async remove(keys: string[]): Promise<void> {
    if (!keys.length) return;
    const db = await this.open();
    const tx = db.transaction([INDEX, VALUES], "readwrite");
    for (const key of keys) {
      tx.objectStore(INDEX).delete(key);
      tx.objectStore(VALUES).delete(key);
    }
    await done(tx);
  }

  /** Empty every store in place (the connection stays usable for the new scope). */
  async destroy(): Promise<void> {
    const db = await this.open();
    const tx = db.transaction([SCOPE, INDEX, VALUES], "readwrite");
    for (const name of [SCOPE, INDEX, VALUES]) tx.objectStore(name).clear();
    await done(tx);
  }

  /** Close the connection (before the database itself is deleted on sign-out). */
  async close(): Promise<void> {
    const db = this.db;
    this.db = null;
    if (db) (await db.catch(() => null))?.close();
  }
}
