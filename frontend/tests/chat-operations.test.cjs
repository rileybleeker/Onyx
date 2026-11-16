// Replay-safe chat writes (SEC-04): lib/chat-operations.ts over the real Supabase store code and an in-memory
// PostgREST stand-in. Each "lost response" below is simulated at one durable step: right after the ledger claim,
// after the write but before the ledger recorded it, and after everything was recorded. Synthetic ids and names only.
const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { loadTs } = require("./helpers/load-ts.cjs");
const { createFakePostgrest, chatLedgerTables } = require("./helpers/fake-postgrest.cjs");

const ops = loadTs("lib/chat-operations.ts");
const receipts = loadTs("lib/chat-receipts.ts");

const OWNER = "00000000-0000-4000-8000-0000000000a1";
const OTHER_OWNER = "00000000-0000-4000-8000-0000000000b2";
const REQUEST = "11111111-1111-4111-8111-111111111111";
const CONVERSATION = ops.conversationSha([{ role: "user", content: "Log my synthetic stack" }]);

const plain = (v) => JSON.parse(JSON.stringify(v));

function setup(extra = {}) {
  const db = createFakePostgrest({ ...chatLedgerTables(randomUUID), ...extra });
  const store = ops.supabaseLedgerStore(db);
  const errors = [];
  const held = [];
  // Each open() is a new try of the request. The tries before it have ended (the route gives the lease back in
  // `finally`), unless the test keeps them running.
  const open = async ({ owner = OWNER, request = REQUEST, conversation = CONVERSATION, reconcilers, keepRunning = false } = {}) => {
    if (!keepRunning) while (held.length) await held.pop().release();
    const opened = await ops.openLedger(store, {
      ownerId: owner,
      requestId: request,
      conversationSha: conversation,
      buildReceipt: receipts.buildWriteReceipt,
      reconcilers,
      onError: (stage, code) => errors.push([stage, code]),
    });
    assert.equal(opened.kind, "ledger");
    held.push(opened.ledger);
    return opened.ledger;
  };
  return { db, store, open, errors };
}

/** A try that was stopped without giving its lease back, once the lease has run out. */
async function expireLeases(db) {
  await db.from("chat_requests").update({ lease_until: new Date(Date.now() - 1000).toISOString() }).eq("owner_id", OWNER);
}

/** A keyed write, like the supplement event key or the reading client_key: the same key never writes twice. */
function keyedWrite() {
  const effects = new Map();
  const keys = [];
  return {
    effects,
    keys,
    execute: (name = "Synthetic Morning") => async (opId) => {
      keys.push(opId);
      if (effects.has(opId)) return { failed: false, result: JSON.stringify({ ...effects.get(opId), replayed: true }) };
      const row = { success: true, stack: name, products: 2, total_doses: 3, date: "2030-01-01" };
      effects.set(opId, row);
      return { failed: false, result: JSON.stringify(row) };
    },
  };
}

const STACK = "log_supplement_stack";
const input = (stack = "synthetic morning") => ({ stack });

test("canonical form: key order and undefined fields do not change the hash; the tool does", () => {
  assert.equal(ops.canonicalJson({ b: 1, a: [1, { d: undefined, c: "x" }] }), '{"a":[1,{"c":"x"}],"b":1}');
  assert.equal(ops.intentSha(STACK, { a: 1, b: 2 }), ops.intentSha(STACK, { b: 2, a: 1 }));
  assert.notEqual(ops.intentSha(STACK, { a: 1 }), ops.intentSha("mark_habit_complete", { a: 1 }));
  assert.equal(ops.canonicalJson(Number.NaN), "null");
  assert.match(ops.intentSha(STACK, {}), /^[0-9a-f]{64}$/);
});

test("outcomes: confirmed = done, clean error = refused (nothing written), throw or incomplete = unknown", () => {
  assert.equal(ops.classifyOutcome({ failed: false, result: '{"success":true}' }), "done");
  assert.equal(ops.classifyOutcome({ failed: false, result: '{"error":"No stack named"}' }), "refused");
  assert.equal(ops.classifyOutcome({ failed: false, result: '{"error":"x","incomplete":true}' }), "unknown");
  assert.equal(ops.classifyOutcome({ failed: true, result: '{"success":true}' }), "unknown");
  assert.equal(ops.classifyOutcome({ failed: false, result: "not json" }), "unknown");
});

