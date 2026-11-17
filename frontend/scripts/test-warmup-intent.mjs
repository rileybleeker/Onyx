// Warm-up guard: the background sweep must not fetch the /log weight window (or the Today overview's 90-day
// weight read). Those are warmed only on intent (hover, focus, press, command palette via warmRoute).
// Fix by keeping `intentOnly: true` on those warmers and by the sweep filtering them out in lib/warmup.ts runWarmup.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');
const warmup = read('lib/warmup.ts');
const appData = read('components/AppData.tsx');
const sources = read('components/overview/sources.ts');

let count = 0;
function test(name, fn) { fn(); count++; console.log(`PASS ${name}`); }

test('the sweep filters out intent-only warmers', () => {
  assert.match(warmup, /warmers\.filter\(\(w\) => !w\.intentOnly\b/);
  assert.match(warmup, /warmRoute[\s\S]*target\.data\(\)/);
});

test('/log weight window is intent-only', () => {
  assert.match(appData, /\{ \.\.\.json\("\/api\/weight\?days=365"\), intentOnly: true \}/);
});

test('Today overview 90-day weight read is intent-only and the flag is passed through', () => {
  assert.match(sources, /key: "\/api\/weight\?days=90"[^\n]*intentOnly: true/);
  assert.match(sources, /intentOnly: s\.intentOnly/);
});

console.log(`${count} tests passed`);
