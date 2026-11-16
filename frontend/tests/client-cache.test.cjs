// Run: node --test tests/client-cache.test.cjs
// The shared client cache (src/lib/client-cache.ts): persistence rules, scope, wipe, expiry, size cap, quota,
// revalidation and write invalidation. Offline, invented data, an in-memory stand-in for IndexedDB.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const { outputText } = ts.transpileModule(readFileSync(path.join(__dirname, '..', 'src', 'lib', 'client-cache.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', outputText)((name) => { throw new Error(`client-cache.ts must stay import-free (imported ${name})`); }, mod, mod.exports);
const {
  ClientCache, CACHE_SCHEMA_VERSION, CACHE_DB_NAME, DEFAULT_MAX_AGE_MS, SWEEP_EVERY_MS, GONE, GoneError, isSensitiveKey, isAppStorageKey,
  writeInvalidates, sessionEnded, isGoneStatus, wipeClientData, cachedJson, setSessionEndedHandler,
} = mod.exports;

const USER_A = 'user-aaaa-synthetic';
const USER_B = 'user-bbbb-synthetic';
const DAY = 24 * 3600_000;

/** In-memory stand-in for the IndexedDB store; `failPut` makes put() throw (quota tests). */
function fakeBackend() {
  const b = {
    scope: null, rows: new Map(), values: new Map(), destroyed: 0, failPut: 0, failAlways: false, puts: [],
    async readScope() { return b.scope; },
    async writeScope(s) { b.scope = { ...s }; },
    async listRows() { return Array.from(b.rows.values()).map((r) => ({ ...r })); },
    async getValue(k) { return b.values.has(k) ? structuredClone(b.values.get(k)) : undefined; },
    async put(row, value) {
      if (b.failAlways || b.failPut > 0) {
        b.failPut = Math.max(0, b.failPut - 1);
        const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; throw e;
      }
      b.puts.push(row.key);
      b.rows.set(row.key, { ...row }); b.values.set(row.key, structuredClone(value));
    },
    async touch(rows) { for (const r of rows) if (b.rows.has(r.key)) b.rows.set(r.key, { ...r }); },
    async remove(keys) { for (const k of keys) { b.rows.delete(k); b.values.delete(k); } },
    async destroy() { b.destroyed++; b.scope = null; b.rows.clear(); b.values.clear(); },
  };
  return b;
}

function clock(start = Date.parse('2031-02-03T12:00:00Z')) {
  const c = { t: start, now: () => c.t, advance: (ms) => { c.t += ms; } };
  return c;
}

function makeCache(c = clock(), extra = {}) {
  return new ClientCache({ now: c.now, schedule: (task) => task(), readyTimeoutMs: 20, ...extra });
}

async function persisted(cache) {
  await cache.whenFlushed();
  await new Promise((r) => setImmediate(r));
  await cache.whenFlushed();
}

test('finance, procurement, medical, screen time, experiments and token routes are memory-only', () => {
  for (const key of ['/api/finance/alerts', '/api/procurement/renewals/summary', '/api/medical/labs', '/api/screen-time/token',
    '/api/experiments/today', '/api/spotify/auth-url', '/api/focus/config', '/financials', '/financials/forecast?x=1',
    '/procurement', '/screen-time?days=30', '/health/records', 'finance:ledger', 'medical:docs', 'screen-time:daily',
    '/api/care/google/callback', '/api/anything/token', '/api/x/session']) {
    assert.equal(isSensitiveKey(key), true, key);
  }
  for (const key of ['/api/reading', '/api/habits/checkin', '/api/status', 'agents:inbox', 'habits:journal:365', '/api/urgent-email', '/api/orders/summary']) {
    assert.equal(isSensitiveKey(key), false, key);
  }
});

