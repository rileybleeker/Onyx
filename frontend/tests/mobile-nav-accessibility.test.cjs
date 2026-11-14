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
function render(drawerOpen = false, logOpen = false) {
  const states = [drawerOpen, logOpen];
  const module = { exports: {} };
  const mockRequire = (id) => {
    if (id === 'react') return { ...React, useState: () => [states.shift(), () => {}], useEffect: () => {}, useRef: () => ({ current: null }) };
    if (id === 'react/jsx-runtime') return require(id);
    if (id === 'next/link') return { default: (props) => React.createElement('a', props) };
    if (id === 'next/navigation') return { usePathname: () => '/today', useRouter: () => ({}) };
    if (id === 'lucide-react') return new Proxy({}, { get: () => () => null });
    if (id === '@/lib/nav') return { NAV_SECTIONS: [{ title: 'Health', items: [{ href: '/health', label: 'Health & appointments', icon: () => null }] }] };
    if (id === '@/lib/supabase-browser') return {};
    if (id === './CommandPalette') return { OPEN_COMMAND_PALETTE: 'open-command-palette' };
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
  assert.deepEqual(links.slice(checkin, checkin + 4), ['/check-in', '/supplements', '/habits', '/nutrition']);
});
test('drawer navigation and search/sign-out have minimum 44px height', () => {
  const html = render(true);
  assert.match(html, /href="\/health"[^>]*class="min-h-11 /);
  assert.match(html, /class="w-full min-h-11 /);
  assert.match(html, /class="min-h-11 [^"]*w-full"/);
});
