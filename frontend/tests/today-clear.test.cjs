// Run: node --test tests/today-clear.test.cjs
// Clearing items from Today (src/lib/today-clear.ts, POST /api/urgent-email/clear). Offline, invented data.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const src = (...p) => readFileSync(path.join(__dirname, '..', 'src', ...p), 'utf8');
const { outputText } = ts.transpileModule(src('lib', 'today-clear.ts'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', outputText)((name) => { throw new Error(`today-clear.ts must stay import-free (imported ${name})`); }, mod, mod.exports);
const { parseClearBody, checkClearRequest, stillCleared, clearKeyHash, hiddenEmailKey, clearedLabel, MAX_CLEAR_ITEMS } = mod.exports;

const NOW = new Date('2030-03-05T15:00:00Z');
const KEY = 'thread:owner@example.com:1234567890123456789';
const headers = (h) => ({ get: (n) => h[n.toLowerCase()] ?? null });

test('clear: keys and times are checked, normalised, de-duplicated (later time wins)', () => {
  const out = parseClearBody({ items: [
    { key: KEY, receivedAt: '2030-03-05T10:00:00+00:00' },
    { key: KEY, receivedAt: '2030-03-05T12:00:00Z' },
    { key: 'msg:second@example.com:abc@mail.example.com', receivedAt: '2030-03-04T08:00:00Z' },
  ] }, NOW);
  assert.deepEqual(out, { ok: true, request: { undo: false, items: [
    { key: KEY, through: '2030-03-05T12:00:00.000Z' },
    { key: 'msg:second@example.com:abc@mail.example.com', through: '2030-03-04T08:00:00.000Z' },
  ] } });
});

test('undo needs only the keys', () => {
  assert.deepEqual(parseClearBody({ items: [{ key: KEY }, { key: KEY }], undo: true }, NOW), { ok: true, request: { undo: true, keys: [KEY] } });
});

test('refused: wrong shapes, unknown fields, bad keys or times, empty or oversized lists', () => {
  const bad = [
    null, [], 'x', {}, { items: [] }, { items: 'x' }, { items: [{ key: KEY, receivedAt: '2030-03-05T10:00:00Z' }], extra: 1 },
    { items: [{ key: KEY, receivedAt: '2030-03-05T10:00:00Z', subject: 'x' }] },
    { items: [{ key: 'card:A12', receivedAt: '2030-03-05T10:00:00Z' }] },
    { items: [{ key: 'thread:has space:1', receivedAt: '2030-03-05T10:00:00Z' }] },
    { items: [{ key: 'thread:' + 'a'.repeat(900), receivedAt: '2030-03-05T10:00:00Z' }] },
    { items: [{ key: KEY }] },
    { items: [{ key: KEY, receivedAt: 'yesterday' }] },
    { items: [{ key: KEY, receivedAt: '1999-12-31T00:00:00Z' }] },
    { items: [{ key: KEY, receivedAt: '2030-03-08T15:00:00Z' }] },
    { items: [{ key: KEY, receivedAt: '2030-03-05T10:00:00Z' }], undo: 'yes' },
    { items: Array.from({ length: MAX_CLEAR_ITEMS + 1 }, (_, i) => ({ key: `thread:owner@example.com:${i}`, receivedAt: '2030-03-05T10:00:00Z' })) },
  ];
  for (const body of bad) assert.equal(parseClearBody(body, NOW).ok, false, JSON.stringify(body)?.slice(0, 80));
});

test('same-origin JSON only, size capped', () => {
  const ok = { origin: 'https://onyx.example', host: 'onyx.example', 'content-type': 'application/json', 'content-length': '120' };
  assert.equal(checkClearRequest(headers(ok), 'https://onyx.example'), null);
  assert.equal(checkClearRequest(headers({ ...ok, origin: undefined }), 'https://onyx.example').status, 403);
  assert.equal(checkClearRequest(headers({ ...ok, origin: 'https://evil.example' }), 'https://onyx.example').status, 403);
  assert.equal(checkClearRequest(headers({ ...ok, 'content-type': 'text/plain' }), 'https://onyx.example').status, 415);
  assert.equal(checkClearRequest(headers({ ...ok, 'content-length': '999999' }), 'https://onyx.example').status, 413);
});

test('a cleared thread stays hidden only while nothing newer arrived', () => {
  assert.equal(stillCleared('2030-03-05T10:00:00+00:00', '2030-03-05T10:00:00.000Z'), true);
  assert.equal(stillCleared('2030-03-05T09:00:00Z', '2030-03-05T10:00:00Z'), true);
  assert.equal(stillCleared('2030-03-05T10:00:01Z', '2030-03-05T10:00:00Z'), false);
  assert.equal(stillCleared('junk', '2030-03-05T10:00:00Z'), false);
});

test('the stored id is a SHA-256 hex of the key (no address in the table)', async () => {
  const h = await clearKeyHash(KEY);
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(h, require('node:crypto').createHash('sha256').update(KEY).digest('hex'));
  assert.ok(!h.includes('example'));
});

test('client hide key changes with a newer message; toast text', () => {
  assert.notEqual(hiddenEmailKey({ key: KEY, receivedAt: 'a' }), hiddenEmailKey({ key: KEY, receivedAt: 'b' }));
  assert.equal(clearedLabel(1), 'Cleared 1');
  assert.equal(clearedLabel(4), 'Cleared 4');
});

test('the clear route is owner-session only and touches nothing in Gmail', () => {
  const middleware = src('middleware.ts');
  assert.ok(!/urgent-email/.test(middleware), 'never add /api/urgent-email to the CI carve-out');
  const route = src('app', 'api', 'urgent-email', 'clear', 'route.ts');
  assert.ok(route.includes('checkClearRequest(') && route.includes('parseClearBody('));
  assert.ok(/from\("today_cleared_emails"\)/.test(route));
  assert.ok(!/inbox_emails"|imap|gmail\.googleapis/i.test(route), 'the route writes only the clear marks');
  assert.ok(!/console\.error\([^)]*(key|items|body)\b/.test(route), 'logs carry a database code only');
});
