// Run: node --test tests/warmup.test.cjs
// Background warm-up (src/lib/warmup.ts): order, one step per idle slot, freshness, intent, cancel.
// Offline, invented data.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const src = (...p) => readFileSync(path.join(__dirname, '..', 'src', ...p), 'utf8');
const { outputText } = ts.transpileModule(src('lib', 'warmup.ts'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
const mod = { exports: {} };
new Function('require', 'module', 'exports', outputText)((name) => { throw new Error(`warmup.ts must stay import-free (imported ${name})`); }, mod, mod.exports);
const { orderTargets, recordVisit, parseVisits, decayed, routeOf, runWarmup, configureWarmup, warmRoute, navIntentProps, SAVE_DATA_LIMIT } = mod.exports;

const NOW = Date.parse('2031-04-01T12:00:00Z');
const PINNED = ['/today', '/check-in', '/analytics/hrv', '/agents'];

function harness({ fetchedAt = {}, saveData = false } = {}) {
  const log = [];
  let idles = 0;
  const deps = {
    prefetchRoute: (href, mode) => log.push(`route ${href} ${mode}`),
    cache: {
      fetchedAt: (k) => fetchedAt[k],
      register: (k) => log.push(`register ${k}`),
      revalidate: async (k, f) => { log.push(`fetch ${k}`); return f(); },
    },
    now: () => NOW,
    idle: async () => { idles++; },
    wait: async () => {},
    saveData: () => saveData,
  };
  return { deps, log, idles: () => idles };
}

test('routes normalise: query and hash dropped, / is Today', () => {
  assert.equal(routeOf('/agents?t=x#m1'), '/agents');
  assert.equal(routeOf('/'), '/today');
  assert.equal(routeOf('/financials/forecast'), '/financials/forecast');
});

test('order: tabs and quick links first, then by how often each page is opened', () => {
  const targets = ['/today', '/check-in', '/analytics/hrv', '/agents', '/sleep', '/nutrition', '/status'].map((href) => ({ href }));
  assert.deepEqual(orderTargets(targets, {}, PINNED, NOW).map((t) => t.href), ['/today', '/check-in', '/analytics/hrv', '/agents', '/sleep', '/nutrition', '/status']);
  let visits = {};
  for (let i = 0; i < 6; i++) visits = recordVisit(visits, '/status', NOW - i * 3600_000);
  visits = recordVisit(visits, '/nutrition', NOW);
  const order = orderTargets(targets, visits, PINNED, NOW).map((t) => t.href);
  assert.equal(order[0], '/status', 'a page opened far more often than the tabs leads');
  assert.ok(order.indexOf('/nutrition') < order.indexOf('/sleep'));
  // Visits fade: a burst two months ago counts for little now.
  const old = recordVisit({}, '/sleep', NOW - 60 * 24 * 3600_000);
  assert.ok(decayed(old['/sleep'], NOW) < 0.1);
  assert.deepEqual(parseVisits('not json'), {});
  assert.deepEqual(parseVisits(JSON.stringify({ '/x': { score: 2, at: 1 }, bad: { score: 'no' } })), { '/x': { score: 2, at: 1 } });
});

test('runs every page except the current one, one idle slot per step, and only fetches stale data', async () => {
  const { deps, log, idles } = harness({ fetchedAt: { 'k:fresh': NOW - 5_000, 'k:old': NOW - 10 * 60_000 } });
  const targets = [
    { href: '/today', prefetch: 'full', data: () => [{ key: 'k:fresh', fetch: async () => 1 }] },
    { href: '/agents', prefetch: 'full', data: () => [{ key: 'k:old', fetch: async () => 2 }, { key: 'k:new', fetch: async () => 3 }] },
    { href: '/health', prefetch: 'auto' },
  ];
  await runWarmup(targets, deps, '/agents?t=x').done;
  assert.deepEqual(log, [
    'route /today full', 'register k:fresh',
    'route /health auto',
  ], 'the page on screen is skipped (it fetches its own data); fresh data is not fetched again');
  log.length = 0;
  await runWarmup(targets, deps, '/').done;
  assert.deepEqual(log, [
    'route /today full', 'register k:fresh',
    'route /agents full', 'register k:old', 'fetch k:old', 'register k:new', 'fetch k:new',
    'route /health auto',
  ], 'from "/" the /today URL is still prefetched; stale and missing data is fetched');
  assert.ok(idles() >= 5, 'each page and each data fetch waits for its own idle slot');
});

test('save-data mode warms only the first pages; cancel stops the run', async () => {
  const targets = Array.from({ length: 10 }, (_, i) => ({ href: `/p${i}`, prefetch: 'full' }));
  const a = harness({ saveData: true });
  await runWarmup(targets, a.deps, null).done;
  assert.equal(a.log.length, SAVE_DATA_LIMIT);
  const b = harness();
  let run;
  b.deps.idle = async () => { if (b.log.length >= 2) run.cancel(); };
  run = runWarmup(targets, b.deps, null);
  await run.done;
  assert.equal(b.log.length, 2);
});

test('a failing fetch or prefetch does not stop the warm-up', async () => {
  const { deps, log } = harness();
  deps.prefetchRoute = (href) => { if (href === '/a') throw new Error('synthetic'); log.push(`route ${href}`); };
  deps.cache.revalidate = async (k) => { log.push(`fetch ${k}`); throw new Error('synthetic'); };
  await runWarmup([{ href: '/a', prefetch: 'full', data: () => [{ key: 'k:a', fetch: async () => 1 }] }, { href: '/b', prefetch: 'full' }], deps, null).done;
  assert.deepEqual(log, ['register k:a', 'fetch k:a', 'route /b']);
});

test('intent (hover, focus, pointer-down) warms that page at once; nav links switch off viewport prefetch', async () => {
  const { deps, log } = harness();
  configureWarmup(deps, [{ href: '/check-in', prefetch: 'full', data: () => [{ key: '/api/habits/checkin', fetch: async () => ({}) }] }, { href: '/orders', prefetch: 'auto' }]);
  const props = navIntentProps('/check-in');
  assert.equal(props.prefetch, false);
  props.onPointerDown();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(log, ['route /check-in full', 'register /api/habits/checkin', 'fetch /api/habits/checkin']);
  warmRoute('/orders?x=1');
  assert.equal(log.at(-1), 'route /orders?x=1 auto');
  configureWarmup(null);
  warmRoute('/check-in');
  assert.equal(log.length, 4, 'nothing happens once the warm-up is switched off');
});

test('the app warm-up list: no experiment reveal, write-coupled server pages warm their skeleton only', () => {
  const app = src('components', 'AppData.tsx');
  assert.ok(!/json\("\/api\/experiments/.test(app), 'reading today\'s arm stamps it as revealed: only Today may ask');
  const autoOnly = /AUTO_ONLY = new Set\(\[([^\]]+)\]\)/.exec(app)[1];
  for (const href of ['/health', '/health/records', '/orders', '/procurement']) assert.ok(autoOnly.includes(`"${href}"`), href);
  for (const nav of ['Sidebar.tsx', 'MobileNav.tsx']) assert.match(src('components', nav), /navIntentProps\(/, nav);
});
