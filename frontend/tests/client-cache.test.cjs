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
  sensitiveRowKeys, writeInvalidates, sessionEnded, isGoneStatus, wipeClientData, cachedJson, setSessionEndedHandler,
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
    '/api/care/google/callback', '/api/anything/token', '/api/x/session', '/api/care/items', '/api/care/page-data', 'care:items']) {
    assert.equal(isSensitiveKey(key), true, key);
  }
  for (const key of ['/api/reading', '/api/habits/checkin', 'habits:journal:365', '/api/orders/summary', '/api/statuses',
    '/api/urgent-emails', 'agentsx:inbox', '/onyxfoo']) {
    assert.equal(isSensitiveKey(key), false, key);
  }
});

test('mixed payloads (agents inbox and threads, agents Worker routes, /api/status, /api/urgent-email) are memory-only', () => {
  for (const key of ['agents:inbox', 'agents:thread:synthetic-agent', 'agents:thread:a.b-c', '/api/status', '/api/status?x=1',
    '/api/urgent-email', '/api/urgent-email?view=all', '/onyx/inbox', '/onyx/messages?thread=synthetic',
    'https://agents.example.invalid/onyx/messages?thread=synthetic']) {
    assert.equal(isSensitiveKey(key), true, key);
  }
  assert.ok(CACHE_SCHEMA_VERSION >= 2, 'stores written before agents / status became memory-only are deleted whole');
  assert.deepEqual(sensitiveRowKeys([{ key: '/api/reading' }, { key: 'agents:inbox' }, { key: '/api/status' }, { key: 'k:x' }]),
    ['agents:inbox', '/api/status']);
});

