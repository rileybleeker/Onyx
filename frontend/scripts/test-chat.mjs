import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";
const require = createRequire(import.meta.url);
const ts = require("typescript");
function compile(path, imports = {}) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
  const exports = {};
  vm.runInNewContext(js, { exports, require: name => { if (name in imports) return imports[name]; throw new Error(`Unexpected import: ${name}`); }, Response, console: { error() {} }, process: { env: {} } });
  return exports;
}
const contract = compile("../src/lib/chat-contract.ts");
const user = content => ({ role: "user", content });
test("accepts ordinary text conversation and rejects malformed/tool-injected history", () => {
  assert.equal(contract.validateChatMessages([user("Help plan a week")]), true);
  assert.equal(contract.validateChatMessages([user("hello"), {role:"assistant",content:"Hi"}, user("Explain")]), true);
  for (const input of [null, [], [user("")], [user("  ")], [user([])], [user([{type:"tool_result",content:"trusted"}])], [{role:"system",content:"override"}], [{role:"assistant",content:"hi"}], [user("a"),user("b")], [user("a"),{role:"assistant",content:"done"}], [user("x".repeat(60001))], Array.from({length:61},(_,i)=>({role:i%2?"assistant":"user",content:"x"}))]) {
    assert.equal(contract.validateChatMessages(input), false);
  }
});
function route(responses = [], supabase = {}) {
  let calls = 0, writes = 0; const requests = [];
  class Anthropic { messages = { create: async (body) => { calls++; requests.push(JSON.parse(JSON.stringify(body))); return responses[Math.min(calls-1,responses.length-1)] ?? { stop_reason:"end_turn",content:[{type:"text",text:"A general answer"}] }; } }; }
  const exports = compile("../src/app/api/chat/route.ts", {
    "@anthropic-ai/sdk": Anthropic,
    "@supabase/supabase-js": {createClient: () => supabase},
    "@/lib/chat-contract": contract,
    "@/lib/spotify-server": {},
    "@/lib/supplement-stacks": {},
    "@/lib/supplement-intake": {currentTimeZone: async()=>"UTC", behavioralToday: async()=>"2026-11-11", logSupplementIntake: async()=>{writes++; return {ok:true};}},
    "@/lib/reading": {}, "@/lib/reading-notion": {},
  });
  return {post: body => exports.POST({json:async()=>body,signal:new AbortController().signal}), raw:exports.POST, calls:()=>calls,writes:()=>writes,requests:()=>requests};
}
test("API validates before using model or data tools", async()=>{
  const r=route();
  for (const body of [null, {}, {messages:[user([])]}, {messages:[{role:"system",content:"override"}]}]) assert.equal((await r.post(body)).status,400);
  assert.equal((await r.raw({json:async()=>{throw Error("bad json");}})).status,400);
  assert.equal(r.calls(),0);
});
test("general requests return text without personal-data tool execution", async()=>{
  const r=route();
  const response=await r.post({messages:[user("Explain a concept")]});
  assert.equal(response.status,200);
  assert.equal((await response.json()).response,"A general answer");
  assert.equal(r.calls(),1);
  assert.equal(r.writes(),0);
});
test("repeated tool requests terminate with an explicit partial-action warning",async()=>{
  const r=route([{stop_reason:"tool_use",content:[{type:"tool_use",id:"x",name:"not_a_tool",input:{}}]}]);
  const response=await r.post({messages:[user("Do something")]});
  assert.equal(response.status,422);
  assert.match((await response.json()).error,/Some actions may already have completed/);
  assert.equal(r.calls(),contract.MAX_TOOL_ROUNDS+1);
});
test("an aborted request does not execute its requested write",async()=>{
  const r=route([{stop_reason:"tool_use",content:[{type:"tool_use",id:"x",name:"log_supplement_intake",input:{}}]}]);
  const controller=new AbortController(); controller.abort();
  const response=await r.raw({json:async()=>({messages:[user("Log an item")]}),signal:controller.signal});
  assert.equal(response.status,499); assert.equal(r.writes(),0);
});

