// Run: node --test tests/autosave.test.cjs (offline; compiles only lib/autosave.ts). Autosave scheduler, 2026-11-15.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const out = mkdtempSync(path.join(tmpdir(), 'onyx-autosave-'));
execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), 'src/lib/autosave.ts', '--outDir', out, '--module', 'commonjs', '--target', 'ES2022', '--skipLibCheck']);
const { Autosaver, AutosaveRefused } = require(path.join(out, 'autosave.js'));

/** Manual clock: timers run only when advance() passes them. */
function fakeTimers() {
  let now = 0;
  let next = 1;
  const pending = new Map();
  return {
    set: (fn, ms) => { const id = next++; pending.set(id, { at: now + ms, fn }); return id; },
    clear: (id) => { pending.delete(id); },
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
        await settle();
      }
      now = until;
      await settle();
    },
    count: () => pending.size,
  };
}
const settle = () => new Promise((r) => setImmediate(r));

function recorder({ fail = () => null } = {}) {
  const sent = [];
  let gate = null;
  return {
    sent,
    hold() { let open; gate = new Promise((r) => { open = r; }); return () => { gate = null; open(); }; },
    save: async (v) => {
      if (gate) await gate;
      const f = fail(v, sent.length);
      if (f) throw f;
      sent.push(v);
    },
  };
}

test('a burst of changes sends only the newest value, once, after the delay', async () => {
  const t = fakeTimers();
  const r = recorder();
  const s = new Autosaver({ save: r.save, delayMs: 800, timers: t });
  s.change({ a: 1 });
  s.change({ a: 2 });
  await t.advance(500);
  s.change({ a: 3 });
  assert.equal(s.state.status, 'waiting');
  assert.equal(s.dirty, true);
  await t.advance(799);
  assert.deepEqual(r.sent, []);
  await t.advance(1);
  assert.deepEqual(r.sent, [{ a: 3 }]);
  assert.equal(s.state.status, 'saved');
  assert.equal(s.dirty, false);
});

test('a value equal to the stored one sends nothing (baseline and after a save)', async () => {
  const t = fakeTimers();
  const r = recorder();
  const s = new Autosaver({ save: r.save, timers: t }, 'stored');
  s.change('stored');
  await t.advance(5000);
  assert.deepEqual(r.sent, []);
  assert.equal(s.state.status, 'idle');
  s.change('new');
  await t.advance(1000);
  s.change('new');
  await t.advance(1000);
  assert.deepEqual(r.sent, ['new']);
});

test('changing back to the saved value before the timer cancels the save', async () => {
  const t = fakeTimers();
  const r = recorder();
  const s = new Autosaver({ save: r.save, timers: t }, 'a');
  s.change('b');
  s.change('a');
  await t.advance(5000);
  assert.deepEqual(r.sent, []);
  assert.equal(s.dirty, false);
});

test('not ready: nothing is sent and the reason is the state', async () => {
  const t = fakeTimers();
  const r = recorder();
  const s = new Autosaver({ save: r.save, timers: t, ready: (v) => (v > 0 ? null : 'Enter a number') });
  s.change(0);
  await t.advance(5000);
  await s.flush();
  assert.deepEqual(r.sent, []);
  assert.equal(s.state.status, 'incomplete');
  assert.equal(s.state.error, 'Enter a number');
  assert.equal(s.dirty, true, 'typed but not savable still counts as unsaved work');
  s.change(4);
  await t.advance(1000);
  assert.deepEqual(r.sent, [4]);
});

test('single flight: a change during a save is sent after it, with the newest value', async () => {
  const t = fakeTimers();
  const r = recorder();
  const s = new Autosaver({ save: r.save, delayMs: 100, timers: t });
  const open = r.hold();
  s.change(1);
  await t.advance(100); // save of 1 starts and waits
  assert.equal(s.state.status, 'saving');
  s.change(2);
  s.change(3);
  await t.advance(100); // its timer fires while 1 is still in flight
  assert.deepEqual(r.sent, []);
  open();
  await settle();
  await t.advance(0);
  assert.deepEqual(r.sent, [1, 3]);
  assert.equal(s.state.status, 'saved');
});

test('flush() saves at once (blur / Enter) and a delayMs: null value waits for it', async () => {
  const t = fakeTimers();
  const r = recorder();
  const s = new Autosaver({ save: r.save, timers: t });
  s.change('first words', { delayMs: null });
  await t.advance(60000);
  assert.deepEqual(r.sent, []);
  assert.equal(s.state.status, 'waiting');
  await s.flush();
  assert.deepEqual(r.sent, ['first words']);
});

