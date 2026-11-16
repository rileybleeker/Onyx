// Run: node --test tests/unsaved-work.test.cjs (offline; compiles only the pure helpers). Onyx#326.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const out = mkdtempSync(path.join(tmpdir(), 'onyx-unsaved-work-'));
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), 'src/lib/unsaved-work.ts', 'src/lib/app-update.ts', '--outDir', out, '--module', 'commonjs', '--target', 'ES2022', '--skipLibCheck']);
const { UnsavedWork, trackUnsavedWork, isTextField } = require(path.join(out, 'unsaved-work.js'));
const { updateAction, isBusy } = require(path.join(out, 'app-update.js'));

// The updater's decision as UpdateChecker makes it: focus OR unsaved work.
const decide = (work, doc) => updateAction({ running: 'a', live: 'b', busy: isBusy(doc) || work.has(), reloadedFor: null });
const focusedOn = (tag) => ({ activeElement: { tagName: tag }, querySelector: () => null });

function fakeWindow(responder) {
  const listeners = {};
  return {
    fetch: (input, init) => responder(input, init),
    document: { addEventListener: (type, fn) => { listeners[type] = fn; } },
    type: (target) => listeners.input({ target }),
  };
}
const textarea = (value = '') => ({ tagName: 'TEXTAREA', value, isConnected: true, dataset: {} });

test('clean page: a new build reloads', () => {
  const work = new UnsavedWork();
  assert.equal(decide(work, focusedOn('BUTTON')), 'reload');
});

test('type -> blur -> new build = prompt, not reload (registered form)', () => {
  const work = new UnsavedWork();
  work.setDirty('journal:1', true); // words in the box, focus moved to the "Captured by" button
  assert.equal(decide(work, focusedOn('BUTTON')), 'prompt');
  work.setDirty('journal:1', false); // saved or discarded
  assert.equal(decide(work, focusedOn('BUTTON')), 'reload');
});

test('type -> blur -> new build = prompt (unregistered field, safety net)', () => {
  const work = new UnsavedWork();
  const win = fakeWindow(async () => ({ ok: true }));
  trackUnsavedWork(win, work);
  const field = textarea('half a paragraph');
  win.type(field);
  assert.equal(decide(work, focusedOn('BUTTON')), 'prompt');
  field.value = '';
  assert.equal(decide(work, focusedOn('BUTTON')), 'reload', 'an emptied field has nothing to lose');
});

test('a pending save = prompt; it settles -> reload', async () => {
  const work = new UnsavedWork();
  let finish;
  const win = fakeWindow(() => new Promise((r) => { finish = r; }));
  trackUnsavedWork(win, work);
  const field = textarea('words');
  win.type(field);
  const p = win.fetch('/api/journal/file', { method: 'POST' });
  assert.equal(decide(work, focusedOn('BUTTON')), 'prompt');
  finish({ ok: true });
  await p;
  assert.equal(decide(work, focusedOn('BUTTON')), 'reload', 'a successful write after the typing saved it');
});

test('a failed save keeps the typed words protected', async () => {
  const work = new UnsavedWork();
  const win = fakeWindow(async () => ({ ok: false }));
  trackUnsavedWork(win, work);
  win.type(textarea('words'));
  await win.fetch('/api/journal/file', { method: 'POST' });
  assert.equal(decide(work, focusedOn('BUTTON')), 'prompt');
});

test('a network error settles the write and keeps the words protected', async () => {
  const work = new UnsavedWork();
  const win = fakeWindow(async () => { throw new Error('offline'); });
  trackUnsavedWork(win, work);
  win.type(textarea('words'));
  await assert.rejects(win.fetch('/x', { method: 'PUT' }));
  assert.equal(work.has(), true);
});

test('typing after a write started is not cleared by that write', async () => {
  const work = new UnsavedWork();
  let finish;
  const win = fakeWindow(() => new Promise((r) => { finish = r; }));
  trackUnsavedWork(win, work);
  const p = win.fetch('/api/habits/checkin', { method: 'POST' });
  win.type(textarea('typed while it was saving'));
  finish({ ok: true });
  await p;
  assert.equal(work.has(), true);
});

test('GET reads are not writes; removed fields are forgotten', async () => {
  const work = new UnsavedWork();
  const win = fakeWindow(async () => ({ ok: true }));
  trackUnsavedWork(win, work);
  let resolved = false;
  const p = win.fetch('/api/status').then(() => { resolved = true; });
  assert.equal(work.has(), false);
  await p;
  assert.equal(resolved, true);
  const field = textarea('words');
  win.type(field);
  field.isConnected = false;
  assert.equal(work.has(), false);
});

