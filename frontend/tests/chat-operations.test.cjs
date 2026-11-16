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
  const open = async ({ owner = OWNER, request = REQUEST, conversation = CONVERSATION, reconcilers } = {}) => {
    const opened = await ops.openLedger(store, {
      ownerId: owner,
      requestId: request,
      conversationSha: conversation,
      buildReceipt: receipts.buildWriteReceipt,
      reconcilers,
      onError: (stage, code) => errors.push([stage, code]),
    });
    assert.equal(opened.kind, "ledger");
    return opened.ledger;
  };
  return { db, store, open, errors };
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
  await store.claimRequest(OWNER, REQUEST, CONVERSATION);
  const sha = ops.intentSha(STACK, input());
  await store.claim({ owner_id: OWNER, request_id: REQUEST, tool: STACK, ordinal: 1 }, sha, input());
  const write = keyedWrite();
  const again = await (await open()).run(STACK, input(), write.execute());
  assert.equal(write.effects.size, 1);
  assert.equal(again.replayed, false);
  assert.equal(again.receipt.status, "saved");
  assert.equal(db.rows("chat_operations")[0].status, "done");
});

test("two tries of one message at the same moment still write once", async () => {
  const { open } = setup();
  const write = keyedWrite();
  const [a, b] = await Promise.all([open(), open()]);
  const results = await Promise.all([a.run(STACK, input(), write.execute()), b.run(STACK, input(), write.execute())]);
  assert.equal(write.effects.size, 1);
  assert.ok(results.every((r) => r.receipt.status === "saved"));
});

test("a retry that asks for different details in the same place is refused and shows what the first try saved", async () => {
  const { open } = setup();
  const write = keyedWrite();
  const first = await (await open()).run(STACK, input("synthetic morning"), write.execute("Synthetic Morning"));
  let ran = 0;
  const conflict = await (await open()).run(STACK, input("synthetic evening"), async () => { ran++; return { failed: false, result: "{}" }; });
  assert.equal(ran, 0);
  assert.equal(write.effects.size, 1);
  const forModel = JSON.parse(conflict.result);
  assert.equal(forModel.conflict, true);
  assert.equal(forModel.error, ops.CONFLICT_ERROR);
  assert.equal(forModel.earlier_result.stack, "Synthetic Morning");
  assert.deepEqual(plain(conflict.receipt.details), [...plain(first.receipt.details), ops.CONFLICT_DETAIL]);
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

test("a call the first try refused (nothing written) runs again on the retry", async () => {
  const { db, open } = setup();
  const refused = await (await open()).run(STACK, input("synthetic evening"), async () => ({ failed: false, result: JSON.stringify({ error: 'No stack named "synthetic evening".' }) }));
  assert.equal(refused.receipt.status, "not_saved");
  assert.equal(db.rows("chat_operations")[0].status, "refused");
  const write = keyedWrite();
  // The model picks the right stack this time: the refused place is free for it.
  const again = await (await open()).run(STACK, input("synthetic morning"), write.execute());
  assert.equal(write.effects.size, 1);
  assert.equal(again.receipt.status, "saved");
  assert.equal(db.rows("chat_operations").length, 1);
  assert.equal(db.rows("chat_operations")[0].status, "done");
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
  assert.equal(await store.claimRequest(OWNER, REQUEST, CONVERSATION), "new");
  assert.equal(await store.claimRequest(OWNER, REQUEST, CONVERSATION), "retry");
  const other = ops.conversationSha([{ role: "user", content: "Log my other synthetic stack" }]);
  assert.equal(await store.claimRequest(OWNER, REQUEST, other), "conflict");
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

  // The audit row exists (the first try did create it): the retry confirms it from there.
  const opRow = db.rows("chat_operations")[0];
  db.seed("spotify_playlists", [
    { playlist_id: "old", name: call.name, created_via: "chat", spotify_url: "https://open.spotify.com/playlist/old", track_count: 2, created_at: "2029-12-01T00:00:00.000Z" },
    { playlist_id: "pl1", name: call.name, created_via: "chat", spotify_url: "https://open.spotify.com/playlist/pl1", track_count: 2, created_at: opRow.created_at },
  ]);
  const found = await (await open({ reconcilers })).run(PLAYLIST, call, create);
  assert.equal(creates, 1, "still one create call in total");
  assert.equal(found.replayed, true);
  assert.equal(found.receipt.status, "saved");
  assert.equal(found.receipt.link.href, "https://open.spotify.com/playlist/pl1", "the older playlist with the same name is not taken for it");
  assert.equal(db.rows("chat_operations")[0].status, "done");

  // From now on it is a plain replay.
  const later = await (await open({ reconcilers: {} })).run(PLAYLIST, call, create);
  assert.equal(later.replayed, true);
  assert.equal(creates, 1);
});

test("a quiz result left pending is confirmed from pds.reading_quizzes, never recorded twice", async () => {
  const { db, store, open } = setup();
  const QUIZ = "record_reading_quiz";
  const call = { checkpoint: "ch12", score: 4, total: 5 };
  await store.claimRequest(OWNER, REQUEST, CONVERSATION);
  const { row } = await store.claim({ owner_id: OWNER, request_id: REQUEST, tool: QUIZ, ordinal: 1 }, ops.intentSha(QUIZ, call), call);
  let records = 0;
  const record = async () => { records++; return { failed: false, result: JSON.stringify({ success: true }) }; };
  const reconcilers = ops.supabaseReconcilers(db);
  const unsure = await (await open({ reconcilers })).run(QUIZ, call, record);
  assert.equal(records, 0);
  assert.equal(unsure.receipt.status, "unknown");
  db.seed("reading_quizzes", [{ quiz_id: 9, checkpoint: "ch12", score: 4, total: 5, quiz_date: "2030-01-01", taken_at: row.created_at }]);
  const found = await (await open({ reconcilers })).run(QUIZ, call, record);
  assert.equal(records, 0);
  assert.equal(found.receipt.status, "saved");
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
  for (const text of [ops.CONFLICT_ERROR, ops.LEDGER_ERROR]) assert.ok(text.length <= 240);
});
