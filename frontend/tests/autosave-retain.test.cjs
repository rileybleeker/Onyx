// Run: node --test tests/autosave-retain.test.cjs (offline; compiles lib/autosave.ts, lib/unsaved-work.ts and
// lib/autosave-retain.ts only). PROD-T01, 2026-11-16: an autosaving form whose component unmounts (the scroll
// dropping the Log page, a navigation, a hidden part) keeps its entry, its operation key and its retry until saved.
// SYNTHETIC DATA ONLY: invented values; no network, no storage.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const out = mkdtempSync(path.join(tmpdir(), 'onyx-autosave-retain-'));
execFileSync(process.execPath, [
  require.resolve('typescript/bin/tsc'),
  'src/lib/autosave.ts', 'src/lib/unsaved-work.ts', 'src/lib/autosave-retain.ts',
  '--outDir', out, '--module', 'commonjs', '--target', 'ES2022', '--skipLibCheck',
]);
const { AutosaveRefused } = require(path.join(out, 'autosave.js'));
const { UnsavedWork } = require(path.join(out, 'unsaved-work.js'));
const { FormRetainer, MAX_RETAINED } = require(path.join(out, 'autosave-retain.js'));

const settle = () => new Promise((r) => setImmediate(r));

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

/** A synthetic create endpoint: one row per operation key, like client_key on POST /api/reading/sessions. */
function endpoint() {
  const rows = new Map();
  const calls = [];
  let mode = 'up'; // 'up' | 'offline' | 'refuse'
  return {
    rows, calls,
    set mode(m) { mode = m; },
    async create(value, key) {
      calls.push({ value, key });
      if (mode === 'offline') throw new TypeError('Failed to fetch');
      if (mode === 'refuse') throw new AutosaveRefused('Synthetic refusal');
      if (!rows.has(key)) rows.set(key, value);
      return rows.get(key);
    },
  };
}

const ready = (v) => (v.through ? null : 'Enter the chapter you read through to save.');
const data = () => ({ key: 'synthetic-key-1', row: null });

/** One "component": create-or-take-over, attach, and the listener it would hand to setState. */
function mount(retainer, name, opts, init = data) {
  const states = [];
  const form = retainer.find(name) ?? retainer.create(name, init(), opts);
  const listener = (s) => states.push(s.status);
  retainer.attach(form, listener);
  return { form, states, unmount: () => retainer.detach(form, listener) };
}

function setup({ max } = {}) {
  const timers = fakeTimers();
  const work = new UnsavedWork();
  const retainer = new FormRetainer({ work, timers, max });
  const api = endpoint();
  let current = null; // the form whose data the save reads (stands in for the component's `kept`)
  const opts = {
    delayMs: 800,
    ready,
    save: async (v) => {
      const d = current.data;
      d.row = await api.create(v, d.key);
    },
  };
  const show = (name = 'log-reading') => {
    const m = mount(retainer, name, opts);
    current = m.form;
    return m;
  };
  return { timers, work, retainer, api, show };
}

test('an incomplete entry survives its component: kept, counted as unsaved, taken over with its data; nothing is sent', async () => {
  const { work, retainer, api, show } = setup();
  const a = show();
  a.form.data.minutes = '25'; // the component writes its fields into data
  a.form.saver.change({ minutes: '25' });
  assert.equal(a.form.saver.state.status, 'incomplete');
  await a.unmount();
  assert.equal(api.calls.length, 0, 'an incomplete entry is never sent');
  assert.equal(retainer.size, 1, 'kept');
  assert.equal(work.has(), true, 'still unsaved work: the updater never reloads over it');

  const b = show();
  assert.equal(b.form, a.form, 'the next copy takes the same form over');
  assert.equal(b.form.data.minutes, '25', 'with its fields');
  assert.equal(b.form.saver.state.status, 'incomplete');
  assert.equal(work.has(), false, 'the kept key is cleared while a component shows it (it registers its own)');
  assert.equal(api.calls.length, 0, 'taking over sends nothing');

  b.form.saver.change({ minutes: '25', through: '3' });
  await b.form.saver.flush();
  assert.equal(api.calls.length, 1);
  assert.equal(b.form.saver.state.status, 'saved');
});

