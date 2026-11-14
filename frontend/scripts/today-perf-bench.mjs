// Isolated, synthetic Today render benchmark. NOT app latency.
//
// What it measures: in headless Chromium, with ALL network aborted and every endpoint
// answered by an in-page synthetic fixture after a fixed artificial delay, how long the
// compiled-CSS Today component takes from mount() to "Refresh Today" becoming enabled
// again (every panel settled). Because each fixture answer has the same fixed delay, a
// serial request waterfall shows up as settled time far above the delay; parallel
// requests settle at about the delay plus render cost.
//
// What it does NOT measure: real server time, real network, Vercel, the service worker,
// Next.js routing, hydration, an iPhone or Windows device. Do not quote these numbers as
// how fast Onyx is. They are only comparable between runs of THIS script on the same
// machine, same Chromium, same --latency, same --runs, different revisions.
//
// Run from the repository root, after `cd frontend && npx next build --experimental-build-mode compile`
// (the compiled CSS in frontend/.next/static/css is required; the script fails without it):
//   node frontend/scripts/today-perf-bench.mjs --label baseline --out baseline.json
//   (check out the candidate revision, rebuild)
//   node frontend/scripts/today-perf-bench.mjs --label candidate --out candidate.json
//   node frontend/scripts/today-perf-bench.mjs --compare baseline.json candidate.json
// Options: --runs 20 (first run is recorded as cold and excluded from the percentiles)
//          --latency 50 (artificial ms per synthetic answer) --width 390
// Only synthetic data is used; nothing is written except the --out JSON (no screenshots).

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf('--' + name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : dflt; };

const pct = (xs, p) => {
  const s = xs.filter(Number.isFinite).sort((a, b) => a - b);
  if (!s.length) return null;
  if (s.length === 1) return s[0];
  const r = (p / 100) * (s.length - 1), lo = Math.floor(r), hi = Math.ceil(r);
  return s[lo] + (s[hi] - s[lo]) * (r - lo);
};
const r1 = v => (v == null ? '-' : v.toFixed(1));

