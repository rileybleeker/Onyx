// Run: node --test tests/mobile-tabs.test.cjs
// The phone's bottom tab bar (src/lib/mobile-tabs.ts). Offline, synthetic.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadTs } = require('./helpers/load-ts.cjs');

const { DEFAULT_MOBILE_TABS, DEFAULT_TAB_SLOTS, MORE_SLOT, mobileTabs, tabSlots, chooseTab, isTabActive, tabLabel, badgeText } = loadTs('lib/mobile-tabs.ts');
const { NAV_ITEMS } = loadTs('lib/nav.ts');
const exists = (h) => NAV_ITEMS.some((i) => i.href === h);

test('defaults: Today and Agents left of Log, Chat (Onyx Chat) right of it; all are real nav pages', () => {
  assert.deepEqual(DEFAULT_MOBILE_TABS, ['/today', '/agents', '/chat']);
  assert.deepEqual(mobileTabs(null, exists), ['/today', '/agents', '/chat']);
  for (const h of DEFAULT_MOBILE_TABS) assert.ok(exists(h), h);
});

test('labels are honest: each tab is named after the page it opens', () => {
  const by = Object.fromEntries(NAV_ITEMS.map((i) => [i.href, i]));
  assert.equal(tabLabel(by['/today']), 'Today');
  assert.equal(tabLabel(by['/agents']), 'Agents');
  assert.equal(tabLabel(by['/chat']), 'Chat');
  assert.match(by['/chat'].label, /Chat/, 'the Chat tab opens the page the nav calls Onyx Chat');
  for (const item of NAV_ITEMS) {
    const short = tabLabel(item);
    assert.ok(short.length <= 10, `${item.href}: "${short}" fits the bar`);
  }
});

test('a saved choice overlays the defaults: unknown and repeated pages are dropped, gaps filled', () => {
  assert.deepEqual(mobileTabs(['/sleep', '/habits', '/nutrition'], exists), ['/sleep', '/habits', '/nutrition']);
  assert.deepEqual(mobileTabs(['/gone-page', '/sleep', '/sleep'], exists), ['/sleep', '/today', '/agents']);
  assert.deepEqual(mobileTabs([], exists), ['/today', '/agents', '/chat']);
});

test('active state: Today on / and /today, Agents on any /agents view, Chat on /chat only', () => {
  assert.ok(isTabActive('/today', '/'));
  assert.ok(isTabActive('/today', '/today'));
  assert.ok(isTabActive('/agents', '/agents'));
  assert.ok(isTabActive('/chat', '/chat'));
  assert.ok(!isTabActive('/chat', '/agents'));
  assert.ok(!isTabActive('/agents', '/chat'));
  assert.ok(!isTabActive('/today', '/sleep'));
  assert.ok(isTabActive('/analytics/hrv', '/analytics/hrv'));
  assert.ok(!isTabActive('/health', '/health/records'), 'Health is not active on Medical records');
});

test('unread badge text', () => {
  assert.equal(badgeText(0), '');
  assert.equal(badgeText(-1), '');
  assert.equal(badgeText(NaN), '');
  assert.equal(badgeText(4), '4');
  assert.equal(badgeText(10), '9+');
});

test('four slots around Log: defaults Today, Agents | Log | Chat, More; a saved choice per slot', () => {
  assert.deepEqual(DEFAULT_TAB_SLOTS, ['/today', '/agents', '/chat', MORE_SLOT]);
  assert.deepEqual(tabSlots(null, exists), ['/today', '/agents', '/chat', 'more']);
  assert.deepEqual(tabSlots(['/sleep', '/habits', '/nutrition', '/today'], exists), ['/sleep', '/habits', '/nutrition', '/today']);
  // An unknown or repeated page leaves its slot to its default (or the first unused default).
  assert.deepEqual(tabSlots(['/gone-page', '/sleep', '/sleep', 'more'], exists), ['/today', '/sleep', '/chat', 'more']);
});

test('choosing a page that already sits in another slot swaps the two', () => {
  const slots = ['/today', '/agents', '/chat', 'more'];
  assert.deepEqual(chooseTab(slots, 0, '/sleep'), ['/sleep', '/agents', '/chat', 'more']);
  assert.deepEqual(chooseTab(slots, 0, 'more'), ['more', '/agents', '/chat', '/today']);
  assert.deepEqual(chooseTab(slots, 9, '/sleep'), slots);
});
