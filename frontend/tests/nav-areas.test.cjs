// Run: node --test tests/nav-areas.test.cjs
// The app's area order (layout.areas) on the side panel: src/lib/nav-areas.ts (order, pre-paint script) and
// src/lib/nav-arrange.ts (Personalize moves). Offline, invented sections.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const src = (...p) => readFileSync(path.join(__dirname, '..', 'src', ...p), 'utf8');
function load(file, deps = {}) {
  const { outputText } = ts.transpileModule(src('lib', file), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const mod = { exports: {} };
  new Function('require', 'module', 'exports', outputText)((name) => {
    if (deps[name]) return deps[name];
    throw new Error(`${file} imported ${name}`);
  }, mod, mod.exports);
  return mod.exports;
}
const N = load('nav-areas.ts');
const L = load('personalize-layout.ts');
const O = load('personalize-ops.ts', { './personalize-layout': L });
const A = load('nav-arrange.ts', { './nav-areas': N, './personalize-layout': L, './personalize-ops': O });

const SECTIONS = [
  { title: 'Home', items: [{ href: '/today' }] },
  { title: 'Logging', items: [{ href: '/activities' }, { href: '/nutrition' }, { href: '/log' }] },
  { title: 'Insights', items: [{ href: '/sleep' }, { href: '/analytics/hrv' }] },
  { title: 'Tools', items: [{ href: '/financials' }, { href: '/financials/budgets' }] },
];
const flat = (ordered) => ordered.map((s) => `${s.title}:${s.items.map((i) => i.href).join(',')}`);

test('area ids', () => {
  assert.equal(N.areaId('/analytics/hrv'), 'analytics.hrv');
  assert.equal(N.areaId('/today'), 'today');
  assert.equal(N.areaId('/'), 'today');
  assert.equal(N.areaId('/financials/budgets'), 'financials.budgets');
});

test('no saved order = the nav order', () => {
  assert.deepEqual(flat(N.orderNav(SECTIONS, null)), ['Home:/today', 'Logging:/activities,/nutrition,/log', 'Insights:/sleep,/analytics/hrv', 'Tools:/financials,/financials/budgets']);
});

test('saved order sorts items within sections and sections by their first item; unsaved pages follow their nav predecessor', () => {
  // log follows nutrition, financials + budgets follow analytics.hrv (their nav predecessors); gone.page drops out.
  const saved = ['today', 'analytics.hrv', 'sleep', 'nutrition', 'activities', 'gone.page'];
  assert.deepEqual(flat(N.orderNav(SECTIONS, saved)), [
    'Home:/today',
    'Insights:/analytics/hrv,/sleep',
    'Tools:/financials,/financials/budgets',
    'Logging:/nutrition,/log,/activities',
  ]);
});

test("reads Personalize's local record and a bare layout; garbage is nothing", () => {
  const layout = { v: 1, grids: { main: { order: ['sleep', 'today'] } } };
  assert.deepEqual(N.parseAreaIds(JSON.stringify({ l: layout, u: null, s: 1, d: false, c: 0 })), ['sleep', 'today']);
  assert.deepEqual(N.parseAreaIds(JSON.stringify(layout)), ['sleep', 'today']);
  assert.equal(N.parseAreaIds('{nope'), null);
  assert.equal(N.parseAreaIds(null), null);
  assert.equal(N.parseAreaIds(JSON.stringify({ v: 1 })), null);
});

test('the pre-paint script writes the same panel React renders', () => {
  const saved = ['today', 'analytics.hrv', 'sleep', 'financials.budgets', 'nutrition'];
  const appended = [];
  const env = {
    localStorage: { getItem: (k) => (k === N.AREAS_STORAGE ? JSON.stringify({ l: { v: 1, grids: { main: { order: saved } } } }) : null) },
    document: { createElement: () => ({}), head: { appendChild: (el) => appended.push(el) } },
  };
  new Function('localStorage', 'document', N.navBootScript(SECTIONS))(env.localStorage, env.document);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].id, N.NAV_BOOT_STYLE_ID);
  const css = appended[0].textContent;
  const rank = N.rankAreas(N.navDefaultIds(SECTIONS), saved);
  // The default pins (Today, Log) sit in Quick access, so their section copies are off.
  const pinned = ['today', 'log'];
  for (const [id, r] of rank) {
    if (pinned.includes(id)) assert.ok(css.includes(`[data-nav-area="${id}"]{display:none!important}`), id);
    else assert.ok(css.includes(`[data-nav-area="${id}"]{display:flex!important;order:${r}}`), id);
  }
  pinned.forEach((id, i) => assert.ok(css.includes(`[data-nav-quick="${id}"]{display:flex!important;order:${i}}`), id));
  // Sections ordered by their first item, exactly like orderNav(); Home (only Today) is empty and hidden.
  assert.ok(css.includes('[data-nav-section="0"]{display:none!important}'));
  const sectionOrder = (i) => {
    const m = new RegExp(`\\[data-nav-section="${i}"\\]\\{display:block!important;order:(\\d+)\\}`).exec(css);
    return m ? Number(m[1]) : null;
  };
  const reactOrder = N.arrangeNav(SECTIONS, N.areaPrefsOf({ v: 1, grids: { main: { order: saved } } })).sections.map((s) => s.index);
  const cssOrder = [0, 1, 2, 3].filter((i) => sectionOrder(i) !== null).sort((a, b) => sectionOrder(a) - sectionOrder(b));
  assert.deepEqual(cssOrder, reactOrder);
});

