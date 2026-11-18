// Run: node --test tests/supplement-stack-save.test.cjs (offline). Atomic, versioned supplement stack saves
// (audit PROD-07, 2026-11-16): POST / PATCH /api/supplements/stacks check the whole body, then make ONE call to
// pds.save_supplement_stack (sql/supplement_stack_atomic_save.sql). The database function is replaced by an in-memory
// model of its contract (one transaction: a failure restores everything; version check; client_key adoption; replay
// of a save id; refusal of a body that knows no version); the real function is checked on a Supabase branch by
// sql/checks/verify_supplement_stack_atomic_save_branch.sql and race_supplement_stack_create_branch.sql, and on
// production only by the read-only sql/checks/verify_supplement_stack_atomic_save.sql. Every name and id below is
// invented.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

// ---------------------------------------------------------------------------------------------
// In-memory stand-in for pds.save_supplement_stack (and a read-only table builder for GET)
// ---------------------------------------------------------------------------------------------
const NOW = "2001-01-01T12:00:00.000Z";
const failWith = (code) => Object.assign(new Error(code), { code });

function makeDb() {
  const db = {
    stacks: [],
    items: [],
    products: new Set(["prod-a", "prod-b", "prod-c"]),
    seq: 0,
    rpcCalls: [],
    writes: [],
    selects: [],
    /** Simulates a failure after the old items were already cleared (an insert error inside the transaction). */
    failAfterItemClear: false,
    /** The next call answers this error (as PostgREST would), with a message that must never reach the answer. */
    nextError: null,
    /**
     * The next call COMMITS, then its answer is lost: "throw" (the call rejects), "empty" (no row and no error) or
     * "nocode" (an error with an empty code, as supabase-js reports a dropped connection).
     */
    loseAnswer: null,
    /** GET: answer for each select (by whether it asks for `version`). */
    selectAnswer: () => ({ data: [], error: null }),
  };

  function save(a) {
    const h = a.p_header || {};
    const ids = (a.p_items || []).map((i) => i.product_id);
    if (ids.some((id) => !db.products.has(id))) throw failWith("OXS02");
    let row = null;
    let created = false;
    let existing = false;
    let replayed = false;
    if (a.p_stack_id != null) {
      row = db.stacks.find((s) => s.stack_id === a.p_stack_id) || null;
      if (!row) throw failWith("OXS03");
    } else if (a.p_client_key) {
      row = db.stacks.find((s) => s.client_key === a.p_client_key) || null;
      if (row) existing = true;
    }
    if (!row) {
      if (db.stacks.some((s) => s.is_active && s.name.toLowerCase() === h.name.toLowerCase())) throw failWith("OXS04");
      row = {
        stack_id: ++db.seq, name: h.name, description: h.description ?? null, remind_time: h.remind_time ?? null,
        is_active: true, sort_order: 0, created_at: NOW, updated_at: NOW, client_key: a.p_client_key ?? null,
        version: 1, last_save_id: a.p_save_id ?? null,
      };
      db.stacks.push(row);
      created = true;
    }
    if (!created) {
      if (a.p_save_id && row.last_save_id === a.p_save_id) {
        replayed = true;
      } else {
        const after = a.p_after_save_ids || [];
        const own = row.last_save_id != null && after.includes(row.last_save_id);
        // An out-of-date page (no version on an update, no save id on an adoption) is refused: OXS05 "reload".
        if (existing ? a.p_save_id == null : a.p_expected_version == null) throw failWith("OXS05");
        const ok = existing ? own : row.version === a.p_expected_version || own;
        if (!ok) throw failWith("OXS01");
        const name = "name" in h ? h.name : row.name;
        const active = "is_active" in h ? h.is_active : row.is_active;
        if (active && db.stacks.some((s) => s.is_active && s.stack_id !== row.stack_id && s.name.toLowerCase() === name.toLowerCase())) {
          throw failWith("OXS04");
        }
        row.name = name;
        row.is_active = active;
        if ("description" in h) row.description = h.description;
        if ("remind_time" in h) row.remind_time = h.remind_time;
        row.updated_at = NOW;
        row.version += 1; // the version trigger
        row.last_save_id = a.p_save_id ?? null;
      }
    }
    if (!replayed && (created || a.p_items != null)) {
      db.items = db.items.filter((i) => i.stack_id !== row.stack_id || ids.includes(i.product_id));
      if (db.failAfterItemClear) throw failWith("23503");
      (a.p_items || []).forEach((it, idx) => {
        const cur = db.items.find((i) => i.stack_id === row.stack_id && i.product_id === it.product_id);
        if (cur) Object.assign(cur, { doses: it.doses, sort_order: idx });
        else db.items.push({ stack_id: row.stack_id, product_id: it.product_id, doses: it.doses, sort_order: idx });
      });
    }
    const { client_key, last_save_id, ...cols } = row;
    void client_key;
    void last_save_id;
    return { ...cols, item_count: db.items.filter((i) => i.stack_id === row.stack_id).length, created, existing, replayed };
  }

  const client = {
    rpc: async (fn, args) => {
      db.rpcCalls.push({ fn, args: JSON.parse(JSON.stringify(args)) });
      if (db.nextError) {
        const code = db.nextError;
        db.nextError = null;
        return { data: null, error: { code, message: 'duplicate key value violates unique constraint "supplement_stack_client_key_uniq" (client_key) private detail' } };
      }
      if (fn !== "save_supplement_stack") return { data: null, error: { code: "PGRST202" } };
      const snapshot = JSON.stringify({ stacks: db.stacks, items: db.items, seq: db.seq });
      try {
        const data = save(args);
        const lose = db.loseAnswer;
        db.loseAnswer = null;
        if (lose === "throw") throw Object.assign(new Error("socket hang up"), { committed: true });
        if (lose === "empty") return { data: null, error: null };
        if (lose === "nocode") return { data: null, error: { code: "", message: "TypeError: fetch failed private detail" } };
        return { data, error: null };
      } catch (e) {
        if (e.committed) throw e; // the transaction committed; only the answer is gone
        const s = JSON.parse(snapshot); // one transaction: everything goes back
        db.stacks = s.stacks;
        db.items = s.items;
        db.seq = s.seq;
        return { data: null, error: { code: e.code, message: "private detail that must not be echoed" } };
      }
    },
    from: (table) => {
      const q = {
        cols: null,
        select(c) { q.cols = c; db.selects.push(c); return q; },
        eq() { return q; },
        order() { return q; },
        then(res, rej) { return Promise.resolve(db.selectAnswer(q.cols)).then(res, rej); },
      };
      for (const w of ["insert", "update", "upsert", "delete"]) q[w] = () => { db.writes.push(`${table}.${w}`); return q; };
      return q;
    },
  };
  return { db, client };
}

