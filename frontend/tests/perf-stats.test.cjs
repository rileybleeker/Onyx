// Run: node --test tests/perf-stats.test.cjs
// The pure statistics + request-classification helpers behind the manual production timing run
// (e2e/perf-stats.cjs, e2e/perf-report.cjs). Offline, invented numbers and example.test hosts only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const stats = require('../e2e/perf-stats.cjs');
const report = require('../e2e/perf-report.cjs');

const ORIGIN = 'https://app.example.test';
const WORKER = 'worker.example.test';

test('percentile interpolates, ignores null/NaN, and handles tiny inputs', () => {
  assert.equal(stats.percentile([], 50), null);
  assert.equal(stats.percentile([7], 95), 7);
  assert.equal(stats.percentile([1, 2, 3, 4], 50), 2.5);
  assert.equal(stats.percentile([10, null, NaN, undefined, 20, 30], 50), 20);
  const fifteen = Array.from({ length: 15 }, (_, i) => i + 1);
  assert.equal(stats.percentile(fifteen, 50), 8);
  assert.ok(Math.abs(stats.percentile(fifteen, 95) - 14.3) < 1e-9);
  assert.equal(stats.percentile(fifteen, 0), 1);
  assert.equal(stats.percentile(fifteen, 100), 15);
});

test('classifyRequest sorts requests into classes and never keeps a query string', () => {
  const c = (url, type = 'fetch') => stats.classifyRequest(url, type, ORIGIN, WORKER);
  assert.deepEqual(c('https://abc.supabase.co/rest/v1/whoop_cycles?select=a&calendar_date=gte.2026-01-01'), { cls: 'rest', key: '/rest/v1/whoop_cycles' });
  assert.deepEqual(c('https://abc.supabase.co/rest/v1/rpc/some_fn'), { cls: 'rest', key: '/rest/v1/rpc/some_fn' });
  assert.deepEqual(c('https://abc.supabase.co/auth/v1/user'), { cls: 'supabase-auth', key: '/auth/v1/user' });
  assert.equal(c('https://abc.supabase.co/storage/v1/x').cls, 'other');
  assert.deepEqual(c(`${ORIGIN}/api/status?x=1`), { cls: 'api', key: '/api/status' });
  assert.deepEqual(c(`${ORIGIN}/sleep?_rsc=abc`, 'fetch'), { cls: 'rsc', key: '/sleep?_rsc' });
  assert.equal(c(`${ORIGIN}/_next/static/chunks/a.js`, 'script').cls, 'static');
  assert.equal(c(`${ORIGIN}/sleep`, 'document').cls, 'document');
  assert.deepEqual(c(`https://${WORKER}/onyx/inbox?since=1`), { cls: 'worker', key: '/onyx/inbox' });
  assert.equal(c('https://tiles.example.test/1/2/3.png', 'image').cls, 'other');
  assert.equal(c('not a url').cls, 'other');
  for (const url of [`${ORIGIN}/api/status?token=SECRET`, 'https://abc.supabase.co/rest/v1/t?apikey=SECRET']) {
    assert.ok(!c(url).key.includes('SECRET'));
  }
});

test('foldRequests totals per class and per endpoint', () => {
  const recs = [
    { cls: 'rest', key: '/rest/v1/a', startMs: 100, endMs: 300, durMs: 190, bytes: 1000, failed: false },
    { cls: 'rest', key: '/rest/v1/a', startMs: 110, endMs: 410, durMs: 290, bytes: 2000, failed: false },
    { cls: 'rest', key: '/rest/v1/b', startMs: 120, endMs: 220, durMs: 100, bytes: 500, failed: false },
    { cls: 'api', key: '/api/x', startMs: 50, endMs: 150, bytes: 10, failed: true },
  ];
  const f = stats.foldRequests(recs);
  assert.equal(f.req.rest.n, 3);
  assert.equal(f.req.rest.ms, 580);
  assert.equal(f.req.rest.endMs, 410);
  assert.equal(f.req.rest.bytes, 3500);
  assert.equal(f.req.api.n, 1);
  assert.equal(f.req.api.failed, 1);
  assert.equal(f.req.api.ms, 100, 'a record without durMs falls back to end - start');
  assert.deepEqual(f.total, { n: 4, bytes: 3510 });
  assert.equal(f.endpoints['rest /rest/v1/a'].n, 2);
  assert.equal(f.endpoints['rest /rest/v1/a'].maxMs, 290);
});