test("lost after everything was recorded: the retry gets the stored receipt and nothing runs", async () => {
  const { db, open } = setup();
  const write = keyedWrite();
  const first = await open();
  const done = await first.run(STACK, input(), write.execute());
  assert.equal(done.receipt.status, "saved");
  assert.equal(db.rows("chat_operations")[0].status, "done");

  const retry = await open();
  assert.equal(retry.retry, true);
  let ran = 0;
  const again = await retry.run(STACK, input(), async (opId) => { ran++; return write.execute()(opId); });
  assert.equal(ran, 0, "the ledger answered; the tool did not run");
  assert.equal(write.effects.size, 1);
  assert.equal(again.replayed, true);
  assert.deepEqual(plain(again.receipt.details), [...plain(done.receipt.details), ops.REPLAY_DETAIL]);
  const forModel = JSON.parse(again.result);
  assert.equal(forModel.success, true);
  assert.equal(forModel.replayed, true);
  assert.equal(forModel.note, ops.REPLAY_NOTE);
  assert.equal(db.rows("chat_operations").length, 1);
});

test("lost after the write but before the ledger recorded it: the retry re-runs with the SAME key, so one write", async () => {
  let failFinish = true;
  const { db, open, errors } = setup({
    fail: ({ table, op, payload }) => (failFinish && table === "chat_operations" && op === "update" && payload && payload.status ? { code: "08006" } : null),
  });
  const write = keyedWrite();
  await (await open()).run(STACK, input(), write.execute());
  assert.equal(db.rows("chat_operations")[0].status, "pending", "the record failed: the row is still pending");
  assert.deepEqual(errors, [["finish", "08006"]]);

  failFinish = false;
  const again = await (await open()).run(STACK, input(), write.execute());
  assert.equal(write.keys.length, 2);
  assert.equal(write.keys[0], write.keys[1], "both tries used one operation id as the write's key");
  assert.equal(write.effects.size, 1, "one domain effect");
  assert.equal(again.replayed, true);
  assert.equal(again.receipt.details.at(-1), ops.REPLAY_DETAIL);
  assert.equal(db.rows("chat_operations")[0].status, "done");
});

test("lost right after the claim (the try died before writing): the retry runs the write once", async () => {
  const { db, store, open } = setup();
  await store.claimRequest(OWNER, REQUEST, CONVERSATION, randomUUID());
  const sha = ops.intentSha(STACK, input());
  await store.claim({ owner_id: OWNER, request_id: REQUEST, tool: STACK, ordinal: 1 }, sha, input());
  await expireLeases(db);
  const write = keyedWrite();
  const again = await (await open()).run(STACK, input(), write.execute());
  assert.equal(write.effects.size, 1);
  assert.equal(again.replayed, false);
  assert.equal(again.receipt.status, "saved", "written now, by this try");
  assert.equal(db.rows("chat_operations")[0].status, "done");
});

test("two tries of one message at the same moment: one runs, the other is turned away before anything runs", async () => {
  const { store } = setup();
  const openOne = () => ops.openLedger(store, { ownerId: OWNER, requestId: REQUEST, conversationSha: CONVERSATION, buildReceipt: receipts.buildWriteReceipt });
  const kinds = (await Promise.all([openOne(), openOne()])).map((o) => o.kind).sort();
  assert.deepEqual(kinds, ["busy", "ledger"]);
});

test("one try at a time: a retry waits for the lease; given back or run out, the next try takes it", async () => {
  const { db, store } = setup();
  const openOne = () => ops.openLedger(store, { ownerId: OWNER, requestId: REQUEST, conversationSha: CONVERSATION, buildReceipt: receipts.buildWriteReceipt });
  const first = await openOne();
  assert.equal(first.kind, "ledger");
  assert.equal(first.ledger.retry, false);
  assert.equal((await openOne()).kind, "busy", "the first try still holds it");
  await first.ledger.release();
  const second = await openOne();
  assert.equal(second.kind, "ledger");
  assert.equal(second.ledger.retry, true);
  // The second try is stopped without giving it back: busy until the lease runs out, then the next try takes it.
  assert.equal((await openOne()).kind, "busy");
  await expireLeases(db);
  const third = await openOne();
  assert.equal(third.kind, "ledger");
  // A late release by the stopped try does not free the lease the third try holds.
  await second.ledger.release();
  assert.equal((await openOne()).kind, "busy");
  assert.ok(ops.REQUEST_LEASE_MS > 300_000, "longer than the chat route's maxDuration");
});

