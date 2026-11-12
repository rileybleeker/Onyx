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
const { getUrgentEmail, SCAN_LIMIT } = await import("../src/lib/urgent-email-query.ts");
const {
  assessEmail, selectUrgent, daysUntilDeadline, domainMatches, gmailMessageHref, isGmailHref,
  MAX_URGENT_SHOWN, WINDOW_DAYS, URGENT_THRESHOLD, PRIORITY_SENDER_DOMAINS,
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
  assert.ok(r.score <= 6 + 3, `score ${r.score} should be content cap 6 plus at most one deadline bonus`);
  assert.equal(r.reasons.length, 3);
});

// ---- Promotional damping -----------------------------------------------------------
await test("promotional mail with urgent words is not urgent", () => {
  assert.equal(assessEmail(mail({ subject: "URGENT: 50% off sale ends today" }), NOW).urgent, false);
  assert.equal(assessEmail(mail({ subject: "Last chance: final notice for our newsletter giveaway" }), NOW).urgent, false);
  assert.equal(assessEmail(mail({ fromAddress: "newsletter@example.com", subject: "Action required: read this week's digest" }), NOW).urgent, false);
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

// ---- Query (fake client, no database) ------------------------------------------------
function fakeClient(result) {
  const calls = {};
  const chain = {
    from(t) { calls.table = t; return chain; },
    select(c) { calls.columns = c; return chain; },
    gte(col, v) { calls.gte = [col, v]; return chain; },
    order(col, o) { calls.order = [col, o]; return chain; },
    limit(n) { calls.limit = n; return Promise.resolve(result); },
  };
  return { client: chain, calls };
}
const row = (over = {}) => ({
  email_id: 1, account: "me@example.com", message_id: "m1@mail.example.com", received_at: hoursAgo(3),
  from_name: "Example Billing", from_address: "billing@example.com", subject: "Payment failed",
  snippet: null, is_unread: true, ...over,
});

await test("a missing table means 'not connected', for either error code", async () => {
  for (const code of ["PGRST205", "42P01"]) {
    const { client } = fakeClient({ data: null, error: { code, message: "relation does not exist" } });
    assert.deepEqual(await getUrgentEmail(client, NOW), { status: "not_connected" });
  }
});

await test("any other database error is an error, not an empty inbox", async () => {
  const { client } = fakeClient({ data: null, error: { code: "XX000", message: "boom with details" } });
  await assert.rejects(() => getUrgentEmail(client, NOW), (e) => e.message.includes("XX000") && !e.message.includes("details"));
});

await test("the query is windowed, newest first, and hard-limited", async () => {
  const { client, calls } = fakeClient({ data: [], error: null });
  await getUrgentEmail(client, NOW);
  assert.equal(calls.table, "inbox_emails");
  assert.equal(calls.limit, SCAN_LIMIT);
  assert.deepEqual(calls.order, ["received_at", { ascending: false }]);
  assert.deepEqual(calls.gte, ["received_at", new Date(NOW.getTime() - WINDOW_DAYS * 86_400_000).toISOString()]);
  assert.ok(!/body|html|attachment/.test(calls.columns), "no body columns are ever selected");
});

await test("an empty table answers ready with nothing to show", async () => {
  const { client } = fakeClient({ data: [], error: null });
  assert.deepEqual(await getUrgentEmail(client, NOW), {
    status: "ready", windowDays: WINDOW_DAYS, scanned: 0, total: 0, newestReceivedAt: null, items: [],
  });
});

await test("urgent rows come back bounded, linked and without the snippet", async () => {
  const rows = [
    row({ email_id: 1, subject: "Payment failed", snippet: "private body text" }),
    row({ email_id: 2, subject: "Lunch?", from_address: "friend@example.com", from_name: null, received_at: hoursAgo(1) }),
    row({ email_id: 3, subject: "Weekly digest sale", from_address: "newsletter@example.com" }),
    row({ email_id: 4, subject: "Final notice: " + "x".repeat(400), message_id: null }),
  ];
  const { client } = fakeClient({ data: rows, error: null });
  const out = await getUrgentEmail(client, NOW);
  assert.equal(out.status, "ready");
  assert.equal(out.scanned, 4);
  assert.equal(out.total, 2);
  assert.equal(out.newestReceivedAt, rows[0].received_at);
  const first = out.items.find((i) => i.id === "1");
  assert.equal(first.from, "Example Billing");
  assert.ok(first.href.startsWith("https://mail.google.com/mail/?authuser=me%40example.com#search/rfc822msgid%3A"));
  assert.ok(!JSON.stringify(out).includes("private body text"), "snippet must not leave the server");
  const noLink = out.items.find((i) => i.id === "4");
  assert.equal(noLink.href, null);
  assert.ok(noLink.subject.length <= 140);
});

await test("malformed rows are skipped, not fatal", async () => {
  const { client } = fakeClient({ data: [null, { email_id: 9 }, row({ email_id: 10, received_at: undefined }), row({ email_id: 11 })], error: null });
  const out = await getUrgentEmail(client, NOW);
  assert.equal(out.scanned, 1);
  assert.equal(out.items[0].id, "11");
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) { console.log(`Failed: ${failures.join("; ")}`); process.exit(1); }
