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

function budgetPage(slug, over = {}) {
  // A complete, fast page: 4 navigations planned and measured, warm data ready under a second, every call fast.
  const summary = {
    total: 4, ok: 4, failed: 0,
    cold: { ready: 600 },
    coldEndpoints: [{ cls: 'api', key: '/api/x', maxMs: 300 }],
    timing: { ready: { p95: 480, max: 500, n: 3, values: [420, 450, 500] } },
    endpoints: [{ cls: 'api', key: '/api/x', callMsP50: 180, callMsMax: 240, callMaxP95: 230, maxPerView: [180, 200, 240] }],
    ...over,
  };
  return { slug, label: '/' + slug, expected: 4, summary };
}

test('speed budget: a complete fast page passes', () => {
  assert.deepEqual(stats.budgetViolations([budgetPage('fast')]), []);
  assert.equal(stats.SPEED_BUDGET_MS, 1000);
});

test('speed budget: one slow call is caught even when the per-view mean is fast (1500 + 100 ms)', () => {
  // Codex 2026-11-14: two calls of 1500 and 100 ms averaged to 800 ms and passed.
  const recs = [
    { cls: 'rest', key: '/rest/v1/a', startMs: 0, endMs: 1500, durMs: 1500, bytes: 1, failed: false },
    { cls: 'rest', key: '/rest/v1/a', startMs: 0, endMs: 100, durMs: 100, bytes: 1, failed: false },
  ];
  const samples = [sample(0, 400, 0)];
  for (let i = 1; i <= 3; i++) {
    const f = stats.foldRequests(i === 2 ? recs : [recs[1]]);
    samples.push({ ...sample(i, 400, 0), req: f.req, total: f.total, endpoints: f.endpoints });
  }
  const summary = stats.summarizePage(samples);
  const e = summary.endpoints.find((x) => x.key === '/rest/v1/a');
  assert.equal(e.callMsP50, 100, 'the old per-view mean statistic hides it');
  assert.equal(e.callMsMax, 1500);
  assert.deepEqual(stats.budgetViolations([{ slug: 'p', label: '/p', expected: 4, summary }]),
    ['/p: /rest/v1/a took 1500 ms (isolated: 1 of 3 warm views, warm p95 1360 ms)']);
});

test('speed budget: a repeatable slow call or page is labelled repeatable', () => {
  const over = stats.budgetViolations([budgetPage('slow', {
    timing: { ready: { p95: 1180, max: 1200, n: 3, values: [1100, 1150, 1200] } },
    endpoints: [{ cls: 'api', key: '/api/y', callMsP50: 1300, callMsMax: 1500, callMaxP95: 1480, maxPerView: [1200, 1300, 1500] },
      { cls: 'static', key: '/_next/*', callMsMax: 3000, maxPerView: [3000] }],
  })]);
  assert.deepEqual(over, [
    '/slow: data ready 1200 ms in the slowest warm view (repeatable: 3 of 3 warm views, warm p95 1180 ms)',
    '/slow: /api/y took 1500 ms (repeatable: 3 of 3 warm views, warm p95 1480 ms)',
  ], 'static chunks are not API calls');
});

test('speed budget: the cold first visit counts, for data ready and for its calls', () => {
  const over = stats.budgetViolations([budgetPage('cold', { cold: { ready: 1361 }, coldEndpoints: [{ cls: 'worker', key: '/onyx/inbox', maxMs: 1100 }] })]);
  assert.deepEqual(over, ['/cold: data ready 1361 ms on the cold first visit', '/cold: /onyx/inbox took 1100 ms on the cold first visit']);
});

test('speed budget: an incomplete page is a breach, never a pass', () => {
  assert.deepEqual(stats.budgetViolations([budgetPage('failed', { failed: 1, ok: 3 })]),
    ['/failed: 1 of 4 navigations never reached data-ready (counts as over 1000 ms)']);
  assert.deepEqual(stats.budgetViolations([budgetPage('short', { total: 2, ok: 2 })]), ['/short: only 2 of 4 navigations were measured']);
  // Only the cold navigation succeeded: no warm number at all used to mean "no violation".
  const onlyCold = stats.budgetViolations([budgetPage('cold-only', { ok: 1, failed: 3, timing: { ready: { p95: null, max: null, n: 0, values: [] } } })]);
  assert.deepEqual(onlyCold, ['/cold-only: 3 of 4 navigations never reached data-ready (counts as over 1000 ms)', '/cold-only: no warm navigation reached data-ready']);
});

