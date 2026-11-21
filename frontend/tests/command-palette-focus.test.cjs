// The command palette's keyboard focus (synthetic, no network, no browser). Escape and an outside click hand focus
// back to the opener or the visible Search control; a page or Personalize choice does not. While open, the palette is
// a modal: keys are pressed in a stand-in page to check Escape from a result, Tab / Shift+Tab wrap and the cleanup.
// Run: node --test tests/command-palette-focus.test.cjs
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
  assert.match(src, /trapDialogKeys\(document, dialog, \(\) => close\(true\)\)/);
  assert.match(src, /onClick=\{\(\) => close\(true\)\}/);
  assert.match(src, /const go = useCallback[\s\S]*?close\(false\)/);
  assert.doesNotMatch(src, /\bclose\(\)/);
});

// ---- Behaviour: keys pressed in a synthetic page holding the open palette (no browser, no network). ----

const { loadTs } = require("./helpers/load-ts.cjs");
const { DIALOG_FOCUSABLE, trapDialogKeys } = loadTs("components/dialog-keys.ts");

/**
 * A page with a link before and after the palette. The palette holds the search input, two results and a hidden
 * row. `press` runs the document's keydown listeners, then (if no listener prevented it) the browser's own Tab move
 * through the page's visible controls in order, so a missing trap shows up as focus on the page behind.
 */
function page() {
  const listeners = new Set();
  const doc = {
    activeElement: null,
    addEventListener(type, fn) { if (type === "keydown") listeners.add(fn); },
    removeEventListener(type, fn) { if (type === "keydown") listeners.delete(fn); },
  };
  const el = (name, shown = true) => {
    const e = { name, getClientRects: () => ({ length: shown ? 1 : 0 }), focus() { doc.activeElement = e; } };
    return e;
  };
  const before = el("page link before");
  const input = el("search input");
  const resultA = el("result A");
  const hidden = el("hidden row", false);
  const resultB = el("result B");
  const after = el("page link after");
  const inside = [input, resultA, hidden, resultB];
  const order = [before, ...inside, after];
  const dialog = {
    contains: (node) => inside.includes(node),
    querySelectorAll: (sel) => {
      assert.equal(sel, DIALOG_FOCUSABLE);
      return inside;
    },
  };
  function press(key, { shiftKey = false } = {}) {
    const ev = { key, shiftKey, defaultPrevented: false, preventDefault() { ev.defaultPrevented = true; } };
    for (const fn of [...listeners]) fn(ev);
    if (key === "Tab" && !ev.defaultPrevented) {
      const shown = order.filter((x) => x.getClientRects().length > 0);
      const i = shown.indexOf(doc.activeElement);
      doc.activeElement = (shiftKey ? shown[i < 0 ? shown.length - 1 : i - 1] : shown[i + 1]) ?? null;
    }
    return ev;
  }
  return { doc, dialog, press, listeners, before, input, resultA, resultB, after, inside };
}

test("Escape with focus on a result (or the input) calls the close once", () => {
  const p = page();
  let closes = 0;
  trapDialogKeys(p.doc, p.dialog, () => { closes += 1; });
  p.resultB.focus();
  assert.equal(p.press("Escape").defaultPrevented, true);
  assert.equal(closes, 1, "from a result");
  p.input.focus();
  p.press("Escape");
  assert.equal(closes, 2, "from the input");
  p.press("a");
  p.press("ArrowDown");
  assert.equal(closes, 2, "other keys do not close");
});

test("Tab walks the dialog's visible controls and wraps from the last to the first", () => {
  const p = page();
  trapDialogKeys(p.doc, p.dialog, () => {});
  p.input.focus();
  const seen = [];
  for (let i = 0; i < 7; i++) {
    p.press("Tab");
    seen.push(p.doc.activeElement.name);
  }
  assert.deepEqual(seen, ["result A", "result B", "search input", "result A", "result B", "search input", "result A"]);
});

test("Shift+Tab wraps from the first to the last and never reaches the page", () => {
  const p = page();
  trapDialogKeys(p.doc, p.dialog, () => {});
  p.input.focus();
  const seen = [];
  for (let i = 0; i < 4; i++) {
    p.press("Tab", { shiftKey: true });
    seen.push(p.doc.activeElement.name);
  }
  assert.deepEqual(seen, ["result B", "result A", "search input", "result B"]);
});

test("focus outside the dialog is brought to its first control by Tab and Shift+Tab", () => {
  const p = page();
  trapDialogKeys(p.doc, p.dialog, () => {});
  p.before.focus();
  p.press("Tab");
  assert.equal(p.doc.activeElement, p.input);
  p.after.focus();
  p.press("Tab", { shiftKey: true });
  assert.equal(p.doc.activeElement, p.input);
  p.doc.activeElement = null;
  p.press("Tab");
  assert.equal(p.doc.activeElement, p.input, "nothing focused");
});

