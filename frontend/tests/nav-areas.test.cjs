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
  { title: 'Logging', items: [{ href: '/activities' }, { href: '/nutrition' }, { href: '/check-in' }] },
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
  assert.deepEqual(flat(N.orderNav(SECTIONS, null)), ['Home:/today', 'Logging:/activities,/nutrition,/check-in', 'Insights:/sleep,/analytics/hrv', 'Tools:/financials,/financials/budgets']);
});

test('saved order sorts items within sections and sections by their first item; unsaved pages follow their nav predecessor', () => {
  // check-in follows nutrition, financials + budgets follow analytics.hrv (their nav predecessors); gone.page drops out.
  const saved = ['today', 'analytics.hrv', 'sleep', 'nutrition', 'activities', 'gone.page'];
  assert.deepEqual(flat(N.orderNav(SECTIONS, saved)), [
    'Home:/today',
    'Insights:/analytics/hrv,/sleep',
    'Tools:/financials,/financials/budgets',
    'Logging:/nutrition,/check-in,/activities',
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

test('the pre-paint script writes the same order React renders', () => {
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
  for (const [id, r] of rank) assert.ok(css.includes(`[data-nav-area="${id}"]{order:${r}}`), id);
  // Sections ordered by their first item, exactly like orderNav().
  const sectionOrder = (i) => Number(new RegExp(`\\[data-nav-section="${i}"\\]\\{order:(\\d+)\\}`).exec(css)[1]);
  const reactOrder = N.orderNav(SECTIONS, saved).map((s) => s.index);
  const cssOrder = [0, 1, 2, 3].sort((a, b) => sectionOrder(a) - sectionOrder(b));
  assert.deepEqual(cssOrder, reactOrder);
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
  assert.deepEqual(flat(N.orderNav(SECTIONS, l.grids.main.order)).slice(1, 2), ['Logging:/nutrition,/activities,/check-in']);
  // Across sections: refused.
  assert.deepEqual(A.moveNavItem(L.EMPTY_LAYOUT, SECTIONS, '/sleep', '/activities'), L.EMPTY_LAYOUT);
  // To the end of its section.
  l = A.moveNavItem(L.EMPTY_LAYOUT, SECTIONS, '/activities', null);
  assert.deepEqual(flat(N.orderNav(SECTIONS, l.grids.main.order))[1], 'Logging:/nutrition,/check-in,/activities');
  // Back to the default stores nothing.
  assert.deepEqual(A.moveNavItem(l, SECTIONS, '/activities', '/nutrition'), { v: 1 });
});

test('moving by one among the items shown (Check-in sits in Quick access, not in the list)', () => {
  const shown = (h) => h !== '/check-in';
  const l = A.moveNavItemBy(L.EMPTY_LAYOUT, SECTIONS, '/activities', 1, shown);
  assert.deepEqual(flat(N.orderNav(SECTIONS, l.grids.main.order))[1], 'Logging:/nutrition,/activities,/check-in');
  assert.deepEqual(A.moveNavItemBy(L.EMPTY_LAYOUT, SECTIONS, '/activities', -1, shown), L.EMPTY_LAYOUT);
});

test('moving a section moves its pages as a block; the scroll order is the flattened list', () => {
  let l = A.moveNavSection(L.EMPTY_LAYOUT, SECTIONS, 3, 1); // Tools before Logging
  assert.deepEqual(flat(N.orderNav(SECTIONS, l.grids.main.order)).map((x) => x.split(':')[0]), ['Home', 'Tools', 'Logging', 'Insights']);
  assert.deepEqual(l.grids.main.order, ['today', 'financials', 'financials.budgets', 'activities', 'nutrition', 'check-in', 'sleep', 'analytics.hrv']);
  l = A.moveNavSectionBy(l, SECTIONS, 3, 1); // Tools down one: after Logging
  assert.deepEqual(flat(N.orderNav(SECTIONS, l.grids.main.order)).map((x) => x.split(':')[0]), ['Home', 'Logging', 'Tools', 'Insights']);
  l = A.moveNavSectionBy(l, SECTIONS, 3, 1); // and to the end: the default again
  assert.deepEqual(flat(N.orderNav(SECTIONS, l.grids?.main?.order ?? null)).map((x) => x.split(':')[0]), ['Home', 'Logging', 'Insights', 'Tools']);
  assert.deepEqual(l, { v: 1 });
});
