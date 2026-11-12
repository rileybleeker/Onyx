// Run: node --test tests/wins.test.cjs (compiles only the pure status mapper and the GitHub reader).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const output = mkdtempSync(path.join(tmpdir(), 'onyx-wins-'));
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), 'next-env.d.ts', 'src/lib/wins.ts', 'src/lib/wins-server.ts', '--outDir', output, '--module', 'commonjs', '--target', 'ES2022', '--skipLibCheck']);
const { makeBoard, highlights, groupByStage, stageOrder } = require(path.join(output, 'wins.js'));
const state = (row) => makeBoard([ { number: 15, ...row } ], null).wins.find(w => w.pr === 15).state;
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
  assert.equal(makeBoard([{ number: 15, state: 'closed', merged_at: '2026-11-11T01:28:08-05:00' }], null).wins.find(w => w.pr === 15).mergedAt, '2026-11-11T06:28:08.000Z');
});

// Stage separation: proposals, drafts, merged and deployed never mix.
const SITE_PR = highlights.find(h => h.surface === 'site').pr;
const BEHIND_PR = highlights.find(h => h.surface === 'behind').pr;
const production = { sha: 'a'.repeat(40), committedAt: '2026-11-11T08:00:00.000Z' };
const merged = (number, at, extra = {}) => ({ number, state: 'closed', merged_at: at, ...extra });
const stageOf = (rows, pr, prod = production) => makeBoard(rows, null, prod).wins.find(w => w.pr === pr).state;
test('a website change is live only after a later successful production deploy', () => {
  assert.equal(stageOf([merged(SITE_PR, '2026-11-11T07:00:00Z')], SITE_PR), 'deployed');
  assert.equal(stageOf([merged(SITE_PR, '2026-11-11T09:00:00Z')], SITE_PR), 'merged');
  assert.equal(stageOf([merged(SITE_PR, '2026-11-11T09:00:00Z', { merge_commit_sha: production.sha })], SITE_PR), 'deployed');
  assert.equal(stageOf([merged(SITE_PR, '2026-11-11T07:00:00Z')], SITE_PR, null), 'merged');
});
test('behind-the-scenes work is merged, never claimed as live on the site', () => {
  assert.equal(stageOf([merged(BEHIND_PR, '2026-11-11T07:00:00Z')], BEHIND_PR), 'merged');
});
test('drafts, reviews and failures are never deployed even with a newer production deploy', () => {
  for (const [row, expected] of [
    [{ state: 'open', merged_at: null, draft: true }, 'draft'],
    [{ state: 'open', merged_at: null, draft: false }, 'review'],
    [{ state: 'closed', merged_at: null }, 'closed'],
    [{ state: 'open', merged_at: '2026-11-11T07:00:00Z', draft: false }, 'unknown'],
  ]) assert.equal(stageOf([{ number: SITE_PR, ...row }], SITE_PR), expected);
  assert.equal(stageOf([], SITE_PR), 'unknown');
});
test('groups keep each stage apart, in delivery order, with no overlap', () => {
  const rows = [
    merged(SITE_PR, '2026-11-11T07:00:00Z'),
    merged(BEHIND_PR, '2026-11-11T07:00:00Z'),
    ...highlights.filter(h => h.pr !== SITE_PR && h.pr !== BEHIND_PR).map((h, i) => ({ number: h.pr, state: 'open', merged_at: null, draft: i % 2 === 0 })),
  ];
  const groups = groupByStage(makeBoard(rows, null, production).wins);
  assert.deepEqual(groups.map(g => g.state), ['deployed', 'merged', 'review', 'draft']);
  assert.ok(groups.every(g => g.wins.every(w => w.state === g.state)));
  assert.equal(groups.reduce((n, g) => n + g.wins.length, 0), highlights.length);
  assert.deepEqual(groups.map(g => g.state), stageOrder.filter(s => groups.some(g => g.state === s)));
  assert.deepEqual(groupByStage(makeBoard(null, null).wins).map(g => g.state), ['unknown']);
});
test('curated board covers the confirmed merged work and stays truthful', () => {
  const prs = highlights.map(h => h.pr);
  for (const pr of [8, 11, 12, 15, 17, 18, 25, 26, 27]) assert.ok(prs.includes(pr), `PR #${pr} should be on the board`);
  assert.equal(new Set(prs).size, prs.length);
  for (const h of highlights) {
    assert.ok(h.title && h.summary && h.benefit, `PR #${h.pr} needs title, summary and benefit`);
    assert.ok(['site', 'behind'].includes(h.surface));
  }
  // Nothing may read as delivered before GitHub says so: no row data means no delivered stage.
  assert.ok(makeBoard(null, null, production).wins.every(w => w.state === 'unknown'));
});

