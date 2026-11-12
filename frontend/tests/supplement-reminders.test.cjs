// Run: node --test tests/supplement-reminders.test.cjs
// Offline tests for the supplement stack reminders (src/lib/supplement-reminders.ts): the claim window,
// dedup and settle sweep, the respond endpoint's idempotency, and the heartbeat throttle. Supabase is replaced
// by a small in-memory fake that mimics the PostgREST calls the module makes (including ON CONFLICT DO NOTHING
// for upsert+ignoreDuplicates and status-guarded updates). Every name and number below is invented.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const frontend = path.join(__dirname, '..');
const output = mkdtempSync(path.join(tmpdir(), 'onyx-supp-reminders-'));
execFileSync(process.execPath, [
  require.resolve('typescript/bin/tsc'),
  path.join('src', 'lib', 'supplement-reminders.ts'),
  path.join('src', 'lib', 'supplement-stacks.ts'),
  '--outDir', output, '--module', 'commonjs', '--target', 'ES2022', '--skipLibCheck', '--strict',
], { cwd: frontend });
const lib = require(path.join(output, 'supplement-reminders.js'));

// ---------------------------------------------------------------------------
// In-memory stand-in for the pds-scoped Supabase client
// ---------------------------------------------------------------------------
function dayIn(tz, instant) {
  // ((instant AT TIME ZONE tz) - 6h)::date
  return new Date(new Date(instant).getTime() - 6 * 3600_000).toLocaleDateString('en-CA', { timeZone: tz });
}