test('/api/status keeps its CDN caching but tells the browser never to store it (disk HTTP cache is outside the wipe)', () => {
  const route = readFileSync(path.join(__dirname, '..', 'src', 'app', 'api', 'status', 'route.ts'), 'utf8');
  const browser = [...route.matchAll(/"Cache-Control":\s*"([^"]*)"/g)].map((m) => m[1]);
  assert.ok(browser.length >= 2, 'the answer and the 500 branch both set Cache-Control');
  for (const value of browser) {
    assert.match(value, /no-store/, value);
    assert.doesNotMatch(value, /public|s-maxage/, value);
  }
  assert.match(route, /"Vercel-CDN-Cache-Control":\s*"max-age=\d+/, 'the CDN rule lives in a header Vercel consumes');
});

// Synthetic markers standing in for finance / medical / email text an agent message or a heartbeat could quote.
const MARKERS = ['SYNTHETIC-FIN-MARKER-7f3a', 'SYNTHETIC-MED-MARKER-91c2', 'SYNTHETIC-MAIL-MARKER-c40d', 'SYNTHETIC-BANK-MARKER-2b88'];
const inboxValue = () => ({ items: [{ code: 'A1', text: `Synthetic card ${MARKERS[0]}` }], threads: [{ id: 'synthetic', last: { id: 3, preview: MARKERS[1] } }], badge: 1 });
const threadValue = () => ({ messages: [{ id: 3, body: `Synthetic message ${MARKERS[1]} ${MARKERS[0]}` }], cardStates: {}, lastRead: 0, typing: false });
const statusValue = () => ({ sources: { synthetic: { status: 'partial', error: MARKERS[3] } }, recentHistory: [{ source: 'synthetic', error_message: MARKERS[3] }] });
const urgentValue = () => ({ status: 'ready', items: [{ subject: MARKERS[2], from: 'Synthetic Sender' }] });

function storeText(backend) {
  return JSON.stringify([Array.from(backend.rows.entries()), Array.from(backend.values.entries())]);
}

function assertNoMarkers(backend, label) {
  const text = storeText(backend);
  for (const m of MARKERS) assert.equal(text.includes(m), false, `${label}: ${m} reached the persisted store`);
}

test('agents, status and urgent-email values never enter the persisted store, whatever the caller asks', async () => {
  const backend = fakeBackend();
  const cache = makeCache();
  // Queued before the store attaches, like a warm-up or an early read landing first.
  cache.put('agents:inbox', inboxValue());
  await cache.attach(backend, USER_A);
  cache.put('agents:thread:synthetic', threadValue(), { persist: true });
  cache.put('/api/status', statusValue());
  cache.put('/api/urgent-email', urgentValue(), { persist: true });
  cache.put('/api/reading', { overview: null });
  await persisted(cache);
  assert.deepEqual(backend.puts, ['/api/reading']);
  assertNoMarkers(backend, 'after put');
  // Rendered at once from memory this session (no await, no disk read).
  assert.deepEqual(cache.peek('agents:inbox'), inboxValue());
  assert.deepEqual(cache.peek('agents:thread:synthetic'), threadValue());
  assert.deepEqual(cache.peek('/api/status'), statusValue());
  // Live revalidation still replaces the in-memory copy and still stays off the disk.
  const next = { ...threadValue(), messages: [{ id: 4, body: `Newer ${MARKERS[0]}` }] };
  assert.deepEqual(await cache.revalidate('agents:thread:synthetic', async () => next), next);
  assert.deepEqual(cache.peek('agents:thread:synthetic'), next);
  await persisted(cache);
  assertNoMarkers(backend, 'after revalidate');
  // A write invalidates the agents entries in memory; the background refetch stays in memory too.
  cache.register('agents:inbox', async () => inboxValue());
  cache.invalidate(writeInvalidates('/onyx/dismiss'));
  assert.equal(cache.peek('agents:thread:synthetic'), undefined);
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(cache.peek('agents:inbox'), inboxValue());
  await persisted(cache);
  assertNoMarkers(backend, 'after invalidate + refetch');
  // Restart: a new cache over the same store has no copy of any of them.
  const reopened = makeCache();
  await reopened.attach(backend, USER_A);
  for (const key of ['agents:inbox', 'agents:thread:synthetic', '/api/status', '/api/urgent-email']) {
    assert.equal(await reopened.read(key), undefined, key);
  }
  assert.deepEqual(await reopened.read('/api/reading'), { overview: null });
});

test('a quota retry never writes a memory-only key', async () => {
  const backend = fakeBackend();
  const cache = makeCache();
  await cache.attach(backend, USER_A);
  for (const k of ['k:1', 'k:2']) cache.put(k, { k });
  await persisted(cache);
  backend.failPut = 1;
  cache.put('agents:inbox', inboxValue());
  cache.put('/api/status', statusValue());
  cache.put('k:3', { k: 'k:3' });
  await persisted(cache);
  assert.equal(backend.rows.has('k:3'), true, 'the persistable value was retried after evicting');
  assert.equal(backend.puts.includes('agents:inbox') || backend.puts.includes('/api/status'), false);
  assertNoMarkers(backend, 'after quota retry');
});

test('a memory-only read answers at once and never waits for the store to attach', async () => {
  const cache = makeCache(clock(), { readyTimeoutMs: 60_000 });
  const timeout = new Promise((r) => setTimeout(() => r('waited'), 200));
  assert.equal(await Promise.race([cache.read('agents:inbox'), timeout]), undefined);
  assert.equal(await Promise.race([cache.read('/api/status'), timeout]), undefined);
  cache.put('agents:inbox', inboxValue());
  assert.deepEqual(await Promise.race([cache.read('agents:inbox'), timeout]), inboxValue());
});

/** A store already scoped to this user and this schema, holding rows written under an older policy. */
function storeWithOldRows(userId = USER_A) {
  const backend = fakeBackend();
  backend.scope = { userId, schema: CACHE_SCHEMA_VERSION, lastSweep: 0 };
  const at = Date.parse('2031-02-03T11:00:00Z');
  const rows = [['agents:inbox', inboxValue()], ['agents:thread:synthetic', threadValue()], ['/api/status', statusValue()],
    ['/api/urgent-email', urgentValue()], ['/api/finance/alerts', { alerts: [{ text: MARKERS[0] }] }], ['/api/reading', { overview: null }]];
  for (const [key, value] of rows) {
    backend.rows.set(key, { key, at, maxAge: DEFAULT_MAX_AGE_MS, lastUsed: at, size: 100 });
    backend.values.set(key, value);
  }
  return backend;
}

test('rows persisted under an older policy are purged at the next start, without a sign-out or a schema bump', async () => {
  const backend = storeWithOldRows();
  const base = backend.destroyed;
  const cache = makeCache();
  await cache.attach(backend, USER_A);
  assert.equal(backend.destroyed, base, 'the store is kept: only the memory-only rows go');
  assert.deepEqual(Array.from(backend.rows.keys()), ['/api/reading']);
  assert.deepEqual(Array.from(backend.values.keys()), ['/api/reading']);
  assertNoMarkers(backend, 'after the purge');
  assert.equal(cache.persistent, true);
  assert.deepEqual(await cache.read('/api/reading'), { overview: null });
  assert.equal(await cache.read('agents:inbox'), undefined);
  assert.equal(cache.totalBytes(), 100, 'purged rows no longer count towards the size cap');

  // A tab still running an older version writes one after this tab attached: never served, purged at the next start.
  const late = Date.parse('2031-02-03T11:30:00Z'); // inside the max age: purged, not just expired
  await backend.put({ key: 'agents:inbox', at: late, maxAge: DEFAULT_MAX_AGE_MS, lastUsed: late, size: 100 }, inboxValue());
  assert.equal(await cache.read('agents:inbox'), undefined);
  const restarted = makeCache();
  await restarted.attach(backend, USER_A);
  assert.equal(backend.rows.has('agents:inbox'), false);
  assertNoMarkers(backend, 'after the restart');
});

test('a store written before the schema bump is deleted whole before anything is read', async () => {
  const backend = storeWithOldRows();
  backend.scope = { ...backend.scope, schema: CACHE_SCHEMA_VERSION - 1 };
  const base = backend.destroyed;
  const cache = makeCache();
  await cache.attach(backend, USER_A);
  assert.equal(backend.destroyed, base + 1);
  assert.equal(backend.rows.size, 0);
  assertNoMarkers(backend, 'after the schema bump');
  assert.equal(backend.scope.schema, CACHE_SCHEMA_VERSION);
  assert.equal(await cache.read('/api/reading'), undefined);
});

test('purge failure: rows that cannot be removed take the whole store; if that fails too, memory only until the next start', async () => {
  // 1. remove() fails: the whole store is deleted instead, and the cache keeps working on the empty store.
  const first = storeWithOldRows();
  const remove = first.remove;
  first.remove = async () => { throw new Error('synthetic remove failure'); };
  const base = first.destroyed;
  const a = makeCache();
  await a.attach(first, USER_A);
  assert.equal(first.destroyed, base + 1);
  assertNoMarkers(first, 'after the fallback');
  assert.equal(a.persistent, true);
  assert.equal(first.scope.userId, USER_A);
  first.remove = remove;
  a.put('/api/reading', { overview: { book: { title: 'A synthetic book' } } });
  await persisted(a);
  assert.deepEqual(first.puts.slice(-1), ['/api/reading']);

  // 2. remove() and destroy() both fail: nothing is served from the store this session (memory only) ...
  const second = storeWithOldRows();
  const secondRemove = second.remove;
  const secondDestroy = second.destroy;
  second.remove = async () => { throw new Error('synthetic remove failure'); };
  second.destroy = async () => { throw new Error('synthetic destroy failure'); };
  const b = makeCache();
  await b.attach(second, USER_A);
  assert.equal(b.persistent, false);
  assert.equal(await b.read('agents:inbox'), undefined);
  assert.equal(await b.read('/api/reading'), undefined, 'a store that could not be cleaned is not used at all');
  b.put('agents:inbox', inboxValue());
  assert.deepEqual(b.peek('agents:inbox'), inboxValue(), 'still rendered from memory');
  // ... and the next start retries the purge.
  second.remove = secondRemove;
  second.destroy = secondDestroy;
  const c = makeCache();
  await c.attach(second, USER_A);
  assert.equal(c.persistent, true);
  assert.deepEqual(Array.from(second.rows.keys()), ['/api/reading']);
  assertNoMarkers(second, 'after the retry');
  assert.deepEqual(await c.read('/api/reading'), { overview: null });
});

test('another user on the device never sees the previous user\'s agents or status copies', async () => {
  const backend = storeWithOldRows(USER_A);
  const cache = makeCache();
  await cache.attach(backend, USER_B);
  assert.equal(backend.rows.size, 0);
  assertNoMarkers(backend, 'after the user switch');
  assert.equal(await cache.read('agents:inbox'), undefined);
  assert.equal(await cache.read('/api/reading'), undefined);
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
  second.put('k:user-b', { ok: 1 });
  await persisted(second);
  assert.equal(backend.rows.has('k:user-b'), true);
  backend.scope = { ...backend.scope, schema: CACHE_SCHEMA_VERSION - 1 };
  const third = makeCache();
  await third.attach(backend, USER_B);
  assert.equal(backend.destroyed, base + 2);
  assert.equal(await third.read('k:user-b'), undefined);
});

test('signing out wipes memory, the IndexedDB store, Cache Storage and only this app\'s localStorage keys', async () => {
  const backend = fakeBackend();
  const cache = makeCache();
  await cache.attach(backend, USER_A);
  cache.put('/api/reading', { overview: null });
  cache.put('/api/finance/alerts', { status: 'ready', alerts: [] });
  cache.put('agents:thread:synthetic', threadValue());
  cache.put('/api/status', statusValue());
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
  assert.equal(cache.peek('agents:thread:synthetic'), undefined);
  assert.equal(cache.peek('/api/status'), undefined);
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
  assert.deepEqual(writeInvalidates('/api/habits/checkin'), ['/api/habits', 'habits:', '/api/delivery', '/api/sleep/winddown']);
  // A wind-down answer is the chosen habit's own row (PROD-SLEEP-01): habits and wind-down go stale together.
  assert.deepEqual(writeInvalidates('/api/sleep/winddown/night'), ['/api/sleep', 'sleep:', '/api/habits', 'habits:']);
  assert.deepEqual(writeInvalidates('/api/reading/sessions'), ['/api/reading', 'reading:']);
  // A Want to read change refreshes the quest (/api/reading, the switcher's book list) and the list itself.
  assert.deepEqual(writeInvalidates('/api/reading/list'), ['/api/reading', 'reading:']);
  assert.ok('/api/reading/list'.startsWith('/api/reading') && !isSensitiveKey('/api/reading/list'));
  assert.ok(isAppStorageKey('onyx.reading.list.v2'), 'the list\'s unconfirmed changes are wiped on sign-out');
  assert.deepEqual(writeInvalidates('/api/urgent-email/clear'), ['/api/urgent-email', 'urgent-email:']);
  assert.deepEqual(writeInvalidates('/onyx/dismiss'), ['agents:']);
  assert.deepEqual(writeInvalidates('/api/habits/sync'), [], 'the page itself re-reads what the sync changed');
  assert.deepEqual(writeInvalidates('/api/habits/complete'), ['/api/habits/checkin', '/api/habits/list', '/api/sleep/winddown'], '/habits writes its own journal through');
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
