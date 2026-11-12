// Offline tests for lib/causal-plausibility.ts (the /analytics/hrv causal plausibility guard).
// Synthetic rows only. The reason strings are pinned to the same literals the Python guard
// produces (tests/test_causal_aipw_synthetic.py) so the two implementations stay in step.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../src/lib/causal-plausibility.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const module = { exports: {} };
vm.runInNewContext(code, { exports: module.exports, module, Number, Math, Array });
const { PLAUSIBLE_MAX_ATE_SD, PLAUSIBLE_DISAGREE_SD } = module.exports;
// Values built inside the vm realm have their own Array prototype; compare plain JSON copies.
const plain = (v) => JSON.parse(JSON.stringify(v));
const causalPlausibility = (row) => plain(module.exports.causalPlausibility(row));
const splitPlausible = (rows) => plain(module.exports.splitPlausible(rows));

let count = 0;
function test(name, fn) { fn(); count++; console.log(`PASS ${name}`); }

const BLOWUP = { treatment: 't1', aipw_ate: -129.9, naive_ate: 3.0, psm_ate: 5.9, pooled_outcome_sd: 35.8 };
const PLAUSIBLE = { treatment: 't2', aipw_ate: -23.9, naive_ate: -13.2, psm_ate: -12.7, pooled_outcome_sd: 32.5 };

test('thresholds match causal_inference.py', () => {
  assert.equal(PLAUSIBLE_MAX_ATE_SD, 1.0);
  assert.equal(PLAUSIBLE_DISAGREE_SD, 0.5);
});

test('legacy blow-up row is hidden with both reasons (same text as Python)', () => {
  const p = causalPlausibility(BLOWUP);
  assert.equal(p.implausible, true);
  assert.deepEqual(p.reasons, [
    'AIPW -130 ms is larger than one SD of nightly HRV (36 ms)',
    'AIPW -130 ms is more than 18 ms from both naive (+3) and PSM (+6)',
  ]);
});

test('legacy row within bounds and close to PSM stays', () => {
  assert.deepEqual(causalPlausibility(PLAUSIBLE), { implausible: false, reasons: [] });
});

test('far from naive but agreeing with PSM is confounding, not a blow-up', () => {
  assert.equal(causalPlausibility({ aipw_ate: -20, naive_ate: 5, psm_ate: -17, pooled_outcome_sd: 33 }).implausible, false);
});

test('disagreement rule needs a finite PSM; SD rule does not', () => {
  assert.equal(causalPlausibility({ aipw_ate: -20, naive_ate: 5, psm_ate: null, pooled_outcome_sd: 33 }).implausible, false);
  assert.equal(causalPlausibility({ aipw_ate: 40, naive_ate: 5, psm_ate: null, pooled_outcome_sd: 33 }).implausible, true);
});

test('rows written by the fixed pipeline are trusted as stored', () => {
  assert.deepEqual(
    causalPlausibility({ ...BLOWUP, implausible: false, implausible_reasons: [] }),
    { implausible: false, reasons: [] },
  );
  const stored = causalPlausibility({ ...PLAUSIBLE, implausible: true, implausible_reasons: ['3 of 5 cross-fitting folds skipped (an arm too small)', 7] });
  assert.equal(stored.implausible, true);
  assert.deepEqual(stored.reasons, ['3 of 5 cross-fitting folds skipped (an arm too small)']);
});

test('missing or non-numeric fields never hide a row', () => {
  for (const row of [{}, { aipw_ate: 'x', pooled_outcome_sd: 30 }, { aipw_ate: 200, pooled_outcome_sd: 0 }, { aipw_ate: 200 }]) {
    assert.equal(causalPlausibility(row).implausible, false);
  }
});

test('splitPlausible keeps order and carries reasons', () => {
  const { shown, hidden } = splitPlausible([PLAUSIBLE, BLOWUP, { ...PLAUSIBLE, treatment: 't3' }]);
  assert.deepEqual(shown.map(r => r.treatment), ['t2', 't3']);
  assert.equal(hidden.length, 1);
  assert.equal(hidden[0].row.treatment, 't1');
  assert.equal(hidden[0].reasons.length, 2);
});

console.log(`${count} offline causal plausibility tests passed; synthetic rows only.`);