if (args[0] === '--compare') {
  const [a, b] = [args[1], args[2]].map(f => JSON.parse(fs.readFileSync(f, 'utf8')));
  const rows = [['settled ms p50', a.summary.settledMs.p50, b.summary.settledMs.p50], ['settled ms p95', a.summary.settledMs.p95, b.summary.settledMs.p95], ['fetches / load', a.summary.fetchesPerLoad, b.summary.fetchesPerLoad]];
  console.log('SYNTHETIC component benchmark, not app latency. Comparable only if machine, Chromium, latency, runs and width match.');
  for (const k of ['latencyMs', 'runs', 'width', 'chromium', 'platform']) if (a.meta[k] !== b.meta[k]) console.log(`WARNING: ${k} differs (${a.meta[k]} vs ${b.meta[k]}); do not compare.`);
  console.log(`baseline ${a.meta.label} @ ${a.meta.revision}  vs  candidate ${b.meta.label} @ ${b.meta.revision}`);
  for (const [n, x, y] of rows) console.log(`${n.padEnd(16)} ${r1(x).padStart(8)} -> ${r1(y).padStart(8)}`);
  process.exit(0);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
process.chdir(root);
const base = path.join(root, 'frontend', 'node_modules');
const require = createRequire(import.meta.url);
const ts = require(base + '/typescript');
const { chromium } = require(base + '/@playwright/test');

const RUNS = Math.max(3, Number(opt('runs', 20)));
const LATENCY = Math.max(0, Number(opt('latency', 50)));
const WIDTH = Number(opt('width', 390));

const cssDir = 'frontend/.next/static/css';
const css = fs.existsSync(cssDir) ? fs.readdirSync(cssDir).filter(x => x.endsWith('.css')).map(x => fs.readFileSync(path.join(cssDir, x), 'utf8')).join('\n') : '';
if (!css.trim()) { console.error('Compile the frontend before benchmarking: cd frontend && npx next build --experimental-build-mode compile'); process.exit(2); }

// Same bundling approach as tests/today-regression.cjs: transpile the component and its
// local libs, stub next/link, lucide-react and agents-api, bundle react + react-dom.
const modules = {}, ids = new Map();
function bundle(file) {
  if (ids.has(file)) return ids.get(file);
  const id = ids.size; ids.set(file, id);
  let code = fs.readFileSync(file, 'utf8');
  code = code.replace(/require\(['"]([^'"]+)['"]\)/g, (_, dep) => `require(${bundle(require.resolve(dep, { paths: [path.dirname(file)] }))})`);
  modules[id] = code; return id;
}
const tsOpts = { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } };
const react = bundle(require.resolve(base + '/react')), dom = bundle(require.resolve(base + '/react-dom/client'));
let component = ts.transpileModule(fs.readFileSync('frontend/src/app/today/TodayClient.tsx', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText;
component = 'const React=require(' + react + ');\n' + component
  .replace(/require\("react"\)/g, `require(${react})`)
  .replace(/require\("next\/link"\)/g, `({__esModule:true,default:({children,href,...props})=>React.createElement('a',{...props,href,onClick:e=>e.preventDefault()},children)})`)
  .replace(/require\("lucide-react"\)/g, `new Proxy({},{get:()=>props=>React.createElement('svg',{...props,viewBox:'0 0 24 24'})})`)
  .replace(/require\("@\/lib\/agents-api"\)/g, `({agentsApi:{inbox:()=>window.synth('inbox'),dismiss:()=>Promise.resolve({ok:true,codes:[],badge:0})},clearDeviceNotifications:()=>Promise.resolve(),setBadge:()=>{}})`);
for (const lib of ['urgent-email', 'experiments', 'calendar-events', 'today-clear']) {
  const id = ids.size; ids.set('frontend/src/lib/' + lib + '.ts', id);
  modules[id] = ts.transpileModule(fs.readFileSync('frontend/src/lib/' + lib + '.ts', 'utf8'), tsOpts).outputText;
  component = component.replace(new RegExp(`require\\("@/lib/${lib}"\\)`, 'g'), `require(${id})`);
}
const script = `const process={env:{NODE_ENV:'production'}};const modules={${Object.entries(modules).map(([id, c]) => `${id}:function(module,exports,require){${c}\n}`).join(',')}};const cache={};function require(id){if(cache[id])return cache[id].exports;const m={exports:{}};cache[id]=m;modules[id](m,m.exports,require);return m.exports;}const out={exports:{}};(function(module,exports){${component}\n})(out,out.exports);window.mount=()=>{window.root=require(${dom}).createRoot(document.getElementById('root'));const R=require(${react});window.root.render(R.createElement(out.exports.default));};`;

const ago = h => new Date(Date.now() - h * 3600000).toISOString();
const okSync = { at: ago(0.3), status: 'success', error: null };
const answers = {
  '/api/reading': { overview: { book: { title: 'A book for steady progress' }, chaptersDone: 3, totalChapters: 12 } },
  '/api/urgent-email': { status: 'ready', windowDays: 30, scanned: 9, total: 0, hidden: 9, lastSync: okSync, items: [] },
  '/api/orders/summary': { status: 'ready', attention: 0, arrivingToday: 0, onTheWay: 0, top: [] },
  '/api/procurement/renewals/summary': { status: 'empty' },
  '/api/experiments/today': { status: 'none' },
  '/api/calendar/events': { status: 'ready', events: [], truncated: false, lastSync: okSync },
};
const inbox = { items: Array.from({ length: 5 }, (_, i) => ({ kind: 'card', thread: 'fixture-agent', messageId: i + 1, card: { code: 'request-' + i, agent: 'Planning assistant', name: 'Synthetic request ' + i } })), threads: [], badge: 5, typing: null };

let revision = 'unknown', dirty = false;
try { revision = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(); dirty = execFileSync('git', ['status', '--porcelain', '--', 'frontend/src'], { encoding: 'utf8' }).trim() !== ''; } catch { /* not a git checkout */ }

const browser = await chromium.launch({ headless: true });
const samples = [];
const leaks = [];
try {
  for (let i = 0; i < RUNS; i++) {
    const page = await browser.newPage({ viewport: { width: WIDTH, height: 900 }, serviceWorkers: 'block' });
    page.on('pageerror', e => leaks.push(e.message));
    await page.route('**/*', r => r.abort()); // network blocked: any real request fails and is reported
    page.on('request', r => { if (['fetch', 'xhr', 'eventsource', 'ping'].includes(r.resourceType())) leaks.push('network ' + r.resourceType()); });
    await page.setContent('<style>' + css + '</style><div class="max-w-6xl mx-auto px-4 sm:px-6 pt-8 pb-8"><div id="root"></div></div>');
    await page.evaluate(({ answers, inbox, latency }) => {
      document.documentElement.className = 'dark';
      document.body.className = 'bg-surface text-text-primary antialiased font-sans';
      window.fetchCount = 0; window.unexpected = [];
      const later = v => new Promise(res => setTimeout(() => res(v), latency));
      window.synth = k => { window.fetchCount++; return later(inbox); };
      window.fetch = url => {
        window.fetchCount++;
        const key = String(url).split('?')[0];
        if (!(key in answers)) { window.unexpected.push(key); return Promise.reject(Error('unexpected')); }
        return later({ ok: true, status: 200, json: async () => answers[key] });
      };
    }, { answers, inbox, latency: LATENCY });
    await page.addScriptTag({ content: script });
    const t = await page.evaluate(async () => {
      const t0 = performance.now();
      window.mount();
      await new Promise(res => {
        const tick = () => {
          const b = document.querySelector('[aria-label="Refresh Today"]');
          if (b && b.getAttribute('aria-disabled') === 'false') res(); else requestAnimationFrame(tick);
        };
        tick();
      });
      return { settledMs: performance.now() - t0, fetches: window.fetchCount, unexpected: window.unexpected };
    });
    if (t.unexpected.length) leaks.push('unexpected endpoint: ' + t.unexpected.join(','));
    samples.push({ i, cold: i === 0, ...t, unexpected: undefined });
    await page.close();
  }
} finally {
  await browser.close();
}

const warm = samples.filter(s => !s.cold);
const result = {
  meta: {
    label: opt('label', 'run'), revision, uncommittedSourceChanges: dirty, runs: RUNS, latencyMs: LATENCY, width: WIDTH,
    chromium: null, platform: process.platform, syntheticOnly: true, networkBlocked: true,
    notAppLatency: 'Synthetic fixtures with fixed artificial delay in headless Chromium; not production, not a device.',
    leaks,
  },
  summary: { settledMs: { p50: pct(warm.map(s => s.settledMs), 50), p95: pct(warm.map(s => s.settledMs), 95), cold: samples[0]?.settledMs ?? null }, fetchesPerLoad: pct(warm.map(s => s.fetches), 50) },
  samples,
};
try { result.meta.chromium = (await chromium.executablePath()).split(/[\\/]/).slice(-4, -3)[0] || null; } catch { /* ignore */ }
const outFile = opt('out', '');
if (outFile) fs.writeFileSync(outFile, JSON.stringify(result, null, 1));
console.log(`SYNTHETIC component benchmark (not app latency) ${result.meta.label} @ ${revision}${dirty ? ' + uncommitted changes' : ''}`);
console.log(`settled ms p50 ${r1(result.summary.settledMs.p50)} p95 ${r1(result.summary.settledMs.p95)} cold ${r1(result.summary.settledMs.cold)}; fetches/load ${result.summary.fetchesPerLoad}; artificial latency ${LATENCY} ms`);
if (leaks.length) { console.error('Isolation violated:', leaks.join('; ')); process.exit(1); }
