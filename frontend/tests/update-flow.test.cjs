// Run: node --test tests/update-flow.test.cjs  (offline, synthetic)
const test = require('node:test');
const assert = require('node:assert');
const { loadTs } = require('./helpers/load-ts.cjs');
const f = loadTs('lib/update-flow.ts');
const T = '0.1.0 (12)';
const ctx = (o) => ({ now: 0, installed: '0.1.0 (11)', available: T, needsTrust: false, webChecked: true, webBehind: false, retryHref: '/install?auto=1', ...o });
const base = () => f.startFlow(T, true, false, 0);

test('steps follow the recorded events', () => {
  assert.equal(f.flowView(base(), ctx({ now: 1000 })).step, 'handed_off');
  const p = f.recordPrompt(base(), 2000);
  assert.equal(f.flowView(p, ctx({ now: 3000 })).step, 'install_prompt');
  const h = f.recordHidden(p, 5000);
  assert.equal(f.flowView(h, ctx({ now: 6000 })).step, 'installing');
  assert.equal(f.flowView(h, ctx({ now: 5000 + f.INSTALL_MS + 1 })).step, 'open_app');
});
test('no popup after 20 s offers one concrete action', () => {
  const v = f.flowView(f.recordPrompt(base(), 0), ctx({ now: 21000 }));
  assert.equal(v.step, 'no_prompt');
  assert.equal(v.action.label, 'Tap Install again');
  assert.equal(f.flowView(base(), ctx({ now: 21000 })).step, 'no_prompt');
});
test('not reported after 5 min links to the app; trust links to Settings', () => {
  const h = f.recordHidden(f.recordPrompt(base(), 0), 1000);
  const v = f.flowView(h, ctx({ now: f.UNCONFIRMED_MS + 1 }));
  assert.equal(v.step, 'unconfirmed');
  assert.equal(v.action.href, 'onyxscreentime://');
  const t = f.flowView(h, ctx({ now: 30000, needsTrust: true }));
  assert.equal(t.step, 'needs_trust');
  assert.equal(t.action.href, f.TRUST_URL);
});
test('reported build finishes the flow, green for 10 s, then gone', () => {
  let s = f.recordHidden(f.recordPrompt(base(), 0), 1000);
  const c = ctx({ now: 70000, installed: T });
  s = f.settle(s, c);
  assert.equal(s.doneAt, 70000);
  const v = f.flowView(s, c);
  assert.equal(v.step, 'done');
  assert.match(v.title, /Updated to 0\.1\.0 \(12\)/);
  assert.equal(f.flowActive(s, 70000 + f.DONE_SHOW_MS + 1), false);
  assert.equal(f.flowActive(s, 70000 + 5000), true);
});
test('web-only flow finishes once the web is current; unchecked web never counts', () => {
  let s = f.startFlow(null, false, true, 0);
  assert.equal(f.settle(s, ctx({ now: 5, webChecked: false })).webDoneAt, undefined);
  s = f.settle(s, ctx({ now: 5 }));
  assert.equal(f.flowView(s, ctx({ now: 6 })).title.startsWith('Onyx updated'), true);
});
test('polling stops when done or expired; garbage storage is rejected', () => {
  assert.equal(f.shouldPoll(base(), 1000), true);
  assert.equal(f.shouldPoll({ ...base(), doneAt: 1 }, 1000), false);
  assert.equal(f.shouldPoll(base(), f.EXPIRE_MS + 1), false);
  assert.equal(f.parseFlow('{"target":1}'), null);
  assert.equal(f.parseFlow(JSON.stringify(base())).target, T);
});