test("two ledgers on one request (no lease between them) still write once", async () => {
  const { store } = setup();
  await store.claimRequest(OWNER, REQUEST, CONVERSATION, randomUUID());
  const ledger = () => new ops.ChatLedger({ store, ownerId: OWNER, requestId: REQUEST, retry: true, buildReceipt: receipts.buildWriteReceipt });
  const write = keyedWrite();
  const [a, b] = [ledger(), ledger()];
  await Promise.all([a.run(STACK, input(), write.execute()), b.run(STACK, input(), write.execute())]);
  assert.equal(write.effects.size, 1);
});

test("a retry that asks for different details is refused; what the first try saved is still listed once", async () => {
  const { open } = setup();
  const write = keyedWrite();
  const first = await (await open()).run(STACK, input("synthetic morning"), write.execute("Synthetic Morning"));
  let ran = 0;
  const retry = await open();
  const conflict = await retry.run(STACK, input("synthetic evening"), async () => { ran++; return { failed: false, result: "{}" }; });
  assert.equal(ran, 0);
  assert.equal(write.effects.size, 1);
  const forModel = JSON.parse(conflict.result);
  assert.equal(forModel.conflict, true);
  assert.equal(forModel.error, ops.CONFLICT_ERROR);
  assert.equal(forModel.earlier_result.stack, "Synthetic Morning");
  assert.equal(conflict.receipt.status, "not_saved", "the refused call wrote nothing");
  const earlier = plain(await retry.earlierReceipts());
  assert.equal(earlier.length, 1);
  assert.deepEqual(earlier[0].details, [...plain(first.receipt.details), ops.EARLIER_DETAIL]);
});

test("the same calls in another order on the retry are matched by content", async () => {
  const { open } = setup();
  const write = keyedWrite();
  const first = await open();
  await first.run(STACK, input("synthetic morning"), write.execute("Synthetic Morning"));
  await first.run(STACK, input("synthetic evening"), write.execute("Synthetic Evening"));
  const retry = await open();
  let ran = 0;
  const count = async (opId) => { ran++; return write.execute()(opId); };
  const evening = await retry.run(STACK, input("synthetic evening"), count);
  const morning = await retry.run(STACK, input("synthetic morning"), count);
  assert.equal(ran, 0);
  assert.equal(JSON.parse(evening.result).stack, "Synthetic Evening");
  assert.equal(JSON.parse(morning.result).stack, "Synthetic Morning");
  assert.equal(write.effects.size, 2);
});

test("a call the first try refused (nothing written) does not block the retry: the same call or another one runs", async () => {
  const { db, open } = setup();
  const refuse = async () => ({ failed: false, result: JSON.stringify({ error: 'No stack named "synthetic evening".', available: ["Synthetic Morning", "Synthetic Night"] }) });
  const refused = await (await open()).run(STACK, input("synthetic evening"), refuse);
  assert.equal(refused.receipt.status, "not_saved");
  const stored = db.rows("chat_operations")[0];
  assert.equal(stored.status, "refused");
  assert.deepEqual(stored.result, { error: 'No stack named "synthetic evening".' }, "a refusal keeps its error line, not the lists it carried");
  const write = keyedWrite();
  // The model picks the right stack this time: nothing earlier was written, so the call runs.
  const again = await (await open()).run(STACK, input("synthetic morning"), write.execute());
  assert.equal(write.effects.size, 1);
  assert.equal(again.receipt.status, "saved");
  assert.deepEqual(db.rows("chat_operations").map((r) => r.status), ["refused", "done"]);

  // The same refused call made again re-runs in its own place, under its own operation id.
  const { db: db2, open: open2 } = setup();
  await (await open2()).run(STACK, input("synthetic morning"), refuse);
  const opId = db2.rows("chat_operations")[0].op_id;
  const write2 = keyedWrite();
  const rerun = await (await open2()).run(STACK, input("synthetic morning"), write2.execute());
  assert.equal(rerun.receipt.status, "saved");
  assert.deepEqual(write2.keys, [opId]);
  assert.equal(db2.rows("chat_operations").length, 1);
  assert.equal(db2.rows("chat_operations")[0].status, "done");
});

test("a new message is a new request: an intentional second log writes again", async () => {
  const { open } = setup();
  const write = keyedWrite();
  await (await open()).run(STACK, input(), write.execute());
  await (await open({ request: "22222222-2222-4222-8222-222222222222" })).run(STACK, input(), write.execute());
  assert.equal(write.effects.size, 2);
});