let current = makeDb();
const autosave = loadTs("lib/autosave.ts");
const stubs = {
  "@supabase/supabase-js": { createClient: () => ({ rpc: (...a) => current.client.rpc(...a), from: (t) => current.client.from(t) }) },
  "next/server": { NextResponse: { json: (body, init) => ({ status: (init && init.status) || 200, body }) } },
  "@/lib/autosave": autosave,
};
const route = loadTs("app/api/supplements/stacks/route.ts", stubs);
const lib = loadTs("lib/supplement-stack-save.ts", stubs);
const chainLib = loadTs("lib/supplement-stack-chain.ts", stubs);

const reset = () => { current = makeDb(); return current.db; };
const post = (body) => route.POST({ json: async () => body });
const patch = (body) => route.PATCH({ json: async () => body });
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const idGen = (start) => { let n = start; return () => uuid(n++); };
const itemsOf = (db, stackId) => db.items.filter((i) => i.stack_id === stackId).sort((a, b) => a.sort_order - b.sort_order).map((i) => [i.product_id, i.doses]);
const BODY = { name: "Test stack", description: null, remind_time: null, items: [{ product_id: "prod-a", doses: 1 }, { product_id: "prod-b", doses: 2 }] };

/** A stored stack at version 1 with two items, created through the route. */
async function seedStack(db) {
  const r = await post({ ...BODY, client_key: uuid(900), save_id: uuid(901) });
  assert.equal(r.status, 200);
  assert.equal(r.body.version, 1);
  return r.body.stack_id;
}

// ---------------------------------------------------------------------------------------------
// Body checks: nothing is written for a malformed body
// ---------------------------------------------------------------------------------------------
test("items that are not a valid array are refused (400) and the stored items stay", async () => {
  const db = reset();
  const id = await seedStack(db);
  const calls = db.rpcCalls.length;
  for (const items of ["prod-a", null, {}, 3, [{}], [{ product_id: "" }], [{ product_id: "prod-a", doses: "two" }],
    [{ product_id: "prod-a", doses: 0 }], [{ product_id: "prod-a", doses: -1 }], [{ product_id: "prod-a", doses: 1e9 }],
    [{ product_id: "prod-a" }, { product_id: "prod-a" }], [{ product_id: "prod-a", doses: 1, extra: true }], ["prod-a"]]) {
    const r = await patch({ stack_id: id, items, expected_version: 1, save_id: uuid(1) });
    assert.equal(r.status, 400, JSON.stringify(items));
    assert.equal(r.body.code, "invalid");
  }
  assert.equal(db.rpcCalls.length, calls, "a refused body never reaches the database");
  assert.deepEqual(itemsOf(db, id), [["prod-a", 1], ["prod-b", 2]]);
  assert.equal(db.stacks[0].version, 1);
});

test("other malformed bodies are refused before any write", async () => {
  const db = reset();
  const id = await seedStack(db);
  const calls = db.rpcCalls.length;
  const bad = [
    [patch, { items: [] }], // no stack_id
    [patch, { stack_id: "1", items: [] }],
    [patch, { stack_id: id, name: "  " }],
    [patch, { stack_id: id, is_active: "yes" }],
    [patch, { stack_id: id, expected_version: 0 }],
    [patch, { stack_id: id, save_id: "not-a-uuid" }],
    [patch, { stack_id: id, after_save_ids: "x" }],
    [patch, { stack_id: id, surprise: 1 }],
    [post, { ...BODY, name: "" }],
    [post, { ...BODY, client_key: "nope" }],
    [post, { ...BODY, is_active: false }],
    [post, { ...BODY, remind_time: "25:00" }],
    [post, "not an object"],
  ];
  for (const [fn, body] of bad) assert.equal((await fn(body)).status, 400, JSON.stringify(body));
  assert.equal((await route.PATCH({ json: async () => { throw new SyntaxError("bad json"); } })).status, 400);
  assert.equal(db.rpcCalls.length, calls);
  assert.deepEqual(itemsOf(db, id), [["prod-a", 1], ["prod-b", 2]]);
});

test("an explicitly empty item list clears the stack on purpose; a body without items leaves them alone", async () => {
  const db = reset();
  const id = await seedStack(db);
  const header = await patch({ stack_id: id, name: "Renamed stack", expected_version: 1, save_id: uuid(2) });
  assert.equal(header.status, 200);
  assert.deepEqual(itemsOf(db, id), [["prod-a", 1], ["prod-b", 2]], "no items key = items unchanged");
  assert.equal(current.db.rpcCalls.at(-1).args.p_items, null);
  const cleared = await patch({ stack_id: id, items: [], expected_version: 2, save_id: uuid(3) });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.item_count, 0);
  assert.deepEqual(itemsOf(db, id), []);
  assert.equal(db.stacks[0].name, "Renamed stack");
});

// ---------------------------------------------------------------------------------------------
// One transaction: a failure leaves the header AND the items as they were
// ---------------------------------------------------------------------------------------------
test("a failure while replacing the items leaves both the previous header and the previous items", async () => {
  const db = reset();
  const id = await seedStack(db);
  current.db.failAfterItemClear = true;
  const r = await patch({ stack_id: id, name: "Should not stick", items: [{ product_id: "prod-c", doses: 3 }], expected_version: 1, save_id: uuid(4) });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "unknown_product");
  const after = current.db;
  assert.equal(after.stacks[0].name, "Test stack");
  assert.equal(after.stacks[0].version, 1);
  assert.deepEqual(itemsOf(after, id), [["prod-a", 1], ["prod-b", 2]]);
  assert.deepEqual(after.writes, [], "POST / PATCH never write a table directly (no separate clear + insert)");
});

