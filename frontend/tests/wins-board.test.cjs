// Run from frontend: node --test tests/wins-board.test.cjs
// Optional real-CSS, offline Chromium checks: RUN_WINS_LAYOUT=1 node --test tests/wins-board.test.cjs
// Compiles the real Tailwind CSS directly; WINS_TEST_CSS can supply a compiled stylesheet.
// Optional WINS_SCREENSHOT_DIR saves synthetic phone and desktop previews locally.
// Only invented fixtures are rendered. No app server, auth, GitHub or personal data is accessed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { loadTs, SRC } = require('./helpers/load-ts.cjs');

const { labels, stageNotes, stageOrder } = loadTs('lib/wins.ts');
const win = (state, index, surface = 'site') => ({
  pr: 9000 + index,
  surface,
  state,
  area: `Synthetic area ${index}`,
  title: `Synthetic improvement ${index}: keeping every detail within reach`,
  summary: `Synthetic summary ${index}. A longer description preserves the change and its limits while wrapping on a narrow phone screen.`,
  benefit: `Synthetic benefit ${index}. The reason this matters stays visible beside or below the description without being collapsed.`,
  mergedAt: ['deployed', 'merged'].includes(state) ? '2030-01-11T06:28:08.000Z' : null,
});
const mixed = {
  checkedAt: '2030-01-12T14:05:00.000Z',
  wins: [...stageOrder.map((state, i) => win(state, i)), win('merged', 6, 'behind')],
};
const allUnknown = { checkedAt: null, wins: [win('unknown', 7), win('unknown', 8)] };
const filterStates = { All: stageOrder, Delivered: ['deployed', 'merged'], 'In progress': ['review', 'draft'] };
const linkStub = ({ children, ...props }) => React.createElement('a', props, children);
const plain = (html) => html.replace(/<[^>]*>/g, '').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');

function render(board = mixed, filter = 'All') {
  const Board = loadTs('app/wins/WinsBoard.tsx', {
    'next/link': linkStub,
    react: { ...React, useState: () => [filter, () => {}] },
  }).default;
  return renderToStaticMarkup(React.createElement(Board, { board }));
}

test('all six stages remain distinct and every original detail has an evidence link', () => {
  const html = render();
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  assert.equal((html.match(/<article\b/g) || []).length, mixed.wins.length);
  const headings = [...html.matchAll(/<h2\b[^>]*id="stage-([^"]+)"[^>]*>(.*?)<\/h2>/gs)];
  assert.deepEqual(headings.map((match) => match[1]), stageOrder);
  for (const [state, heading] of headings.map((match) => [match[1], plain(match[2])])) {
    assert.ok(heading.includes(labels[state]), `stage label: ${state}`);
    assert.ok(heading.includes(`(${mixed.wins.filter((item) => item.state === state).length})`), `stage count: ${state}`);
    assert.ok(plain(html).includes(stageNotes[state]), `stage explanation: ${state}`);
  }
  for (const item of mixed.wins) {
    const article = [...html.matchAll(/<article\b[^>]*>(.*?)<\/article>/gs)].find((match) => match[1].includes(`win-${item.pr}`));
    assert.ok(article, `labelled article for PR ${item.pr}`);
    assert.ok(article[0].includes(`aria-labelledby="win-${item.pr}"`));
    for (const field of ['area', 'title', 'summary', 'benefit']) assert.ok(plain(article[0]).includes(item[field]), `${item.pr}: ${field}`);
    assert.ok(article[0].includes(`href="https://github.com/rileybleeker/Onyx/pull/${item.pr}"`));
    assert.match(article[0], /target="_blank"/);
    assert.match(article[0], /rel="noopener noreferrer"/);
    assert.ok(plain(article[0]).includes('(opens in a new tab)'));
    if (item.mergedAt) assert.ok(plain(article[0]).includes('Merged 2030-01-11 (UTC).'));
    else assert.ok(plain(article[0]).includes('Intended change (not verified as merged)'));
  }
  const text = plain(html);
  for (const note of [
    'A production deployment made after this merge is recorded as successful.',
    'Not confirmed live on the site yet.',
    'Behind the scenes: no website deployment to confirm.',
    'Selected highlights, not a complete activity log.',
    'Status is a cached snapshot and may be older than five minutes.',
    'Source checked: 2030-01-12 14:05 UTC.',
  ]) assert.ok(text.includes(note), note);
  for (const route of ['/today', '/agents']) assert.ok(html.includes(`href="${route}"`));
});