function sample(i, ready, restN, over = {}) {
  const recs = Array.from({ length: restN }, (_, k) => ({ cls: 'rest', key: `/rest/v1/t${k % 2}`, startMs: 10, endMs: 60, durMs: 50, bytes: 100, failed: false }));
  const f = stats.foldRequests(recs);
  return { i, cold: i === 0, ok: true, ttfb: 100 + i, fcp: 200, lcp: 300, ready, firstChart: ready + 10, req: f.req, total: f.total, endpoints: f.endpoints, cache: 'HIT', region: 'iad1>iad1', ...over };
}

test('summarizePage keeps the cold navigation out of the warm percentiles and counts failures', () => {
  const samples = [sample(0, 5000, 8)];
  for (let i = 1; i <= 14; i++) samples.push(sample(i, 1000 + i * 10, 4));
  samples.push({ i: 15, cold: false, ok: false, error: 'ready-timeout' });
  const s = stats.summarizePage(samples);
  assert.equal(s.total, 16);
  assert.equal(s.ok, 15);
  assert.equal(s.failed, 1);
  assert.equal(s.timing.ready.n, 14);
  assert.equal(s.timing.ready.p50, 1075, 'warm median only: 1010..1140');
  assert.equal(s.cold.ready, 5000);
  assert.equal(s.cold.rest, 8);
  assert.equal(s.requests.rest.n, 4);
  assert.equal(s.requests.rest.ms, 200);
  assert.deepEqual(s.cache, { HIT: 15 });
  assert.equal(s.endpoints[0].callsPerView, 2);
  assert.equal(s.endpoints[0].callMsP50, 50);
});

test('summarizePage with no usable navigations returns nulls instead of throwing', () => {
  const s = stats.summarizePage([{ i: 0, cold: true, ok: false, error: 'ready-timeout' }]);
  assert.equal(s.ok, 0);
  assert.equal(s.cold, null);
  assert.equal(s.timing.ready.p50, null);
  assert.equal(s.requests.rest.n, null);
});

test('report renders tables and a stability section from result files', () => {
  const dirs = [0, 1].map((run) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-report-'));
    const samples = [sample(0, 4000, 6)];
    for (let i = 1; i <= 14; i++) samples.push(sample(i, (run === 0 ? 1000 : 1100) + i, 3));
    fs.writeFileSync(path.join(dir, 'sleep.json'), JSON.stringify({ meta: { slug: 'sleep', label: '/sleep', navigations: 15, startedAt: 'T', github: { runId: String(run) }, runner: {} }, samples }));
    return dir;
  });
  const md = report.render(dirs.map(report.loadRun));
  assert.match(md, /\| \/sleep \| 15\/15 \|/);
  assert.match(md, /Stability across runs/);
  assert.match(md, /\| \/sleep \| Data ready \| 1008 \| 1108 \| 10%/);
  assert.match(md, /rest \/rest\/v1\/t0/);
  assert.ok(!/NaN|undefined/.test(md), 'no NaN/undefined leaks into the output');
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

test('normRegion drops per-request ids and tells CDN answers from function runs', () => {
  assert.equal(stats.normRegion('iad1'), 'iad1 (cdn)');
  assert.equal(stats.normRegion('iad1>iad1'), 'iad1>iad1 (function)');
  assert.equal(stats.normRegion('iad1>zqs8v-1794452282628-11b03cce4640'), 'iad1 (cdn)', 'run-1 samples kept the request id');
  assert.equal(stats.normRegion(null), null);
});
