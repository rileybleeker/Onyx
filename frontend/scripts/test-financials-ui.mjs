/** Offline UI regression: isolated fixture, synthetic exports, no production env. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';
const frontend = fileURLToPath(new URL('..', import.meta.url));
const fixture = await mkdtemp(path.join(tmpdir(), 'onyx-financials-ui-'));
await mkdir(path.join(fixture, 'app')); await mkdir(path.join(fixture, 'lib'));
await symlink(path.join(frontend, 'node_modules'), path.join(fixture, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
await copyFile(path.join(frontend, 'src/lib/financials.ts'), path.join(fixture, 'lib/financials.ts'));
const client = await readFile(path.join(frontend, 'src/app/financials/FinancialsClient.tsx'), 'utf8');
await writeFile(path.join(fixture, 'app/FinancialsClient.tsx'), client.replace('@/lib/financials', '../lib/financials'));
await copyFile(path.join(frontend, 'src/app/financials/page.tsx'), path.join(fixture, 'app/page.tsx'));
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
  const page = await browser.newPage({viewport:{width:390,height:844}});
  const errors = [], blocked = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === new URL(url).origin) return route.continue();
    blocked.push(route.request().url()); return route.abort();
  });
  await page.goto(url); await page.getByRole('heading',{name:'Financials',exact:true}).waitFor();
  const csv='Date,Name,Amount,Category,Type\n2026-11-01,Synthetic Salary,-1000,Salary,income\n2026-11-02,Synthetic Grocer,50,Food,debit\n2026-11-03,Synthetic Transfer,100,Transfer,transfer\n2026-10-01,Synthetic Old,20,Food,debit';
  const file={name:'synthetic-only.csv',mimeType:'text/csv',buffer:Buffer.from(csv)};
  const upload = () => page.locator('input[type=file]').setInputFiles(file);
  const confirm = () => page.getByRole('checkbox',{name:/I checked/}).check();
  const importButton = () => page.getByRole('button',{name:'Import into this session'});
  await upload(); await page.getByText('4 rows ready.',{exact:false}).waitFor();
  assert.equal(await importButton().isDisabled(),true);
  await page.getByRole('button',{name:'Cancel preview'}).click();
  assert.equal(await importButton().count(),0);
  await upload(); await confirm(); await importButton().click();
  await page.getByRole('heading',{name:'Net cashflow'}).waitFor();
  assert.equal(await page.getByText('$950.00',{exact:true}).count(),1);
  await page.getByLabel('Search description, category, date or amount').fill('No match');
  await page.getByText('No matching transactions.').waitFor();
  await page.getByLabel('Search description, category, date or amount').fill('');
  await page.getByLabel('Period',{exact:false}).selectOption('2026-10');
  assert.ok(await page.getByText('-$20.00',{exact:true}).count());
  await page.getByLabel('Period',{exact:false}).selectOption('2026-11');
  await page.getByRole('checkbox',{name:'Food',exact:true}).check();
  assert.ok(await page.getByText('$1,000.00',{exact:true}).count());
  await page.locator('input[type=file]').setInputFiles({name:'bad.csv',mimeType:'text/csv',buffer:Buffer.from('Date,Name,Amount\n2026-02-30,Synthetic Bad,2')});
  await confirm(); assert.equal(await importButton().isDisabled(),true);
  await page.getByRole('button',{name:'Cancel preview'}).click();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
  // Confirming the same export replaces, rather than doubles, the dataset.
  await upload(); await confirm(); await importButton().click();
  assert.equal(await page.getByText('$950.00',{exact:true}).count(),1);
  await page.getByLabel('Search description, category, date or amount').fill('2026-11-02');
  assert.equal(await page.getByText('Synthetic Grocer',{exact:true}).count(),1);
  await page.getByLabel('Search description, category, date or amount').fill('');
  await page.screenshot({path:path.join(fixture,'mobile-synthetic.png'),fullPage:true});
  await page.setViewportSize({width:1440,height:1000});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth),false);
  await page.screenshot({path:path.join(fixture,'desktop-synthetic.png'),fullPage:true});
  const many = 'Date,Name,Amount\n' + Array.from({length:101}, () => '2026-11-01,Synthetic Same Merchant,1').join('\n');
  await page.locator('input[type=file]').setInputFiles({name:'synthetic-many.csv',mimeType:'text/csv',buffer:Buffer.from(many)});
  await confirm(); await importButton().click();
  assert.equal(await page.getByRole('row').count(),101);
  await page.getByRole('button',{name:'Show next 1 transactions',exact:true}).click();
  assert.equal(await page.getByRole('row').count(),102);
  await page.getByRole('button',{name:'Clear session'}).click();
  await page.getByText('Your overview starts with your export').waitFor();
  await upload(); await confirm(); await importButton().click(); await page.reload();
  await page.getByText('Your overview starts with your export').waitFor();
  assert.deepEqual(errors,[]); assert.deepEqual(blocked,[]);
  console.log('PASS offline finance UI: explicit confirmation, repeated file, cancel, month/search, exclusions, invalid-row block, replacement, clear/reload, mobile/desktop overflow, no runtime errors or external requests.');
  console.log('Synthetic fixture/screenshots retained at '+fixture);
} finally {
  if (browser) await browser.close();
  // This is only the child process created above, never an existing app/server.
  server.kill();
}