test("an unknown product is refused and nothing changes", async () => {
  const db = reset();
  const id = await seedStack(db);
  const r = await patch({ stack_id: id, items: [{ product_id: "prod-a", doses: 1 }, { product_id: "prod-gone", doses: 1 }], expected_version: 1, save_id: uuid(5) });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "unknown_product");
  assert.deepEqual(itemsOf(current.db, id), [["prod-a", 1], ["prod-b", 2]]);
});

test("a failed create leaves no stack behind", async () => {
  reset();
  const r = await post({ ...BODY, items: [{ product_id: "prod-gone", doses: 1 }], client_key: uuid(10), save_id: uuid(11) });
  assert.equal(r.status, 400);
  assert.equal(current.db.stacks.length, 0);
  assert.equal(current.db.items.length, 0);
});

// ---------------------------------------------------------------------------------------------
// Versions: concurrent editors, lost answers, late requests
// ---------------------------------------------------------------------------------------------
test("two editors on one version: the second save is refused with 409 and its items are not mixed in", async () => {
  const db = reset();
  const id = await seedStack(db);
  const a = new chainLib.StackSaveChain(1, idGen(100));
  const b = new chainLib.StackSaveChain(1, idGen(200));
  const bodyA = { stack_id: id, name: "Test stack", items: [{ product_id: "prod-a", doses: 4 }] };
  const bodyB = { stack_id: id, name: "Test stack", items: [{ product_id: "prod-c", doses: 1 }, { product_id: "prod-b", doses: 1 }] };
  const fa = a.next(bodyA);
  const ra = await patch({ ...bodyA, ...fa });
  assert.equal(ra.status, 200);
  a.accepted(ra.body.version);
  assert.equal(a.knownVersion, 2);
  const fb = b.next(bodyB);
  const rb = await patch({ ...bodyB, ...fb });
  assert.equal(rb.status, 409);
  assert.equal(rb.body.code, "stale");
  assert.deepEqual(itemsOf(current.db, id), [["prod-a", 4]], "only editor A's complete list is stored");
  assert.equal(current.db.stacks[0].version, 2);
});

test("a save whose answer was lost is resent with the same id and answered as a replay (no second write)", async () => {
  const db = reset();
  const id = await seedStack(db);
  const chain = new chainLib.StackSaveChain(1, idGen(300));
  const body = { stack_id: id, name: "Test stack", items: [{ product_id: "prod-b", doses: 1 }] };
  const f1 = chain.next(body);
  const lost = await patch({ ...body, ...f1 }); // committed, but the editor never sees this answer
  assert.equal(lost.status, 200);
  const f2 = chain.next(body);
  assert.equal(f2.save_id, f1.save_id, "same body, same save id");
  const again = await patch({ ...body, ...f2 });
  assert.equal(again.status, 200);
  assert.equal(again.body.replayed, true);
  assert.equal(again.body.version, 2, "the version went up once");
  assert.equal(again.body.stack_id, id);
  chain.accepted(again.body.version);
  assert.deepEqual(chain.unanswered, []);
});

// A save that committed but whose answer never arrived must not be reported as "Nothing was changed" (Codex R2,
// PR 365): the route says the outcome is not confirmed, the editor keeps the save id, and the resend is a replay.
test("commit, then the answer is lost: the route says the save may have gone through, and the resend is a replay", async () => {
  for (const lose of ["throw", "empty", "nocode"]) {
    const db = reset();
    const id = await seedStack(db);
    const chain = new chainLib.StackSaveChain(1, idGen(320));
    const body = { stack_id: id, name: "Test stack", items: [{ product_id: "prod-c", doses: 3 }] };
    const f1 = chain.next(body);
    current.db.loseAnswer = lose;
    const lost = await patch({ ...body, ...f1 });
    assert.ok(lost.status >= 500, `${lose}: a 5xx, retried by the editor`);
    assert.equal(lost.body.code, "unconfirmed", lose);
    assert.doesNotMatch(lost.body.error, /Nothing was changed/i, `${lose}: never claims nothing changed`);
    assert.match(lost.body.error, /may or may not have been saved/);
    assert.doesNotMatch(JSON.stringify(lost.body), /private detail|socket hang up|fetch failed/, "no database or transport text");
    assert.deepEqual(itemsOf(current.db, id), [["prod-c", 3]], `${lose}: the save did commit`);
    // The editor's fetch turns this answer into an unconfirmed outcome: retried, not a refusal, id kept.
    await assert.rejects(
      chainLib.stackSaveRequest("PATCH", {}, false, async () => ({ ok: false, status: lost.status, json: async () => lost.body })),
      (e) => {
        assert.equal(e.name, "StackSaveUnconfirmed");
        assert.ok(!(e instanceof autosave.AutosaveRefused), "retried with backoff and Retry, not shown as a refusal");
        assert.doesNotMatch(e.message, /Nothing was changed/i);
        return true;
      },
    );
    assert.deepEqual(chain.unanswered, [f1.save_id], "the save id stays unanswered");
    const f2 = chain.next(body);
    assert.equal(f2.save_id, f1.save_id, "Retry sends the same save id");
    const again = await patch({ ...body, ...f2 });
    assert.equal(again.status, 200, lose);
    assert.equal(again.body.replayed, true, `${lose}: answered as a replay`);
    assert.equal(again.body.version, 2, `${lose}: written once`);
    assert.deepEqual(itemsOf(current.db, id), [["prod-c", 3]]);
  }
});

test("a create that committed but lost its answer is resent with the same key and id: one stack, replayed", async () => {
  const db = reset();
  const chain = new chainLib.StackSaveChain(null, idGen(340));
  const key = uuid(339);
  const f1 = chain.next(BODY);
  db.loseAnswer = "throw";
  const lost = await post({ ...BODY, client_key: key, ...f1 });
  assert.equal(lost.status, 502);
  assert.equal(lost.body.code, "unconfirmed");
  assert.doesNotMatch(lost.body.error, /Nothing was changed/i);
  assert.equal(current.db.stacks.length, 1, "the create did commit");
  const f2 = chain.next(BODY);
  assert.equal(f2.save_id, f1.save_id);
  const again = await post({ ...BODY, client_key: key, ...f2 });
  assert.equal(again.status, 200);
  assert.equal(again.body.replayed, true);
  assert.equal(again.body.stack_id, current.db.stacks[0].stack_id);
  assert.equal(current.db.stacks.length, 1, "no second stack");
});

