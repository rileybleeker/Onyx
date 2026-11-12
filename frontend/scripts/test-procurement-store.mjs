/**
 * Offline tests for saving the /procurement subscription tracker: payload validation, row mapping,
 * the missing-table fallback (SQL not applied yet), the store against a fake database, and the
 * guarantee that no purchase / order / checkout action exists. No network, no database, no secrets.
 * Run: node frontend/scripts/test-procurement-store.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const root = new URL('../', import.meta.url);
const read = rel => fs.readFileSync(new URL(rel, root), 'utf8');
function load(rel, requires = {}) {
  const js = ts.transpileModule(read(rel), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const module = { exports: {} };
  vm.runInThisContext(`(function (exports, module, require) {${js}\n})`)(module.exports, module, name => { if (name in requires) return requires[name]; throw new Error('unexpected import ' + name); });
  return module.exports;
}
const lib = load('src/lib/procurement.ts');
const store = load('src/lib/procurement-store.ts', { './procurement': lib });

/** A Supabase-shaped fake: every chained call is recorded, awaiting resolves to the next queued {data, error}. */
function fakeDb(queue) {
  const calls = [];
  return {
    calls,
    from(table) {
      const call = { table, ops: [] }; calls.push(call);
      const result = queue.shift() ?? { data: [], error: null };
      const chain = new Proxy({}, { get(_, op) {
        if (op === 'then') return (resolve, reject) => Promise.resolve(result).then(resolve, reject);
        return (...args) => { call.ops.push([op, ...args]); return chain; };
      } });
      return chain;
    },
  };
}
const ops = (call, name) => call.ops.filter(o => o[0] === name);
const row = (over = {}) => ({ subscription_id: 7, name: 'Demo Tool', vendor: null, amount_cents: 999, currency: 'USD', cadence: 'monthly', next_renewal: '2026-12-01', notes: null, is_active: true, ...over });
const body = (over = {}) => ({ name: ' Demo Tool ', amount: '9.99', cycle: 'monthly', renewsOn: '2026-12-01', ...over });
const MISSING = { code: 'PGRST205', message: "Could not find the table 'pds.procurement_subscriptions' in the schema cache" };

// --- payload validation (same rules as the form, plus vendor/notes) ---
const ok = lib.parseSubscriptionInput(body({ vendor: ' Acme ', notes: 'Annual review\nin March' }));
assert.equal(ok.name, 'Demo Tool'); assert.equal(ok.cents, 999); assert.equal(ok.currency, 'USD'); assert.equal(ok.vendor, 'Acme'); assert.equal(ok.notes, 'Annual review\nin March');
assert.equal(lib.parseSubscriptionInput(body()).vendor, ''); assert.equal(lib.parseSubscriptionInput(body({ vendor: null, notes: null })).notes, '');
for (const bad of [null, undefined, 'x', 5, [], [body()]]) assert.throws(() => lib.parseSubscriptionInput(bad), bad === undefined ? /JSON object/ : /JSON object/);
for (const key of ['name', 'amount', 'cycle', 'renewsOn']) { const b = body(); delete b[key]; assert.throws(() => lib.parseSubscriptionInput(b), /Missing/, key); }
assert.throws(() => lib.parseSubscriptionInput(body({ amount: 9.99 })), /Missing amount/);   // numbers are rejected: amounts travel as exact-cent strings
for (const amount of ['0', '-1', '1e3', 'NaN', '1.234', '10000000', '', ' 1']) assert.throws(() => lib.parseSubscriptionInput(body({ amount })), /USD amount/, amount);
assert.throws(() => lib.parseSubscriptionInput(body({ name: '' })));
assert.throws(() => lib.parseSubscriptionInput(body({ name: 'x'.repeat(81) })));
assert.throws(() => lib.parseSubscriptionInput(body({ name: 'Bad\r\nname' })));
assert.throws(() => lib.parseSubscriptionInput(body({ cycle: 'weekly' })));
assert.throws(() => lib.parseSubscriptionInput(body({ cycle: 'toString' })));
assert.throws(() => lib.parseSubscriptionInput(body({ renewsOn: '2026-02-30' })));
assert.throws(() => lib.parseSubscriptionInput(body({ vendor: 'v'.repeat(81) })), /Vendor/);
assert.throws(() => lib.parseSubscriptionInput(body({ vendor: 'a\nb' })), /Vendor/);
assert.throws(() => lib.parseSubscriptionInput(body({ notes: 'n'.repeat(501) })), /Notes/);
assert.throws(() => lib.parseSubscriptionInput(body({ notes: 'bell\u0007' })), /Notes/);
assert.throws(() => lib.parseSubscriptionInput(body({ vendor: 5 })), /vendor must be text/);