test('sensitive values never reach the persisted store and are gone when the app closes', async () => {
  const backend = fakeBackend();
  const cache = makeCache();
  await cache.attach(backend, USER_A);
  cache.put('/api/finance/alerts', { status: 'ready', alerts: [{ kind: 'synthetic' }] });
  cache.put('/api/reading', { overview: null });
  cache.put('/api/status', { ok: true }, { persist: false });
  await persisted(cache);
  assert.deepEqual(backend.puts, ['/api/reading']);
  assert.deepEqual(cache.peek('/api/finance/alerts'), { status: 'ready', alerts: [{ kind: 'synthetic' }] });
  // "Reopen": a new cache over the same store has the persisted entry only.
  const reopened = makeCache();
  await reopened.attach(backend, USER_A);
  assert.deepEqual(await reopened.read('/api/reading'), { overview: null });
  assert.equal(await reopened.read('/api/finance/alerts'), undefined);
  assert.equal(await reopened.read('/api/status'), undefined);
});

test('the store is scoped to the user and the schema version: a mismatch deletes it before any read', async () => {
  const backend = fakeBackend();
  const first = makeCache();
  await first.attach(backend, USER_A);
  first.put('/api/reading', { overview: { book: { title: 'A synthetic book' } } });
  await persisted(first);
  assert.equal(backend.scope.userId, USER_A);
  assert.equal(backend.scope.schema, CACHE_SCHEMA_VERSION);

  // Another user on the same device: the store is destroyed before rows are listed.
  const base = backend.destroyed;
  let listedBeforeDestroy = false;
  const list = backend.listRows;
  backend.listRows = async () => { if (backend.destroyed === base) listedBeforeDestroy = true; return list(); };
  const second = makeCache();
  await second.attach(backend, USER_B);
  assert.equal(listedBeforeDestroy, false);
  assert.equal(backend.destroyed, base + 1);
  assert.equal(await second.read('/api/reading'), undefined);
  assert.equal(backend.scope.userId, USER_B);
  backend.listRows = list;

  // Same user, older cache schema: destroyed too.
  second.put('/api/status', { ok: 1 });
  await persisted(second);
  backend.scope = { ...backend.scope, schema: CACHE_SCHEMA_VERSION - 1 };
  const third = makeCache();
  await third.attach(backend, USER_B);
  assert.equal(backend.destroyed, base + 2);
  assert.equal(await third.read('/api/status'), undefined);
});

test('signing out wipes memory, the IndexedDB store, Cache Storage and only this app\'s localStorage keys', async () => {
  const backend = fakeBackend();
  const cache = makeCache();
  await cache.attach(backend, USER_A);
  cache.put('/api/reading', { overview: null });
  cache.put('/api/finance/alerts', { status: 'ready', alerts: [] });
  await persisted(cache);
  const base = backend.destroyed;
  const store = new Map([['onyx:checkin:2031-02-03', '{}'], ['onyx.warmup.visits', '{}'], ['onyx-care-planner-v1', '[]'],
    ['chartCard.collapsed.Synthetic', 'true'], ['unrelated-key', 'keep'], ['sb-synthetic-auth', 'keep']]);
  const storage = { get length() { return store.size; }, key: (i) => Array.from(store.keys())[i] ?? null, removeItem: (k) => store.delete(k) };
  const deletedCaches = [];
  const cacheStorage = { keys: async () => ['onyx-static', 'other'], delete: async (n) => { deletedCaches.push(n); return true; } };
  const deletedDbs = [];
  await wipeClientData({ cache, storage, cacheStorage, deleteDatabase: async (n) => { deletedDbs.push(n); } });
  assert.equal(cache.peek('/api/reading'), undefined);
  assert.equal(cache.peek('/api/finance/alerts'), undefined);
  assert.equal(backend.destroyed, base + 1);
  assert.equal(backend.values.size, 0);
  assert.deepEqual(deletedDbs, [CACHE_DB_NAME]);
  assert.deepEqual(deletedCaches, ['onyx-static', 'other']);
  assert.deepEqual(Array.from(store.keys()).sort(), ['sb-synthetic-auth', 'unrelated-key']);
  assert.equal(cache.persistent, false, 'persistence stays off until the next attach');
  assert.equal(isAppStorageKey('onyx:checkin:night:2031-02-02'), true);
  assert.equal(isAppStorageKey('somebody-else'), false);
});

