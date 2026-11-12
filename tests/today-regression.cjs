const fs = require('fs'), path = require('path'), assert = require('assert');
// Run from the repository root. Only synthetic fixtures are used.
const root = path.resolve(__dirname, '..');
process.chdir(root);
const base = path.join(root, 'frontend', 'node_modules');
const ts = require(base + '/typescript'), { chromium } = require(base + '/@playwright/test');
const modules = {}, ids = new Map();
function bundle(file) { if (ids.has(file))
    return ids.get(file); const id = ids.size; ids.set(file, id); let code = fs.readFileSync(file, 'utf8'); code = code.replace(/require\(['"]([^'"]+)['"]\)/g, (_, dep) => `require(${bundle(require.resolve(dep, { paths: [path.dirname(file)] }))})`); modules[id] = code; return id; }
const react = bundle(require.resolve(base + '/react')), dom = bundle(require.resolve(base + '/react-dom/client'));
let component = ts.transpileModule(fs.readFileSync('frontend/src/app/today/TodayClient.tsx', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText;
component = 'const React=require(' + react + ');\n' + component.replace(/require\("react"\)/g, `require(${react})`).replace(/require\("next\/link"\)/g, `({__esModule:true,default:({children,href,...props})=>React.createElement('a',{...props,href,onClick:e=>{e.preventDefault();window.navigated=href;}},children)})`).replace(/require\("lucide-react"\)/g, `new Proxy({},{get:()=>props=>React.createElement('svg',{...props,viewBox:'0 0 24 24'},React.createElement('circle',{cx:12,cy:12,r:8,fill:'none',stroke:'currentColor',strokeWidth:1.5}))})`).replace(/require\("@\/lib\/agents-api"\)/g, '({agentsApi:new Proxy({inbox:()=>window.mockInbox()},{get:(target,key)=>key==="inbox"?target.inbox:()=>{window.unexpectedRequests.push("agentsApi."+String(key));throw Error("Unexpected agentsApi method");}})})');
const script = `const process={env:{NODE_ENV:window.reactEnv||'production'}};const modules={${Object.entries(modules).map(([id, c]) => `${id}:function(module,exports,require){${c}\n}`).join(',')}};const cache={};function require(id){if(cache[id])return cache[id].exports;const m={exports:{}};cache[id]=m;modules[id](m,m.exports,require);return m.exports;}const out={exports:{}};(function(module,exports){${component}\n})(out,out.exports);window.mount=()=>{window.root=require(${dom}).createRoot(document.getElementById('root'));const R=require(${react}),el=R.createElement(out.exports.default);window.root.render(window.strict?R.createElement(R.StrictMode,null,el):el);};window.mount();`;
const cards = Array.from({ length: 5 }, (_, i) => ({ kind: 'card', thread: 'fixture-agent', messageId: i + 1, card: { code: 'request-' + i, agent: 'Planning assistant', name: ['Review a proposed plan', 'Choose a time for your project', 'Confirm your next step', 'Fourth request', 'Fifth request'][i] } }));
const fixture = { items: [{ kind: 'message', body: 'FYI should not appear' }, ...cards], threads: [], badge: 6, typing: null };
const book = { book: { title: 'A book for steady progress' }, chaptersDone: 3, totalChapters: 12 };
const urgentItem = (i, over = {}) => ({ id: String(i), from: 'Example Billing ' + i, subject: 'Payment failed for invoice ' + i, receivedAt: '2026-11-10T15:00:00Z', reasons: ['payment problem', 'deadline tomorrow'], href: 'https://mail.google.com/mail/?authuser=me%40example.com#search/rfc822msgid%3Aabc' + i, ...over });
const urgentFixtures = {
    not_connected: { status: 'not_connected' },
    none: { status: 'ready', windowDays: 7, scanned: 12, total: 0, newestReceivedAt: '2026-11-11T12:00:00Z', truncated: false, items: [] },
    truncated_none: { status: 'ready', windowDays: 7, scanned: 200, total: 0, newestReceivedAt: '2026-11-11T12:00:00Z', truncated: true, items: [] },
    items: { status: 'ready', windowDays: 7, scanned: 40, total: 8, newestReceivedAt: '2026-11-11T12:00:00Z', truncated: true, items: [urgentItem(1), urgentItem(2, { href: null }), urgentItem(3, { href: 'https://evil.example/x' })] },
};
// Missing CSS must fail: a script-only pass cannot validate responsive layout.
const css = fs.readdirSync('frontend/.next/static/css').filter(x => x.endsWith('.css')).map(x => fs.readFileSync('frontend/.next/static/css/' + x, 'utf8')).join('\n');
assert(css.trim(), 'Compile the frontend before running layout regressions');
(async () => {
    const browser = await chromium.launch({ headless: true });
    const errors = [];
    try {
        async function setup(mode = 'healthy', width = 390, strict = false, urgent = 'not_connected') { const page = await browser.newPage({ viewport: { width, height: 900 }, serviceWorkers: 'block' }); page.on('pageerror', e => errors.push(e.message)); page.on('request', request => { if (['fetch', 'xhr', 'eventsource', 'ping'].includes(request.resourceType())) errors.push('Unexpected network request: ' + request.resourceType()); }); if (strict) page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); }); await page.routeWebSocket('**/*', socket => { errors.push('Unexpected WebSocket'); socket.close(); }); await page.route('**/*', r => r.abort()); await page.setContent('<style>' + css + '</style><div class="max-w-6xl mx-auto px-4 sm:px-6 pt-8 pb-8"><div id="root"></div></div>'); await page.evaluate(() => { document.documentElement.className = 'dark'; document.body.className = 'bg-surface text-text-primary antialiased font-sans'; }); await page.evaluate(({ fixture, book, mode, strict, urgent, urgentFixtures }) => { window.urgentMode = urgent; window.urgentFixtures = urgentFixtures; window.urgentCalls = []; window.strict = strict; window.reactEnv = strict ? 'development' : 'production'; window.fixture = fixture; window.book = book; window.mode = mode; window.calls = []; window.unexpectedRequests = []; window.pending = []; window.mockInbox = () => { window.calls.push({ url: '/onyx/inbox', method: 'GET' }); if (window.mode === 'sync-error')
            throw Error('synthetic'); if (['error', 'inbox-error', 'refresh-error'].includes(window.mode))
            return Promise.reject(Error('synthetic')); if (window.mode === 'defer')
            return new Promise((resolve, reject) => window.pending.push({ kind: 'inbox', resolve, reject })); return Promise.resolve(window.mode === 'empty' ? { ...window.fixture, items: [] } : window.fixture); }; window.fetch = (url, init) => { if (url === '/api/urgent-email' && !(init?.method && init.method !== 'GET')) { window.urgentCalls.push(url); return Promise.resolve(window.urgentMode === 'error' ? { ok: false, status: 500, json: async () => ({ error: 'x' }) } : { ok: true, status: 200, json: async () => window.urgentFixtures[window.urgentMode] }); } if (url !== '/api/reading' || (init?.method && init.method !== 'GET')) { window.unexpectedRequests.push(String(url)); return Promise.reject(Error('Unexpected request')); } window.calls.push({ url, method: init?.method || 'GET' }); if (['error', 'reading-error', 'refresh-error'].includes(window.mode))
            return Promise.resolve({ ok: false }); if (window.mode === 'defer')
            return new Promise(resolve => window.pending.push({ kind: 'reading', resolve })); return Promise.resolve({ ok: true, json: async () => ({ overview: window.mode === 'empty' ? null : window.book }) }); }; }, { fixture, book, mode, strict, urgent, urgentFixtures }); await page.addScriptTag({ content: script }); await page.getByRole('heading', { name: 'Today', exact: true }).waitFor(); assert.equal(await page.locator('[role=status]').evaluate(el => getComputedStyle(el).position), 'absolute', 'compiled CSS must be applied'); return page; }
        async function close(page) { assert.deepEqual(await page.evaluate(() => window.unexpectedRequests), [], 'Only expected GET endpoints may be requested'); await page.close(); }
        async function settled(page) { await page.waitForFunction(() => document.querySelector('[aria-label="Refresh Today"]')?.getAttribute('aria-disabled') === 'false'); }
        let page = await setup();
        await settled(page);
        assert.equal(await page.locator('section').first().locator('li').count(), 3);
        assert(await page.getByText('Showing 3 of 5 requests returned, in inbox order.').isVisible());
        assert.equal(await page.getByText('FYI should not appear').count(), 0);
        assert.equal(await page.getByRole('link', { name: 'See the rest in your inbox' }).getAttribute('href'), '/agents?view=unread');
        assert.equal(await page.getByRole('link', { name: /Review a proposed plan/ }).getAttribute('href'), '/agents?t=fixture-agent#m1');
        assert.equal(await page.getByRole('link', { name: 'Continue reading' }).getAttribute('href'), '/reading');
        assert.equal(await page.getByRole('link', { name: 'Open check-in' }).getAttribute('href'), '/check-in');
        assert(await page.getByText('3 of 12 chapters recorded.').isVisible());
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.setViewportSize({ width: 1440, height: 1000 });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.getByRole('link', { name: /Review a proposed plan/ }).focus();
        await page.evaluate(() => { window.mode = 'refresh-error'; document.querySelector('[aria-label="Refresh Today"]').click(); });
        await settled(page);
        assert(await page.getByText(/Couldn't refresh requests/).isVisible());
        assert(await page.getByText(/Couldn't refresh reading/).isVisible());
        assert.equal(await page.locator('section').first().locator('li').count(), 3);
        assert(await page.evaluate(() => document.activeElement.textContent.includes('Review a proposed plan')));
        assert((await page.evaluate(() => window.calls)).every(c => c.method === 'GET'));
        await page.evaluate(() => window.mode = 'healthy');
        await page.getByRole('button', { name: 'Refresh Today' }).click();
        await settled(page);
        assert.equal(await page.getByText(/Couldn't refresh requests/).count(), 0);
        assert.equal(await page.getByText(/Couldn't refresh reading/).count(), 0);
        await close(page);
        console.log('PASS healthy bound, FYI filtering, links, reading, mobile width, refresh errors preserve data/focus, retry, GET-only');
        for (const mode of ['empty', 'error', 'inbox-error', 'reading-error', 'sync-error']) {
            page = await setup(mode);
            await settled(page);
            if (mode === 'empty') {
                assert(await page.getByText(/last check returned no open requests/).isVisible());
                assert(await page.getByText('No book is currently in progress.').isVisible());
            }
            else {
                if (mode !== 'reading-error')
                    assert(await page.getByText(/Couldn't check requests/).isVisible());
                if (['error', 'reading-error'].includes(mode))
                    assert(await page.getByText('Reading progress is unavailable right now.').isVisible());
                else
                    assert(await page.getByText('A book for steady progress').isVisible());
                if (mode === 'reading-error')
                    assert.equal(await page.locator('section').first().locator('li').count(), 3);
                assert.equal(await page.getByText(/last check returned no open requests/).count(), 0);
            }
            await close(page);
        }
        console.log('PASS empty vs initial errors, independent failure, synchronous inbox exception');
        page = await setup('defer');
        await page.waitForFunction(() => window.calls.length === 2);
        await page.getByRole('button', { name: 'Refresh Today' }).click({ force: true });
        await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)));
        assert.equal(await page.getByRole('button', {name:'Refresh Today'}).getAttribute('aria-disabled'), 'true');
        assert.equal(await page.evaluate(() => window.calls.length), 2);
        await close(page);
        page = await setup('defer', 390, true);
        await page.waitForFunction(() => window.pending.length === 4);
        await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 100)));
        assert.equal(await page.evaluate(() => window.pending.length), 4);
        await page.evaluate(() => {
            const by = kind => window.pending.filter(p => p.kind === kind);
            const [oldInbox, newInbox] = by('inbox'), [oldReading, newReading] = by('reading');
            newInbox.resolve(window.fixture);
            newReading.resolve({ok:true, json:async () => ({overview:window.book})});
            window.resolveLate = () => {
                oldInbox.resolve({...window.fixture, items:[]});
                oldReading.resolve({ok:true, json:async () => ({overview:null})});
            };
        });
        await settled(page);
        await page.evaluate(async () => { window.resolveLate(); await new Promise(resolve => setTimeout(resolve, 100)); });
        assert.equal(await page.locator('section').first().locator('li').count(), 3);
        assert(await page.getByText('A book for steady progress').isVisible());
        await close(page);
        console.log('PASS duplicate-refresh suppression and Strict Mode superseded completions');
        page = await setup('defer');
        await settled(page);
        assert(await page.getByText(/Couldn't check requests/).isVisible());
        assert(await page.getByText('Reading progress is unavailable right now.').isVisible());
        assert.equal(await page.getByText(/last check returned no open requests/).count(), 0);
        await page.evaluate(() => window.mode = 'healthy');
        await page.getByRole('button', { name: 'Refresh Today' }).click();
        await settled(page);
        assert.equal(await page.locator('section').first().locator('li').count(), 3);
        await page.evaluate(async () => {
            for (const pending of window.pending) pending.resolve(pending.kind === 'inbox'
                ? {...window.fixture, items:[]}
                : {ok:true, json:async () => ({overview:null})});
            await new Promise(resolve => setTimeout(resolve, 100));
        });
        assert.equal(await page.locator('section').first().locator('li').count(), 3);
        assert(await page.getByText('A book for steady progress').isVisible());
        await close(page);
        console.log('PASS bounded timeout is unavailable, not empty; retry recovers and rejects late data');
        page = await setup();
        await settled(page);
        assert(await page.getByText('No urgent email source connected yet.').isVisible());
        assert.equal(await page.locator('section[aria-labelledby="urgent-email-heading"] a').count(), 0);
        assert.equal(await page.evaluate(() => window.urgentCalls.length), 1);
        await page.evaluate(() => window.urgentMode = 'none');
        await page.getByRole('button', { name: 'Refresh Today' }).click();
        await settled(page);
        assert(await page.getByText(/Checked 12 unread emails from the last 7 days; none look urgent/).isVisible());
        assert.equal(await page.getByText(/Only the newest unread emails were checked/).count(), 0);
        await page.evaluate(() => window.urgentMode = 'truncated_none');
        await page.getByRole('button', { name: 'Refresh Today' }).click();
        await settled(page);
        assert(await page.getByText(/Checked 200 unread emails from the last 7 days; none look urgent/).isVisible());
        assert(await page.getByText(/Only the newest unread emails were checked, so older ones in this window may be missing/).isVisible());
        await page.evaluate(() => window.urgentMode = 'items');
        await page.getByRole('button', { name: 'Refresh Today' }).click();
        await settled(page);
        const urgentPanel = page.locator('section[aria-labelledby="urgent-email-heading"]');
        assert(await urgentPanel.getByText('Showing 3 of 8 urgent emails, strongest first.').isVisible());
        assert.equal(await urgentPanel.locator('li').count(), 3);
        assert(await urgentPanel.getByText(/Only the newest unread emails were checked/).isVisible(), 'a capped scan is disclosed next to the list too');
        assert.equal(await urgentPanel.locator('a').count(), 1, 'only a mail.google.com link may be linked; no-link and off-Gmail rows are plain text');
        assert.equal(await urgentPanel.getByRole('link', { name: /Payment failed for invoice 1/ }).getAttribute('href'), 'https://mail.google.com/mail/?authuser=me%40example.com#search/rfc822msgid%3Aabc1');
        assert.equal(await urgentPanel.getByRole('link', { name: /Payment failed for invoice 1/ }).getAttribute('rel'), 'noopener noreferrer');
        assert.equal(await urgentPanel.getByText('No link available').count(), 2);
        assert(await urgentPanel.getByText('Why: payment problem, deadline tomorrow').first().isVisible());
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.evaluate(() => window.urgentMode = 'error');
        await page.getByRole('button', { name: 'Refresh Today' }).click();
        await settled(page);
        assert(await page.getByText(/Couldn't refresh email/).isVisible());
        assert.equal(await urgentPanel.locator('li').count(), 3, 'a failed refresh keeps the last email list');
        assert.equal(await page.locator('section').first().locator('li').count(), 3, 'agent requests stay independent of email');
        await close(page);
        page = await setup('healthy', 390, false, 'error');
        await settled(page);
        assert(await page.getByText(/Couldn't check urgent email/).isVisible());
        assert.equal(await page.getByText('No urgent email source connected yet.').count(), 0, 'an error is not the not-connected state');
        assert.equal(await page.locator('section').first().locator('li').count(), 3);
        assert(await page.getByText('A book for steady progress').isVisible());
        await close(page);
        console.log('PASS urgent email: not connected vs none urgent vs list, Gmail-only links, failed refresh keeps list, error is not empty, independent of requests');
        assert.deepEqual(errors, []);
        console.log('PASS no browser exceptions; no health data, credentials, or screenshots collected');
    }
    finally {
        await browser.close();
    }
})().catch(e => { console.error(e); process.exit(1); });
