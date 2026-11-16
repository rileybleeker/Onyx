// PROD-T11 (2026-11-16): on a phone, keyboard focus and jumps must stop clear of what is fixed over the page.
// Reproduced on production at 390 px: Tab moved focus to a check-in Yes / No button that sat under the fixed tab
// bar (and, going back with Shift+Tab, under the fixed header) without scrolling, because the browser counted it as
// on screen. The fix is html scroll padding in globals.css. This test keeps the padding in step with the bars it
// clears; it reads source files only. Run: node --test tests/phone-scroll-padding.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
const css = read('app/globals.css');
const TW = 0.25; // rem per Tailwind spacing step (h-12 = 3rem)

/** The body of the first `@media (max-width: 767.98px)` block that sets scroll padding. */
function phoneBlock() {
  const at = css.indexOf('@media (max-width: 767.98px)');
  assert.ok(at >= 0, 'phone media block');
  let depth = 0;
  for (let i = css.indexOf('{', at); i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(at, i + 1);
  }
  throw new Error('unbalanced CSS');
}
const remIn = (decl) => {
  const m = decl.match(/\+ ([\d.]+)rem/);
  assert.ok(m, decl);
  return Number(m[1]);
};
function decl(block, selector, prop) {
  const rule = block.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`));
  assert.ok(rule, `${selector} rule`);
  const d = rule[1].match(new RegExp(`${prop}:\\s*([^;]+);`));
  assert.ok(d, `${selector} ${prop}`);
  return d[1];
}

test('phone scroll padding clears the fixed header and the tab bar (and the safe areas)', () => {
  const block = phoneBlock();
  const top = decl(block, 'html', 'scroll-padding-top');
  const bottom = decl(block, 'html', 'scroll-padding-bottom');
  assert.match(top, /env\(safe-area-inset-top\)/);
  assert.match(bottom, /env\(safe-area-inset-bottom\)/);
  assert.match(top, /var\(--pz-banner-h, 0px\)/, 'the Personalize banner adds its own height');

  const nav = read('components/MobileNav.tsx');
  const header = Number(nav.match(/<div className="h-(\d+) px-3 flex items-center justify-between">/)[1]) * TW;
  const bar = Number(nav.match(/<div className="grid grid-cols-5 h-(\d+)">/)[1]) * TW;
  assert.ok(remIn(top) >= header, `top padding ${remIn(top)}rem clears the ${header}rem header`);
  assert.ok(remIn(bottom) >= bar, `bottom padding ${remIn(bottom)}rem clears the ${bar}rem tab bar`);
});

test('on /log and /check-in the bottom padding also clears the check-in save bar', () => {
  const block = phoneBlock();
  const bottom = remIn(decl(block, 'html:has([data-pz-key="layout.check-in"])', 'scroll-padding-bottom'));
  const checkin = read('app/check-in/CheckInClient.tsx');
  const offset = Number(checkin.match(/sticky bottom-\[calc\(env\(safe-area-inset-bottom\)\+([\d.]+)rem\)\]/)[1]);
  const height = Number(checkin.match(/min-h-\[([\d.]+)rem\]/)[1]);
  assert.ok(bottom >= offset + height, `${bottom}rem >= ${offset}rem above the bottom + ${height}rem tall`);
  assert.match(checkin, /<PartGrid page="\/check-in"/, 'the check-in grid (data-pz-key="layout.check-in") marks the page');
});

test('desktop pads for the open Personalize banner, and for the check-in save bar where the check-in is drawn', () => {
  const desktop = css.match(/\nhtml\s*\{([^}]*)\}/);
  assert.ok(desktop, 'top-level html rule');
  assert.match(desktop[1], /scroll-padding-top:\s*var\(--pz-banner-h, 0px\);/);
  assert.doesNotMatch(desktop[1], /scroll-padding-bottom/, 'no bottom band on pages without the check-in');
  // Reproduced at 1440 px: the save bar (sticky 1rem above the bottom) covered the Yes / No button Tab had reached.
  const outside = css.slice(0, css.indexOf('@media (max-width: 767.98px)'));
  const bottom = decl(outside, 'html:has([data-pz-key="layout.check-in"])', 'scroll-padding-bottom');
  const rem = Number(bottom.match(/^([\d.]+)rem$/)[1]);
  const checkin = read('app/check-in/CheckInClient.tsx');
  const offset = Number(checkin.match(/md:bottom-(\d+) /)[1]) * TW;
  const height = Number(checkin.match(/min-h-\[([\d.]+)rem\]/)[1]);
  assert.ok(rem >= offset + height, `${rem}rem >= ${offset}rem above the bottom + ${height}rem tall`);
});

test('a Log part link still lands where it did (safe area + 4.25rem) now that the padding clears the header', () => {
  const log = read('app/log/LogClient.tsx');
  const anchor = log.match(/function Anchor[\s\S]*?className="([^"]+)"/)[1];
  const margin = Number(anchor.match(/(?:^|\s)scroll-mt-(\d+)(?:\s|$)/)[1]) * TW;
  const top = remIn(decl(phoneBlock(), 'html', 'scroll-padding-top'));
  assert.equal(top + margin, 4.25);
  assert.match(anchor, /md:scroll-mt-6/, 'desktop unchanged');
});
