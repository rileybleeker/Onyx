// Run: node --test tests/wins.test.cjs (compiles only the pure status mapper).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const output = mkdtempSync(path.join(tmpdir(), 'onyx-wins-'));
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), 'src/lib/wins.ts', '--outDir', output, '--module', 'commonjs', '--target', 'ES2022', '--skipLibCheck']);
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
