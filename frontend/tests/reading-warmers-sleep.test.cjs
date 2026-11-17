// Run: node --test tests/reading-warmers-sleep.test.cjs
// The Reading warm-up reads (list, practice, bank) carry a skipOn that names /sleep, so the background sweep leaves
// them out while /sleep is on screen. Source-text check, offline.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

const src = readFileSync(path.join(__dirname, '..', 'src', 'components', 'AppData.tsx'), 'utf8');

test('skipOnSleep skips /sleep and /sleep/ paths only', () => {
  assert.match(src, /const skipOnSleep = \(page: string\) => page === "\/sleep" \|\| page\.startsWith\("\/sleep\/"\);/);
});

test('reading list warmer carries skipOnSleep', () => {
  assert.match(src, /\{ \.\.\.json\("\/api\/reading\/list"\), skipOn: skipOnSleep \}/);
});

test('reading practice and bank warmers carry skipOnSleep', () => {
  assert.match(src, /\{ \.\.\.json\(practiceUrl\(slug\)\), skipOn: skipOnSleep \}/);
  assert.match(src, /\{ \.\.\.json\(bankUrl\(slug\)\), skipOn: skipOnSleep \}/);
});

test('other reading reads are unchanged (no skipOn on /api/reading or pacing)', () => {
  assert.doesNotMatch(src, /json\("\/api\/reading"\), skipOn/);
  assert.doesNotMatch(src, /json\("\/api\/ui\/preferences\?key=reading\.pacing"\), skipOn/);
});
