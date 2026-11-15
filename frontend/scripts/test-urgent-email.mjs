// Offline unit tests for the Today "Urgent email" rules and query (no network, no credentials).
//   cd frontend && node scripts/test-urgent-email.mjs        (Node 22.18+ strips the TypeScript types itself)
// Every email below is invented; addresses use the reserved example domains.
import assert from "node:assert/strict";
import { register } from "node:module";

// Let the query module's "@/lib/..." imports resolve to src/lib/*.ts outside Next.
register(
  "data:text/javascript," +
    encodeURIComponent(
      `export async function resolve(spec, ctx, next) {
         if (spec.startsWith("@/")) return next(new URL("../src/" + spec.slice(2) + ".ts", ${JSON.stringify(import.meta.url)}).href, ctx);
         return next(spec, ctx);
       }`,
    ),
);

const rules = await import("../src/lib/urgent-email.ts");
const { getUrgentEmail, getUrgentEmailStatusCard, SCAN_LIMIT, WINDOW_DAYS: WINDOW_DAYS_Q } = await import("../src/lib/urgent-email-query.ts");
const {
  assessEmail, selectUrgent, daysUntilDeadline, domainMatches, gmailMessageHref, isGmailHref,
  MAX_URGENT_SHOWN, WINDOW_DAYS, URGENT_THRESHOLD, PRIORITY_SENDER_DOMAINS,
  parseGmailLink, isEmailCard, mergeUrgent, ageLabel, parseWorkerTime,
} = rules;

// Wednesday 2026-11-11, 10:00 Eastern.
const NOW = new Date("2026-11-11T15:00:00Z");
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3_600_000).toISOString();
let seq = 0;
const mail = (over = {}) => ({
  id: String(++seq),
  fromName: "Sender",
  fromAddress: "someone@example.com",
  subject: "Hello",
  snippet: null,
  receivedAt: hoursAgo(2),
  isUnread: true,
  ...over,
});

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`ok   ${name}`); }
  catch (e) { failures.push(name); console.log(`FAIL ${name}\n     ${e.message}`); }
}

// ---- Keyword rules ----------------------------------------------------------------
await test("plain conversation is not urgent", () => {
  const r = assessEmail(mail({ subject: "Lunch on Friday?", snippet: "Want to try the new place?" }), NOW);
  assert.equal(r.urgent, false);
  assert.equal(r.score, 0);
  assert.deepEqual(r.reasons, []);
});

await test("a payment failure is urgent and says why", () => {
  const r = assessEmail(mail({ subject: "Your payment failed", fromAddress: "billing@example.com" }), NOW);
  assert.equal(r.urgent, true);
  assert.equal(r.reasons[0], "payment problem");
});

await test("security alert is urgent", () => {
  const r = assessEmail(mail({ subject: "Security alert: unusual sign-in to your account" }), NOW);
  assert.equal(r.urgent, true);
  assert.ok(r.reasons.includes("security or fraud alert"));
});

await test("'action required' and overdue notices are urgent", () => {
  assert.equal(assessEmail(mail({ subject: "Action required: sign the lease addendum" }), NOW).urgent, true);
  assert.equal(assessEmail(mail({ subject: "Final notice: invoice 1042" }), NOW).urgent, true);
  assert.equal(assessEmail(mail({ subject: "Your invoice is past due" }), NOW).urgent, true);
});

await test("one medium phrase alone is not urgent, two are", () => {
  assert.equal(assessEmail(mail({ subject: "Please confirm your details" }), NOW).urgent, false);
  const both = assessEmail(mail({ subject: "Time sensitive: confirm your details" }), NOW);
  assert.equal(both.score, 4);
  assert.equal(both.urgent, true);
});

await test("a lone 'reminder' is below the threshold", () => {
  const r = assessEmail(mail({ subject: "Reminder: team lunch" }), NOW);
  assert.equal(r.score, 1);
  assert.equal(r.urgent, false);
});

await test("snippet text counts, not only the subject", () => {
  const r = assessEmail(mail({ subject: "Your account", snippet: "Your payment was declined by the bank." }), NOW);
  assert.equal(r.urgent, true);
});

await test("keyword points are capped so stuffing cannot run away", () => {
  const r = assessEmail(mail({ subject: "URGENT final notice: payment failed, fraud alert, account suspended, deadline" }), NOW);
  assert.equal(r.score, 6, "five strong phrases and a medium one are worth exactly the content cap of 6");
  assert.equal(r.reasons.length, 3);
  // The cap covers phrases only; a real, dated deadline still adds its own 3 on top.
  const dated = assessEmail(mail({ subject: "URGENT final notice: payment failed, fraud alert, account suspended, due tomorrow" }), NOW);
  assert.equal(dated.score, 9);
});

await test("'Your payment to X failed' phrasings are a payment problem", () => {
  for (const subject of [
    "Your payment to Example Utilities failed",
    "Payment to Example Landlord was declined",
    "Your payment to Example Insurance has been returned",
    "Failed payment on your account",
    "Payment failure notice",
    "We couldn't charge your card: card declined",
  ]) {
    const r = assessEmail(mail({ subject }), NOW);
    assert.equal(r.urgent, true, subject);
    assert.ok(r.reasons.includes("payment problem"), subject);
  }
});

await test("successful or unrelated payment mail is not a payment problem", () => {
  for (const subject of [
    "Your payment to Example Utilities was successful",
    "Payment to Example Landlord processed",
    "Receipt for your payment",
    "Payment received, thank you",
    "Failed to load? Our app update fixes it",
  ]) {
    const r = assessEmail(mail({ subject }), NOW);
    assert.equal(r.urgent, false, subject);
    assert.ok(!r.reasons.includes("payment problem"), subject);
  }
});

await test("rent, mortgage and tuition due or late are urgent", () => {
  for (const subject of ["Rent due", "Your rent is due", "Rent payment is now due", "Mortgage payment due", "Tuition overdue", "Late rent notice", "Property taxes are due"]) {
    const r = assessEmail(mail({ subject }), NOW);
    assert.equal(r.urgent, true, subject);
  }
  assert.ok(assessEmail(mail({ subject: "Rent due" }), NOW).reasons.includes("rent or loan payment due"));
  for (const subject of ["Rent receipt for October", "Renters insurance quote", "Parent night: dues and donations", "Your rent was paid"]) {
    assert.equal(assessEmail(mail({ subject }), NOW).urgent, false, subject);
  }
});