// Codex review round 2 (PR 365): a save commits but its answer is lost, then the form is put back the way it loaded.
// The real Autosaver, wired as the editor wires it, must SEND that change back (not treat the form as clean and cancel
// the retry), so the unwanted change does not stay stored.
test("real Autosaver: a committed save whose answer was lost, then a change back to the loaded values, stores the loaded values", async () => {
  const db = reset();
  const id = await seedStack(db);
  const loaded = { name: "Test stack", description: null, remind_time: null, items: BODY.items };
  const unwanted = { ...loaded, items: [{ product_id: "prod-c", doses: 3 }] };
  const chain = new chainLib.StackSaveChain(1, idGen(700));
  const sent = [];
  const viaRoute = async (_url, init) => {
    const b = JSON.parse(init.body);
    sent.push(b);
    const r = init.method === "POST" ? await post(b) : await patch(b);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body };
  };
  const timers = { set: () => ({}), clear: () => {} }; // retries are driven by hand below
  const saver = new autosave.Autosaver(
    {
      timers,
      unknownOutcome: chainLib.stackSaveUnknownOutcome, // what components/StackEditorModal.tsx passes
      // The editor's save: chain fields, one request, a refusal forgets its id, a success is the version held now.
      save: async (f, { keepalive }) => {
        const fields = chain.next(f);
        let json;
        try {
          json = await chainLib.stackSaveRequest("PATCH", { stack_id: id, ...f, ...fields }, keepalive, viaRoute);
        } catch (e) {
          if (e instanceof autosave.AutosaveRefused) chain.refused(fields);
          throw e;
        }
        chain.accepted(json.version);
      },
    },
    loaded,
  );

  current.db.loseAnswer = "throw";
  saver.change(unwanted, { delayMs: null });
  assert.equal(await saver.flush(), false, "no clear answer: still unsaved");
  assert.equal(saver.state.status, "error");
  assert.equal(saver.state.retrying, true);
  assert.doesNotMatch(saver.state.error, /Nothing was changed/i);
  assert.deepEqual(itemsOf(current.db, id), [["prod-c", 3]], "the unwanted change did commit");

  saver.change(loaded, { delayMs: null }); // the form is put back the way it loaded
  assert.equal(saver.dirty, true, "not treated as clean: the stack may hold the lost save");
  assert.equal(await saver.flush(), true);
  assert.equal(saver.state.status, "saved");
  assert.equal(sent.length, 2, "the change back was sent");
  assert.notEqual(sent[1].save_id, sent[0].save_id);
  assert.deepEqual(sent[1].after_save_ids, [sent[0].save_id], "sent after the unanswered save, so it is accepted");
  assert.deepEqual(itemsOf(current.db, id), [["prod-a", 1], ["prod-b", 2]], "the loaded values are stored again");
  assert.equal(current.db.stacks[0].version, 3);
  assert.deepEqual(chain.unanswered, []);

  // Once a save has answered, the stored value is known again: the same value sends nothing.
  saver.change(loaded, { delayMs: null });
  assert.equal(await saver.flush(), true);
  assert.equal(sent.length, 2);
});

test("after a lost answer, the next (changed) save is accepted: the stack's last write was this editor's own", async () => {
  const db = reset();
  const id = await seedStack(db);
  const chain = new chainLib.StackSaveChain(1, idGen(400));
  const b1 = { stack_id: id, name: "Test stack", items: [{ product_id: "prod-b", doses: 1 }] };
  const b2 = { stack_id: id, name: "Test stack", items: [{ product_id: "prod-b", doses: 2 }] };
  await patch({ ...b1, ...chain.next(b1) }); // lost answer
  const f2 = chain.next(b2);
  assert.equal(f2.expected_version, 1);
  assert.equal(f2.after_save_ids.length, 1);
  const r = await patch({ ...b2, ...f2 });
  assert.equal(r.status, 200);
  assert.equal(r.body.version, 3);
  assert.deepEqual(itemsOf(current.db, id), [["prod-b", 2]]);
});

test("a late copy of an older save cannot overwrite a newer one", async () => {
  const db = reset();
  const id = await seedStack(db);
  const chain = new chainLib.StackSaveChain(1, idGen(500));
  const old = { stack_id: id, name: "Test stack", items: [{ product_id: "prod-c", doses: 9 }] };
  const newer = { stack_id: id, name: "Test stack", items: [{ product_id: "prod-a", doses: 1 }] };
  const fOld = chain.next(old); // its request is slow; the editor saw it fail
  const fNew = chain.next(newer);
  const rNew = await patch({ ...newer, ...fNew }); // arrives first: the stack is still at version 1
  assert.equal(rNew.status, 200);
  const rOld = await patch({ ...old, ...fOld }); // arrives later
  assert.equal(rOld.status, 409);
  assert.deepEqual(itemsOf(current.db, id), [["prod-a", 1]]);
});

test("an archive (or any other update) means a different writer: the open editor is asked to reload", async () => {
  const db = reset();
  const id = await seedStack(db);
  // The archive route's update raises the version through the trigger; the model does the same.
  current.db.stacks[0].is_active = false;
  current.db.stacks[0].version += 1;
  current.db.stacks[0].last_save_id = null;
  const chain = new chainLib.StackSaveChain(1, idGen(600));
  const body = { stack_id: id, name: "Test stack", items: [] };
  const r = await patch({ ...body, ...chain.next(body) });
  assert.equal(r.status, 409);
  assert.equal(current.db.stacks[0].is_active, false);
  assert.deepEqual(itemsOf(current.db, id), [["prod-a", 1], ["prod-b", 2]]);
});

test("a body that knows no version (previous build, delayed legacy retry) is refused with 409 reload; nothing changes", async () => {
  const db = reset();
  const id = await seedStack(db);
  // A newer save from the current editor first.
  const newer = await patch({ stack_id: id, name: "Test stack", items: [{ product_id: "prod-a", doses: 3 }], expected_version: 1, save_id: uuid(850) });
  assert.equal(newer.status, 200);
  // Previous build: no version and no save id. The database refuses it (OXS05).
  const old = await patch({ stack_id: id, name: "Test stack", items: [{ product_id: "prod-c", doses: 1 }] });
  assert.equal(old.status, 409);
  assert.equal(old.body.code, "reload");
  assert.equal(current.db.rpcCalls.at(-1).args.p_expected_version, null);
  // List read before the migration, with a save id: refused by the route before any database call.
  const calls = current.db.rpcCalls.length;
  const listed = await patch({ stack_id: id, name: "Test stack", items: [{ product_id: "prod-c", doses: 1 }], save_id: uuid(851) });
  assert.equal(listed.status, 409);
  assert.equal(listed.body.code, "reload");
  assert.equal(current.db.rpcCalls.length, calls, "refused before the database");
  assert.deepEqual(itemsOf(current.db, id), [["prod-a", 3]], "the newer save stays");
  assert.equal(current.db.stacks[0].version, 2);
});