test('filters never mix unfinished or unverifiable work with delivered highlights', () => {
  for (const [filter, states] of Object.entries(filterStates)) {
    const html = render(mixed, filter);
    const expected = mixed.wins.filter((item) => states.includes(item.state));
    assert.equal((html.match(/<article\b/g) || []).length, expected.length, filter);
    for (const item of mixed.wins) assert.equal(html.includes(`id="win-${item.pr}"`), expected.includes(item), `${filter}: ${item.state}`);
    const pressed = [...html.matchAll(/<button\b[^>]*aria-pressed="true"[^>]*>(.*?)<\/button>/gs)];
    assert.equal(pressed.length, 1);
    assert.ok(plain(pressed[0][1]).includes(filter));
    assert.ok(plain(html).includes(`Showing ${expected.length} of ${mixed.wins.length} highlights.`));
    // Source failures stay visible even while their cards are filtered out.
    assert.ok(plain(html).includes('Some statuses could not be verified.'));
  }
});

test('unavailable, filtered-empty and empty boards stay honest and recoverable', () => {
  const unavailable = render(allUnknown);
  assert.equal((unavailable.match(/<article\b/g) || []).length, 2);
  assert.ok(plain(unavailable).includes('No check time available.'));
  assert.ok(plain(unavailable).includes('Those cards are not counted as delivered.'));
  assert.ok(!unavailable.includes('id="stage-deployed"'));
  for (const board of [allUnknown, { wins: [], checkedAt: null }]) {
    const empty = render(board, 'Delivered');
    assert.equal((empty.match(/<article\b/g) || []).length, 0);
    assert.ok(plain(empty).includes('No verified highlights in this view yet. Try All to see the full board.'));
    assert.ok(empty.includes('aria-label="Filter progress"'));
    assert.ok(empty.includes('href="/today"'));
  }
});

test('the route loading state still announces that progress is being checked', () => {
  const Loading = loadTs('app/wins/loading.tsx').default;
  const html = renderToStaticMarkup(React.createElement(Loading));
  assert.match(html, /role="status"/);
  assert.ok(plain(html).includes('Checking the latest progress...'));
});

