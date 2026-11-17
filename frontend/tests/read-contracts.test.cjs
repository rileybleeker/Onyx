// Run: node --test tests/read-contracts.test.cjs
// Read contracts changed by #187 (faster check-in / habits / reading / status reads), pinned offline (Codex review
// 2026-11-14, D6): the shared stale-while-revalidate cache never serves an entry past its maximum age, says how old a
// cached answer is, and passes the invalidation tag; the habit-definition comparison the sync uses to drop the
// cached list; and the single embedded reading request (children complete, ordered server-side, errors thrown).
// SYNTHETIC DATA ONLY: invented books and dates, a fake fetch, no network, no database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createClient } = require("@supabase/supabase-js");
const { loadTs } = require("./helpers/load-ts.cjs");

// unstable_cache stand-in: `entry` is what the shared cache holds (null = no Next cache outside a request).
function nextCacheStub(state) {
  return {
    unstable_cache: (fn, keys, opts) => {
      state.calls.push({ keys, opts });
      return async () => {
        if (state.entry === null) throw new Error("Invariant: incrementalCache missing in unstable_cache");
        if (state.entry === undefined) return fn();
        return state.entry;
      };
    },
  };
}

test("swr-cache: outside a Next request the source is read directly and its errors reach the caller", async () => {
  const state = { calls: [], entry: null };
  const S = loadTs("lib/swr-cache.ts", { "next/cache": nextCacheStub(state) });
  const before = Date.now();
  const r = await S.swrCacheTimed("k", async () => 42, { revalidateSeconds: 60, maxAgeMs: 1000 })();
  assert.equal(r.value, 42);
  assert.ok(r.checkedAt >= before, "a direct read is checked now");
  await assert.rejects(S.swrCache("k2", async () => { throw new Error("notion down"); }, { revalidateSeconds: 60, maxAgeMs: 1000 })(), /notion down/);
});

test("swr-cache: a cached entry is served with its own age, and never once it is past maxAge", async () => {
  const state = { calls: [], entry: { at: Date.now() - 30_000, value: "cached" } };
  const S = loadTs("lib/swr-cache.ts", { "next/cache": nextCacheStub(state) });
  const read = S.swrCacheTimed("k", async () => "fresh", { revalidateSeconds: 60, maxAgeMs: 60_000, tag: "t1" });
  const hit = await read();
  assert.equal(hit.value, "cached");
  assert.equal(hit.checkedAt, state.entry.at, "the age reported is the cached read's, not now");
  state.entry = { at: Date.now() - 61_000, value: "too old" };
  assert.equal((await read()).value, "fresh", "an entry past maxAge is never served");
  assert.deepEqual(state.calls[0].opts, { revalidate: 60, tags: ["t1"] });
  S.swrCache("k3", async () => 1, { revalidateSeconds: 5, maxAgeMs: 10 });
  assert.deepEqual(state.calls[1].opts, { revalidate: 5 }, "no tag unless asked for");
});

test("staleCheckNote: current within the limit, otherwise says how old the last good check is", () => {
  const S = loadTs("lib/swr-cache.ts", { "next/cache": nextCacheStub({ calls: [], entry: null }) });
  const now = Date.parse("2026-11-14T12:00:00Z");
  assert.equal(S.staleCheckNote(now - 14 * 60000, now, 15 * 60000, "Notion"), null);
  assert.equal(S.staleCheckNote(now - 15 * 60000, now, 15 * 60000, "Notion"), null, "the limit itself is still current");
  assert.match(S.staleCheckNote(now - 40 * 60000, now, 15 * 60000, "Notion"), /last good Notion check, 40 min old/);
  assert.match(S.staleCheckNote(now - 5 * 3600000, now, 15 * 60000, "Notion"), /5 h old/);
});

test("habit definitions: the sync and the cached reader parse a page the same way, and only definition changes count", () => {
  const H = loadTs("lib/habits-notion.ts", { "next/cache": nextCacheStub({ calls: [], entry: null }) });
  const page = (id, name, extra = {}) => ({ id, properties: { Habit: { title: [{ plain_text: name }] }, Active: { checkbox: true }, ...extra } });
  const a = H.parseHabitPage(page("p1", "Read a book", { Category: { select: { name: "learning" } }, Frequency: { select: { name: "weekly" } } }));
  assert.deepEqual(a, { id: "p1", name: "Read a book", category: "learning", frequency: "weekly", active: true, lastCompleted: null });
  const b = H.parseHabitPage(page("p2", "Stretch"));
  assert.equal(b.category, "general");
  assert.equal(b.frequency, "daily");
  assert.equal(H.parseHabitPage({ id: "p3", properties: {} }).name, "");

  assert.equal(H.sameHabitDefinitions([a, b], [b, { ...a, lastCompleted: "2026-11-13" }]), true, "order and Last Completed are not definitions");
  assert.equal(H.sameHabitDefinitions([a, b], [b, { ...a, name: "Read two books" }]), false, "rename");
  assert.equal(H.sameHabitDefinitions([a, b], [b, { ...a, frequency: "daily" }]), false, "frequency");
  assert.equal(H.sameHabitDefinitions([a, b], [b, { ...a, category: "health" }]), false, "category");
  assert.equal(H.sameHabitDefinitions([a, b], [a]), false, "deactivated (dropped from the Active list)");
  assert.equal(H.sameHabitDefinitions([a], [a, b]), false, "added");
  assert.equal(H.HABITS_CACHE_TAG, "notion-active-habits");
});