test('report passes the planned navigation count to the budget and orders in-app pages after full loads', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-report-'));
  const write = (slug, label, navigations, n) => {
    const samples = [sample(0, 400, 2)];
    for (let i = 1; i < n; i++) samples.push(sample(i, 400 + i, 2));
    fs.writeFileSync(path.join(dir, `${slug}.json`), JSON.stringify({ meta: { slug, label, navigations, startedAt: 'T', github: {}, runner: {} }, samples }));
  };
  write('nav-sleep', '/sleep (in-app)', 4, 4);
  write('sleep', '/sleep', 4, 2);
  const run = report.loadRun(dir);
  assert.deepEqual(run.pages.map((p) => p.slug), ['sleep', 'nav-sleep']);
  assert.equal(run.pages[0].expected, 4);
  assert.deepEqual(stats.budgetViolations(run.pages), ['/sleep: only 2 of 4 navigations were measured']);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Harness version 2: cache state, fixed window by purpose and origin, robust percentiles with n, the measured
// production revision, the observe-only phone scenario. Synthetic numbers and example.test hosts only.
// ---------------------------------------------------------------------------

test('robust percentiles carry n and a low-n warning, and never throw on empty input', () => {
  const r = stats.robust([400, 410, 420, null, NaN, 1300]);
  assert.equal(r.n, 4);
  assert.equal(r.p50, 415);
  assert.equal(r.max, 1300);
  assert.equal(r.lowN, true, `n=4 is below LOW_N=${stats.LOW_N}`);
  assert.equal(r.mad, 10, 'median absolute deviation ignores the one slow view');
  const big = stats.robust(Array.from({ length: 20 }, (_, i) => 100 + i));
  assert.equal(big.lowN, false);
  assert.equal(big.iqr, 9.5);
  const none = stats.robust([]);
  assert.equal(none.n, 0);
  assert.equal(none.p50, null);
  assert.equal(none.lowN, true);
});

test('viaOf: service worker, memory / disk / prefetch cache, network, and unknown when the browser did not say', () => {
  assert.equal(stats.viaOf(undefined), 'unknown', 'probe unavailable or request not in the log');
  assert.equal(stats.viaOf({}), 'unknown', 'still open: no response seen');
  assert.equal(stats.viaOf({ responded: true }), 'network');
  assert.equal(stats.viaOf({ servedFromCache: true, responded: true }), 'memory-cache');
  assert.equal(stats.viaOf({ fromDiskCache: true, responded: true }), 'disk-cache');
  assert.equal(stats.viaOf({ fromPrefetchCache: true, responded: true }), 'prefetch-cache');
  assert.equal(stats.viaOf({ fromServiceWorker: true, fromDiskCache: true, responded: true }), 'service-worker');
});

test('purposeOf: prefetch wins, then before / after data-ready, unknown when the page never got ready', () => {
  assert.equal(stats.purposeOf({ startMs: 50, prefetch: true }, 400), 'prefetch');
  assert.equal(stats.purposeOf({ startMs: 50 }, 400), 'routed');
  assert.equal(stats.purposeOf({ startMs: 400 }, 400), 'background', 'started at the ready moment = after it');
  assert.equal(stats.purposeOf({ startMs: 50 }, null), 'unknown');
});

function rec(cls, startMs, over = {}) {
  return { cls, key: `/${cls}`, startMs, endMs: startMs + 100, durMs: 100, bytes: 1000, failed: false, prefetch: false, via: 'network', ...over };
}

test('foldWindow counts only requests that started inside the fixed window, split by purpose and origin', () => {
  const records = [
    rec('document', 0),
    rec('static', 20, { via: 'disk-cache' }),
    rec('static', 25, { via: 'memory-cache' }),
    rec('rest', 100),
    rec('api', 120, { via: 'unknown' }),
    rec('rsc', 3000, { prefetch: true }),
    rec('api', 2500),
    rec('rest', 2600, { via: 'service-worker' }),
    rec('rest', 6000), // starts exactly at the window end: outside
    rec('api', 9000),
  ];
  const w = stats.foldWindow(records, { windowMs: 6000, readyAtMs: 450, observedMs: 6100 });
  assert.equal(w.complete, true);
  assert.equal(w.total.n, 8);
  assert.deepEqual(
    { n: w.purpose.routed.n, data: w.purpose.routed.data, network: w.purpose.routed.network, cached: w.purpose.routed.cached, unknownVia: w.purpose.routed.unknownVia },
    { n: 5, data: 2, network: 2, cached: 2, unknownVia: 1 }
  );
  assert.deepEqual(
    { n: w.purpose.background.n, data: w.purpose.background.data, network: w.purpose.background.network, serviceWorker: w.purpose.background.serviceWorker },
    { n: 2, data: 2, network: 1, serviceWorker: 1 }
  );
  assert.equal(w.purpose.prefetch.n, 1);
  assert.equal(w.via['disk-cache'], 1);
  assert.equal(w.via['memory-cache'], 1);
  assert.equal(w.via.unknown, 1);
  assert.equal(w.purpose.routed.cls.static, 2);
});

test('foldWindow: a window not observed to its end is incomplete, and an unknown origin is never counted as network', () => {
  const w = stats.foldWindow([rec('api', 10, { via: undefined })], { windowMs: 6000, readyAtMs: 300, observedMs: 2500 });
  assert.equal(w.complete, false);
  assert.equal(w.purpose.routed.network, 0);
  assert.equal(w.purpose.routed.unknownVia, 1);
  const neverReady = stats.foldWindow([rec('api', 10)], { windowMs: 6000, readyAtMs: null, observedMs: 6000 });
  assert.equal(neverReady.purpose.unknown.n, 1, 'no data-ready: nothing is called routed or background');
});

test('foldWindow: an in-app window starts at the click; earlier records are counted apart and a full window follows the input', () => {
  // Click at 1500 ms on the request clock (after scrolling to the link and marking the old page), window 4000 ms:
  // [1500, 5500). The rsc and api requests before the click are the previous page's or the preparation's, not this page's.
  const records = [rec('rsc', 100), rec('api', 900), rec('rsc', 1500, { prefetch: true }), rec('rest', 1600), rec('api', 5400), rec('api', 5600)];
  const w = stats.foldWindow(records, { windowMs: 4000, readyAtMs: 1900, observedMs: 5550, anchorMs: 1500 });
  assert.equal(w.anchorMs, 1500);
  assert.deepEqual(w.beforeAnchor, { n: 2, data: 1 });
  assert.equal(w.total.n, 3, 'the hover prefetch at the click, the routed read, one background read; 5600 is past the window');
  assert.equal(w.purpose.prefetch.n, 1);
  assert.equal(w.purpose.routed.n, 1);
  assert.equal(w.purpose.background.n, 1);
  assert.equal(w.readyAtMs, 400, 'reported from the window start');
  assert.equal(w.observedMs, 4050);
  assert.equal(w.complete, true, 'observed 4050 ms after the click');
  const cut = stats.foldWindow(records, { windowMs: 4000, readyAtMs: 1900, observedMs: 5000, anchorMs: 1500 });
  assert.equal(cut.complete, false, 'only 3500 ms after the click: a late click never passes for a full window');
  const fromStart = stats.foldWindow(records, { windowMs: 4000, readyAtMs: 1900, observedMs: 5000 });
  assert.equal(fromStart.anchorMs, 0);
  assert.deepEqual(fromStart.beforeAnchor, { n: 0, data: 0 }, 'a full load anchors at navigation start');
});

test('foldWindow: a request still open when observation stopped is unfinished, its cost unknown, never zero', () => {
  const open = rec('api', 3000, { endMs: undefined, durMs: undefined, bytes: 0, via: undefined });
  const w = stats.foldWindow([rec('api', 100), open], { windowMs: 6000, readyAtMs: 500, observedMs: 6000 });
  assert.equal(w.complete, true);
  assert.equal(w.total.n, 2, 'it started in the window, so it is counted');
  assert.equal(w.total.pending, 1);
  assert.equal(w.costComplete, false);
  assert.equal(w.purpose.background.pending, 1);
  assert.equal(w.purpose.background.ms, 0, 'no duration is invented for the open request');
  assert.equal(w.purpose.background.unknownVia, 1, 'no response seen: origin unknown, not network');
  assert.equal(w.purpose.routed.ms, 100);
  assert.equal(w.total.bytes, 1000, 'only the finished request has a size');
  assert.equal(stats.foldWindow([rec('api', 100)], { windowMs: 6000, readyAtMs: 500, observedMs: 6000 }).costComplete, true);
});

test('windowTable: unfinished requests, the service-worker count and a window anchored at the click are shown', () => {
  const pend = (i, ready) => v2sample(i, ready, {
    window: stats.foldWindow([rec('rest', 50), rec('api', ready + 100, { via: 'service-worker' }), rec('api', ready + 300, { endMs: undefined, durMs: undefined, via: undefined })],
      { windowMs: 6000, readyAtMs: ready, observedMs: 6050 }),
  });
  const s = stats.summarizePage([pend(0, 900), pend(1, 400), pend(2, 420), v2sample(3, 410)]);
  const md = stats.windowTable([{ label: '/x', summary: s }]);
  assert.match(md, /\| \/x \| 6000 from navigation start \| 4 \/ 4 \(4\) \|/);
  assert.match(md, /\| 0 \/ 0 \/ 1 \/ 1 \|/, 'background: network / cached / SW / unknown');
  assert.match(md, /\| 0 \| 1 \(2 of 3 windows\) \| - \|/, 'prefetch n, unfinished, before the click (n/a for a full load)');
  // In-app: round 1 has no fixed window (version 1 spacing), later rounds start the window at the click.
  const click = (i, ready) => ({
    ...v2sample(i, ready),
    cacheState: stats.cacheStateOf({ mode: 'click', first: false }),
    window: stats.foldWindow([rec('rsc', 10), rec('rest', 1300)], { windowMs: 4000, readyAtMs: 1200 + ready, observedMs: 5300, anchorMs: 1200 }),
  });
  const first = { ...sample(0, 500, 2), cacheState: stats.cacheStateOf({ mode: 'click', first: true }) };
  const nav = stats.summarizePage([first, click(1, 300), click(2, 310), click(3, 320)]);
  assert.equal(nav.coldWindow, null, 'the first in-app visit has no fixed window');
  const navMd = stats.windowTable([{ label: '/x (in-app)', summary: nav }]);
  assert.match(navMd, /\| \/x \(in-app\) \| 4000 from the click \| 3 \/ 3 \(4\) \|/);
  assert.match(navMd, /\| 0 \| 0 \| 1 \| /, 'prefetch n, unfinished, one request before the click');
  assert.match(navMd, /\| - \|$/, 'no first-navigation window');
  assert.ok(!/NaN|undefined/.test(md + navMd));
});

test('foldLongTasks: blocking time is the part over 50 ms, bounded by the window, split at data-ready', () => {
  const t = stats.foldLongTasks([[100, 120], [300, 60], [700, 200], [7000, 500], [null, 90]], 0, 6000, 500);
  assert.equal(t.n, 3);
  assert.equal(t.totalMs, 380);
  assert.equal(t.blockingMs, 70 + 10 + 150);
  assert.equal(t.maxMs, 200);
  assert.equal(t.blockingBeforeReadyMs, 80);
  assert.equal(stats.foldLongTasks([], 0, 6000, null).blockingBeforeReadyMs, null);
});

test('cacheStateOf: the empty browser cache is told apart from CDN and function, which stay unknown without headers', () => {
  assert.deepEqual(stats.cacheStateOf({ mode: 'load', first: true, vercelCache: 'HIT', vercelId: 'iad1::abcd1-1794452282628-11b03cce4640' }),
    { browser: 'empty', cdn: 'HIT', fn: 'not-run', fnWarmth: 'n/a' });
  assert.deepEqual(stats.cacheStateOf({ mode: 'load', first: false, vercelCache: 'miss', vercelId: 'iad1::iad1::abcd1-1794452282628-11b03cce4640' }),
    { browser: 'warm', cdn: 'MISS', fn: 'ran', fnWarmth: 'unknown' }, 'whether the function was cold is never visible');
  assert.deepEqual(stats.cacheStateOf({ mode: 'load', first: true }), { browser: 'empty', cdn: 'unknown', fn: 'unknown', fnWarmth: 'n/a' });
  assert.equal(stats.cacheStateOf({ mode: 'click', first: true }).browser, 'prewarmed', 'an in-app first visit is never cold');
});

test('revisionOf and scenarioOf: version 1 files have no revision and keep the old enforcement', () => {
  assert.equal(stats.revisionOf({}), null);
  assert.equal(stats.revisionOf({ deployed: { start: 'a'.repeat(40), end: 'a'.repeat(40) } }), 'a'.repeat(40));
  assert.equal(stats.revisionOf({ deployed: { start: 'a'.repeat(40), end: 'b'.repeat(40) } }), 'mixed');
  assert.equal(stats.revisionOf({ deployed: { start: null, end: null } }), 'unknown');
  // Only one of the two /api/version reads succeeded: a deploy may have landed unseen, so the result is unbound.
  assert.equal(stats.revisionOf({ deployed: { start: 'a'.repeat(40), end: null } }), 'partial', 'end read failed');
  assert.equal(stats.revisionOf({ deployed: { start: null, end: 'b'.repeat(40) } }), 'partial', 'start read failed');
  assert.equal(stats.isExactRevision('a'.repeat(40)), true);
  for (const r of ['mixed', 'partial', 'unknown', null, undefined]) assert.equal(stats.isExactRevision(r), false, String(r));
  assert.deepEqual(['a'.repeat(40), 'mixed', 'partial', 'unknown', null].map(stats.revisionTag), ['aaaaaaa', 'mixed', 'partial', 'unknown', 'not recorded']);
  assert.deepEqual(stats.scenarioOf({ slug: 'nav-sleep' }), { name: 'in-app-prewarmed', enforced: true, harness: 1, detail: null });
  assert.deepEqual(stats.scenarioOf({ slug: 'sleep' }), { name: 'full-load', enforced: true, harness: 1, detail: null });
  assert.equal(stats.scenarioOf({ harness: 2, scenario: { name: 'phone-full-load', enforced: false } }).enforced, false);
});

function v2sample(i, ready, over = {}) {
  const s = sample(i, ready, 2);
  const window = stats.foldWindow([rec('document', 0), rec('rest', 50), rec('api', ready + 100), rec('rsc', ready + 200, { prefetch: true })],
    { windowMs: 6000, readyAtMs: ready, observedMs: 6050 });
  return { ...s, cacheState: stats.cacheStateOf({ mode: 'load', first: i === 0, vercelCache: 'HIT' }), readyAtMs: ready, window,
    longTasks: stats.foldLongTasks([[10, 80]], 0, 6000, ready), feedAtMs: 2100, firstPrefetchAtMs: ready + 200, ...over };
}

test('summarizePage: version 2 aggregates use complete windows only; a version 1 sample yields nulls, never zeros', () => {
  const incomplete = v2sample(3, 410);
  const samples = [v2sample(0, 900), v2sample(1, 400), v2sample(2, 420), { ...incomplete, window: { ...incomplete.window, complete: false } }];
  const s = stats.summarizePage(samples);
  assert.equal(s.harness2, true);
  assert.deepEqual(s.windows, { recorded: 4, complete: 3 });
  assert.equal(s.window.n, 2, 'the incomplete warm window is not averaged in');
  assert.equal(s.window.purpose.routed.n, 2);
  assert.equal(s.window.purpose.background.n, 1);
  assert.equal(s.window.purpose.prefetch.n, 1);
  assert.equal(s.coldWindow.n, 1);
  assert.equal(s.cacheStates.first.browser, 'empty');
  assert.deepEqual(s.cacheStates.rest, { 'warm cdn:HIT fn:unknown': 3 });
  assert.equal(s.readyRobust.n, 3);
  assert.equal(s.blocking.p50, 30);
  const legacy = stats.summarizePage([sample(0, 500, 2), sample(1, 400, 2)]);
  assert.equal(legacy.harness2, false);
  assert.equal(legacy.window, null);
  assert.equal(legacy.cacheStates.first, null);
  assert.equal(legacy.blocking.n, 0);
});

test('speed budget: an observe-only scenario never breaks it but is reported; enforced pages are unchanged', () => {
  const phone = { ...budgetPage('phone-today', { timing: { ready: { p95: 2900, max: 3000, n: 3, values: [2800, 2900, 3000] } } }), enforced: false };
  const desk = budgetPage('today');
  assert.deepEqual(stats.budgetViolations([desk, phone]), [], 'the phone page is not enforced yet');
  assert.deepEqual(stats.observedViolations([desk, phone], []),
    ['/phone-today: data ready 3000 ms in the slowest warm view (repeatable: 3 of 3 warm views, warm p95 2900 ms)']);
  // The same page enforced (a version 1 file, or after promotion) is a breach as before.
  assert.equal(stats.budgetViolations([{ ...phone, enforced: true }]).length, 1);
});

test('speed budget: an observe-only page that was not measured is listed as missing, not as a pass', () => {
  const phone = { ...budgetPage('phone-log', { total: 1, ok: 0, failed: 1, cold: null, timing: { ready: { n: 0, values: [] } } }), enforced: false };
  const lines = stats.observedViolations([phone], []);
  assert.ok(lines.some((l) => l.includes('only 1 of 4 navigations were measured')));
  assert.ok(lines.some((l) => l.includes('never reached data-ready')));
  assert.ok(lines.some((l) => l.includes('no warm navigation reached data-ready')));
});

test('speed budget: an in-app first visit is labelled prewarmed, a full load keeps "cold first visit"', () => {
  const nav = { ...budgetPage('nav-log', { cold: { ready: 1200 }, coldEndpoints: [] }), label: '/log (in-app)', scenario: 'in-app-prewarmed' };
  assert.deepEqual(stats.budgetViolations([nav]), ['/log (in-app): data ready 1200 ms on the first in-app visit (session prewarmed by Today)']);
  const legacyNav = { ...budgetPage('nav-log', { cold: { ready: 1200 }, coldEndpoints: [] }), label: '/log (in-app)' };
  assert.deepEqual(stats.budgetViolations([legacyNav]), ['/log (in-app): data ready 1200 ms on the first in-app visit (session prewarmed by Today)'],
    'a version 1 nav- file is recognised by its slug');
});

function tap(i, action, over = {}) {
  return { i, round: Math.floor(i / 2), action, ok: true, inputMs: 40 + i, eventMs: 24, readyMs: 300 + i * 10, longTasks: { blockingMs: 5 }, ...over };
}

test('summarizeInput: per action n and robust stats; failed taps never contribute a number', () => {
  const s = stats.summarizeInput([
    tap(0, 'tap Log tab'), tap(1, 'open More menu'),
    tap(2, 'tap Log tab', { ok: false, error: 'ready-timeout', readyMs: null }), tap(3, 'open More menu', { eventMs: null }),
    tap(4, 'tap Log tab', { ok: false, error: 'control not on screen', inputMs: null, readyMs: null }),
  ]);
  assert.equal(s.total, 5);
  assert.equal(s.ok, 3);
  const log = s.actions.find((a) => a.action === 'tap Log tab');
  assert.equal(log.total, 3);
  assert.equal(log.ok, 1);
  assert.deepEqual(log.errors, { 'ready-timeout': 1, 'control not on screen': 1 });
  assert.equal(log.readyMs.n, 1, 'the timed-out tap is not counted as a time');
  const more = s.actions.find((a) => a.action === 'open More menu');
  assert.equal(more.eventMs.n, 1, 'below the Event Timing threshold = no value, not 0');
  assert.deepEqual(s.actions.map((a) => a.action), ['tap Log tab', 'open More menu']);
});

test('observedViolations: untried, unmeasured and slow phone taps are reported', () => {
  const summary = stats.summarizeInput([
    tap(0, 'tap Today tab', { readyMs: 1400, inputMs: 260 }),
    tap(1, 'open More menu', { ok: false, error: 'no input recorded', inputMs: null, readyMs: null }),
  ]);
  const lines = stats.observedViolations([], [{ label: 'Phone taps, 390 px', expected: 12, summary }]);
  assert.deepEqual(lines, [
    'Phone taps, 390 px: only 2 of 12 taps were tried',
    'Phone taps, 390 px: tap Today tab: tap to ready 1400 ms (slowest of 1)',
    `Phone taps, 390 px: tap Today tab: input to next paint 260 ms (slowest of 1, over ${stats.INPUT_PAINT_MS} ms)`,
    'Phone taps, 390 px: open More menu: 1 of 1 taps not measured (no input recorded), not a pass',
  ]);
});

function writeRun(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-report-v2-'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), JSON.stringify(body));
  return dir;
}
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const v2meta = (slug, label, over = {}) => ({ slug, label, navigations: 4, startedAt: 'T', harness: 2, github: {}, runner: {},
  scenario: { name: 'full-load', viewport: '1280x720', cpuSlowdown: 1, enforced: true }, deployed: { start: SHA_A, end: SHA_A },
  fixedWindowMs: 6000, windowRule: 'navigations 1-4 of each page', ...over });

test('report: a version 1 artifact still loads as the baseline, its new columns read "not recorded", never 0', () => {
  const samples = [sample(0, 600, 2), sample(1, 400, 2), sample(2, 410, 2), sample(3, 420, 2)];
  const dir = writeRun({
    'sleep.json': { meta: { slug: 'sleep', label: '/sleep', navigations: 4, startedAt: 'T', github: {}, runner: {} }, samples },
    'nav-sleep.json': { meta: { slug: 'nav-sleep', label: '/sleep (in-app)', navigations: 4, startedAt: 'T', github: {}, runner: {} }, samples },
  });
  const run = report.loadRun(dir);
  assert.equal(run.harness, 1);
  assert.deepEqual(run.missing, [], 'a version 1 run never had the phone scenario');
  assert.deepEqual(run.pages.map((p) => [p.slug, p.scenario, p.enforced, p.revision]), [
    ['sleep', 'full-load', true, null], ['nav-sleep', 'in-app-prewarmed', true, null],
  ]);
  const md = report.render([run]);
  assert.match(md, /Harness version 1/);
  assert.match(md, /not recorded \(harness 1\)/);
  assert.match(md, /\| \/sleep \(in-app\) \| 4\/4 \|.*\| 600 \(first visit, prewarmed\) \|/);
  assert.match(md, /low n \(3 < 10\)/);
  assert.ok(!/NaN|undefined/.test(md));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('report: version 2 files show scenario, revision, the fixed window and the phone taps, observe-only', () => {
  const samples = [v2sample(0, 900), v2sample(1, 400), v2sample(2, 420), v2sample(3, 410)];
  const dir = writeRun({
    'today.json': { meta: v2meta('today', '/ (Today)'), samples },
    'phone-today.json': { meta: v2meta('phone-today', '/ (Today), 390 px', { scenario: { name: 'phone-full-load', viewport: '390x664', cpuSlowdown: 4, enforced: false } }), samples },
    'phone-input.json': { meta: v2meta('phone-input', 'Phone taps, 390 px', { kind: 'input', planned: 4, scenario: { name: 'phone-input', enforced: false } }),
      samples: [tap(0, 'tap Log tab'), tap(1, 'open More menu')] },
  });
  const run = report.loadRun(dir);
  assert.equal(run.harness, 2);
  assert.deepEqual(run.pages.map((p) => p.slug), ['today', 'phone-today'], 'phone pages after the desktop ones; taps are not a page');
  assert.equal(run.inputs.length, 1);
  assert.equal(run.inputs[0].expected, 4);
  assert.equal(report.revisionLine(run), 'aaaaaaa (3 results)');
  const md = report.render([run]);
  assert.match(md, /\| \/ \(Today\), 390 px \| phone-full-load \| 390x664, CPU 4x slower \| observed only \|/);
  assert.match(md, /\| \/ \(Today\) \| full-load \| 1280x720 \| enforced \| empty \/ HIT \/ unknown \|/);
  assert.match(md, /\| \/ \(Today\) \| 6000 from navigation start \| 4 \/ 4 \(4\) \|/);
  // phone-log.json was not written: reported as not measured, in the report and in the observed lines.
  assert.deepEqual(run.missing.map((x) => x.slug), ['phone-log']);
  assert.deepEqual(report.missingObserved(run), ['/log, 390 px: no result file written (not measured, not a pass)']);
  assert.match(md, /Observe-only results not recorded/);
  assert.match(md, /Phone input responsiveness \(observed, not enforced yet\)/);
  assert.match(md, /\| Phone taps, 390 px \| tap Log tab \| 1\/1 \|/);
  assert.ok(!/NaN|undefined/.test(md));
  assert.deepEqual(stats.budgetViolations(run.pages), [], 'the slow cold phone load is not enforced');
  assert.ok(stats.observedViolations(run.pages, run.inputs).some((l) => l.startsWith('Phone taps, 390 px: only 2 of 4 taps')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('report: pooled table keeps revisions and harness versions apart and never pools an unbound result', () => {
  const samples = [v2sample(0, 900), v2sample(1, 400), v2sample(2, 420), v2sample(3, 410)];
  const legacy = [sample(0, 600, 2), sample(1, 300, 2), sample(2, 310, 2), sample(3, 320, 2)];
  const dirs = [
    writeRun({ 'sleep.json': { meta: { slug: 'sleep', label: '/sleep', navigations: 4, startedAt: 'T', github: {}, runner: {} }, samples: legacy } }),
    writeRun({ 'sleep.json': { meta: v2meta('sleep', '/sleep'), samples } }),
    writeRun({ 'sleep.json': { meta: v2meta('sleep', '/sleep'), samples } }),
    writeRun({ 'sleep.json': { meta: v2meta('sleep', '/sleep', { deployed: { start: SHA_A, end: SHA_B } }), samples } }),
    writeRun({ 'sleep.json': { meta: v2meta('sleep', '/sleep', { deployed: { start: SHA_A, end: SHA_B } }), samples } }),
    writeRun({ 'sleep.json': { meta: v2meta('sleep', '/sleep', { deployed: { start: null, end: SHA_A } }), samples } }),
  ];
  const runs = dirs.map(report.loadRun);
  assert.equal(report.revisionLine(runs[5]), 'partial (1 result)');
  const md = report.render(runs);
  assert.match(md, /different harness versions \(1, 2\)/);
  assert.match(md, /not evidence of a speed-up/);
  assert.match(md, /\| \/sleep \| 1 \| full-load \| not recorded \/ CPU not recorded \| not recorded \| not recorded \| 1 \| 3 \|.*no build recorded \(harness 1\): not pooled/);
  assert.match(md, /\| \/sleep \| 2 \| full-load \| 1280x720 \/ CPU 1x \| 6000 \(navigations 1-4 of each page\) \| aaaaaaa \| 2 \| 6 \|/, 'two runs of the same build and method pool to n=6');
  const mixedRows = md.split('\n').filter((l) => l.includes('| mixed (deploy during the page) |'));
  assert.equal(mixedRows.length, 2, 'two runs that each spanned a deploy stay one row per run');
  for (const row of mixedRows) assert.match(row, /\| 1 \| 3 \|.*not bound to one build, not pooled/);
  assert.match(md, /\| unbound \(only one of the start \/ end reads succeeded\) \| 1 \| 3 \|.*only one \/api\/version read succeeded: not bound to one build, not pooled/,
    'a one-sided read is shown as unbound, never as the SHA it did read');
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

test('report: pooled table keeps the CPU slowdown actually in force apart (a failed 4x throttle measured at 1x never pools with 4x)', () => {
  const samples = [v2sample(0, 900), v2sample(1, 400), v2sample(2, 420), v2sample(3, 410)];
  const phone = (cpu) => ({
    'phone-today.json': { meta: v2meta('phone-today', '/ (Today), 390 px', { scenario: { name: 'phone-full-load', viewport: '390x664', cpuSlowdown: cpu, enforced: false } }), samples },
  });
  const dirs = [writeRun(phone(4)), writeRun(phone(1)), writeRun(phone(4))];
  const md = report.render(dirs.map(report.loadRun));
  const rows = md.split('\n').filter((l) => l.startsWith('| / (Today), 390 px | 2 | phone-full-load |'));
  assert.equal(rows.length, 2, 'one row for 4x, one for 1x');
  assert.match(md, /\| 390x664 \/ CPU 4x \| 6000 \(navigations 1-4 of each page\) \| aaaaaaa \| 2 \| 6 \|/, 'the two 4x runs pool');
  assert.match(md, /\| 390x664 \/ CPU 1x \| 6000 \(navigations 1-4 of each page\) \| aaaaaaa \| 1 \| 3 \|/, 'the 1x run stays on its own');
  // A different fixed window is a different method too.
  const other = writeRun({ 'sleep.json': { meta: v2meta('sleep', '/sleep', { fixedWindowMs: 8000 }), samples } });
  const same = writeRun({ 'sleep.json': { meta: v2meta('sleep', '/sleep'), samples } });
  const md2 = report.render([other, same].map(report.loadRun));
  assert.match(md2, /\| 8000 \(navigations 1-4 of each page\) \| aaaaaaa \| 1 \| 3 \|/);
  assert.match(md2, /\| 6000 \(navigations 1-4 of each page\) \| aaaaaaa \| 1 \| 3 \|/);
  for (const d of [...dirs, other, same]) fs.rmSync(d, { recursive: true, force: true });
});