function makeDb({ tz = 'America/New_York', failOn = null, seed = {} } = {}) {
  const tables = {
    supplement_stack: [
      { stack_id: 4, name: 'Morning Stack', remind_time: '08:30', is_active: true, sort_order: 0 },
      { stack_id: 3, name: 'Night Stack', remind_time: '22:30', is_active: true, sort_order: 0 },
    ],
    supplement_stack_item: [
      { item_id: 1, stack_id: 4, product_id: 'p-lion', doses: 1, sort_order: 0 },
      { item_id: 2, stack_id: 4, product_id: 'p-mag', doses: 2, sort_order: 1 },
      { item_id: 3, stack_id: 3, product_id: 'p-night', doses: 1, sort_order: 0 },
    ],
    supplement_products: [
      { product_id: 'p-lion', full_name: "Lion's Mane Mushroom", brand_name: 'Acme Herbs' },
      { product_id: 'p-mag', full_name: 'Magnesium glycinate', brand_name: 'Acme Minerals' },
      { product_id: 'p-night', full_name: null, brand_name: 'Acme Night' },
    ],
    supplement_intake: [],
    supplement_stack_reminder: [],
    sync_log: [],
  };
  for (const [k, v] of Object.entries(seed)) tables[k] = v.map((r) => ({ ...r }));
  const db = { tables, tz, failOn, intakeSeq: 100, calls: [] };

  class Query {
    constructor(table) {
      this.table = table; this.op = 'select'; this.filters = []; this.orders = [];
      this.limitN = null; this.payload = null; this.opts = {}; this.cols = '*'; this.returning = false; this.mode = null;
    }
    select(cols = '*') { this.cols = cols; if (this.op !== 'select') this.returning = true; return this; }
    insert(rows) { this.op = 'insert'; this.payload = [].concat(rows); return this; }
    upsert(rows, opts = {}) { this.op = 'upsert'; this.payload = [].concat(rows); this.opts = opts; return this; }
    update(patch) { this.op = 'update'; this.payload = patch; return this; }
    eq(c, v) { this.filters.push((r) => r[c] === v); return this; }
    in(c, vs) { this.filters.push((r) => vs.includes(r[c])); return this; }
    gte(c, v) { this.filters.push((r) => r[c] >= v); return this; }
    not(c, op, v) {
      assert.equal(op, 'is'); assert.equal(v, null);
      this.filters.push((r) => r[c] !== null && r[c] !== undefined); return this;
    }
    order(c, o = {}) { this.orders.push([c, o.ascending !== false]); return this; }
    limit(n) { this.limitN = n; return this; }
    single() { this.mode = 'single'; return this; }
    maybeSingle() { this.mode = 'maybe'; return this; }
    project(r) {
      if (this.cols === '*') return { ...r };
      const out = {};
      for (const c of this.cols.split(',').map((x) => x.trim())) out[c] = r[c];
      return out;
    }
    exec() {
      db.calls.push(`${this.op}:${this.table}`);
      const message = db.failOn && db.failOn(this.table, this.op);
      if (message) return { data: null, error: { message } };
      const rows = db.tables[this.table];
      assert.ok(rows, `unknown table ${this.table}`);
      let affected;
      if (this.op === 'insert') {
        affected = this.payload.map((r) => {
          const row = { ...r };
          if (this.table === 'supplement_intake') row.intake_id = ++db.intakeSeq;
          rows.push(row);
          return row;
        });
      } else if (this.op === 'upsert') {
        const keys = this.opts.onConflict.split(',');
        affected = [];
        for (const r of this.payload) {
          const dup = rows.find((x) => keys.every((k) => x[k] === r[k]));
          if (dup) {
            if (!this.opts.ignoreDuplicates) { Object.assign(dup, r); affected.push(dup); }
            continue; // ON CONFLICT DO NOTHING: nothing inserted, nothing returned
          }
          const row = { prompted_at: 'now', responded_at: null, ...r };
          rows.push(row);
          affected.push(row);
        }
      } else {
        let m = rows.filter((r) => this.filters.every((f) => f(r)));
        if (this.op === 'update') m.forEach((r) => Object.assign(r, this.payload));
        else {
          for (const [c, asc] of [...this.orders].reverse()) {
            m = [...m].sort((a, b) => (a[c] < b[c] ? -1 : a[c] > b[c] ? 1 : 0) * (asc ? 1 : -1));
          }
          if (this.limitN !== null) m = m.slice(0, this.limitN);
        }
        affected = m;
      }
      if (this.op !== 'select' && !this.returning) return { data: null, error: null };
      const data = affected.map((r) => this.project(r));
      if (this.mode === 'single') {
        return data.length === 1 ? { data: data[0], error: null } : { data: null, error: { message: 'no single row' } };
      }
      if (this.mode === 'maybe') return { data: data[0] ?? null, error: null };
      return { data, error: null };
    }
    then(resolve, reject) { return Promise.resolve().then(() => this.exec()).then(resolve, reject); }
  }

  return Object.assign(db, {
    from: (table) => new Query(table),
    rpc: (name, args) => Promise.resolve().then(() => {
      db.calls.push(`rpc:${name}`);
      if (name === 'tz_for_instant') return { data: db.tz, error: null };
      if (name === 'behavioral_date_for') return { data: dayIn(db.tz, args.ts), error: null };
      return { data: null, error: { message: `unexpected rpc ${name}` } };
    }),
  });
}

const iso = (s) => new Date(s);
// November 2026: America/New_York is EST (UTC-5), Europe/Madrid is CET (UTC+1).
const EST = (day, hhmm) => iso(`2026-11-${day}T${hhmm}:00-05:00`);
const reminders = (db) => db.tables.supplement_stack_reminder;
const intakeRows = (db, stackId) => db.tables.supplement_intake.filter((r) => r.stack_id === stackId);

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------
test('remind_time validation accepts HH:MM, treats blank as off, and rejects the rest', () => {
  for (const ok of ['00:00', '08:30', '19:05', '23:59']) assert.deepEqual(lib.parseRemindTime(ok), { ok: true, value: ok });
  for (const off of [null, '', '   ']) assert.deepEqual(lib.parseRemindTime(off), { ok: true, value: null });
  for (const bad of ['24:00', '8:30', '08:60', '0830', 'noon', '08:30:00', 830, true, {}]) {
    assert.equal(lib.parseRemindTime(bad).ok, false, String(bad));
  }
});