// Small offline bundler following tests/today-regression.cjs. Local UI components,
// React and ReactDOM are real. Next Link becomes an anchor; icon paths are rendered
// from Lucide locally, avoiding bundling the entire icon catalog for this fixture.
function browserScript() {
  const ts = require('typescript');
  const modules = [];
  const ids = new Map();
  const iconNames = fs.readFileSync(path.join(SRC, 'app/wins/WinsBoard.tsx'), 'utf8').match(/import \{([^}]+)\} from "lucide-react"/)[1].split(',').map((name) => name.trim());
  const iconPaths = Object.fromEntries(iconNames.map((name) => [name, renderToStaticMarkup(React.createElement(require('lucide-react')[name])).replace(/^<svg[^>]*>|<\/svg>$/g, '')]));
  const virtual = new Map([
    ['next/link', `const R=require('react'); module.exports={__esModule:true,default:({children,...props})=>R.createElement('a',props,children)};`],
    ['lucide-react', `const R=require('react'),paths=${JSON.stringify(iconPaths)}; module.exports=new Proxy({},{get:(_,name)=>name==='__esModule'?true:({size=24,...props})=>R.createElement('svg',{...props,width:size,height:size,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:2,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true,dangerouslySetInnerHTML:{__html:paths[name]}})});`],
  ]);
  function resolve(spec, parent) {
    if (virtual.has(spec)) return spec;
    if (spec.startsWith('@/')) return resolve('./' + spec.slice(2), path.join(SRC, 'entry.ts'));
    if (spec.startsWith('.')) {
      const target = path.resolve(path.dirname(parent), spec);
      for (const suffix of ['', '.ts', '.tsx', '.js', '/index.ts', '/index.tsx', '/index.js']) {
        if (fs.existsSync(target + suffix) && fs.statSync(target + suffix).isFile()) return target + suffix;
      }
    }
    return require.resolve(spec, { paths: [path.dirname(parent)] });
  }
  function bundle(filename) {
    if (ids.has(filename)) return ids.get(filename);
    const id = modules.length;
    ids.set(filename, id);
    modules.push('');
    let code = virtual.get(filename) || fs.readFileSync(filename, 'utf8');
    if (/\.tsx?$/.test(filename)) code = ts.transpileModule(code, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
    }).outputText;
    if (/\.json$/.test(filename)) code = `module.exports=${code};`;
    code = code.replace(/require\(['"]([^'"]+)['"]\)/g, (_, dep) => `require(${bundle(resolve(dep, virtual.has(filename) ? __filename : filename))})`);
    modules[id] = code;
    return id;
  }
  const react = bundle(require.resolve('react'));
  const dom = bundle(require.resolve('react-dom/client'));
  const board = bundle(path.join(SRC, 'app/wins/WinsBoard.tsx'));
  return `const process={env:{NODE_ENV:'production'}};const modules={${modules.map((code, id) => `${id}:function(module,exports,require){${code}\n}`).join(',')}};const cache={};function require(id){if(cache[id])return cache[id].exports;const m={exports:{}};cache[id]=m;modules[id](m,m.exports,require);return m.exports;}const root=require(${dom}).createRoot(document.getElementById('root'));window.renderBoard=board=>root.render(require(${react}).createElement(require(${board}).default,{board}));`;
}

