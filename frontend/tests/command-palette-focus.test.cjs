// Source-level checks for the command palette's focus return (synthetic, no network, no DOM).
// Escape and an outside click hand focus back to the opener or the visible Search control; a page or
// Personalize choice does not. The trigger attribute must exist on both Search controls.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");

test("palette records the opener when it opens", () => {
  const src = read("components/CommandPalette.tsx");
  assert.match(src, /const openerRef = useRef<HTMLElement \| null>\(null\)/);
  assert.match(src, /openerRef\.current =/);
  assert.match(src, /prior !== document\.body/);
});

test("palette restores focus after close, with an opener-then-Search fallback", () => {
  const src = read("components/CommandPalette.tsx");
  assert.match(src, /const restoreFocus = useRef\(false\)/);
  assert.match(src, /if \(open \|\| !restoreFocus\.current\) return;/);
  assert.match(src, /querySelectorAll<HTMLElement>\("\[data-palette-trigger\]"\)/);
  assert.match(src, /\(canTakeFocus\(opener\) \? opener : trigger\)\?\.focus\(\)/);
  assert.match(src, /el\.getClientRects\(\)\.length > 0/);
});

test("Escape and outside click restore focus; a page or Personalize choice does not", () => {
  const src = read("components/CommandPalette.tsx");
  assert.match(src, /e\.key === "Escape"[\s\S]*?close\(true\)/);
  assert.match(src, /onClick=\{\(\) => close\(true\)\}/);
  assert.match(src, /const go = useCallback[\s\S]*?close\(false\)/);
  assert.doesNotMatch(src, /\bclose\(\)/);
});

// The modal keydown effect: only while open, Escape from anywhere in the dialog, Tab / Shift+Tab wrap.
const dialogEffect = (src) => {
  const m = src.match(/useEffect\(\(\) => \{\s*if \(!open\) return;\s*const dialog = dialogRef\.current;[\s\S]*?\}, \[open, close\]\);/);
  assert.ok(m, "dialog keydown effect keyed on open");
  return m[0];
};

test("palette dialog root carries the ref the modal handler uses", () => {
  const src = read("components/CommandPalette.tsx");
  assert.match(src, /const dialogRef = useRef<HTMLDivElement>\(null\)/);
  assert.match(src, /ref=\{dialogRef\}[\s\S]*?role="dialog"/);
});

test("Escape from a result (not only the input) closes once, through close(true)", () => {
  const src = read("components/CommandPalette.tsx");
  const effect = dialogEffect(src);
  assert.match(effect, /document\.addEventListener\("keydown", onDialogKey\)/);
  assert.match(effect, /e\.key === "Escape"\)\s*\{\s*e\.preventDefault\(\);\s*close\(true\);/);
  // Exactly one Escape handler in the file: the input's own branch is gone.
  assert.equal((src.match(/e\.key === "Escape"/g) || []).length, 1);
});

test("Tab from the last element wraps to the first; outside focus goes to the first", () => {
  const effect = dialogEffect(read("components/CommandPalette.tsx"));
  assert.match(effect, /'a\[href\], button:not\(\[disabled\]\), input:not\(\[disabled\]\), \[tabindex="0"\]'/);
  assert.match(effect, /getClientRects\(\)\.length > 0/);
  assert.match(effect, /dialog!?\.contains\(document\.activeElement\)/);
  assert.match(effect, /!e\.shiftKey && \(document\.activeElement === last \|\| !inside\)\)\s*\{\s*e\.preventDefault\(\);\s*first\.focus\(\);/);
});

test("Shift+Tab from the first element wraps to the last", () => {
  const effect = dialogEffect(read("components/CommandPalette.tsx"));
  assert.match(effect, /e\.shiftKey && \(document\.activeElement === first \|\| !inside\)\)\s*\{\s*e\.preventDefault\(\);\s*\(inside \? last : first\)\.focus\(\);/);
});

test("the modal keydown listener is removed on close and unmount", () => {
  const effect = dialogEffect(read("components/CommandPalette.tsx"));
  assert.match(effect, /return \(\) => document\.removeEventListener\("keydown", onDialogKey\);/);
});

test("both visible Search controls carry data-palette-trigger", () => {
  assert.match(read("components/Sidebar.tsx"), /data-palette-trigger=""/);
  assert.match(read("components/MobileNav.tsx"), /data-palette-trigger=""/);
});
