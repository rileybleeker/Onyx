// Synthetic browser regressions. No auth, records, external services or live writes.
const fs=require('fs'),path=require('path'),assert=require('assert');
const root=path.resolve(__dirname,'..');process.chdir(root);
const base=path.join(root,'frontend/node_modules');
const ts=require(base+'/typescript'),{chromium}=require(base+'/@playwright/test');
const modules={},ids=new Map();
function bundle(file){if(ids.has(file))return ids.get(file);const id=ids.size;ids.set(file,id);let code=fs.readFileSync(file,'utf8');code=code.replace(/require\(['"]([^'"]+)['"]\)/g,(_,dep)=>`require(${bundle(require.resolve(dep,{paths:[path.dirname(file)]}))})`);modules[id]=code;return id;}
const react=bundle(require.resolve(base+'/react')),dom=bundle(require.resolve(base+'/react-dom/client'));
const compile=file=>ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React,esModuleInterop:true}}).outputText;
const contract=compile('frontend/src/lib/chat-contract.ts');
const component='const React=require('+react+');\n'+compile('frontend/src/app/chat/page.tsx').replace(/require\("react"\)/g,`require(${react})`).replace(/require\("next\/link"\)/g,`({__esModule:true,default:({children,href,...props})=>React.createElement('a',{...props,href},children)})`).replace(/require\("@\/lib\/chat-contract"\)/g,'contract.exports');
const script=`const process={env:{NODE_ENV:'production'}};const modules={${Object.entries(modules).map(([id,c])=>`${id}:function(module,exports,require){${c}\n}`).join(',')}};const cache={};function require(id){if(cache[id])return cache[id].exports;const m={exports:{}};cache[id]=m;modules[id](m,m.exports,require);return m.exports;}const contract={exports:{}};(function(exports){${contract}\n})(contract.exports);const out={exports:{}};(function(exports){${component}\n})(out.exports);window.root=require(${dom}).createRoot(document.getElementById('root'));window.root.render(require(${react}).createElement(out.exports.default));`;
const css=fs.readdirSync('frontend/.next/static/css').filter(x=>x.endsWith('.css')).map(x=>fs.readFileSync('frontend/.next/static/css/'+x,'utf8')).join('\n');assert(css.trim());
(async()=>{const browser=await chromium.launch({headless:true});const errors=[];try{
for(const width of [390,1440]){
 const page=await browser.newPage({viewport:{width,height:900},serviceWorkers:'block'});
 page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',r=>{errors.push('Unexpected network');return r.abort();});
 await page.setContent('<style>'+css+'</style><div class="p-4"><div id="root"></div></div>');
 await page.evaluate(()=>{document.documentElement.className='dark';document.body.className='bg-surface text-text-primary';window.requests=[];window.mode='defer';window.fetch=async(url,init)=>{if(url!='/api/chat'||init.method!=='POST')throw Error('Unexpected endpoint');window.requests.push(JSON.parse(init.body));if(window.mode==='unauthorized')return {ok:false,status:401,json:async()=>null};if(window.mode==='bad-json')return {ok:false,json:async()=>{throw Error('secret HTML parse detail');}};if(window.mode==='fail')return {ok:false,json:async()=>({error:'Synthetic service error'})};return new Promise(resolve=>window.resolveChat=resolve);};});
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
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.screenshot({path: path.join(require("os").tmpdir(), `onyx-chat-${width}.png`),fullPage:true});
 await page.getByRole('button',{name:'New chat'}).click();await page.getByText('What would you like to work on?',{exact:true}).waitFor();assert.equal(await input.inputValue(),'');
 await page.evaluate(()=>window.mode='unauthorized');await input.fill('Keep this draft');await page.getByRole('button',{name:'Send',exact:true}).click();await page.getByRole('alert').waitFor();assert.match(await page.getByRole('alert').textContent(),/session may have expired/);assert.equal(await input.inputValue(),'Keep this draft');await page.getByRole('button',{name:'New chat'}).click();assert.equal(await page.getByRole('alert').count(),0);assert.equal(await input.inputValue(),'');
 await input.fill('First line');await input.press('Shift+Enter');await input.press('A');assert.equal(await input.inputValue(),'First line\nA');
 await page.evaluate(()=>{window.matchMedia=()=>({matches:false});});await input.press('Enter');assert.equal(await input.inputValue(),'First line\nA\n');assert.equal(await page.evaluate(()=>window.requests.length),4);
 await page.close();console.log(`PASS ${width}px: examples, duplicate submit lock, clear blocked in-flight, non-JSON error recovery, retry history, clear and width`);
}
assert.deepEqual(errors,[]);
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});