test("an exact resend of a save that went through is refused without a version, and replayed with one", async () => {
  const db = reset();
  const id = await seedStack(db);
  const body = { stack_id: id, name: "Test stack", items: [{ product_id: "prod-b", doses: 1 }] };
  assert.equal((await patch({ ...body, expected_version: 1, save_id: uuid(860) })).status, 200);
  const noVersion = await patch({ ...body, save_id: uuid(860) });
  assert.equal(noVersion.status, 409);
  assert.equal(noVersion.body.code, "reload");
  assert.equal(current.db.stacks[0].version, 2, "nothing written by the refused resend");
  const again = await patch({ ...body, expected_version: 1, save_id: uuid(860) });
  assert.equal(again.status, 200);
  assert.equal(again.body.replayed, true);
  assert.equal(again.body.version, 2);
});

test("an update with save_id and no expected_version is refused before the database, whatever the stack holds", async () => {
  const db = reset();
  const id = await seedStack(db);
  const calls = db.rpcCalls.length;
  const r = await patch({ stack_id: id, name: "Test stack", items: [], save_id: uuid(861) });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "reload");
  assert.equal(r.body.error, "This stack changed in another tab. Refresh it, then save again.");
  assert.equal(db.rpcCalls.length, calls);
  assert.deepEqual(db.writes, []);
});

test("parser: an update with save_id and a positive expected_version still parses", () => {
  const r = lib.parseStackSave({ stack_id: 1, name: "Test stack", items: [], expected_version: 2, save_id: uuid(862) }, "update");
  assert.equal(r.ok, true);
  assert.equal(r.value.expectedVersion, 2);
  assert.equal(r.value.saveId, uuid(862));
});

test("parser: a create with save_id and no expected_version still parses", () => {
  const r = lib.parseStackSave({ ...BODY, client_key: uuid(863), save_id: uuid(864) }, "create");
  assert.equal(r.ok, true);
  assert.equal(r.value.expectedVersion, null);
  assert.equal(r.value.saveId, uuid(864));
});

test("parser: an update without save_id and without expected_version keeps its current behaviour (parsed, then refused by the database)", async () => {
  const r = lib.parseStackSave({ stack_id: 1, name: "Test stack", items: [] }, "update");
  assert.equal(r.ok, true);
  assert.equal(r.value.expectedVersion, null);
  assert.equal(r.value.saveId, null);
  const db = reset();
  const id = await seedStack(db);
  const calls = db.rpcCalls.length;
  const body = await patch({ stack_id: id, name: "Test stack", items: [] });
  assert.equal(body.status, 409);
  assert.equal(body.body.code, "reload");
  assert.equal(db.rpcCalls.length, calls + 1, "passed on to the database");
});

test("StackSaveChain.learnVersion takes a version only when none is held", () => {
  const c = new chainLib.StackSaveChain(null, idGen(1100));
  c.learnVersion(4);
  assert.equal(c.knownVersion, 4);
  c.learnVersion(9);
  assert.equal(c.knownVersion, 4, "a known version is not replaced");
  c.learnVersion(null);
  assert.equal(new chainLib.StackSaveChain(null, idGen(1)).knownVersion, null);
});

test("a retried create without a save id (previous build) is refused when its stack exists; a first create still works", async () => {
  reset();
  const key = uuid(870);
  const first = await post({ ...BODY, client_key: key });
  assert.equal(first.status, 200, "a brand-new stack from the previous build is created");
  assert.equal(first.body.created, true);
  const retry = await post({ ...BODY, items: [{ product_id: "prod-c", doses: 1 }], client_key: key });
  assert.equal(retry.status, 409);
  assert.equal(retry.body.code, "reload");
  assert.equal(current.db.stacks.length, 1);
  assert.deepEqual(itemsOf(current.db, first.body.stack_id), [["prod-a", 1], ["prod-b", 2]]);
});

// ---------------------------------------------------------------------------------------------
// Create: client_key keeps one stack identity; 23505 never means "insert without the key"
// ---------------------------------------------------------------------------------------------
test("a create retried after a lost answer returns the same stack, once", async () => {
  reset();
  const chain = new chainLib.StackSaveChain(null, idGen(700));
  const key = uuid(77);
  const body = { ...BODY };
  const f1 = chain.next(body);
  const first = await post({ ...body, client_key: key, ...f1 }); // lost answer
  assert.equal(first.status, 200);
  assert.equal(first.body.created, true);
  const f2 = chain.next(body);
  const again = await post({ ...body, client_key: key, ...f2 });
  assert.equal(again.status, 200);
  assert.equal(again.body.stack_id, first.body.stack_id);
  assert.equal(again.body.existing, true);
  assert.equal(again.body.replayed, true);
  assert.equal(current.db.stacks.length, 1);
  // A changed body sent before the first answer arrived updates that same stack.
  const changed = { ...body, items: [{ product_id: "prod-c", doses: 1 }] };
  const f3 = chain.next(changed);
  const r3 = await post({ ...changed, client_key: key, ...f3 });
  assert.equal(r3.status, 200);
  assert.equal(r3.body.stack_id, first.body.stack_id);
  assert.equal(current.db.stacks.length, 1);
  assert.deepEqual(itemsOf(current.db, first.body.stack_id), [["prod-c", 1]]);
});