test('window arithmetic wraps midnight and is 4 hours wide', () => {
  const m = (h, min) => h * 60 + min;
  assert.equal(lib.inReminderWindow(m(8, 29), '08:30'), false);
  assert.equal(lib.inReminderWindow(m(8, 30), '08:30'), true);
  assert.equal(lib.inReminderWindow(m(12, 29), '08:30'), true);
  assert.equal(lib.inReminderWindow(m(12, 30), '08:30'), false);
  assert.equal(lib.inReminderWindow(m(23, 59), '22:30'), true);
  assert.equal(lib.inReminderWindow(m(0, 0), '22:30'), true);
  assert.equal(lib.inReminderWindow(m(2, 29), '22:30'), true);
  assert.equal(lib.inReminderWindow(m(2, 30), '22:30'), false);
  assert.equal(lib.inReminderWindow(m(22, 29), '22:30'), false);
});

test('local minutes follow the zone, not the server clock', () => {
  const at = iso('2026-11-11T13:45:00Z');
  assert.equal(lib.localMinutesOfDay(at, 'America/New_York'), 8 * 60 + 45);
  assert.equal(lib.localMinutesOfDay(at, 'Europe/Madrid'), 14 * 60 + 45);
  assert.equal(lib.localMinutesOfDay(iso('2026-11-12T05:05:00Z'), 'America/New_York'), 0 * 60 + 5, 'midnight is 00, not 24');
});

