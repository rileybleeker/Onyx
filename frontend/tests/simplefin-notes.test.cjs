// Run: node --test tests/simplefin-notes.test.cjs
// SEC-07: SimpleFIN heartbeat text is an allowlist. simplefin_etl.py writes only "wording [code]" segments from
// NOTE_CODES; lib/finance-status.ts re-renders every SimpleFIN heartbeat from those codes alone before the /status
// card, the /status sync history or the /financials freshness line shows it. This file checks the two tables
// agree, that provider text (names, emails, URLs, short and long ids) never survives the re-rendering, and that
// the status route applies it to the card and to the history.
// SYNTHETIC DATA ONLY. No network, no credentials, no database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs, SRC } = require("./helpers/load-ts.cjs");

const S = loadTs("lib/finance-status.ts");
// Normalized: a Windows checkout (core.autocrlf) has CRLF line ends, which the line-anchored regexes below miss.
const ETL = fs.readFileSync(path.join(SRC, "..", "..", "simplefin_etl.py"), "utf8").replace(/\r\n/g, "\n");

const PII = ["Demo Bank", "Jane Q Example", "jane@example.com", "https://bank.example.com/login?u=42", "www.demo-bank.example", "12345678", "acct 42", "ACT-0042"];
const piiMsg = (i = 0) => `Reconnect ${PII[0]} for ${PII[1]} <${PII[2]}> at ${PII[3]} (${PII[4]}) account ${PII[5]} / ${PII[6]} / ${PII[7]} #${i}`;
const assertNoPii = (text) => {
  for (const s of PII) assert.ok(!String(text).includes(s), `provider text leaked: ${s} in ${text}`);
};

test("the allowlist in lib/finance-status.ts is NOTE_CODES in simplefin_etl.py, same order, same wording", () => {
  const block = ETL.match(/^NOTE_CODES: dict\[str, str\] = \{\n([\s\S]*?)\n\}/m);
  assert.ok(block, "NOTE_CODES block found");
  const py = block[1].split("\n").map((line) => {
    const m = line.match(/^ {4}"([a-z][a-z0-9_]*)": "([^"\\]*)",$/);
    assert.ok(m, `one entry per line, double quotes, no escapes: ${line}`);
    return [m[1], m[2]];
  });
  assert.deepEqual(Object.entries(S.SIMPLEFIN_NOTES), py);
  assert.equal(Number(ETL.match(/^NOTE_LIMIT = (\d+)/m)[1]), S.SIMPLEFIN_NOTE_LIMIT);
  assert.equal(Number(ETL.match(/^NOTE_MAX_COUNT = (\d+)/m)[1]), 9999);
});