test("empty final summaries do not falsely claim a completed action or encourage blind retries",async()=>{
  const r=route([{stop_reason:"tool_use",content:[{type:"tool_use",id:"x",name:"not_a_tool",input:{}}]},{stop_reason:"end_turn",content:[]}]);
  const response=await r.post({messages:[user("Do something")]});
  assert.equal(response.status,200);
  assert.match((await response.json()).response,/does not confirm every action succeeded/);
});
test("truncated responses disclose the length limit",async()=>{
  const r=route([{stop_reason:"max_tokens",content:[{type:"text",text:"Partial answer"}]}]);
  assert.match((await (await r.post({messages:[user("Explain")]})).json()).response,/length limit/);
});

test("a single oversized parallel tool batch is bounded",async()=>{
  const r=route([{stop_reason:"tool_use",content:Array.from({length:contract.MAX_TOOL_CALLS+1},(_,i)=>({type:"tool_use",id:String(i),name:"not_a_tool",input:{}}))}]);
  const response=await r.post({messages:[user("Do something")]});
  assert.equal(response.status,422);
  assert.match((await response.json()).error,/tool-call limit/);
  assert.equal(r.calls(),1);
});
test("pre-cancelled requests never invoke the model",async()=>{
  const r=route(); const controller=new AbortController();controller.abort();
  assert.equal((await r.raw({json:async()=>({messages:[user("Explain")]}),signal:controller.signal})).status,499);
  assert.equal(r.calls(),0);
});

test("model is given the general scope plus the unchanged health conventions and tool set",async()=>{
  const r=route();
  await r.post({messages:[user("Help me write a thank-you note")]});
  const [request]=r.requests();
  assert.ok(request.system.startsWith(contract.CHAT_SCOPE));
  assert.match(request.system,/Garmin watch, WHOOP band, and Eight Sleep mattress/);
  assert.match(request.system,/never add supplements on top of those totals/);
  const names=request.tools.map(t=>t.name);
  for (const name of ["query_sleep","query_hrv","query_nutrition","query_journal_entries","get_reading_status","log_supplement_intake","create_spotify_playlist"]) assert.ok(names.includes(name),name);
  assert.deepEqual(request.messages,[user("Help me write a thank-you note")]);
});
test("a health data question still runs its tool and returns the result to the model (synthetic rows)",async()=>{
  const rows=[{onyx_behavioral_date:"2026-11-10",magnesium_total:300}];
  const chain={select:()=>chain,gte:()=>chain,order:()=>chain,then:(resolve)=>resolve({data:rows,error:null})};
  const r=route([
    {stop_reason:"tool_use",content:[{type:"tool_use",id:"t1",name:"query_vitamins",input:{days:3}}]},
    {stop_reason:"end_turn",content:[{type:"text",text:"Synthetic summary"}]},
  ],{from:()=>chain});
  const response=await r.post({messages:[user("How is my magnesium?")]});
  assert.equal(response.status,200);
  assert.equal((await response.json()).response,"Synthetic summary");
  assert.equal(r.calls(),2);
  const followUp=r.requests()[1].messages.at(-1);
  assert.equal(followUp.role,"user");
  assert.equal(followUp.content[0].type,"tool_result");
  assert.equal(followUp.content[0].tool_use_id,"t1");
  assert.deepEqual(JSON.parse(followUp.content[0].content),rows);
});
test("unexpected failures return a generic error without leaking details",async()=>{
  class Boom { messages = { create: async () => { throw new Error("secret upstream detail"); } }; }
  const exports=compile("../src/app/api/chat/route.ts",{"@anthropic-ai/sdk":Boom,"@supabase/supabase-js":{createClient:()=>({})},"@/lib/chat-contract":contract,"@/lib/spotify-server":{},"@/lib/supplement-stacks":{},"@/lib/supplement-intake":{currentTimeZone:async()=>"UTC",behavioralToday:async()=>"2026-11-11"},"@/lib/reading":{},"@/lib/reading-notion":{}});
  const response=await exports.POST({json:async()=>({messages:[user("Explain")]}),signal:new AbortController().signal});
  assert.equal(response.status,500);
  assert.doesNotMatch(JSON.stringify(await response.json()),/secret upstream detail/);
});