// --- row mapping ---
assert.deepEqual(lib.subscriptionToRow(ok), { name: 'Demo Tool', vendor: 'Acme', amount_cents: 999, currency: 'USD', cadence: 'monthly', next_renewal: '2026-12-01', notes: 'Annual review\nin March' });
assert.equal(lib.subscriptionToRow(lib.parseSubscriptionInput(body())).vendor, null);
assert.deepEqual(lib.subscriptionFromRow(row()), { id: 7, name: 'Demo Tool', cents: 999, currency: 'USD', cycle: 'monthly', renewsOn: '2026-12-01' });
assert.equal(lib.subscriptionFromRow(row({ vendor: 'Acme', notes: 'n' })).vendor, 'Acme');
for (const bad of [null, undefined, {}, row({ subscription_id: '7' }), row({ name: '  ' }), row({ amount_cents: 0 }), row({ amount_cents: 9.5 }), row({ cadence: 'weekly' }), row({ cadence: 'toString' }), row({ next_renewal: '2026-02-30' }), row({ next_renewal: null })]) assert.equal(lib.subscriptionFromRow(bad), null);
assert.equal(lib.parseRowId('42'), 42);
for (const bad of ['', '0', '-1', '1.5', '1e3', 'abc', '12 ', '99999999999999999', '../1']) assert.equal(lib.parseRowId(bad), null, bad);

// --- missing-table detection: only "table not there", never a real failure ---
assert.equal(lib.isMissingTableError(MISSING), true);
assert.equal(lib.isMissingTableError({ code: '42P01', message: 'relation "pds.procurement_subscriptions" does not exist' }), true);
assert.equal(lib.isMissingTableError({ message: 'relation "pds.procurement_subscriptions" does not exist' }), true);
assert.equal(lib.isMissingTableError({ message: 'Could not find the table pds.procurement_subscriptions in the schema cache' }), true);
for (const real of [null, undefined, {}, { code: '42501', message: 'permission denied for table procurement_subscriptions' }, { code: '23514', message: 'new row violates check constraint' }, { message: 'fetch failed' }, { code: 'PGRST301', message: 'JWT expired' }]) assert.equal(lib.isMissingTableError(real), false, JSON.stringify(real));

