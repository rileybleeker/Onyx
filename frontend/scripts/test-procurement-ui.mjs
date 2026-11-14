/** Offline UI regression: isolated fixture, synthetic exports, no production env. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';
const frontend = fileURLToPath(new URL('..', import.meta.url));
const fixture = await mkdtemp(path.join(tmpdir(), 'onyx-procurement-ui-'));
await mkdir(path.join(fixture, 'app')); await mkdir(path.join(fixture, 'lib'));
await symlink(path.join(frontend, 'node_modules'), path.join(fixture, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
await copyFile(path.join(frontend, 'src/lib/procurement.ts'), path.join(fixture, 'lib/procurement.ts'));
const client = await readFile(path.join(frontend, 'src/app/procurement/ProcurementClient.tsx'), 'utf8');
// The type-only import of the detector is erased at compile time; point it at a relative path anyway.
const relative = source => source.replace(/'@\/lib\/(procurement[a-z-]*)'/g, "'../lib/$1'");
await writeFile(path.join(fixture, 'app/ProcurementClient.tsx'), relative(client));
// The detected-subscriptions card (renewal estimates) is its own component next to the client.
await writeFile(path.join(fixture, 'app/DetectedSubscriptions.tsx'), relative(await readFile(path.join(frontend, 'src/app/procurement/DetectedSubscriptions.tsx'), 'utf8')));
await copyFile(path.join(frontend, 'src/lib/procurement-recurring.ts'), path.join(fixture, 'lib/procurement-recurring.ts'));
await copyFile(path.join(frontend, 'src/lib/procurement-renewals.ts'), path.join(fixture, 'lib/procurement-renewals.ts'));
await copyFile(path.join(frontend, 'src/lib/finance-ledger.ts'), path.join(fixture, 'lib/finance-ledger.ts'));
// The real page.tsx reads the ledger on the server; the fixture has no database, so it renders the client with synthetic detected rows.
await writeFile(path.join(fixture, 'app/page.tsx'), `import ProcurementClient from './ProcurementClient';
const estimate = { nextMethod: 'same day of the month as the recent charges', confidence: 'high', checkedGaps: 4, maxMissDays: 1 };
const detected = { state: 'ok', today: '2030-03-15', total: 2400, subs: [
  { id: '00000000000000a1', merchant: 'Demo streaming plan', cadence: 'monthly', typicalCents: 1500, lastCharge: '2030-03-10', nextExpected: '2030-04-10', chargeCount: 6, monthlyCents: 1500, status: 'active', ...estimate },
  { id: '00000000000000a2', merchant: 'Demo storage plan', cadence: 'monthly', typicalCents: 900, lastCharge: '2030-02-17', nextExpected: '2030-03-17', chargeCount: 5, monthlyCents: 900, status: 'active', ...estimate, confidence: 'low', maxMissDays: 6 },
  { id: '00000000000000a3', merchant: 'Demo old gym', cadence: 'monthly', typicalCents: 3000, lastCharge: '2029-11-01', nextExpected: '2029-12-01', chargeCount: 5, monthlyCents: 3000, status: 'lapsed', ...estimate },
], irregular: [
  { id: '00000000000000b1', merchant: 'Demo top-up', typicalCents: 2000, lastCharge: '2030-03-01', chargeCount: 5, medianGapDays: 23 },
] } as const;
export default function Page() { return <ProcurementClient detected={detected as never} />; }
`);
await copyFile(path.join(frontend, 'src/app/globals.css'), path.join(fixture, 'app/globals.css'));
await copyFile(path.join(frontend, 'postcss.config.mjs'), path.join(fixture, 'postcss.config.mjs'));
await writeFile(path.join(fixture, 'app/layout.tsx'), 'import "./globals.css"; export default function Layout({children}: {children: React.ReactNode}) {return <html lang="en" className="dark"><body className="bg-surface text-text-primary antialiased font-sans">{children}</body></html>}');
await writeFile(path.join(fixture, 'package.json'), '{"private":true}');
// Deliberately no production secrets, inherited NODE_OPTIONS, or Supabase variables.
const env = { NEXT_TELEMETRY_DISABLED: '1' };
for (const key of ['PATH','Path','SystemRoot','SYSTEMROOT','WINDIR','TEMP','TMP','HOME','USERPROFILE','LOCALAPPDATA']) if (process.env[key]) env[key] = process.env[key];
// Run Next directly in one owned process; the CLI dev supervisor would fork a child.
const serverCode = `const next=require(${JSON.stringify(path.join(frontend,'node_modules/next'))});
const app=next({dev:true,dir:${JSON.stringify(fixture)},hostname:'127.0.0.1',port:0});
app.prepare().then(()=>{const server=require('node:http').createServer(app.getRequestHandler());
server.listen(0,'127.0.0.1',()=>console.log('http://127.0.0.1:'+server.address().port+' Ready in 0ms'));});`;
const server = spawn(process.execPath, ['-e', serverCode], { cwd: fixture, env, windowsHide: true, stdio: ['pipe','pipe','pipe'] });
let output = '', browser;
try {
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Local fixture startup timed out. '+output.slice(-2000))), 60000);
    const collect = chunk => { output += chunk.toString(); const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/); if (match && /Ready in/.test(output)) { clearTimeout(timer); resolve(match[0]); } };
    server.stdout.on('data', collect); server.stderr.on('data', collect);
    server.once('exit', code => { clearTimeout(timer); reject(new Error('Local fixture exited '+code+' '+output.slice(-2000))); });
  });
  browser = await chromium.launch({headless: true});
  const context = await browser.newContext({viewport:{width:390,height:844}, permissions:['clipboard-read','clipboard-write']});
  const page = await context.newPage();
  const errors = [], blocked = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === new URL(url).origin) return route.continue();
    blocked.push(route.request().url()); return route.abort();
  });
  await page.goto(url, {timeout: 180000}); await page.getByRole('heading',{name:'Procurement',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Place order (unavailable)',exact:true}).isDisabled(),true);
  await page.getByRole('heading',{name:'Detected subscriptions',exact:true}).waitFor();
  await page.getByText('Demo streaming plan',{exact:true}).waitFor();
  await page.getByText(/About \$24\.00 \/ month across 2 active subscriptions\./).waitFor();
  await page.getByText(/1 lapsed/).waitFor();
  // Renewal estimates: what renews in the next 14 days, the method and confidence, and no date for irregular repeats.
  const renewals = page.getByTestId('procurement-renewals');
  await renewals.getByText(/Demo storage plan/).waitFor();
  assert.match(await renewals.innerText(), /renews in 2 days, Mar 17, 2030 · \$9\.00 · rough date \(low confidence\)/);
  assert.equal(await renewals.getByText(/Demo streaming plan/).count(), 0, 'a renewal 26 days out is not under Renewing soon');
  await page.getByText(/next expected Apr 10, 2030 \(renews in 26 days\)/).waitFor();
  await page.getByText('Estimate: same day of the month as the recent charges. High confidence: the last 4 gaps fit within 1 day.',{exact:true}).waitFor();
  await page.getByText(/1 repeating charge without a regular schedule \(no date estimated\)/).click();
  await page.getByText('No next date: the spacing is too uneven to estimate one.',{exact:true}).waitFor();
  await page.getByRole('heading',{name:'What this page reads',exact:true}).waitFor();
  assert.equal(await page.getByText(/Disconnected preview/).count(),0);
  assert.equal(await page.getByText(/Financials is not read/).count(),0);
  await page.getByRole('button',{name:'Show synthetic examples'}).click();
  await page.getByText('Demo workspace subscription',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Hide synthetic examples'}).click();
  assert.equal(await page.getByText('Demo workspace subscription',{exact:true}).count(),0);
  const add = async () => {
    await page.getByLabel('Item or service').fill('Synthetic monitor');
    await page.getByLabel('Merchant',{exact:true}).fill('Demo shop');
    await page.getByLabel('Estimated total (USD)').fill('25.10');
    await page.getByLabel('Commitment',{exact:true}).selectOption('monthly');
    await page.getByRole('button',{name:'Add planning draft'}).click();
  };
  await add(); await page.getByText('Demo shop · $25.10 / month · Draft only',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Remove draft 1',exact:true}).click();
  await page.getByText('No planning drafts.',{exact:true}).waitFor();
  await add(); await page.getByRole('button',{name:'Clear drafts',exact:true}).click();
  await add(); await page.reload(); await page.getByText('No planning drafts.',{exact:true}).waitFor();
  await page.getByLabel('Item or service').fill('Synthetic'); await page.getByLabel('Merchant',{exact:true}).fill('Demo');
  await page.getByLabel('Estimated total (USD)').fill('-1'); await page.getByRole('button',{name:'Add planning draft'}).click();
  await page.getByRole('alert').filter({hasText:'Enter a positive USD amount'}).waitFor();
  // --- subscription tracker (synthetic data only) ---
  const localIso = offset => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
  await page.getByText('No subscriptions tracked yet.',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Load synthetic demo subscriptions'}).click();
  await page.getByText('Demo streaming service',{exact:true}).waitFor();
  await page.getByText(/About \$.*\/ month, \$.* \/ year across 4 tracked subscriptions/).waitFor();
  await page.getByText(/Demo streaming service renews in 5 days/).waitFor();
  const addSub = async (name, price, cycle, date) => {
    await page.getByLabel('Subscription name').fill(name);
    await page.getByLabel('Price per cycle (USD)').fill(price);
    await page.getByLabel('Billing cycle').selectOption(cycle);
    await page.getByLabel('Next renewal date').fill(date);
    await page.getByRole('button',{name:'Add subscription'}).click();
  };
  await addSub('Demo streaming service', '9.99', 'monthly', localIso(20));
  await page.getByText(/tracked 2 times/).waitFor();
  await addSub('Demo bad price', '0', 'monthly', localIso(20));
  await page.getByRole('heading',{name:'Track subscriptions',exact:true}).locator('xpath=..').getByRole('alert').filter({hasText:'Enter a positive USD amount'}).waitFor();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button',{name:'Download renewal reminders (.ics)'}).click(),
  ]);
  assert.equal(download.suggestedFilename(), 'onyx-renewal-reminders.ics');
  const icsPath = path.join(fixture, 'reminders.ics'); await download.saveAs(icsPath);
  const ics = await readFile(icsPath, 'utf8');
  assert.match(ics, /^BEGIN:VCALENDAR\r\n/); assert.equal((ics.match(/BEGIN:VEVENT/g) ?? []).length, 5);
  await page.getByRole('button',{name:/^Remove subscription \d+$/}).first().click();
  await page.getByText(/across 4 tracked subscriptions/).waitFor();

  // --- order preparation: totals, duplicate-subscription warning, prepared list, copy ---
  await page.getByLabel('Item or service').fill('Demo streaming service');
  await page.getByLabel('Merchant',{exact:true}).fill('Demo shop');
  await page.getByLabel('Estimated total (USD)').fill('15.99');
  await page.getByLabel('Commitment',{exact:true}).selectOption('monthly');
  await page.getByRole('button',{name:'Add planning draft'}).click();
  await page.getByLabel('Item or service').fill('Synthetic cable');
  await page.getByLabel('Merchant',{exact:true}).fill('Demo shop');
  await page.getByLabel('Estimated total (USD)').fill('4.90');
  await page.getByRole('button',{name:'Add planning draft'}).click();
  await page.getByText('Estimated one-time: $4.90 · Recurring: $15.99 / month',{exact:true}).waitFor();
  await page.getByText(/which you already track/).waitFor();
  assert.equal(await page.getByRole('button',{name:'Copy prepared list'}).isDisabled(),true);
  await page.getByRole('button',{name:'Show prepared list'}).click();
  const prepared = page.getByLabel('Prepared list');
  await prepared.waitFor();
  assert.match(await prepared.innerText(), /Nothing has been ordered, submitted or paid for/);
  await page.getByRole('button',{name:'Copy prepared list'}).click();
  await page.getByText('Prepared list copied. No order was placed.',{exact:true}).waitFor();
  assert.match(await page.evaluate(() => navigator.clipboard.readText()), /Estimated recurring total: \$15\.99 \/ month/);
  assert.equal(await page.getByRole('button',{name:'Place order (unavailable)',exact:true}).isDisabled(),true);
  for(const width of [390,1280]) {
    await page.setViewportSize({width,height:844});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),true);
    await page.screenshot({path:path.join(fixture,`procurement-${width}.png`),fullPage:true});
  }
  await page.getByRole('button',{name:'Clear subscriptions'}).click();
  await page.getByText('No subscriptions tracked yet.',{exact:true}).waitFor();
  assert.deepEqual(errors,[]); assert.deepEqual(blocked,[]);
  console.log('PASS offline procurement UI: synthetic toggle, draft add/remove/clear/reload, recurring amount, invalid amount, subscription tracker (synthetic load, duplicate prompt, bad price, .ics download, remove, clear), prepared list and copy, duplicate-subscription warning, hard-disabled checkout, mobile/desktop overflow, no runtime errors or external requests.');
  console.log('Synthetic fixture/screenshots retained at '+fixture);
} finally {
  if (browser) await browser.close();
  // Stops only this test-owned child process.
  server.kill();
}