// ---- Promotional damping -----------------------------------------------------------
await test("promotional mail with urgent words is not urgent", () => {
  assert.equal(assessEmail(mail({ subject: "URGENT: 50% off sale ends today" }), NOW).urgent, false);
  assert.equal(assessEmail(mail({ subject: "Last chance: final notice for our newsletter giveaway" }), NOW).urgent, false);
  assert.equal(assessEmail(mail({ fromAddress: "newsletter@example.com", subject: "Action required: read this week's digest" }), NOW).urgent, false);
});

await test("the promotional veto never hides a fraud, payment or account-security alert", () => {
  for (const subject of [
    "Suspicious charge at Big Sale Outlet",
    "Unauthorized transaction: Example Deals Inc",
    "Fraud alert: 50% off is not why we are writing",
    "Your payment to Weekly Digest Co failed",
    "Account suspended: confirm to get free shipping",
  ]) {
    assert.equal(assessEmail(mail({ subject }), NOW).urgent, true, subject);
  }
  // Even from a marketing-looking sender.
  assert.equal(assessEmail(mail({ fromAddress: "offers@example.com", subject: "Suspicious sign-in to your account" }), NOW).urgent, true);
  // The exception is narrow: overdue/deadline/urgent wording does not lift the veto.
  assert.equal(assessEmail(mail({ subject: "Final notice: sale ends today, due tomorrow" }), NOW).urgent, false);
  assert.equal(assessEmail(mail({ fromAddress: "offers@example.com", subject: "Action required: rent due" }), NOW).urgent, false);
});

await test("a marketing footer in the snippet does not hide a real alert", () => {
  const r = assessEmail(mail({ subject: "Unauthorized transaction on your card", snippet: "Unsubscribe | view in browser | shop now" }), NOW);
  assert.equal(r.urgent, true);
});

// ---- Sender rules ------------------------------------------------------------------
await test("billing/security local-parts add a small boost, never enough alone", () => {
  const alone = assessEmail(mail({ fromAddress: "billing@example.com", subject: "Your statement is ready" }), NOW);
  assert.equal(alone.urgent, false);
  assert.equal(alone.score, 1);
  const withDeadline = assessEmail(mail({ fromAddress: "billing@example.com", subject: "Payment due tomorrow" }), NOW);
  assert.equal(withDeadline.urgent, true);
});

await test("domainMatches accepts subdomains and rejects lookalikes", () => {
  assert.equal(domainMatches("example.com", "example.com"), true);
  assert.equal(domainMatches("mail.example.com", "example.com"), true);
  assert.equal(domainMatches("MAIL.Example.COM", "example.com"), true);
  assert.equal(domainMatches("evilexample.com", "example.com"), false);
  assert.equal(domainMatches("example.com.evil.net", "example.com"), false);
  assert.equal(domainMatches("example.com", ""), false);
});

await test("no priority senders are configured by default", () => {
  assert.deepEqual([...PRIORITY_SENDER_DOMAINS], []);
});

// ---- Deadlines ---------------------------------------------------------------------
const recv = (iso) => new Date(iso);

await test("'due today' / 'due tomorrow' resolve against the day it was received", () => {
  const monday = recv("2026-11-09T18:00:00Z");
  assert.equal(daysUntilDeadline("Rent is due tomorrow", monday, NOW), -1);   // Tue Nov 10: already passed
  assert.equal(daysUntilDeadline("Rent is due tomorrow", recv("2026-11-11T13:00:00Z"), NOW), 1);
  assert.equal(daysUntilDeadline("Form due today", recv("2026-11-11T13:00:00Z"), NOW), 0);
});

await test("a week-old 'due tomorrow' does not score as a live deadline", () => {
  const r = assessEmail(mail({ subject: "Form due tomorrow", receivedAt: hoursAgo(24 * 5) }), NOW);
  assert.ok(!r.reasons.some((x) => x.startsWith("deadline")));
});

await test("month-day dates use Eastern days; no year picks the nearest future one", () => {
  assert.equal(daysUntilDeadline("Reply by Nov 13", recv(hoursAgo(2)), NOW), 2);
  assert.equal(daysUntilDeadline("due November 12th", recv(hoursAgo(2)), NOW), 1);
  assert.equal(daysUntilDeadline("due Nov 11, 2026", recv(hoursAgo(2)), NOW), 0);
  assert.equal(daysUntilDeadline("due 11/18", recv(hoursAgo(2)), NOW), 7);
  assert.equal(daysUntilDeadline("due 11/18/26", recv(hoursAgo(2)), NOW), 7);
});

await test("late-night Eastern edge: 02:00 UTC is still the previous Eastern day", () => {
  const lateNow = new Date("2026-11-12T02:00:00Z"); // 9 pm ET on Nov 11
  assert.equal(daysUntilDeadline("due Nov 11", recv("2026-11-11T20:00:00Z"), lateNow), 0);
});

await test("a December email naming a January date rolls into the next year", () => {
  const decNow = new Date("2026-12-29T15:00:00Z");
  assert.equal(daysUntilDeadline("due Jan 3", recv("2026-12-28T15:00:00Z"), decNow), 5);
});

await test("impossible dates are ignored", () => {
  assert.equal(daysUntilDeadline("due Feb 30", recv(hoursAgo(2)), NOW), null);
  assert.equal(daysUntilDeadline("due 13/45", recv(hoursAgo(2)), NOW), null);
});

await test("weekday and 'expires in N hours/days' deadlines", () => {
  assert.equal(daysUntilDeadline("submit by Friday", recv(hoursAgo(2)), NOW), 2);   // Fri Nov 13
  assert.equal(daysUntilDeadline("expires in 12 hours", recv(hoursAgo(2)), NOW), 0); // 12h after Wed 10:00 ET = Wed 22:00 ET
  assert.equal(daysUntilDeadline("expires in 3 days", recv(hoursAgo(2)), NOW), 3);
  assert.equal(daysUntilDeadline("nothing dated here", recv(hoursAgo(2)), NOW), null);
});

