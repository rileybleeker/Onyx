// PROD-T11 (2026-11-16): every field on the Log screen shows where keyboard focus is. Reproduced at 1440 px: the
// supplement search and its amount / time fields removed the browser's focus ring and only turned the border from
// one grey to another, which could not be seen. Reads source files only (no network, no data).
// Run: node --test tests/log-focus-visible.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', 'src', 'app', 'log', 'sections');
// SayIt.tsx is owned by the Say it lane: its box uses accent/40 (visible, fainter); listed in PROD-T11's open items.
const ELSEWHERE = new Set(['SayIt.tsx']);

/** Class strings (quoted literals) that take the outline away. */
function outlineFree(src) {
  return [...src.matchAll(/"([^"\n]*\boutline-none\b[^"\n]*)"/g)].map((m) => m[1]);
}

/** A visible replacement: an accent border of at least 60 % strength, or a focus-visible outline or ring. */
function hasIndicator(cls) {
  const border = cls.match(/\bfocus:border-accent(?:\/(\d+))?\b/);
  if (border && (border[1] === undefined || Number(border[1]) >= 60)) return true;
  return /\bfocus-visible:(?:outline|ring)\b/.test(cls) || /\bfocus:ring\b/.test(cls);
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
});

test('the supplement fields use the same accent border as Weight and Reading', () => {
  const src = fs.readFileSync(path.join(DIR, 'Supplements.tsx'), 'utf8');
  const input = src.match(/const input =\s*"([^"]+)"/);
  assert.ok(input, 'shared field class');
  assert.match(input[1], /focus:border-accent\/60/);
  assert.doesNotMatch(input[1], /focus:border-border-emphasis/);
});