test('the pre-paint script shows saved pins and hides hidden pages, like arrangeNav()', () => {
  const layout = { v: 1, grids: { quick: { order: ['sleep'], hide: { sleep: false, 'log': true } }, nav: { hide: { activities: true } } } };
  const appended = [];
  new Function('localStorage', 'document', N.navBootScript(SECTIONS))(
    { getItem: () => JSON.stringify({ l: layout }) },
    { createElement: () => ({}), head: { appendChild: (el) => appended.push(el) } },
  );
  const css = appended[0].textContent;
  const arranged = N.arrangeNav(SECTIONS, N.areaPrefsOf(layout));
  assert.deepEqual(arranged.pinned.map((i) => i.href), ['/sleep', '/today']);
  assert.ok(css.includes('[data-nav-quick="sleep"]{display:flex!important;order:0}'));
  assert.ok(css.includes('[data-nav-quick="today"]{display:flex!important;order:1}'));
  assert.ok(css.includes('[data-nav-quick="log"]{display:none!important}'));
  assert.ok(css.includes('[data-nav-area="log"]{display:flex!important;'), 'an unpinned default is back in its section');
  assert.ok(css.includes('[data-nav-area="activities"]{display:none!important}'), 'a hidden page is off');
  assert.deepEqual(arranged.hidden.map((i) => i.href), ['/activities']);
});

test('the pre-paint script does nothing without a saved order or on bad data', () => {
  const appended = [];
  const doc = { createElement: () => ({}), head: { appendChild: (el) => appended.push(el) } };
  new Function('localStorage', 'document', N.navBootScript(SECTIONS))({ getItem: () => null }, doc);
  new Function('localStorage', 'document', N.navBootScript(SECTIONS))({ getItem: () => '{oops' }, doc);
  assert.equal(appended.length, 0);
});

test('moving an item stays within its section and stores the whole order', () => {
  let l = A.moveNavItem(L.EMPTY_LAYOUT, SECTIONS, '/nutrition', '/activities');
  assert.deepEqual(flat(N.orderNav(SECTIONS, l.grids.main.order)).slice(1, 2), ['Logging:/nutrition,/activities,/log']);
  // Across sections: refused.
  assert.deepEqual(A.moveNavItem(L.EMPTY_LAYOUT, SECTIONS, '/sleep', '/activities'), L.EMPTY_LAYOUT);
  // To the end of its section.
  l = A.moveNavItem(L.EMPTY_LAYOUT, SECTIONS, '/activities', null);
  assert.deepEqual(flat(N.orderNav(SECTIONS, l.grids.main.order))[1], 'Logging:/nutrition,/log,/activities');
  // Back to the default stores nothing.
  assert.deepEqual(A.moveNavItem(l, SECTIONS, '/activities', '/nutrition'), { v: 1 });
});

test('moving by one among the items shown (Log sits in Quick access, not in the list)', () => {
  const shown = (h) => h !== '/log';
  const l = A.moveNavItemBy(L.EMPTY_LAYOUT, SECTIONS, '/activities', 1, shown);
  assert.deepEqual(flat(N.orderNav(SECTIONS, l.grids.main.order))[1], 'Logging:/nutrition,/activities,/log');
  assert.deepEqual(A.moveNavItemBy(L.EMPTY_LAYOUT, SECTIONS, '/activities', -1, shown), L.EMPTY_LAYOUT);
});