await test("earliest upcoming deadline wins; passed ones are ignored when a live one exists", () => {
  assert.equal(daysUntilDeadline("due Nov 9 (extended: due Nov 14)", recv(hoursAgo(2)), NOW), 3);
});

await test("a near deadline makes an otherwise ordinary email urgent; a far one does not", () => {
  const near = assessEmail(mail({ subject: "Contract paperwork due tomorrow" }), NOW);
  assert.equal(near.urgent, true);
  assert.ok(near.reasons.includes("deadline tomorrow"));
  const week = assessEmail(mail({ subject: "Survey due Nov 17" }), NOW);
  assert.equal(week.urgent, false);
  assert.ok(week.reasons.includes("deadline in 6 days"));
});

// ---- Selection ---------------------------------------------------------------------
await test("selectUrgent skips read, old, future-dated and malformed mail", () => {
  const urgentSubject = "Action required: verify your account";
  const emails = [
    mail({ subject: urgentSubject }),
    mail({ subject: urgentSubject, isUnread: false }),
    mail({ subject: urgentSubject, receivedAt: hoursAgo(24 * (WINDOW_DAYS + 1)) }),
    mail({ subject: urgentSubject, receivedAt: new Date(NOW.getTime() + 3 * 86_400_000).toISOString() }),
    mail({ subject: urgentSubject, receivedAt: "not a date" }),
  ];
  const out = selectUrgent(emails, NOW);
  assert.equal(out.items.length, 1);
  assert.equal(out.total, 1);
  assert.equal(out.scanned, 1);
});

await test("result is bounded and ordered by score, then newest, then id", () => {
  const emails = [];
  for (let i = 0; i < 12; i++) emails.push(mail({ id: `b${i}`, subject: "Payment failed", receivedAt: hoursAgo(10 + i) }));
  emails.push(mail({ id: "top", subject: "Final notice: payment failed", receivedAt: hoursAgo(100) }));
  const out = selectUrgent(emails, NOW);
  assert.equal(out.items.length, MAX_URGENT_SHOWN);
  assert.equal(out.total, 13);
  assert.equal(out.scanned, 13);
  assert.equal(out.items[0].email.id, "top");
  assert.deepEqual(out.items.slice(1).map((x) => x.email.id), ["b0", "b1", "b2", "b3"]);
  const tie = selectUrgent([mail({ id: "z", subject: "Payment failed" }), mail({ id: "a", subject: "Payment failed" })].map((m) => ({ ...m, receivedAt: hoursAgo(5) })), NOW);
  assert.deepEqual(tie.items.map((x) => x.email.id), ["a", "z"]);
});

await test("limit is respected and never negative", () => {
  const emails = [mail({ subject: "Payment failed" }), mail({ subject: "Payment failed" })];
  assert.equal(selectUrgent(emails, NOW, 1).items.length, 1);
  assert.equal(selectUrgent(emails, NOW, 0).items.length, 0);
  assert.equal(selectUrgent(emails, NOW, -3).items.length, 0);
  assert.equal(selectUrgent(emails, NOW, 1).total, 2);
});

await test("empty input is a valid empty answer", () => {
  assert.deepEqual(selectUrgent([], NOW), { scanned: 0, total: 0, items: [] });
});

await test("scoring is deterministic", () => {
  const e = mail({ subject: "Action required: payment due tomorrow", fromAddress: "billing@example.com" });
  assert.deepEqual(assessEmail(e, NOW), assessEmail(e, NOW));
  assert.ok(assessEmail(e, NOW).score >= URGENT_THRESHOLD);
});

// ---- Gmail links -------------------------------------------------------------------
await test("gmailMessageHref builds a mail.google.com search by Message-ID", () => {
  assert.equal(
    gmailMessageHref("me@example.com", "<abc+1@mail.example.com>"),
    "https://mail.google.com/mail/?authuser=me%40example.com#search/rfc822msgid%3Aabc%2B1%40mail.example.com",
  );
  assert.equal(gmailMessageHref("not-an-address", "id@x.example"), "https://mail.google.com/mail/?authuser=0#search/rfc822msgid%3Aid%40x.example");
  assert.equal(gmailMessageHref(null, "id@x.example")?.includes("authuser=0"), true);
});

await test("gmailMessageHref refuses unusable ids and cannot be steered off Gmail", () => {
  assert.equal(gmailMessageHref("me@example.com", ""), null);
  assert.equal(gmailMessageHref("me@example.com", "   "), null);
  assert.equal(gmailMessageHref("me@example.com", "has space@x"), null);
  assert.equal(gmailMessageHref("me@example.com", "x".repeat(501)), null);
  const nasty = gmailMessageHref("me@example.com&authuser=9", "a#b&c=d@x");
  assert.ok(nasty && isGmailHref(nasty));
  assert.equal(new URL(nasty).origin, "https://mail.google.com");
  assert.ok(!nasty.includes("&c=d"), "ampersands in the id must be encoded");
  assert.equal(isGmailHref("https://evil.example/mail/"), false);
  assert.equal(isGmailHref("javascript:alert(1)"), false);
});

// ---- Query: inbox-triage labels from pds.inbox_emails (fake client, no database) ------
// The fake records every filter so the tests can check what is read, and answers the
// inbox_emails and sync_log reads separately.
function fakeClient({ rows = [], error = null, beat = null, beatError = null, cleared = [], clearedError = null } = {}) {
  const calls = [];
  const from = (table) => {
    const call = { table, filters: [], orders: [] };
    calls.push(call);
    const chain = {
      select(c) { call.columns = c; return chain; },
      eq(col, v) { call.filters.push(["eq", col, v]); return chain; },
      gte(col, v) { call.filters.push(["gte", col, v]); return chain; },
      lte(col, v) { call.filters.push(["lte", col, v]); return chain; },
      order(col, o) { call.orders.push([col, o]); return chain; },
      limit(n) {
        call.limit = n;
        return Promise.resolve(table === "sync_log"
          ? { data: beat ? [beat] : [], error: beatError }
          : table === "today_cleared_emails"
            ? { data: clearedError ? null : cleared, error: clearedError }
            : { data: error ? null : rows, error });
      },
    };
    return chain;
  };
  return { client: { from }, calls };
}
const ACCT = "owner@example.com";
const row = (over = {}) => ({
  account: ACCT, message_id: `m${++seq}@mail.example.com`, received_at: hoursAgo(3),
  from_name: "Example Sender", from_address: "sender@example.com", subject: "Please reply",
  snippet: null, is_unread: true, gmail_thread_id: `10000000000000${String(seq).padStart(5, "0")}`,
  agent_labels: ["Agent/Action"], in_inbox: true, last_seen_at: hoursAgo(1), ...over,
});
const BEAT = { sync_start: hoursAgo(0.5), status: "success", error_message: null };

