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

test('the Focus build (superset) is the one to install when published', () => {
  const d = { version: '0.1.0', build: '500' }, f = { version: '0.1.0', build: '480' };
  assert.equal(u.installTarget(d, f), f);
  assert.equal(u.installTarget(d, null), d);
  assert.equal(u.installTarget(null, null), null);
});
test('only itms-services download links are install URLs', () => {
  assert.equal(u.isInstallUrl('itms-services://?action=download-manifest&url=https%3A%2F%2Fx'), true);
  assert.equal(u.isInstallUrl('https://evil.example/x'), false);
  assert.equal(u.isInstallUrl(null), false);
});
test('hello validation', () => {
  assert.deepEqual(u.parseHello({ variant: 'focus', app_version: '0.1.0', build: '465123' }), { variant: 'focus', app_version: '0.1.0', build: '465123' });
  assert.equal(u.parseHello({ variant: 'x', app_version: '0.1.0', build: '1' }), null);
  assert.equal(u.parseHello({ variant: 'default', app_version: '1; drop', build: '1' }), null);
  assert.equal(u.parseHello({ variant: 'default', app_version: '1.0', build: 5 }), null);
  assert.equal(u.parseHello(null), null);
});
test('trust step only when the installed build predates the current certificate', () => {
  assert.equal(u.needsTrustStep({ version: '0.1.0', build: '100' }, '200'), true);
  assert.equal(u.needsTrustStep({ version: '0.1.0', build: '300' }, '200'), false);
  assert.equal(u.needsTrustStep(null, '200'), false);
  assert.equal(u.needsTrustStep({ version: '0.1.0', build: '100' }, null), false);
});

test('update button href: Safari hand-off inside the home-screen app, direct link in Safari', () => {
  const link = 'itms-services://?action=download-manifest&url=https%3A%2F%2Fx';
  assert.equal(u.updateHref(link, true, 'https://onyx.example'), 'x-safari-https://onyx.example/install?auto=1');
  assert.equal(u.updateHref(null, true, 'https://onyx.example'), 'x-safari-https://onyx.example/install?auto=1');
  assert.equal(u.updateHref(link, false, 'https://onyx.example'), link);
  assert.equal(u.updateHref(null, false, 'https://onyx.example'), null);
  assert.equal(u.updateHref(link, true, 'http://localhost:3000'), null);
});