test('addDays and isRealDate are calendar-safe', () => {
  assert.equal(lib.addDays('2026-11-01', -7), '2026-10-25');
  assert.equal(lib.addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(lib.isRealDate('2026-11-11'), true);
  for (const bad of ['2026-02-30', '2026-13-01', '11/11/2026', '2026-11-1', null, 20261111]) assert.equal(lib.isRealDate(bad), false, String(bad));
});

test('item labels: name, multiplier only when not one dose, trimmed to 40 chars, fall back to brand then id', () => {
  assert.equal(lib.itemLabel({ full_name: 'Magnesium glycinate' }, 'x', 2), 'Magnesium glycinate x2');
  assert.equal(lib.itemLabel({ full_name: 'Magnesium glycinate' }, 'x', 1), 'Magnesium glycinate');
  assert.equal(lib.itemLabel({ full_name: 'Zinc' }, 'x', 0.5), 'Zinc x0.5');
  assert.equal(lib.itemLabel({ full_name: null, brand_name: 'Acme' }, 'x', 1), 'Acme');
  assert.equal(lib.itemLabel(undefined, 'custom_123', 1), 'custom_123');
  const long = lib.itemLabel({ full_name: 'A'.repeat(60) }, 'x', 1);
  assert.equal(long.length, 40);
  assert.ok(long.endsWith('…'));
});

test('claim "now" is validated against the server clock', () => {
  const server = iso('2026-11-11T20:00:00Z');
  assert.deepEqual(lib.parseClaimNow(undefined, server), { ok: true, now: null });
  assert.equal(lib.parseClaimNow('2026-11-11T20:03:00Z', server).ok, true);
  assert.equal(lib.parseClaimNow('2026-11-11T08:00:00Z', server).ok, true);
  for (const bad of ['yesterday', 12345, '2026-11-11T20:30:00Z', '2026-11-09T20:00:00Z']) {
    assert.equal(lib.parseClaimNow(bad, server).ok, false, String(bad));
  }
});

test('respond body is validated', () => {
  const good = { stack_id: 4, behavioral_date: '2026-11-11', action: 'log' };
  assert.deepEqual(lib.parseRespondBody(good), { ok: true, value: good });
  assert.equal(lib.parseRespondBody({ ...good, action: 'skip' }).ok, true);
  for (const patch of [{ stack_id: '4' }, { stack_id: 0 }, { stack_id: 1.5 }, { behavioral_date: '2026-02-30' }, { action: 'delete' }, { action: undefined }]) {
    assert.equal(lib.parseRespondBody({ ...good, ...patch }).ok, false, JSON.stringify(patch));
  }
  assert.equal(lib.parseRespondBody(null).ok, false);
});

// ---------------------------------------------------------------------------
// claim
// ---------------------------------------------------------------------------
test('claim: a due stack is claimed once with its card text and a prompted ledger row', async () => {
  const db = makeDb();
  const res = await lib.claimDueReminders(db, EST('11', '08:45'));
  assert.equal(res.ok, true);
  assert.equal(res.behavioral_date, '2026-11-11');
  assert.deepEqual(res.settled, []);
  assert.deepEqual(res.claimed, [
    {
      stack_id: 4,
      name: 'Morning Stack',
      remind_time: '08:30',
      behavioral_date: '2026-11-11',
      item_count: 2,
      items: ["Lion's Mane Mushroom", 'Magnesium glycinate x2'],
    },
  ]);
  assert.equal(reminders(db).length, 1);
  assert.equal(reminders(db)[0].status, 'prompted');
  assert.equal(reminders(db)[0].stack_id, 4);

  const again = await lib.claimDueReminders(db, EST('11', '09:00'));
  assert.deepEqual(again.claimed, [], 'the same day is never claimed twice');
  assert.equal(reminders(db).length, 1);
});

test('claim: window edges for the morning stack (08:30 up to, not including, 12:30 local)', async () => {
  const cases = [['08:29', false], ['08:30', true], ['10:00', true], ['12:29', true], ['12:30', false], ['18:00', false]];
  for (const [t, expected] of cases) {
    const res = await lib.claimDueReminders(makeDb(), EST('11', t));
    assert.equal(res.claimed.some((c) => c.stack_id === 4), expected, t);
  }
});

test('claim: the night stack keeps its own behavioral day across midnight (22:30 up to 02:30)', async () => {
  const before = await lib.claimDueReminders(makeDb(), EST('11', '22:29'));
  assert.equal(before.claimed.length, 0);

  const evening = await lib.claimDueReminders(makeDb(), EST('11', '22:30'));
  assert.deepEqual(evening.claimed.map((c) => [c.stack_id, c.behavioral_date]), [[3, '2026-11-11']]);

  // 00:15 on the 12th is still the 11th's behavioral day (awake-tail rule).
  const late = await lib.claimDueReminders(makeDb(), EST('12', '00:15'));
  assert.equal(late.behavioral_date, '2026-11-11');
  assert.deepEqual(late.claimed.map((c) => [c.stack_id, c.behavioral_date]), [[3, '2026-11-11']]);

  assert.equal((await lib.claimDueReminders(makeDb(), EST('12', '02:29'))).claimed.length, 1);
  assert.equal((await lib.claimDueReminders(makeDb(), EST('12', '02:30'))).claimed.length, 0);
});

test('claim: the first prompt of the evening and a late-night one do not collide (same behavioral day, one claim)', async () => {
  const db = makeDb();
  assert.equal((await lib.claimDueReminders(db, EST('11', '22:31'))).claimed.length, 1);
  assert.equal((await lib.claimDueReminders(db, EST('12', '00:40'))).claimed.length, 0);
  assert.equal(reminders(db).length, 1);
});

test('claim: travel moves the window (zone comes from pds.tz_for_instant)', async () => {
  // 07:45Z is 08:45 in Madrid (due) but 02:45 in New York (not due).
  const abroad = await lib.claimDueReminders(makeDb({ tz: 'Europe/Madrid' }), iso('2026-11-11T07:45:00Z'));
  assert.deepEqual(abroad.claimed.map((c) => c.stack_id), [4]);
  const home = await lib.claimDueReminders(makeDb({ tz: 'America/New_York' }), iso('2026-11-11T07:45:00Z'));
  assert.deepEqual(home.claimed, []);
});

test('claim: a stack already logged for the behavioral day (any path) is not prompted', async () => {
  const db = makeDb({ seed: { supplement_intake: [{ intake_id: 1, stack_id: 4, intake_date: '2026-11-11', product_id: 'p-lion' }] } });
  assert.deepEqual((await lib.claimDueReminders(db, EST('11', '09:00'))).claimed, []);
  assert.equal(reminders(db).length, 0, 'nothing is claimed for a logged stack');
});

test('claim: intake on another day, or from another stack, does not suppress the prompt', async () => {
  const db = makeDb({
    seed: {
      supplement_intake: [
        { intake_id: 1, stack_id: 4, intake_date: '2026-11-10', product_id: 'p-lion' },
        { intake_id: 2, stack_id: 3, intake_date: '2026-11-11', product_id: 'p-night' },
        { intake_id: 3, stack_id: null, intake_date: '2026-11-11', product_id: 'p-lion' },
      ],
    },
  });
  assert.deepEqual((await lib.claimDueReminders(db, EST('11', '09:00'))).claimed.map((c) => c.stack_id), [4]);
});

test('claim: an existing ledger row in any status blocks a second prompt for that day', async () => {
  for (const status of ['prompted', 'logged', 'skipped']) {
    const db = makeDb({ seed: { supplement_stack_reminder: [{ stack_id: 4, behavioral_date: '2026-11-11', status, responded_at: null }] } });
    const res = await lib.claimDueReminders(db, EST('11', '09:00'));
    assert.deepEqual(res.claimed, [], status);
    assert.equal(reminders(db).find((r) => r.stack_id === 4).status, status, 'the existing row is untouched');
  }
});

test('claim: archived stacks and stacks without a reminder time are ignored', async () => {
  const db = makeDb({
    seed: {
      supplement_stack: [
        { stack_id: 4, name: 'Morning Stack', remind_time: '08:30', is_active: false, sort_order: 0 },
        { stack_id: 5, name: 'No reminder', remind_time: null, is_active: true, sort_order: 0 },
        { stack_id: 6, name: 'Bad value', remind_time: '9am', is_active: true, sort_order: 0 },
      ],
    },
  });
  assert.deepEqual((await lib.claimDueReminders(db, EST('11', '09:00'))).claimed, []);
});

test('claim: two simultaneous calls claim a stack exactly once', async () => {
  const db = makeDb();
  const [a, b] = await Promise.all([lib.claimDueReminders(db, EST('11', '09:00')), lib.claimDueReminders(db, EST('11', '09:00'))]);
  assert.equal(a.claimed.length + b.claimed.length, 1);
  assert.equal(reminders(db).length, 1);
});

test('claim: several due stacks come back together; card text is capped at 12 items with the true count', async () => {
  const many = Array.from({ length: 15 }, (_, i) => ({ item_id: 100 + i, stack_id: 4, product_id: `p${i}`, doses: 1, sort_order: i }));
  const db = makeDb({
    seed: {
      supplement_stack: [
        { stack_id: 4, name: 'Morning Stack', remind_time: '22:00', is_active: true, sort_order: 0 },
        { stack_id: 3, name: 'Night Stack', remind_time: '22:30', is_active: true, sort_order: 1 },
      ],
      supplement_stack_item: [...many, { item_id: 1, stack_id: 3, product_id: 'p-night', doses: 1, sort_order: 0 }],
      supplement_products: [{ product_id: 'p-night', full_name: 'Night thing', brand_name: null }],
    },
  });
  const res = await lib.claimDueReminders(db, EST('11', '22:45'));
  assert.deepEqual(res.claimed.map((c) => c.stack_id), [4, 3]);
  assert.equal(res.claimed[0].item_count, 15);
  assert.equal(res.claimed[0].items.length, 12);
  assert.equal(res.claimed[0].items[0], 'p0', 'unknown product falls back to its id');
});

test('claim: settled lists prompts whose stack was logged another way, once, and only those', async () => {
  const db = makeDb({
    seed: {
      supplement_stack_reminder: [
        { stack_id: 3, behavioral_date: '2026-11-10', status: 'prompted', responded_at: null },   // logged elsewhere -> settle
        { stack_id: 4, behavioral_date: '2026-11-10', status: 'prompted', responded_at: null },   // still open -> leave
        { stack_id: 4, behavioral_date: '2026-11-09', status: 'skipped', responded_at: 'x' },     // already answered -> leave
        { stack_id: 3, behavioral_date: '2026-10-01', status: 'prompted', responded_at: null },   // beyond the look-back -> leave
      ],
      supplement_intake: [
        { intake_id: 1, stack_id: 3, intake_date: '2026-11-10', product_id: 'p-night' },
        { intake_id: 2, stack_id: 3, intake_date: '2026-10-01', product_id: 'p-night' },
        { intake_id: 3, stack_id: 4, intake_date: '2026-11-09', product_id: 'p-lion' },
      ],
    },
  });
  const res = await lib.claimDueReminders(db, EST('11', '09:00'));
  assert.deepEqual(res.settled, [{ stack_id: 3, behavioral_date: '2026-11-10', status: 'logged' }]);
  const row = (s, d) => reminders(db).find((r) => r.stack_id === s && r.behavioral_date === d);
  assert.equal(row(3, '2026-11-10').status, 'logged');
  assert.ok(row(3, '2026-11-10').responded_at);
  assert.equal(row(4, '2026-11-10').status, 'prompted');
  assert.equal(row(4, '2026-11-09').status, 'skipped');
  assert.equal(row(3, '2026-10-01').status, 'prompted');

  const again = await lib.claimDueReminders(db, EST('11', '09:05'));
  assert.deepEqual(again.settled, [], 'only rows flipped by THIS call are reported');
});

test('claim: a database error surfaces instead of being swallowed', async () => {
  const db = makeDb({ failOn: (table) => (table === 'supplement_stack' ? 'boom' : null) });
  await assert.rejects(lib.claimDueReminders(db, EST('11', '09:00')), /stack lookup: boom/);
});

test('claim: everything that can fail runs before the claiming insert', async () => {
  const db = makeDb({ failOn: (table) => (table === 'supplement_products' ? 'products down' : null) });
  await assert.rejects(lib.claimDueReminders(db, EST('11', '09:00')), /product lookup/);
  assert.equal(reminders(db).length, 0, 'a failed call must not leave a claimed-but-undelivered prompt behind');
});

// ---------------------------------------------------------------------------
// heartbeat
// ---------------------------------------------------------------------------
function clockAt(start) {
  let t = new Date(start).getTime();
  const clock = () => new Date(t);
  clock.advance = (ms) => { t += ms; };
  return clock;
}
const heartbeats = (db) => db.tables.sync_log.filter((r) => r.source === 'supplement_reminders');
const MIN = 60_000;

test('heartbeat: written on the first call, throttled to one per 50 minutes when nothing is claimed', async () => {
  const db = makeDb();
  const clock = clockAt('2026-11-11T14:00:00Z');
  const quiet = () => lib.runClaim(db, EST('11', '15:00'), clock); // 15:00 EST: nothing due

  await quiet();
  assert.equal(heartbeats(db).length, 1);
  assert.equal(heartbeats(db)[0].data_type, 'prompt');
  assert.equal(heartbeats(db)[0].status, 'success');
  assert.equal(heartbeats(db)[0].records_synced, 0);
  assert.equal(heartbeats(db)[0].error_message, null);

  clock.advance(20 * MIN); await quiet();
  clock.advance(20 * MIN); await quiet();
  assert.equal(heartbeats(db).length, 1, 'quiet polls inside 50 minutes add nothing');

  clock.advance(15 * MIN); await quiet();
  assert.equal(heartbeats(db).length, 2, 'a quiet poll after 50 minutes refreshes the heartbeat');
});

test('heartbeat: a claim is always recorded with the number claimed', async () => {
  const db = makeDb();
  const clock = clockAt('2026-11-11T13:50:00Z');
  await lib.runClaim(db, EST('11', '07:00'), clock); // quiet first heartbeat
  clock.advance(5 * MIN);
  const res = await lib.runClaim(db, EST('11', '09:00'), clock);
  assert.equal(res.claimed.length, 1);
  assert.equal(heartbeats(db).length, 2);
  assert.equal(heartbeats(db)[1].records_synced, 1);
  assert.equal(heartbeats(db)[1].status, 'success');
  assert.ok(heartbeats(db)[1].sync_start && heartbeats(db)[1].sync_end);
  assert.equal(typeof heartbeats(db)[1].duration_seconds, 'number');
});

test('heartbeat: a failure writes a failed row with the message, rethrows, and repeats are throttled', async () => {
  const db = makeDb({ failOn: (table) => (table === 'supplement_stack' ? 'database unreachable' : null) });
  const clock = clockAt('2026-11-11T14:00:00Z');
  await assert.rejects(lib.runClaim(db, EST('11', '09:00'), clock), /database unreachable/);
  assert.equal(heartbeats(db).length, 1);
  assert.equal(heartbeats(db)[0].status, 'failed');
  assert.match(heartbeats(db)[0].error_message, /database unreachable/);

  clock.advance(10 * MIN);
  await assert.rejects(lib.runClaim(db, EST('11', '09:00'), clock));
  assert.equal(heartbeats(db).length, 1, 'the same failure is not re-logged within 50 minutes');
});

test('heartbeat: a sync_log outage never turns a successful claim into an error', async () => {
  const db = makeDb({ failOn: (table) => (table === 'sync_log' ? 'sync_log down' : null) });
  const res = await lib.runClaim(db, EST('11', '09:00'), clockAt('2026-11-11T14:00:00Z'));
  assert.equal(res.claimed.length, 1, 'the claim result still reaches the Worker');
});

// ---------------------------------------------------------------------------
// respond
// ---------------------------------------------------------------------------
async function claimed(db, at = EST('11', '09:00')) {
  await lib.claimDueReminders(db, at);
  return db;
}
const respond = (db, input, at = EST('11', '09:10')) => lib.respondToReminder(db, input, () => at);
const LOG = { stack_id: 4, behavioral_date: '2026-11-11', action: 'log' };
const SKIP = { ...LOG, action: 'skip' };

test('respond log: writes one intake per item for the claimed day and settles the reminder', async () => {
  const db = await claimed(makeDb());
  const res = await respond(db, LOG);
  assert.equal(res.httpStatus, 200);
  assert.deepEqual(res.body, { ok: true, status: 'logged', message: 'Logged Morning Stack: 2 items', intake_count: 2 });

  const rows = intakeRows(db, 4);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => [r.product_id, r.doses]), [['p-lion', 1], ['p-mag', 2]]);
  for (const r of rows) {
    assert.equal(r.intake_date, '2026-11-11');
    assert.equal(r.stack_id, 4);
    assert.equal(r.intake_time, EST('11', '09:10').toISOString(), 'the current behavioral day keeps the truthful clock time');
  }
  assert.equal(reminders(db)[0].status, 'logged');
  assert.ok(reminders(db)[0].responded_at);
});

