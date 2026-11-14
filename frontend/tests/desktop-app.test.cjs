// Run: node --test tests/desktop-app.test.cjs (offline; compiles only the pure helper).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { existsSync, mkdtempSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const output = mkdtempSync(path.join(tmpdir(), 'onyx-desktop-app-'));
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), 'src/lib/desktop-app.ts', '--outDir', output, '--module', 'commonjs', '--target', 'ES2022', '--skipLibCheck']);
const { START_URL, launchTarget, paletteShortcutLabel } = require(path.join(output, 'desktop-app.js'));

const manifest = JSON.parse(readFileSync('public/manifest.json', 'utf8'));
const ORIGIN = 'https://onyx.example';

test('manifest keeps the app identity and is installable', () => {
  // id + start_url "/" = the identity existing installs already have; changing either makes a second app.
  assert.equal(manifest.id, '/');
  assert.equal(manifest.start_url, START_URL);
  assert.equal(manifest.scope, '/');
  assert.equal(manifest.display, 'standalone');
  assert.ok(manifest.name && manifest.short_name);
  for (const size of ['192x192', '512x512']) {
    const icon = manifest.icons.find((i) => i.sizes === size && !i.purpose);
    assert.ok(icon, `icon ${size}`);
    assert.ok(existsSync(path.join('public', icon.src)), icon.src);
  }
});

test('title bar color matches the page background', () => {
  const css = readFileSync('src/app/globals.css', 'utf8');
  const surface = css.match(/--color-surface:\s*(#[0-9A-Fa-f]{6})/)[1];
  assert.equal(manifest.theme_color.toLowerCase(), surface.toLowerCase());
  assert.equal(manifest.background_color.toLowerCase(), surface.toLowerCase());
  assert.match(readFileSync('src/app/layout.tsx', 'utf8'), new RegExp(`themeColor: "${surface}"`, 'i'));
});

test('a launch focuses the open window instead of opening a second one', () => {
  assert.equal(manifest.launch_handler.client_mode[0], 'focus-existing');
});

test('every jump-list shortcut is a real nav route', () => {
  const nav = readFileSync('src/lib/nav.ts', 'utf8');
  assert.ok(manifest.shortcuts.length >= 1 && manifest.shortcuts.length <= 10);
  for (const s of manifest.shortcuts) {
    assert.ok(s.name, 'shortcut name');
    assert.ok(nav.includes(`href: "${s.url}"`), `${s.url} is in NAV_SECTIONS`);
    assert.notEqual(s.url, START_URL, 'a shortcut on the start URL would be read as a plain launch');
    for (const icon of s.icons || []) assert.ok(existsSync(path.join('public', icon.src)), icon.src);
  }
});

test('plain launch keeps the page you had open', () => {
  assert.equal(launchTarget(`${ORIGIN}/`, ORIGIN, '/nutrition'), null);
});

test('a shortcut navigates the open window', () => {
  assert.equal(launchTarget(`${ORIGIN}/agents`, ORIGIN, '/nutrition'), '/agents');
  assert.equal(launchTarget(`${ORIGIN}/today`, ORIGIN, '/status'), '/today');
  assert.equal(launchTarget(`${ORIGIN}/check-in?date=2026-11-13`, ORIGIN, '/today'), '/check-in?date=2026-11-13');
});

test('already on that page, another origin or a bad URL does nothing', () => {
  assert.equal(launchTarget(`${ORIGIN}/agents`, ORIGIN, '/agents'), null);
  assert.equal(launchTarget('https://evil.example/agents', ORIGIN, '/today'), null);
  assert.equal(launchTarget('not a url', ORIGIN, '/today'), null);
  assert.equal(launchTarget(undefined, ORIGIN, '/today'), null);
  assert.equal(launchTarget('', ORIGIN, '/today'), null);
});

test('palette hint: Ctrl K on Windows, ⌘K on Apple', () => {
  assert.equal(paletteShortcutLabel('Win32', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'), 'Ctrl K');
  assert.equal(paletteShortcutLabel('MacIntel', ''), '⌘K');
  assert.equal(paletteShortcutLabel('', 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)'), '⌘K');
  assert.equal(paletteShortcutLabel('Linux x86_64', ''), 'Ctrl K');
});