test("one request id under another owner is a separate request and never sees the first owner's receipts", async () => {
  const { db, open } = setup();
  const write = keyedWrite();
  const mine = await open();
  await mine.run(STACK, input(), write.execute());
  const theirs = await open({ owner: OTHER_OWNER });
  assert.equal(theirs.retry, false, "not a retry: the id belongs to another owner's request");
  assert.deepEqual(plain(await theirs.earlierReceipts()), []);
  await theirs.run(STACK, input(), write.execute());
  assert.equal(write.effects.size, 2);
  assert.deepEqual(db.rows("chat_operations").map((r) => r.owner_id).sort(), [OWNER, OTHER_OWNER].sort());
});

test("the same request id with another conversation is a conflict", async () => {
  const { store } = setup();
  const a = randomUUID();
  assert.equal(await store.claimRequest(OWNER, REQUEST, CONVERSATION, a), "new");
  await store.releaseRequest(OWNER, REQUEST, a);
  assert.equal(await store.claimRequest(OWNER, REQUEST, CONVERSATION, randomUUID()), "retry");
  const other = ops.conversationSha([{ role: "user", content: "Log my other synthetic stack" }]);
  assert.equal(await store.claimRequest(OWNER, REQUEST, other, randomUUID()), "conflict");
  const opened = await ops.openLedger(store, { ownerId: OWNER, requestId: REQUEST, conversationSha: other, buildReceipt: receipts.buildWriteReceipt });
  assert.equal(opened.kind, "conflict");
});

test("a retry where the model did not repeat a call still lists what the first try saved", async () => {
  const { open } = setup();
  const write = keyedWrite();
  const first = await (await open()).run(STACK, input(), write.execute());
  const retry = await open();
  const earlier = plain(await retry.earlierReceipts());
  assert.equal(earlier.length, 1);
  assert.deepEqual(earlier[0].details, [...plain(first.receipt.details), ops.EARLIER_DETAIL]);
  // A first try lists nothing.
  assert.deepEqual(plain(await (await open({ request: "33333333-3333-4333-8333-333333333333" })).earlierReceipts()), []);
});

test("a playlist left unconfirmed is looked up read-only and never created again by a retry", async () => {
  const { db, open } = setup();
  const PLAYLIST = "create_spotify_playlist";
  const call = { name: "Synthetic focus mix", track_ids: ["t1", "t2"] };
  let creates = 0;
  const create = async () => {
    creates++;
    return { failed: false, result: JSON.stringify({ error: "Spotify may have created the playlist before this failed.", incomplete: true }) };
  };
  const reconcilers = ops.supabaseReconcilers(db);
  const first = await (await open({ reconcilers })).run(PLAYLIST, call, create);
  assert.equal(first.receipt.status, "unknown");
  assert.equal(db.rows("chat_operations")[0].status, "unknown");

  // Nothing in pds.spotify_playlists: the retry cannot confirm it and creates nothing.
  const unsure = await (await open({ reconcilers })).run(PLAYLIST, call, create);
  assert.equal(creates, 1);
  assert.equal(unsure.receipt.status, "unknown");
  assert.equal(JSON.parse(unsure.result).uncertain, true);

  // An audit row with the same name but another operation's key is not taken for it.
  const opRow = db.rows("chat_operations")[0];
  db.seed("spotify_playlists", [
    { playlist_id: "other", name: call.name, created_via: "chat", spotify_url: "https://open.spotify.com/playlist/other", track_count: 2, client_key: randomUUID(), created_at: opRow.created_at },
  ]);
  const stillUnsure = await (await open({ reconcilers })).run(PLAYLIST, call, create);
  assert.equal(stillUnsure.receipt.status, "unknown");
  // The audit row carries this operation's key (the first try did create it): the retry confirms it from there.
  db.seed("spotify_playlists", [
    { playlist_id: "pl1", name: call.name, created_via: "chat", spotify_url: "https://open.spotify.com/playlist/pl1", track_count: 2, client_key: opRow.op_id, created_at: opRow.created_at },
  ]);
  const found = await (await open({ reconcilers })).run(PLAYLIST, call, create);
  assert.equal(creates, 1, "still one create call in total");
  assert.equal(found.replayed, true);
  assert.equal(found.receipt.status, "unchanged", "made by the earlier try, nothing new now");
  assert.equal(found.receipt.link.href, "https://open.spotify.com/playlist/pl1", "found by its key, not by its name");
  assert.equal(db.rows("chat_operations")[0].status, "done");

  // From now on it is a plain replay.
  const later = await (await open({ reconcilers: {} })).run(PLAYLIST, call, create);
  assert.equal(later.replayed, true);
  assert.equal(creates, 1);
});