await test("a missing table or column means 'not connected', not an error", async () => {
  for (const code of ["PGRST205", "42P01", "42703"]) {
    const { client } = fakeClient({ error: { code, message: "relation does not exist" } });
    assert.deepEqual(await getUrgentEmail(client, NOW), { status: "not_connected" });
  }
});

await test("any other database error is an error, without the detail", async () => {
  const { client } = fakeClient({ error: { code: "XX000", message: "boom with details" } });
  await assert.rejects(() => getUrgentEmail(client, NOW), (e) => e.message.includes("XX000") && !e.message.includes("details"));
});

await test("reads only labelled rows in the window, bounded, deterministic order, no body columns", async () => {
  const { client, calls } = fakeClient({ beat: BEAT });
  await getUrgentEmail(client, NOW);
  const q = calls.find((c) => c.table === "inbox_emails");
  assert.deepEqual(q.filters.find((f) => f[0] === "eq"), ["eq", "labeled", true]);
  assert.deepEqual(q.filters.find((f) => f[0] === "gte"), ["gte", "received_at", new Date(NOW.getTime() - WINDOW_DAYS_Q * 86_400_000).toISOString()]);
  assert.deepEqual(q.filters.find((f) => f[0] === "lte"), ["lte", "received_at", new Date(NOW.getTime() + rules.FUTURE_SKEW_MS).toISOString()],
    "future-dated junk cannot use up the row cap");
  assert.equal(q.limit, SCAN_LIMIT);
  assert.deepEqual(q.orders.map((o) => o[0]), ["received_at", "message_id"], "a secondary sort keeps ties stable");
  assert.ok(!/body|html|attachment/.test(q.columns));
  const s = calls.find((c) => c.table === "sync_log");
  assert.deepEqual(s.filters, [["eq", "source", "urgent_email"], ["eq", "data_type", "labels"]]);
});

await test("a thread cleared on Today is left out and counted until a newer message arrives", async () => {
  const { clearKeyHash } = await import("../src/lib/today-clear.ts");
  const keep = row({ subject: "Still here" });
  const gone = row({ subject: "Cleared one", received_at: hoursAgo(5) });
  const back = row({ subject: "Cleared, then replied", received_at: hoursAgo(1) });
  const key = (r) => `thread:${ACCT}:${r.gmail_thread_id}`;
  const cleared = [
    { key_hash: await clearKeyHash(key(gone)), cleared_through: gone.received_at },
    { key_hash: await clearKeyHash(key(back)), cleared_through: hoursAgo(2) },   // cleared before the newest message
  ];
  const { client, calls } = fakeClient({ rows: [keep, gone, back], beat: BEAT, cleared });
  const out = await getUrgentEmail(client, NOW);
  assert.deepEqual(out.items.map((i) => i.subject).sort(), ["Cleared, then replied", "Still here"]);
  assert.deepEqual([out.scanned, out.total, out.hidden, out.cleared], [3, 2, 0, 1]);
  const q = calls.find((c) => c.table === "today_cleared_emails");
  assert.equal(q.columns, "key_hash,cleared_through");
  assert.deepEqual(q.filters, [["gte", "cleared_through", new Date(NOW.getTime() - WINDOW_DAYS_Q * 86_400_000).toISOString()]]);
  assert.deepEqual(q.orders.map((o) => o[0]), ["cleared_through", "key_hash"]);
});

await test("a failed read of the clear marks (or no table yet) shows everything", async () => {
  const rows = [row(), row()];
  for (const clearedError of [{ code: "PGRST205" }, { code: "XX000" }]) {
    const out = await getUrgentEmail(fakeClient({ rows, beat: BEAT, cleared: [], clearedError }).client, NOW);
    assert.deepEqual([out.total, out.cleared], [2, 0]);
  }
});

await test("an empty table answers ready with nothing to show and the last sync", async () => {
  const { client } = fakeClient({ beat: BEAT });
  const out = await getUrgentEmail(client, NOW);
  assert.equal(out.status, "ready");
  assert.deepEqual([out.scanned, out.total, out.hidden, out.items.length], [0, 0, 0, 0]);
  assert.deepEqual(out.lastSync, { at: BEAT.sync_start, status: "success", error: null });
  const never = await getUrgentEmail(fakeClient().client, NOW);
  assert.equal(never.lastSync, null, "before the first run there is no sync line");
});

await test("one item per thread even when both labels sit on different messages of it", async () => {
  const thread = "1000000000000000777";
  const rows = [
    row({ gmail_thread_id: thread, agent_labels: ["Agent/Action"], received_at: hoursAgo(30), subject: "Lease question" }),
    row({ gmail_thread_id: thread, agent_labels: ["Agent/Deadline"], received_at: hoursAgo(2), subject: "Re: Lease question, reply by Nov 12" }),
  ];
  const out = await getUrgentEmail(fakeClient({ rows, beat: BEAT }).client, NOW);
  assert.equal(out.scanned, 1);
  assert.equal(out.items.length, 1);
  assert.deepEqual(out.items[0].labels, ["Agent/Action", "Agent/Deadline"]);
  assert.equal(out.items[0].subject, "Re: Lease question, reply by Nov 12", "newest message names the thread");
  assert.equal(out.items[0].deadline.daysLeft, 1);
  assert.equal(out.items[0].href, `https://mail.google.com/mail/?authuser=owner%40example.com#all/thread-f:${thread}`);
});