test('respond log: a late tap for an earlier behavioral day records the day with no clock time', async () => {
  const db = makeDb({ seed: { supplement_stack_reminder: [{ stack_id: 3, behavioral_date: '2026-11-10', status: 'prompted', responded_at: null }] } });
  const res = await respond(db, { stack_id: 3, behavioral_date: '2026-11-10', action: 'log' }, EST('11', '08:00'));
  assert.equal(res.body.status, 'logged');
  assert.equal(res.body.message, 'Logged Night Stack: 1 item');
  const [row] = intakeRows(db, 3);
  assert.equal(row.intake_date, '2026-11-10');
  assert.equal(row.intake_time, null);
});

test('respond log: a second call never logs twice', async () => {
  const db = await claimed(makeDb());
  await respond(db, LOG);
  const second = await respond(db, LOG);
  assert.equal(second.httpStatus, 200);
  assert.equal(second.body.status, 'already_logged');
  assert.equal(second.body.ok, true);
  assert.equal(second.body.intake_count, 2);
  assert.match(second.body.message, /Morning Stack was already logged today/);
  assert.equal(intakeRows(db, 4).length, 2);
});

test('respond log: two simultaneous taps write the stack once', async () => {
  const db = await claimed(makeDb());
  const [a, b] = await Promise.all([respond(db, LOG), respond(db, LOG)]);
  assert.deepEqual([a.body.status, b.body.status].sort(), ['already_logged', 'logged']);
  assert.equal(intakeRows(db, 4).length, 2);
  assert.equal(reminders(db)[0].status, 'logged');
});

