// Synthetic render contract. No network, authentication, or production data.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const source = fs.readFileSync(path.join(__dirname, '../src/components/MobileNav.tsx'), 'utf8');
const tabsJs = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/lib/mobile-tabs.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const mobileTabs = { exports: {} };
vm.runInNewContext(tabsJs, { module: mobileTabs, exports: mobileTabs.exports });
// Personalize (#235, #240): the real saved-order module (no storage here = default order).
const navAreasJs = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/lib/nav-areas.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const navAreas = { exports: {} };
vm.runInNewContext(navAreasJs, { module: navAreas, exports: navAreas.exports });
const icon = () => null;
const NAV = [
  { title: 'Home', items: [{ href: '/today', label: 'Today', icon }] },
  { title: 'Health', items: [{ href: '/health', label: 'Health & appointments', icon }] },
  { title: 'Tools', items: [{ href: '/analytics/hrv', label: 'HRV Analysis', icon }, { href: '/agents', label: 'Agents', icon }, { href: '/chat', label: 'Onyx Chat', icon }] },
];
function render(drawerOpen = false, logOpen = false, unread = 0, pathname = '/today') {
  const states = [drawerOpen, logOpen, unread];
  const module = { exports: {} };
  const mockRequire = (id) => {
    if (id === 'react') return { ...React, useState: () => [states.shift(), () => {}], useEffect: () => {}, useRef: () => ({ current: null }) };
    if (id === 'react/jsx-runtime') return require(id);
    if (id === 'next/link') return { default: (props) => React.createElement('a', props) };
    if (id === 'next/navigation') return { usePathname: () => pathname, useRouter: () => ({}) };
    if (id === 'lucide-react') return new Proxy({}, { get: () => () => null });
    if (id === '@/lib/nav') return { NAV_SECTIONS: NAV };
    if (id === '@/lib/supabase-browser') return {};
    if (id === '@/lib/client-cache') return { wipeClientData: async () => {}, CACHE_KEYS: { agentsInbox: 'agents:inbox' }, clientCache: { peek: () => undefined, read: async () => undefined, subscribe: () => () => {} } };
    if (id === '@/lib/agents-api') return { AGENTS_BADGE_EVENT: 'onyx:agents-badge', lastAgentsBadge: () => null };
    if (id === '@/lib/mobile-tabs') return mobileTabs.exports;
    if (id === '@/lib/warmup') return { navIntentProps: () => ({}) };
    if (id === './CommandPalette') return { OPEN_COMMAND_PALETTE: 'open-command-palette' };
    if (id === './FeedContext') return { useActiveRoute: () => (pathname === '/' ? '/today' : pathname) };
    if (id === './personalize/PersonalizeButton') return { __esModule: true, default: (props) => React.createElement('button', props, 'Personalize') };
    if (id === '@/lib/nav-areas') return navAreas.exports;
    if (id === '@/lib/personalize-registry') return { currentEditingKey: () => null, editorRef: () => null, subscribeTargets: () => () => {} };
    throw new Error(`Unexpected dependency: ${id}`);
  };
  const js = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  vm.runInNewContext(js, { module, exports: module.exports, require: mockRequire });
  return renderToStaticMarkup(React.createElement(module.exports.default));
}
function button(html, label) {
  const found = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(m => m[0]).find(s => s.includes(`aria-label="${label}"`));
  assert.ok(found, label);
  return found;
}
test('mobile search and dismiss buttons expose 44px targets and descriptive names', () => {
  for (const [html, label] of [[render(), 'Search'], [render(false, true), 'Close quick log'], [render(true), 'Close navigation']]) {
    const markup = button(html, label);
    assert.match(markup, /\bw-11\b/);
    assert.match(markup, /\bh-11\b/);
  }
});
test('openers announce dialogs and reference only mounted panels', () => {
  assert.doesNotMatch(render(), /aria-controls=/);
  for (const [html, id] of [[render(false, true), 'mobile-quick-log'], [render(true), 'mobile-navigation']]) {
    assert.ok(html.includes(`aria-controls="${id}"`));
    assert.ok(html.includes(`id="${id}"`));
    assert.match(html, /aria-expanded="true" aria-haspopup="dialog"/);
  }
});
test('all quick capture destinations remain available and check-in remains first', () => {
  const html = render(false, true);
  const links = [...html.matchAll(/href="([^"]+)"/g)].map(m => m[1]);
  const checkin = links.indexOf('/check-in');
  assert.deepEqual(links.slice(checkin, checkin + 4), ['/check-in', '/supplements', '/habits', '/nutrition?log=weight']);
});
test('drawer navigation and search/sign-out have minimum 44px height', () => {
  const html = render(true);
  assert.match(html, /href="\/health"[^>]*class="min-h-11 /);
  assert.match(html, /class="w-full min-h-11 /);
  assert.match(html, /class="min-h-11 [^"]*w-full"/);
});

function tabBar(html) {
  const bar = html.match(/<nav data-testid="mobile-tab-bar"[\s\S]*?<\/nav>/)[0];
  return [...bar.matchAll(/<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>/g)].map((m) => ({
    tag: m[1], href: (m[2].match(/href="([^"]+)"/) || [])[1] || null, current: /aria-current="page"/.test(m[2]),
    label: [...m[3].matchAll(/<span>([^<]+)<\/span>/g)].map((x) => x[1]).pop(),
    text: m[3].replace(/<[^>]+>/g, ''),
  }));
}
test('bottom bar: Today, Agents, Log (centre), Chat, More; every label is where it goes', () => {
  const tabs = tabBar(render());
  assert.deepEqual(tabs.map((t) => t.label), ['Today', 'Agents', 'Log', 'Chat', 'More']);
  assert.deepEqual(tabs.map((t) => t.href), ['/today', '/agents', null, '/chat', null]);
  assert.ok(!tabs.some((t) => t.label === 'Trends'), 'Trends lives in More and on Today');
  const log = render().match(/<button[^>]*>(?:(?!<\/button>)[\s\S])*?<span>Log<\/span><\/button>/)[0];
  assert.match(log, /bg-accent/, 'Log is the visually primary action');
});
test('bottom bar: the active tab follows the page, and Agents carries the unread count', () => {
  for (const [path, label] of [['/today', 'Today'], ['/', 'Today'], ['/agents', 'Agents'], ['/agents?t=devops', 'Agents'], ['/chat', 'Chat']]) {
    const current = tabBar(render(false, false, 0, path.split('?')[0])).filter((t) => t.current).map((t) => t.label);
    assert.deepEqual(current, [label], path);
  }
  assert.deepEqual(tabBar(render(false, false, 0, '/sleep')).filter((t) => t.current), []);
  const agents = tabBar(render(false, false, 3)).find((t) => t.href === '/agents');
  assert.match(agents.text, /3/);
  assert.match(agents.text, /3 unread/);
  assert.ok(!/unread/.test(tabBar(render()).find((t) => t.href === '/agents').text), 'no badge at zero');
  assert.match(tabBar(render(false, false, 12)).find((t) => t.href === '/agents').text, /9\+/);
});
test('bottom bar keeps 44px-plus targets and the safe-area padding', () => {
  const html = render();
  assert.match(html, /data-testid="mobile-tab-bar"[^>]*pb-\[env\(safe-area-inset-bottom\)\]/);
  assert.match(html, /grid grid-cols-5 h-14/);
});