test("the cleanup removes the listener: keys then reach the page as normal", () => {
  const p = page();
  let closes = 0;
  const cleanup = trapDialogKeys(p.doc, p.dialog, () => { closes += 1; });
  assert.equal(p.listeners.size, 1);
  cleanup();
  assert.equal(p.listeners.size, 0);
  p.resultB.focus();
  assert.equal(p.press("Escape").defaultPrevented, false);
  assert.equal(closes, 0);
  p.press("Tab");
  assert.equal(p.doc.activeElement, p.after, "the browser's own Tab, no trap");
});

// The real CommandPalette, with React's hooks replaced by recorders so its effects can be run by hand.
let hooks;
const React = require("react");
const reactStub = {
  ...React,
  useState: (init) => {
    const i = hooks.stateIndex++;
    if (i === 0) return [hooks.open, (v) => hooks.setOpen.push(v)];
    return [typeof init === "function" ? init() : init, () => {}];
  },
  useRef: (init) => {
    const ref = { current: init };
    hooks.refs.push(ref);
    return ref;
  },
  useEffect: (fn, deps) => { hooks.effects.push({ fn, deps }); },
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
};
const icon = () => null;
const { default: CommandPalette } = loadTs("components/CommandPalette.tsx", {
  react: reactStub,
  "next/navigation": { useRouter: () => ({ push() {} }) },
  "lucide-react": new Proxy({}, { get: () => icon }),
  "@/lib/nav": { NAV_ITEMS: [{ href: "/a", label: "Page A", shortcut: "", icon }, { href: "/b", label: "Page B", shortcut: "", icon }] },
  "@/lib/warmup": { warmRoute() {} },
  "@/lib/go-shortcuts": { createGoShortcuts: () => ({ onKey: () => null }), goHint: (k) => k },
  "./FeedContext": { useActiveRoute: () => "/a" },
  "./personalize/start": { personalizeNow() {} },
});

function render(open) {
  hooks = { open, stateIndex: 0, setOpen: [], refs: [], effects: [] };
  const tree = CommandPalette();
  // The keydown effect is the one keyed on [open, close].
  const modal = hooks.effects.filter((e) => e.deps && e.deps.length === 2 && e.deps[0] === open && typeof e.deps[1] === "function");
  assert.equal(modal.length, 1, "one effect keyed on [open, close]");
  return { tree, runModalEffect: (doc) => withDocument(doc, modal[0].fn) };
}
function withDocument(doc, fn) {
  const prior = globalThis.document;
  globalThis.document = doc;
  try { return fn(); } finally { globalThis.document = prior; }
}
function find(node, pred) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const n of node) { const hit = find(n, pred); if (hit) return hit; }
    return null;
  }
  if (pred(node)) return node;
  return find(node.props?.children, pred);
}

test("the open palette: Escape from a result closes it through close(true), Tab stays inside, cleanup on close", () => {
  const { tree, runModalEffect } = render(true);
  assert.equal(tree.props.role, "dialog");
  const p = page();
  const dialogRef = "ref" in tree.props ? tree.props.ref : tree.ref;
  dialogRef.current = p.dialog;
  const cleanup = runModalEffect(p.doc);
  assert.equal(p.listeners.size, 1, "listening while open");

  p.resultB.focus();
  p.press("Tab");
  assert.equal(p.doc.activeElement, p.input, "Tab from the last result wraps to the input");
  p.press("Tab", { shiftKey: true });
  assert.equal(p.doc.activeElement, p.resultB, "Shift+Tab from the input wraps to the last result");

  p.press("Escape");
  assert.deepEqual(hooks.setOpen, [false], "closed exactly once");
  // close(true) marks the restore (close(false) would leave every flag false): the opener gets focus back.
  assert.equal(hooks.refs.filter((r) => r.current === true).length, 1, "restoreFocus set");

  assert.equal(typeof cleanup, "function");
  cleanup();
  assert.equal(p.listeners.size, 0, "listener removed on close");
});

test("the input's own keys no longer close on Escape (one close per press)", () => {
  const { tree } = render(true);
  const input = find(tree, (n) => n.type === "input");
  assert.ok(input, "search input");
  input.props.onKeyDown({ key: "Escape", preventDefault() {} });
  assert.deepEqual(hooks.setOpen, []);
});

test("the closed palette renders nothing and adds no keydown listener", () => {
  const { tree, runModalEffect } = render(false);
  assert.equal(tree, null);
  const p = page();
  assert.equal(runModalEffect(p.doc), undefined);
  assert.equal(p.listeners.size, 0);
});

test("both visible Search controls carry data-palette-trigger", () => {
  assert.match(read("components/Sidebar.tsx"), /data-palette-trigger=""/);
  assert.match(read("components/MobileNav.tsx"), /data-palette-trigger=""/);
});