test('offline: a failed create keeps its operation key across unmount and remount; Retry creates the row once', async () => {
  const { timers, work, retainer, api, show } = setup();
  api.mode = 'offline';
  const a = show();
  a.form.saver.change({ through: '3' });
  await timers.advance(800);
  assert.equal(a.form.saver.state.status, 'error');
  assert.equal(a.form.saver.state.retrying, true);
  await a.unmount(); // the unmount sends once more (still offline)
  assert.equal(retainer.size, 1);
  assert.equal(work.has(), true, 'a failed entry with nobody showing it is still unsaved work');

  const b = show();
  assert.equal(b.form, a.form);
  assert.equal(b.form.saver.state.status, 'error', 'the new copy shows the failure, with Retry');
  api.mode = 'up';
  assert.equal(await b.form.saver.retry(), true);
  assert.equal(b.form.saver.state.status, 'saved');
  const keys = new Set(api.calls.map((c) => c.key));
  assert.deepEqual([...keys], ['synthetic-key-1'], 'every attempt carried the same operation key');
  assert.equal(api.rows.size, 1, 'one row, never two');
  await b.unmount();
  assert.equal(retainer.size, 0, 'saved: nothing left to keep');
  assert.equal(work.has(), false);
});

test('a kept entry keeps retrying while nobody shows it; the retry that gets through releases it', async () => {
  const { timers, work, retainer, api, show } = setup();
  api.mode = 'offline';
  const a = show();
  a.form.saver.change({ through: '4' });
  await timers.advance(800);
  await a.unmount();
  const before = api.calls.length;
  assert.ok(timers.count() > 0, 'its retry timer is still set (not disposed at unmount)');
  api.mode = 'up';
  await timers.advance(60_000);
  assert.equal(api.calls.length, before + 1, 'one more send, by the retry timer');
  assert.equal(api.rows.size, 1);
  assert.equal(retainer.size, 0, 'clean now: released');
  assert.equal(work.has(), false);
  assert.equal(timers.count(), 0, 'and stopped');

  const b = show();
  assert.notEqual(b.form, a.form, 'the next copy starts a new form');
  assert.equal(b.form.saver.state.status, 'idle');
});

test('a refused entry is kept without retrying, and Retry from the next copy sends it once', async () => {
  const { timers, retainer, api, show } = setup();
  api.mode = 'refuse';
  const a = show();
  a.form.saver.change({ through: '2' });
  await timers.advance(800);
  assert.equal(a.form.saver.state.status, 'error');
  assert.equal(a.form.saver.state.retrying, false);
  await a.unmount();
  const calls = api.calls.length;
  await timers.advance(120_000);
  assert.equal(api.calls.length, calls, 'a refusal waits for Riley, also while nobody shows it');
  assert.equal(retainer.size, 1);
  api.mode = 'up';
  const b = show();
  await b.form.saver.retry();
  assert.equal(api.calls.length, calls + 1);
  assert.equal(b.form.saver.state.status, 'saved');
});

test('a clean form is forgotten at unmount, and a waiting one is sent once then forgotten', async () => {
  const { work, retainer, api, show } = setup();
  const a = show();
  await a.unmount();
  assert.equal(retainer.size, 0);
  const b = show();
  assert.notEqual(b.form, a.form);
  b.form.saver.change({ through: '5' }); // waiting for its 800 ms
  await b.unmount();
  assert.equal(api.calls.length, 1, 'what was waiting is sent at unmount (keepalive)');
  assert.equal(retainer.size, 0);
  assert.equal(work.has(), false);
});

