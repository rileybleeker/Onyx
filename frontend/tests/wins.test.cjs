// Run: node --test tests/wins.test.cjs (compiles only the pure status mapper).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const output = mkdtempSync(path.join(tmpdir(), 'onyx-wins-'));
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), 'next-env.d.ts', 'src/lib/wins.ts', 'src/lib/wins-server.ts', '--outDir', output, '--module', 'commonjs', '--target', 'ES2022', '--skipLibCheck']);
const { makeBoard, highlights } = require(path.join(output, 'wins.js'));
const state = (row) => makeBoard([ { number: 15, ...row } ], null).wins[0].state;
test('merge status requires a real merge timestamp, not merely closed', () => {
  assert.equal(state({ state: 'closed', merged_at: '2026-11-11T06:28:08Z' }), 'merged');
  assert.equal(state({ state: 'closed', merged_at: null }), 'closed');
  assert.equal(state({ state: 'closed', merged_at: 'garbage' }), 'unknown');
});
test('drafts and reviews are never celebrated as merged', () => {
  assert.equal(state({ state: 'open', merged_at: null, draft: true }), 'draft');
  assert.equal(state({ state: 'open', merged_at: null, draft: false }), 'review');
  assert.equal(state({ state: 'open', merged_at: null }), 'unknown');
});
test('outages, omitted rows and malformed metadata fail visibly', () => {
  for (const input of [null, {}, [], [null], [{ number: 15 }]]) {
    assert.ok(makeBoard(input, null).wins.every(w => w.state === 'unknown'));
  }
});
test('only curated public-safe entries are rendered, never remote content', () => {
  const board = makeBoard([{ number: 999, title: 'private' }, { number: 15, title: 'injection', body: 'secret', state: 'open', merged_at: null, draft: false }], null);
  assert.equal(board.wins.length, highlights.length);
  assert.equal(board.wins[0].title, highlights[0].title);
  assert.ok(!JSON.stringify(board).includes('secret'));
  assert.ok(!JSON.stringify(board).includes('injection'));
});

test('contradictory merge metadata is not accepted', () => {
  assert.equal(state({ state: 'open', merged_at: '2026-11-11T06:28:08Z', draft: false }), 'unknown');
});
test('parseable merge dates are normalized before display', () => {
  assert.equal(makeBoard([{ number: 15, state: 'closed', merged_at: '2026-11-11T01:28:08-05:00' }], null).wins[0].mergedAt, '2026-11-11T06:28:08.000Z');
});

// Stub only Next's server-only marker; all fetches below are deterministic fixtures.
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function(name, ...args) { return name === 'server-only' ? {} : originalLoad.call(this, name, ...args); };
const { getWins } = require(path.join(output, 'wins-server.js'));
Module._load = originalLoad;
test('older curated PRs use bounded cached fallback and oldest source date', async () => {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push([url, options.next.revalidate]);
    const number = Number(url.split('/').pop());
    return new Response(JSON.stringify(Number.isFinite(number) ? { number, state: 'closed', merged_at: '2026-11-11T06:28:08Z' } : []), { headers: { Date: Number.isFinite(number) ? 'Wed, 11 Nov 2026 05:00:00 GMT' : 'Wed, 11 Nov 2026 06:00:00 GMT' } });
  };
  try {
    const board = await getWins();
    assert.ok(board.wins.every(w => w.state === 'merged'));
    assert.equal(board.checkedAt, '2026-11-11T05:00:00.000Z');
    assert.equal(calls.length, highlights.length + 1);
    assert.equal(calls[0][1], 300);
    assert.ok(calls.slice(1).every(call => call[1] === 3600));
  } finally { global.fetch = original; }
});
test('list outage and individual fallback failure stay unavailable', async () => {
  const original = global.fetch;
  try {
    global.fetch = async () => new Response('', { status: 503 });
    assert.ok((await getWins()).wins.every(w => w.state === 'unknown'));
    global.fetch = async url => url.includes('?') ? new Response('[]') : new Response('', { status: 404 });
    assert.ok((await getWins()).wins.every(w => w.state === 'unknown'));
  } finally { global.fetch = original; }
});
