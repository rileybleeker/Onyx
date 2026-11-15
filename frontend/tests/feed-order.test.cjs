// Run: node --test tests/feed-order.test.cjs
// The continuous scroll's page order (src/lib/feed-order.ts). Offline, synthetic.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadTs } = require('./helpers/load-ts.cjs');

const { areaOrder, feedSequence, feedRouteOf, isFeedExcluded, neighbourOf, parseAreaOrder, feedTitle } = loadTs('lib/feed-order.ts');

const NAV = ['/today', '/activities', '/nutrition', '/log', '/sleep', '/analytics/hrv', '/agents', '/financials', '/chat', '/status'];
const all = () => true;

test('route keys: "/" is Today, query, hash and trailing slash are dropped', () => {
  assert.equal(feedRouteOf('/'), '/today');
  assert.equal(feedRouteOf('/caffeine?days=720#x'), '/caffeine');
  assert.equal(feedRouteOf('/sleep/'), '/sleep');
});

test('excluded routes never join the scroll', () => {
  for (const r of ['/login', '/auth/callback', '/agents', '/chat', '/account', '/install']) assert.ok(isFeedExcluded(r), r);
  assert.ok(!isFeedExcluded('/today'));
  const order = areaOrder(NAV, null);
  assert.ok(!order.includes('/agents') && !order.includes('/chat'));
  assert.deepEqual(feedSequence(NAV, null, '/agents', all), []);
  assert.deepEqual(feedSequence(NAV, null, '/heart', all), [], 'a page that is not an area gets no scroll');
});

test('default: nav order with Today first', () => {
  assert.deepEqual(areaOrder(['/sleep', '/today', '/status'], null), ['/today', '/sleep', '/status']);
  assert.deepEqual(feedSequence(NAV, null, '/sleep', all), ['/today', '/activities', '/nutrition', '/log', '/sleep', '/analytics/hrv', '/financials', '/status']);
});

test('pages without a FeedSection are skipped, except the routed page', () => {
  const has = (r) => r !== '/log' && r !== '/financials';
  const seq = feedSequence(NAV, null, '/today', has);
  assert.ok(!seq.includes('/log') && !seq.includes('/financials'));
  assert.ok(feedSequence(NAV, null, '/log', has).includes('/log'));
});

test('a saved order: known pages in that order, new pages after their default predecessor, hidden skipped', () => {
  const known = areaOrder(NAV, null);
  const saved = parseAreaOrder({ order: ['/sleep', '/today', 'analytics.hrv'], hidden: ['/status'] }, known);
  assert.deepEqual(saved, { order: ['/sleep', '/today', '/analytics/hrv'], hidden: ['/status'] });
  const order = areaOrder(NAV, saved);
  assert.deepEqual(order.slice(0, 3), ['/sleep', '/today', '/activities']);
  assert.equal(order.length, known.length);
  const seq = feedSequence(NAV, saved, '/today', all);
  assert.ok(!seq.includes('/status'));
  assert.ok(feedSequence(NAV, saved, '/status', all).includes('/status'), 'a hidden routed page keeps its place');
});

test('accepted shapes: page-layout grid, list with hidden flags, local copy, junk', () => {
  const known = areaOrder(NAV, null);
  // A Personalize layout also names the Quick access pages (the default pins when it has no grids.quick).
  assert.deepEqual(parseAreaOrder({ v: 1, grids: { main: { order: ['sleep', 'today'], hide: { status: true } } } }, known), { order: ['/sleep', '/today'], hidden: ['/status'], pinned: ['/today', '/log'] });
  assert.deepEqual(parseAreaOrder([{ href: '/nutrition' }, { href: '/sleep', hidden: true }, '/today', '/nope'], known), { order: ['/nutrition', '/sleep', '/today'], hidden: ['/sleep'] });
  assert.deepEqual(parseAreaOrder({ l: ['analytics-hrv', 'today'] }, known), { order: ['/analytics/hrv', '/today'], hidden: [] });
  assert.equal(parseAreaOrder(null, known), null);
  assert.equal(parseAreaOrder('x', known), null);
  assert.equal(parseAreaOrder({ something: 1 }, known), null);
});

test('Quick access (pinned) pages lead the scroll; a page hidden from the side panel is not pinned', () => {
  const known = areaOrder(NAV, null);
  const layout = { v: 1, grids: { main: { order: ['nutrition', 'sleep', 'today'] }, quick: { order: ['sleep'], hide: { sleep: false, 'log': true } } } };
  const saved = parseAreaOrder(layout, known);
  assert.deepEqual(saved.pinned, ['/sleep', '/today']);
  assert.deepEqual(areaOrder(NAV, saved).slice(0, 3), ['/sleep', '/today', '/nutrition']);
  assert.deepEqual(feedSequence(NAV, saved, '/nutrition', all).slice(0, 3), ['/sleep', '/today', '/nutrition']);
  const off = parseAreaOrder({ v: 1, grids: { quick: { order: ['sleep'], hide: { sleep: false } }, nav: { hide: { sleep: true } } } }, known);
  assert.deepEqual(off.pinned, ['/today', '/log']);
  // A layout with only the bottom bar or hidden-from-navigation says nothing about the scroll.
  assert.equal(parseAreaOrder({ v: 1, grids: { tabs: { order: ['sleep'] } } }, known), null);
});

test('neighbours and titles', () => {
  const seq = ['/today', '/activities', '/sleep'];
  assert.equal(neighbourOf(seq, '/today', -1), null);
  assert.equal(neighbourOf(seq, '/today', 1), '/activities');
  assert.equal(neighbourOf(seq, '/sleep', 1), null);
  assert.equal(neighbourOf(seq, '/nope', 1), null);
  assert.equal(feedTitle('Sleep & Recovery'), 'Sleep & Recovery - Onyx');
});