test("a quiz result left pending is confirmed from pds.reading_quizzes, never recorded twice", async () => {
  const { db, store, open } = setup({
    tables: {
      books: [
        { book_id: 3, slug: "synthetic-book", status: "reading", created_at: "2029-06-01T00:00:00.000Z" },
        { book_id: 4, slug: "other-synthetic-book", status: "finished", created_at: "2029-01-01T00:00:00.000Z" },
      ],
    },
  });
  const QUIZ = "record_reading_quiz";
  const call = { checkpoint: "ch12", score: 4, total: 5 };
  await store.claimRequest(OWNER, REQUEST, CONVERSATION, randomUUID());
  const { row } = await store.claim({ owner_id: OWNER, request_id: REQUEST, tool: QUIZ, ordinal: 1 }, ops.intentSha(QUIZ, call), call);
  await expireLeases(db);
  let records = 0;
  const record = async () => { records++; return { failed: false, result: JSON.stringify({ success: true }) }; };
  const reconcilers = ops.supabaseReconcilers(db);
  const unsure = await (await open({ reconcilers })).run(QUIZ, call, record);
  assert.equal(records, 0);
  assert.equal(unsure.receipt.status, "unknown");
  // The same checkpoint and score for another book is not this quiz.
  db.seed("reading_quizzes", [{ quiz_id: 8, book_id: 4, checkpoint: "ch12", score: 4, total: 5, quiz_date: "2030-01-01", taken_at: row.created_at }]);
  assert.equal((await (await open({ reconcilers })).run(QUIZ, call, record)).receipt.status, "unknown");
  db.seed("reading_quizzes", [{ quiz_id: 9, book_id: 3, checkpoint: "ch12", score: 4, total: 5, quiz_date: "2030-01-01", taken_at: row.created_at }]);
  const found = await (await open({ reconcilers })).run(QUIZ, call, record);
  assert.equal(records, 0);
  assert.equal(found.receipt.status, "unchanged");
  assert.deepEqual(plain(found.receipt.details.slice(0, 2)), ["ch12: 4/5 (passed)", "Day: 2030-01-01"]);
});

test("a ledger that cannot record the call refuses the write instead of running it unrecorded", async () => {
  const { db, open, errors } = setup();
  const ledger = await open();
  db.setFailure(({ table, op }) => (table === "chat_operations" && op === "insert" ? { code: "53300" } : null));
  let ran = 0;
  const out = await ledger.run(STACK, input(), async () => { ran++; return { failed: false, result: '{"success":true}' }; });
  assert.equal(ran, 0);
  assert.equal(out.receipt.status, "not_saved");
  assert.equal(JSON.parse(out.result).error, ops.LEDGER_ERROR);
  assert.deepEqual(errors, [["claim", "53300"]]);
});

test("missing ledger tables are reported as unavailable (the route then runs as before), other failures as failed", async () => {
  const missing = ops.supabaseLedgerStore(createFakePostgrest({ fail: () => ({ code: "PGRST205" }) }));
  assert.deepEqual(plain(await ops.openLedger(missing, { ownerId: OWNER, requestId: REQUEST, conversationSha: CONVERSATION, buildReceipt: receipts.buildWriteReceipt })), { kind: "unavailable", code: "PGRST205" });
  const broken = ops.supabaseLedgerStore(createFakePostgrest({ fail: () => ({ code: "08006" }) }));
  assert.deepEqual(plain(await ops.openLedger(broken, { ownerId: OWNER, requestId: REQUEST, conversationSha: CONVERSATION, buildReceipt: receipts.buildWriteReceipt })), { kind: "failed", code: "08006" });
});

test("only the keyed and naturally idempotent write tools are re-run; every other write tool is looked up", () => {
  for (const tool of receipts.WRITE_TOOLS) {
    const rerun = ops.RERUN_SAFE.has(tool);
    assert.equal(rerun, !["record_reading_quiz", "create_spotify_playlist"].includes(tool), tool);
  }
  assert.equal(ops.RERUN_SAFE.has("a_future_write_tool"), false);
});

test("uncertain-outcome texts fit the receipt without being cut", () => {
  for (const tool of receipts.WRITE_TOOLS) assert.ok(ops.uncertainText(tool).length <= 240, tool);
  for (const text of [ops.CONFLICT_ERROR, ops.REPEAT_ERROR, ops.LEDGER_ERROR]) assert.ok(text.length <= 240);
});

