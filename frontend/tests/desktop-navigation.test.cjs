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
const sidebarModule = load('src/components/Sidebar.tsx', {
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
});
const Sidebar = sidebarModule.default;
// The skip link's target resolver and handler (AppShell renders the link; these live in a shared module).
const skipModule = load('src/lib/skip-to-page.ts');
const render = () => renderToStaticMarkup(React.createElement(Sidebar));
// Link destinations only: React 19's server render also emits <link rel="preload" href> for the sidebar logo.
// Every page is rendered in Quick access AND in its section (for the pre-paint script); the copy that is not shown
// carries data-off="true" and is display:none, so it is not counted.
const hrefs = (html) => [...html.matchAll(/<a\b[^>]*>/g)].map((m) => m[0])
  .filter((tag) => !/\sdata-off="true"/.test(tag))
  .map((tag) => (tag.match(/\shref="([^"]+)"/) || [])[1])
  // Destinations only: the "Skip to page content" link points inside the page (#page-content).
  .filter((href) => Boolean(href) && !href.startsWith('#'));
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
// PROD-T11 (2026-11-16): one h1 per page, and a way past the side panel for the keyboard.
test('the wordmark is not a heading: each page title is the page\'s only h1', () => {
  const html = render();
  assert.ok(html.includes('Onyx</p>'), 'wordmark still shown');
  assert.doesNotMatch(html, /<h[1-6]\b/, 'no heading in the side panel');
});
// The skip link is rendered by AppShell at every width (outside the max-md:hidden side panel), never by Sidebar.
test('"Skip to page content" is not inside the side panel and is rendered once, by AppShell, at every width', () => {
  const html = render();
  assert.equal(html.indexOf('Skip to page content'), -1, 'not rendered by Sidebar');
  const shellSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'AppShell.tsx'), 'utf8');
  const linkSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'SkipToPageLink.tsx'), 'utf8');
  assert.equal(shellSrc.split('<SkipToPageLink />').length - 1, 2, 'one render in each full layout (/agents and the main layout)');
  assert.doesNotMatch(shellSrc, /<SkipToPageLink \/>[\s\S]*<aside/, 'no aside before the link in the main layout');
  assert.match(linkSrc, /sr-only focus:not-sr-only /);
  assert.doesNotMatch(linkSrc, /max-md:hidden|md:hidden|hidden md/, 'the link itself is never hidden below 768 px');
  // The link comes before the side panel in both layouts, so it is the first focusable element.
  const sidebarIdx = shellSrc.indexOf('<Sidebar />');
  const linkIdx = shellSrc.indexOf('<SkipToPageLink />');
  assert.ok(linkIdx > 0 && linkIdx < sidebarIdx, 'the link is rendered before the side panel');
  const sidebarSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'Sidebar.tsx'), 'utf8');
  assert.match(sidebarSrc, /<aside data-side-panel="" className="[^"]*max-md:hidden/, 'the side panel is still hidden below 768 px');
});
test('the skip link targets the opened page title, then the page, then <main>', () => {
  const { pageContentTarget } = skipModule;
  // Synthetic stand-ins for the DOM: the routed page is the scroll root's div child; neighbours are sections.
  const node = (name, kids = {}) => ({ name, querySelector: (sel) => kids[sel] ?? null });
  const heading = node('heading');
  const routed = node('routed', { '[data-testid="page-heading"]': heading });
  const docWith = (map) => ({ querySelector: (sel) => map[sel] ?? null });
  const ROUTED = '[data-feed-root] > div[data-feed-route]';
  assert.equal(pageContentTarget(docWith({ [ROUTED]: routed, main: node('main') })), heading);
  const bare = node('bare');
  assert.equal(pageContentTarget(docWith({ [ROUTED]: bare })), bare, 'a page without a title: the page itself');
  const main = node('main');
  assert.equal(pageContentTarget(docWith({ main })), main, 'no scroll root: <main>');
  // /agents is drawn without <main>: its title, else the screen after the side panel (review round 1).
  const title = node('agents h1');
  const screen = node('agents screen');
  assert.equal(pageContentTarget(docWith({ h1: title, [skipModule.AFTER_SIDE_PANEL]: screen })), title, 'no <main>: the h1');
  assert.equal(pageContentTarget(docWith({ [skipModule.AFTER_SIDE_PANEL]: screen })), screen, 'no title: what follows the side panel');
  assert.equal(pageContentTarget(docWith({ h1: title, main })), main, '<main> first when there is one');
  assert.equal(pageContentTarget(docWith({})), null, 'nothing to skip to');
});
// Review round 2 (2026-11-16): the page in view, not always the routed one, when the continuous scroll has moved on.
test('the skip link targets the page in view of the continuous scroll', () => {
  const { pageContentTarget } = skipModule;
  const page = (route, kids = {}) => ({ route, getAttribute: (a) => (a === 'data-feed-route' ? route : null), querySelector: (sel) => kids[sel] ?? null });
  const TITLE = '[data-testid="page-heading"], [data-testid="feed-page-heading"]';
  const routedTitle = { name: 'routed title' };
  const neighbourTitle = { name: 'neighbour title' };
  const routed = page('/log', { '[data-testid="page-heading"]': routedTitle, [TITLE]: routedTitle });
  const neighbour = page('/nutrition', { [TITLE]: neighbourTitle });
  const loading = page('/habits');
  const docWith = (pages) => ({
    querySelectorAll: (sel) => (sel === '[data-feed-root] > [data-feed-route]' ? pages : []),
    querySelector: (sel) => (sel === '[data-feed-root] > div[data-feed-route]' ? routed : null),
  });
  const doc = docWith([routed, neighbour, loading]);
  assert.equal(pageContentTarget(doc, '/nutrition'), neighbourTitle, 'a neighbour in view: its title');
  assert.equal(pageContentTarget(doc, '/habits'), loading, 'still a skeleton: the page itself');
  assert.equal(pageContentTarget(doc, '/log'), routedTitle, 'the routed page');
  assert.equal(pageContentTarget(doc, '/status'), routedTitle, 'not in the scroll: the routed page');
  assert.equal(pageContentTarget(doc, null), routedTitle, 'no page in view given');
});
test('the skip link never falls through to the browser jump, and the side panel is marked for the fallback', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'skip-to-page.ts'), 'utf8');
  const body = src.slice(src.indexOf('export function skipToPage'));
  assert.ok(body.indexOf('event.preventDefault()') >= 0 && body.indexOf('event.preventDefault()') < body.indexOf('if (!target) return'), 'prevented before the target check');
  // A tabindex the link adds goes again on blur (left in place, a click on the page's text would focus the page).
  const added = body.indexOf('target.setAttribute("tabindex", "-1");');
  const removed = body.indexOf('target.addEventListener("blur", () => target.removeAttribute("tabindex"), { once: true });');
  assert.ok(added > 0 && removed > added && removed < body.indexOf('target.focus('), 'tabindex removed on blur when the link added it');
  const linkSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'SkipToPageLink.tsx'), 'utf8');
  assert.match(linkSrc, /onClick=\{\(e\) => skipToPage\(e, current\)\}/, 'the page in view');
  const sidebarSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'components', 'Sidebar.tsx'), 'utf8');
  assert.match(sidebarSrc, /<aside data-side-panel=""/);
  assert.match(skipModule.AFTER_SIDE_PANEL, /^\[data-side-panel\] ~ /);
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