test('moving a section moves its pages as a block; the scroll order is the flattened list', () => {
  let l = A.moveNavSection(L.EMPTY_LAYOUT, SECTIONS, 3, 1); // Tools before Logging
  assert.deepEqual(flat(N.orderNav(SECTIONS, l.grids.main.order)).map((x) => x.split(':')[0]), ['Home', 'Tools', 'Logging', 'Insights']);
  assert.deepEqual(l.grids.main.order, ['today', 'financials', 'financials.budgets', 'activities', 'nutrition', 'log', 'sleep', 'analytics.hrv']);
  l = A.moveNavSectionBy(l, SECTIONS, 3, 1); // Tools down one: after Logging
  assert.deepEqual(flat(N.orderNav(SECTIONS, l.grids.main.order)).map((x) => x.split(':')[0]), ['Home', 'Logging', 'Tools', 'Insights']);
  l = A.moveNavSectionBy(l, SECTIONS, 3, 1); // and to the end: the default again
  assert.deepEqual(flat(N.orderNav(SECTIONS, l.grids?.main?.order ?? null)).map((x) => x.split(':')[0]), ['Home', 'Logging', 'Insights', 'Tools']);
  assert.deepEqual(l, { v: 1 });
});

test('pin, unpin and hide: Quick access and hidden pages are stored in layout.areas', () => {
  let l = { v: 1 };
  assert.deepEqual(A.pinnedOf(l, SECTIONS), ['/today', '/log'], 'default pins');
  l = A.setPinned(l, SECTIONS, '/sleep', true);
  assert.deepEqual(A.pinnedOf(l, SECTIONS), ['/today', '/log', '/sleep']);
  const a = N.arrangeNav(SECTIONS, N.areaPrefsOf(l));
  assert.deepEqual(a.sections.map((s) => s.title), ['Logging', 'Insights', 'Tools'], 'Home holds only Today, pinned');
  assert.deepEqual(a.sections[1].items.map((i) => i.href), ['/analytics/hrv']);
  // Hiding unpins; the page is listed as hidden.
  l = A.setNavHidden(l, SECTIONS, '/log', true);
  assert.deepEqual(A.pinnedOf(l, SECTIONS), ['/today', '/sleep']);
  assert.deepEqual(N.arrangeNav(SECTIONS, N.areaPrefsOf(l)).hidden.map((i) => i.href), ['/log']);
  // Pinning a hidden page shows it again, here before Today.
  l = A.setPinned(l, SECTIONS, '/log', true, '/today');
  assert.deepEqual(A.pinnedOf(l, SECTIONS), ['/log', '/today', '/sleep']);
  assert.deepEqual(N.areaPrefsOf(l).navHidden, []);
  l = A.movePinnedBy(l, SECTIONS, '/log', 1);
  assert.deepEqual(A.pinnedOf(l, SECTIONS), ['/today', '/log', '/sleep']);
  // The default pins store nothing.
  l = A.setPinned(l, SECTIONS, '/sleep', false);
  assert.equal(l.grids && l.grids.quick, undefined);
  // Unpin everything: stored as flags, not as "default".
  l = A.setPinnedList({ v: 1 }, SECTIONS, []);
  assert.deepEqual(A.pinnedOf(l, SECTIONS), []);
});

test('hide from scroll is separate from hide from navigation', () => {
  let l = A.setScrollHidden({ v: 1 }, SECTIONS, '/sleep', true);
  assert.deepEqual(N.areaPrefsOf(l).scrollHidden, ['sleep']);
  assert.deepEqual(N.areaPrefsOf(l).navHidden, []);
  l = A.setNavHidden(l, SECTIONS, '/nutrition', true);
  assert.deepEqual(N.areaPrefsOf(l).scrollHidden, ['sleep']);
  assert.deepEqual(N.areaPrefsOf(l).navHidden, ['nutrition']);
  l = A.setScrollHidden(l, SECTIONS, '/sleep', false);
  assert.deepEqual(N.areaPrefsOf(l).scrollHidden, []);
});

test('bottom-bar slots are stored as area ids; the default bar stores nothing', () => {
  const D = ['/today', '/agents', '/chat', 'more'];
  const l = A.setTabSlots({ v: 1 }, ['/sleep', '/agents', '/chat', 'more'], D);
  assert.deepEqual(l.grids.tabs.order, ['sleep', 'agents', 'chat', 'more']);
  assert.deepEqual(N.areaPrefsOf(l).tabs, ['sleep', 'agents', 'chat', 'more']);
  assert.deepEqual(A.setTabSlots(l, D, D), { v: 1 });
});

test('the bottom-bar pre-paint script hides only the slots that differ from the default', () => {
  const appended = [];
  const rec = { l: { v: 1, grids: { tabs: { order: ['sleep', 'agents', 'chat', 'nutrition'] } } } };
  new Function('localStorage', 'document', N.tabsBootScript(['today', 'agents', 'chat', 'more']))(
    { getItem: () => JSON.stringify(rec) },
    { createElement: () => ({}), head: { appendChild: (el) => appended.push(el) } },
  );
  assert.equal(appended[0].id, N.TABS_BOOT_STYLE_ID);
  assert.equal(appended[0].textContent, '[data-tab-slot="0"]{visibility:hidden}[data-tab-slot="3"]{visibility:hidden}');
});
