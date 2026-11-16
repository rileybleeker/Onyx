// PROD-T11 (2026-11-16): keyboard focus around the Personalize banner. Synthetic stand-ins only: no network,
// authentication or production data. Run: node --test tests/personalize-banner-focus.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const SRC = path.join(__dirname, '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');
function loadTs(rel) {
  const js = ts.transpileModule(read(rel), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(js, { module: mod, exports: mod.exports });
  return mod.exports;
}
const focus = loadTs('components/personalize/banner-focus.ts');

/** A control stand-in: connected, shown, enabled and outside any inert subtree unless told otherwise. */
function control(name, { connected = true, disabled = false, inert = false, rects = 1 } = {}) {
  const el = {
    name,
    focused: 0,
    isConnected: connected,
    disabled,
    focus() { el.focused += 1; },
    closest: (sel) => (inert && /\[inert\]/.test(sel) ? {} : null),
    getClientRects: () => ({ length: rects }),
  };
  return el;
}

test('a control can take focus only when it is in the page, shown, enabled and not inert', () => {
  assert.equal(focus.canTakeFocus(control('ok')), true);
  assert.equal(focus.canTakeFocus(control('gone', { connected: false })), false, 'removed from the page');
  assert.equal(focus.canTakeFocus(control('off', { disabled: true })), false, 'disabled (Personalize while it runs)');
  assert.equal(focus.canTakeFocus(control('drawer', { inert: true })), false, 'inside the closed phone drawer');
  assert.equal(focus.canTakeFocus(control('hidden', { rects: 0 })), false, 'display: none');
  for (const v of [null, undefined, 0, 'button', {}]) assert.equal(focus.canTakeFocus(v), false, String(v));
});

test('closing the banner gives focus back to the opener first, else to what had focus when it opened', () => {
  const opener = control('sidebar Personalize');
  const before = control('More tab');
  assert.equal(focus.returnFocusTarget([opener, before]), opener, 'desktop: the Personalize button');
  const drawerButton = control('drawer Personalize', { inert: true });
  assert.equal(focus.returnFocusTarget([drawerButton, before]), before, 'phone: the drawer is closed, so the More tab');
  const palette = control('palette input', { connected: false });
  assert.equal(focus.returnFocusTarget([palette, null]), null, 'command palette gone and nothing before: leave focus alone');
  assert.equal(focus.returnFocusTarget([]), null);
});

test('the banner host is inserted as the first child of <body>', () => {
  const calls = [];
  const host = { attrs: {}, setAttribute(k, v) { host.attrs[k] = v; } };
  const doc = { createElement: (tag) => { calls.push(['create', tag]); return host; }, body: { prepend: (el) => calls.push(['prepend', el]) } };
  assert.equal(focus.createBannerHost(doc), host);
  assert.deepEqual(calls, [['create', 'div'], ['prepend', host]], 'prepend, not append: first in the Tab order');
  assert.equal(host.attrs[focus.BANNER_HOST_ATTR], '');
});

test('the banner is drawn in that host, takes focus, and publishes its height on <html>', () => {
  const editor = read('components/personalize/PersonalizeEditor.tsx');
  const banner = editor.slice(editor.indexOf('export function Banner()'), editor.indexOf('// ---- tables'));
  assert.ok(banner.length > 0, 'Banner found');
  assert.match(banner, /createBannerHost\(document\)/);
  assert.match(banner, /createPortal\([\s\S]*\n\s*host,\n\s*\);/, 'portal target is the host, not document.body');
  assert.doesNotMatch(banner, /document\.body,\n\s*\);/);
  assert.match(banner, /role="region"[^>]*tabIndex=\{-1\}/, 'the region can take focus');
  assert.match(banner, /openingFocusTarget\(document, el\)\?\.focus\(\{ preventScroll: true \}\)/, 'never focused past an open modal');
  assert.doesNotMatch(banner, /\bel\.focus\(/, 'no unconditional focus');
  assert.match(banner, /returnFocusTarget\(candidates\)/);
  assert.match(banner, /document\.documentElement[\s\S]*setProperty\("--pz-banner-h"/, 'height on <html> for scroll padding');
});

test('Personalize remembers the control that started it before the session disables it', () => {
  const start = read('components/personalize/start.ts');
  const body = start.slice(start.indexOf('export function personalizeNow'));
  assert.ok(body.indexOf('opener =') > 0 && body.indexOf('opener =') < body.indexOf('startPersonalize()'), 'opener read first');
  assert.match(start, /export function personalizeOpener\(\)/);
});

// Review round 1 (2026-11-16): Tailwind 4's outline-none sets --tw-outline-style: none on the element, and
// focus-visible:outline-2 draws with that variable, so without an explicit style the banner showed no focus ring.
test('the banner region shows a focus ring when it takes focus', () => {
  const editor = read('components/personalize/PersonalizeEditor.tsx');
  const banner = editor.slice(editor.indexOf('export function Banner()'), editor.indexOf('// ---- tables'));
  const cls = banner.match(/role="region"[^>]*className="([^"]+)"/);
  assert.ok(cls, 'region class');
  assert.match(cls[1], /\bfocus-visible:outline-accent\b/);
  if (/\boutline-(?:none|hidden)\b/.test(cls[1])) {
    assert.match(cls[1], /\bfocus-visible:outline-(?:solid|dashed|dotted|double)\b/, 'outline-none needs a focus-visible outline style');
  }
});

/** A dialog stand-in: `inside` lists what it contains, `kids` answers its querySelector. */
function dialog(inside, kids = {}) {
  return { contains: (n) => inside.includes(n), querySelector: (sel) => kids[sel] ?? null };
}
const docWith = (modal, activeElement, body = { name: 'body' }) => ({
  querySelector: (sel) => (sel === focus.MODAL_DIALOG ? modal : null),
  activeElement,
  body,
});
const ARRANGER_BUTTON = `[${focus.ARRANGER_ATTR}] button:not([disabled])`;
const FIRST_CONTROL = 'button:not([disabled]), a[href]';

test('opening: the banner takes focus when no modal dialog is open (or it is inside it)', () => {
  const banner = control('banner');
  const body = { name: 'body' };
  assert.equal(focus.openingFocusTarget(docWith(null, body, body), banner), banner, 'desktop: focus to the banner');
  assert.equal(focus.openingFocusTarget(docWith(dialog([banner]), body, body), banner), banner, 'a dialog holding the banner');
  assert.equal(focus.openingFocusTarget(docWith(null, body, body), control('hidden banner', { rects: 0 })), null, 'not shown: leave focus alone');
});

test('opening: the phone drawer left open by a side-panel session keeps focus inside it', () => {
  const body = { name: 'body' };
  const banner = control('banner');
  const cancel = control('arranger Cancel');
  const close = control('Close navigation');
  const kids = { [ARRANGER_BUTTON]: cancel, [FIRST_CONTROL]: close };
  // The disabled Personalize button dropped focus on <body>: the arranger's first control, never the banner.
  assert.equal(focus.openingFocusTarget(docWith(dialog([cancel, close], kids), body, body), banner), cancel);
  assert.equal(banner.focused, 0);
  // Focus still on a control in the drawer: left where it is.
  assert.equal(focus.openingFocusTarget(docWith(dialog([cancel, close], kids), close, body), banner), null);
  // Firefox keeps a disabled button as the active element: moved to the arranger.
  const off = control('drawer Personalize', { disabled: true });
  assert.equal(focus.openingFocusTarget(docWith(dialog([off, cancel, close], kids), off, body), banner), cancel);
  // No arranger drawn yet: the dialog's first control.
  assert.equal(focus.openingFocusTarget(docWith(dialog([close], { [FIRST_CONTROL]: close }), body, body), banner), close);
});

test('the drawer arranger carries the attribute the banner looks for', () => {
  const nav = read('components/personalize/NavArranger.tsx');
  const drawer = nav.slice(nav.indexOf('export function DrawerArranger()'));
  assert.match(drawer, new RegExp(`<div ${focus.ARRANGER_ATTR}=""`));
  assert.equal(focus.MODAL_DIALOG, '[role="dialog"][aria-modal="true"]');
  const mobile = read('components/MobileNav.tsx');
  assert.match(mobile, /role=\{drawerOpen \? "dialog" : undefined\}/);
  assert.match(mobile, /aria-modal=\{drawerOpen \? true : undefined\}/);
});