await test("stale items stay off Today: passed deadlines, archived threads, old Action, old undated Deadline", async () => {
  const rows = [
    row({ agent_labels: ["Agent/Deadline"], subject: "Ballot closes Nov 9", received_at: hoursAgo(24 * 5) }),     // passed
    row({ agent_labels: ["Agent/Action"], in_inbox: false }),                                                      // archived
    row({ agent_labels: ["Agent/Action"], received_at: hoursAgo(24 * 20) }),                                       // too old
    row({ agent_labels: ["Agent/Deadline"], subject: "Appointment details", received_at: hoursAgo(24 * 6) }),     // undated, old
    row({ agent_labels: ["Agent/Deadline"], subject: "Renewal due Nov 30", received_at: hoursAgo(5) }),            // > 7 days out
    row({ agent_labels: ["Agent/Deadline"], subject: "Form", snippet: "The window closes in 48 hours.", received_at: hoursAgo(4) }),
  ];
  const out = await getUrgentEmail(fakeClient({ rows, beat: BEAT }).client, NOW);
  assert.equal(out.scanned, 6);
  assert.equal(out.total, 1);
  assert.equal(out.hidden, 5);
  assert.equal(out.items[0].subject, "Form");
  assert.equal(out.items[0].deadline.daysLeft, 2);
  assert.ok(out.items[0].reasons[0].startsWith("Deadline in 2 days"));
  assert.ok(!JSON.stringify(out).includes("closes in 48 hours"), "the snippet never leaves the server");
});

await test("deadlines first (soonest first), then Action, each with a next step", async () => {
  const rows = [
    row({ agent_labels: ["Agent/Action"], subject: "Question from a friend", received_at: hoursAgo(1) }),
    row({ agent_labels: ["Agent/Deadline"], subject: "Bill due Nov 14", received_at: hoursAgo(10) }),
    row({ agent_labels: ["Agent/Deadline"], subject: "RSVP by tomorrow", received_at: hoursAgo(8) }),
  ];
  const out = await getUrgentEmail(fakeClient({ rows, beat: BEAT }).client, NOW);
  assert.deepEqual(out.items.map((i) => i.subject), ["RSVP by tomorrow", "Bill due Nov 14", "Question from a friend"]);
  assert.ok(out.items[0].nextStep.includes("Thu, Nov 12"));
  assert.ok(out.items[2].nextStep.startsWith("Reply or decide"));
  assert.ok(out.items.every((i) => i.reasons.length > 0));
});

await test("malformed rows are skipped, not fatal", async () => {
  const rows = [null, { message_id: "x" }, row({ received_at: "not a date" }), row({ from_address: null }), row({ subject: "Kept" })];
  const out = await getUrgentEmail(fakeClient({ rows, beat: BEAT }).client, NOW);
  assert.equal(out.scanned, 1);
  assert.equal(out.items[0].subject, "Kept");
});

await test("a failed heartbeat read only drops the sync line", async () => {
  const out = await getUrgentEmail(fakeClient({ rows: [row()], beatError: { code: "XX000" } }).client, NOW);
  assert.equal(out.lastSync, null);
  assert.equal(out.items.length, 1);
});

// ---- /status card ---------------------------------------------------------------------
await test("status card: unknown before the first run, then heartbeat age and run status", async () => {
  const card = async (beat, beatError = null) => (await getUrgentEmailStatusCard(fakeClient({ beat, beatError }).client, NOW)).status;
  assert.equal(await card(null), "unknown");
  assert.equal(await card({ sync_start: hoursAgo(1), status: "success" }), "success");
  assert.equal(await card({ sync_start: hoursAgo(3.5), status: "success" }), "partial");
  assert.equal(await card({ sync_start: hoursAgo(9), status: "success" }), "failed");
  assert.equal(await card({ sync_start: hoursAgo(1), status: "partial" }), "partial");
  assert.equal(await card({ sync_start: hoursAgo(1), status: "failed" }), "failed");
  assert.equal(await card(null, { code: "XX000", message: "down" }), "failed");
  const full = await getUrgentEmailStatusCard(fakeClient({ beat: { sync_start: hoursAgo(1), status: "partial", records_synced: 4, error_message: "label Agent/Action missing" } }).client, NOW);
  assert.deepEqual([full.label, full.recordsSynced, full.errorMessage], ["Urgent Email", 4, "label Agent/Action missing"]);
});

// ---- Today merge: labels + Agent Inbox, each thing once ------------------------------
const emailItem = (over = {}) => ({
  key: `thread:${ACCT}:${++seq}`, threadId: `20000000000000${String(seq).padStart(5, "0")}`, messageId: `e${seq}@mail.example.com`,
  account: ACCT, from: "Sender", subject: `Email ${seq}`, receivedAt: hoursAgo(5), labels: ["Agent/Action"],
  deadline: null, reasons: ["inbox-triage marked it Agent/Action (needs a reply or decision)"],
  nextStep: "Reply or decide in Gmail", href: `https://mail.google.com/mail/?authuser=owner%40example.com#all/thread-f:20000000000000${String(seq).padStart(5, "0")}`, ...over,
});
const card = (over = {}, cardOver = {}) => ({
  kind: "card", thread: "inbox-triage", messageId: ++seq, created_at: "2026-11-11 13:00:00",
  card: { code: `C${seq}`, agent: "inbox-triage", type: "question", name: "Urgent: check a sign-in", details: "", link: "", expires: null, updated: false, ...cardOver },
  ...over,
});

await test("parseGmailLink reads account + thread from both Gmail link forms and rejects others", () => {
  assert.deepEqual(parseGmailLink("https://mail.google.com/mail/?authuser=Owner@Example.com#all/thread-f:1234567890123456789"),
    { account: "owner@example.com", threadId: "1234567890123456789" });
  assert.deepEqual(parseGmailLink("https://mail.google.com/mail/?authuser=owner@example.com#all/thread-f:42|msg-f:43"),
    { account: "owner@example.com", threadId: "42" });
  // hex API/web id = the same 64-bit number as thread-f (synthetic 0x18c2a4b1d3e5f607)
  assert.equal(parseGmailLink("https://mail.google.com/mail/u/0/#inbox/18c2a4b1d3e5f607").threadId, "1784169486063367687");
  assert.deepEqual(parseGmailLink("https://mail.google.com/mail/?authuser=owner@example.com#search/password+reset"),
    { account: "owner@example.com", threadId: null });
  assert.equal(parseGmailLink("https://evil.example/mail/#all/thread-f:1"), null);
  assert.equal(parseGmailLink("https://mail.google.com.evil.example/mail/#all/thread-f:1"), null);
  assert.equal(parseGmailLink(""), null);
  assert.equal(parseGmailLink(null), null);
});