// Stub only Next's server-only marker; all fetches below are deterministic fixtures.
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function(name, ...args) { return name === 'server-only' ? {} : originalLoad.call(this, name, ...args); };
const { getWins } = require(path.join(output, 'wins-server.js'));
Module._load = originalLoad;

const SHA = 'b'.repeat(40);
const dated = (when) => ({ headers: { Date: when } });
// Deterministic GitHub stand-in routed by URL. Options let a test break one endpoint at a time.
function fakeGitHub({ pulls = 'ok', deployments = 'ok' } = {}) {
  const calls = [];
  const stub = async (url, options) => {
    calls.push([url, options.next.revalidate]);
    if (url.includes('/deployments?')) {
      if (deployments === 'fail') return new Response('', { status: 503 });
      return new Response(JSON.stringify([{ id: 7, sha: SHA }]), dated('Wed, 11 Nov 2026 05:30:00 GMT'));
    }
    if (url.includes('/deployments/7/statuses')) return new Response(JSON.stringify([{ state: deployments === 'pending' ? 'pending' : 'success' }]), dated('Wed, 11 Nov 2026 05:30:00 GMT'));
    if (url.includes(`/commits/${SHA}`)) return new Response(JSON.stringify({ commit: { committer: { date: '2026-11-11T08:00:00Z' } } }), dated('Wed, 11 Nov 2026 05:30:00 GMT'));
    if (url.includes('?')) return pulls === 'down' ? new Response('', { status: 503 }) : new Response('[]', dated('Wed, 11 Nov 2026 06:00:00 GMT'));
    if (pulls === 'fallback-missing') return new Response('', { status: 404 });
    const number = Number(url.split('/').pop());
    return new Response(JSON.stringify({ number, state: 'closed', merged_at: '2026-11-11T06:28:08Z' }), dated('Wed, 11 Nov 2026 05:00:00 GMT'));
  };
  return { stub, calls };
}
test('older curated PRs use bounded cached fallback and oldest source date', async () => {
  const original = global.fetch;
  const { stub, calls } = fakeGitHub();
  global.fetch = stub;
  try {
    const board = await getWins();
    const isDeployInfo = (c) => c[0].includes('/deployments') || c[0].includes('/commits/');
    assert.equal(board.checkedAt, '2026-11-11T05:00:00.000Z');
    assert.equal(calls.filter(c => !isDeployInfo(c)).length, highlights.length + 1);
    assert.equal(calls[0][1], 300);
    assert.ok(calls.filter(c => c[0].includes('/pulls/')).every(c => c[1] === 3600));
    assert.ok(calls.filter(isDeployInfo).every(c => c[1] === 900));
    assert.ok(calls.filter(isDeployInfo).length <= 3);
    // Website changes merged before the production commit are live; everything else is only merged.
    assert.ok(board.wins.every(w => w.state === (w.surface === 'site' ? 'deployed' : 'merged')));
  } finally { global.fetch = original; }
});
test('a failed or unfinished production lookup never promotes a merge to live', async () => {
  const original = global.fetch;
  try {
    for (const deployments of ['fail', 'pending']) {
      global.fetch = fakeGitHub({ deployments }).stub;
      const board = await getWins();
      assert.ok(board.wins.every(w => w.state === 'merged'), `deployments=${deployments}`);
    }
  } finally { global.fetch = original; }
});
test('list outage and individual fallback failure stay unavailable', async () => {
  const original = global.fetch;
  try {
    global.fetch = fakeGitHub({ pulls: 'down' }).stub;
    assert.ok((await getWins()).wins.every(w => w.state === 'unknown'));
    global.fetch = fakeGitHub({ pulls: 'fallback-missing' }).stub;
    assert.ok((await getWins()).wins.every(w => w.state === 'unknown'));
    global.fetch = async () => new Response('', { status: 503 });
    assert.ok((await getWins()).wins.every(w => w.state === 'unknown'));
  } finally { global.fetch = original; }
});
