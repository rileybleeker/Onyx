// Offline component regression: real route catalog, mocked browser/auth boundaries.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
let pathname = '/today';
const SRC = path.resolve('src');
// Resolve an import the way the app's bundler does: "@/x" is src/x (tsconfig paths), "./x" and "../x" sit next to
// the importing file, as .ts / .tsx source. Anything else is a real node module (react, lucide-react, ...).
function resolveSource(name, from) {
  let base = null;
  if (name.startsWith('@/')) base = path.join(SRC, name.slice(2));
  else if (name.startsWith('./') || name.startsWith('../')) base = path.resolve(path.dirname(from), name);
  if (base === null) return null;
  for (const ext of ['.ts', '.tsx']) if (fs.existsSync(base + ext)) return base + ext;
  return null;
}
// Real source modules (Sidebar's own imports such as ./personalize/PersonalizeButton, @/lib/nav-areas and
// @/lib/personalize-registry) are transpiled and loaded too, once per file like the bundle, so the Sidebar and
// the Personalize button share one registry. Only the mocked browser/auth boundaries are replaced.
function load(file, mocks = {}, cache = new Map()) {
  const filename = path.resolve(file);
  if (cache.has(filename)) return cache.get(filename).exports;
  const mod = new Module(filename, module);
  cache.set(filename, mod);
  mod.paths = module.paths;
  const originalRequire = mod.require.bind(mod);
  mod.require = (name) => {
    if (name in mocks) return mocks[name];
    const source = resolveSource(name, filename);
    return source ? load(source, mocks, cache) : originalRequire(name);
  };
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    // fileName keeps .ts files out of the JSX parser; a modern target keeps for...of over a Set or Map working.
    fileName: path.basename(filename),
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, filename);
  return mod.exports;
}
const nav = load('src/lib/nav.ts');
const Sidebar = load('src/components/Sidebar.tsx', {
  'next/link': ({ children, ...props }) => React.createElement('a', props, children),
  'next/navigation': { usePathname: () => pathname, useRouter: () => ({ push() {} }) },
  '@/lib/nav': nav,
  '@/lib/supabase-browser': { createSupabaseBrowser: () => { throw new Error('No auth access in fixture'); } },
  '@/lib/client-cache': { wipeClientData: async () => {} },
  '@/lib/warmup': { navIntentProps: () => ({}) },
  '@/lib/go-shortcuts': load('src/lib/go-shortcuts.ts'),
  './CommandPalette': { OPEN_COMMAND_PALETTE: 'test-open-palette' },
  // The page in view (components/FeedContext.tsx): the routed page here, as no continuous scroll runs.
  './FeedContext': { useActiveRoute: () => (pathname === '/' ? '/today' : pathname), useRevealActiveNavItem: () => {} },
  './DesktopApp': {
    InstallAppButton: () => React.createElement('button', null, 'Install fixture'),
    ReloadAppButton: () => React.createElement('button', null, 'Reload fixture'),
    usePaletteShortcutLabel: () => 'Ctrl K',
  },
}).default;
const render = () => renderToStaticMarkup(React.createElement(Sidebar));
// Link destinations only: React 19's server render also emits <link rel="preload" href> for the sidebar logo.
// Every page is rendered in Quick access AND in its section (for the pre-paint script); the copy that is not shown
// carries data-off="true" and is display:none, so it is not counted.
const hrefs = (html) => [...html.matchAll(/<a\b[^>]*>/g)].map((m) => m[0])
  .filter((tag) => !/\sdata-off="true"/.test(tag))
  .map((tag) => (tag.match(/\shref="([^"]+)"/) || [])[1])
  .filter(Boolean);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Sidebar's element tree, captured inside a real render so its hooks run in React (calling it bare would not).
function sidebarTree() {
  let tree;
  function Capture() { tree = Sidebar(); return tree; }
  renderToStaticMarkup(React.createElement(Capture));
  return tree;
}
const textOf = (node) => {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node !== 'object') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf(node.props && node.props.children);
};
// The first host element (div, button, ...) in the tree that matches; components are not expanded.
function findHost(node, match) {
  if (node == null || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findHost(child, match);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof node.type === 'string' && match(node)) return node;
  return findHost(node.props && node.props.children, match);
}
test('every catalog destination appears once without removal or duplication', () => {
  assert.deepEqual(hrefs(render()).sort(), nav.NAV_ITEMS.map((item) => item.href).sort());
});
test('Today and Log are pinned outside the scrollable library', () => {
  const html = render();
  const quick = html.match(/<nav aria-label="Quick access"[^>]*>(.*?)<\/nav>/s)[1];
  assert.deepEqual(hrefs(quick), ['/today', '/log']);
  assert.match(html, /aria-label="Quick access" class="shrink-0/);
  assert.match(html, /aria-label="All sections" class="flex-1 min-h-0 [^"]*overflow-y-auto/);
});
test('current page remains correctly marked for every destination', () => {
  for (const item of nav.NAV_ITEMS) {
    pathname = item.href;
    const html = render();
    assert.equal((html.match(/aria-current="page"/g) || []).length, 1);
    // The marker sits on this destination's own link (other attributes, e.g. data-nav-area, may come between).
    assert.match(html, new RegExp(`<a href="${escapeRe(item.href)}"[^>]*\\saria-current="page"`), item.href);
  }
});
test('search uses existing palette event and platform shortcut', () => {
  let received;
  global.window = { dispatchEvent: (event) => { received = event.type; } };
  const search = findHost(sidebarTree(), (el) => el.type === 'button' && textOf(el).includes('Search…'));
  assert.ok(search, 'search button');
  search.props.onClick();
  assert.equal(received, 'test-open-palette');
  assert.ok(render().includes('Ctrl K'));
  delete global.window;
});
test('every item shows its go-to shortcut as "G <key>" (desktop only)', () => {
  const html = render();
  for (const item of nav.NAV_ITEMS) assert.ok(html.includes(`>G ${item.shortcut}</kbd>`), item.label);
  assert.match(html, /<kbd class="[^"]*hidden lg:inline/);
});
test('installed app controls remain present and sidebar remains desktop-only', () => {
  const html = render();
  for (const label of ['Install fixture', 'Reload fixture', 'Sign out']) assert.ok(html.includes(label));
  // The real Personalize button (components/personalize/PersonalizeButton.tsx), not a fixture.
  assert.ok(html.includes('>Personalize</button>'), 'Personalize');
  assert.ok(html.includes('max-md:hidden'));
});
// CI's offline stage has no browser installed. Opt in after installing Playwright:
// RUN_DESKTOP_LAYOUT=1 node --test tests/desktop-navigation.test.cjs
test('real Tailwind layout keeps quick access fixed while library scrolls', { skip: process.env.RUN_DESKTOP_LAYOUT !== '1' ? 'Set RUN_DESKTOP_LAYOUT=1 in a browser-equipped environment' : false }, async () => {
  const postcss = require('postcss');
  const tailwind = require('@tailwindcss/postcss');
  const { chromium } = require('@playwright/test');
  const result = await postcss([tailwind()]).process(fs.readFileSync('src/app/globals.css', 'utf8'), { from: path.resolve('src/app/globals.css') });
  const browser = await chromium.launch({ ...(process.platform === 'win32' ? { channel: 'msedge' } : {}), headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', (route) => route.abort());
    for (const height of [768, 600, 400]) {
      await page.setViewportSize({ width: 1280, height });
      await page.setContent(`<style>${result.css}</style>${render()}`);
      const today = page.locator('a[href="/today"]:not([data-off])');
      const before = await today.boundingBox();
      const library = page.getByRole('navigation', { name: 'All sections', exact: true });
      const libraryBox = await library.boundingBox();
      assert.ok(libraryBox.height > 0, `library has room at ${height}px`);
      await library.evaluate((el) => { el.scrollTop = el.scrollHeight; });
      assert.deepEqual(await today.boundingBox(), before);
      assert.ok(before.y >= 0 && before.y + before.height <= height);
      assert.ok(await library.evaluate((el) => el.scrollTop > 0));
      await today.focus();
      assert.equal(await page.evaluate(() => document.activeElement.getAttribute('href')), '/today');
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.getAttribute('href')), '/log');
    }
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator('aside').isVisible(), false);
  } finally { await browser.close(); }
});
