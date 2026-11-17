// Behaviour tests for the real findSameTitleEntry() (lib/journal-file-server.ts): the same-title duplicate check
// of POST /api/journal/entry, run against a mocked global fetch that answers canned Notion JSON. The source-string
// assertions in journal-entry.test.cjs cover the query *shape* only; these exercise what the helper actually does
// with Notion's answers, so a regression in how a match is decided fails here instead of passing.
// SYNTHETIC text and ids only; no network, no real Notion.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadTs } = require("./helpers/load-ts.cjs");

process.env.NOTION_API_KEY = "synthetic-notion-key";
process.env.NOTION_JOURNAL_DB = "00000000000000000000000000000000";

// The real server module. It imports "server-only" (no such package is installed, and it would throw): stub it.
const Server = loadTs("lib/journal-file-server.ts", { "server-only": {} });

const DB = process.env.NOTION_JOURNAL_DB;
/** Long in the past so the route's validation always accepts it (the route race only cares about same title + day). */
const DAY = "2020-03-04";
const entry = (over = {}) => ({
  date: DAY,
  title: "Synthetic title",
  mood: "neutral",
  confidence: "medium",
  source: "voice",
  topics: ["reflection"],
  body: "alpha words",
  ...over,
});
const PAGE = { id: "44444444444444444444444444444444", url: "https://www.notion.so/synthetic-entry-44444444444444444444444444444444" };
const PAGE_2 = { id: "55555555555555555555555555555555", url: "https://www.notion.so/synthetic-entry-55555555555555555555555555555555" };
/** Canned children whose pageBodyText() equals bodyAsWritten("alpha words"). */
const words = (text) => ({ results: [{ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", plain_text: text }] } }] });

/** A global.fetch over https://api.notion.com/v1/... that records every call and dispatches on (method, path). */
function notionServer(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const path = String(url).replace(/^https:\/\/api\.notion\.com\/v1\//, "");
    calls.push({ method, path });
    const route = routes.find((r) => r.method === method && (r.path instanceof RegExp ? r.path.test(path) : r.path === path));
    if (!route) throw new Error(`unexpected Notion call: ${method} ${path}`);
    return { ok: (route.status ?? 200) < 400, status: route.status ?? 200, json: async () => route.json };
  };
  return { calls, fetchImpl };
}
async function withFetch(fetchImpl, fn) {
  const prev = global.fetch;
  global.fetch = fetchImpl;
  try {
    return await fn();
  } finally {
    global.fetch = prev;
  }
}
const queryPath = `databases/${DB}/query`;
const childrenPath = (id) => new RegExp(`^blocks/${id}/children`);

test("findSameTitleEntry: one matching page with identical words is the same entry", async () => {
  const n = notionServer([
    { method: "POST", path: queryPath, json: { results: [PAGE] } },
    { method: "GET", path: childrenPath(PAGE.id), json: words("alpha words") },
  ]);
  await withFetch(n.fetchImpl, async () => {
    assert.deepEqual(await Server.findSameTitleEntry(entry()), { url: PAGE.url, sameWords: true });
  });
  // The query once, then the page's blocks once, in that order.
  assert.deepEqual(
    n.calls.map((c) => `${c.method} ${c.path.split("?")[0]}`),
    [`POST ${queryPath}`, `GET blocks/${PAGE.id}/children`],
  );
});

test("findSameTitleEntry: a page with different words is a different entry, never reported as saved", async () => {
  const n = notionServer([
    { method: "POST", path: queryPath, json: { results: [PAGE] } },
    { method: "GET", path: childrenPath(PAGE.id), json: words("unrelated words") },
  ]);
  await withFetch(n.fetchImpl, async () => {
    assert.deepEqual(await Server.findSameTitleEntry(entry()), { url: PAGE.url, sameWords: false });
  });
});

// The real helper inside the route: on sameWords:false the route must answer 409 and send no create call (Onyx#168 P1).
const nextServer = { NextResponse: { json: (body, init = {}) => ({ status: init.status ?? 200, body }) } };
const route = loadTs("app/api/journal/entry/route.ts", {
  "next/server": nextServer,
  "@/lib/checkin-voice": { checkVoiceRequest: () => null },
  "server-only": {}, // the route loads journal-file-server for real, needs the stub
});
function post(body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const h = { origin: "https://onyx.example", host: "onyx.example", "content-type": "application/json" };
  return { headers: { get: (k) => (k in h ? h[k] : null) }, nextUrl: { origin: "https://onyx.example" }, text: async () => text };
}

test("route: a different entry with the same title makes no create call (real helper)", async () => {
  const n = notionServer([
    { method: "POST", path: queryPath, json: { results: [PAGE] } },
    { method: "GET", path: childrenPath(PAGE.id), json: words("unrelated words") },
  ]);
  await withFetch(n.fetchImpl, async () => {
    const res = await route.POST(post(entry()));
    assert.equal(res.status, 409);
    assert.equal(res.body.existing, undefined);
  });
  assert.equal(n.calls.some((c) => c.method === "POST" && c.path === "pages"), false, "no create is sent for a different entry");
});

test("findSameTitleEntry: no matching pages answers null", async () => {
  const n = notionServer([{ method: "POST", path: queryPath, json: { results: [] } }]);
  await withFetch(n.fetchImpl, async () => {
    assert.equal(await Server.findSameTitleEntry(entry()), null);
  });
});

test("findSameTitleEntry: a Notion 500 on the query throws NotionRefused, never a false 'already there'", async () => {
  const n = notionServer([{ method: "POST", path: queryPath, status: 500, json: {} }]);
  await withFetch(n.fetchImpl, async () => {
    await assert.rejects(() => Server.findSameTitleEntry(entry()), (e) => e instanceof Server.NotionRefused && e.status === 500);
  });
});

test("findSameTitleEntry: identical words under a changed label -> an update request is sent", (t) => {
  // SKIPPED: the label-retry follow-up is not built yet (a same-title page holding the same words but a different
  // label should be brought up to the new labels). Once it lands, this is what must hold:
  //   const relabeled = { ...PAGE, properties: { Title: { title: [{ plain_text: "Renamed synthetic title" }] } } };
  //   const n = notionServer([
  //     { method: "POST", path: queryPath, json: { results: [relabeled] } },
  //     { method: "GET", path: childrenPath(PAGE.id), json: words("alpha words") },
  //     { method: "PATCH", path: `pages/${PAGE.id}`, json: { ...PAGE, properties: {} } },
  //   ]);
  //   await withFetch(n.fetchImpl, async () => {
  //     assert.deepEqual(await Server.findSameTitleEntry(entry()), { url: PAGE.url, sameWords: true });
  //   });
  //   assert.ok(n.calls.some((c) => c.method === "PATCH" && c.path === `pages/${PAGE.id}`), "the label update is sent");
  t.skip("label retry follow-up not built yet (Onyx roadmap); the assertion lives in the comment above");
});

test("findSameTitleEntry: the identical page past the first page of results is found", (t) => {
  // SKIPPED: the query is not paginated yet. findSameTitleEntry reads only the first page of sameEntryQuery
  // (page_size 5) and ignores has_more / next_cursor, so a same-words page on the second page is missed today.
  // Once pagination lands, this is what must hold (the mock would route the two POST query calls by their body,
  // since both hit `databases/<id>/query`: the first answers has_more + next_cursor, the follow-up carries
  // start_cursor and answers the page that holds the identical words):
  //   const n = notionServer([
  //     { method: "POST", path: queryPath, json: { results: [{ ...PAGE_2 }], has_more: true, next_cursor: "second-page" } },
  //     { method: "POST", path: queryPath, json: { results: [PAGE] } },
  //     { method: "GET", path: childrenPath(PAGE.id), json: words("alpha words") },
  //   ]);
  //   await withFetch(n.fetchImpl, async () => {
  //     assert.deepEqual(await Server.findSameTitleEntry(entry()), { url: PAGE.url, sameWords: true });
  //   });
  t.skip("query pagination not built yet (Onyx roadmap); the assertion lives in the comment above");
});
