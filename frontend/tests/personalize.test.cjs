// Run: node --test tests/personalize.test.cjs
// Personalize (src/lib/personalize-layout.ts + src/lib/personalize-ops.ts): the layout overlay (move, hide, width,
// collapse, new / removed parts, clear), columns (order, hide, freeze), the cookie and the drop-position maths.
// Offline, invented part ids.
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
const L = load('personalize-layout.ts');
const O = load('personalize-ops.ts', { './personalize-layout': L });

const def = (id, extra = {}) => ({ id, title: id.toUpperCase(), width: 'full', hidden: false, collapsed: false, ...extra });
const DEFS = [def('a'), def('b', { width: 'half' }), def('c', { width: 'half' }), def('d'), def('e', { hidden: true })];
const ids = (parts) => parts.map((p) => p.id);
const Z = 'main';

test('keys: route to a dotted key of at most 40 characters', () => {
  assert.equal(L.layoutKey('/analytics/hrv'), 'layout.analytics.hrv');
  assert.equal(L.layoutKey('/sleep'), 'layout.sleep');
  assert.equal(L.layoutKey('/check-in'), 'layout.check-in');
  assert.ok(L.layoutKey('/a/very/long/route/that/keeps/going/and/going').length <= 40);
  assert.match(L.layoutKey('/a/very/long/route/that/keeps/going/and/going'), /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);
  assert.equal(L.storageKey('layout.sleep'), 'onyx.layout.sleep');
});