// ---------------------------------------------------------------------------
// Retries whose model makes the calls differently (review round 1). A retry never creates a new write while an
// earlier write is still unmatched, so a reordered, reworded or repeated call cannot write a second time.
// ---------------------------------------------------------------------------
const INTAKE = "log_supplement_intake";

test("first try saved A and stopped before B; the retry calls B then A: A is not written again", async () => {
  const { db, open } = setup();
  const write = keyedWrite();
  await (await open()).run(INTAKE, { product: "synthetic a" }, write.execute("A"));
  const retry = await open();
  let ranA = 0;
  const b = await retry.run(INTAKE, { product: "synthetic b" }, write.execute("B"));
  const a = await retry.run(INTAKE, { product: "synthetic a" }, async (opId) => { ranA++; return write.execute("A")(opId); });
  assert.equal(ranA, 0, "A was answered from the ledger");
  assert.equal(a.replayed, true);
  assert.equal(JSON.parse(b.result).conflict, true, "B could have been A asked differently: refused while A is unmatched");
  assert.equal(b.receipt.status, "not_saved");
  assert.equal(write.effects.size, 1, "one domain effect");
  assert.equal(db.rows("chat_operations").length, 1, "the refused call made no row");
  assert.deepEqual(plain(await retry.earlierReceipts()), [], "A was answered in this try, so it is not listed again");
});

test("a changed call the retry refused is refused again when the model repeats it, also after the earlier write matched", async () => {
  const { open } = setup();
  const write = keyedWrite();
  await (await open()).run(INTAKE, { product: "synthetic a" }, write.execute("A"));
  const retry = await open();
  const changed = { product: "synthetic a", amount: 2 };
  assert.equal(JSON.parse((await retry.run(INTAKE, changed, write.execute("A2"))).result).conflict, true);
  assert.equal(JSON.parse((await retry.run(INTAKE, changed, write.execute("A2"))).result).conflict, true);
  assert.equal((await retry.run(INTAKE, { product: "synthetic a" }, write.execute("A"))).replayed, true);
  assert.equal(JSON.parse((await retry.run(INTAKE, changed, write.execute("A2"))).result).conflict, true);
  assert.equal(write.effects.size, 1);
});

test("a stack the first try logged, asked for as single products on the retry, is not logged a second time", async () => {
  const { open } = setup();
  const write = keyedWrite();
  await (await open()).run(STACK, input(), write.execute());
  const retry = await open();
  const x = await retry.run(INTAKE, { product: "synthetic x" }, write.execute("X"));
  const y = await retry.run(INTAKE, { product: "synthetic y" }, write.execute("Y"));
  assert.equal(JSON.parse(x.result).conflict, true);
  assert.equal(JSON.parse(x.result).earlier_tool, STACK);
  assert.equal(JSON.parse(y.result).conflict, true);
  assert.equal(write.effects.size, 1);
  assert.equal((await retry.earlierReceipts()).length, 1, "the stack the first try saved is still shown");
});

test("one more copy of a call than the first try made is refused; a new call past every earlier write runs", async () => {
  const { db, open } = setup();
  const write = keyedWrite();
  await (await open()).run(INTAKE, { product: "synthetic a" }, write.execute("A"));
  const retry = await open();
  assert.equal((await retry.run(INTAKE, { product: "synthetic a" }, write.execute("A"))).replayed, true);
  const extra = await retry.run(INTAKE, { product: "synthetic a" }, write.execute("A"));
  assert.equal(JSON.parse(extra.result).error, ops.REPEAT_ERROR);
  assert.equal(write.effects.size, 1);
  // The first try stopped before B; with A accounted for, B is the rest of the message and runs once.
  const b = await retry.run(INTAKE, { product: "synthetic b" }, write.execute("B"));
  assert.equal(JSON.parse(b.result).success, true);
  assert.equal(b.replayed, false);
  assert.equal(write.effects.size, 2);
  assert.deepEqual(db.rows("chat_operations").map((r) => r.ordinal).sort(), [1, 2]);
  // A later retry answers both from the ledger.
  const later = await open();
  assert.equal((await later.run(INTAKE, { product: "synthetic b" }, write.execute("B"))).replayed, true);
  assert.equal((await later.run(INTAKE, { product: "synthetic a" }, write.execute("A"))).replayed, true);
  assert.equal(write.effects.size, 2);
});

