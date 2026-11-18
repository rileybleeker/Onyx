// Run: node --test tests/app-update.test.cjs (offline; compiles only the pure helper).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const out = mkdtempSync(path.join(tmpdir(), 'onyx-app-update-'));
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), 'src/lib/app-update.ts', '--outDir', out, '--module', 'commonjs', '--target', 'ES2022', '--skipLibCheck']);
const { updateAction, isBusy } = require(path.join(out, 'app-update.js'));

test('same build or an unknown build: nothing happens', () => {
  assert.equal(updateAction({ running: 'a', live: 'a', busy: false, reloadedFor: null }), 'none');
  assert.equal(updateAction({ running: undefined, live: 'b', busy: false, reloadedFor: null }), 'none');
  assert.equal(updateAction({ running: 'a', live: null, busy: false, reloadedFor: null }), 'none');
});

test('a newer build reloads, unless the user is busy', () => {
  assert.equal(updateAction({ running: 'a', live: 'b', busy: false, reloadedFor: null }), 'reload');
  assert.equal(updateAction({ running: 'a', live: 'b', busy: true, reloadedFor: null }), 'prompt');
});

test('never loops: after one reload for a build it only offers the button', () => {
  assert.equal(updateAction({ running: 'a', live: 'b', busy: false, reloadedFor: 'b' }), 'prompt');
  assert.equal(updateAction({ running: 'a', live: 'c', busy: false, reloadedFor: 'b' }), 'reload');
});

test('typing in a field or an open dialog counts as busy', () => {
  const doc = (tag, dialog = false, editable = false) => ({
    activeElement: tag ? { tagName: tag, isContentEditable: editable } : null,
    querySelector: () => (dialog ? {} : null),
  });
  assert.equal(isBusy(doc('INPUT')), true);
  assert.equal(isBusy(doc('TEXTAREA')), true);
  assert.equal(isBusy(doc('DIV', false, true)), true);
  assert.equal(isBusy(doc('BUTTON', true)), true);
  assert.equal(isBusy(doc('BUTTON')), false);
  assert.equal(isBusy(doc(null)), false);
});

test('webBehind: only when both commits are known and differ', () => {
  const { webBehind } = require(path.join(out, 'app-update.js'));
  assert.equal(webBehind('a', 'b'), true);
  assert.equal(webBehind('a', 'a'), false);
  assert.equal(webBehind(undefined, 'b'), false);
  assert.equal(webBehind('a', null), false);
});