test("another editor's write in between: a retried create with that key is refused, not overwritten", async () => {
  reset();
  const key = uuid(78);
  const created = await post({ ...BODY, client_key: key, save_id: uuid(801), after_save_ids: [] });
  const id = created.body.stack_id;
  const other = await patch({ stack_id: id, name: "Test stack", items: [{ product_id: "prod-a", doses: 5 }], expected_version: 1, save_id: uuid(802) });
  assert.equal(other.status, 200);
  const late = await post({ ...BODY, client_key: key, save_id: uuid(803), after_save_ids: [] });
  assert.equal(late.status, 409);
  assert.deepEqual(itemsOf(current.db, id), [["prod-a", 5]]);
});

test("a unique violation naming client_key is retried as the same save; no second, keyless insert is attempted", async () => {
  reset();
  current.db.nextError = "23505";
  const r = await post({ ...BODY, client_key: uuid(79), save_id: uuid(804) });
  assert.equal(r.status, 503, "retryable: the editor sends the same save again");
  assert.equal(r.body.code, "conflict");
  assert.equal(current.db.rpcCalls.length, 1, "one call, no retry without the key");
  assert.equal(current.db.rpcCalls[0].args.p_client_key, uuid(79));
  assert.deepEqual(current.db.writes, []);
  assert.equal(current.db.stacks.length, 0);
  assert.doesNotMatch(JSON.stringify(r.body), /private detail|client_key_uniq/, "the database text is never echoed");
});

test("a database without the save function answers 503 and never falls back to the old multi-step save", async () => {
  for (const code of ["PGRST202", "42883", "42703", "PGRST204"]) {
    reset();
    current.db.nextError = code;
    const r = await patch({ stack_id: 1, items: [], expected_version: 1, save_id: uuid(5) });
    assert.equal(r.status, 503, code);
    assert.equal(r.body.code, "not_set_up");
    assert.deepEqual(current.db.writes, [], `${code}: no direct table write`);
  }
});

test("error answers are mapped from the code only", () => {
  assert.deepEqual([lib.stackSaveFailure("OXS01").status, lib.stackSaveFailure("OXS01").code], [409, "stale"]);
  assert.deepEqual([lib.stackSaveFailure("OXS05").status, lib.stackSaveFailure("OXS05").code], [409, "reload"]);
  assert.equal(lib.stackSaveFailure("OXS02").status, 400);
  assert.equal(lib.stackSaveFailure("OXS03").status, 404);
  assert.equal(lib.stackSaveFailure("OXS04").status, 409);
  assert.equal(lib.stackSaveFailure("23505").status, 503);
  assert.equal(lib.stackSaveFailure("23505").code, "conflict");
  assert.equal(lib.stackSaveFailure("22023").status, 400);
  // A code this file does not know (or none) leaves the outcome open: never "Nothing was changed".
  for (const code of ["XX000", "", "57014", undefined, null]) {
    const f = lib.stackSaveFailure(code);
    assert.equal(f.status, 500, String(code));
    assert.equal(f.code, "unconfirmed", String(code));
    assert.doesNotMatch(f.error, /Nothing was changed/i, String(code));
  }
  assert.equal(lib.stackSaveUnconfirmed().status, 502);
  assert.equal(lib.stackSaveUnconfirmed().code, "unconfirmed");
  // Only known refusals (the function raised, its transaction rolled back) say nothing changed.
  for (const code of ["OXS05", "OXS02", "23503", "OXS04", "22023", "22P02", "23514", "PGRST202", "42883", "42703", "PGRST204"]) {
    assert.match(lib.stackSaveFailure(code).error, /Nothing was changed\./, code);
  }
  assert.equal(lib.STACK_UNCONFIRMED_MESSAGE, chainLib.STACK_UNCONFIRMED_TEXT, "server and editor show the same text");
});

test("the stored stack's name conflict and a missing stack are answered without writing", async () => {
  const db = reset();
  await seedStack(db);
  const dup = await post({ ...BODY, client_key: uuid(81), save_id: uuid(82) });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, "name_taken");
  const missing = await patch({ stack_id: 999, items: [], expected_version: 1, save_id: uuid(83) });
  assert.equal(missing.status, 404);
  assert.equal(current.db.stacks.length, 1);
});

// ---------------------------------------------------------------------------------------------
// The editor's chain and fetch
// ---------------------------------------------------------------------------------------------
test("StackSaveChain: same body keeps its id, a refusal is forgotten, success clears the unanswered list", () => {
  const c = new chainLib.StackSaveChain(3, idGen(1000));
  const a = c.next({ x: 1 });
  assert.deepEqual(a, { save_id: uuid(1000), expected_version: 3, after_save_ids: [] });
  assert.equal(c.next({ x: 1 }).save_id, a.save_id);
  const b = c.next({ x: 2 });
  assert.deepEqual(b.after_save_ids, [a.save_id]);
  c.refused(b);
  assert.deepEqual(c.unanswered, [a.save_id]);
  c.accepted(4);
  assert.equal(c.knownVersion, 4);
  assert.deepEqual(c.unanswered, []);
  for (let i = 0; i < 30; i++) c.next({ i });
  assert.equal(c.unanswered.length, chainLib.STACK_PENDING_MAX);
  assert.equal(new chainLib.StackSaveChain(undefined, idGen(1)).knownVersion, null);
});

