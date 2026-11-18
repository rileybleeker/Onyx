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

/** keyedWrite for log_supplement_intake: the same keyed effects, answered in that tool's shape (one entry logged). */
function keyedIntakeWrite() {
  const w = keyedWrite();
  return {
    ...w,
    execute: (name) => async (opId) => {
      const out = await w.execute(name)(opId);
      return { ...out, result: JSON.stringify({ ...JSON.parse(out.result), product: name, logged: [{ time: "08:00" }] }) };
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

/** What pds.chat_ledger_purge does to one request (sql/chat_ledger_retention.sql): marker first, then the rows. */
async function purgeRequest(db, owner = OWNER, request = REQUEST) {
  const row = db.rows("chat_requests").find((r) => r.owner_id === owner && r.request_id === request);
  db.seed("chat_retired_requests", [{ owner_id: owner, request_id: request, conversation_sha: row.conversation_sha, retired_at: db.now() }]);
  await db.from("chat_operations").delete().eq("owner_id", owner).eq("request_id", request);
  await db.from("chat_requests").delete().eq("owner_id", owner).eq("request_id", request);
}

test("CHAT795-1: a send whose ledger rows retention removed is refused on retry, never written again", async () => {
  const { db, store, open } = setup();
  const write = keyedWrite();
  const first = await open();
  await first.run(STACK, input(), write.execute());
  await first.release();
  assert.equal(write.effects.size, 1);

  await purgeRequest(db);
  assert.equal(db.rows("chat_requests").length, 0);

  const opened = await ops.openLedger(store, { ownerId: OWNER, requestId: REQUEST, conversationSha: CONVERSATION, buildReceipt: receipts.buildWriteReceipt });
  assert.equal(opened.kind, "retired", "the old id is not taken as a new request");
  assert.equal(write.effects.size, 1, "one domain effect: nothing ran again");
  assert.equal(db.rows("chat_requests").length, 0, "no new ledger row under the retired id");
  // Another owner's same id is unaffected by this owner's marker.
  assert.equal(await store.claimRequest(OTHER_OWNER, REQUEST, CONVERSATION, randomUUID()), "new");
});

test("CHAT795-1: a purge that retires the id between the check and the insert still refuses it", async () => {
  let racing = true;
  const { db, store } = setup();
  db.setFailure(({ table, op }) => {
    // The purge commits right before this try's insert: the old row is gone (so the insert succeeds) and its marker
    // is in place. The fake runs each call alone, so only the marker is staged here; the id has no row.
    if (racing && table === "chat_requests" && op === "insert") {
      racing = false;
      db.seed("chat_retired_requests", [{ owner_id: OWNER, request_id: REQUEST, conversation_sha: CONVERSATION, retired_at: db.now() }]);
    }
    return null;
  });
  const b = randomUUID();
  assert.equal(await store.claimRequest(OWNER, REQUEST, CONVERSATION, b), "retired", "refused, not run as new");
  assert.equal(db.rows("chat_requests").length, 0, "the new row was taken back");
  assert.equal(await store.claimRequest(OWNER, REQUEST, CONVERSATION, randomUUID()), "retired", "and stays refused");
});

test("CHAT795-1: before the marker table exists, claims work exactly as before", async () => {
  const { store } = setup({ fail: ({ table }) => (table === "chat_retired_requests" ? { code: "PGRST205" } : null) });
  const a = randomUUID();
  assert.equal(await store.claimRequest(OWNER, REQUEST, CONVERSATION, a), "new");
  await store.releaseRequest(OWNER, REQUEST, a);
  assert.equal(await store.claimRequest(OWNER, REQUEST, CONVERSATION, randomUUID()), "retry");
  const broken = setup({ fail: ({ table }) => (table === "chat_retired_requests" ? { code: "08006" } : null) });
  await assert.rejects(broken.store.claimRequest(OWNER, REQUEST, CONVERSATION, randomUUID()), (e) => e instanceof ops.LedgerFailure);
  assert.equal(broken.db.rows("chat_requests").length, 0, "an unreadable marker writes nothing (fails closed)");
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

test("a quiz result left pending is re-run under its own operation key, read back only when another call wrote", async () => {
  const { db, store, open } = setup({
    tables: { books: [{ book_id: 3, slug: "synthetic-book", status: "reading", created_at: "2029-06-01T00:00:00.000Z" }] },
  });
  const QUIZ = "record_reading_quiz";
  const call = { checkpoint: "ch12", score: 4, total: 5 };
  await store.claimRequest(OWNER, REQUEST, CONVERSATION, randomUUID());
  const { row } = await store.claim({ owner_id: OWNER, request_id: REQUEST, tool: QUIZ, ordinal: 1 }, ops.intentSha(QUIZ, call), call, { book_id: 3 });
  await expireLeases(db);
  assert.equal(ops.supabaseReconcilers(db).record_reading_quiz, undefined, "never matched by book, checkpoint, score or time");
  // A lookalike row is not proof; the quiz write itself answers by its op_key (the RPC's stored receipt).
  db.seed("reading_quizzes", [{ quiz_id: 9, book_id: 3, checkpoint: "ch12", score: 4, total: 5, quiz_date: "2030-01-01", taken_at: row.created_at }]);
  const runs = [];
  const record = async (opId, _context, check) => {
    runs.push({ opId, check });
    return { failed: false, result: JSON.stringify({ success: true, passed: true, score: "4/5", checkpoint: "ch12", quiz_date: "2030-01-01", quiz_id: 9, replayed: true }) };
  };
  const out = await (await open()).run(QUIZ, call, record);
  assert.deepEqual(runs, [{ opId: row.op_id, check: false }], "re-run under the same key, a write allowed (nothing else was written)");
  assert.equal(out.replayed, true);
  assert.equal(out.receipt.status, "unchanged");
  assert.equal(db.rows("chat_operations")[0].status, "done");

  // Another call of the earlier try wrote too: the quiz re-run only reads back what its key holds.
  const other = setup();
  await other.store.claimRequest(OWNER, REQUEST, CONVERSATION, randomUUID());
  const quizRow = (await other.store.claim({ owner_id: OWNER, request_id: REQUEST, tool: QUIZ, ordinal: 1 }, ops.intentSha(QUIZ, call), call, {})).row;
  const stackRow = (await other.store.claim({ owner_id: OWNER, request_id: REQUEST, tool: STACK, ordinal: 1 }, ops.intentSha(STACK, input()), input(), {})).row;
  await other.store.finish(stackRow, "done", { success: true }, null);
  await expireLeases(other.db);
  const checks = [];
  await (await other.open()).run(QUIZ, call, async (opId, _context, check) => {
    checks.push({ opId, check });
    return { failed: false, result: JSON.stringify({ error: ops.uncertainText(QUIZ), incomplete: true, uncertain: true }) };
  });
  assert.deepEqual(checks, [{ opId: quizRow.op_id, check: true }]);
});

test("the first try's request context is stored with the request row and handed to every retry", async () => {
  const { db, store } = setup();
  const context = { now: "2030-01-01T04:59:00.000Z", time_zone: "UTC", behavioral_today: "2029-12-31" };
  const base = { ownerId: OWNER, requestId: REQUEST, conversationSha: CONVERSATION, buildReceipt: receipts.buildWriteReceipt };
  const first = await ops.openLedger(store, { ...base, requestContext: context });
  assert.equal(first.kind, "ledger");
  assert.equal(first.ledger.retry, false);
  assert.deepEqual(plain(first.ledger.requestContext), context);
  assert.deepEqual(plain(db.rows("chat_requests")[0].context), context, "written with the row, in the same insert");
  await first.ledger.release();
  // The retry brings this moment's context; the stored one wins.
  const later = { now: "2030-01-01T12:00:00.000Z", time_zone: "UTC", behavioral_today: "2030-01-01" };
  const retry = await ops.openLedger(store, { ...base, requestContext: later });
  assert.equal(retry.ledger.retry, true);
  assert.deepEqual(plain(retry.ledger.requestContext), context);
  assert.deepEqual(plain(db.rows("chat_requests")[0].context), context, "never overwritten by a retry");
  await retry.ledger.release();
  // A context that cannot be read fails the ledger (writes pause), never a fresh day.
  db.setFailure(({ table, op }) => (table === "chat_requests" && op === "select" ? { code: "08006" } : null));
  assert.deepEqual(plain(await ops.openLedger(store, { ...base, requestContext: later })), { kind: "failed", code: "08006" });
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

test("only keyed write tools are re-run; habit and highlight re-run in check mode; every other write tool is looked up", () => {
  for (const tool of receipts.WRITE_TOOLS) {
    const keyed = ["log_supplement_intake", "log_supplement_stack", "log_reading_session", "record_reading_quiz", "record_reading_answer", "flag_reading_question"].includes(tool);
    const checked = ["mark_habit_complete", "add_book_highlight"].includes(tool);
    assert.equal(ops.RERUN_SAFE.has(tool), keyed, tool);
    assert.equal(ops.CHECK_ON_RERUN.has(tool), checked, tool);
  }
  assert.equal(ops.RERUN_SAFE.has("a_future_write_tool"), false);
  assert.equal(ops.CHECK_ON_RERUN.has("a_future_write_tool"), false);
});

test("uncertain-outcome texts fit the receipt without being cut", () => {
  for (const tool of receipts.WRITE_TOOLS) assert.ok(ops.uncertainText(tool).length <= 240, tool);
  for (const text of [ops.CONFLICT_ERROR, ops.REPEAT_ERROR, ops.FRESH_ERROR, ops.UNSETTLED_ERROR, ops.LEDGER_ERROR]) assert.ok(text.length <= 240);
});

// ---------------------------------------------------------------------------
// Retries whose model makes the calls differently (review rounds 1 and 4). A retry never creates a new write once an
// earlier try wrote, or may have written, anything, so a reordered, reworded, split or repeated call cannot write a
// second time.
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

test("one more copy of a call than the first try made is refused; so is a new call once anything earlier was written", async () => {
  const { db, open } = setup();
  const write = keyedWrite();
  await (await open()).run(INTAKE, { product: "synthetic a" }, write.execute("A"));
  const retry = await open();
  assert.equal((await retry.run(INTAKE, { product: "synthetic a" }, write.execute("A"))).replayed, true);
  const extra = await retry.run(INTAKE, { product: "synthetic a" }, write.execute("A"));
  assert.equal(JSON.parse(extra.result).error, ops.REPEAT_ERROR);
  assert.equal(write.effects.size, 1);
  // A matched, and the model now asks for B: no stored plan says B was part of the first try, so it is refused.
  const b = await retry.run(INTAKE, { product: "synthetic b" }, write.execute("B"));
  assert.equal(JSON.parse(b.result).error, ops.FRESH_ERROR);
  assert.equal(JSON.parse(b.result).earlier_tool, INTAKE);
  assert.equal(b.receipt.status, "not_saved");
  // Asked again in the same try: refused again.
  assert.equal(JSON.parse((await retry.run(INTAKE, { product: "synthetic b" }, write.execute("B"))).result).error, ops.FRESH_ERROR);
  assert.equal(write.effects.size, 1);
  assert.equal(db.rows("chat_operations").length, 1, "the refused calls made no row");
  // B sent as a new message is a new request and writes.
  await (await open({ request: "22222222-2222-4222-8222-222222222222" })).run(INTAKE, { product: "synthetic b" }, write.execute("B"));
  assert.equal(write.effects.size, 2);
});

test("a stack replayed on a retry, followed by its products one by one, writes nothing more (SEC04-R1)", async () => {
  const { db, open } = setup();
  const write = keyedWrite();
  await (await open()).run(STACK, input(), write.execute());
  const retry = await open();
  let ran = 0;
  const count = (name) => async (opId) => { ran++; return write.execute(name)(opId); };
  const stack = await retry.run(STACK, input(), count("Synthetic Morning"));
  assert.equal(stack.replayed, true);
  const x = await retry.run(INTAKE, { product: "synthetic x" }, count("X"));
  const y = await retry.run(INTAKE, { product: "synthetic y" }, count("Y"));
  assert.equal(ran, 0, "nothing ran: the stack came from the ledger and its products were refused");
  for (const refused of [x, y]) {
    const forModel = JSON.parse(refused.result);
    assert.equal(forModel.error, ops.FRESH_ERROR);
    assert.equal(forModel.earlier_tool, STACK);
    assert.equal(forModel.earlier_result.stack, "Synthetic Morning");
    assert.equal(refused.receipt.status, "not_saved");
  }
  assert.equal(write.effects.size, 1, "one stack log, no single intakes");
  assert.equal(db.rows("chat_operations").length, 1);
});

test("a retry whose earlier try wrote nothing (no rows, or refused ones only) runs new calls as a first try would", async () => {
  const { db, store, open } = setup();
  await store.claimRequest(OWNER, REQUEST, CONVERSATION, randomUUID());
  await expireLeases(db);
  const write = keyedIntakeWrite();
  const retry = await open();
  assert.equal(retry.retry, true);
  assert.equal((await retry.run(INTAKE, { product: "synthetic a" }, write.execute("A"))).receipt.status, "saved");
  assert.equal((await retry.run(INTAKE, { product: "synthetic b" }, write.execute("B"))).receipt.status, "saved", "a second new call of the same try runs too");
  assert.equal(write.effects.size, 2);
});

test("a re-run whose answer is a refusal stays unknown, so a later retry still starts nothing new", async () => {
  const { db, store, open } = setup();
  await store.claimRequest(OWNER, REQUEST, CONVERSATION, randomUUID());
  // The first try claimed the stack call and stopped: it may have written.
  await store.claim({ owner_id: OWNER, request_id: REQUEST, tool: STACK, ordinal: 1 }, ops.intentSha(STACK, input()), input());
  await expireLeases(db);
  const refuse = async () => ({ failed: false, result: JSON.stringify({ error: 'No stack named "synthetic morning".' }) });
  const unsure = await (await open()).run(STACK, input(), refuse);
  assert.equal(JSON.parse(unsure.result).uncertain, true, "not 'not saved': the earlier write may exist");
  assert.equal(unsure.receipt.status, "unknown");
  assert.equal(db.rows("chat_operations")[0].status, "unknown");
  const write = keyedWrite();
  const fresh = await (await open()).run(INTAKE, { product: "synthetic x" }, write.execute("X"));
  assert.equal(JSON.parse(fresh.result).conflict, true);
  assert.equal(write.effects.size, 0);
});

test("a re-run gets the context the operation first ran with (its behavioral day), not the retry's", async () => {
  let failFinish = true;
  const { open } = setup({
    fail: ({ table, op, payload }) => (failFinish && table === "chat_operations" && op === "update" && payload && payload.status ? { code: "08006" } : null),
  });
  const seen = [];
  const checks = [];
  const execute = async (opId, context, check) => {
    seen.push(context.behavioral_today);
    checks.push(check);
    return { failed: false, result: JSON.stringify({ success: true, entry: { question: "Synthetic habit", answer: "Yes", cycle_date: context.behavioral_today } }) };
  };
  await (await open()).run("mark_habit_complete", { habit: "Synthetic habit" }, execute, { behavioral_today: "2030-01-01" });
  failFinish = false;
  const again = await (await open()).run("mark_habit_complete", { habit: "Synthetic habit" }, execute, { behavioral_today: "2030-01-02" });
  assert.deepEqual(seen, ["2030-01-01", "2030-01-01"], "the re-run after the day rolled over keeps the first day");
  assert.deepEqual(checks, [false, true], "the first run writes; the re-run of an unconfirmed habit answer only checks");
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

// ---------------------------------------------------------------------------
// Review round 5 (SEC-04): a refused call is a new write on a retry, a write removed since is never made again, and a
// playlist checks its key before Spotify is asked for anything. Synthetic ids and names only.
// ---------------------------------------------------------------------------

test("a call the first try refused is not run on a retry once another earlier call wrote (stack refused, its products logged)", async () => {
  const { db, open } = setup();
  const write = keyedWrite();
  const first = await open();
  // The stack call is refused (e.g. a transient lookup error read as a clean refusal); the model then logs the stack's
  // products one by one, which are written.
  await first.run(STACK, input(), async () => ({ failed: false, result: JSON.stringify({ error: "synthetic lookup refused" }) }));
  await first.run(INTAKE, { product: "synthetic x" }, write.execute("X"));
  await first.run(INTAKE, { product: "synthetic y" }, write.execute("Y"));
  assert.deepEqual(db.rows("chat_operations").map((r) => r.status), ["refused", "done", "done"]);

  // The retry asks for the stack again, which now would work: it would log X and Y a second time.
  const retry = await open();
  let ran = 0;
  const stack = await retry.run(STACK, input(), async (opId) => { ran++; return write.execute()(opId); });
  assert.equal(ran, 0, "the refused stack did not run: something earlier was written");
  const forModel = JSON.parse(stack.result);
  assert.equal(forModel.error, ops.FRESH_ERROR);
  assert.equal(forModel.conflict, true);
  assert.equal(forModel.earlier_tool, INTAKE);
  assert.equal(stack.receipt.status, "not_saved");
  // Asked again in the same try: refused again; the earlier products are still answered from the ledger.
  assert.equal(JSON.parse((await retry.run(STACK, input(), write.execute())).result).error, ops.FRESH_ERROR);
  assert.equal((await retry.run(INTAKE, { product: "synthetic x" }, write.execute("X"))).replayed, true);
  assert.equal(write.effects.size, 2, "X and Y once each, no stack");
  assert.deepEqual(db.rows("chat_operations").map((r) => r.status), ["refused", "done", "done"], "the refused row was not taken back");
});

test("a write removed since is settled: never written again, and its replay does not say 'already saved'", async () => {
  let failFinish = true;
  const { db, open } = setup({
    fail: ({ table, op, payload }) => (failFinish && table === "chat_operations" && op === "update" && payload && payload.status ? { code: "08006" } : null),
  });
  const write = keyedWrite();
  await (await open()).run(INTAKE, { product: "synthetic a" }, write.execute("A"));
  assert.equal(db.rows("chat_operations")[0].status, "pending", "written, but the ledger never recorded it");
  failFinish = false;
  // Riley removed the intake since: the keyed write finds its tombstone and writes nothing.
  const removed = JSON.stringify({ error: "synthetic removed since", removed_since: true });
  let ran = 0;
  const again = await (await open()).run(INTAKE, { product: "synthetic a" }, async () => { ran++; return { failed: false, result: removed }; });
  assert.equal(ran, 1, "re-run under the same key, which found the tombstone");
  assert.equal(ops.classifyOutcome({ failed: false, result: removed }), "done");
  assert.equal(again.receipt.status, "not_saved", "nothing is saved now");
  assert.equal(db.rows("chat_operations")[0].status, "done", "settled: a later retry never re-runs it");
  assert.equal(write.effects.size, 1);

  const later = await open();
  let ranLater = 0;
  const replay = await later.run(INTAKE, { product: "synthetic a" }, async () => { ranLater++; return { failed: false, result: removed }; });
  assert.equal(ranLater, 0, "answered from the ledger");
  const forModel = JSON.parse(replay.result);
  assert.equal(forModel.removed_since, true);
  assert.equal("note" in forModel, false, "not told to say it was already saved");
  // It still counts as an earlier write: a new call next to it is refused.
  const fresh = await later.run(INTAKE, { product: "synthetic b" }, write.execute("B"));
  assert.equal(JSON.parse(fresh.result).error, ops.FRESH_ERROR);
  assert.equal(JSON.parse(fresh.result).earlier_outcome, "removed_since");
  assert.equal(write.effects.size, 1);
});

test("a playlist from chat checks its key before Spotify is asked for anything", async () => {
  const KEY = "66666666-6666-4666-8666-666666666666";
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => { calls.push(String(url)); throw new Error("synthetic: no network in tests"); };
  try {
    const load = (db) => loadTs("lib/spotify-server.ts", { "@supabase/supabase-js": { createClient: () => db } });
    const args = { name: "Synthetic mix", trackIds: ["t1"], createdVia: "chat", clientKey: KEY };
    // The key column is missing (sql/chat_operations.sql not applied): refused as "not created", nothing asked of Spotify.
    const missing = createFakePostgrest({ fail: ({ table, op }) => (table === "spotify_playlists" && op === "select" ? { code: "42703" } : null) });
    await assert.rejects(load(missing).createPlaylist(args), /^Error: Spotify playlist key unavailable/);
    // A playlist is already logged under this key: never made a second time.
    const logged = createFakePostgrest({ tables: { spotify_playlists: [{ playlist_id: "pl9", client_key: KEY }] } });
    await assert.rejects(load(logged).createPlaylist(args), /already created for this request/);
    assert.deepEqual(calls, [], "Spotify was never called");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a keyed call left unfinished is re-run read-back only when another earlier call wrote; alone it re-runs as before", async () => {
  // A product logged, then a stack the first try could not confirm (it may or may not have written).
  const { db, open } = setup();
  const write = keyedWrite();
  const first = await open();
  await first.run(INTAKE, { product: "synthetic x" }, write.execute("X"));
  await first.run(STACK, input(), async () => ({ failed: false, result: JSON.stringify({ error: "The database did not confirm this.", incomplete: true }) }));
  assert.deepEqual(db.rows("chat_operations").map((r) => r.status), ["done", "unknown"]);
  const checks = [];
  const retry = await open();
  const stack = await retry.run(STACK, input(), async (opId, _ctx, check) => {
    checks.push(check);
    // In check mode the keyed write only reads back; its key holds nothing here, so it is unconfirmed.
    return check
      ? { failed: false, result: JSON.stringify({ error: ops.uncertainText(STACK), incomplete: true, uncertain: true }) }
      : write.execute()(opId);
  });
  assert.deepEqual(checks, [true], "read back only: X was written next to it");
  assert.equal(stack.receipt.status, "unknown");
  assert.equal(write.effects.size, 1, "the stack was not logged next to its products");

  // Alone (no other earlier write), an unfinished keyed call re-runs as a write under its own key.
  const solo = setup();
  await solo.store.claimRequest(OWNER, REQUEST, CONVERSATION, randomUUID());
  await solo.store.claim({ owner_id: OWNER, request_id: REQUEST, tool: STACK, ordinal: 1 }, ops.intentSha(STACK, input()), input());
  await expireLeases(solo.db);
  const soloChecks = [];
  const soloWrite = keyedWrite();
  await (await solo.open()).run(STACK, input(), async (opId, _ctx, check) => { soloChecks.push(check); return soloWrite.execute()(opId); });
  assert.deepEqual(soloChecks, [false]);
  assert.equal(soloWrite.effects.size, 1);
});

// ---------------------------------------------------------------------------
// Inside one try (review round 6): the calls of the try count like an earlier try's. While a call of the try is
// unconfirmed nothing new starts, and a keyed re-run of it next to another write of the try only reads back.
// ---------------------------------------------------------------------------
const unconfirmedStack = async () => ({ failed: false, result: JSON.stringify({ error: "The database did not confirm this.", incomplete: true }) });

test("in one try, an unconfirmed stack blocks its products one by one; once a re-run confirms it, new calls run again", async () => {
  const { db, open } = setup();
  const write = keyedWrite();
  const first = await open();
  assert.equal((await first.run(STACK, input(), unconfirmedStack)).receipt.status, "unknown");
  let ran = 0;
  const count = (name) => async (opId) => { ran++; return write.execute(name)(opId); };
  for (const product of ["synthetic x", "synthetic y"]) {
    const refused = await first.run(INTAKE, { product }, count(product));
    const forModel = JSON.parse(refused.result);
    assert.equal(forModel.error, ops.UNSETTLED_ERROR);
    assert.equal(forModel.earlier_tool, STACK);
    assert.equal(forModel.earlier_outcome, "unknown");
    assert.equal(refused.receipt.status, "not_saved");
  }
  assert.equal(ran, 0, "no product was logged next to a stack that may have been logged");
  assert.equal(db.rows("chat_operations").length, 1, "the refused calls made no row");
  // The model asks for the stack again: the same operation, re-run under its key (nothing else was written).
  const checks = [];
  const again = await first.run(STACK, input(), async (opId, _ctx, check) => { checks.push(check); return write.execute()(opId); });
  assert.deepEqual(checks, [false]);
  assert.equal(again.receipt.status, "saved");
  // Confirmed: the try is settled, so another call runs as usual.
  assert.equal((await first.run("mark_habit_complete", { habit: "Synthetic habit" }, async () => ({ failed: false, result: JSON.stringify({ success: true, entry: { question: "Synthetic habit", answer: "Yes", cycle_date: "2030-01-01" } }) }))).receipt.status, "saved");
  assert.deepEqual(db.rows("chat_operations").map((r) => [r.tool, r.status]), [[STACK, "done"], ["mark_habit_complete", "done"]]);
});

test("in one try, products logged then an unconfirmed stack asked again: the re-run only reads back, never logs the stack on top", async () => {
  const { db, open } = setup();
  const write = keyedWrite();
  const first = await open();
  await first.run(INTAKE, { product: "synthetic x" }, write.execute("X"));
  await first.run(INTAKE, { product: "synthetic y" }, write.execute("Y"));
  assert.equal((await first.run(STACK, input(), unconfirmedStack)).receipt.status, "unknown");
  const checks = [];
  const again = await first.run(STACK, input(), async (opId, _ctx, check) => {
    checks.push(check);
    return check
      ? { failed: false, result: JSON.stringify({ error: ops.uncertainText(STACK), incomplete: true, uncertain: true }) }
      : write.execute()(opId);
  });
  assert.deepEqual(checks, [true], "read back only: X and Y were written in this try");
  assert.equal(again.receipt.status, "unknown");
  assert.equal(write.effects.size, 2, "the stack was not logged next to its products");
  assert.deepEqual(db.rows("chat_operations").map((r) => r.status), ["done", "done", "unknown"]);
  // Still unconfirmed: nothing new starts in this try.
  assert.equal(JSON.parse((await first.run(INTAKE, { product: "synthetic z" }, write.execute("Z"))).result).error, ops.UNSETTLED_ERROR);
  assert.equal(write.effects.size, 2);
});

test("a retry whose earlier calls were all refused runs a repeated call twice, as a first try would", async () => {
  const { db, store, open } = setup();
  await store.claimRequest(OWNER, REQUEST, CONVERSATION, randomUUID());
  const { row } = await store.claim({ owner_id: OWNER, request_id: REQUEST, tool: INTAKE, ordinal: 1 }, ops.intentSha(INTAKE, { product: "synthetic a" }), { product: "synthetic a" });
  await store.finish(row, "refused", { error: "No product named that." }, null);
  await expireLeases(db);
  const write = keyedIntakeWrite();
  const retry = await open();
  assert.equal((await retry.run(INTAKE, { product: "synthetic a" }, write.execute("A"))).receipt.status, "saved");
  assert.equal((await retry.run(INTAKE, { product: "synthetic a" }, write.execute("A"))).receipt.status, "saved", "a second copy runs: nothing earlier was written");
  assert.equal(write.effects.size, 2);
  assert.deepEqual(db.rows("chat_operations").map((r) => [r.ordinal, r.status]), [[1, "done"], [2, "done"]]);
});

test("a retry that cannot read the ledger back for the earlier try's writes says so (null), never 'nothing was saved'", async () => {
  const state = { failList: false };
  const { open, errors } = setup({ fail: ({ table, op }) => (state.failList && table === "chat_operations" && op === "select" ? { code: "08006" } : null) });
  const write = keyedWrite();
  await (await open()).run(STACK, input(), write.execute());
  const retry = await open();
  assert.equal(retry.retry, true);
  assert.equal((await retry.earlierReceipts()).length, 1, "readable: the earlier write is listed");
  state.failList = true;
  assert.equal(await retry.earlierReceipts(), null, "unreadable: unknown, not an empty list");
  assert.deepEqual(errors.at(-1), ["list", "08006"]);
  // A first try has no earlier try: nothing to read, an empty list.
  const fresh = await (await setup()).open({ request: "33333333-3333-4333-8333-333333333333" });
  assert.deepEqual(plain(await fresh.earlierReceipts()), []);
});

test("abandoning an id that never reached the ledger refuses the request if it arrives late; one that arrived is not abandoned", async () => {
  const { db, store, open } = setup();
  const late = "44444444-4444-4444-8444-444444444444";
  // Not in the ledger: recorded as abandoned (no lease), and again when asked twice.
  assert.deepEqual(plain(await ops.abandonRequest(store, OWNER, late, receipts.buildWriteReceipt)), { status: "abandoned", receipts: [] });
  assert.deepEqual(plain(await ops.abandonRequest(store, OWNER, late, receipts.buildWriteReceipt)), { status: "abandoned", receipts: [] });
  const row = db.rows("chat_requests").filter((r) => r.request_id === late);
  assert.equal(row.length, 1);
  assert.equal(row[0].conversation_sha, ops.ABANDONED_CONVERSATION_SHA);
  assert.equal(row[0].lease_until, null);
  // The request itself arrives now: a conflict, so nothing runs under it.
  const arrived = await ops.openLedger(store, { ownerId: OWNER, requestId: late, conversationSha: CONVERSATION, buildReceipt: receipts.buildWriteReceipt });
  assert.equal(arrived.kind, "conflict");
  // Read back like any request: settled, nothing saved.
  assert.deepEqual(plain(await ops.requestOutcome(store, OWNER, late, receipts.buildWriteReceipt)), { status: "settled", receipts: [] });
  // A request that reached the ledger first is never abandoned: its account comes back instead, and it still replays.
  const write = keyedWrite();
  const firstTry = await open();
  await firstTry.run(STACK, input(), write.execute());
  await firstTry.release();
  const before = db.rows("chat_requests").find((r) => r.request_id === REQUEST).conversation_sha;
  const kept = plain(await ops.abandonRequest(store, OWNER, REQUEST, receipts.buildWriteReceipt));
  assert.equal(kept.status, "settled");
  assert.deepEqual(kept.receipts.map((r) => r.status), ["saved"]);
  assert.equal(db.rows("chat_requests").find((r) => r.request_id === REQUEST).conversation_sha, before);
  assert.equal((await open()).retry, true, "the request still replays");
  // Another owner's id is its own row.
  assert.equal((await ops.abandonRequest(store, OTHER_OWNER, REQUEST, receipts.buildWriteReceipt)).status, "abandoned");
  assert.equal(db.rows("chat_requests").find((r) => r.request_id === REQUEST && r.owner_id === OWNER).conversation_sha, before);
});

test("an abandon whose answer is lost or refused is a failure (the page keeps the id), never 'abandoned'", async () => {
  const id = "55555555-5555-4555-8555-555555555555";
  const lost = setup({ lose: ({ table, op }) => (table === "chat_requests" && op === "insert" ? { message: "fetch failed" } : null) });
  assert.equal((await ops.abandonRequest(lost.store, OWNER, id, receipts.buildWriteReceipt)).status, "failed");
  const missing = setup({ fail: ({ table }) => (table === "chat_requests" ? { code: "42P01" } : null) });
  assert.equal((await ops.abandonRequest(missing.store, OWNER, id, receipts.buildWriteReceipt)).status, "unavailable");
});

test("a removal and a keyed insert of the same operation take one lock, so a removed write never comes back (SQL)", () => {
  const sql = require("node:fs").readFileSync(require("node:path").join(__dirname, "../../sql/chat_operations.sql"), "utf8");
  const lock = "pg_advisory_xact_lock(hashtextextended('pds.chat_operation:' || k::text, 0))";
  const body = (fn) => new RegExp(String.raw`FUNCTION pds\.${fn}\(\)[\s\S]*?\$\$;`).exec(sql)?.[0] ?? "";
  // The insert guard waits for a running removal of the key BEFORE it looks for the tombstone.
  const guard = body("chat_operation_not_removed");
  assert.ok(guard.includes(lock) && guard.indexOf(lock) < guard.indexOf("chat_operation_tombstones t"), "lock, then the tombstone check");
  // The removal takes it before the row goes (BEFORE DELETE), on both keyed tables.
  assert.ok(body("chat_operation_lock_removed").includes(lock));
  for (const table of ["supplement_intake", "reading_sessions"]) {
    assert.match(sql, new RegExp(String.raw`TRIGGER ${table}_chat_lock\s+BEFORE DELETE ON pds\.${table}\s+FOR EACH ROW WHEN \(OLD\.client_(event_)?key IS NOT NULL\)\s+EXECUTE FUNCTION pds\.chat_operation_lock_removed`));
  }
  assert.ok(body("chat_operation_tombstone").includes(lock));
  assert.doesNotMatch(sql, /\bDROP\b/i, "applied through the Supabase MCP, which declines any DROP");
});

// ---------------------------------------------------------------------------
// Review round 9 (SEC-04): every row of a request is read back, never the first 200. Synthetic ids and names only.
// ---------------------------------------------------------------------------

/** `refused` refused calls, then one confirmed stack log, as an earlier try (or earlier tries) left them. */
function seedLongRequest(db, refused) {
  const at = (i) => new Date(Date.parse("2029-12-01T00:00:00.000Z") + i * 1000).toISOString();
  const row = (i, fields) => ({
    op_id: randomUUID(), owner_id: OWNER, request_id: REQUEST, context: null, receipt: null, created_at: at(i), updated_at: at(i), ...fields,
  });
  const rows = [];
  for (let i = 1; i <= refused; i++) {
    const intent = { product: `synthetic ${i}` };
    rows.push(row(i, { tool: INTAKE, ordinal: i, intent, intent_sha: ops.intentSha(INTAKE, intent), status: "refused", result: { error: "No product named that." } }));
  }
  rows.push(row(refused + 1, {
    tool: STACK, ordinal: 1, intent: input(), intent_sha: ops.intentSha(STACK, input()), status: "done",
    result: { success: true, stack: "Synthetic Morning", products: 2, total_doses: 3, date: "2030-01-01" },
  }));
  db.seed("chat_operations", rows);
}

test("a request with more than 200 operations is read back in full: a write after the 200th row still blocks new calls", async () => {
  for (const maxRows of [undefined, 50]) {
    // maxRows = a PostgREST max-rows cap smaller than one page: the listing advances by what came back, skipping nothing.
    const { db, store, open } = setup(maxRows ? { maxRows } : {});
    await store.claimRequest(OWNER, REQUEST, CONVERSATION, randomUUID());
    await expireLeases(db);
    seedLongRequest(db, 250);
    assert.equal((await store.listForRequest(OWNER, REQUEST)).length, 251);
    const write = keyedWrite();
    const retry = await open();
    assert.equal(retry.retry, true);
    const fresh = await retry.run(INTAKE, { product: "synthetic new" }, write.execute("New"));
    const forModel = JSON.parse(fresh.result);
    assert.equal(forModel.conflict, true, "the stack log past row 200 counts as written");
    assert.equal(forModel.earlier_tool, STACK);
    assert.equal(forModel.earlier_outcome, "saved");
    assert.equal(fresh.receipt.status, "not_saved");
    assert.equal(write.effects.size, 0, "nothing ran next to the earlier write");
    const earlier = await retry.earlierReceipts();
    assert.deepEqual(earlier.map((r) => r.status), ["unchanged"], "the earlier stack log is listed");
    const outcome = plain(await ops.requestOutcome(store, OWNER, REQUEST, receipts.buildWriteReceipt));
    assert.deepEqual(outcome.receipts.map((r) => r.status), ["saved"]);
  }
});

test("a listing that cannot reach the row count fails closed: no new write, the earlier account is unknown", async () => {
  const { db, store, open, errors } = setup({ maxRows: 0 });
  await store.claimRequest(OWNER, REQUEST, CONVERSATION, randomUUID());
  await expireLeases(db);
  seedLongRequest(db, 3);
  await assert.rejects(store.listForRequest(OWNER, REQUEST), (e) => e instanceof ops.LedgerFailure && e.code === "list_incomplete");
  const write = keyedWrite();
  const retry = await open();
  const fresh = await retry.run(INTAKE, { product: "synthetic new" }, write.execute("New"));
  assert.equal(JSON.parse(fresh.result).error, ops.LEDGER_ERROR);
  assert.equal(write.effects.size, 0);
  assert.equal(await retry.earlierReceipts(), null, "unknown, never 'nothing was saved'");
  assert.deepEqual(errors.at(-1), ["list", "list_incomplete"]);
  assert.equal((await ops.requestOutcome(store, OWNER, REQUEST, receipts.buildWriteReceipt)).status, "failed");
});

test("addHighlight insert_only (check-mode recovery) never updates a highlight that already has the passage", async () => {
  const R = loadTs("lib/reading.ts");
  const KEY = "22222222-2222-4222-8222-222222222222";
  const at = "2030-01-01T00:00:00.000Z";
  const db = createFakePostgrest({
    unique: { book_highlights: [["book_id", "passage"], ["client_key"]] },
    defaults: { book_highlights: (now, seq) => ({ highlight_id: seq, archived: false, notion_block_id: null, created_at: now(), updated_at: now() }) },
    tables: {
      books: [{ book_id: 3, slug: "synthetic-book", status: "reading" }],
      book_highlights: [{ highlight_id: 100, book_id: 3, passage: "A synthetic line.", comment: "An earlier note.", chapter: 2, concept: null, archived: false, client_key: null, created_at: at, updated_at: at }],
    },
  });
  const base = { book_id: 3, comment: "Chat note.", chapter: 5, date: "2030-01-01", client_key: KEY, insert_only: true };
  const clash = await R.addHighlight(db, { ...base, passage: "A synthetic line." });
  assert.deepEqual(plain(clash), { ok: false, error: R.HIGHLIGHT_EXISTS });
  const kept = db.rows("book_highlights").find((h) => h.highlight_id === 100);
  assert.equal(kept.comment, "An earlier note.");
  assert.equal(kept.chapter, 2);
  // No highlight has the passage: created by one insert, with the key.
  const made = await R.addHighlight(db, { ...base, passage: "A new synthetic line." });
  assert.equal(made.ok, true);
  assert.equal(made.created, true);
  assert.equal(db.rows("book_highlights").find((h) => h.passage === "A new synthetic line.").client_key, KEY);
  // The same key again (a copy of this call): its own highlight is read back, never written twice.
  const again = await R.addHighlight(db, { ...base, passage: "Yet another synthetic line." });
  assert.equal(again.ok, true);
  assert.equal(again.readBack, true);
  assert.equal(db.rows("book_highlights").length, 2);
  // insert_only needs a key.
  assert.equal((await R.addHighlight(db, { ...base, client_key: null, passage: "Unkeyed synthetic line." })).ok, false);
});

test("storedContext: a retry reads the context the same call first ran with; a first try, another call or a refused one gets null", async () => {
  const { open } = setup();
  const write = keyedWrite();
  const first = await open();
  assert.equal(await first.storedContext(STACK, input()), null, "a first try has no earlier context");
  await first.run(STACK, input(), write.execute(), { behavioral_today: "2030-01-01", book_id: 7 });

  const retry = await open();
  assert.equal(retry.retry, true);
  assert.deepEqual(plain(await retry.storedContext(STACK, input())), { behavioral_today: "2030-01-01", book_id: 7 });
  assert.equal(await retry.storedContext(STACK, input("Another Synthetic")), null, "another call has no stored context");
  // Reading it runs nothing and claims nothing: the call still resolves to its stored result.
  const again = await retry.run(STACK, input(), write.execute());
  assert.equal(again.replayed, true);
  assert.equal(write.effects.size, 1);
});

test("question-bank answers and flags are keyed re-runs, matched by question and reply, never by the model's own grade wording (READ-QUIZ-01 S6)", () => {
  assert.ok(ops.RERUN_SAFE.has("record_reading_answer") && ops.RERUN_SAFE.has("flag_reading_question"));
  const call = { question_id: 1201, version: 2, answer: "The fog bell", verdict: "correct", feedback: "Right." };
  // The grade and the feedback are the model's wording: a retry that words them differently is the same call.
  assert.equal(ops.intentSha("record_reading_answer", call), ops.intentSha("record_reading_answer", { ...call, verdict: "partial", feedback: "Close." }));
  assert.equal(ops.intentSha("record_reading_answer", call), ops.intentSha("record_reading_answer", { ...call, feedback: undefined, verdict: "incorrect" }));
  // The question, its version and the reply are what the call asks for: a numeric string is the same number.
  assert.equal(ops.intentSha("record_reading_answer", call), ops.intentSha("record_reading_answer", { ...call, question_id: "1201", version: "2" }));
  for (const other of [{ question_id: 1202 }, { version: 3 }, { answer: "The horn" }]) {
    assert.notEqual(ops.intentSha("record_reading_answer", call), ops.intentSha("record_reading_answer", { ...call, ...other }));
  }
  // The same question flagged another way is another call.
  assert.notEqual(ops.intentSha("flag_reading_question", { question_id: 1201, kind: "wrong" }), ops.intentSha("flag_reading_question", { question_id: 1201, kind: "unclear" }));
  // An unconfirmed one never reads "check the quiz result".
  for (const tool of ["record_reading_answer", "flag_reading_question"]) {
    assert.match(ops.uncertainText(tool), /\/reading/);
    assert.notEqual(ops.uncertainText(tool), ops.uncertainText("log_supplement_intake"));
  }
});