test('respond log: a stack already logged another way is reported, not duplicated, and the row is settled', async () => {
  const db = await claimed(makeDb());
  db.tables.supplement_intake.push({ intake_id: 1, stack_id: 4, intake_date: '2026-11-11', product_id: 'p-lion' });
  const res = await respond(db, LOG);
  assert.equal(res.body.status, 'already_logged');
  assert.equal(res.body.intake_count, 1);
  assert.equal(intakeRows(db, 4).length, 1, 'no extra rows');
  assert.equal(reminders(db)[0].status, 'logged');
});

test('respond log: a failed write puts the reminder back so the card can be tapped again', async () => {
  const db = await claimed(makeDb());
  let broken = true;
  db.failOn = (table, op) => (broken && table === 'supplement_intake' && op === 'insert' ? 'insert failed' : null);
  const first = await respond(db, LOG);
  assert.equal(first.httpStatus, 400);
  assert.equal(first.body.ok, false);
  assert.match(first.body.error, /insert failed/);
  assert.equal(reminders(db)[0].status, 'prompted');
  assert.equal(reminders(db)[0].responded_at, null);
  assert.equal(intakeRows(db, 4).length, 0);

  broken = false;
  const retry = await respond(db, LOG);
  assert.equal(retry.body.status, 'logged');
  assert.equal(intakeRows(db, 4).length, 2);
});

