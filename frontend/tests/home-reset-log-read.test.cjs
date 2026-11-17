// Run: node --test tests/home-reset-log-read.test.cjs
// /log does not show the apartment-reset card, so it must not request /api/home-reset: the background sweep has no
// warmer for it, and the hook's window listeners re-read only while a card is mounted. Source-text checks, offline.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const appData = readFileSync(path.join(__dirname, '..', 'src', 'components', 'AppData.tsx'), 'utf8');
const hook = readFileSync(path.join(__dirname, '..', 'src', 'lib', 'use-home-reset.ts'), 'utf8');

test('the warm-up sweep never reads /api/home-reset (so /log does not either)', () => {
  assert.doesNotMatch(appData, /home-reset/);
});

test('the visibility and online listeners read only with a card mounted or a save waiting', () => {
  assert.match(hook, /document\.visibilityState === "visible" && \(state\.ops\.length \|\| listeners\.size\)/);
  assert.match(hook, /window\.addEventListener\("online", \(\) => \{ if \(state\.ops\.length \|\| listeners\.size\) void flushHomeReset\(\); \}\);/);
});

test('the first card on screen reads the plan once, not from start() plus a second flush', () => {
  assert.match(hook, /if \(firstOnScreen\) void flushHomeReset\(\);/);
  assert.doesNotMatch(hook, /loadHomeReset\(\)\.then\(\(\) => flushHomeReset\(\)\)/);
});