test('a flush-only value is not sent just because an earlier save finished', async () => {
  const t = fakeTimers();
  const r = recorder();
  const s = new Autosaver({ save: r.save, delayMs: 100, timers: t });
  const open = r.hold();
  s.change('a');
  await t.advance(100);
  s.change('a, b', { delayMs: null });
  open();
  await settle();
  await t.advance(0);
  assert.deepEqual(r.sent, ['a']);
  assert.equal(s.state.status, 'waiting');
});

test('a refusal is shown and not retried until the value changes', async () => {
  const t = fakeTimers();
  const r = recorder({ fail: (v) => (v === 'bad' ? new AutosaveRefused('weight must be under 1000 lb') : null) });
  const s = new Autosaver({ save: r.save, timers: t, delayMs: 10 });
  s.change('bad');
  await t.advance(10);
  assert.equal(s.state.status, 'error');
  assert.equal(s.state.error, 'weight must be under 1000 lb');
  assert.equal(s.state.retrying, false);
  assert.equal(t.count(), 0);
  s.change('bad');
  await t.advance(60000);
  assert.deepEqual(r.sent, []);
  s.change('good');
  await t.advance(10);
  assert.deepEqual(r.sent, ['good']);
});

test('offline: retried with backoff until it goes through', async () => {
  const t = fakeTimers();
  let down = 2;
  const r = recorder({ fail: () => (down-- > 0 ? new TypeError('Failed to fetch') : null) });
  const s = new Autosaver({ save: r.save, timers: t, delayMs: 10, retryDelaysMs: [1000, 3000] });
  s.change('x');
  await t.advance(10);
  assert.equal(s.state.status, 'error');
  assert.equal(s.state.retrying, true);
  assert.equal(s.state.error, "Couldn't reach Onyx.");
  await t.advance(1000); // first retry fails
  assert.equal(s.state.status, 'error');
  await t.advance(2999);
  assert.deepEqual(r.sent, []);
  await t.advance(1);
  assert.deepEqual(r.sent, ['x']);
  assert.equal(s.state.status, 'saved');
});

test('retry() sends again at once after a refusal', async () => {
  const t = fakeTimers();
  let refuse = true;
  const r = recorder({ fail: () => (refuse ? new AutosaveRefused('Conflict') : null) });
  const s = new Autosaver({ save: r.save, timers: t, delayMs: 10 });
  s.change('v');
  await t.advance(10);
  refuse = false;
  await s.retry();
  assert.deepEqual(r.sent, ['v']);
});

test('setBaseline: fresh server data equal to what is waiting drops the wait', async () => {
  const t = fakeTimers();
  const r = recorder();
  const s = new Autosaver({ save: r.save, timers: t });
  s.change('same as server');
  s.setBaseline('same as server');
  await t.advance(5000);
  assert.deepEqual(r.sent, []);
  assert.equal(s.dirty, false);
});

test('reset forgets what is waiting', async () => {
  const t = fakeTimers();
  const r = recorder();
  const s = new Autosaver({ save: r.save, timers: t });
  s.change('typed');
  s.reset();
  await t.advance(5000);
  assert.deepEqual(r.sent, []);
  assert.equal(s.state.status, 'idle');
});

test('reset() forgets the saved value too: the same value typed again after an Undo is sent', async () => {
  const t = fakeTimers();
  const r = recorder();
  const s = new Autosaver({ save: r.save, timers: t, delayMs: 10 });
  s.change('185');
  await t.advance(10);
  s.reset(); // Undo put the day back
  s.change('185');
  await t.advance(10);
  assert.deepEqual(r.sent, ['185', '185']);
});

test('reset(baseline) keeps what the server holds: that value sends nothing', async () => {
  const t = fakeTimers();
  const r = recorder();
  const s = new Autosaver({ save: r.save, timers: t, delayMs: 10 });
  s.reset('on server');
  s.change('on server');
  await t.advance(1000);
  assert.deepEqual(r.sent, []);
});

test('flush() answers whether anything is left unsaved', async () => {
  const t = fakeTimers();
  let down = true;
  const r = recorder({ fail: () => (down ? new TypeError('Failed to fetch') : null) });
  const s = new Autosaver({ save: r.save, timers: t, delayMs: 10, ready: (v) => (v ? null : 'Type something') });
  assert.equal(await s.flush(), true, 'nothing waiting');
  s.change('x');
  assert.equal(await s.flush(), false, 'the save failed: keep the form');
  down = false;
  assert.equal(await s.retry(), true);
  s.change('');
  assert.equal(await s.flush(), false, 'incomplete input is not saved');
});