test('development double mount: detach then attach before the send settles keeps the same form', async () => {
  const { retainer, show } = setup();
  const a = show();
  a.form.saver.change({ minutes: '10' }); // incomplete
  const listener = () => {};
  const pending = a.unmount();
  retainer.attach(a.form, listener); // React mounts it again at once
  await pending;
  assert.equal(retainer.size, 1);
  assert.equal(retainer.find('log-reading'), a.form);
  assert.equal(a.form.mounts, 1);
});

test('bounded: at most MAX_RETAINED names, one form per name; a second copy shown at the same time is not kept', async () => {
  const { retainer, show } = setup({ max: 2 });
  assert.ok(MAX_RETAINED >= 2 && MAX_RETAINED <= 16, 'a small fixed bound');
  const one = show('one');
  const two = show('two');
  const three = show('three');
  assert.equal(retainer.size, 2, 'the third name is not kept');
  for (const m of [one, two, three]) m.form.saver.change({ minutes: '1' });
  await three.unmount();
  assert.equal(retainer.find('three'), null, 'beyond the bound: not kept past its component');
  await one.unmount();
  assert.equal(retainer.find('one'), one.form, 'within the bound: kept');

  // Two copies of one form at once (not how the app draws it): the first copy owns the name.
  const r2 = setup();
  const first = r2.show('dup');
  const second = r2.retainer.create('dup', data(), { ready, save: async () => {} });
  r2.retainer.attach(second, () => {});
  second.saver.change({ minutes: '3' });
  await r2.retainer.detach(second, () => {});
  assert.equal(r2.retainer.find('dup'), first.form);
});

test('listeners: every copy hears state changes; a detached listener does not', async () => {
  const { timers, show } = setup();
  const a = show();
  a.form.saver.change({ through: '6' });
  await timers.advance(800);
  assert.deepEqual(a.states, ['waiting', 'saving', 'saved']);
  await a.unmount();
  a.form.saver.change({ through: '7' });
  assert.deepEqual(a.states, ['waiting', 'saving', 'saved'], 'nothing after detach');
});

test('clear() forgets every kept form and its unsaved-work key', async () => {
  const { work, retainer, show } = setup();
  const a = show();
  a.form.saver.change({ minutes: '1' });
  await a.unmount();
  assert.equal(work.has(), true);
  retainer.clear();
  assert.equal(retainer.size, 0);
  assert.equal(work.has(), false);
});

test('session end: the wipe event of lib/client-cache.ts drops every kept form of the app retainer and stops its retries', async () => {
  // A fresh copy of the module with a window-like global, so its app retainer registers its listener.
  const file = path.join(out, 'autosave-retain.js');
  const listeners = new Map();
  const prior = Object.getOwnPropertyDescriptor(globalThis, 'addEventListener');
  globalThis.addEventListener = (type, fn) => listeners.set(type, fn);
  delete require.cache[require.resolve(file)];
  let fresh;
  try {
    fresh = require(file);
  } finally {
    if (prior) Object.defineProperty(globalThis, 'addEventListener', prior);
    else delete globalThis.addEventListener;
    delete require.cache[require.resolve(file)];
  }
  const cacheSource = readFileSync(path.join(__dirname, '..', 'src', 'lib', 'client-cache.ts'), 'utf8');
  const name = /export const CLIENT_WIPE_EVENT = "([^"]+)"/.exec(cacheSource)?.[1];
  assert.ok(name, 'lib/client-cache.ts names the event');
  assert.equal(fresh.CLIENT_WIPE_EVENT, name, 'the retainer listens for the same name');
  assert.match(cacheSource, /dispatchEvent\(new Event\(CLIENT_WIPE_EVENT\)\)/, 'wipeClientData fires it');
  const onWipe = listeners.get(name);
  assert.equal(typeof onWipe, 'function', 'the app retainer listens');

  const timers = fakeTimers();
  const api = endpoint();
  api.mode = 'offline';
  const retainer = fresh.formRetainer;
  const opts = { delayMs: 800, ready, timers, save: async (v) => { await api.create(v, 'synthetic-key-9'); } };
  const failed = mount(retainer, 'synthetic-failed', opts);
  failed.form.saver.change({ through: '4' });
  await timers.advance(800);
  await failed.unmount();
  const incomplete = mount(retainer, 'synthetic-incomplete', opts);
  incomplete.form.saver.change({ minutes: '9' });
  await incomplete.unmount();
  assert.equal(retainer.size, 2, 'both kept before the session ends');
  assert.ok(timers.count() > 0, 'a retry is waiting');

  onWipe();
  assert.equal(retainer.size, 0, 'nothing kept after the session ended');
  assert.equal(timers.count(), 0, 'its retry timer is stopped');
  const sent = api.calls.length;
  api.mode = 'up';
  await timers.advance(120_000);
  assert.equal(api.calls.length, sent, 'nothing is sent after the session ended');
  assert.equal(api.rows.size, 0);
  assert.equal(retainer.find('synthetic-incomplete'), null, 'the next mount starts empty');
});