test("a re-run gets the context the operation first ran with (its behavioral day), not the retry's", async () => {
  let failFinish = true;
  const { open } = setup({
    fail: ({ table, op, payload }) => (failFinish && table === "chat_operations" && op === "update" && payload && payload.status ? { code: "08006" } : null),
  });
  const seen = [];
  const execute = async (opId, context) => {
    seen.push(context.behavioral_today);
    return { failed: false, result: JSON.stringify({ success: true, entry: { question: "Synthetic habit", answer: "Yes", cycle_date: context.behavioral_today } }) };
  };
  await (await open()).run("mark_habit_complete", { habit: "Synthetic habit" }, execute, { behavioral_today: "2030-01-01" });
  failFinish = false;
  const again = await (await open()).run("mark_habit_complete", { habit: "Synthetic habit" }, execute, { behavioral_today: "2030-01-02" });
  assert.deepEqual(seen, ["2030-01-01", "2030-01-01"], "the re-run after the day rolled over keeps the first day");
  assert.match(again.receipt.details.join(" "), /2030-01-01/);
});

test("an unfinished call keeps only its error line in the ledger", () => {
  assert.deepEqual(plain(ops.storedResult("refused", { error: "x", candidates: ["a", "b"] })), { error: "x" });
  assert.deepEqual(plain(ops.storedResult("unknown", { error: "x", incomplete: true, available: ["a"] })), { error: "x", incomplete: true });
  assert.deepEqual(plain(ops.storedResult("done", { success: true, items: [1] })), { success: true, items: [1] });
});

// ---------------------------------------------------------------------------
// Review round 2: wording-tolerant matching, a repeat of an unconfirmed call in the same try, partial reconciles,
// the pinned book, and reading a request's outcome back by its id alone (the page after a reload).
// ---------------------------------------------------------------------------

test("matching ignores what the tools ignore: case of resolved names, padding of times, empty fields, numeric strings", () => {
  const a = ops.intentSha(INTAKE, { product: "Synthetic Focus", amount: 2, unit: "mg", times: ["8:30", "8:30 PM"], date: null });
  const b = ops.intentSha(INTAKE, { product: "  synthetic focus ", amount: "2", unit: "MG", times: ["08:30", "08:30pm"] });
  assert.equal(a, b);
  assert.notEqual(a, ops.intentSha(INTAKE, { product: "Synthetic Calm", amount: 2, unit: "mg", times: ["08:30", "08:30pm"] }));
  assert.notEqual(a, ops.intentSha(INTAKE, { product: "Synthetic Focus", amount: 3, unit: "mg", times: ["08:30", "08:30pm"] }));
  // Free text keeps its case: a passage is the highlight itself.
  assert.notEqual(ops.intentSha("add_book_highlight", { passage: "Synthetic Line" }), ops.intentSha("add_book_highlight", { passage: "synthetic line" }));
});

test("a retry worded slightly differently by the model is answered from the stored row", async () => {
  const { open } = setup();
  const write = keyedWrite();
  await (await open()).run(STACK, { stack: "Synthetic Morning" }, write.execute());
  let ran = 0;
  const again = await (await open()).run(STACK, { stack: "synthetic morning " }, async (opId) => { ran++; return write.execute()(opId); });
  assert.equal(ran, 0);
  assert.equal(again.replayed, true);
  assert.equal(again.receipt.status, "unchanged");
});

test("in one try, the model asking again for a call whose outcome was unclear re-runs the SAME operation", async () => {
  const { db, open } = setup();
  const keys = [];
  let calls = 0;
  const execute = async (opId) => {
    keys.push(opId);
    calls++;
    // The first answer was lost after the write: the keyed write reports it may be done.
    return calls === 1
      ? { failed: false, result: JSON.stringify({ error: "The database did not confirm this.", incomplete: true }) }
      : { failed: false, result: JSON.stringify({ success: true, stack: "Synthetic Morning", replayed: true }) };
  };
  const ledger = await open();
  const first = await ledger.run(STACK, input(), execute);
  assert.equal(first.receipt.status, "unknown");
  const second = await ledger.run(STACK, input(), execute);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1], "the repeat used the first call's operation id, so its key finds the rows");
  assert.equal(second.replayed, true);
  assert.equal(db.rows("chat_operations").length, 1, "one operation, not two");
  assert.equal(db.rows("chat_operations")[0].status, "done");
});

