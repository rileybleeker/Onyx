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
await writeFile(path.join(fixture, 'app/ProcurementClient.tsx'), client.replace('@/lib/procurement', '../lib/procurement'));
await copyFile(path.join(frontend, 'src/app/procurement/page.tsx'), path.join(fixture, 'app/page.tsx'));
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
  await page.goto(url); await page.getByRole('heading',{name:'Procurement',exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Place order (unavailable)',exact:true}).isDisabled(),true);
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
  for(const width of [390,1280]) {
    await page.setViewportSize({width,height:844});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),true);
    await page.screenshot({path:path.join(fixture,`procurement-${width}.png`),fullPage:true});
  }
  assert.deepEqual(errors,[]); assert.deepEqual(blocked,[]);
  console.log('PASS offline procurement UI: synthetic toggle, draft add/remove/clear/reload, recurring amount, invalid amount, hard-disabled checkout, mobile/desktop overflow, no runtime errors or external requests.');
  console.log('Synthetic fixture/screenshots retained at '+fixture);
} finally {
  if (browser) await browser.close();
  // Stops only this test-owned child process.
  server.kill();
}