// --- store against a fake database: happy path ---
{
  const db = fakeDb([{ data: [row(), row({ subscription_id: 8, name: 'Other', next_renewal: '2026-12-15' }), { junk: true }], error: null }]);
  const r = await store.listSubscriptions(db);
  assert.equal(r.ok, true); assert.equal(r.value.length, 2, 'invalid rows are dropped, not shown');
  assert.equal(db.calls[0].table, 'procurement_subscriptions');
  assert.deepEqual(ops(db.calls[0], 'eq'), [['eq', 'is_active', true]]);   // archived rows never listed
}
{
  const db = fakeDb([{ data: [], error: null }, { data: row({ vendor: 'Acme' }), error: null }]);
  const r = await store.createSubscriptionRecord(db, ok);
  assert.equal(r.ok, true); assert.equal(r.value.id, 7); assert.equal(r.value.vendor, 'Acme');
  assert.equal(ops(db.calls[1], 'insert')[0][1].amount_cents, 999);
  assert.equal('is_active' in ops(db.calls[1], 'insert')[0][1], false, 'new rows rely on the column default');
}
{
  const db = fakeDb([{ data: [row({ name: 'Renamed' })], error: null }]);
  const r = await store.updateSubscriptionRecord(db, 7, ok);
  assert.equal(r.ok, true); assert.equal(ops(db.calls[0], 'eq')[0][2], 7); assert.equal(ops(db.calls[0], 'eq')[1][1], 'is_active');
  assert.equal(typeof ops(db.calls[0], 'update')[0][1].updated_at, 'string');
  const gone = await store.updateSubscriptionRecord(fakeDb([{ data: [], error: null }]), 99, ok);
  assert.deepEqual({ ok: gone.ok, status: gone.status }, { ok: false, status: 404 });
}
{
  const db = fakeDb([{ data: [{ subscription_id: 7 }], error: null }]);
  const r = await store.archiveSubscriptionRecord(db, 7);
  assert.equal(r.ok, true);
  const patch = ops(db.calls[0], 'update')[0][1];
  assert.equal(patch.is_active, false); assert.equal(ops(db.calls[0], 'delete').length, 0, 'archive is a soft delete, never a row delete');
  assert.equal((await store.archiveSubscriptionRecord(fakeDb([{ data: [], error: null }]), 7)).status, 404);
  const all = fakeDb([{ data: [{ subscription_id: 1 }, { subscription_id: 2 }], error: null }]);
  assert.equal((await store.archiveAllSubscriptions(all)).value.archived, 2); assert.equal(ops(all.calls[0], 'delete').length, 0);
}
// cap
{
  const full = Array.from({ length: lib.MAX_SUBSCRIPTIONS }, (_, i) => row({ subscription_id: i + 1 }));
  const db = fakeDb([{ data: full, error: null }]);
  const r = await store.createSubscriptionRecord(db, ok);
  assert.equal(r.status, 409); assert.equal(db.calls.length, 1, 'no insert attempted once the tracker is full');
}

// --- the missing-table fallback: SQL not applied yet ---
{
  const list = await store.listSubscriptions(fakeDb([{ data: null, error: MISSING }]));
  assert.deepEqual({ ok: list.ok, setupPending: list.setupPending }, { ok: false, setupPending: true });
  const readResp = store.failureResponse(list, true);
  assert.equal(readResp.status, 200, 'a read must not fail the page');
  assert.equal(readResp.body.persisted, false); assert.equal(readResp.body.setupPending, true); assert.deepEqual(readResp.body.subscriptions, []);
  assert.match(readResp.body.message, /Not saved yet - setup pending/);

  const db = fakeDb([{ data: null, error: MISSING }]);
  const created = await store.createSubscriptionRecord(db, ok);
  assert.equal(created.setupPending, true); assert.equal(db.calls.length, 1, 'no insert is attempted against a missing table');
  const writeResp = store.failureResponse(created, false);
  assert.equal(writeResp.status, 503); assert.equal(writeResp.body.setupPending, true); assert.match(writeResp.body.error, /Not saved yet - setup pending/);

  for (const call of [
    store.updateSubscriptionRecord(fakeDb([{ data: null, error: MISSING }]), 1, ok),
    store.archiveSubscriptionRecord(fakeDb([{ data: null, error: { code: '42P01', message: 'x' } }]), 1),
    store.archiveAllSubscriptions(fakeDb([{ data: null, error: MISSING }])),
  ]) assert.equal((await call).setupPending, true);

  // A real failure is NOT reported as "setup pending": the owner should see it.
  const broken = await store.listSubscriptions(fakeDb([{ data: null, error: { code: '42501', message: 'permission denied for table procurement_subscriptions' } }]));
  assert.deepEqual({ ok: broken.ok, setupPending: broken.setupPending, status: broken.status }, { ok: false, setupPending: false, status: 500 });
  assert.equal(store.failureResponse(broken, true).status, 500);
  assert.equal(store.failureResponse(await store.archiveSubscriptionRecord(fakeDb([{ data: [], error: null }]), 5), false).status, 404);
}

