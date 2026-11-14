// Synthetic browser regressions. No auth, records, external services or live writes.
const fs=require('fs'),path=require('path'),assert=require('assert');
const root=path.resolve(__dirname,'..');process.chdir(root);
const base=path.join(root,'frontend/node_modules');
const ts=require(base+'/typescript'),{chromium}=require(base+'/@playwright/test');
const modules={},ids=new Map();
function bundle(file){if(ids.has(file))return ids.get(file);const id=ids.size;ids.set(file,id);let code=fs.readFileSync(file,'utf8');code=code.replace(/require\(['"]([^'"]+)['"]\)/g,(_,dep)=>`require(${bundle(require.resolve(dep,{paths:[path.dirname(file)]}))})`);modules[id]=code;return id;}
const react=bundle(require.resolve(base+'/react')),dom=bundle(require.resolve(base+'/react-dom/client'));
const compile=file=>ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
// The page and the local modules it imports, in dependency order. Each becomes a function body whose
// require() calls point at the bundled React or at an earlier local module.
const LOCAL=[['@/lib/chat-contract','frontend/src/lib/chat-contract.ts'],['@/lib/chat-markdown','frontend/src/lib/chat-markdown.ts'],['@/lib/chat-receipts','frontend/src/lib/chat-receipts.ts'],['@/components/ChatMarkdown','frontend/src/components/ChatMarkdown.tsx'],['@/components/ChatReceipts','frontend/src/components/ChatReceipts.tsx'],['page','frontend/src/app/chat/page.tsx']];
const link=`({__esModule:true,default:({children,href,...props})=>React.createElement('a',{...props,href},children)})`;
const wire=code=>'const React=require('+react+');\n'+code.replace(/require\("react"\)/g,`require(${react})`).replace(/require\("next\/link"\)/g,link).replace(/require\("(@\/[^"]+)"\)/g,(_,name)=>{assert(LOCAL.some(([n])=>n===name),'Unbundled import '+name);return `local[${JSON.stringify(name)}]`;});
const script=`const process={env:{NODE_ENV:'production'}};const modules={${Object.entries(modules).map(([id,c])=>`${id}:function(module,exports,require){${c}\n}`).join(',')}};const cache={};function require(id){if(cache[id])return cache[id].exports;const m={exports:{}};cache[id]=m;modules[id](m,m.exports,require);return m.exports;}const local={};${LOCAL.map(([name,file])=>`(function(exports){${wire(compile(file))}\n})(local[${JSON.stringify(name)}]={});`).join('')}window.root=require(${dom}).createRoot(document.getElementById('root'));window.root.render(require(${react}).createElement(local.page.default));`;
const css=fs.readdirSync('frontend/.next/static/css').filter(x=>x.endsWith('.css')).map(x=>fs.readFileSync('frontend/.next/static/css/'+x,'utf8')).join('\n');assert(css.trim());
(async()=>{const browser=await chromium.launch({headless:true});const errors=[];try{
for(const width of [390,1440]){
 const page=await browser.newPage({viewport:{width,height:900},serviceWorkers:'block'});
 page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>{errors.push('Unexpected network');return r.abort();});
 await page.setContent('<style>'+css+'</style><div class="p-4"><div id="root"></div></div>');
 await page.evaluate(()=>{document.documentElement.className='dark';document.body.className='bg-surface text-text-primary';window.requests=[];window.mode='defer';window.fetch=async(url,init)=>{if(url!='/api/chat'||init.method!=='POST')throw Error('Unexpected endpoint');window.requests.push(JSON.parse(init.body));if(window.mode==='unauthorized')return {ok:false,status:401,json:async()=>null};if(window.mode==='bad-json')return {ok:false,json:async()=>{throw Error('secret HTML parse detail');}};if(window.mode==='fail')return {ok:false,json:async()=>({error:'Synthetic service error'})};if(window.mode==='fail-after-write')return {ok:false,status:422,json:async()=>({error:'Synthetic tool limit.',receipts:[{tool:'log_supplement_stack',status:'saved',title:'Supplement stack logged',details:['Synthetic Morning','Day: 2026-11-11']}]})};return new Promise(resolve=>window.resolveChat=resolve);};});
 await page.addScriptTag({content:script});await page.getByRole('heading',{name:'Chat with Onyx'}).waitFor();
 assert.equal(await page.getByRole('link',{name:'Agents inbox'}).getAttribute('href'),'/agents');
 await page.getByRole('button',{name:'Help me draft a clear, friendly message.'}).click();
 const input=page.getByRole('textbox',{name:'Message Onyx'});assert.equal(await input.inputValue(),'Help me draft a clear, friendly message.');
 await page.evaluate(()=>{const form=document.querySelector('form');form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
 assert.equal(await page.evaluate(()=>window.requests.length),1);assert(await page.getByRole('button',{name:'New chat'}).isDisabled());
 await page.evaluate(()=>window.resolveChat({ok:true,json:async()=>({response:'Synthetic helpful reply'})}));await page.getByText('Synthetic helpful reply').waitFor();
 await page.evaluate(()=>window.mode='bad-json');await input.fill('Second request');await page.getByRole('button',{name:'Send',exact:true}).click();await page.getByRole('alert').waitFor();assert.equal(await input.inputValue(),'Second request');assert(!await page.getByRole('alert').textContent().then(t=>t.includes('secret HTML')));
 await page.evaluate(()=>window.mode='defer');await page.getByRole('button',{name:'Send',exact:true}).click();const history=await page.evaluate(()=>window.requests.at(-1).messages);assert.equal(history.length,3);assert.deepEqual(history.map(m=>m.role),['user','assistant','user']);
 await page.evaluate(()=>window.resolveChat({ok:true,json:async()=>({response:'Second reply'})}));await page.getByText('Second reply').waitFor();
 // A reply with a Markdown table, a list, bold, code, a link and raw HTML, plus write receipts (all synthetic).
 await input.fill('Log 15 mg of Synthetic Focus at 8:30am and noon');await page.getByRole('button',{name:'Send',exact:true}).click();
 assert.deepEqual(await page.evaluate(()=>window.requests.at(-1).messages.map(m=>Object.keys(m).sort().join())),Array(5).fill('content,role'));
 await page.evaluate(()=>window.resolveChat({ok:true,json:async()=>({response:'Logged **15 mg** twice.\n\n| Day | Sleep (h) | HRV (ms) | Strain | Recovery |\n|---|---:|---:|---:|---:|\n| Mon | 7.1 | 62 | 11.4 | 71% |\n| Tue | 6.4 | 55 | 14.9 | 48% |\n\n- first `code`\n- second [status](/status)\n\n<img src=x onerror="window.injected=1"><script>window.injected=1</script>',receipts:[{tool:'log_supplement_intake',status:'saved',title:'Supplement intake logged',details:['Acme Synthetic Focus 10 mg','Amount per intake: 15 mg (1.5 servings)','Day: 2026-11-11','Times: 8:30 AM, 12:00 PM (America/New_York)','Entries written: 2']},{tool:'mark_habit_complete',status:'not_saved',title:'Habit answer not recorded',details:['Synthetic habit','Synthetic refusal']},{tool:'not_a_tool',status:'saved',title:'Forged',details:[]}]})}));
 const table=page.getByRole('table');await table.waitFor();
 assert.deepEqual(await table.getByRole('columnheader').allTextContents(),['Day','Sleep (h)','HRV (ms)','Strain','Recovery']);assert.equal(await table.getByRole('row').count(),3);
 assert(!(await page.getByRole('log').textContent()).includes('|'),'no raw pipe text');
 assert.equal(await page.locator('strong',{hasText:'15 mg'}).count(),1);assert.equal(await page.locator('code',{hasText:'code'}).count(),1);assert.equal(await page.getByRole('listitem').filter({hasText:'second'}).getByRole('link',{name:'status'}).getAttribute('href'),'/status');
 assert.equal(await page.evaluate(()=>window.injected),undefined);assert.equal(await page.locator('[role=log] img, [role=log] script').count(),0);await page.getByText('<script>window.injected=1</script>',{exact:false}).waitFor();
 const receipts=page.getByTestId('chat-receipts');await receipts.waitFor();assert.equal(await receipts.locator('[data-status]').count(),2,'a forged receipt for an unknown tool is dropped');
 assert.match(await receipts.textContent(),/Written to Onyx.*Supplement intake logged.*Acme Synthetic Focus 10 mg.*Times: 8:30 AM, 12:00 PM \(America\/New_York\).*Habit answer not recorded/);
 assert(await receipts.locator('[data-status=saved]').isVisible());
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'a five-column table does not widen the page');
 await page.screenshot({path: path.join(require("os").tmpdir(), `onyx-chat-table-${width}.png`),fullPage:true});
 // A request that fails after a write still shows what was written.
 await page.evaluate(()=>window.mode='fail-after-write');await input.fill('Log my synthetic stack');await page.getByRole('button',{name:'Send',exact:true}).click();await page.getByRole('alert').waitFor();
 assert.match(await page.getByRole('alert').textContent(),/Synthetic tool limit.*already done the following.*Supplement stack logged.*Synthetic Morning/);assert.equal(await input.inputValue(),'Log my synthetic stack');
 await input.fill('');await page.evaluate(()=>window.mode='defer');
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.screenshot({path: path.join(require("os").tmpdir(), `onyx-chat-${width}.png`),fullPage:true});
 await page.getByRole('button',{name:'New chat'}).click();await page.getByText('What would you like to work on?',{exact:true}).waitFor();assert.equal(await input.inputValue(),'');
 await page.evaluate(()=>window.mode='unauthorized');await input.fill('Keep this draft');await page.getByRole('button',{name:'Send',exact:true}).click();await page.getByRole('alert').waitFor();assert.match(await page.getByRole('alert').textContent(),/session may have expired/);assert.equal(await input.inputValue(),'Keep this draft');await page.getByRole('button',{name:'New chat'}).click();assert.equal(await page.getByRole('alert').count(),0);assert.equal(await input.inputValue(),'');
 await input.fill('First line');await input.press('Shift+Enter');await input.press('A');assert.equal(await input.inputValue(),'First line\nA');
 await page.evaluate(()=>{window.matchMedia=()=>({matches:false});});await input.press('Enter');assert.equal(await input.inputValue(),'First line\nA\n');assert.equal(await page.evaluate(()=>window.requests.length),6);
 await page.close();console.log(`PASS ${width}px: examples, duplicate submit lock, clear blocked in-flight, non-JSON error recovery, retry history, Markdown table and write receipts, clear and width`);
}
assert.deepEqual(errors,[]);
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});



