// Offline contract + request-count benchmark. No credentials, network, or health data.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../src/lib/queries-hrv.ts'), 'utf8');
function harness(rows, failAt = -1) {
  let requests = 0, returnedRows = 0;
  const client = { from(table) {
    assert.equal(table, 'hrv_analysis_results');
    const eq = [], orders = []; let range = [0, Infinity], filter;
    const q = {
      select(columns) { assert.equal(columns, 'result_type,result_key,result_json,computed_at'); return q; },
      eq(k,v) { eq.push([k,v]); return q; },
      or(f) { filter = f; return q; },
      order(k,o) { orders.push([k,o?.ascending !== false]); return q; },
      range(a,b) { range = [a,b]; return q; }, limit(n) { range = [0,n-1]; return q; },
      then(resolve,reject) {
        const count = requests++;
        if (count === failAt) return Promise.resolve({data:null,error:new Error('synthetic failure')}).then(resolve,reject);
        let out = rows.filter(r => eq.every(([k,v]) => r[k] === v));
        if (filter) out = out.filter(r => filter.includes(`and(result_type.eq.${r.result_type},result_key.eq.${r.result_key})`) || filter.split(',').includes(`result_type.eq.${r.result_type}`));
        out = [...out].sort((a,b) => { for (const [k,asc] of orders) { const n = String(a[k]).localeCompare(String(b[k])); if(n) return asc ? n : -n; } return 0; });
        out = out.slice(range[0],range[1]+1); returnedRows += out.length;
        return Promise.resolve({ data:out,error:null }).then(resolve,reject);
      }
    }; return q;
  }};
  const exports = {};
  vm.runInNewContext(ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText,
    {exports, require(id) { if(id === '@/lib/supabase') return {supabase:client}; if(id === '@/lib/queries' || id === '@/lib/sweet-spot') return {}; throw new Error(id); }, Date, Intl, Map});
  return {api:exports,count:()=>requests,returned:()=>returnedRows};
}
function fixture() {
 const {api} = harness([]);
 return api.HRV_ANALYSIS_PANELS.map(([type,key],i) => ({result_type:type,result_key:key || 'default',result_json:{synthetic:i},computed_at:'2026-11-11T00:00:00Z'}));
}
test('same 17 panel results with 3 requests instead of 17', async () => {
 const rows = fixture(); rows.push({result_type:'unrelated',result_key:'large',result_json:'not requested',computed_at:'2030-01-01'});
 const old = harness(rows), next = harness(rows);
 const before = await Promise.all(old.api.HRV_ANALYSIS_PANELS.map(([t,k])=>old.api.getHrvAnalysisResults(t,k)));
 const select = await next.api.getHrvAnalysisBatch();
 const after = next.api.HRV_ANALYSIS_PANELS.map(([t,k])=>select(t,k));
 assert.equal(JSON.stringify(after),JSON.stringify(before));
 assert.equal(old.count(),17); assert.equal(next.count(),3);
 console.log('Synthetic request benchmark: 17 -> 3 analysis requests (82.4% fewer). No real page latency claim.');
});
test('newest type-only row, absent panels, and legacy JSON strings survive', async () => {
 const rows = fixture().filter(r=>r.result_key !== 'dag');
 rows.push({result_type:'journal_impact',result_key:'new',result_json:'[{"synthetic":true}]',computed_at:'2026-11-12'});
 const h = harness(rows), select = await h.api.getHrvAnalysisBatch();
 assert.equal(select('journal_impact').result_key,'new');
 assert.equal(select('journal_impact').result_json,'[{"synthetic":true}]');
 assert.equal(select('causal','dag'),null);
});
test('type-only selectors remain bounded with more than 1000 keys', async () => {
 const rows = fixture();
 for(let i=0;i<1001;i++) rows.push({result_type:'journal_impact',result_key:`new${i}`,result_json:[],computed_at:'2027-01-01'});
 const h = harness(rows), select = await h.api.getHrvAnalysisBatch();
 assert.equal(h.count(),3); assert.equal(h.returned(),17); assert.equal(select('causal','dag').result_key,'dag');
});
test('failure in any batch member rejects rather than baking empty data into ISR', async () => {
 for(let i=0;i<3;i++) {
  const h = harness(fixture(),i); await assert.rejects(h.api.getHrvAnalysisBatch(),/synthetic failure/);
 }
});

test('every dashboard panel call is included in the bounded batch specification', () => {
 const {api} = harness([]);
 const staticLoader = source.slice(source.indexOf('async function loadHrvStatic()'));
 const calls = [...staticLoader.matchAll(/panel\("([^"]+)"(?:, "([^"]+)")?\)/g)].map(m=>[m[1],m[2]]);
 const specs = api.HRV_ANALYSIS_PANELS.map(([type,key])=>[type,key]);
 assert.equal(JSON.stringify(calls),JSON.stringify(specs));
 assert.equal(calls.length,17);
});