test("a playlist found with its tracks unconfirmed is never made again and its receipt says to check it", async () => {
  const { db, store, open } = setup();
  const PLAYLIST = "create_spotify_playlist";
  const call = { name: "Synthetic run mix", track_ids: ["t1"] };
  await store.claimRequest(OWNER, REQUEST, CONVERSATION, randomUUID());
  const { row } = await store.claim({ owner_id: OWNER, request_id: REQUEST, tool: PLAYLIST, ordinal: 1 }, ops.intentSha(PLAYLIST, call), call);
  await expireLeases(db);
  // createPlaylist wrote the audit row right after Spotify made the playlist; the try stopped before the tracks.
  db.seed("spotify_playlists", [{ playlist_id: "pl2", name: call.name, spotify_url: "https://open.spotify.com/playlist/pl2", track_count: null, client_key: row.op_id }]);
  let creates = 0;
  const create = async () => { creates++; return { failed: false, result: '{"success":true}' }; };
  const found = await (await open({ reconcilers: ops.supabaseReconcilers(db) })).run(PLAYLIST, call, create);
  assert.equal(creates, 0);
  assert.equal(found.receipt.status, "unknown");
  assert.ok(found.receipt.details.includes(ops.PLAYLIST_TRACKS_UNCONFIRMED));
  assert.equal(found.receipt.link.href, "https://open.spotify.com/playlist/pl2");
  assert.equal(db.rows("chat_operations")[0].status, "done", "it exists: a later retry replays it and never creates");
});

test("a quiz is looked up under the book pinned when the operation began, not the one being read now", async () => {
  const { db, store, open } = setup({
    tables: {
      books: [
        { book_id: 3, slug: "synthetic-book", status: "finished", created_at: "2029-06-01T00:00:00.000Z" },
        { book_id: 5, slug: "newer-synthetic-book", status: "reading", created_at: "2029-09-01T00:00:00.000Z" },
      ],
    },
  });
  const QUIZ = "record_reading_quiz";
  const call = { checkpoint: "ch3", score: 5, total: 5 };
  await store.claimRequest(OWNER, REQUEST, CONVERSATION, randomUUID());
  const { row } = await store.claim({ owner_id: OWNER, request_id: REQUEST, tool: QUIZ, ordinal: 1 }, ops.intentSha(QUIZ, call), call, { book_id: 3 });
  await expireLeases(db);
  db.seed("reading_quizzes", [
    { quiz_id: 21, book_id: 5, checkpoint: "ch3", score: 5, total: 5, quiz_date: "2030-01-01", taken_at: row.created_at },
    { quiz_id: 22, book_id: 3, checkpoint: "ch3", score: 5, total: 5, quiz_date: "2030-01-01", taken_at: row.created_at },
  ]);
  const found = await (await open({ reconcilers: ops.supabaseReconcilers(db) })).run(QUIZ, call, async () => ({ failed: false, result: "{}" }));
  assert.equal(JSON.parse(found.result).quiz_id, 22);
});

test("a request read back by its id alone: none, running, then what it saved (refused calls left out)", async () => {
  const { store, open } = setup();
  const outcome = (now) => ops.requestOutcome(store, OWNER, REQUEST, receipts.buildWriteReceipt, now);
  assert.deepEqual(plain(await outcome()), { status: "none", receipts: [] });

  const write = keyedWrite();
  const ledger = await open();
  await ledger.run(STACK, input("synthetic morning"), write.execute("Synthetic Morning"));
  await ledger.run(STACK, input("synthetic nothing"), async () => ({ failed: false, result: JSON.stringify({ error: 'No stack named "synthetic nothing".' }) }));
  const running = plain(await outcome());
  assert.equal(running.status, "running", "the try still holds the lease");
  assert.deepEqual(running.receipts.map((r) => r.status), ["saved"]);

  await ledger.release();
  const settled = plain(await outcome());
  assert.equal(settled.status, "settled");
  assert.deepEqual(settled.receipts.map((r) => r.status), ["saved"]);
  // Another owner never sees it.
  assert.equal((await ops.requestOutcome(store, OTHER_OWNER, REQUEST, receipts.buildWriteReceipt)).status, "none");
  // A call that was claimed but never finished reads "check this".
  await store.claim({ owner_id: OWNER, request_id: REQUEST, tool: STACK, ordinal: 9 }, ops.intentSha(STACK, input("x")), input("x"));
  assert.deepEqual(plain(await outcome()).receipts.map((r) => r.status), ["saved", "unknown"]);
  // Missing tables: "unavailable", with the code only.
  const missing = ops.supabaseLedgerStore(createFakePostgrest({ fail: () => ({ code: "PGRST205" }) }));
  assert.deepEqual(plain(await ops.requestOutcome(missing, OWNER, REQUEST, receipts.buildWriteReceipt)), { status: "unavailable", code: "PGRST205", receipts: [] });
});