test("stackSaveRequest: 409 stale is a StackConflict, other 4xx a refusal, 5xx and network errors are retried", async () => {
  const answer = (status, body) => async () => ({ ok: status < 300, status, json: async () => body });
  await assert.rejects(chainLib.stackSaveRequest("PATCH", {}, false, answer(409, { error: "changed", code: "stale" })), (e) => {
    assert.equal(e.name, "StackConflict");
    assert.ok(e instanceof autosave.AutosaveRefused, "a conflict is a refusal (not retried)");
    return true;
  });
  await assert.rejects(chainLib.stackSaveRequest("PATCH", {}, false, answer(409, { error: "reload", code: "reload" })), (e) => {
    assert.equal(e.name, "StackConflict", "an out-of-date page is offered the latest version too");
    return true;
  });
  await assert.rejects(chainLib.stackSaveRequest("PATCH", {}, false, answer(503, { error: "not set up", code: "not_set_up" })), (e) => {
    assert.ok(e instanceof autosave.AutosaveRefused, "a missing database function is shown with Retry, not retried on its own");
    assert.notEqual(e.name, "StackConflict");
    return true;
  });
  await assert.rejects(chainLib.stackSaveRequest("PATCH", {}, false, answer(409, { error: "name", code: "name_taken" })), (e) => {
    assert.ok(e instanceof autosave.AutosaveRefused);
    assert.notEqual(e.name, "StackConflict");
    return true;
  });
  await assert.rejects(chainLib.stackSaveRequest("PATCH", {}, false, answer(503, { error: "later" })), (e) => {
    assert.ok(!(e instanceof autosave.AutosaveRefused), "503 is retried");
    assert.equal(e.name, "StackSaveUnconfirmed", "a 5xx the editor cannot place leaves the outcome open");
    return true;
  });
  await assert.rejects(chainLib.stackSaveRequest("PATCH", {}, false, answer(503, { error: "two saves met", code: "conflict" })), (e) => {
    assert.ok(!(e instanceof autosave.AutosaveRefused), "a conflict wrote nothing and is retried");
    assert.equal(e.name, "Error");
    assert.equal(e.message, "two saves met");
    return true;
  });
  // No answer, a gateway page instead of JSON, or a success that is not a saved stack: the save may have gone through.
  const unconfirmedCases = [
    ["the request failed in transit", async () => { throw new TypeError("Failed to fetch"); }],
    ["a gateway timeout page", async () => ({ ok: false, status: 504, json: async () => { throw new SyntaxError("not json"); } })],
    ["a success whose body is not JSON", async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("cut off"); } })],
    ["a success that names no stack", async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })],
    ["a 429 from something between the browser and the route", async () => ({ ok: false, status: 429, json: async () => ({}) })],
    ["a 408 from something between the browser and the route", async () => ({ ok: false, status: 408, json: async () => ({}) })],
  ];
  for (const [label, impl] of unconfirmedCases) {
    await assert.rejects(chainLib.stackSaveRequest("PATCH", {}, false, impl), (e) => {
      assert.equal(e.name, "StackSaveUnconfirmed", label);
      assert.ok(!(e instanceof autosave.AutosaveRefused), `${label}: retried`);
      assert.equal(e.message, chainLib.STACK_UNCONFIRMED_TEXT, label);
      assert.doesNotMatch(e.message, /Nothing was changed/i, label);
      return true;
    });
  }
  const ok = await chainLib.stackSaveRequest("POST", { a: 1 }, true, async (url, init) => {
    assert.equal(url, "/api/supplements/stacks");
    assert.equal(init.method, "POST");
    assert.equal(init.keepalive, true);
    assert.deepEqual(JSON.parse(init.body), { a: 1 });
    return { ok: true, status: 200, json: async () => ({ stack_id: 5, version: 1 }) };
  });
  assert.deepEqual(ok, { stack_id: 5, version: 1 });
});

test("GET reads the version, and still answers on a database without the column", async () => {
  reset();
  current.db.selectAnswer = (cols) => (cols.includes("version,") ? { data: null, error: { code: "42703", message: "x" } } : { data: [], error: null });
  const r = await route.GET({ nextUrl: new URL("http://localhost/api/supplements/stacks") });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { stacks: [] });
  assert.equal(current.db.selects.length, 2);
  assert.match(current.db.selects[0], /version,/);
  assert.doesNotMatch(current.db.selects[1], /version,/);
});

// ---------------------------------------------------------------------------------------------
// Source contracts: the SQL file, the route, the editor
// ---------------------------------------------------------------------------------------------
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
const sql = fs.readFileSync(path.join(SRC, "..", "..", "sql", "supplement_stack_atomic_save.sql"), "utf8");

test("the SQL is additive, service-role only and one transaction with a row lock", () => {
  assert.doesNotMatch(sql, /drop/i, "no DROP anywhere (the Supabase connector declines it)");
  assert.doesNotMatch(sql, /TO\s+(anon|authenticated|PUBLIC)\b/i, "never granted to anon / authenticated / PUBLIC");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS version bigint NOT NULL DEFAULT 1/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS last_save_id uuid/);
  assert.match(sql, /CREATE OR REPLACE TRIGGER supplement_stack_version\s+BEFORE UPDATE ON pds\.supplement_stack/);
  assert.match(sql, /SECURITY INVOKER/);
  assert.match(sql, /REVOKE ALL ON FUNCTION pds\.save_supplement_stack\([^)]*\) FROM PUBLIC, anon, authenticated;/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION pds\.save_supplement_stack\([^)]*\) TO service_role;/);
  assert.match(sql, /WHERE stack_id = p_stack_id FOR UPDATE/);
  assert.match(sql, /ON CONFLICT \(client_key\) WHERE client_key IS NOT NULL DO NOTHING/);
  assert.doesNotMatch(sql, /DELETE FROM pds\.supplement_stack\b(?!_item)/, "a stack row is never removed (intake provenance)");
  // Every custom code the function raises has a non-500 answer in the route.
  const codes = [...new Set([...sql.matchAll(/ERRCODE = '(OXS\d\d)'/g)].map((m) => m[1]))];
  assert.deepEqual(codes.sort(), ["OXS01", "OXS02", "OXS03", "OXS04", "OXS05"]);
  for (const c of codes) assert.notEqual(lib.stackSaveFailure(c).status, 500, c);
  // A body that knows no version is refused, never saved last-writer-wins.
  assert.match(sql, /IF p_expected_version IS NULL THEN\s+RAISE EXCEPTION [^;]*ERRCODE = 'OXS05'/);
  assert.match(sql, /IF p_save_id IS NULL THEN\s+RAISE EXCEPTION [^;]*ERRCODE = 'OXS05'/);
  assert.doesNotMatch(sql, /v_ok := p_expected_version IS NULL|v_ok := p_save_id IS NULL/);
});

test("a create with a client key takes the key's advisory lock before looking the key up or checking the name", () => {
  const lock = sql.indexOf("pg_advisory_xact_lock(hashtextextended('pds.supplement_stack.client_key:' || p_client_key::text, 0))");
  assert.ok(lock > 0, "the client-key lock is there");
  const lookup = sql.indexOf("WHERE client_key = p_client_key FOR UPDATE");
  const nameCheck = sql.indexOf("lower(s.name) = lower(v_name)");
  assert.ok(lookup > lock, "the lookup comes after the lock (a waiting retry then sees the committed row)");
  assert.ok(nameCheck > lock, "the name check comes after the lock (no false 'name in use' for its own stack)");
});