test('a wipe in the middle of a fetch stops the late answer from being stored', async () => {
  const cache = makeCache();
  let release;
  const pending = cache.revalidate('/api/reading', () => new Promise((r) => { release = r; }));
  await new Promise((r) => setImmediate(r));
  await cache.wipe();
  release({ overview: null });
  assert.equal(await pending, undefined);
  assert.equal(cache.peek('/api/reading'), undefined);
});

test('a 401 or a redirect to /login means the session ended and wipes; 404 / 410 / 204 remove the entry', async (t) => {
  assert.equal(sessionEnded({ status: 401 }), true);
  assert.equal(sessionEnded({ status: 200, redirected: true, url: 'https://onyx.example/login?next=%2Freading' }), true);
  assert.equal(sessionEnded({ status: 200, redirected: true, url: 'https://onyx.example/today' }), false);
  assert.equal(sessionEnded({ status: 500 }), false);
  assert.equal(sessionEnded({ ok: false }), false);
  for (const s of [404, 410, 204]) assert.equal(isGoneStatus(s), true);
  assert.equal(isGoneStatus(200), false);

  const cache = makeCache();
  let ended = 0;
  setSessionEndedHandler(() => { ended++; });
  const prior = globalThis.fetch;
  t.after(() => { globalThis.fetch = prior; });
  let answer = { ok: false, status: 401, json: async () => ({}) };
  globalThis.fetch = async () => answer;
  await assert.rejects(cachedJson('/api/reading', { cache }), { name: 'SessionEndedError' });
  assert.equal(ended, 1);

  cache.put('/api/reading', { overview: null });
  answer = { ok: false, status: 404, json: async () => ({}) };
  await assert.rejects(cachedJson('/api/reading', { cache }), GoneError);
  assert.equal(cache.peek('/api/reading'), undefined, 'the server said it is gone: the entry is removed, not kept');

  answer = { ok: true, status: 200, json: async () => ({ overview: { book: { title: 'Fresh synthetic title' } } }) };
  assert.deepEqual(await cachedJson('/api/reading', { cache }), { overview: { book: { title: 'Fresh synthetic title' } } });
  assert.deepEqual(cache.peek('/api/reading'), { overview: { book: { title: 'Fresh synthetic title' } } });

  // An invalid answer is neither returned nor cached.
  answer = { ok: true, status: 200, json: async () => ({ nonsense: true }) };
  await assert.rejects(cachedJson('/api/reading', { cache, check: (d) => { if (!('overview' in d)) throw new Error('invalid'); } }));
  assert.deepEqual(cache.peek('/api/reading'), { overview: { book: { title: 'Fresh synthetic title' } } });
  setSessionEndedHandler(() => {});
});

test('every cached read is revalidated: the server answer replaces it, null or GONE removes it, requests are shared', async () => {
  const cache = makeCache();
  cache.put('k:one', { v: 1 });
  let calls = 0;
  const fetcher = async () => { calls++; await new Promise((r) => setImmediate(r)); return { v: 2 }; };
  const [a, b] = await Promise.all([cache.revalidate('k:one', fetcher), cache.revalidate('k:one', fetcher)]);
  assert.equal(calls, 1, 'concurrent revalidations share one request');
  assert.deepEqual(a, { v: 2 });
  assert.deepEqual(b, { v: 2 });
  assert.deepEqual(cache.peek('k:one'), { v: 2 });
  await cache.revalidate('k:one', async () => GONE);
  assert.equal(cache.peek('k:one'), undefined);
  cache.put('k:two', { v: 1 });
  await cache.revalidate('k:two', async () => null);
  assert.equal(cache.peek('k:two'), undefined);
  // A fetcher that throws at once does not leave a stuck request behind.
  await assert.rejects(cache.revalidate('k:three', () => { throw new Error('synthetic'); }));
  assert.deepEqual(await cache.revalidate('k:three', async () => ({ v: 3 })), { v: 3 });
});

test('deep-equal bailout: an identical answer is not a change and notifies nobody', () => {
  const cache = makeCache();
  const seen = [];
  cache.subscribe('k:list', (v) => seen.push(v));
  assert.equal(cache.put('k:list', { items: [1, 2], at: 'x' }), true);
  const first = cache.peek('k:list');
  assert.equal(cache.put('k:list', { items: [1, 2], at: 'x' }), false);
  assert.equal(seen.length, 1);
  assert.equal(cache.put('k:list', { items: [1, 2, 3], at: 'x' }), true);
  assert.equal(seen.length, 2);
  assert.notEqual(cache.peek('k:list'), first);
});