test("a note written by the ETL is shown exactly as written", () => {
  const one = S.formatSimplefinNotes({ sf_reauth: 1 });
  assert.equal(one, `${S.SIMPLEFIN_NOTES.sf_reauth} [sf_reauth]`);
  assert.equal(S.safeSimplefinNote(one), one);
  const two = S.formatSimplefinNotes({ account_unmatched: 2, sf_reauth: 1 });
  assert.equal(two, `${S.SIMPLEFIN_NOTES.sf_reauth} [sf_reauth]; ${S.SIMPLEFIN_NOTES.account_unmatched} [account_unmatched x2]`);
  assert.equal(S.safeSimplefinNote(two), two);
  // Every code at once: the later ones are tokens only, and the round trip is still exact.
  const every = S.formatSimplefinNotes(Object.fromEntries(Object.keys(S.SIMPLEFIN_NOTES).map((c) => [c, 3])));
  for (const c of Object.keys(S.SIMPLEFIN_NOTES)) assert.ok(every.includes(`[${c} x3]`), c);
  assert.match(every, /; also \[/);
  assert.equal(S.safeSimplefinNote(every), every);
  assert.equal(S.formatSimplefinNotes({}), null);
  assert.equal(S.formatSimplefinNotes({ nope: 4 }), null);
});

test("provider text, names, emails, URLs and ids never survive; unknown or malformed text is a generic note", () => {
  for (const raw of [
    piiMsg(),
    `SimpleFIN: ${piiMsg(1)}`,
    `one ${PII[0]} account was not imported: could not be matched uniquely`,
    "SimpleFIN refused the Access URL",
    "[not_a_code] [SF_REAUTH] [sf_reauth x99999] [sf_reauth x-1] [ sf_reauth ]",
    "x".repeat(5000),
  ]) {
    const shown = S.safeSimplefinNote(raw);
    assert.equal(shown, S.SIMPLEFIN_UNREADABLE_NOTE, raw.slice(0, 60));
    assertNoPii(shown);
  }
  // Codes mixed into provider text: only the allowlisted wording is shown, counts are summed and capped.
  const mixed = `${piiMsg(2)} [sf_reauth] ${PII[2]} [sf_reauth x2] [account_unmatched x9999] [account_unmatched x9999] [bogus]`;
  const shown = S.safeSimplefinNote(mixed);
  assert.equal(shown, S.formatSimplefinNotes({ sf_reauth: 3, account_unmatched: 9999 }));
  assertNoPii(shown);
  for (const empty of [null, undefined, "", "   ", 42, {}, ["[sf_reauth]"]]) assert.equal(S.safeSimplefinNote(empty), null);
});

test("history rows: SimpleFIN text is re-rendered, other sources are untouched", () => {
  const sfRow = { source: "simplefin", data_type: "transactions", status: "partial", error_message: piiMsg() };
  assert.equal(S.withSafeSimplefinNote(sfRow).error_message, S.SIMPLEFIN_UNREADABLE_NOTE);
  assert.equal(sfRow.error_message, piiMsg(), "the input row is not mutated");
  const other = { source: "garmin", data_type: "full_sync", status: "partial", error_message: "No wearable data" };
  assert.equal(S.withSafeSimplefinNote(other), other);
});

test("the card: free text in a failed heartbeat is never shown; an empty failed heartbeat says so plainly", () => {
  const now = Date.parse("2030-03-15T12:00:00Z");
  const beat = (over) => ({ status: "success", sync_start: new Date(now - 3_600_000).toISOString(), records_synced: 1, duration_seconds: 1, error_message: null, ...over });
  const leaked = S.simplefinLedgerCard(beat({ status: "failed", error_message: piiMsg() }), beat(), now);
  assert.equal(leaked.status, "failed");
  assert.equal(leaked.errorMessage, S.SIMPLEFIN_UNREADABLE_NOTE);
  const coded = S.simplefinLedgerCard(beat({ status: "partial", error_message: S.formatSimplefinNotes({ sf_reauth: 1 }) }), beat(), now);
  assert.equal(coded.status, "partial");
  assert.equal(coded.errorMessage, S.formatSimplefinNotes({ sf_reauth: 1 }));
  assert.equal(S.simplefinLedgerCard(beat({ status: "failed" }), beat(), now).errorMessage, "The latest transactions import failed (no error text recorded).");
  // SimpleFIN thresholds: 14 h degraded, 30 h red.
  const old = (h) => beat({ sync_start: new Date(now - h * 3_600_000).toISOString() });
  assert.equal(S.simplefinLedgerCard(old(13), old(13), now).status, "success");
  assert.equal(S.simplefinLedgerCard(old(15), old(1), now).status, "partial");
  assert.equal(S.simplefinLedgerCard(old(31), old(31), now).status, "failed");
});

function fakeSupabase(beats, history) {
  const from = (table) => {
    const q = { table, eq: {} };
    const b = {
      select() { return b; },
      eq(col, val) { q.eq[col] = val; return b; },
      not() { return b; },
      gte() { return b; },
      or() { return b; },
      order() { return b; },
      limit() { return b; },
      then(resolve, reject) {
        let data = [];
        if (table === "sync_log" && q.eq.source === "simplefin") data = beats[q.eq.data_type] ? [beats[q.eq.data_type]] : [];
        else if (table === "sync_log" && !q.eq.source) data = history.filter((r) => !q.eq.data_type || r.data_type === q.eq.data_type);
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return b;
  };
  return { from };
}

test("/api/status: the SimpleFIN card and the sync history carry only allowlisted wording", async () => {
  const at = (h) => new Date(Date.now() - h * 3_600_000).toISOString();
  const row = (over) => ({ source: "simplefin", data_type: "transactions", status: "partial", sync_start: at(1), records_synced: 3, duration_seconds: 2, error_message: piiMsg(), ...over });
  const beats = { transactions: row({}), balances: row({ data_type: "balances" }) };
  const history = [
    row({ sync_start: at(1) }),
    row({ data_type: "balances", sync_start: at(1) }),
    row({ status: "partial", sync_start: at(7), error_message: `${S.formatSimplefinNotes({ sf_reauth: 1 })} ${PII[2]}` }),
    { source: "garmin", data_type: "full_sync", status: "partial", sync_start: at(2), records_synced: 1, duration_seconds: 1, error_message: "No wearable data" },
  ];
  const client = fakeSupabase(beats, history);
  const route = loadTs("app/api/status/route.ts", {
    "@supabase/supabase-js": { createClient: () => client },
    "next/server": { NextResponse: { json: (body, init) => ({ status: (init && init.status) || 200, body }) } },
    "@/lib/nyc": { getNycScoutFreshness: async () => ({ lastVerified: null, liveCount: 0 }) },
  });
  const res = await route.GET();
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
  const card = res.body.sources.simplefin;
  assert.equal(card.status, "partial");
  assert.equal(card.errorMessage, S.SIMPLEFIN_UNREADABLE_NOTE);
  const sfHistory = res.body.recentHistory.filter((r) => r.source === "simplefin");
  assert.equal(sfHistory.length, 3);
  assert.deepEqual(sfHistory.map((r) => r.error_message), [S.SIMPLEFIN_UNREADABLE_NOTE, S.SIMPLEFIN_UNREADABLE_NOTE, S.formatSimplefinNotes({ sf_reauth: 1 })]);
  assert.equal(res.body.recentHistory.find((r) => r.source === "garmin").error_message, "No wearable data", "other sources keep their text");
  // Nothing anywhere in the response carries the provider text.
  assertNoPii(JSON.stringify(res.body));
});
