// Theme guard (Direction D, "Instrument", 2026-11-14).
// Fails when the old Terminal palette or its square corners come back, or when
// the chart palette drifts from the CSS tokens. Fix by using the tokens:
// colors -> bg-surface-card / text-accent / text-up ... or lib/chart-theme.ts;
// corners -> rounded-card (cards) / rounded-control (buttons, inputs, nav).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));

function walk(d, out = []) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(tsx?|css)$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = walk(srcDir).map((p) => ({ p: path.relative(srcDir, p), s: fs.readFileSync(p, 'utf8') }));
let count = 0;
function test(name, fn) { fn(); count++; console.log(`PASS ${name}`); }

// The Terminal palette's identifying values (accent green, slate surfaces, greys, old status colors).
const OLD_HEX = ['16E07A', '08090B', '0E1014', '15181E', '1A1E26', 'FF4159', 'FFD23F', '9AA0A6', '5F6368', 'E8EAED', '1DB954', '0093E7', '33B5F5', '7DD3FC'];
const OLD_HEX_RE = new RegExp(`#(${OLD_HEX.join('|')})\\b`, 'i');

test('no Terminal-palette hex colors in src', () => {
  const hits = [];
  for (const { p, s } of files) {
    s.split('\n').forEach((line, i) => { if (OLD_HEX_RE.test(line)) hits.push(`${p}:${i + 1}: ${line.trim().slice(0, 120)}`); });
  }
  assert.deepEqual(hits, [], `Old Terminal colors found; use the theme tokens instead:\n${hits.join('\n')}`);
});

test('no square-corner radii (rounded-[4px|5px|6px], incl. one side) in components', () => {
  const hits = [];
  for (const { p, s } of files) {
    if (!p.endsWith('.tsx')) continue;
    s.split('\n').forEach((line, i) => { if (/\brounded(-[lrtb])?-\[(4|5|6)px\]/.test(line)) hits.push(`${p}:${i + 1}`); });
  }
  assert.deepEqual(hits, [], `Use rounded-card (cards) or rounded-control (buttons, inputs, nav):\n${hits.join('\n')}`);
});

const css = files.find((f) => f.p === path.join('app', 'globals.css')).s;
const chart = files.find((f) => f.p === path.join('lib', 'chart-theme.ts')).s;
const token = (name) => {
  const m = css.match(new RegExp(`--color-${name}:\\s*(#[0-9A-Fa-f]{6})`));
  assert.ok(m, `token --color-${name} missing`);
  return m[1].toUpperCase();
};

test('chart palette matches the CSS tokens', () => {
  const pick = (key) => {
    const m = chart.match(new RegExp(`\\b${key}: "(#[0-9A-Fa-f]{6})"`));
    assert.ok(m, `chartColors.${key} missing`);
    return m[1].toUpperCase();
  };
  assert.equal(chart.match(/accentColor = "(#[0-9A-Fa-f]{6})"/)[1].toUpperCase(), token('accent'));
  for (const [key, tok] of [['up', 'up'], ['down', 'down'], ['mid', 'mid'], ['neutral', 'neutral'], ['strain', 'strain'], ['cardBg', 'surface-card']]) {
    assert.equal(pick(key), token(tok), `chartColors.${key} != --color-${tok}`);
  }
  for (const src of ['garmin', 'whoop', 'eightsleep', 'cronometer', 'spotify']) {
    assert.equal(pick(src), token(`source-${src}`), `sourceColors.${src} != --color-source-${src}`);
  }
});

test('radius, shadow and on-accent tokens exist', () => {
  for (const t of ['--radius-card', '--radius-control', '--shadow-card', '--color-on-accent', '--color-surface-sunken']) {
    assert.ok(css.includes(`${t}:`), `${t} missing from globals.css`);
  }
});

test('no Terminal aurora backdrop', () => {
  assert.ok(!/body::before/.test(css) && !/aura-drift/.test(css), 'the drifting aurora backdrop is not part of the Instrument theme');
});

console.log(`${count} theme checks passed`);
