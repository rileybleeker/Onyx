// The command palette's keyboard focus (synthetic, no network, no browser). Escape and an outside click hand focus
// back to the opener or the visible Search control; a page or Personalize choice does not. While open, the palette is
// a modal: keys are pressed in a stand-in page to check Escape from a result, Tab / Shift+Tab wrap and the cleanup.
// The stand-in dialog evaluates DIALOG_FOCUSABLE against its elements' tags and attributes (disabled, hidden, bare
// anchor, tabindex -1 included), and a narrowed copy of the selector is shown to break the Tab walk.
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
 * The fixture's own selector engine: comma-separated alternatives of an optional tag followed by `[attr]`,
 * `[attr="value"]` and `:not([...])` parts, matched against each fixture element's tag and attributes. Anything else
 * throws, so a selector the engine cannot read fails loudly instead of matching everything.
 */
function compileSelector(selector) {
  const parseAttr = (text) => {
    const m = /^\[([a-z-]+)(?:="([^"]*)")?\]$/.exec(text);
    if (!m) throw new Error(`fixture selector engine cannot read ${text}`);
    return { name: m[1], value: m[2] };
  };
  const alternatives = String(selector).split(",").map((part) => {
    const s = part.trim();
    const m = /^([a-z]*)((?:\[[^\]]*\]|:not\(\[[^\]]*\]\))*)$/.exec(s);
    if (!s || !m) throw new Error(`fixture selector engine cannot read "${s}"`);
    const conds = (m[2].match(/:not\(\[[^\]]*\]\)|\[[^\]]*\]/g) ?? []).map((c) => {
      const negate = c.startsWith(":not(");
      return { negate, ...parseAttr(negate ? c.slice(5, -1) : c) };
    });
    return { tag: m[1], conds };
  });
  return (e) =>
    alternatives.some(({ tag, conds }) =>
      (!tag || e.tag === tag) &&
      conds.every(({ negate, name, value }) => {
        const has = Object.prototype.hasOwnProperty.call(e.attrs, name) && (value === undefined || e.attrs[name] === value);
        return negate ? !has : has;
      }));
}

/** What the browser's own Tab reaches, decided from attributes alone (independent of DIALOG_FOCUSABLE). */
const browserTabbable = (e) =>
  e.shown &&
  !Object.prototype.hasOwnProperty.call(e.attrs, "disabled") &&
  (e.tag === "input" || e.tag === "button" || (e.tag === "a" && "href" in e.attrs) || e.attrs.tabindex === "0");

/**
 * A page with a link before and after the palette. The palette holds, in document order: the search input, an ESC
 * hint, result A, a hidden row, result B, an anchor without href, a help link, a tabindex="-1" row, a tabindex="0"
 * custom row and a trailing disabled row. The dialog's querySelectorAll really evaluates the selector it is given against those
 * tags and attributes. `press` runs the document's keydown listeners, then (if no listener prevented it) the browser's
 * own Tab move through the page's tabbable controls in order, so a missing trap shows up as focus on the page behind.
 */
function page() {
  const listeners = new Set();
  const doc = {
    activeElement: null,
    addEventListener(type, fn) { if (type === "keydown") listeners.add(fn); },
    removeEventListener(type, fn) { if (type === "keydown") listeners.delete(fn); },
  };
  const el = (name, tag, attrs = {}, shown = true) => {
    const e = { name, tag, attrs, shown, getClientRects: () => ({ length: e.shown ? 1 : 0 }), focus() { doc.activeElement = e; } };
    return e;
  };
  const before = el("page link before", "a", { href: "/before" });
  const input = el("search input", "input", { "aria-label": "Search pages" });
  const escHint = el("ESC hint", "kbd");
  const resultA = el("result A", "button", { type: "button" });
  const disabledRow = el("disabled row", "button", { type: "button", disabled: "" });
  const hidden = el("hidden row", "button", { type: "button" }, false);
  const resultB = el("result B", "button", { type: "button" });
  const bareAnchor = el("anchor without href", "a");
  const helpLink = el("help link", "a", { href: "/help" });
  const minusOne = el("tabindex -1 row", "li", { tabindex: "-1" });
  const customRow = el("custom row", "div", { tabindex: "0" });
  const after = el("page link after", "a", { href: "/after" });
  const inside = [input, escHint, resultA, hidden, resultB, bareAnchor, helpLink, minusOne, customRow, disabledRow];
  const order = [before, ...inside, after];
  const dialog = {
    contains: (node) => inside.includes(node),
    querySelectorAll: (sel) => inside.filter(compileSelector(sel)),
  };
  function press(key, { shiftKey = false } = {}) {
    const ev = { key, shiftKey, defaultPrevented: false, preventDefault() { ev.defaultPrevented = true; } };
    for (const fn of [...listeners]) fn(ev);
    if (key === "Tab" && !ev.defaultPrevented) {
      const tabbable = order.filter(browserTabbable);
      const i = tabbable.indexOf(doc.activeElement);
      doc.activeElement = (shiftKey ? tabbable[i < 0 ? tabbable.length - 1 : i - 1] : tabbable[i + 1]) ?? null;
    }
    return ev;
  }
  return { doc, dialog, press, listeners, before, input, resultA, resultB, helpLink, customRow, after, inside, last: customRow };
}