test('a successful write invalidates the entries it changed and refetches them in the background', async () => {
  assert.deepEqual(writeInvalidates('/api/habits/checkin'), ['/api/habits', 'habits:', '/api/delivery']);
  assert.deepEqual(writeInvalidates('/api/reading/sessions'), ['/api/reading', 'reading:']);
  assert.deepEqual(writeInvalidates('/api/urgent-email/clear'), ['/api/urgent-email', 'urgent-email:']);
  assert.deepEqual(writeInvalidates('/onyx/dismiss'), ['agents:']);
  assert.deepEqual(writeInvalidates('/api/habits/sync'), [], 'the page itself re-reads what the sync changed');
  assert.deepEqual(writeInvalidates('/api/habits/complete'), ['/api/habits/checkin', '/api/habits/list'], '/habits writes its own journal through');
  assert.ok(writeInvalidates('/api/chat').includes('habits:'), 'chat write tools log habits');
  assert.deepEqual(writeInvalidates('/today'), []);
  // A drink capture is one row counted by Nutrition AND Caffeine: both areas (and their feed seeds) go stale.
  assert.deepEqual(writeInvalidates('/api/nutrition/drinks'), ['/api/nutrition', 'nutrition:', '/api/caffeine', 'caffeine:']);
  assert.deepEqual(writeInvalidates('/api/nutrition/photo-meals'), ['/api/nutrition', 'nutrition:']);

  const cache = makeCache();
  cache.put('/api/habits/checkin', { today: '2031-02-03', answers: { a: 'No' } });
  cache.put('habits:journal:365', [{ q: 'a', answer: 'No' }]);
  cache.put('/api/reading', { overview: null });
  let refetched = 0;
  cache.register('/api/habits/checkin', async () => { refetched++; return { today: '2031-02-03', answers: { a: 'Yes' } }; });
  const dropped = cache.invalidate(writeInvalidates('/api/habits/checkin')).sort();
  assert.deepEqual(dropped, ['/api/habits/checkin', 'habits:journal:365']);
  assert.equal(cache.peek('habits:journal:365'), undefined);
  assert.deepEqual(cache.peek('/api/reading'), { overview: null }, 'unrelated entries stay');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(refetched, 1);
  assert.deepEqual(cache.peek('/api/habits/checkin'), { today: '2031-02-03', answers: { a: 'Yes' } }, 'the next visit shows the post-write state');
});

test('entries expire: deleted when read and by the startup and daily sweep', async () => {
  const c = clock();
  const backend = fakeBackend();
  const cache = makeCache(c);
  await cache.attach(backend, USER_A);
  cache.put('/api/reading', { overview: null });
  cache.put('k:short', { v: 1 }, { maxAgeMs: 60_000 });
  await persisted(cache);
  assert.equal(backend.rows.get('/api/reading').maxAge, DEFAULT_MAX_AGE_MS);
  c.advance(61_000);
  assert.equal(cache.peek('k:short'), undefined, 'expired on read');
  assert.equal(backend.rows.has('k:short'), false, 'and removed from the store');

  // An expired row on disk is deleted at startup, before any page asks for it.
  c.advance(8 * DAY);
  const reopened = makeCache(c);
  await reopened.attach(backend, USER_A);
  assert.equal(backend.rows.has('/api/reading'), false);
  assert.equal(await reopened.read('/api/reading'), undefined);

  // The daily sweep runs once 24 h have passed since the last one.
  reopened.put('k:a', { v: 1 }, { maxAgeMs: 3600_000 });
  await persisted(reopened);
  c.advance(2 * 3600_000);
  await reopened.sweep();
  assert.equal(backend.rows.has('k:a'), true, 'no sweep yet: the last one was under 24 h ago');
  c.advance(SWEEP_EVERY_MS);
  await reopened.sweep();
  assert.equal(backend.rows.has('k:a'), false);
});

