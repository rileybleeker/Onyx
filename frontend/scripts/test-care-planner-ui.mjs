/**
 * Offline UI regression for /health: the real HealthClient in an isolated Next fixture, with the
 * /api/care/* calls answered by an in-memory stand-in inside this script. No database, no
 * production env, synthetic items only. Needs a browser, so CI skips it (*-ui.mjs); run it by hand:
 *   cd frontend && node scripts/test-care-planner-ui.mjs
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, copyFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';

const frontend = fileURLToPath(new URL('..', import.meta.url));
const fixture = await mkdtemp(path.join(tmpdir(), 'onyx-care-ui-'));
for (const dir of ['src/app/health', 'src/lib']) await mkdir(path.join(fixture, dir), { recursive: true });
await symlink(path.join(frontend, 'node_modules'), path.join(fixture, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
for (const file of ['src/lib/care-planner.ts', 'src/lib/care-items.ts', 'src/lib/care-google.ts', 'src/app/health/HealthClient.tsx', 'src/app/health/CareCalendar.tsx', 'src/app/health/CalendarConnectionCard.tsx', 'src/app/health/CalendarEventsCard.tsx', 'src/app/health/useCalendarEvents.ts', 'src/lib/calendar-events.ts', 'src/lib/urgent-email.ts', 'src/app/globals.css']) {
  await copyFile(path.join(frontend, file), path.join(fixture, file));
}
await copyFile(path.join(frontend, 'postcss.config.mjs'), path.join(fixture, 'postcss.config.mjs'));
// The real module reads the table with the service role; the page only needs its type.
await writeFile(path.join(fixture, 'src/lib/care-items-server.ts'), "import type { CareItem } from '@/lib/care-planner';\nexport type CareLoad = { state: 'ready'; items: CareItem[] } | { state: 'error' };\n");

const A = '10000000-0000-4000-8000-000000000001', B = '10000000-0000-4000-8000-000000000002';
const seed = [
  { id: A, title: 'Synthetic yearly visit', kind: 'medical', due: '2031-05-20', time: '09:30', tz: 'America/New_York', months: 12, booked: true, notes: 'Synthetic note', archived: false, completedOn: null },
  { id: B, title: 'Synthetic one-off errand', kind: 'personal', due: '2031-07-01', time: null, tz: 'America/New_York', months: 0, booked: false, notes: '', archived: false, completedOn: null },
];
await writeFile(path.join(fixture, 'src/app/initial.json'), JSON.stringify(seed));
await writeFile(path.join(fixture, 'src/app/page.tsx'), `import HealthClient from './health/HealthClient';
import seed from './initial.json';
export const dynamic = 'force-dynamic';
export default async function Page({ searchParams }: { searchParams: Promise<{ state?: string; cal?: string }> }) {
  const { state, cal } = await searchParams;
  const initial = state === 'error' ? { state: 'error' } : { state: 'ready', items: state === 'empty' ? [] : seed };
  const off = { configured: false, connected: false, calendarName: 'Onyx care', connectedAt: null, lastSync: null };
  const calendar = cal === 'ready' ? { ...off, configured: true }
    : cal === 'on' ? { ...off, configured: true, connected: true, connectedAt: '2031-01-01T00:00:00.000Z' }
    : cal === 'none' ? undefined : off;
  return <HealthClient initial={initial as never} calendar={calendar as never} />;
}
`);
await writeFile(path.join(fixture, 'src/app/layout.tsx'), 'import "./globals.css"; export default function Layout({children}: {children: React.ReactNode}) {return <html lang="en" className="dark"><body className="bg-surface text-text-primary antialiased font-sans">{children}</body></html>}');
await writeFile(path.join(fixture, 'package.json'), '{"private":true}');
await writeFile(path.join(fixture, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2017', lib: ['dom', 'dom.iterable', 'esnext'], skipLibCheck: true, strict: true, noEmit: true, esModuleInterop: true, module: 'esnext', moduleResolution: 'bundler', resolveJsonModule: true, isolatedModules: true, jsx: 'preserve', plugins: [{ name: 'next' }], paths: { '@/*': ['./src/*'] } }, include: ['**/*.ts', '**/*.tsx'], exclude: ['node_modules'] }));

// Deliberately no production secrets, inherited NODE_OPTIONS, or Supabase variables.
const env = { NEXT_TELEMETRY_DISABLED: '1' };
for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA']) if (process.env[key]) env[key] = process.env[key];
const serverCode = `const next=require(${JSON.stringify(path.join(frontend, 'node_modules/next'))});
const app=next({dev:true,dir:${JSON.stringify(fixture)},hostname:'127.0.0.1',port:0});
app.prepare().then(()=>{const server=require('node:http').createServer(app.getRequestHandler());
server.listen(0,'127.0.0.1',()=>console.log('http://127.0.0.1:'+server.address().port+' Ready in 0ms'));});`;
const server = spawn(process.execPath, ['-e', serverCode], { cwd: fixture, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
let output = '', browser;
try {
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Local fixture startup timed out. ' + output.slice(-2000))), 60000);
    const collect = chunk => { output += chunk.toString(); const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/); if (match && /Ready in/.test(output)) { clearTimeout(timer); resolve(match[0]); } };
    server.stdout.on('data', collect); server.stderr.on('data', collect);
    server.once('exit', code => { clearTimeout(timer); reject(new Error('Local fixture exited ' + code + ' ' + output.slice(-2000))); });
  });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'America/New_York' });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const errors = [], blocked = [];
  page.on('pageerror', e => errors.push(e.message));

  // ---- the stand-in for /api/care/*: same contract as the real routes ----
  const store = new Map(seed.map(item => [item.id, item]));
  const removed = new Map(), importKeys = new Set();
  // The one outside address the page may leave for. It is answered here; the real Google is never contacted.
  const CONSENT_STUB = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=fixture';
  const calls = [], googleCalls = [], left = [], eventCalls = [];
  // Synced calendar events for the current month (the page's zone is America/New_York): one
  // all-day and one timed event today, both invented.
  let eventsMode = 'ready';
  const nyToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const nyOffset = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'longOffset' }).formatToParts(new Date()).find(p => p.type === 'timeZoneName').value.replace('GMT', '') || '+00:00';
  const syntheticEvents = () => [
    { key: 'ev-timed', title: 'Synthetic calendar meeting', allDay: false, startAt: new Date(`${nyToday}T09:00:00${nyOffset}`).toISOString(), endAt: new Date(`${nyToday}T10:00:00${nyOffset}`).toISOString(), startDate: nyToday, endDate: nyToday, calendar: 'main', account: 'acct one', location: 'Synthetic room', status: 'confirmed', recurring: false },
    { key: 'ev-day', title: 'Synthetic all-day event', allDay: true, startAt: null, endAt: null, startDate: nyToday, endDate: nyToday, calendar: 'main', account: 'acct one', location: null, status: 'confirmed', recurring: false },
  ];
  let failNext = false, startUrl = CONSENT_STUB;
  const answer = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/*', route => {
    const request = route.request(), target = new URL(request.url());
    if (request.url() === CONSENT_STUB) { left.push(request.url()); return route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Consent page stand-in</h1>' }); }
    if (target.origin !== new URL(url).origin) { blocked.push(request.url()); return route.abort(); }
    if (target.pathname === '/api/calendar/events') {
      eventCalls.push(`${request.method()} ${target.search}`);
      if (eventsMode === 'error') return answer(route, { error: 'calendar unavailable' }, 500);
      if (eventsMode === 'not_connected') return answer(route, { status: 'not_connected', lastSync: null });
      return answer(route, { status: 'ready', truncated: false, events: syntheticEvents(), lastSync: { at: new Date(Date.now() - 20 * 60000).toISOString(), status: 'success', error: null },
        calendars: [{ account: 'acct one', calendar: 'main', events: 2 }] });
    }
    if (!target.pathname.startsWith('/api/care/')) return route.continue();
    if (target.pathname.startsWith('/api/care/google/')) {
      googleCalls.push(`${request.method()} ${target.pathname} origin=${request.headers().origin === url}`);
      if (failNext) { failNext = false; return answer(route, { error: 'x' }, 500); }
      if (target.pathname.endsWith('/start')) return answer(route, { url: startUrl });
      if (target.pathname.endsWith('/sync')) return answer(route, { sync: { at: new Date().toISOString(), ok: true, created: 2, updated: 1, removed: 0, unchanged: 3, failed: 0, error: null } });
      if (target.pathname.endsWith('/disconnect')) return answer(route, { configured: true, connected: false, calendarName: 'Onyx care', connectedAt: null, lastSync: null });
      return answer(route, { error: 'unexpected' }, 404);
    }
    const method = request.method(), body = request.postData() ? request.postDataJSON() : null;
    calls.push({ method, path: target.pathname, body, origin: request.headers().origin ?? null, type: request.headers()['content-type'] ?? null });
    if (failNext) { failNext = false; return answer(route, { error: 'could not save' }, 500); }
    if (target.pathname === '/api/care/items') {
      if (method === 'GET') return answer(route, { items: [...store.values()] });
      store.set(body.id, body);
      return answer(route, { item: body }, 201);
    }
    if (target.pathname === '/api/care/items/import') {
      let copied = 0;
      for (const local of body.items) {
        if (importKeys.has(local.id)) continue;
        importKeys.add(local.id); copied++;
        const id = randomUUID();
        store.set(id, { ...local, id, kind: 'other', time: null, tz: body.tz, notes: '', completedOn: null });
      }
      return answer(route, { copied, skipped: body.items.length - copied, items: [...store.values()] });
    }
    const id = target.pathname.split('/').pop();
    if (method === 'DELETE') {
      if (!store.has(id)) return answer(route, { error: 'item not found' }, 404);
      removed.set(id, store.get(id)); store.delete(id);
      return answer(route, { id });
    }
    if (body.removed === false) { store.set(id, removed.get(id)); return answer(route, { item: store.get(id) }); }
    if (!store.has(id)) return answer(route, { error: 'item not found' }, 404);
    store.set(id, { ...store.get(id), ...body });
    return answer(route, { item: store.get(id) });
  });
  const last = () => calls[calls.length - 1];
  const upcoming = page.locator('section', { has: page.getByRole('heading', { name: 'Upcoming care', exact: true }) });
  const card = title => upcoming.locator('article', { hasText: title });
  // Next's own route announcer also has role=alert; these are the page's messages.
  const alerts = page.locator('p[role="alert"]');
  const idle = () => page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));

  // ---- data state: server-provided items render, nothing is requested, sample data stays local ----
  await page.goto(url, { timeout: 180000 });
  await page.getByRole('heading', { name: 'Health & appointments', exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Private planning, saved in Onyx', exact: true }).waitFor();
  await card('Synthetic yearly visit').waitFor();
  assert.match(await card('Synthetic yearly visit').innerText(), /2031-05-20 at 9:30 AM · Medical · Booked by you · Every 12 months after completion/);
  assert.match(await card('Synthetic yearly visit').innerText(), /Synthetic note/);
  assert.equal(await page.getByLabel(/Show sample data/).isChecked(), false);
  await page.getByLabel(/Show sample data/).check();
  await page.getByText('Sample: skin check').first().waitFor();
  assert.equal(await upcoming.getByText(/Sample:/).count(), 0, 'sample items are never in the editable list');
  await page.getByLabel(/Show sample data/).uncheck();
  assert.equal(await page.getByRole('button', { name: /^Connect Google Calendar$/ }).isDisabled(), true);
  assert.equal(await page.getByRole('heading', { name: "Couldn't load your care items" }).count(), 0);
  assert.equal(await page.getByText(/This browser holds/).count(), 0, 'no copy offer without a browser-saved planner');
  assert.deepEqual(calls, [], 'rendering and sample data make no API call');

  // ---- synced calendar events: read-only, next to the care items, never one of them ----
  const eventsCard = page.locator('[aria-label="Calendar events sync"]');
  await eventsCard.getByRole('heading', { name: 'Your calendar events: synced (read-only)', exact: true }).waitFor();
  assert.match(await eventsCard.innerText(), /main \(acct one\)\s*2 events/);
  assert.match(await eventsCard.innerText(), /Last sync 20 min ago\./);
  assert.equal(await eventsCard.locator('button').count(), 0, 'the read-only card has nothing to press');
  const calendarBox = page.locator('section[aria-label="Care calendar"]');
  const todayCell = calendarBox.locator('td', { has: page.locator('span.sr-only', { hasText: '(today)' }) });
  assert.deepEqual(await todayCell.locator('li').evaluateAll(list => list.map(li => li.firstChild.textContent)), ['Synthetic all-day event', 'Synthetic calendar meeting'], 'all-day first, then by time');
  assert.match(await todayCell.locator('li').nth(1).getAttribute('title'), /^Synthetic calendar meeting: 9:00 AM - 10:00 AM, Synthetic room, Google Calendar: main \(read-only\)$/);
  await calendarBox.getByRole('button', { name: 'Agenda', exact: true }).click();
  assert.match(await calendarBox.locator('li', { hasText: 'Synthetic calendar meeting' }).innerText(), new RegExp(`${nyToday} · 9:00 AM - 10:00 AM · Synthetic room · Google Calendar: main \\(read-only\\)`));
  assert.match(await calendarBox.locator('li', { hasText: 'Synthetic all-day event' }).innerText(), /All day · Google Calendar: main \(read-only\)/);
  await calendarBox.getByRole('button', { name: 'Month', exact: true }).click();
  assert.equal(await upcoming.getByText(/Synthetic (calendar meeting|all-day event)/).count(), 0, 'calendar events are never in the editable care list');
  assert.equal(await page.locator('section[aria-label="Due soon"]').getByText(/Synthetic (calendar meeting|all-day event)/).count(), 0, 'nor in Due soon');
  assert.ok(eventCalls.length >= 1 && eventCalls.every(c => /^GET \?from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}&summary=1$/.test(c)), 'the events route is only ever read');
  assert.deepEqual(calls, [], 'showing calendar events sends nothing to the care-item routes');
  assert.deepEqual(googleCalls, [], 'and nothing to the care-items -> Google routes');
  // A failed read and a missing table are their own states; the care items are unaffected by either.
  for (const [mode, heading] of [['error', "Your calendar events: couldn't be checked"], ['not_connected', 'Your calendar events: not synced yet']]) {
    eventsMode = mode;
    await page.goto(url);
    await eventsCard.getByRole('heading', { name: heading, exact: true }).waitFor();
    await card('Synthetic yearly visit').waitFor();
    assert.equal(await calendarBox.getByText(/Synthetic (calendar meeting|all-day event)/).count(), 0);
  }
  eventsMode = 'ready';
  await page.goto(url);
  await eventsCard.getByRole('heading', { name: 'Your calendar events: synced (read-only)', exact: true }).waitFor();
  eventCalls.length = 0;

  // ---- add: shown at once, POSTed same-origin as JSON with every field ----
  await page.getByLabel('Short label').fill('Synthetic new visit');
  await page.getByLabel('Kind').selectOption('dental');
  await page.getByLabel('Due date').fill('2031-06-15');
  assert.equal(await page.getByLabel('Time zone of the appointment').count(), 0, 'no zone picker until a time is set');
  await page.getByLabel('Time (optional)').fill('14:30');
  assert.equal(await page.getByLabel('Time zone of the appointment').inputValue(), 'America/New_York');
  await page.getByLabel('Time zone of the appointment').selectOption('Europe/Madrid');
  await page.getByLabel('Note (optional)').fill('Synthetic reminder text');
  await page.getByRole('button', { name: 'Add item', exact: true }).click();
  await card('Synthetic new visit').waitFor();
  await idle();
  assert.equal(last().method, 'POST');
  assert.equal(last().path, '/api/care/items');
  assert.equal(last().origin, url);
  assert.match(last().type, /^application\/json/);
  const { id: newId, ...sent } = last().body;
  assert.match(newId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(sent, { title: 'Synthetic new visit', kind: 'dental', due: '2031-06-15', time: '14:30', tz: 'Europe/Madrid', months: 0, booked: false, notes: 'Synthetic reminder text', archived: false, completedOn: null });
  // The reader is in New York, the appointment in Madrid: both clocks are shown.
  assert.match(await card('Synthetic new visit').innerText(), /2031-06-15 at 2:30 PM \(Europe\/Madrid; 8:30 AM your time\) · Dental · Due — needs booking/);
  assert.equal(await page.getByLabel('Short label').inputValue(), '');
  assert.equal(await alerts.count(), 0);

  // ---- a failed add is taken back, says so, and puts the entry back in the form ----
  failNext = true;
  await page.getByLabel('Short label').fill('Synthetic failing item');
  await page.getByLabel('Due date').fill('2031-08-01');
  await page.getByRole('button', { name: 'Add item', exact: true }).click();
  await alerts.filter({ hasText: "Couldn't save that to Onyx, so it was not changed." }).waitFor();
  assert.equal(await card('Synthetic failing item').count(), 0);
  assert.equal(await page.getByLabel('Short label').inputValue(), 'Synthetic failing item');
  assert.equal(await page.getByLabel('Due date').inputValue(), '2031-08-01');
  assert.equal(store.size, 3);
  assert.equal(await page.getByRole('button', { name: 'Undo last change' }).count() > 0, true, 'the earlier successful change can still be undone');
  await page.getByLabel('Short label').fill('');

  // ---- a failed change to one item leaves the others alone ----
  failNext = true;
  await card('Synthetic one-off errand').getByRole('button', { name: 'Archive' }).click();
  await alerts.waitFor();
  await idle();
  await card('Synthetic one-off errand').waitFor();
  assert.equal(await page.getByText('Archived and completed items').count(), 0);
  assert.equal(await card('Synthetic new visit').count(), 1);

  // ---- complete: a one-off is archived; Undo sends the opposite change ----
  await card('Synthetic one-off errand').getByRole('button', { name: 'Mark complete today' }).click();
  await page.getByText('Archived and completed items').waitFor();
  await idle();
  assert.equal(last().method, 'PATCH');
  assert.equal(last().path, `/api/care/items/${B}`);
  assert.deepEqual(Object.keys(last().body).sort(), ['archived', 'completedOn']);
  assert.equal(last().body.archived, true);
  assert.match(last().body.completedOn, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(await card('Synthetic one-off errand').count(), 0);
  await page.getByRole('button', { name: 'Undo last change' }).click();
  await card('Synthetic one-off errand').waitFor();
  await page.getByText('Undone.', { exact: true }).waitFor();
  assert.deepEqual(last().body, { archived: false, completedOn: null });
  assert.equal(await page.getByRole('button', { name: 'Undo last change' }).count(), 0);

  // ---- complete a repeating item: due moves N months from today, booked clears, time is kept ----
  await card('Synthetic yearly visit').getByRole('button', { name: 'Mark complete today' }).click();
  await idle();
  assert.deepEqual(Object.keys(last().body).sort(), ['booked', 'completedOn', 'due']);
  assert.equal(last().body.booked, false);
  assert.notEqual(last().body.due, '2031-05-20');
  assert.match(await card('Synthetic yearly visit').innerText(), / at 9:30 AM · Medical · Due — needs booking/);
  await page.getByRole('button', { name: 'Undo last change' }).click();
  await page.getByText('Undone.', { exact: true }).waitFor();
  assert.deepEqual(last().body, { due: '2031-05-20', booked: true, completedOn: null });
  assert.match(await card('Synthetic yearly visit').innerText(), /2031-05-20 at 9:30 AM · Medical · Booked by you/);

  // ---- edit ----
  await card('Synthetic one-off errand').getByRole('button', { name: 'Edit' }).click();
  await page.getByRole('heading', { name: 'Edit care item', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Short label').inputValue(), 'Synthetic one-off errand');
  assert.equal(await card('Synthetic one-off errand').getByRole('button', { name: 'Archive' }).isDisabled(), true);
  await page.getByLabel('Repeat after completion').selectOption('6');
  await page.getByLabel('I have already booked this appointment').check();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await page.getByRole('heading', { name: 'Add care item', exact: true }).waitFor();
  await idle();
  assert.equal(last().method, 'PATCH');
  assert.deepEqual(last().body, { title: 'Synthetic one-off errand', kind: 'personal', due: '2031-07-01', time: null, tz: 'America/New_York', months: 6, booked: true, notes: '' });
  assert.match(await card('Synthetic one-off errand').innerText(), /Booked by you · Every 6 months after completion/);

  // ---- archive, remove (soft), undo the removal ----
  await card('Synthetic new visit').getByRole('button', { name: 'Archive' }).click();
  await idle();
  await page.getByText('Archived and completed items').click();
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('details'));
  assert.equal(last().method, 'DELETE');
  assert.equal(last().path, `/api/care/items/${newId}`);
  assert.equal(last().body, null);
  assert.equal(store.has(newId), false);
  await page.getByRole('button', { name: 'Undo last change' }).click();
  await page.getByText('Archived and completed items').waitFor();
  assert.deepEqual(last().body, { removed: false });
  assert.equal(store.has(newId), true);

  // ---- layout: no sideways scroll on a phone or a desktop ----
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await page.screenshot({ path: path.join(fixture, `health-${width}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 390, height: 844 });

  // ---- load failed is its own state (not an empty list), and Try again recovers ----
  calls.length = 0;
  await page.goto(url + '/?state=error');
  await page.getByRole('heading', { name: "Couldn't load your care items", exact: true }).waitFor();
  await page.getByText('This is not an empty list.', { exact: false }).waitFor();
  assert.equal(await page.getByRole('heading', { name: 'Add care item' }).count(), 0, 'no form over an unknown list');
  assert.equal(await page.getByText('No care items yet.', { exact: false }).count(), 0);
  assert.deepEqual(calls, []);
  await page.getByRole('button', { name: 'Try again' }).click();
  await card('Synthetic yearly visit').waitFor();
  assert.deepEqual(calls.map(c => `${c.method} ${c.path}`), ['GET /api/care/items']);
  assert.equal(await page.getByRole('heading', { name: "Couldn't load your care items" }).count(), 0);
  failNext = true;
  await page.goto(url + '/?state=error');
  await page.getByRole('button', { name: 'Try again' }).click();
  await page.waitForFunction(() => !document.body.innerText.includes('Loading your care items'));
  await page.getByRole('heading', { name: "Couldn't load your care items", exact: true }).waitFor();

  // ---- empty is a different state again ----
  await page.goto(url + '/?state=empty');
  await page.getByText('No care items yet. Add a date when you know one.', { exact: true }).waitFor();
  await page.getByText('Nothing due in the next 30 days.', { exact: true }).waitFor();
  await page.getByRole('heading', { name: 'Add care item', exact: true }).waitFor();

  // ---- the old browser planner: one button, idempotent, then no more offer ----
  const saved = [
    { id: 'local-fixture-1', title: 'Synthetic browser item one', due: '2031-09-01', months: 6, booked: false, archived: false },
    { id: 'local-fixture-2', title: 'Synthetic browser item two', due: '2031-10-01', months: 0, booked: true, archived: true },
  ];
  await page.evaluate(raw => localStorage.setItem('onyx-care-planner-v1', raw), JSON.stringify(saved));
  calls.length = 0;
  await page.goto(url);
  await page.getByText('This browser holds 2 items saved by the earlier version of this page.', { exact: true }).waitFor();
  assert.deepEqual(calls, [], 'nothing is copied until the button is pressed');
  failNext = true;
  await page.getByRole('button', { name: 'Copy all 2 into Onyx' }).click();
  await alerts.filter({ hasText: "Couldn't copy the items saved in this browser." }).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('onyx-care-planner-v1-copied')), null, 'a failed copy keeps the offer');
  await page.getByRole('button', { name: 'Copy all 2 into Onyx' }).click();
  await page.getByText('Copied 2 items into Onyx.', { exact: true }).waitFor();
  assert.equal(last().path, '/api/care/items/import');
  assert.deepEqual(last().body, { items: saved, tz: 'America/New_York' });
  await card('Synthetic browser item one').waitFor();
  assert.equal(await page.getByRole('button', { name: /Copy .* into Onyx/ }).count(), 0);
  assert.notEqual(await page.evaluate(() => localStorage.getItem('onyx-care-planner-v1-copied')), null);
  assert.equal(await page.evaluate(() => localStorage.getItem('onyx-care-planner-v1')), JSON.stringify(saved), 'the browser copy is not touched by the copy');
  calls.length = 0;
  await page.goto(url);
  await page.getByText(/now in Onyx\. The old browser copy is no longer used\./).waitFor();
  assert.equal(await page.getByRole('button', { name: /Copy .* into Onyx/ }).count(), 0, 'copied once: not offered again');
  await page.getByRole('button', { name: 'Remove the browser copy' }).click();
  await page.waitForFunction(() => !document.body.innerText.includes('browser copy'));
  assert.equal(await page.evaluate(() => localStorage.getItem('onyx-care-planner-v1')), null);
  assert.deepEqual(calls, []);
  // A damaged browser copy is reported and left exactly as it was.
  await page.evaluate(() => localStorage.setItem('onyx-care-planner-v1', '{not json'));
  await page.goto(url);
  await page.getByText(/older saved planner that cannot be read/).waitFor();
  assert.equal(await page.evaluate(() => localStorage.getItem('onyx-care-planner-v1')), '{not json');
  assert.equal(await page.getByRole('button', { name: /Copy .* into Onyx/ }).count(), 0);

  // ---- Google Calendar card: not connected by default; no request until a button is pressed ----
  const cardBox = page.getByLabel('Google Calendar connection');
  const cardAlert = cardBox.locator('p[role="alert"]');
  for (const variant of ['', '/?cal=none']) {
    await page.goto(url + variant);
    await page.getByRole('heading', { name: 'Google Calendar: not connected', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Connect Google Calendar', exact: true }).isDisabled(), true);
    await cardBox.getByText(/Not set up yet: Onyx has no Google credentials/).waitFor();
    await cardBox.getByText('Never requested', { exact: true }).waitFor();
  }
  assert.deepEqual(googleCalls, [], 'showing the card contacts nothing');
  // Set up, not connected: Connect asks the server for the consent URL and leaves only for the real Google consent page.
  await page.goto(url + '/?cal=ready');
  startUrl = 'https://evil.example/phish';
  await page.getByRole('button', { name: 'Connect Google Calendar', exact: true }).click();
  await cardAlert.filter({ hasText: "Couldn't start the Google sign-in. Nothing was connected." }).waitFor();
  assert.equal(new URL(page.url()).origin, url, 'a URL that is not the Google consent page is refused');
  assert.deepEqual(blocked, []);
  startUrl = CONSENT_STUB;
  await page.getByRole('button', { name: 'Connect Google Calendar', exact: true }).click();
  await page.getByRole('heading', { name: 'Consent page stand-in' }).waitFor();
  assert.equal(page.url(), CONSENT_STUB);
  assert.deepEqual(left, [CONSENT_STUB], 'the only outside address the page leaves for');
  assert.deepEqual(googleCalls.splice(0), ['POST /api/care/google/start origin=true', 'POST /api/care/google/start origin=true']);
  // Back from Google: the result is shown once and removed from the address bar.
  await page.goto(url + '/?cal=on&calendar=connected');
  await page.getByRole('heading', { name: 'Google Calendar: connected', exact: true }).waitFor();
  await cardBox.getByText(/Google Calendar is connected\. The first sync runs in the background/).waitFor();
  await page.waitForFunction(() => !location.search.includes('calendar='));
  assert.equal(new URL(page.url()).search, '?cal=on');
  await cardBox.getByText('No sync has finished yet.', { exact: true }).waitFor();
  await cardBox.getByText('Granted', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Sync now' }).click();
  await cardBox.getByText(/Last sync just now: 2 added, 1 changed, 0 taken off, 3 already up to date\./).waitFor();
  failNext = true;
  await page.getByRole('button', { name: 'Sync now' }).click();
  await cardAlert.filter({ hasText: "Couldn't run the sync." }).waitFor();
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await page.getByRole('heading', { name: 'Google Calendar: not connected', exact: true }).waitFor();
  await cardBox.getByText(/Disconnected\. The "Onyx care" calendar and its events are still in Google Calendar/).waitFor();
  assert.deepEqual(googleCalls.splice(0), ['POST /api/care/google/sync origin=true', 'POST /api/care/google/sync origin=true', 'POST /api/care/google/disconnect origin=true']);
  await page.goto(url + '/?cal=ready&calendar=error&reason=wrong_scope');
  await cardAlert.filter({ hasText: 'Could not connect Google Calendar (wrong_scope). Nothing was connected.' }).waitFor();
  await page.goto(url + '/?cal=ready&calendar=denied');
  await cardBox.getByText('The Google sign-in was cancelled. Nothing was connected.', { exact: true }).waitFor();
  assert.deepEqual(googleCalls, []);

  assert.ok(calls.every(c => !JSON.stringify(c.body ?? '').includes('Synthetic calendar meeting') && !JSON.stringify(c.body ?? '').includes('Synthetic all-day event')), 'no care-item request ever carried a calendar event');
  assert.ok(eventCalls.every(c => c.startsWith('GET ')), 'the events route was only ever read');
  assert.deepEqual(errors, []); assert.deepEqual(blocked, []);
  console.log('Care planner UI regression passed (optimistic saves, reverts, undo, load states, one-time copy, calendar card, read-only calendar events). Screenshots: ' + fixture);
} finally {
  await browser?.close();
  server.kill();
}