const names = (els) => Array.from(els, (e) => e.name);

/** Seven Tab presses from the input, with `trap` (a trapDialogKeys) installed on a fresh page. */
function tabWalk(trap) {
  const p = page();
  trap(p.doc, p.dialog, () => {});
  p.input.focus();
  const seen = [];
  for (let i = 0; i < 7; i++) {
    p.press("Tab");
    seen.push(p.doc.activeElement && p.doc.activeElement.name);
  }
  return seen;
}
const TAB_WALK = ["result A", "result B", "help link", "custom row", "search input", "result A", "result B"];

test("the fixture evaluates selectors against its elements' tags and attributes", () => {
  const { dialog } = page();
  assert.deepEqual(names(dialog.querySelectorAll(DIALOG_FOCUSABLE)),
    ["search input", "result A", "hidden row", "result B", "help link", "custom row"],
    "the real selector skips the disabled row, the bare anchor, tabindex -1 and the ESC hint");
  assert.deepEqual(names(dialog.querySelectorAll("input")), ["search input"]);
  assert.deepEqual(names(dialog.querySelectorAll("button")), ["result A", "hidden row", "result B", "disabled row"]);
  assert.deepEqual(names(dialog.querySelectorAll("a[href]")), ["help link"]);
  assert.deepEqual(names(dialog.querySelectorAll('[tabindex="0"]')), ["custom row"]);
  assert.throws(() => dialog.querySelectorAll("button:focus-visible"), /cannot read/);
});

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

test("Tab walks the dialog's visible, enabled controls and wraps from the last to the first", () => {
  assert.deepEqual(tabWalk(trapDialogKeys), TAB_WALK);
});

// dialog-keys.ts re-transpiled in memory with DIALOG_FOCUSABLE replaced, to show the Tab walk depends on the selector.
const ts = require("typescript");
function dialogKeysWith(selector) {
  const src = read("components/dialog-keys.ts");
  const decl = /export const DIALOG_FOCUSABLE = '[^']*';/;
  assert.match(src, decl);
  const { outputText } = ts.transpileModule(src.replace(decl, `export const DIALOG_FOCUSABLE = ${JSON.stringify(selector)};`), {
    fileName: "dialog-keys.ts",
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const mod = { exports: {} };
  new Function("exports", "require", "module", outputText)(mod.exports, require, mod);
  return mod.exports;
}

test("the Tab walk fails when DIALOG_FOCUSABLE is narrowed or loses :not([disabled])", () => {
  const real = dialogKeysWith(DIALOG_FOCUSABLE);
  assert.equal(real.DIALOG_FOCUSABLE, DIALOG_FOCUSABLE);
  assert.deepEqual(tabWalk(real.trapDialogKeys), TAB_WALK, "the real selector passes");
  for (const narrowed of [
    "input",
    "button:not([disabled]), input:not([disabled])",
    // Without :not([disabled]) the trailing disabled row becomes "last", so Tab from the custom row escapes the trap.
    'a[href], button, input, [tabindex="0"]',
  ]) {
    assert.notDeepEqual(tabWalk(dialogKeysWith(narrowed).trapDialogKeys), TAB_WALK, `caught: ${narrowed}`);
  }
});

test("Shift+Tab wraps from the first to the last and never reaches the page", () => {
  const p = page();
  trapDialogKeys(p.doc, p.dialog, () => {});
  p.input.focus();
  const seen = [];
  for (let i = 0; i < 6; i++) {
    p.press("Tab", { shiftKey: true });
    seen.push(p.doc.activeElement.name);
  }
  assert.deepEqual(seen, ["custom row", "help link", "result B", "result A", "search input", "custom row"]);
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
  p.customRow.focus();
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

// Recorded hooks only: this runs the keydown effect and its returned cleanup by hand. It is not React unmount or
// focus-restore coverage (no React render, unmount or focus move happens here).
test("the open palette's keydown effect: Escape calls close(true), Tab stays inside, the returned cleanup removes it", () => {
  const { tree, runModalEffect } = render(true);
  assert.equal(tree.props.role, "dialog");
  const p = page();
  const dialogRef = "ref" in tree.props ? tree.props.ref : tree.ref;
  dialogRef.current = p.dialog;
  const cleanup = runModalEffect(p.doc);
  assert.equal(p.listeners.size, 1, "listening while open");

  p.last.focus();
  p.press("Tab");
  assert.equal(p.doc.activeElement, p.input, "Tab from the last enabled control wraps to the input");
  p.press("Tab", { shiftKey: true });
  assert.equal(p.doc.activeElement, p.last, "Shift+Tab from the input wraps to the last enabled control");

  p.resultB.focus();
  p.press("Escape");
  assert.deepEqual(hooks.setOpen, [false], "closed exactly once");
  // close(true) sets one ref flag (close(false) would leave every flag false). The focus move itself is not run here.
  assert.equal(hooks.refs.filter((r) => r.current === true).length, 1, "restoreFocus set");

  assert.equal(typeof cleanup, "function");
  cleanup();
  assert.equal(p.listeners.size, 0, "the effect's cleanup removes the listener");
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