test('a session end while an unmount is still sending: nothing is registered after it settles, no retry, a replacement is left alone', async () => {
  const timers = fakeTimers();
  const work = new UnsavedWork();
  const retainer = new FormRetainer({ work, timers });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const seen = [];
  const opts = {
    delayMs: 800,
    ready,
    save: async (_v, ctx) => {
      seen.push(ctx.cancelled());
      await held; // the request is out
      seen.push(ctx.cancelled());
      throw new TypeError('Failed to fetch'); // a failure worth retrying, had the session not ended
    },
  };
  const a = mount(retainer, 'log-reading', opts);
  a.form.saver.change({ through: '3' }); // waiting for its pause
  const pending = a.unmount(); // sends what is waiting; held in flight
  await settle();
  assert.equal(a.form.saver.state.status, 'saving');
  assert.equal(work.has(), true, 'registered before the send');

  retainer.clear(); // the session ends while that request is out
  assert.equal(retainer.size, 0);
  assert.equal(work.has(), false);
  const b = mount(retainer, 'log-reading', { ready, save: async () => {} }); // the next session's copy, same name
  assert.notEqual(b.form, a.form, 'a new form');
  b.form.saver.change({ minutes: '5' }); // incomplete

  release();
  await pending;
  await settle();
  assert.deepEqual(seen, [false, true], 'the save saw the session end after its await');
  assert.equal(retainer.size, 1, 'only the replacement is kept');
  assert.equal(retainer.find('log-reading'), b.form);
  assert.equal(work.has(), false, 'no retained: key left behind by the wiped form (the replacement is shown)');
  assert.equal(timers.count(), 0, 'no retry timer');
  assert.equal(b.form.saver.state.status, 'incomplete', 'the replacement is untouched');

  await b.unmount();
  assert.equal(retainer.find('log-reading'), b.form, 'and is kept as usual when it unmounts');
  assert.equal(work.has(), true);
  retainer.clear();
  assert.equal(work.has(), false);
});

test('a session end also stops a copy on screen that was never kept (beyond the bound), and a let-go form is never kept again', async () => {
  const { timers, retainer, show } = setup({ max: 1 });
  const one = show('one');
  const two = show('two');
  assert.equal(retainer.size, 1, 'the second name is beyond the bound');
  two.form.saver.change({ through: '2' }); // waiting: its pause timer is set
  assert.ok(timers.count() > 0);
  retainer.clear();
  assert.equal(timers.count(), 0, 'its timer stopped too');
  assert.equal(one.form.released, true);
  assert.equal(two.form.released, true);
  // React's development double mount of the copy that was on screen: the old form is not taken back in.
  await one.unmount();
  retainer.attach(one.form, () => {});
  assert.equal(retainer.size, 0);
  assert.equal(retainer.find('one'), null);
});

