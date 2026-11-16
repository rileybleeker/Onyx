// PROD-T11 (2026-11-16): every field on the Log screen shows where keyboard focus is. Reproduced at 1440 px: the
// supplement search and its amount / time fields removed the browser's focus ring and only turned the border from
// one grey to another, which could not be seen. Reads source files only (no network, no data).
// Run: node --test tests/log-focus-visible.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'src', 'app', 'log', 'sections');
// Sections other lanes own, left out so their changes cannot turn this guard red under them: SayIt.tsx (its box
// uses accent/40, visible but fainter; listed in PROD-T11's open items), Reading.tsx and Drinks.tsx.
const ELSEWHERE = new Set(['SayIt.tsx', 'Reading.tsx', 'Drinks.tsx']);

/** Class strings (double-quoted or template literals) that take the outline away. */
function outlineFree(src) {
  return [...src.matchAll(/(["`])((?:(?!\1)[^\n])*\boutline-(?:none|hidden)\b(?:(?!\1)[^\n])*)\1/g)].map((m) => m[2]);
}

/**
 * A visible replacement: an accent border of at least 60 % strength, a ring, or a focus-visible outline. Tailwind 4:
 * outline-none sets --tw-outline-style: none, and focus-visible:outline-2 / -accent draw with that variable, so an
 * outline after outline-none counts only with its own style (focus-visible:outline-solid).
 */
function hasIndicator(cls) {
  const border = cls.match(/\bfocus:border-accent(?:\/(\d+))?\b/);
  if (border && (border[1] === undefined || Number(border[1]) >= 60)) return true;
  if (/\bfocus(?:-visible)?:ring\b/.test(cls)) return true;
  if (!/\bfocus-visible:outline-(?!none\b|hidden\b)/.test(cls)) return false;
  return !/\boutline-(?:none|hidden)\b/.test(cls) || /\bfocus-visible:outline-(?:solid|dashed|dotted|double)\b/.test(cls);
}

test('a Log field that drops the outline shows an accent border or a ring instead', () => {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.tsx') && !ELSEWHERE.has(f));
  assert.ok(files.includes('Supplements.tsx') && files.includes('Weight.tsx'), 'sections found');
  for (const file of files) {
    for (const cls of outlineFree(fs.readFileSync(path.join(DIR, file), 'utf8'))) {
      assert.ok(hasIndicator(cls), `${file}: "${cls.slice(0, 80)}…" has no visible focus`);
    }
  }
});

test('the indicator check itself: grey-to-grey and faint accent borders do not count', () => {
  assert.equal(hasIndicator('focus:outline-none focus:border-border-emphasis'), false, 'grey to grey');
  assert.equal(hasIndicator('focus:outline-none focus:border-accent/40'), false, 'too faint');
  assert.equal(hasIndicator('focus:border-accent/60 outline-none'), true);
  assert.equal(hasIndicator('outline-none focus-visible:ring-1 focus-visible:ring-accent'), true);
  assert.equal(hasIndicator('focus:outline-none focus:border-accent'), true);
  // Tailwind 4: the outline after outline-none draws with style none unless it sets its own (review round 1).
  assert.equal(hasIndicator('outline-none focus-visible:outline-2 focus-visible:outline-accent'), false, 'no outline style');
  assert.equal(hasIndicator('focus:outline-none focus-visible:outline-2 focus-visible:outline-accent'), false, 'focus: variant too');
  assert.equal(hasIndicator('outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-accent'), true);
  assert.equal(hasIndicator('focus-visible:outline-2 focus-visible:outline-accent'), true, 'no outline-none: the default style stays');
  assert.equal(hasIndicator('outline-none focus-visible:outline-none'), false);
});

test('the scan reads template literals too', () => {
  const found = outlineFree('<input className={`px-3 ${x} outline-none focus:border-accent/60`} /> <a className="block" />');
  assert.deepEqual(found, ['px-3 ${x} outline-none focus:border-accent/60']);
});

test('the supplement fields use the same accent border as Weight and Reading', () => {
  const src = fs.readFileSync(path.join(DIR, 'Supplements.tsx'), 'utf8');
  const input = src.match(/const input =\s*"([^"]+)"/);
  assert.ok(input, 'shared field class');
  assert.match(input[1], /focus:border-accent\/60/);
  assert.doesNotMatch(input[1], /focus:border-border-emphasis/);
});
