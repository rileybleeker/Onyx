// Run: node --test tests/install-builds.test.cjs (compiles only the pure variant helper).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const output = mkdtempSync(path.join(tmpdir(), 'onyx-install-builds-'));
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), 'src/lib/install-builds.ts', '--outDir', output, '--module', 'commonjs', '--target', 'ES2022', '--skipLibCheck']);
const { BUILD_VARIANTS, resolveBuildVariant, buildApiUrl } = require(path.join(output, 'install-builds.js'));

test('no variant keeps the original Screen Time build', () => {
  assert.equal(resolveBuildVariant(null), 'default');
  assert.equal(BUILD_VARIANTS.default.path, 'screentime/latest.json');
  assert.equal(buildApiUrl('default'), '/api/screen-time/build');
});

test('variant=focus reads the separate Focus folder', () => {
  assert.equal(resolveBuildVariant('focus'), 'focus');
  assert.equal(BUILD_VARIANTS.focus.path, 'screentime-focus/latest.json');
  assert.equal(buildApiUrl('focus'), '/api/screen-time/build?variant=focus');
  assert.equal(BUILD_VARIANTS.focus.title, 'Onyx with Focus (development build)');
});

test('every other variant value is rejected (400), never a path', () => {
  for (const bad of ['', 'default', 'FOCUS', 'focus ', '../screentime', 'screentime-focus', 'focus/../x']) {
    assert.equal(resolveBuildVariant(bad), null, JSON.stringify(bad));
  }
});

test('the route answers 400 for an unknown variant and reads only the mapped path', () => {
  const route = readFileSync('src/app/api/screen-time/build/route.ts', 'utf8');
  assert.match(route, /resolveBuildVariant\(req\.nextUrl\.searchParams\.get\("variant"\)\)/);
  assert.match(route, /status: 400/);
  assert.match(route, /download\(BUILD_VARIANTS\[variant\]\.path\)/);
});

test('publish_build.py folders match the paths the route reads', () => {
  const publish = readFileSync('../tools/screentime_ios/ci/publish_build.py', 'utf8');
  const workflow = readFileSync('../.github/workflows/focus-ios-signed.yml', 'utf8');
  assert.match(publish, /f"\{folder\}\/latest\.json"/);
  assert.match(publish, /folder = env\.get\("PUBLISH_PREFIX"\) or "screentime"/);
  assert.match(workflow, /PUBLISH_PREFIX: screentime-focus/);
  // both builds' manifests go where the existing manifest route looks
  assert.match(publish, /f"screentime\/manifests\/\{slug\}\.plist"/);
  const manifestRoute = readFileSync('src/app/api/screen-time/manifest/[slug]/route.ts', 'utf8');
  assert.match(manifestRoute, /`screentime\/manifests\/\$\{slug\}\.plist`/);
});
