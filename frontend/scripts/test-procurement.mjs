import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source = fs.readFileSync(new URL('../src/lib/procurement.ts', import.meta.url), 'utf8');
const module = { exports: {} };
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020} }).outputText, {exports: module.exports, module});
const {createDraft, executionReadiness} = module.exports;
assert.equal(createDraft(' Demo ', ' Shop ', '12.30', 'monthly').totalCents, 1230);
assert.equal(createDraft(' Demo ', ' Shop ', '0.01', 'one-time').item, 'Demo');
for (const amount of ['0','-1','1e3','NaN','1.234','Infinity','10000000','', ' 1']) assert.throws(() => createDraft('Demo','Shop',amount,'one-time'));
assert.throws(() => createDraft('', 'Shop', '1', 'one-time'));
assert.throws(() => createDraft('Demo', 'Shop', '1', 'annual'));
assert.equal(executionReadiness().allowed, false);
assert.equal(executionReadiness({approved:true,connected:true}).allowed, false);
for (const file of ['../src/lib/procurement.ts','../src/app/procurement/ProcurementClient.tsx']) {
 const content=fs.readFileSync(new URL(file, import.meta.url),'utf8');
 assert.doesNotMatch(content, /fetch\(|localStorage|sessionStorage|supabase|process\.env|XMLHttpRequest/);
}
console.log('PASS procurement validation, exact cents, execution hard-disable, no network/storage integrations');