await test("isEmailCard: inbox-triage 'Urgent:' questions or a Gmail link; other cards stay in Needs your input", () => {
  assert.equal(isEmailCard(card().card), true);
  assert.equal(isEmailCard(card({}, { name: "Unsubscribe list", link: "https://app.notion.example/p/1" }).card), false);
  assert.equal(isEmailCard(card({}, { agent: "coordinator", name: "Urgent: Onyx down" }).card), false);
  assert.equal(isEmailCard(card({}, { agent: "coordinator", name: "Pay the bill", link: "https://mail.google.com/mail/?authuser=owner@example.com#all/thread-f:9" }).card), true);
  assert.equal(isEmailCard({ code: "x", agent: "Planning assistant", name: "Review a plan" }), false, "fixture cards without a link");
});

await test("a card linking a labelled thread merges into that email: one item, both sources, both links", () => {
  const e = emailItem({ deadline: { daysLeft: 1, label: "Thu, Nov 12" }, labels: ["Agent/Deadline"], nextStep: "Handle it in Gmail by Thu, Nov 12" });
  const c = card({}, { name: "Urgent: ballot closes tomorrow", link: `https://mail.google.com/mail/?authuser=${ACCT}#all/thread-f:${e.threadId}` });
  const out = mergeUrgent([e], [c]);
  assert.equal(out.total, 1);
  const [item] = out.items;
  assert.deepEqual(item.sources, ["Gmail", "Agent Inbox"]);
  assert.ok(item.reasons[0].includes("ballot closes tomorrow"));
  assert.ok(item.nextStep.startsWith("Answer the request, then handle it"));
  assert.equal(item.gmailHref, e.href);
  assert.equal(item.requestHref, `/agents?t=inbox-triage#m${c.messageId}`);
  assert.equal(item.atVerb, "Received");
});

await test("each merged item says what a Clear removes: its cards and its threads, twins included", () => {
  const e = emailItem();
  const c = card({}, { name: "Urgent: reply today", link: `https://mail.google.com/mail/?authuser=${ACCT}#all/thread-f:${e.threadId}` });
  const again = card({ messageId: 999 }, { code: "Q77", name: "Urgent: reply today (again)", link: c.card.link });
  const twin = emailItem({ account: "second@example.com", messageId: e.messageId.toUpperCase() });
  const alone = card({ messageId: 1000 }, { code: "Z9", name: "Urgent: other thing", link: "https://mail.google.com/mail/?authuser=owner@example.com#search/other+thing" });
  const out = mergeUrgent([e, twin], [c, again, alone]);
  const merged = out.items.find((i) => i.key === `email:${e.key}`);
  assert.deepEqual(merged.clear.cards, [c.card.code.toUpperCase(), "Q77"], "a second card on the same thread is cleared with it");
  assert.deepEqual(merged.clear.emails, [{ key: e.key, receivedAt: e.receivedAt }, { key: twin.key, receivedAt: twin.receivedAt }],
    "the copy in the other mailbox is cleared too, so it does not take the item's place");
  const solo = out.items.find((i) => i.key === "card:Z9");
  assert.deepEqual(solo.clear, { cards: ["Z9"], emails: [] });
});

await test("same thread id in another mailbox does not merge; same Message-ID in both mailboxes does", () => {
  const e = emailItem();
  const other = card({}, { link: `https://mail.google.com/mail/?authuser=second@example.com#all/thread-f:${e.threadId}` });
  assert.equal(mergeUrgent([e], [other]).total, 2);
  const twin = emailItem({ account: "second@example.com", messageId: e.messageId.toUpperCase() });
  const out = mergeUrgent([e, twin], []);
  assert.equal(out.total, 1);
  assert.ok(out.items[0].reasons.includes("Also in second@"));
});

const SEARCH = (words, acct = ACCT) => `https://mail.google.com/mail/?authuser=${acct}#search/${words}`;

await test("gmailSearchWords: lowercases, drops operators, null for thread and non-Gmail links", () => {
  const { gmailSearchWords } = rules;
  assert.deepEqual(gmailSearchWords(SEARCH("Invoice+Overdue+from%3Abilling%40example.com+newer_than%3A2d+label:Agent")), ["invoice", "overdue"]);
  assert.deepEqual(gmailSearchWords(SEARCH("Renew%20Plan++now")), ["renew", "plan", "now"]);
  assert.equal(gmailSearchWords(`https://mail.google.com/mail/?authuser=${ACCT}#all/thread-f:42`), null);
  assert.equal(gmailSearchWords("https://evil.example/mail/#search/a+b"), null);
  assert.equal(gmailSearchWords(null), null);
});

await test("a #search card merges into the one labelled email holding every word (same account, within 7 days)", () => {
  const e = emailItem({ subject: "Invoice 42 is overdue, please pay", receivedAt: "2026-11-11T10:00:00.000Z" });
  const noise = emailItem({ subject: "Weekly digest", receivedAt: "2026-11-11T09:00:00.000Z" });
  const c = card({}, { name: "Urgent: invoice overdue", link: SEARCH("Invoice+overdue") });
  const out = mergeUrgent([e, noise], [c]);
  assert.equal(out.total, 2);
  const item = out.items.find((i) => i.key === `email:${e.key}`);
  assert.deepEqual(item.sources, ["Gmail", "Agent Inbox"]);
  assert.ok(item.reasons[0].includes("invoice overdue"));
  assert.ok(item.nextStep.startsWith("Answer the request, then reply"));
  assert.equal(item.requestHref, `/agents?t=inbox-triage#m${c.messageId}`);
  // 6 days 23 h before the card still counts
  const old = emailItem({ subject: "Invoice overdue", receivedAt: "2026-11-04T14:00:00.000Z" });
  assert.equal(mergeUrgent([old], [c]).total, 1);
});