test('respond log: an archived stack cannot be logged and its reminder is left alone', async () => {
  const db = await claimed(makeDb());
  db.tables.supplement_stack.find((s) => s.stack_id === 4).is_active = false;
  const res = await respond(db, LOG);
  assert.equal(res.httpStatus, 409);
  assert.equal(res.body.ok, false);
  assert.equal(reminders(db)[0].status, 'prompted');
  assert.equal(intakeRows(db, 4).length, 0);
});

test('respond skip: settles the reminder without logging anything', async () => {
  const db = await claimed(makeDb());
  const res = await respond(db, SKIP);
  assert.equal(res.httpStatus, 200);
  assert.deepEqual(res.body, { ok: true, status: 'skipped', message: 'Skipped Morning Stack today' });
  assert.equal(reminders(db)[0].status, 'skipped');
  assert.ok(reminders(db)[0].responded_at);
  assert.equal(intakeRows(db, 4).length, 0);

  const again = await respond(db, SKIP);
  assert.equal(again.body.status, 'skipped', 'skipping twice is fine');
  assert.equal(reminders(db)[0].status, 'skipped');
});

test('respond skip: an earlier day is named in the message', async () => {
  const db = makeDb({ seed: { supplement_stack_reminder: [{ stack_id: 3, behavioral_date: '2026-11-10', status: 'prompted', responded_at: null }] } });
  const res = await respond(db, { stack_id: 3, behavioral_date: '2026-11-10', action: 'skip' }, EST('11', '08:00'));
  assert.equal(res.body.message, 'Skipped Night Stack for 2026-11-10');
});