// --- the page keeps working without the table ---
const client = read('src/app/procurement/ProcurementClient.tsx');
assert.match(client, /Not saved yet - setup pending/);
assert.match(client, /setStore\(body && body\.setupPending === true \? 'pending' : 'unavailable'\)/);
assert.match(client, /catch \{ if \(!cancelled\) setStore\('unavailable'\); \}/, 'a failed or non-JSON load must not break the page');
for (const heading of ['Procurement', 'Disconnected preview', 'Track subscriptions', 'Plan an order', 'Why execution is disabled']) assert.ok(client.includes(`>${heading}</h`), heading);   // headings the smoke test and UI test rely on
assert.ok(client.includes('<button className={button} disabled>Place order (unavailable)</button>'));
assert.ok(client.includes('No subscriptions tracked yet.'));

// --- there is no purchase, checkout, order-submission or cancel action anywhere ---
assert.equal(lib.executionReadiness().allowed, false); assert.equal(lib.executionReadiness.length, 0);
const FORBIDDEN_NAME = /^(place|submit|buy|purchase|checkout|pay|order|cancel|subscribe|charge|execute|approve)/i;
for (const [name, mod] of [['procurement', lib], ['procurement-store', store]]) for (const key of Object.keys(mod)) if (typeof mod[key] === 'function') assert.doesNotMatch(key, FORBIDDEN_NAME, `${name}.${key}`);
assert.equal(client.match(/Place order/g).length, 1, 'only the disabled placeholder button mentions placing an order');
assert.equal((client.match(/<button[^>]*>Place order[^<]*<\/button>/g) ?? []).every(b => /\bdisabled>/.test(b)), true);
const fetches = [...client.matchAll(/fetch\(([^,)]+)/g)].map(m => m[1].trim());
assert.ok(fetches.length > 0 && fetches.every(f => f === 'SUBSCRIPTIONS_API' || f.startsWith('`${SUBSCRIPTIONS_API}/')), 'the page only talks to its own subscriptions API: ' + fetches.join(' | '));
const routeFiles = [];
(function walk(dir) { for (const e of fs.readdirSync(new URL(dir, root), { withFileTypes: true })) { const rel = dir + e.name + (e.isDirectory() ? '/' : ''); if (e.isDirectory()) walk(rel); else routeFiles.push(rel); } })('src/app/api/procurement/');
assert.deepEqual(routeFiles.sort(), ['src/app/api/procurement/subscriptions/[id]/route.ts', 'src/app/api/procurement/subscriptions/route.ts'], 'only the tracker routes exist under /api/procurement');
for (const file of routeFiles) {
  const src = read(file);
  const methods = [...src.matchAll(/export async function (\w+)/g)].map(m => m[1]);
  assert.ok(methods.length > 0 && methods.every(m => ['GET', 'POST', 'PATCH', 'DELETE'].includes(m)), file + ': ' + methods);
  assert.doesNotMatch(src, /\b(fetch|axios|https?:\/\/)/, file + ' must not call any merchant or provider');
}
// Session-protected: the procurement API is not on the middleware's no-session carve-outs.
assert.doesNotMatch(read('src/middleware.ts'), /api\/procurement/);

// --- the SQL: idempotent, service-role only, nothing removed, no anon access ---
const sql = fs.readFileSync(new URL('../sql/procurement_schema.sql', root), 'utf8');
const sqlCode = sql.split('\n').filter(l => !l.trim().startsWith('--')).join('\n').replace(/--.*$/gm, '');
assert.match(sqlCode, /CREATE TABLE IF NOT EXISTS pds\.procurement_subscriptions/);
assert.match(sqlCode, /CREATE INDEX IF NOT EXISTS/);
assert.match(sqlCode, /ENABLE ROW LEVEL SECURITY/);
assert.match(sqlCode, /REVOKE ALL ON pds\.procurement_subscriptions FROM anon, authenticated/);
assert.doesNotMatch(sqlCode, /\bDROP\b|\bDELETE\b|\bTRUNCATE\b|TO anon|TO authenticated|TO public/i);
for (const col of ['subscription_id', 'name', 'vendor', 'amount_cents', 'currency', 'cadence', 'next_renewal', 'notes', 'is_active', 'created_at', 'updated_at']) assert.match(sqlCode, new RegExp('\\b' + col + '\\b'), col);

console.log('PASS procurement store: payload validation, row mapping, missing-table fallback, fake-db store (list/create/update/archive/cap), page fallback strings, no purchase action, SQL guards');