await test("a #search card stays separate: missing word, ambiguous, other account, wrong time window", () => {
  const link = SEARCH("Invoice+overdue");
  const c = card({}, { link });
  const base = { subject: "Invoice overdue", receivedAt: "2026-11-11T10:00:00.000Z" };
  assert.equal(mergeUrgent([emailItem({ ...base, subject: "Invoice due soon" })], [c]).total, 2, "word missing");
  assert.equal(mergeUrgent([emailItem({ subject: "Invoicer overdue" })], [c]).total, 2, "whole words only");
  assert.equal(mergeUrgent([emailItem(base), emailItem({ ...base, subject: "Re: Invoice overdue" })], [c]).total, 3, "ambiguous");
  assert.equal(mergeUrgent([emailItem({ ...base, account: "second@example.com" })], [card({}, { link })]).total, 2, "other account");
  assert.equal(mergeUrgent([emailItem({ ...base, receivedAt: "2026-11-11T14:00:00.000Z" })], [c]).total, 2, "received after the card");
  assert.equal(mergeUrgent([emailItem({ ...base, receivedAt: "2026-11-04T12:00:00.000Z" })], [c]).total, 2, "more than 7 days before");
  assert.equal(mergeUrgent([emailItem(base)], [card({}, { link: SEARCH("from%3Abilling%40example.com") })]).total, 2, "operators only");
});

// A search word may also sit in the sender's display name (the brand is often only there).
const total = (emails, link, cardOver = {}) => mergeUrgent(emails, [card({}, { link, ...cardOver })]).total;

await test("gmailSearchTerms: words, phrases, subject:/from:, exclusions; other operators and OR/AND dropped", () => {
  const { gmailSearchTerms } = rules;
  const any = (w, negated = false) => ({ field: "any", words: [w], negated });
  assert.deepEqual(gmailSearchTerms(SEARCH("Examplia+Card%20paused")), [any("examplia"), any("card"), any("paused")]);
  assert.deepEqual(gmailSearchTerms(SEARCH('"card+paused"+-refund+-"final+notice"')), [
    { field: "any", words: ["card", "paused"], negated: false }, any("refund", true),
    { field: "any", words: ["final", "notice"], negated: true },
  ]);
  assert.deepEqual(gmailSearchTerms(SEARCH('from%3AExamplia+From:(card+team)+from:"Examplia+Bank"+subject:paused+-subject:(a+b)')), [
    { field: "from", words: ["examplia"], negated: false },
    { field: "from", words: ["card"], negated: false }, { field: "from", words: ["team"], negated: false },
    { field: "from", words: ["examplia", "bank"], negated: false },
    { field: "subject", words: ["paused"], negated: false },
    { field: "subject", words: ["a"], negated: true }, { field: "subject", words: ["b"], negated: true },
  ]);
  assert.deepEqual(gmailSearchTerms(SEARCH('paused+newer_than:2d+label:"agent+action"+in:anywhere+is:unread+has:attachment+to:(a+b)+rfc822msgid:x1@mail.example.com+re:+-label:x')),
    [any("paused")], "operators that say nothing about subject or sender go, value included");
  assert.deepEqual(gmailSearchTerms(SEARCH("{card+OR+loan}+AND+(paused)+or")), [any("card"), any("loan"), any("paused"), any("or")],
    "OR/AND are dropped and every word stays required; a lowercase 'or' is a word");
  assert.deepEqual(gmailSearchTerms(SEARCH("")), []);
  assert.equal(gmailSearchTerms(`https://mail.google.com/mail/?authuser=${ACCT}#all/thread-f:42`), null);
  assert.equal(gmailSearchTerms("https://evil.example/mail/#search/a+b"), null);
});

await test("a #search card merges when its words are only in the sender's display name", () => {
  const e = emailItem({ from: "Examplia Card Support", subject: "Your statement is ready" });
  const noise = emailItem({ from: "Another Sender", subject: "Your statement is ready" });
  const c = card({}, { name: "Urgent: Examplia support wrote", link: SEARCH("Examplia+support") });
  const out = mergeUrgent([e, noise], [c]);
  assert.equal(out.total, 2);
  const item = out.items.find((i) => i.key === `email:${e.key}`);
  assert.deepEqual(item.sources, ["Gmail", "Agent Inbox"]);
  assert.equal(item.requestHref, `/agents?t=inbox-triage#m${c.messageId}`);
  assert.deepEqual(out.items.find((i) => i.key === `email:${noise.key}`).sources, ["Gmail"]);
});

await test("a #search card merges when its words are split across the subject and the sender name", () => {
  const e = emailItem({ from: "Examplia Rewards Team", subject: "Your loyalty card was paused - action needed" });
  assert.equal(total([e], SEARCH("Examplia+loyalty+card")), 1, "brand in the sender, the rest in the subject");
  assert.equal(total([e], SEARCH("examplia+LOYALTY+card+card")), 1, "case and repeats do not matter");
  assert.equal(total([e], SEARCH("Examplia+loyalty+card+refund")), 2, "a word in neither stays unmatched");
  assert.equal(total([emailItem({ from: "Exampliabank Rewards", subject: e.subject })], SEARCH("Examplia+loyalty+card")), 2, "whole words only in the sender too");
  assert.equal(total([emailItem({ from: null, subject: e.subject })], SEARCH("Examplia+loyalty+card")), 2, "no sender at all");
});

await test("sender-name matches keep the safeties: two candidates, other account and the time window never merge", () => {
  const link = SEARCH("Examplia+loyalty+card");
  const base = { from: "Examplia Rewards Team", subject: "Your loyalty card was paused", receivedAt: "2026-11-11T10:00:00.000Z" };
  assert.equal(total([emailItem(base)], link), 1);
  assert.equal(total([emailItem(base), emailItem({ ...base, subject: "A new loyalty card is on its way" })], link), 3, "two from the same sender");
  assert.equal(total([emailItem(base), emailItem({ from: "Someone Else", subject: "Examplia loyalty card question" })], link), 3,
    "one matches through its sender, one through its subject alone: still ambiguous");
  assert.equal(total([emailItem({ ...base, account: "second@example.com" })], link), 2, "other account");
  assert.equal(total([emailItem({ ...base, account: "second@example.com" }), emailItem(base)], link), 2, "the other account's twin is not a second candidate");
  assert.equal(total([emailItem({ ...base, receivedAt: "2026-11-11T14:00:00.000Z" })], link), 2, "received after the card");
  assert.equal(total([emailItem({ ...base, receivedAt: "2026-11-04T12:00:00.000Z" })], link), 2, "more than 7 days before");
});

