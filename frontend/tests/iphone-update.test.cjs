// Run: node --test tests/iphone-update.test.cjs  (offline, synthetic)
const test = require('node:test');
const assert = require('node:assert');
const { loadTs } = require('./helpers/load-ts.cjs');
const u = loadTs('lib/iphone-update.ts');
const now = new Date('2026-11-18T12:00:00Z');
const latest = { version: '1.5', build: '90' };

test('older build is an update, newer or equal is current', () => {
  assert.equal(u.updateStatus('1.4 (87)', '2026-11-17T00:00:00Z', latest, now).verdict, 'update');
  assert.equal(u.updateStatus('1.5 (89)', '2026-11-17T00:00:00Z', latest, now).verdict, 'update');
  assert.equal(u.updateStatus('1.5 (90)', '2026-11-17T00:00:00Z', latest, now).verdict, 'current');
  assert.equal(u.updateStatus('1.10 (1)', '2026-11-17T00:00:00Z', latest, now).verdict, 'current');
});
test('a silent or never-reporting phone says check; no published build or unreadable text is unknown', () => {
  assert.equal(u.updateStatus('1.5 (90)', '2026-11-01T00:00:00Z', latest, now).verdict, 'check');
  assert.equal(u.updateStatus(null, null, latest, now).verdict, 'check');
  assert.equal(u.updateStatus('?', '2026-11-17T00:00:00Z', latest, now).verdict, 'unknown');
  assert.equal(u.updateStatus('1.4 (87)', '2026-11-17T00:00:00Z', null, now).verdict, 'unknown');
});
test('stale report with an older build still says update; card shows for update and check only', () => {
  assert.equal(u.updateStatus('1.4 (87)', '2026-10-01T00:00:00Z', latest, now).verdict, 'update');
  assert.equal(u.showUpdateCard({ verdict: 'current' }), false);
  assert.equal(u.showUpdateCard({ verdict: 'check' }), true);
});
test('newestBuild picks the highest', () => {
  assert.deepEqual(u.newestBuild([null, { version: '1.4', build: '9' }, { version: '1.4', build: '10' }]), { version: '1.4', build: '10' });
});