test('offline real-CSS phone and desktop layouts preserve content, targets and keyboard filters', { skip: !process.env.RUN_WINS_LAYOUT, timeout: 120000 }, async () => {
  const { chromium } = require('@playwright/test');
  const css = process.env.WINS_TEST_CSS
    ? fs.readFileSync(path.resolve(process.env.WINS_TEST_CSS), 'utf8')
    : (await require('postcss')([require('@tailwindcss/postcss')()]).process(fs.readFileSync('src/app/globals.css', 'utf8'), { from: path.resolve('src/app/globals.css') })).css;
  assert.ok(css.trim(), 'Real compiled CSS is required.');
  // The same vendored faces as layout.tsx, embedded so even fonts need no network.
  const font = (name) => fs.readFileSync(path.join(SRC, 'app/fonts', name)).toString('base64');
  const fontCss = `@font-face{font-family:FixtureArchivo;src:url(data:font/woff2;base64,${font('Archivo-Latin.woff2')});font-weight:100 900}@font-face{font-family:FixtureMono;src:url(data:font/woff2;base64,${font('DMMono-Regular-Latin.woff2')});font-weight:400}@font-face{font-family:FixtureMono;src:url(data:font/woff2;base64,${font('DMMono-Medium-Latin.woff2')});font-weight:500}:root{--font-archivo:FixtureArchivo;--font-dm-mono:FixtureMono}`;
  const script = browserScript();
  const browser = await chromium.launch({ ...(process.platform === 'win32' ? { channel: 'msedge' } : {}), headless: true });
  const errors = [];
  try {
    for (const width of [320, 390, 768, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 1000 }, serviceWorkers: 'block' });
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('request', (request) => { if (!request.url().startsWith('data:')) errors.push(`Unexpected network request: ${request.resourceType()}`); });
      await page.route('**/*', (route) => route.abort());
      await page.routeWebSocket('**/*', (socket) => { errors.push('Unexpected WebSocket'); socket.close(); });
      await page.setContent(`<style>${css}\n${fontCss}</style><body class="bg-surface text-text-primary font-sans"><main class="md:ml-[220px] min-h-screen"><div class="max-w-6xl mx-auto px-4 sm:px-6 py-8"><div id="root"></div></div></main></body>`);
      await page.addScriptTag({ content: script });
      await page.evaluate((fixture) => window.renderBoard(fixture), mixed);
      await page.getByRole('article').last().waitFor();
      await page.evaluate(() => document.fonts.ready);
      assert.equal(await page.getByRole('article').count(), mixed.wins.length);
      const overview = page.getByRole('group', { name: 'Progress overview', exact: true });
      for (const [label, count] of [['Live on the site', 1], ['Merged', 2], ['In progress', 2]]) {
        const card = overview.getByText(label, { exact: true }).locator('..');
        assert.ok(await card.getByText(String(count), { exact: true }).isVisible(), `${width}: ${label} count`);
      }
      for (const item of mixed.wins) {
        const article = page.getByRole('article', { name: item.title, exact: true });
        for (const field of ['area', 'title', 'summary', 'benefit']) assert.ok(await article.getByText(item[field], { exact: field === 'title' || field === 'area' }).isVisible(), `${width}: ${item.pr} ${field}`);
        assert.ok(await article.getByRole('link', { name: `View evidence - PR #${item.pr}`, exact: false }).isVisible());
      }
      const geometry = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth > window.innerWidth,
        smallTargets: [...document.querySelectorAll('button, a')].filter((element) => element.getBoundingClientRect().height < 44).map((element) => element.textContent),
        clippedText: [...document.querySelectorAll('article h3, article p')].filter((element) => element.scrollWidth > element.clientWidth + 1 || element.scrollHeight > element.clientHeight + 1).map((element) => element.textContent),
      }));
      assert.equal(geometry.overflow, false, `${width}: no horizontal page overflow`);
      assert.deepEqual(geometry.smallTargets, [], `${width}: interactive targets are at least 44px high`);
      assert.deepEqual(geometry.clippedText, [], `${width}: full article text wraps without clipping`);
      if (process.env.WINS_SCREENSHOT_DIR && [390, 1440].includes(width)) {
        const dir = path.resolve(process.env.WINS_SCREENSHOT_DIR);
        fs.mkdirSync(dir, { recursive: true });
        const name = width === 390 ? 'wins-phone' : 'wins-desktop';
        await page.screenshot({ path: path.join(dir, `${name}.png`) });
        await page.screenshot({ path: path.join(dir, `${name}-full.png`), fullPage: true });
      }
      const delivered = page.getByRole('button', { name: 'Delivered', exact: true });
      await delivered.focus();
      await delivered.press('Space');
      await page.waitForFunction(() => document.querySelectorAll('article').length === 3);
      assert.equal(await delivered.getAttribute('aria-pressed'), 'true');
      assert.ok(await delivered.evaluate((element) => document.activeElement === element));
      assert.ok(await page.getByText('Some statuses could not be verified.', { exact: false }).isVisible());
      await page.getByRole('button', { name: 'In progress', exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll('article').length === 2);
      for (const state of ['review', 'draft']) assert.ok(await page.locator(`#stage-${state}`).isVisible());
      assert.equal(await page.locator('#stage-deployed, #stage-merged, #stage-closed, #stage-unknown').count(), 0);
      await page.getByRole('button', { name: 'All', exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll('article').length === 7);
      await page.evaluate((fixture) => window.renderBoard(fixture), allUnknown);
      await page.getByText('No check time available.', { exact: false }).waitFor();
      await page.getByRole('button', { name: 'Delivered', exact: true }).click();
      await page.getByText('No verified highlights in this view yet. Try All to see the full board.').waitFor();
      assert.equal(await page.getByRole('article').count(), 0);
      await page.getByRole('button', { name: 'Show all highlights', exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll('article').length === 2);
      assert.equal(await page.getByRole('button', { name: 'All', exact: true }).getAttribute('aria-pressed'), 'true');
      await page.close();
    }
    assert.deepEqual(errors, [], 'No browser errors or network access');
  } finally {
    await browser.close();
  }
});
