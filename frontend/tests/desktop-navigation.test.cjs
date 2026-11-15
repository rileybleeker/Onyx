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
function load(file, mocks = {}) {
  const filename = path.resolve(file);
  const mod = new Module(filename, module);
  mod.paths = module.paths;
  const originalRequire = mod.require.bind(mod);
  mod.require = (name) => name in mocks ? mocks[name] : originalRequire(name);
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
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
const hrefs = (html) => [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
test('every catalog destination appears once without removal or duplication', () => {
  assert.deepEqual(hrefs(render()).sort(), nav.NAV_ITEMS.map((item) => item.href).sort());
});
test('Today and Check-in are pinned outside the scrollable library', () => {
  const html = render();
  const quick = html.match(/<nav aria-label="Quick access"[^>]*>(.*?)<\/nav>/s)[1];
  assert.deepEqual(hrefs(quick), ['/today', '/check-in']);
  assert.match(html, /aria-label="Quick access" class="shrink-0/);
  assert.match(html, /aria-label="All sections" class="flex-1 min-h-0 [^"]*overflow-y-auto/);
});
test('current page remains correctly marked for every destination', () => {
  for (const item of nav.NAV_ITEMS) {
    pathname = item.href;
    assert.equal((render().match(/aria-current="page"/g) || []).length, 1);
    assert.ok(render().includes(`href="${item.href}" aria-current="page"`));
  }
});
test('search uses existing palette event and platform shortcut', () => {
  let received;
  global.window = { dispatchEvent: (event) => { received = event.type; } };
  const tree = Sidebar();
  const search = tree.props.children[1].props.children;
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
      const today = page.locator('a[href="/today"]');
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
      assert.equal(await page.evaluate(() => document.activeElement.getAttribute('href')), '/check-in');
    }
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator('aside').isVisible(), false);
  } finally { await browser.close(); }
});