test("the production check is read-only; the behaviour checks refuse a database with real stacks", () => {
  const checks = path.join(SRC, "..", "..", "sql", "checks");
  const prod = fs.readFileSync(path.join(checks, "verify_supplement_stack_atomic_save.sql"), "utf8");
  assert.match(prod, /^BEGIN TRANSACTION READ ONLY;/m);
  const code = prod.replace(/--.*$/gm, "");
  assert.doesNotMatch(code, /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|SET\s+(LOCAL\s+)?ROLE)\b/i, "no write, DDL or role switch");
  assert.doesNotMatch(code, /\bs\.name\b|SELECT\s+name\b|description/i, "counts only, never a stack name or description");
  for (const f of ["verify_supplement_stack_atomic_save_branch.sql", "race_supplement_stack_create_branch.sql"]) {
    const b = fs.readFileSync(path.join(checks, f), "utf8");
    assert.match(b, /NEVER RUN THIS ON PRODUCTION/, f);
    assert.match(b, /IF EXISTS \(SELECT 1 FROM pds\.supplement_stack\) OR EXISTS \(SELECT 1 FROM pds\.supplement_stack_item\) THEN\s+RAISE EXCEPTION 'refusing to run/, f);
  }
});

test("the route saves only through the function; the editor sends versions and handles 409", () => {
  const routeSrc = read("app/api/supplements/stacks/route.ts");
  assert.match(routeSrc, /saveStack\(supabase, parsed\.value\)/);
  assert.doesNotMatch(routeSrc, /\.delete\(\)/, "no separate clear of the items");
  assert.doesNotMatch(routeSrc, /\.insert\(/, "no separate insert");
  assert.doesNotMatch(routeSrc, /\/client_key\//, "no message-text guess about the client_key column");
  const libSrc = read("lib/supplement-stack-save.ts");
  assert.doesNotMatch(libSrc, /\.message/, "database message text is never read");
  const modal = read("components/StackEditorModal.tsx");
  assert.match(modal, /const fields = chain\.current\.next\(body\)/);
  assert.match(modal, /stackSaveRequest\("POST", \{ \.\.\.body, client_key: clientKey\.current, \.\.\.fields \}/);
  assert.match(modal, /stackSaveRequest\("PATCH", \{ stack_id: stackIdRef\.current, \.\.\.body, \.\.\.fields \}/);
  assert.match(modal, /if \(e instanceof AutosaveRefused\) chain\.current\.refused\(fields\)/);
  assert.match(modal, /if \(e instanceof StackConflict\) setConflict\(true\)/);
  // No clear answer: shown as "Not confirmed" (not "Not saved"), and the id is NOT dropped (only a refusal drops it).
  assert.match(modal, /setUnconfirmed\(e instanceof StackSaveUnconfirmed\)/);
  assert.match(modal, /errorLabel=\{unconfirmed \? "Not confirmed:" : undefined\}/);
  assert.doesNotMatch(modal, /StackSaveUnconfirmed\) chain\.current\.refused/);
  // After an unconfirmed save the loaded values are not "unchanged": the Autosaver is told so (see the real-Autosaver
  // test above), and the hook passes the option through.
  assert.match(modal, /unknownOutcome: stackSaveUnknownOutcome,/);
  assert.match(modal, /if \(e instanceof StackSaveUnconfirmed\) savedAny\.current = true;/, "closing re-reads the list after a maybe-saved change");
  assert.match(read("lib/use-autosave.ts"), /unknownOutcome: \(e\) => optsRef\.current\.unknownOutcome\?\.\(e\) \?\? false,/);
  assert.match(modal, /chain\.current\.accepted\(json\.version\)/);
  // An existing stack with no version reads it first, so an update with a save id never goes out without one.
  assert.match(modal, /chain\.current\.knownVersion === null\) \{\s+const latest = await readVersion\(stackIdRef\.current\);\s+if \(latest !== null\) \{\s+setConflict\(true\);\s+throw new StackConflict\(/, "a version the server now has means changed elsewhere: refused, not attached to the old body");
  assert.match(modal, /fetch\("\/api\/supplements\/stacks\?include_archived=1"/);
  assert.match(modal, /new StackSaveChain\(stack\.stack_id \? \(stack\.version \?\? null\) : null, newClientKey\)/);
  assert.match(modal, /Load the latest version/);
  const page = read("app/supplements/SupplementsClient.tsx");
  assert.match(page, /version: s\.version \?\? null/);
  // After a save the list is read again; until then, and after a failed read until Retry works, a stack cannot be
  // reopened from its old version (behaviour: tests/supplements-page.test.cjs).
  assert.match(page, /onSaved=\{async \(\) => \{\s+setEditingStack\(null\);[\s\S]{0,200}?await loadStacks\(\{ blocking: true \}\);/);
  assert.match(page, /if \(opts\?\.blocking\) setStacksReloading\(true\);/);
  assert.match(page, /if \(seq === stacksReadSeq\.current\) setStacksLoadFailed\(true\);/);
  assert.match(page, /disabled=\{stacksReloading \|\| stacksLoadFailed\}/);
  assert.match(page, /onClick=\{\(\) => void loadStacks\(\{ blocking: true \}\)\}/);
  assert.doesNotMatch(page, /console\.error\("Stacks load:", e\);\s+\}/, "a failed read is never swallowed");
});

test("the stack editor's failed-save text: a conflict keeps the changed-elsewhere guidance, anything else is the fixed copy", () => {
  const guidance = "This stack was changed somewhere else. Load the latest version, then make your change again.";
  assert.equal(chainLib.STACK_CHANGED_ELSEWHERE, guidance);
  assert.equal(chainLib.stackSaveFailureText(new chainLib.StackConflict("Invented server text")), guidance);
  const other = [new autosave.AutosaveRefused("Invented refusal text"), new Error("Invented network text"), { error: "x" }];
  for (const e of other) assert.equal(chainLib.stackSaveFailureText(e), autosave.SAVE_FAILED_COPY);
  const modal = fs.readFileSync(path.join(SRC, "components/StackEditorModal.tsx"), "utf8");
  assert.match(modal, /describeError: stackSaveFailureText,/, "the editor's autosaver describes its failures with the conflict-aware text");
  assert.doesNotMatch(modal, /const STACK_CHANGED_ELSEWHERE/, "the guidance text lives in the lib, once");
});
