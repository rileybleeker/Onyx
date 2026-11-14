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
component = 'const React=require(' + react + ');\n' + component.replace(/require\("react"\)/g, `require(${react})`).replace(/require\("next\/link"\)/g, `({__esModule:true,default:({children,href,...props})=>React.createElement('a',{...props,href,onClick:e=>{e.preventDefault();window.navigated=href;}},children)})`).replace(/require\("lucide-react"\)/g, `new Proxy({},{get:()=>props=>React.createElement('svg',{...props,viewBox:'0 0 24 24'},React.createElement('circle',{cx:12,cy:12,r:8,fill:'none',stroke:'currentColor',strokeWidth:1.5}))})`).replace(/require\("@\/lib\/agents-api"\)/g, '({agentsApi:new Proxy({inbox:()=>window.mockInbox(),dismiss:o=>window.mockDismiss(o)},{get:(target,key)=>key in target?target[key]:()=>{window.unexpectedRequests.push("agentsApi."+String(key));throw Error("Unexpected agentsApi method");}}),clearDeviceNotifications:()=>{window.deviceCleared=(window.deviceCleared||0)+1;return Promise.resolve();},setBadge:n=>{window.badge=n;}})');
const urgentLib = ids.size; ids.set('frontend/src/lib/urgent-email.ts', urgentLib); modules[urgentLib] = ts.transpileModule(fs.readFileSync('frontend/src/lib/urgent-email.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
component = component.replace(/require\("@\/lib\/urgent-email"\)/g, `require(${urgentLib})`);
const experimentsLib = ids.size; ids.set('frontend/src/lib/experiments.ts', experimentsLib); modules[experimentsLib] = ts.transpileModule(fs.readFileSync('frontend/src/lib/experiments.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
component = component.replace(/require\("@\/lib\/experiments"\)/g, `require(${experimentsLib})`);
const calendarLib = ids.size; ids.set('frontend/src/lib/calendar-events.ts', calendarLib); modules[calendarLib] = ts.transpileModule(fs.readFileSync('frontend/src/lib/calendar-events.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
component = component.replace(/require\("@\/lib\/calendar-events"\)/g, `require(${calendarLib})`);
const clearLib = ids.size; ids.set('frontend/src/lib/today-clear.ts', clearLib); modules[clearLib] = ts.transpileModule(fs.readFileSync('frontend/src/lib/today-clear.ts', 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
component = component.replace(/require\("@\/lib\/today-clear"\)/g, `require(${clearLib})`);
// GET /api/experiments/today answers (synthetic). "none" is the usual case: no trial registered.
const experimentFixtures = {
    none: { status: 'none' },
    not_connected: { status: 'not_connected' },
    active: { status: 'active', experimentId: 'EXP-901', title: 'A synthetic evening routine', behavioralDate: '2030-01-18', dayNumber: 12, nDays: 232, plannedEnd: '2030-08-26', arm: 'A', instruction: 'Synthetic instruction for arm A.' },
    upcoming: { status: 'upcoming', experimentId: 'EXP-901', title: 'A synthetic evening routine', startDate: '2030-01-07', nDays: 232 },
    invalid: { status: 'active', experimentId: 'EXP-901', title: 'x', arm: 'C', instruction: 'never shown' },
};
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
        async function setup(mode = 'healthy', width = 390, strict = false, urgent = 'not_connected', experiment = 'none', calendar = 'not_connected') { const page = await browser.newPage({ viewport: { width, height: 900 }, serviceWorkers: 'block' }); page.on('pageerror', e => errors.push(e.message)); page.on('request', request => { if (['fetch', 'xhr', 'eventsource', 'ping'].includes(request.resourceType())) errors.push('Unexpected network request: ' + request.resourceType()); }); if (strict) page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); }); await page.routeWebSocket('**/*', socket => { errors.push('Unexpected WebSocket'); socket.close(); }); await page.route('**/*', r => r.abort()); await page.setContent('<style>' + css + '</style><div class="max-w-6xl mx-auto px-4 sm:px-6 pt-8 pb-8"><div id="root"></div></div>'); await page.evaluate(() => { document.documentElement.className = 'dark'; document.body.className = 'bg-surface text-text-primary antialiased font-sans'; }); await page.evaluate(({ fixture, book, mode, strict, urgent, urgentFixtures, fixtureWithEmail, experiment, experimentFixtures, calendar }) => { window.calendarMode = calendar; window.calendarCalls = []; (() => {
            // Synthetic calendar events relative to the page's "now" (deliberately unsorted; two are outside today + tomorrow).
            const cd = (off, h, m) => { const d = new Date(); d.setDate(d.getDate() + off); d.setHours(h, m || 0, 0, 0); return d; };
            const ymd = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
            const ev = (key, title, s, e, over) => ({ key, title, allDay: false, startAt: s.toISOString(), endAt: e.toISOString(), startDate: ymd(s), endDate: ymd(e), calendar: 'main', account: 'acct one', location: null, status: 'confirmed', recurring: false, ...over });
            const okSync = { at: new Date(Date.now() - 20 * 60000).toISOString(), status: 'success', error: null };
            const list = [
                ev('c-late', 'Synthetic afternoon sync', cd(0, 14, 30), cd(0, 15, 0), { status: 'tentative', calendar: 'side' }),
                ev('c-tomorrow', 'Synthetic planning session', cd(1, 11, 0), cd(1, 12, 0)),
                ev('c-morning', 'Synthetic morning review', cd(0, 9, 0), cd(0, 10, 0), { location: 'Room 4, North wing' }),
                { key: 'c-day', title: 'Synthetic all-day block', allDay: true, startAt: null, endAt: null, startDate: ymd(cd(0, 12)), endDate: ymd(cd(0, 12)), calendar: 'main', account: 'acct one', location: null, status: 'confirmed', recurring: false },
                ev('c-out', 'Synthetic out of range', cd(2, 9, 0), cd(2, 10, 0)),
                ev('c-overnight', 'Synthetic overnight', cd(-1, 23, 0), cd(0, 1, 0)),
            ];
            window.calendarDays = [ymd(cd(0, 12)), ymd(cd(1, 12))];
            window.calendarFixtures = {
                not_connected: { status: 'not_connected', lastSync: null },
                never_ran: { status: 'ready', events: [], truncated: false, lastSync: null },
                empty: { status: 'ready', events: [], truncated: false, lastSync: okSync },
                events: { status: 'ready', events: list, truncated: false, lastSync: okSync },
                stale_sync: { status: 'ready', events: list, truncated: false, lastSync: { at: new Date(Date.now() - 6.2 * 3600000).toISOString(), status: 'partial', error: 'synthetic' } },
            };
        })(); window.experimentMode = experiment; window.experimentFixtures = experimentFixtures; window.experimentCalls = 0; window.urgentMode = urgent; window.urgentFixtures = urgentFixtures; window.fixtureWithEmail = fixtureWithEmail; window.urgentCalls = []; window.strict = strict; window.reactEnv = strict ? 'development' : 'production'; window.fixture = fixture; window.book = book; window.mode = mode; window.calls = []; window.unexpectedRequests = []; window.pending = []; window.dismissCalls = []; window.clearCalls = []; window.mockDismiss = o => { window.dismissCalls.push(o); return window.dismissMode === 'error' ? Promise.reject(Error('synthetic')) : Promise.resolve({ ok: true, codes: (o.codes || []).map(c => c.toUpperCase()), badge: 2 }); }; window.mockInbox = () => { window.calls.push({ url: '/onyx/inbox', method: 'GET' }); if (window.mode === 'sync-error')
            throw Error('synthetic'); if (['error', 'inbox-error', 'refresh-error'].includes(window.mode))
            return Promise.reject(Error('synthetic')); if (window.mode === 'defer')
            return new Promise((resolve, reject) => window.pending.push({ kind: 'inbox', resolve, reject })); return Promise.resolve(window.mode === 'empty' ? { ...window.fixture, items: [] } : window.mode === 'email-cards' ? window.fixtureWithEmail : window.fixture); }; window.fetch = (url, init) => { if (url === '/api/urgent-email/clear' && init?.method === 'POST') { window.clearCalls.push(JSON.parse(init.body)); return Promise.resolve(window.clearMode === 'error' ? { ok: false, status: 500, json: async () => ({ error: 'x' }) } : { ok: true, status: 200, json: async () => ({ ok: true }) }); } if (url === '/api/urgent-email' && !(init?.method && init.method !== 'GET')) { window.urgentCalls.push(url); return Promise.resolve(window.urgentMode === 'error' ? { ok: false, status: 500, json: async () => ({ error: 'x' }) } : { ok: true, status: 200, json: async () => window.urgentFixtures[window.urgentMode] }); } if (String(url).startsWith('/api/calendar/events?') && !(init?.method && init.method !== 'GET')) { window.calendarCalls.push(String(url)); return Promise.resolve(window.calendarMode === 'error' ? { ok: false, status: 500, json: async () => ({ error: 'x' }) } : { ok: true, status: 200, json: async () => window.calendarFixtures[window.calendarMode] }); } if (url === '/api/orders/summary' && !(init?.method && init.method !== 'GET')) { window.ordersCalls = (window.ordersCalls || 0) + 1; return Promise.resolve({ ok: true, status: 200, json: async () => ({ status: 'ready', attention: 0, arrivingToday: 0, onTheWay: 0, top: [] }) }); } if (url === '/api/procurement/renewals/summary' && !(init?.method && init.method !== 'GET')) { window.renewalsCalls = (window.renewalsCalls || 0) + 1; return Promise.resolve(window.renewalsFixture === 'error' ? { ok: false, status: 500, json: async () => ({ error: 'x' }) } : { ok: true, status: 200, json: async () => (window.renewalsFixture || { status: 'ready', count: 0, soon: [], withinDays: 3 }) }); } if (url === '/api/experiments/today' && !(init?.method && init.method !== 'GET')) { window.experimentCalls++; return Promise.resolve(window.experimentMode === 'error' ? { ok: false, status: 500, json: async () => ({ error: 'x' }) } : { ok: true, status: 200, json: async () => window.experimentFixtures[window.experimentMode] }); } if (url !== '/api/reading' || (init?.method && init.method !== 'GET')) { window.unexpectedRequests.push(String(url)); return Promise.reject(Error('Unexpected request')); } window.calls.push({ url, method: init?.method || 'GET' }); if (['error', 'reading-error', 'refresh-error'].includes(window.mode))
            return Promise.resolve({ ok: false }); if (window.mode === 'defer')
            return new Promise(resolve => window.pending.push({ kind: 'reading', resolve })); return Promise.resolve({ ok: true, json: async () => ({ overview: window.mode === 'empty' ? null : window.book }) }); }; }, { fixture, book, mode, strict, urgent, urgentFixtures, fixtureWithEmail, experiment, experimentFixtures, calendar }); await page.addScriptTag({ content: script }); await page.getByRole('heading', { name: 'Today', exact: true }).waitFor(); assert.equal(await page.locator('[role=status]').evaluate(el => getComputedStyle(el).position), 'absolute', 'compiled CSS must be applied'); return page; }
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
        // Clearing from Today: x per row, Clear all per panel, Undo. Cards go to the Worker's dismiss,
        // labelled threads to POST /api/urgent-email/clear; opening Today clears nothing.
        page = await setup('email-cards', 390, false, 'items');
        await settled(page);
        assert.deepEqual(await page.evaluate(() => [window.dismissCalls.length, window.clearCalls.length]), [0, 0], 'opening Today clears nothing');
        const requestsPanel = page.locator('section[aria-labelledby="requests-heading"]');
        urgentPanel = page.locator('section[aria-labelledby="urgent-email-heading"]');
        const clearResult = page.getByRole('status', { name: 'Clear result' });
        await requestsPanel.getByRole('button', { name: 'Clear: Review a proposed plan' }).click();
        await clearResult.getByText('Cleared 1').waitFor();
        assert.deepEqual(await page.evaluate(() => window.dismissCalls), [{ codes: ['REQUEST-0'] }]);
        assert.equal(await requestsPanel.getByText('Review a proposed plan').count(), 0);
        assert(await requestsPanel.getByText('Showing 3 of 4 requests returned, in inbox order.').isVisible());
        assert.equal(await page.evaluate(() => window.badge), 2, 'the home-screen badge follows the Worker');
        assert(await page.evaluate(() => window.deviceCleared >= 1), "the phone's notifications are closed too");
        assert.equal(await page.evaluate(() => window.clearCalls.length), 0, 'a request is not an email thread');
        await clearResult.getByRole('button', { name: 'Undo' }).click();
        await requestsPanel.getByText('Review a proposed plan').waitFor();
        assert.deepEqual(await page.evaluate(() => window.dismissCalls[1]), { codes: ['REQUEST-0'], undo: true });
        await requestsPanel.getByRole('button', { name: 'Clear: Confirm your next step' }).click();
        await clearResult.getByText('Cleared 1').waitFor();
        await page.getByRole('button', { name: 'Refresh Today' }).click();
        await settled(page);
        assert.equal(await requestsPanel.getByText('Confirm your next step').count(), 0, 'a refresh that lands before the Worker catches up keeps it hidden');
        await requestsPanel.getByRole('button', { name: 'Clear all requests' }).click();
        await requestsPanel.getByText(/last check returned no open requests/).waitFor();
        assert.deepEqual(await page.evaluate(() => window.dismissCalls[3]), { codes: ['REQUEST-0', 'REQUEST-1', 'REQUEST-3', 'REQUEST-4'] }, 'Clear all takes every request, not only the 3 on screen');
        assert(await clearResult.getByText('Cleared 4').isVisible());
        assert.equal(await requestsPanel.getByRole('button', { name: 'Clear all requests' }).count(), 0);
        assert.equal(await urgentPanel.locator('li').count(), 4, 'clearing requests leaves urgent email alone');
        await urgentPanel.getByRole('button', { name: 'Clear: Synthetic labelled email 1' }).click();
        await clearResult.getByText('Cleared 1').waitFor();
        assert.deepEqual(await page.evaluate(() => window.dismissCalls[4]), { codes: ['E1'] }, 'the merged Agent Inbox question is cleared with its email');
        assert.deepEqual(await page.evaluate(() => window.clearCalls[0]), { items: [{ key: urgentItems[0].key, receivedAt: urgentItems[0].receivedAt }] });
        assert.equal(await urgentPanel.locator('li').count(), 3);
        assert.equal(await urgentPanel.getByText('Synthetic labelled email 1').count(), 0);
        await urgentPanel.getByRole('button', { name: 'Clear all urgent email' }).click();
        await urgentPanel.getByText('Nothing urgent right now.').waitFor();
        assert.deepEqual(await page.evaluate(() => window.dismissCalls[5]), { codes: ['E2'] });
        assert.deepEqual(await page.evaluate(() => window.clearCalls[1]), { items: urgentItems.slice(1).map(i => ({ key: i.key, receivedAt: i.receivedAt })) });
        assert(await clearResult.getByText('Cleared 3').isVisible());
        await clearResult.getByRole('button', { name: 'Undo' }).click();
        await page.waitForFunction(() => document.querySelectorAll('section[aria-labelledby="urgent-email-heading"] li').length === 3);
        assert.deepEqual(await page.evaluate(() => [window.dismissCalls[6], window.clearCalls[2]]), [{ codes: ['E2'], undo: true }, { items: urgentItems.slice(1).map(i => ({ key: i.key })), undo: true }]);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        assert((await page.evaluate(() => window.calls)).every(c => c.method === 'GET'));
        await close(page);
        page = await setup('email-cards', 390, false, 'items');
        await settled(page);
        await page.evaluate(() => { window.dismissMode = 'error'; window.clearMode = 'error'; });
        await page.locator('section[aria-labelledby="requests-heading"]').getByRole('button', { name: 'Clear: Review a proposed plan' }).click();
        await page.getByText("Couldn't clear that. Try again.").waitFor();
        assert(await page.getByText('Review a proposed plan').isVisible(), 'a failed clear puts the row back');
        assert.equal(await page.getByRole('button', { name: 'Undo' }).count(), 0, 'nothing to undo');
        await page.evaluate(() => { window.dismissMode = 'ok'; });
        urgentPanel = page.locator('section[aria-labelledby="urgent-email-heading"]');
        await urgentPanel.getByRole('button', { name: 'Clear: Synthetic labelled email 1' }).click();
        await page.getByText(/Some of that couldn't be cleared/).waitFor();
        assert(await urgentPanel.getByText('Synthetic labelled email 1').isVisible(), 'the email whose clear failed stays listed');
        assert.equal(await urgentPanel.getByText(/Agent Inbox \(inbox-triage\)/).count(), 0, 'its cleared question is gone from it');
        await close(page);
        console.log('PASS clearing: opening clears nothing; x and Clear all per panel; cards via the Worker, threads via /api/urgent-email/clear; Undo; a refresh keeps it hidden; failures put rows back');
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
        // Experiment arm card (docs/experiment-framework.md 4.4): nothing when no trial is registered.
        page = await setup();
        await settled(page);
        const armCard = () => page.locator('[role=region][aria-labelledby="experiment-heading"]');
        assert.equal(await armCard().count(), 0, 'no trial registered: no experiment card');
        assert.equal(await page.getByText(/experiment/i).count(), 0, 'no trial registered: Today does not mention experiments');
        assert.equal(await page.evaluate(() => window.experimentCalls), 1);
        await page.evaluate(() => window.experimentMode = 'not_connected');
        await page.getByRole('button', { name: 'Refresh Today' }).click();
        await settled(page);
        assert.equal(await page.getByText(/experiment/i).count(), 0, 'tables not applied: nothing shown');
        await page.evaluate(() => window.experimentMode = 'active');
        await page.getByRole('button', { name: 'Refresh Today' }).click();
        await settled(page);
        assert(await armCard().getByRole('heading', { name: "Today's experiment arm" }).isVisible());
        assert(await armCard().getByText('Arm A', { exact: true }).isVisible());
        assert(await armCard().getByText('Synthetic instruction for arm A.').isVisible());
        assert(await armCard().getByText('EXP-901: A synthetic evening routine. Day 12 of 232 (Fri, Jan 18).').isVisible());
        assert(await armCard().getByText(/Opening Today does not record whether you followed it/).isVisible());
        assert.equal(await armCard().locator('a, button, input').count(), 0, 'the arm card is read-only: nothing to tap');
        assert.equal(await page.locator('section').first().locator('li').count(), 3, 'the other panels are unchanged');
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await page.evaluate(() => window.experimentMode = 'error');
        await page.getByRole('button', { name: 'Refresh Today' }).click();
        await settled(page);
        assert(await armCard().getByText('Arm A', { exact: true }).isVisible(), 'a failed refresh keeps the last arm');
        assert(await armCard().getByText(/Couldn't refresh the experiment arm/).isVisible());
        await page.evaluate(() => window.experimentMode = 'upcoming');
        await page.getByRole('button', { name: 'Refresh Today' }).click();
        await settled(page);
        assert(await armCard().getByText('EXP-901: A synthetic evening routine starts Mon, Jan 7 and runs 232 days. No arm today.').isVisible());
        assert.equal(await armCard().getByText(/Arm [AB]/).count(), 0, 'no arm before the first day');
        assert((await page.evaluate(() => window.calls)).every(c => c.method === 'GET'));
        await close(page);
        page = await setup('healthy', 390, false, 'not_connected', 'error');
        await settled(page);
        assert(await page.getByText("Couldn't check today's experiment arm. Try refreshing.").isVisible(), 'a failed check is not "no experiment"');
        assert.equal(await armCard().count(), 0);
        assert.equal(await page.locator('section').first().locator('li').count(), 3, 'agent requests stay independent of the experiment check');
        await close(page);
        page = await setup('healthy', 390, false, 'not_connected', 'invalid');
        await settled(page);
        assert(await page.getByText("Couldn't check today's experiment arm. Try refreshing.").isVisible(), 'an unrecognised answer is an error');
        assert.equal(await page.getByText('never shown').count(), 0);
        await close(page);
        console.log('PASS experiment arm: nothing when none / not connected, arm + instruction when active, read-only, failed refresh keeps the arm, error is not none, no arm before the start');
        const texts = async locator => (await locator.allTextContents()).map(t => t.replace(/\s+/g, ' ').trim());
        const refresh = async (p, calendarMode) => { await p.evaluate(m => { window.calendarMode = m; }, calendarMode); await p.getByRole('button', { name: 'Refresh Today' }).click(); await settled(p); };
        page = await setup();
        await settled(page);
        let calendarPanel = page.locator('section[aria-labelledby="calendar-heading"]');
        assert.equal(await page.locator('section').first().getAttribute('aria-labelledby'), 'requests-heading', 'Needs your input stays the first panel');
        assert(await calendarPanel.getByText("The calendar sync isn't connected yet.").isVisible());
        assert.equal(await calendarPanel.locator('li').count(), 0);
        assert.equal(await calendarPanel.getByText('Nothing on the calendar.').count(), 0, 'not connected is not an empty day');
        assert.deepEqual(await page.evaluate(() => window.calendarCalls), await page.evaluate(() => ['/api/calendar/events?from=' + window.calendarDays[0] + '&to=' + window.calendarDays[1]]), 'one GET for today..tomorrow in the page zone');
        assert.equal(await calendarPanel.getByRole('link', { name: 'Open calendar' }).getAttribute('href'), '/health');
        assert.equal(await calendarPanel.locator('a').count(), 1, 'the panel links only to the calendar page');
        await refresh(page, 'never_ran');
        assert(await calendarPanel.getByText("The calendar sync isn't connected yet.").isVisible(), 'a table with no sync run and no events is not an empty calendar');
        await refresh(page, 'empty');
        assert.equal(await calendarPanel.getByText('Nothing on the calendar.').count(), 2, 'today and tomorrow are both shown as empty');
        assert.equal(await calendarPanel.getByText(/isn't connected yet/).count(), 0);
        assert(await calendarPanel.getByText('Calendar last synced 20 min ago.').isVisible());
        await refresh(page, 'events');
        const todayList = calendarPanel.getByRole('list', { name: 'Calendar events today' });
        const tomorrowList = calendarPanel.getByRole('list', { name: 'Calendar events tomorrow' });
        assert.deepEqual(await texts(todayList.locator('li p:nth-child(2)')), ['Synthetic all-day block', 'Synthetic morning review', 'Synthetic afternoon sync'], 'all-day first, then by start time');
        assert.deepEqual(await texts(todayList.locator('li p:first-child')), ['All day · main', '9:00 AM - 10:00 AM · main', '2:30 PM - 3:00 PM · Tentative · side'], 'time in the page zone, calendar label, tentative marked');
        assert(await todayList.getByText('Room 4, North wing').isVisible());
        assert.deepEqual(await texts(tomorrowList.locator('li p:nth-child(2)')), ['Synthetic planning session']);
        assert.equal(await calendarPanel.getByText(/Synthetic out of range|Synthetic overnight/).count(), 0, 'the padded server range is trimmed to today and tomorrow; an event that started yesterday evening is not repeated');
        assert.equal(await calendarPanel.getByText('Nothing on the calendar.').count(), 0);
        assert(await calendarPanel.getByText('Read-only: opening Today changes nothing on your calendar.').isVisible());
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await refresh(page, 'error');
        assert(await calendarPanel.getByText(/Couldn't refresh the calendar/).isVisible());
        assert.equal(await calendarPanel.locator('li').count(), 4, 'a failed refresh keeps the last list');
        assert.equal(await page.locator('section').first().locator('li').count(), 3, 'agent requests stay independent of the calendar');
        assert(await page.getByText('A book for steady progress').isVisible());
        assert((await page.evaluate(() => window.calendarCalls)).every(u => u.startsWith('/api/calendar/events?from=')));
        assert((await page.evaluate(() => window.calls)).every(c => c.method === 'GET'));
        await close(page);
        page = await setup('healthy', 390, false, 'not_connected', 'none', 'error');
        await settled(page);
        calendarPanel = page.locator('section[aria-labelledby="calendar-heading"]');
        assert(await calendarPanel.getByText("Couldn't check the calendar. Try refreshing.").isVisible());
        assert.equal(await calendarPanel.getByText('Nothing on the calendar.').count(), 0, 'an error is not empty');
        assert.equal(await calendarPanel.getByText(/isn't connected yet/).count(), 0, 'an error is not the not-connected state');
        assert.equal(await page.locator('section').first().locator('li').count(), 3);
        await close(page);
        page = await setup('healthy', 390, false, 'not_connected', 'none', 'stale_sync');
        await settled(page);
        calendarPanel = page.locator('section[aria-labelledby="calendar-heading"]');
        assert(await calendarPanel.getByText('Calendar last synced 6 h ago (that run: partial); newer changes may be missing.').isVisible());
        assert.equal(await calendarPanel.locator('li').count(), 4);
        await close(page);
        page = await setup('healthy', 390, true, 'not_connected', 'none', 'events');
        await settled(page);
        assert.equal(await page.locator('section[aria-labelledby="calendar-heading"] li').count(), 4, 'Strict Mode: same list, no console error');
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        await close(page);
        console.log('PASS calendar: not connected vs never ran vs empty vs events, today + tomorrow in the page zone, all-day first, read-only link only, failed refresh keeps list, error is not empty, stale sync flagged');
        assert.deepEqual(errors, []);
        console.log('PASS no browser exceptions; no health data, credentials, or screenshots collected');
    }
    finally {
        await browser.close();
    }
})().catch(e => { console.error(e); process.exit(1); });