test('no overlay = the default layout', () => {
  const r = L.resolveGrid(DEFS, undefined);
  assert.deepEqual(ids(r), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(r[1].width, 'half');
  assert.equal(r[4].hidden, true);
});

test('move: before another part, to the end, by one among visible parts, to the top', () => {
  let l = O.movePart(L.EMPTY_LAYOUT, Z, DEFS, 'd', 'a');
  assert.deepEqual(ids(L.resolveGrid(DEFS, l.grids.main)), ['d', 'a', 'b', 'c', 'e']);
  l = O.movePart(l, Z, DEFS, 'd', null);
  assert.deepEqual(ids(L.resolveGrid(DEFS, l.grids?.main)), ['a', 'b', 'c', 'e', 'd']);
  // Back where it started: nothing stored.
  l = O.movePart(l, Z, DEFS, 'd', 'e');
  assert.deepEqual(l, { v: 1 });
  const visible = ['a', 'b', 'c', 'd'];
  l = O.movePartBy(L.EMPTY_LAYOUT, Z, DEFS, visible, 'a', 1);
  assert.deepEqual(ids(L.resolveGrid(DEFS, l.grids.main)), ['b', 'a', 'c', 'd', 'e']);
  // Moving the last visible part down does nothing.
  assert.deepEqual(O.movePartBy(L.EMPTY_LAYOUT, Z, DEFS, visible, 'd', 1), { v: 1 });
  l = O.movePartToTop(L.EMPTY_LAYOUT, Z, DEFS, 'c');
  assert.deepEqual(ids(L.resolveGrid(DEFS, l.grids.main)), ['c', 'a', 'b', 'd', 'e']);
});

test('hide / show, width and collapse store only differences from the default', () => {
  let l = O.setPartHidden(L.EMPTY_LAYOUT, Z, DEFS, 'b', true);
  assert.deepEqual(l.grids.main.hide, { b: true });
  l = O.setPartHidden(l, Z, DEFS, 'e', false); // hidden by default -> shown
  assert.deepEqual(l.grids.main.hide, { b: true, e: false });
  const r = L.resolveGrid(DEFS, l.grids.main);
  assert.equal(r.find((p) => p.id === 'b').hidden, true);
  assert.equal(r.find((p) => p.id === 'e').hidden, false);
  l = O.setPartHidden(O.setPartHidden(l, Z, DEFS, 'b', false), Z, DEFS, 'e', true);
  assert.deepEqual(l, { v: 1 });

  l = O.setPartWidth(L.EMPTY_LAYOUT, Z, DEFS, 'a', 'third');
  assert.equal(L.resolveGrid(DEFS, l.grids.main)[0].width, 'third');
  assert.deepEqual(O.setPartWidth(l, Z, DEFS, 'a', 'full'), { v: 1 });

  l = O.setPartCollapsed(L.EMPTY_LAYOUT, Z, DEFS, 'd', true);
  assert.equal(L.resolveGrid(DEFS, l.grids.main)[3].collapsed, true);
  assert.deepEqual(O.setPartCollapsed(l, Z, DEFS, 'd', false), { v: 1 });
});

test('a part the page gains appears in its default spot; a removed part drops out', () => {
  const saved = O.movePart(L.EMPTY_LAYOUT, Z, DEFS, 'a', null).grids.main; // b c d e a
  const grown = [def('a'), def('n'), def('b'), def('c'), def('d'), def('e')]; // n added after a
  assert.deepEqual(ids(L.resolveGrid(grown, saved)), ['b', 'c', 'd', 'e', 'a', 'n']);
  const leading = [def('z'), ...DEFS];
  assert.deepEqual(ids(L.resolveGrid(leading, saved))[0], 'z');
  const shrunk = DEFS.filter((d) => d.id !== 'c');
  assert.deepEqual(ids(L.resolveGrid(shrunk, saved)), ['b', 'd', 'e', 'a']);
});

test('a part that is not rendered right now keeps its saved place through later moves', () => {
  let l = O.movePart(L.EMPTY_LAYOUT, Z, DEFS, 'd', 'b'); // a d b c e
  const withoutC = DEFS.filter((x) => x.id !== 'c'); // c only renders when it has data
  l = O.movePart(l, Z, withoutC, 'a', null); // d b e a (+ c kept after b)
  assert.ok(l.grids.main.order.includes('c'));
  assert.deepEqual(ids(L.resolveGrid(DEFS, l.grids.main)), ['d', 'b', 'c', 'e', 'a']);
});

test('clear restores the default; sanitize drops anything malformed', () => {
  assert.deepEqual(O.clearLayout(), { v: 1 });
  assert.equal(L.isEmptyLayout(O.clearLayout()), true);
  const dirty = {
    v: 1,
    grids: { main: { order: ['a', 'a', '<x>', 5, 'b'], hide: { b: true, c: 'yes' }, width: { a: 'huge', b: 'half' }, extra: 1 }, 'bad zone!': { order: ['a'] } },
    tables: { t: { order: ['x'], freeze: '"' } },
    junk: true,
  };
  assert.deepEqual(L.sanitizeLayout(dirty), { v: 1, grids: { main: { order: ['a', 'b'], hide: { b: true }, width: { b: 'half' } } }, tables: { t: { order: ['x'] } } });
  assert.deepEqual(L.sanitizeLayout(null), { v: 1 });
  assert.deepEqual(L.sanitizeLayout('x'), { v: 1 });
});

test('stored record round trip, and garbage reads as nothing', () => {
  const rec = { layout: { v: 1, grids: { main: { order: ['b', 'a'] } } }, updatedAt: '2031-01-01T00:00:00Z', savedAt: 5, dirty: true, checkedAt: 7 };
  assert.deepEqual(L.parseStored(L.serializeStored(rec)), rec);
  assert.equal(L.parseStored('{oops'), null);
  assert.equal(L.parseStored(null), null);
});

test('normalized layouts compare equal whatever the key order', () => {
  const a = { v: 1, grids: { main: { width: { b: 'half', a: 'third' }, hide: { c: true } } } };
  const b = { v: 1, grids: { main: { hide: { c: true }, width: { a: 'third', b: 'half' } } } };
  assert.equal(O.sameLayout(a, b), true);
  assert.equal(O.sameLayout(a, { v: 1 }), false);
});

test('columns: order, hide (locked cannot hide), freeze pane', () => {
  const cols = [{ id: 'date', label: 'Date', locked: true }, { id: 'desc', label: 'Desc' }, { id: 'amt', label: 'Amt' }, { id: 'cur', label: 'Cur', hidden: true }];
  let r = L.resolveColumns(cols, undefined, 'date');
  assert.deepEqual(r.map((c) => [c.id, c.hidden, c.frozen]), [['date', false, true], ['desc', false, false], ['amt', false, false], ['cur', true, false]]);
  let l = O.moveColumnBy(L.EMPTY_LAYOUT, 't', cols, ['date', 'desc', 'amt'], 'amt', -1);
  assert.deepEqual(L.resolveColumns(cols, l.tables.t).map((c) => c.id), ['date', 'amt', 'desc', 'cur']);
  l = O.setColumnHidden(l, 't', cols, 'cur', false);
  assert.equal(L.resolveColumns(cols, l.tables.t).find((c) => c.id === 'cur').hidden, false);
  assert.deepEqual(O.setColumnHidden(L.EMPTY_LAYOUT, 't', cols, 'date', true), { v: 1 });
  l = O.setColumnFreeze(L.EMPTY_LAYOUT, 't', 'desc', 'date');
  r = L.resolveColumns(cols, l.tables.t, 'date');
  assert.deepEqual(r.filter((c) => c.frozen).map((c) => c.id), ['date', 'desc']);
  l = O.setColumnFreeze(L.EMPTY_LAYOUT, 't', '', 'date'); // "Clear freeze pane"
  assert.equal(L.resolveColumns(cols, l.tables.t, 'date').some((c) => c.frozen), false);
  assert.deepEqual(O.setColumnFreeze(L.EMPTY_LAYOUT, 't', 'date', 'date'), { v: 1 });
});

test('a table of contents follows the order and drops hidden sections', () => {
  const l = O.setPartHidden(O.movePart(L.EMPTY_LAYOUT, Z, [def('x'), def('y'), def('z'), def('extra')], 'z', 'x'), Z, [def('x'), def('y'), def('z')], 'y', true);
  assert.deepEqual(L.visibleOrder(['x', 'y', 'z'], l), ['z', 'x']);
});

test('cookie: scoped to the page, removed when empty or too large, read back safely', () => {
  const layout = { v: 1, grids: { main: { order: ['b', 'a'] } } };
  const c = L.layoutCookie('/financials', layout);
  assert.match(c, /^onyx-pz-financials=/);
  assert.match(c, /Path=\/financials/);
  assert.match(c, /SameSite=Lax; Secure$/);
  const value = c.slice(c.indexOf('=') + 1, c.indexOf(';'));
  assert.deepEqual(L.layoutFromCookie(value), layout);
  assert.match(L.layoutCookie('/financials', { v: 1 }), /Max-Age=0/);
  const big = { v: 1, grids: { main: { order: Array.from({ length: 200 }, (_, i) => `part-number-${i}`) } } };
  assert.match(L.layoutCookie('/financials', big), /Max-Age=0/);
  assert.deepEqual(L.layoutFromCookie('%E0%A4%A'), { v: 1 });
  assert.deepEqual(L.layoutFromCookie(undefined), { v: 1 });
});

// ---- drop position ----------------------------------------------------------------------------------------
// A 1000 px wide grid, gap 24: a full row (a), two halves (b c), then a full row (d).
const item = (id, left, top, right, bottom) => ({ id, left, top, right, bottom });
const ITEMS = [item('a', 0, 0, 1000, 200), item('b', 0, 224, 488, 424), item('c', 512, 224, 1000, 424), item('d', 0, 448, 1000, 648)];

test('rows: parts side by side share a row', () => {
  assert.deepEqual(O.rowsOf(ITEMS).map((r) => r.map((x) => x.id)), [['a'], ['b', 'c'], ['d']]);
});

test('full-width part: top half drops before it, bottom half after it (a horizontal line)', () => {
  let t = O.dropTarget(ITEMS, { x: 500, y: 460 }, 'a');
  assert.equal(t.beforeId, 'd');
  assert.equal(t.line.axis, 'h');
  assert.equal(t.line.y + O.LINE_THICKNESS / 2, (424 + 448) / 2);
  assert.equal(t.line.w, 1000);
  t = O.dropTarget(ITEMS, { x: 500, y: 600 }, 'a');
  assert.equal(t.beforeId, null);
  assert.equal(t.index, 4);
  // Past the bottom of the grid: the end.
  assert.equal(O.dropTarget(ITEMS, { x: 10, y: 900 }, 'a').beforeId, null);
  // Above the first row.
  assert.equal(O.dropTarget(ITEMS, { x: 10, y: -30 }, 'd').beforeId, 'a');
});

test('row of halves: the middle of the row places beside a part (a vertical line)', () => {
  let t = O.dropTarget(ITEMS, { x: 900, y: 320 }, 'a'); // right of c's middle (756)
  assert.equal(t.line.axis, 'v');
  assert.equal(t.beforeId, 'd'); // after c = before d
  assert.equal(t.line.x + O.LINE_THICKNESS / 2, 1000 + 12);
  t = O.dropTarget(ITEMS, { x: 600, y: 320 }, 'a'); // between b's and c's middles
  assert.equal(t.beforeId, 'c');
  assert.equal(t.line.axis, 'v');
  assert.equal(t.line.x + O.LINE_THICKNESS / 2, (488 + 512) / 2);
  assert.equal(t.line.h, 200);
  t = O.dropTarget(ITEMS, { x: 100, y: 320 }, 'd'); // left of b's middle
  assert.equal(t.beforeId, 'b');
  assert.equal(t.line.axis, 'v');
  assert.equal(t.line.x + O.LINE_THICKNESS / 2, -12);
  // The top edge of the row places above the whole row.
  t = O.dropTarget(ITEMS, { x: 600, y: 230 }, 'd');
  assert.equal(t.beforeId, 'b');
  assert.equal(t.line.axis, 'h');
});

test('dropping where the part already is shows no indicator', () => {
  assert.equal(O.dropTarget(ITEMS, { x: 500, y: 20 }, 'a').noop, true); // before itself
  assert.equal(O.dropTarget(ITEMS, { x: 500, y: 230 }, 'a').noop, true); // right after itself
  assert.equal(O.dropTarget(ITEMS, { x: 500, y: 600 }, 'a').noop, false);
  assert.equal(O.dropTarget([], { x: 0, y: 0 }, 'a'), null);
});

test('keyboard moves use the same targets: position among the others', () => {
  let t = O.keyboardTarget(ITEMS, 'a', 0);
  assert.equal(t.noop, true); // where it is
  t = O.keyboardTarget(ITEMS, 'a', 2); // after b and c
  assert.equal(t.beforeId, 'd');
  assert.equal(t.noop, false);
  assert.equal(t.line.axis, 'h');
  t = O.keyboardTarget(ITEMS, 'd', 2); // between b and c: a vertical line
  assert.equal(t.beforeId, 'c');
  assert.equal(t.line.axis, 'v');
  t = O.keyboardTarget(ITEMS, 'b', 3);
  assert.equal(t.beforeId, null);
  // Applying the target moves the part there.
  const defs = ITEMS.map((x) => def(x.id));
  const l = O.movePart(L.EMPTY_LAYOUT, Z, defs, 'd', O.keyboardTarget(ITEMS, 'd', 2).beforeId);
  assert.deepEqual(ids(L.resolveGrid(defs, l.grids.main)), ['a', 'b', 'd', 'c']);
});

// ---- groups (nested parts) -------------------------------------------------------------------------------
const MODEL = { top: [def('g1'), def('g2'), def('lone')], groups: { g1: [def('a'), def('b')], g2: [def('c')] } };

test('groups: default membership and order', () => {
  const r = L.resolvePage(MODEL, L.EMPTY_LAYOUT);
  assert.deepEqual(ids(r.top), ['g1', 'g2', 'lone']);
  assert.deepEqual(ids(r.members.g1), ['a', 'b']);
  assert.deepEqual(ids(r.members.g2), ['c']);
  assert.equal(r.groupOf.a, 'g1');
});

test('groups: a part moves into another group and back; back home stores nothing', () => {
  let l = O.movePartToGroup(L.EMPTY_LAYOUT, MODEL, 'a', 'g2', 'c');
  let r = L.resolvePage(MODEL, l);
  assert.deepEqual(ids(r.members.g1), ['b']);
  assert.deepEqual(ids(r.members.g2), ['a', 'c']);
  assert.equal(r.groupOf.a, 'g2');
  l = O.movePartToGroup(l, MODEL, 'a', 'g1', 'b');
  r = L.resolvePage(MODEL, l);
  assert.deepEqual(ids(r.members.g1), ['a', 'b']);
  assert.deepEqual(ids(r.members.g2), ['c']);
  assert.deepEqual(l, { v: 1 });
});

test('groups: to the end of a group, within a group by one, to the top', () => {
  let l = O.movePartToGroup(L.EMPTY_LAYOUT, MODEL, 'b', 'g2', null);
  assert.deepEqual(ids(L.resolvePage(MODEL, l).members.g2), ['c', 'b']);
  l = O.movePartInGroupBy(L.EMPTY_LAYOUT, MODEL, 'a', 1);
  assert.deepEqual(ids(L.resolvePage(MODEL, l).members.g1), ['b', 'a']);
  l = O.movePartToGroupTop(l, MODEL, 'a');
  assert.deepEqual(l, { v: 1 });
});

test('groups: flags are page-wide and follow a part into another group', () => {
  let l = O.setPartHidden(L.EMPTY_LAYOUT, 'main', O.modelDefs(MODEL), 'a', true);
  assert.equal(L.resolvePage(MODEL, l).members.g1.find((p) => p.id === 'a').hidden, true);
  l = O.movePartToGroup(l, MODEL, 'a', 'g2', null);
  assert.equal(L.resolvePage(MODEL, l).members.g2.find((p) => p.id === 'a').hidden, true);
  l = O.setPartWidth(l, 'main', O.modelDefs(MODEL), 'c', 'quarter');
  assert.equal(L.resolvePage(MODEL, l).members.g2.find((p) => p.id === 'c').width, 'quarter');
});

test('groups: new parts take their default spot, removed parts and removed groups drop out safely', () => {
  const l = O.movePartToGroup(L.EMPTY_LAYOUT, MODEL, 'a', 'g2', null); // g2: c a
  const grown = { top: MODEL.top, groups: { g1: [def('a'), def('n'), def('b')], g2: [def('c'), def('m')] } };
  const r = L.resolvePage(grown, l);
  assert.deepEqual(ids(r.members.g1), ['n', 'b']);
  assert.deepEqual(ids(r.members.g2), ['c', 'm', 'a']);
  // g2 removed from the page: a goes home to g1.
  const noG2 = { top: [def('g1'), def('lone')], groups: { g1: [def('a'), def('b')] } };
  assert.deepEqual(ids(L.resolvePage(noG2, l).members.g1), ['a', 'b']);
  // a removed from the page: g2 shows c only.
  const noA = { top: MODEL.top, groups: { g1: [def('b')], g2: [def('c')] } };
  assert.deepEqual(ids(L.resolvePage(noA, l).members.g2), ['c']);
});