await test("sender address: with no display name a plain word may match the domain, never the local part or the last label", () => {
  const nameless = { from: "billing@mail.examplia.example", subject: "Your loyalty card was paused" };
  assert.equal(total([emailItem(nameless)], SEARCH("examplia+card")), 1, "domain label");
  assert.equal(total([emailItem(nameless)], SEARCH("billing+card")), 2, "local part is too generic");
  assert.equal(total([emailItem(nameless)], SEARCH("example+card")), 2, "last label (TLD)");
  assert.equal(total([emailItem(nameless)], SEARCH("from:billing@mail.examplia.example+card")), 1, "a from: term names the whole address");
  // With a display name the address never reaches the browser, so only the name counts.
  const named = { from: "Jordan Example", subject: "Your loyalty card was paused" };
  assert.equal(total([emailItem(named)], SEARCH("from:jordan+card")), 1);
  assert.equal(total([emailItem(named)], SEARCH("from:billing@mail.examplia.example+card")), 2);
});

await test("subject:, from:, phrases and exclusions narrow the match; operator-only and exclusion-only links never merge", () => {
  const e = { from: "Examplia Rewards Team", subject: "Your loyalty card was paused" };
  assert.equal(total([emailItem(e)], SEARCH("subject:loyalty+from:examplia")), 1);
  assert.equal(total([emailItem(e)], SEARCH("subject:examplia+loyalty")), 2, "subject: does not look at the sender");
  assert.equal(total([emailItem(e)], SEARCH("from:loyalty+examplia")), 2, "from: does not look at the subject");
  assert.equal(total([emailItem(e)], SEARCH('"loyalty+card"+examplia')), 1, "phrase in order");
  assert.equal(total([emailItem(e)], SEARCH('"card+loyalty"+examplia')), 2, "phrase out of order");
  assert.equal(total([emailItem(e)], SEARCH('"team+your"')), 2, "a phrase never spans sender and subject");
  assert.equal(total([emailItem(e)], SEARCH("loyalty+card+-paused")), 2, "excluded word in the subject");
  assert.equal(total([emailItem(e)], SEARCH("loyalty+card+-from:examplia")), 2, "excluded sender");
  assert.equal(total([emailItem(e)], SEARCH("loyalty+card+-refund+-from:other")), 1, "exclusions that do not apply");
  assert.equal(total([emailItem(e), emailItem({ ...e, subject: "Your loyalty card refund" })], SEARCH("examplia+loyalty+card+-refund")), 2,
    "an exclusion can leave one candidate");
  assert.equal(total([emailItem(e)], SEARCH("-refund")), 2, "exclusions only");
  assert.equal(total([emailItem(e)], SEARCH("newer_than:7d+label:agent")), 2, "ignored operators only");
  assert.equal(total([emailItem(e)], SEARCH("loyalty+OR+refund")), 2, "OR is not understood: both words stay required");
});

await test("unmatched email cards stand alone with source, freshness, reason and next step; duplicates by code once", () => {
  const c = card({ created_at: "2026-11-11 13:00:00" }, { name: "Urgent: password was reset (second@)", link: "https://mail.google.com/mail/?authuser=second@example.com#search/password+reset" });
  const out = mergeUrgent([], [c, { ...c, messageId: c.messageId + 1 }, card({}, { name: "Not email", agent: "nyc-scout" })]);
  assert.equal(out.total, 1);
  const [item] = out.items;
  assert.equal(item.title, "password was reset (second@)");
  assert.equal(item.sourceDetail, "Agent Inbox: inbox-triage, second@");
  assert.equal(item.at, "2026-11-11T13:00:00.000Z", "worker UTC time parsed as UTC");
  assert.equal(item.atVerb, "Posted");
  assert.ok(item.reasons[0].includes("flagged it as urgent"));
  assert.ok(item.nextStep.startsWith("Answer the request"));
  assert.ok(item.gmailHref.startsWith("https://mail.google.com/mail/"));
});

await test("order: deadline today/tomorrow, then agent questions, then later deadlines, then Action; bounded", () => {
  const action = emailItem({ receivedAt: hoursAgo(1) });
  const later = emailItem({ labels: ["Agent/Deadline"], deadline: { daysLeft: 4, label: "Sun, Nov 15" } });
  const soon = emailItem({ labels: ["Agent/Deadline"], deadline: { daysLeft: 0, label: "Wed, Nov 11" }, receivedAt: hoursAgo(40) });
  const c = card();
  const out = mergeUrgent([action, later, soon], [c], 3);
  assert.equal(out.total, 4);
  assert.deepEqual(out.items.map((i) => i.key), [`email:${soon.key}`, `card:${c.card.code.toUpperCase()}`, `email:${later.key}`]);
  assert.equal(mergeUrgent([action], [], 0).items.length, 0);
});

await test("an off-Gmail href from the API is never passed through as a link", () => {
  const out = mergeUrgent([emailItem({ href: "javascript:alert(1)" })], []);
  assert.equal(out.items[0].gmailHref, null);
});

await test("ageLabel is relative and honest about bad input", () => {
  assert.equal(ageLabel(hoursAgo(0.01), NOW), "just now");
  assert.equal(ageLabel(hoursAgo(0.5), NOW), "30 min ago");
  assert.equal(ageLabel(hoursAgo(5), NOW), "5 h ago");
  assert.equal(ageLabel(hoursAgo(72), NOW), "3 d ago");
  assert.equal(ageLabel("nope", NOW), "at an unknown time");
  assert.equal(parseWorkerTime("2026-11-11 13:00:00"), "2026-11-11T13:00:00.000Z");
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log(`Failed: ${failures.join("; ")}`); process.exit(1); }