test('size cap with least-recently-used eviction', async () => {
  const c = clock();
  const backend = fakeBackend();
  // Each value below is ~2 KB stored; a 9 KB cap holds four.
  const cache = makeCache(c, { maxBytes: 9000 });
  await cache.attach(backend, USER_A);
  const blob = (n) => ({ n, pad: 'x'.repeat(980) });
  for (const k of ['k:1', 'k:2', 'k:3', 'k:4']) { cache.put(k, blob(k)); c.advance(1000); }
  await persisted(cache);
  assert.equal(backend.rows.size, 4);
  // k:1 is used again, so k:2 is now the least recently used.
  cache.peek('k:1');
  c.advance(1000);
  cache.put('k:5', blob('k:5'));
  await persisted(cache);
  assert.deepEqual(Array.from(backend.rows.keys()).sort(), ['k:1', 'k:3', 'k:4', 'k:5']);
  assert.ok(cache.totalBytes() <= 9000);
  // A single value over a quarter of the cap stays in memory only.
  cache.put('k:huge', { pad: 'y'.repeat(2000) });
  await persisted(cache);
  assert.equal(backend.rows.has('k:huge'), false);
  assert.ok(cache.peek('k:huge'));
});

test('a quota error evicts and retries; a store that keeps refusing never crashes the page', async () => {
  const backend = fakeBackend();
  const cache = makeCache();
  await cache.attach(backend, USER_A);
  for (const k of ['k:1', 'k:2', 'k:3']) cache.put(k, { k });
  await persisted(cache);
  backend.failPut = 1;
  cache.put('k:4', { k: 'k:4' });
  await persisted(cache);
  assert.equal(backend.rows.has('k:4'), true, 'retried after evicting');
  assert.ok(backend.rows.size < 4, 'something was evicted to make room');
  backend.failAlways = true;
  assert.doesNotThrow(() => cache.put('k:5', { k: 'k:5' }));
  await persisted(cache);
  assert.equal(backend.rows.has('k:5'), false);
  assert.deepEqual(cache.peek('k:5'), { k: 'k:5' }, 'still served from memory this session');
});

test('reads wait briefly for the store, then answer from memory; a broken store is not fatal', async () => {
  const cache = makeCache(clock(), { readyTimeoutMs: 10 });
  assert.equal(await cache.read('/api/reading'), undefined, 'never attached: memory only after the timeout');
  const broken = fakeBackend();
  broken.readScope = async () => { throw new Error('synthetic'); };
  broken.destroy = async () => { throw new Error('synthetic'); };
  const other = makeCache();
  await other.attach(broken, USER_A);
  assert.equal(other.persistent, false);
  other.put('/api/reading', { overview: null });
  assert.deepEqual(await other.read('/api/reading'), { overview: null });
});

test('values fetched while the store is still attaching are persisted once it attaches; detach drops them', async () => {
  const backend = fakeBackend();
  const cache = makeCache();
  cache.put('/api/reading', { overview: null }); // before attach
  cache.put('/api/finance/alerts', { status: 'ready', alerts: [] });
  await cache.attach(backend, USER_A);
  await persisted(cache);
  assert.deepEqual(backend.puts, ['/api/reading']);
  const other = makeCache();
  other.put('/api/reading', { overview: null });
  other.detach(); // no session / no IndexedDB: memory only
  const b2 = fakeBackend();
  await other.attach(b2, USER_A);
  await persisted(other);
  assert.deepEqual(b2.puts, []);
});

test('a wipe in the middle of a sweep ends the sweep without touching the store again', async () => {
  const c = clock();
  const backend = fakeBackend();
  const cache = makeCache(c);
  await cache.attach(backend, USER_A);
  cache.put('k:a', { v: 1 }, { maxAgeMs: 1000 });
  await persisted(cache);
  c.advance(SWEEP_EVERY_MS + 2000);
  let release;
  backend.remove = async () => { await new Promise((r) => { release = r; }); };
  const sweeping = cache.sweep();
  await new Promise((r) => setImmediate(r));
  await cache.wipe();
  const writesBefore = backend.scope;
  release();
  await assert.doesNotReject(sweeping);
  assert.equal(backend.scope, writesBefore, 'no scope written after the wipe');
});