test('a background retry that gets through after a copy rendered (found the form) and before it attached: the form is taken back live', async () => {
  const { timers, work, retainer, api, show } = setup();
  api.mode = 'offline';
  const a = show();
  a.form.saver.change({ through: '4' });
  await timers.advance(800);
  await a.unmount();
  assert.equal(retainer.size, 1, 'kept, retrying');

  // The next copy renders: it finds the kept form; its effect (attach) has not run yet.
  const found = retainer.find('log-reading');
  assert.equal(found, a.form);
  api.mode = 'up';
  await timers.advance(60_000); // the kept saver's retry gets through in between
  assert.equal(api.rows.size, 1);
  assert.equal(found.released, true, 'clean with nobody attached: let go, its saver disposed');
  assert.equal(retainer.size, 0);

  // The effect attaches the form the render holds: it is live again, not a dead saver.
  const states = [];
  retainer.attach(found, (s) => states.push(s.status));
  assert.equal(found.released, false, 'taken back');
  assert.equal(retainer.find('log-reading'), found, 'kept under its name again while shown');
  assert.equal(work.has(), false, 'nothing unsaved');
  assert.equal(found.data.row.through, '4', 'with its data (the row it made)');
  const sent = api.calls.length;
  found.saver.change({ through: '4' });
  await timers.advance(800);
  assert.equal(api.calls.length, sent, 'its last saved value is its baseline: nothing to send');
  found.saver.change({ through: '5' });
  await timers.advance(800);
  assert.equal(api.calls.length, sent + 1, 'a later edit is sent, not dropped');
  assert.deepEqual(states.slice(-3), ['waiting', 'saving', 'saved']);
  await retainer.detach(found, () => {});
  assert.equal(retainer.size, 0, 'clean at unmount: forgotten as usual');
});

test('an edit before the attach takes a form let go as clean back too; a form let go by a session end is never taken back', async () => {
  const { timers, retainer, api, show } = setup();
  api.mode = 'offline';
  const a = show();
  a.form.saver.change({ through: '2' });
  await timers.advance(800);
  await a.unmount();
  const found = retainer.find('log-reading');
  api.mode = 'up';
  await timers.advance(60_000);
  assert.equal(found.released, true);
  // Riley types before the effect attached (what useRetainedAutosave's change() does first).
  assert.equal(retainer.revive(found), true);
  const sent = api.calls.length;
  found.saver.change({ through: '3' });
  await timers.advance(800);
  assert.equal(api.calls.length, sent + 1, 'the edit is sent');
  retainer.attach(found, () => {});
  assert.equal(retainer.find('log-reading'), found);

  // Session end: the copy on screen keeps its fields but sends nothing more, also after a later attach.
  retainer.clear();
  assert.equal(found.wiped, true);
  assert.equal(retainer.revive(found), false, 'a session end is final');
  retainer.attach(found, () => {});
  assert.equal(retainer.size, 0, 'not kept again');
  const after = api.calls.length;
  found.saver.change({ through: '6' });
  await timers.advance(60_000);
  assert.equal(api.calls.length, after, 'nothing is sent after the session ended');
});

test('a form let go as clean and then a session end, both before the attach: never taken back (its data is the ended session\'s)', async () => {
  const { timers, work, retainer, api, show } = setup();
  api.mode = 'offline';
  const a = show();
  a.form.saver.change({ through: '7' });
  await timers.advance(800);
  await a.unmount();
  const found = retainer.find('log-reading'); // the next copy rendered with it
  api.mode = 'up';
  await timers.advance(60_000); // let go as clean
  assert.equal(found.released, true);
  assert.equal(found.wiped, false, 'not kept or shown at the session end below, so clear() never saw it');
  retainer.clear(); // the session ends before that copy's effect ran
  assert.equal(retainer.revive(found), false);
  retainer.attach(found, () => {});
  assert.equal(retainer.size, 0, 'not kept');
  assert.equal(work.has(), false);
  const sent = api.calls.length;
  found.saver.change({ through: '8' });
  await timers.advance(60_000);
  assert.equal(api.calls.length, sent, 'nothing typed into it is sent');
});
