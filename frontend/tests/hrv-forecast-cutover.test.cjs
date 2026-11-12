// Run: node --test tests/hrv-forecast-cutover.test.cjs
// Synthetic rows only. Covers the pure old-pairing / same-night split used by the
// Prediction-vs-Actual chart and the residual histogram on /analytics/hrv, and the shape of
// the residuals query that feeds the histogram.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function load(file, requireImpl = () => { throw new Error('unexpected import'); }, extra = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../src/lib', file), 'utf8');
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const exports = {};
  vm.runInNewContext(code, { exports, require: requireImpl, String, Date, Intl, Map, ...extra });
  return exports;
}
const plain = (v) => JSON.parse(JSON.stringify(v));
const cutover = load('hrv-forecast-cutover.ts');

test('cutover date is the first same-night prediction_date', () => {
  assert.equal(cutover.SAME_NIGHT_FIRST_PREDICTION_DATE, '2026-11-10');
});

test('live forecasts before the cutover are old pairing; from it on they are not', () => {
  const live = (d, v = '2026-11-08_v1') => ({ prediction_date: d, model_version: v });
  assert.equal(cutover.forecastSource(live('2026-11-09')), 'live forecast, old pairing (before the fix)');
  assert.equal(cutover.forecastSource(live('2026-11-10', '2026-11-11_v1')), 'live forecast');
  assert.equal(cutover.forecastSource(live('2026-11-12', '2026-11-11_v1')), 'live forecast');
  assert.equal(cutover.isSameNightComparable(live('2026-11-09')), false);
  assert.equal(cutover.isSameNightComparable(live('2026-11-10', '2026-11-11_v1')), true);
});

test('legacy and retrain-path live rows count as live, not backtest', () => {
  assert.equal(cutover.isSameNightComparable({ prediction_date: '2026-05-01', model_version: 'legacy_v0' }), false);
  assert.equal(cutover.isSameNightComparable({ prediction_date: '2026-06-01', model_version: '2026-06-01_behavioral_v1' }), false);
  assert.equal(cutover.isSameNightComparable({ prediction_date: '2026-11-11', model_version: '2026-11-11_behavioral_v1' }), true);
});

test('walk-forward backtest rows are comparable whatever date they carry', () => {
  for (const d of ['2025-05-18', '2026-10-02', '2026-11-09']) {
    assert.equal(cutover.forecastSource({ prediction_date: d, model_version: 'backtest_initial' }), 'walk-forward backtest');
    assert.equal(cutover.isSameNightComparable({ prediction_date: d, model_version: 'backtest_initial' }), true);
  }
});

test('missing version or date does not throw; a missing date reads as old pairing', () => {
  assert.equal(cutover.isSameNightComparable({}), false);
  assert.equal(cutover.isSameNightComparable({ prediction_date: '2026-11-11', model_version: null }), true);
  assert.equal(cutover.isSameNightComparable({ prediction_date: '2026-11-09', model_version: undefined }), false);
});

test('splitComparable keeps order and partitions every row exactly once', () => {
  const rows = [
    { prediction_date: '2026-10-01', model_version: 'backtest_initial', residual: 1 },
    { prediction_date: '2026-11-08', model_version: '2026-11-07_v1', residual: 2 },
    { prediction_date: '2026-11-09', model_version: '2026-11-08_v1', residual: 3 },
    { prediction_date: '2026-11-10', model_version: '2026-11-11_v1', residual: 4 },
  ];
  const { used, excluded } = plain(cutover.splitComparable(rows));
  assert.deepEqual(used.map(r => r.residual), [1, 4]);
  assert.deepEqual(excluded.map(r => r.residual), [2, 3]);
  assert.equal(used.length + excluded.length, rows.length);
});

test('eval-view rows: a date with a rewritten backtest row stays, only backtest-less old live dates are left out', () => {
  // hrv_predictions_eval keeps the newest row per date. A backtest row is created after the
  // live forecast for its date, so dates that have both arrive as the backtest row.
  const evalRows = [
    { prediction_date: '2026-10-16', model_version: 'backtest_initial', residual: 1 }, // had an old live forecast too
    { prediction_date: '2026-10-17', model_version: '2026-10-16_v1', residual: 2 },    // old live only
    { prediction_date: '2026-11-09', model_version: 'backtest_initial', residual: 3 }, // had an old live forecast too
    { prediction_date: '2026-11-10', model_version: '2026-11-11_v1', residual: 4 },    // same-night live
  ];
  const { used, excluded } = plain(cutover.splitComparable(evalRows));
  assert.deepEqual(used.map(r => r.residual), [1, 3, 4]);
  assert.deepEqual(excluded.map(r => r.residual), [2]);
});

test('getHrvResiduals reads the eval view (newest row per date) with model_version, xgboost h=1 only', async () => {
  const calls = [];
  const rows = [{ prediction_date: '2026-11-10', model: 'xgboost', model_version: '2026-11-11_v1', residual: 3 }];
  const client = {
    from(table) {
      const q = { table, eq: [], order: [], not: [] };
      calls.push(q);
      const chain = {
        select(cols) { q.select = cols; return chain; },
        eq(k, v) { q.eq.push([k, v]); return chain; },
        not(...a) { q.not.push(a); return chain; },
        order(k, o) { q.order.push([k, o]); return chain; },
        then(resolve, reject) { return Promise.resolve({ data: rows, error: null }).then(resolve, reject); },
      };
      return chain;
    },
  };
  const queries = load('queries-hrv.ts', (id) => {
    if (id === '@/lib/supabase') return { supabase: client };
    if (id === '@/lib/queries') return {};
    throw new Error(id);
  });
  const out = await queries.getHrvResiduals();
  assert.equal(out.length, 1);
  const q = calls[0];
  assert.equal(q.table, 'hrv_predictions_eval');
  assert.ok(q.select.split(',').includes('model_version'));
  assert.ok(q.select.split(',').includes('residual'));
  assert.deepEqual(plain(q.eq), [['model', 'xgboost'], ['horizon_days', 1]]);
  assert.deepEqual(plain(q.not), [['residual', 'is', null]]);
  assert.deepEqual(plain(q.order), [['prediction_date', { ascending: true }]]);
});

test('getHrvResiduals rejects on a PostgREST error so the ISR prefetch fails open', async () => {
  const client = {
    from() {
      const chain = {
        select() { return chain; }, eq() { return chain; }, not() { return chain; }, order() { return chain; },
        then(resolve, reject) { return Promise.resolve({ data: null, error: new Error('synthetic') }).then(resolve, reject); },
      };
      return chain;
    },
  };
  const queries = load('queries-hrv.ts', (id) => (id === '@/lib/supabase' ? { supabase: client } : {}));
  await assert.rejects(() => queries.getHrvResiduals(), /synthetic/);
});
