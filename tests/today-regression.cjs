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
const urgentLib = ids.size; ids.set('frontend/src/lib/urgent-email.ts', urgentLib); modules[urgentLib] = ts.transpileModule(fs.readFileSync('frontend/src/lib/urgent-email.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
component = component.replace(/require\("@\/lib\/urgent-email"\)/g, `require(${urgentLib})`);
const script = `const process={env:{NODE_ENV:window.reactEnv||'production'}};const modules={${Object.entries(modules).map(([id, c]) => `${id}:function(module,exports,require){${c}\n}`).join(',')}};const cache={};function require(id){if(cache[id])return cache[id].exports;const m={exports:{}};cache[id]=m;modules[id](m,m.exports,require);return m.exports;}const out={exports:{}};(function(module,exports){${component}\n})(out,out.exports);window.mount=()=>{window.root=require(${dom}).createRoot(document.getElementById('root'));const R=require(${react}),el=R.createElement(out.exports.default);window.root.render(window.strict?R.createElement(R.StrictMode,null,el):el);};window.mount();`;
const cards = Array.from({ length: 5 }, (_, i) => ({ kind: 'card', thread: 'fixture-agent', messageId: i + 1, card: { code: 'request-' + i, agent: 'Planning assistant', name: ['Review a proposed plan', 'Choose a time for your project', 'Confirm your next step', 'Fourth request', 'Fifth request'][i] } }));
const fixture = { items: [{ kind: 'message', body: 'FYI should not appear' }, ...cards], threads: [], badge: 6, typing: null };
const book = { book: { title: 'A book for steady progress' }, chaptersDone: 3, totalChapters: 12 };
const ago = h => new Date(Date.now() - h * 3600000).toISOString();
const workerTime = h => ago(h).slice(0, 19).replace('T', ' ');
const urgentItem = (i, over = {}) => ({ key: 'thread:owner@example.com:' + (9000 + i), threadId: String(9000 + i), messageId: 'm' + i + '@mail.example.com', account: 'owner@example.com', from: 'Example Sender ' + i, subject: 'Synthetic labelled email ' + i, receivedAt: ago(i + 1), lastSeenAt: null, labels: ['Agent/Action'], unread: true, deadline: null, reasons: ['inbox-triage marked it Agent/Action (needs a reply or decision)'], nextStep: 'Reply or decide in Gmail (a draft reply may be waiting)', href: 'https://mail.google.com/mail/?authuser=owner%40example.com#all/thread-f:' + (9000 + i), ...over });
const urgentItems = [urgentItem(1, { labels: ['Agent/Deadline'], deadline: { daysLeft: 1, label: 'Thu, Nov 12' }, reasons: ['Deadline tomorrow (Thu, Nov 12)'], nextStep: 'Handle it in Gmail by Thu, Nov 12' }), urgentItem(2, { href: 'https://evil.example/x' }), urgentItem(3)];
const urgentFixtures = {
    not_connected: { status: 'not_connected' },
    none: { status: 'ready', windowDays: 30, scanned: 12, total: 0, hidden: 12, lastSync: { at: ago(20 / 60), status: 'success', error: null }, items: [] },
    items: { status: 'ready', windowDays: 30, scanned: 9, total: 3, hidden: 6, lastSync: { at: ago(20 / 60), status: 'success', error: null }, items: urgentItems },
    stale_sync: { status: 'ready', windowDays: 30, scanned: 9, total: 3, hidden: 6, lastSync: { at: ago(6.2), status: 'partial', error: 'synthetic' }, items: urgentItems },
};
// inbox-triage email cards: one links labelled thread 9001 (must merge into it), one is a search link (stands alone).
const emailCards = [
    { kind: 'card', thread: 'inbox-triage', messageId: 101, created_at: workerTime(1), card: { code: 'E1', agent: 'inbox-triage', type: 'question', name: 'Urgent: a synthetic ballot closes tomorrow', link: 'https://mail.google.com/mail/?authuser=owner@example.com#all/thread-f:9001' } },
    { kind: 'card', thread: 'inbox-triage', messageId: 102, created_at: workerTime(3.2), card: { code: 'E2', agent: 'inbox-triage', type: 'question', name: 'Urgent: A synthetic sign-in check', link: 'https://mail.google.com/mail/?authuser=second@example.com#search/synthetic' } },
];
const fixtureWithEmail = { ...fixture, items: [...fixture.items, ...emailCards] };
// Missing CSS must fail: a script-only pass cannot validate responsive layout.
const css = fs.readdirSync('frontend/.next/static/css').filter(x => x.endsWith('.css')).map(x => fs.readFileSync('frontend/.next/static/css/' + x, 'utf8')).join('\n');
assert(css.trim(), 'Compile the frontend before running layout regressions');
(async () => {
    const browser = await chromium.launch({ headless: true });
    const errors = [];
    try {
        async function setup(mode = 'healthy', width = 390, strict = false, urgent = 'not_connected') { const page = await browser.newPage({ viewport: { width, height: 900 }, serviceWorkers: 'block' }); page.on('pageerror', e => errors.push(e.message)); page.on('request', request => { if (['fetch', 'xhr', 'eventsource', 'ping'].includes(request.resourceType())) errors.push('Unexpected network request: ' + request.resourceType()); }); if (strict) page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); }); await page.routeWebSocket('**/*', socket => { errors.push('Unexpected WebSocket'); socket.close(); }); await page.route('**/*', r => r.abort()); await page.setContent('<style>' + css + '</style><div class="max-w-6xl mx-auto px-4 sm:px-6 pt-8 pb-8"><div id="root"></div></div>'); await page.evaluate(() => { document.documentElement.className = 'dark'; document.body.className = 'bg-surface text-text-primary antialiased font-sans'; }); await page.evaluate(({ fixture, book, mode, strict, urgent, urgentFixtures, fixtureWithEmail }) => { window.urgentMode = urgent; window.urgentFixtures = urgentFixtures; window.fixtureWithEmail = fixtureWithEmail; window.urgentCalls = []; window.strict = strict; window.reactEnv = strict ? 'development' : 'production'; window.fixture = fixture; window.book = book; window.mode = mode; window.calls = []; window.unexpectedRequests = []; window.pending = []; window.mockInbox = () => { window.calls.push({ url: '/onyx/inbox', method: 'GET' }); if (window.mode === 'sync-error')
            throw Error('synthetic'); if (['error', 'inbox-error', 'refresh-error'].includes(window.mode))
            return Promise.reject(Error('synthetic')); if (window.mode === 'defer')
            return new Promise((resolve, reject) => window.pending.push({ kind: 'inbox', resolve, reject })); return Promise.resolve(window.mode === 'empty' ? { ...window.fixture, items: [] } : window.mode === 'email-cards' ? window.fixtureWithEmail : window.fixture); }; window.fetch = (url, init) => { if (url === '/api/urgent-email' && !(init?.method && init.method !== 'GET')) { window.urgentCalls.push(url); return Promise.resolve(window.urgentMode === 'error' ? { ok: false, status: 500, json: async () => ({ error: 'x' }) } : { ok: true, status: 200, json: async () => window.urgentFixtures[window.urgentMode] }); } if (url === '/api/orders/summary' && !(init?.method && init.method !== 'GET')) { window.ordersCalls = (window.ordersCalls || 0) + 1; return Promise.resolve({ ok: true, status: 200, json: async () => ({ status: 'ready', attention: 0, arrivingToday: 0, onTheWay: 0, top: [] }) }); } if (url === '/api/procurement/renewals/summary' && !(init?.method && init.method !== 'GET')) { window.renewalsCalls = (window.renewalsCalls || 0) + 1; return Promise.resolve(window.renewalsFixture === 'error' ? { ok: false, status: 500, json: async () => ({ error: 'x' }) } : { ok: true, status: 200, json: async () => (window.renewalsFixture || { status: 'ready', count: 0, soon: [], withinDays: 3 }) }); } if (url !== '/api/reading' || (init?.method && init.method !== 'GET')) { window.unexpectedRequests.push(String(url)); return Promise.reject(Error('Unexpected request')); } window.calls.push({ url, method: init?.method || 'GET' }); if (['error', 'reading-error', 'refresh-error'].includes(window.mode))
            return Promise.resolve({ ok: false }); if (window.mode === 'defer')
            return new Promise(resolve => window.pending.push({ kind: 'reading', resolve })); return Promise.resolve({ ok: true, json: async () => ({ overview: window.mode === 'empty' ? null : window.book }) }); }; }, { fixture, book, mode, strict, urgent, urgentFixtures, fixtureWithEmail }); await page.addScriptTag({ content: script }); await page.getByRole('heading', { name: 'Today', exact: true }).waitFor(); assert.equal(await page.locator('[role=status]').evaluate(el => getComputedStyle(el).position), 'absolute', 'compiled CSS must be applied'); return page; }
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
        let urgentPanel = page.locator('section[aria-labelledby="urgent-email-heading"]');
        assert(await urgentPanel.getByText(/email label sync isn't connected yet\./).isVisible());
        assert.equal(await urgentPanel.locator('a').count(), 0);
        assert.equal(await page.evaluate(() => window.urgentCalls.length), 1);
        await page.evaluate(() => window.urgentMode = 'none');
        await page.getByRole('button', { name: 'Refresh Today' }).click();
        await settled(page);
        assert(await urgentPanel.getByText('Nothing urgent right now.').isVisible());
        assert(await urgentPanel.getByText('12 labelled threads in the last 30 days; 12 left out (archived, older, or past their date).').isVisible());
        assert(await urgentPanel.getByText('Email labels last synced 20 min ago.').isVisible());
        await page.evaluate(() => { window.urgentMode = 'items'; window.mode = 'email-cards'; });
        await page.getByRole('button', { name: 'Refresh Today' }).click();
        await settled(page);
        assert(await urgentPanel.getByText('Showing 4 of 4, most pressing first.').isVisible());
        assert.equal(await urgentPanel.locator('li').count(), 4, 'the card for a labelled thread merges into it; the other card stands alone');
        const first = urgentPanel.locator('li').first();
        assert(await first.getByText('Gmail, owner@: Agent/Deadline + Agent Inbox (inbox-triage). Received 2 h ago.').isVisible());
        assert(await first.getByText('Next: Answer the request, then handle it in Gmail by Thu, Nov 12').isVisible());
        assert(await first.getByText(/Why: inbox-triage asked you about it: a synthetic ballot closes tomorrow; Deadline tomorrow/).isVisible());
        const gmail = first.getByRole('link', { name: 'Open in Gmail: Synthetic labelled email 1' });
        assert.equal(await gmail.getAttribute('href'), 'https://mail.google.com/mail/?authuser=owner%40example.com#all/thread-f:9001');
        assert.equal(await gmail.getAttribute('rel'), 'noopener noreferrer');
        assert.equal(await gmail.getAttribute('target'), '_blank');
        assert.equal(await first.getByRole('link', { name: /Open request/ }).getAttribute('href'), '/agents?t=inbox-triage#m101');
        const second = urgentPanel.locator('li').nth(1);
        assert(await second.getByText('A synthetic sign-in check').isVisible());
        assert(await second.getByText(/^Agent Inbox: inbox-triage, second@\. Posted 3 h ago\.$/).isVisible());
        assert(await second.getByText('Next: Answer the request in your inbox').isVisible());
        assert.equal(await urgentPanel.getByRole('link', { name: 'Open in Gmail: Synthetic labelled email 2' }).count(), 0, 'an off-Gmail href is never rendered as a link');
        assert.equal(await urgentPanel.getByText('A synthetic sign-in check').count(), 1);
        assert(await page.getByText('Showing 3 of 5 requests returned, in inbox order.').isVisible());
        assert(await page.getByText('2 email requests are listed under Urgent email instead.').isVisible());
        assert.equal(await page.locator('section').first().getByText(/synthetic sign-in check|synthetic ballot/).count(), 0, 'email requests are shown once, under Urgent email');
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.evaluate(() => window.urgentMode = 'error');
        await page.getByRole('button', { name: 'Refresh Today' }).click();
        await settled(page);
        assert(await urgentPanel.getByText(/Couldn't refresh the email labels/).isVisible());
        assert.equal(await urgentPanel.locator('li').count(), 4, 'a failed refresh keeps the last list');
        assert.equal(await page.locator('section').first().locator('li').count(), 3, 'agent requests stay independent of email');
        assert((await page.evaluate(() => window.calls)).every(c => c.method === 'GET'));
        await close(page);
        page = await setup('healthy', 390, false, 'error');
        await settled(page);
        urgentPanel = page.locator('section[aria-labelledby="urgent-email-heading"]');
        assert(await urgentPanel.getByText("Couldn't check urgent email. Try refreshing.").isVisible());
        assert.equal(await urgentPanel.getByText('Nothing urgent right now.').count(), 0, 'an error is not empty');
        assert.equal(await urgentPanel.getByText(/isn't connected yet/).count(), 0, 'an error is not the not-connected state');
        assert.equal(await page.locator('section').first().locator('li').count(), 3);
        assert(await page.getByText('A book for steady progress').isVisible());
        await close(page);
        page = await setup('email-cards', 390, false, 'error');
        await settled(page);
        urgentPanel = page.locator('section[aria-labelledby="urgent-email-heading"]');
        assert(await urgentPanel.getByText("Couldn't check the email labels. Showing inbox-triage's requests only.").isVisible());
        assert.equal(await urgentPanel.locator('li').count(), 2, 'without the labels both email cards still show');
        await close(page);
        page = await setup('healthy', 390, false, 'stale_sync');
        await settled(page);
        urgentPanel = page.locator('section[aria-labelledby="urgent-email-heading"]');
        assert(await urgentPanel.getByText('Email labels last synced 6 h ago (that run: partial); newer labels may be missing.').isVisible());
        await close(page);
        console.log('PASS urgent email: not connected vs nothing urgent vs list, labels + Agent Inbox merged once, source/freshness/reason/next step, Gmail-only links, failed refresh keeps list, error is not empty, stale sync flagged');
        // Renewals panel: hidden unless something renews within 3 days; a failed check keeps the last answer.
        page = await setup();
        await settled(page);
        assert.equal(await page.locator('section[aria-labelledby="renewals-heading"]').count(), 0, 'nothing due: no Renewals panel');
        await page.evaluate(() => { window.renewalsFixture = { status: 'ready', count: 4, withinDays: 3, soon: [{ merchant: 'Synthetic streaming plan', days: 0, date: '2030-01-01', label: 'renews today' }, { merchant: 'Synthetic storage plan', days: 2, date: '2030-01-03', label: 'renews in 2 days' }] }; });
        await page.getByRole('button', { name: 'Refresh Today' }).click();
        await settled(page);
        let renewalsPanel = page.locator('section[aria-labelledby="renewals-heading"]');
        assert(await renewalsPanel.getByText('4 subscriptions are expected to renew in the next 3 days.').isVisible());
        assert.equal(await renewalsPanel.locator('li').count(), 2);
        assert(await renewalsPanel.getByText('renews in 2 days').isVisible());
        assert(await renewalsPanel.getByText('And 2 more.').isVisible());
        assert.equal(await renewalsPanel.getByRole('link', { name: 'Open procurement' }).getAttribute('href'), '/procurement');
        assert.equal(await renewalsPanel.getByText('$').count(), 0, 'no amounts on Today');
        await page.evaluate(() => { window.renewalsFixture = 'error'; });
        await page.getByRole('button', { name: 'Refresh Today' }).click();
        await settled(page);
        assert.equal(await page.locator('section[aria-labelledby="renewals-heading"] li').count(), 2, 'a failed check keeps the last summary');
        await page.evaluate(() => { window.renewalsFixture = { status: 'empty' }; });
        await page.getByRole('button', { name: 'Refresh Today' }).click();
        await settled(page);
        assert.equal(await page.locator('section[aria-labelledby="renewals-heading"]').count(), 0, 'an empty ledger hides the panel');
        assert(await page.evaluate(() => window.renewalsCalls) >= 4);
        await close(page);
        console.log('PASS renewals panel: hidden when nothing is due, lists what renews soon without amounts, failed check keeps the last answer, empty ledger hides it');
        assert.deepEqual(errors, []);
        console.log('PASS no browser exceptions; no health data, credentials, or screenshots collected');
    }
    finally {
        await browser.close();
    }
})().catch(e => { console.error(e); process.exit(1); });