test('respond skip: after the stack was logged it answers already_logged and keeps the intake', async () => {
  const db = await claimed(makeDb());
  await respond(db, LOG);
  const res = await respond(db, SKIP);
  assert.equal(res.body.status, 'already_logged');
  assert.equal(intakeRows(db, 4).length, 2);
  assert.equal(reminders(db)[0].status, 'logged');
});

test('respond skip: a stack logged elsewhere while the card was open settles as logged, not skipped', async () => {
  const db = await claimed(makeDb());
  db.tables.supplement_intake.push({ intake_id: 1, stack_id: 4, intake_date: '2026-11-11', product_id: 'p-lion' });
  const res = await respond(db, SKIP);
  assert.equal(res.body.status, 'already_logged');
  assert.equal(reminders(db)[0].status, 'logged');
});

test('respond log: changing your mind after a skip logs the stack', async () => {
  const db = await claimed(makeDb());
  await respond(db, SKIP);
  const res = await respond(db, LOG);
  assert.equal(res.body.status, 'logged');
  assert.equal(intakeRows(db, 4).length, 2);
  assert.equal(reminders(db)[0].status, 'logged');
});

test('respond: only a (stack, day) that was actually prompted can be answered', async () => {
  const db = await claimed(makeDb());
  for (const input of [
    { ...LOG, stack_id: 3 },                         // that stack was never prompted today
    { ...LOG, behavioral_date: '2026-11-09' },       // no prompt for that day
    { ...LOG, stack_id: 999 },                       // no such stack
  ]) {
    const res = await respond(db, input);
    assert.equal(res.httpStatus, 404, JSON.stringify(input));
    assert.equal(res.body.ok, false);
    assert.equal(typeof res.body.error, 'string');
  }
  assert.equal(db.tables.supplement_intake.length, 0);
});
