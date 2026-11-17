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

test("both visible Search controls carry data-palette-trigger", () => {
  assert.match(read("components/Sidebar.tsx"), /data-palette-trigger=""/);
  assert.match(read("components/MobileNav.tsx"), /data-palette-trigger=""/);
});
