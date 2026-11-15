// Run: node --test tests/go-shortcuts.test.cjs
// "Go to" keyboard shortcuts (src/lib/go-shortcuts.ts) and the letters in src/lib/nav.ts. Offline, synthetic.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadTs } = require('./helpers/load-ts.cjs');

const { createGoShortcuts, goHint, isTypingTarget, GO_WINDOW_MS } = loadTs('lib/go-shortcuts.ts');
const { NAV_ITEMS } = loadTs('lib/nav.ts');

test('every nav item has a shortcut, and no two share one', () => {
  const keys = NAV_ITEMS.map((i) => i.shortcut.toLowerCase());
  for (const item of NAV_ITEMS) assert.match(item.shortcut, /^[A-Z0-9]$/, `${item.label} has a single-key shortcut`);
  assert.equal(new Set(keys).size, keys.length, `duplicates: ${keys.filter((k, i) => keys.indexOf(k) !== i).join(', ')}`);
  // Existing letters kept; the four new ones.
  const by = Object.fromEntries(NAV_ITEMS.map((i) => [i.href, i.shortcut]));
  assert.equal(by['/today'], 'H');
  assert.equal(by['/agents'], 'G');
  assert.equal(by['/check-in'], 'K');
  assert.deepEqual([by['/health'], by['/health/records'], by['/financials/budgets'], by['/financials/forecast']], ['Z', 'X', 'Q', '4']);
  assert.equal(by['/log'], '1', 'Log: the one screen for every entry');
});

test('hint reads "G <key>"', () => {
  assert.equal(goHint('H'), 'G H');
  assert.equal(goHint('4'), 'G 4');
  assert.equal(goHint(''), '');
});

function machine() {
  const clock = { t: 1000 };
  return { clock, keys: createGoShortcuts(NAV_ITEMS, () => clock.t) };
}
const body = { tagName: 'BODY', getAttribute: () => null, closest: () => null };
const press = (keys, key, extra = {}) => keys.onKey({ key, target: body, ...extra });

test('G then a key opens that page; G G is Agents; capitals (Caps Lock) work', () => {
  const { keys } = machine();
  assert.equal(press(keys, 'g'), null);
  assert.equal(press(keys, 'h'), '/today');
  press(keys, 'g');
  assert.equal(press(keys, 'g'), '/agents');
  press(keys, 'G');
  assert.equal(press(keys, 'V'), '/analytics/hrv');
  press(keys, 'g');
  assert.equal(press(keys, '4'), '/financials/forecast');
});

test('the window is 1.5 s; an unknown key or a letter without G does nothing', () => {
  const { keys, clock } = machine();
  assert.equal(press(keys, 'h'), null, 'a letter alone is not a command');
  press(keys, 'g');
  clock.t += GO_WINDOW_MS + 1;
  assert.equal(press(keys, 'h'), null, 'too late');
  press(keys, 'g');
  clock.t += GO_WINDOW_MS - 100;
  assert.equal(press(keys, 's'), '/sleep');
  press(keys, 'g');
  assert.equal(press(keys, '!'), null, 'no page on that key, and it disarms');
  assert.equal(press(keys, 'h'), null);
  press(keys, 'g');
  assert.equal(press(keys, 'Escape'), null);
  assert.equal(press(keys, 'h'), null, 'a non-character key disarms');
});

test('nothing happens while typing or with a modifier held (Ctrl / Cmd + K stays the palette)', () => {
  const { keys } = machine();
  for (const target of [{ tagName: 'INPUT' }, { tagName: 'textarea' }, { tagName: 'SELECT' }, { tagName: 'DIV', isContentEditable: true },
    { tagName: 'DIV', getAttribute: (n) => (n === 'role' ? 'textbox' : null) }, { tagName: 'SPAN', getAttribute: () => null, closest: () => ({}) }]) {
    assert.equal(isTypingTarget(target), true, JSON.stringify(target));
    assert.equal(keys.onKey({ key: 'g', target }), null);
    assert.equal(keys.onKey({ key: 'h', target }), null);
  }
  assert.equal(isTypingTarget(body), false);
  for (const mod of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey']) {
    press(keys, 'g');
    assert.equal(press(keys, 'h', { [mod]: true }), null, mod);
    assert.equal(press(keys, 'g', { [mod]: true }), null);
    assert.equal(press(keys, 'h'), null, `${mod} also disarms`);
  }
  press(keys, 'g');
  assert.equal(press(keys, 'h', { isComposing: true }), null);
  press(keys, 'g');
  assert.equal(press(keys, 'g', { repeat: true }), null, 'a held G does not count twice');
  assert.equal(press(keys, 'h'), '/today');
});