test('only text-like fields count', () => {
  assert.equal(isTextField({ tagName: 'TEXTAREA', dataset: {} }), true);
  assert.equal(isTextField({ tagName: 'INPUT', type: 'text', dataset: {} }), true);
  assert.equal(isTextField({ tagName: 'INPUT', type: 'checkbox', dataset: {} }), false);
  assert.equal(isTextField({ tagName: 'INPUT', type: 'search', dataset: {} }), false);
  assert.equal(isTextField({ tagName: 'SELECT', dataset: {} }), false);
  assert.equal(isTextField({ tagName: 'DIV', isContentEditable: true, dataset: {} }), true);
  assert.equal(isTextField({ tagName: 'TEXTAREA', dataset: { unsavedIgnore: '' } }), false);
  // A filter or search box is not an entry: typing in it never pins its page of the scroll or blocks an update.
  // closest() stand-in: the field's ancestors match these simple selectors (one per ancestor).
  const within = (...ancestors) => ({
    tagName: 'INPUT', type: 'text', dataset: {},
    closest: (sel) => (sel.split(',').some((part) => ancestors.includes(part.trim())) ? {} : null),
  });
  assert.equal(isTextField(within('[role="search"]')), false, 'inside a role="search" box');
  assert.equal(isTextField(within('[data-unsaved-ignore]')), false, 'inside an ignored container');
  assert.equal(isTextField(within('[data-feed-route]')), true, 'an entry field in a page of the scroll still counts');
  assert.equal(isTextField({ tagName: 'INPUT', type: 'text', dataset: {}, closest: () => { throw new Error('detached'); } }), true);
});

// ---- per page of the continuous scroll (PROD-T01, 2026-11-16) ----------------------------------------------------
// The scroll asks hasIn(route) before unmounting a page far from the screen: a page holding unsaved work stays.

/** A typed field drawn inside the scroll page `route` (closest() finds the page's section). */
const fieldIn = (route, value = '') => ({
  ...textarea(value),
  closest: (selector) => (selector === '[data-feed-route]' ? { getAttribute: (name) => (name === 'data-feed-route' ? route : null) } : null),
});

test('hasIn: a registered form counts for the scroll page it is drawn in, not for others or the routed page', () => {
  const work = new UnsavedWork();
  work.setDirty('autosave:log-reading:1', true, '/log');
  work.setDirty('autosave:nyc-note:2', true); // routed page: no scope
  assert.equal(work.hasIn('/log'), true);
  assert.equal(work.hasIn('/sleep'), false);
  assert.equal(work.has(), true);
  work.setDirty('autosave:log-reading:1', false);
  assert.equal(work.hasIn('/log'), false, 'saved or discarded: the page is no longer held');
  assert.equal(work.has(), true, 'the routed page form still protects the reload');
});

test('hasIn: text typed into a field of a scroll page holds that page until a write saves it', async () => {
  const work = new UnsavedWork();
  const win = fakeWindow(async () => ({ ok: true }));
  trackUnsavedWork(win, work);
  const field = fieldIn('/log', '25 minutes');
  win.type(field);
  assert.equal(work.hasIn('/log'), true);
  assert.equal(work.hasIn('/today'), false);
  await win.fetch('/api/reading/sessions', { method: 'POST' });
  assert.equal(work.hasIn('/log'), false, 'a successful write after the typing released it');
  win.type(fieldIn('/log', ''));
  assert.equal(work.hasIn('/log'), false, 'an empty field holds nothing');
  const gone = fieldIn('/log', 'x');
  win.type(gone);
  gone.isConnected = false;
  assert.equal(work.hasIn('/log'), false, 'a field no longer on the page holds nothing');
});

test('subscribe: told when a form becomes dirty or clean (and when its page changes), never twice for the same state', () => {
  const work = new UnsavedWork();
  let calls = 0;
  const off = work.subscribe(() => { calls += 1; });
  work.setDirty('a', true, '/log');
  work.setDirty('a', true, '/log');
  assert.equal(calls, 1, 'same state again: no call');
  work.setDirty('a', true, '/nutrition');
  assert.equal(calls, 2, 'drawn in another page now');
  work.setDirty('a', false);
  work.setDirty('a', false);
  assert.equal(calls, 3);
  work.setDirty('never-dirty', false);
  assert.equal(calls, 3, 'clearing an unknown key changes nothing');
  off();
  work.setDirty('a', true);
  assert.equal(calls, 3, 'unsubscribed');
});

test('subscribe: a failing listener does not stop the others', () => {
  const work = new UnsavedWork();
  let heard = false;
  work.subscribe(() => { throw new Error('synthetic listener failure'); });
  work.subscribe(() => { heard = true; });
  work.setDirty('a', true, '/log');
  assert.equal(heard, true);
});