// ---------------------------------------------------------------------------------------------------------------
// Reading overview: one embedded request (books + sessions + highlights with reviews + quizzes + chapters).
// ---------------------------------------------------------------------------------------------------------------
const TODAY = "2026-11-10";
function bookRow(over = {}) {
  return {
    book_id: 7, slug: "example-book", title: "Example", author: "A. Writer", total_chapters: 10, status: "reading",
    start_date: "2026-11-01", target_date: "2026-11-30", habit_name: null, notion_page_id: null, finished_on: null, asin: null, last_position: null, last_position_at: null,
    total_positions: null, created_at: "2026-11-01T00:00:00Z",
    reading_sessions: [
      { session_id: 2, book_id: 7, session_date: "2026-11-10", chapter_from: 3, chapter_through: 4, minutes: 30, recall: null, source: "manual" },
      { session_id: 1, book_id: 7, session_date: "2026-11-09", chapter_from: 1, chapter_through: 2, minutes: 25, recall: null, source: "manual" },
    ],
    book_highlights: [
      { highlight_id: 12, book_id: 7, passage: "second", comment: null, chapter: 2, ease: "2.6", next_review: "2026-11-20", archived: false, created_at: "2026-11-10T01:00:00Z",
        reading_reviews: [{ review_date: TODAY }, { review_date: "2026-11-08" }] },
      { highlight_id: 11, book_id: 7, passage: "first", comment: null, chapter: 1, ease: "2.5", next_review: "2026-11-20", archived: false, created_at: "2026-11-09T01:00:00Z", reading_reviews: null },
    ],
    reading_quizzes: [],
    book_chapters: [{ chapter: 1, start_position: 0, end_position: 99, start_page: 1, end_page: 10 }],
    ...over,
  };
}

function fakeSupabase(respond) {
  const requests = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    requests.push({ url: u, method: init.method || "GET" });
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    const [status, body] = respond(u);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  const client = createClient("https://db.example.test", "anon-test-key", { db: { schema: "pds" }, global: { fetch }, auth: { persistSession: false } });
  return { client, requests, maxInFlight: () => maxInFlight };
}

const okRoutes = (rows) => (u) => {
  if (u.pathname === "/rest/v1/rpc/behavioral_today_now") return [200, TODAY];
  // The question bank's summary (READ-QUIZ-01): no book summary answers null, like the function does.
  if (u.pathname === "/rest/v1/rpc/reading_bank_summary") return [200, null];
  if (u.pathname === "/rest/v1/books") return [200, rows];
  return [404, { message: "unexpected " + u.pathname }];
};

test("reading overview: one embedded books request with every child ordered and none truncated, in parallel with today", async () => {
  const R = loadTs("lib/reading.ts");
  const db = fakeSupabase(okRoutes([bookRow()]));
  const o = await R.getOverview(db.client);
  const books = db.requests.filter((r) => r.url.pathname === "/rest/v1/books");
  assert.equal(books.length, 1, "one request for the book and all its children");
  assert.equal(db.requests.length, 3, "plus behavioral today and the question bank's summary, nothing else");
  assert.equal(db.maxInFlight(), 3, "the three requests are in flight together");
  const p = books[0].url.searchParams;
  const select = p.get("select").replace(/\s/g, "");
  for (const rel of ["reading_sessions(*)", "book_highlights(*,reading_reviews(review_date))", "reading_quizzes(*)", "book_chapters("]) {
    assert.ok(select.includes(rel), rel);
  }
  assert.equal(p.get("status"), "eq.reading");
  assert.equal(p.get("book_highlights.archived"), "eq.false", "archived highlights (and so their reviews) stay out");
  assert.equal(p.get("reading_sessions.order"), "session_date.desc,session_id.desc");
  assert.equal(p.get("book_highlights.order"), "created_at.desc,highlight_id.desc");
  assert.equal(p.get("reading_quizzes.order"), "taken_at.desc");
  assert.equal(p.get("book_chapters.order"), "start_position.asc");
  assert.equal(p.get("order"), "created_at.desc");
  assert.equal(p.get("limit"), "1", "one book");
  for (const key of p.keys()) assert.ok(!/\.(limit|offset)$/.test(key), `no child is cut short (${key})`);

  assert.equal(o.today, TODAY);
  assert.deepEqual(o.sessions.map((s) => s.session_id), [2, 1], "server order kept");
  assert.deepEqual(o.highlights.map((h) => h.highlight_id), [12, 11]);
  assert.equal(o.highlights[0].ease, 2.6, "numeric ease");
  assert.ok(!("reading_reviews" in o.highlights[0]), "the embedded reviews are lifted out of each highlight");
  assert.ok(!("reading_sessions" in o.book) && !("book_highlights" in o.book), "the book carries no embedded arrays");
  assert.equal(o.reviewsToday, 1, "every review of every highlight is counted (one today)");
  assert.equal(o.chapters.length, 1);
  assert.equal(o.chaptersDone, 4);
});

test("reading overview: a slug selects that book, a missing book is null, empty children are empty, an error throws", async () => {
  const R = loadTs("lib/reading.ts");
  const bySlug = fakeSupabase(okRoutes([bookRow({ reading_sessions: null, book_highlights: [], reading_quizzes: null, book_chapters: null })]));
  const o = await R.getOverview(bySlug.client, "example-book");
  const p = bySlug.requests.find((r) => r.url.pathname === "/rest/v1/books").url.searchParams;
  assert.equal(p.get("slug"), "eq.example-book");
  assert.equal(p.get("status"), null);
  assert.deepEqual([o.sessions, o.highlights, o.quizzes, o.chapters], [[], [], [], []]);

  assert.equal(await R.getOverview(fakeSupabase(okRoutes([])).client), null);

  const broken = fakeSupabase((u) => (u.pathname === "/rest/v1/books" ? [500, { message: "embedded read failed", code: "XX000" }] : [200, TODAY]));
  await assert.rejects(R.getOverview(broken.client), /embedded read failed/, "a failed read is an error, never a partial overview");
});
