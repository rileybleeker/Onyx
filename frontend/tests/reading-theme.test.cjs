// READ-QUIZ-01 S7: a book's own flavour is data, not code.
//  - lib/reading.ts: pds.books.theme (level titles, concept tags, badge labels) is read with generic defaults, applied to
//    the level and the badges, validated (plain text, limits, a bad part falls back on its own), and carried on the
//    overview without a new request; the badge keys name no book;
//  - the concept picker: the theme's concepts plus the titles of linked question-bank ideas (GET /api/reading/idea-titles,
//    on demand, fail-open), deduplicated and capped;
//  - sql/reading_book_theme.sql: additive, the column's shape check, the linked-titles function behind the spoiler gate;
//  - the public repo names no book: hashes of the words that used to sit in code are looked for in the reading files
//    (the words themselves are not in this test).
// Offline and synthetic: an invented book ("The Lighthouse Ledger"), fake database, no network.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createClient } = require("@supabase/supabase-js");
const { loadTs } = require("./helpers/load-ts.cjs");

const R = loadTs("lib/reading.ts");

const REPO = path.join(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");
const TODAY = "2026-03-10";
const SLUG = "lighthouse-ledger";

const book = {
  book_id: 7,
  slug: SLUG,
  title: "The Lighthouse Ledger",
  author: "A. Writer",
  total_chapters: 20,
  start_date: "2026-03-01",
  target_date: "2026-03-31",
  status: "reading",
  finished_on: null,
  notion_page_id: null,
  habit_name: null,
  asin: null,
  last_position: null,
  last_position_at: null,
  total_positions: null,
};
const session = (id, day, through) => ({ session_id: id, book_id: 7, session_date: day, chapter_from: 1, chapter_through: through, minutes: 20, medium: "kindle", recall: null, question: null, notion_block_id: null, created_at: `${day}T10:00:00Z`, source: "manual", in_chapter: null, highlight_count: null });
const overview = (extra = {}) => R.computeOverview({ book, today: TODAY, sessions: [], highlights: [], reviews: [], quizzes: [], ...extra });
const badge = (o, key) => o.badges.find((b) => b.key === key);

/* ------------------------------------------------------------------ */
/* parseBookTheme                                                       */
/* ------------------------------------------------------------------ */

test("no theme, or one that is not a theme, is the generic defaults (fresh objects each time)", () => {
  for (const raw of [null, undefined, "x", 5, [], [{ concepts: ["a"] }], { v: 2, concepts: ["a"] }, { v: "1" }]) {
    const t = R.parseBookTheme(raw);
    assert.deepEqual(t.levelTitles, [...R.DEFAULT_LEVEL_TITLES], JSON.stringify(raw));
    assert.deepEqual(t.concepts, []);
    assert.deepEqual(t.badgeLabels, {});
  }
  const a = R.parseBookTheme(null);
  a.levelTitles.push("x");
  a.concepts.push("y");
  a.badgeLabels.first = "z";
  assert.deepEqual(R.parseBookTheme(null).concepts, [], "a caller changing its copy never changes the next one's");
  assert.equal(R.parseBookTheme(null).levelTitles.length, R.DEFAULT_LEVEL_TITLES.length);
  assert.deepEqual(R.defaultBookTheme(), R.parseBookTheme(null));
  assert.deepEqual(R.parseBookTheme({}), R.defaultBookTheme(), "an empty object is a theme with nothing in it");
  assert.deepEqual(R.parseBookTheme({ v: 1 }), R.defaultBookTheme());
});

test("a theme's parts are read on their own: a good part is kept, a bad one falls back alone", () => {
  const t = R.parseBookTheme({
    v: 1,
    level_titles: ["Newcomer", "Keeper", "Chief Keeper"],
    concepts: ["Tide tables", "Ledger discipline"],
    badges: { "checkpoint-1": "Lamp lit", "first-session": "First watch" },
  });
  assert.deepEqual(t.levelTitles, ["Newcomer", "Keeper", "Chief Keeper"]);
  assert.deepEqual(t.concepts, ["Tide tables", "Ledger discipline"]);
  assert.deepEqual(t.badgeLabels, { "checkpoint-1": "Lamp lit", "first-session": "First watch" });

  const onlyConcepts = R.parseBookTheme({ concepts: ["Tide tables"], level_titles: "Keeper", badges: ["x"] });
  assert.deepEqual(onlyConcepts.concepts, ["Tide tables"]);
  assert.deepEqual(onlyConcepts.levelTitles, [...R.DEFAULT_LEVEL_TITLES], "level_titles that is not a list: the generic ladder");
  assert.deepEqual(onlyConcepts.badgeLabels, {}, "badges that is not an object: no renames");
  assert.deepEqual(R.parseBookTheme({ level_titles: [1, null, {}] }).levelTitles, [...R.DEFAULT_LEVEL_TITLES], "a list with no text in it: the generic ladder");
  assert.deepEqual(R.parseBookTheme({ level_titles: [1, "Keeper", null] }).levelTitles, ["Keeper"], "entries that are not text are dropped");
});

test("theme text is one short plain line: control characters out, whitespace collapsed, cut to the limits, repeats dropped", () => {
  const long = "x".repeat(200);
  const t = R.parseBookTheme({
    level_titles: ["  Keeper \n of\tthe  light ", long, ...Array.from({ length: 20 }, (_, i) => `L${i}`)],
    concepts: ["Tide tables", "tide TABLES", "  ", "A\u0000B\u0007C", long, ...Array.from({ length: 60 }, (_, i) => `C${i}`)],
    badges: { finisher: `  ${long}  `, scribe: "   ", runner: 7, "not-a-badge": "Sneaky", "checkpoint-2": "Shoals" },
  });
  assert.equal(t.levelTitles[0], "Keeper of the light");
  assert.equal(t.levelTitles[1].length, R.THEME_LIMITS.levelTitleChars, "cut to the limit");
  assert.equal(t.levelTitles.length, R.THEME_LIMITS.levelTitles, "at most 12 titles");
  assert.equal(t.concepts.length, R.THEME_LIMITS.concepts, "at most 40 concepts");
  assert.equal(t.concepts.filter((c) => c.toLowerCase() === "tide tables").length, 1, "a repeat ignoring case is dropped");
  assert.ok(t.concepts.includes("A B C"), "control characters become spaces");
  assert.ok(t.concepts.every((c) => c.length <= R.THEME_LIMITS.conceptChars));
  assert.equal(t.badgeLabels.finisher.length, R.THEME_LIMITS.badgeChars);
  assert.ok(!("scribe" in t.badgeLabels) && !("runner" in t.badgeLabels), "blank and non-text labels keep the generic one");
  assert.ok(!("not-a-badge" in t.badgeLabels), "a theme renames the badges there are, never adds one");
  assert.equal(t.badgeLabels["checkpoint-2"], "Shoals");
  // Markup is just characters: the screens render these as text.
  assert.equal(R.parseBookTheme({ concepts: ["<b>Tides</b> & <script>x</script>"] }).concepts[0], "<b>Tides</b> & <script>x</script>");
});

/* ------------------------------------------------------------------ */
/* The overview: level ladder and badges                                 */
/* ------------------------------------------------------------------ */

test("with no theme the level ladder and the badges are generic, and the badge keys name no book", () => {
  const o = overview();
  assert.equal(o.level.title, R.DEFAULT_LEVEL_TITLES[0]);
  assert.deepEqual(o.badges.map((b) => b.key), ["first-session", "checkpoint-1", "checkpoint-2", "finisher", "streak-7", "scribe", "reviewer", "quiz-master", "on-pace", "runner"]);
  assert.deepEqual(o.badges.map((b) => b.key), [...R.BADGE_KEYS]);
  assert.deepEqual(o.badges.map((b) => b.label), o.badges.map((b) => R.DEFAULT_BADGE_LABELS[b.key]));
  assert.equal(o.badges.length, 10, "no badge added or removed");
  assert.equal(badge(o, "checkpoint-1").description, `Reach chapter ${R.checkpointChapters(20)[0]}`);
  assert.equal(badge(o, "checkpoint-2").description, `Reach chapter ${R.checkpointChapters(20)[1]}`);
  assert.deepEqual(o.theme, R.defaultBookTheme(), "the overview always carries a theme");
  assert.deepEqual(overview({ theme: null }).theme, R.defaultBookTheme());
});

test("a theme renames the level ladder and the badges it names, and nothing else changes", () => {
  const plain = overview({ sessions: [session(1, "2026-03-09", 8), session(2, "2026-03-10", 14)] });
  const theme = R.parseBookTheme({ level_titles: ["Newcomer", "Keeper", "Chief Keeper"], concepts: ["Tide tables"], badges: { "checkpoint-1": "Lamp lit", "first-session": "First watch" } });
  const o = overview({ sessions: [session(1, "2026-03-09", 8), session(2, "2026-03-10", 14)], theme });
  assert.equal(badge(o, "checkpoint-1").label, "Lamp lit");
  assert.equal(badge(o, "first-session").label, "First watch");
  assert.equal(badge(o, "checkpoint-2").label, R.DEFAULT_BADGE_LABELS["checkpoint-2"], "a badge the theme does not name keeps its generic label");
  assert.deepEqual(o.badges.map((b) => [b.key, b.description, b.earned, b.earnedOn]), plain.badges.map((b) => [b.key, b.description, b.earned, b.earnedOn]), "keys, descriptions and what is earned are the same");
  assert.deepEqual({ ...o.xp }, { ...plain.xp });
  assert.deepEqual(o.theme.concepts, ["Tide tables"]);
  assert.equal(badge(o, "checkpoint-1").earned, true, "chapter 14 is past the first checkpoint (6)");
  assert.equal(badge(o, "checkpoint-2").earned, true, "and the second (13)");
});

test("the level title follows the ladder and the last one serves every higher level", () => {
  const theme = R.parseBookTheme({ level_titles: ["Newcomer", "Keeper", "Chief Keeper"] });
  const atXp = (n) => {
    // A reading day with enough recall to reach `n` levels of XP is simpler to build from highlights: 2 XP each.
    const hs = Array.from({ length: Math.ceil((n * R.XP.perLevel) / R.XP.perHighlightBare) }, (_, i) => ({ highlight_id: i + 1, book_id: 7, chapter: 1, location: null, passage: `p${i}`, comment: null, concept: null, source: "kindle", review_count: 0, ease: 2.5, interval_days: 0, next_review: null, last_reviewed: null, archived: false, notion_block_id: null, created_at: "2026-03-05T10:00:00Z", position: null, position_end: null, page: null, highlighted_at: null, note_at: null, behavioral_date: null }));
    return overview({ highlights: hs, theme });
  };
  assert.equal(overview({ theme }).level.n, 1);
  assert.equal(overview({ theme }).level.title, "Newcomer");
  assert.equal(atXp(1).level.n, 2);
  assert.equal(atXp(1).level.title, "Keeper");
  assert.equal(atXp(2).level.title, "Chief Keeper");
  assert.equal(atXp(7).level.title, "Chief Keeper", "past the end of the list: the last title");
  assert.equal(atXp(7).level.n, 8);
  // The generic ladder behaves the same way.
  assert.equal(overview().level.title, R.DEFAULT_LEVEL_TITLES[0]);
});

/* ------------------------------------------------------------------ */
/* getOverview: the theme rides on the book's own row                   */
/* ------------------------------------------------------------------ */

function fakeSupabase(respond) {
  const requests = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    requests.push({ url: u, method: init.method || "GET", body: init.body ? String(init.body) : null });
    await new Promise((r) => setTimeout(r, 2));
    const [status, body] = respond(u, init);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  const client = createClient("https://db.example.test", "anon-test-key", { db: { schema: "pds" }, global: { fetch }, auth: { persistSession: false } });
  return { client, requests };
}
const bookRow = (extra = {}) => ({ ...book, created_at: "2026-03-01T00:00:00Z", reading_sessions: [], book_highlights: [], reading_quizzes: [], book_chapters: [], ...extra });
const routes = (rows) => (u) => {
  if (u.pathname === "/rest/v1/rpc/behavioral_today_now") return [200, TODAY];
  if (u.pathname === "/rest/v1/rpc/reading_bank_summary") return [200, null];
  if (u.pathname === "/rest/v1/books") return [200, rows];
  return [404, { message: `unexpected ${u.pathname}` }];
};

test("getOverview reads the theme from the same one books request, applies it, and keeps the raw column off the book", async () => {
  const db = fakeSupabase(routes([bookRow({ theme: { v: 1, level_titles: ["Newcomer", "Keeper"], concepts: ["Tide tables"], badges: { finisher: "Last light" } } })]));
  const o = await R.getOverview(db.client, SLUG);
  assert.equal(db.requests.length, 3, "the book, today and the question bank's summary: the theme costs no request");
  assert.equal(o.level.title, "Newcomer");
  assert.deepEqual(o.theme.concepts, ["Tide tables"]);
  assert.equal(badge(o, "finisher").label, "Last light");
  assert.ok(!("theme" in o.book), "the raw column is not part of the book that goes to the browser");
  const select = db.requests.find((r) => r.url.pathname === "/rest/v1/books").url.searchParams.get("select");
  assert.match(select, /^\*,/, "the whole row is read (so the theme column comes with it once it exists)");
});

test("getOverview before the column exists, or with a bad value, is the generic quest, never an error", async () => {
  for (const [name, extra] of [["no column", {}], ["null", { theme: null }], ["a string", { theme: "garbage" }], ["a list", { theme: [1, 2] }], ["another version", { theme: { v: 9, concepts: ["a"] } }]]) {
    const o = await R.getOverview(fakeSupabase(routes([bookRow(extra)])).client, SLUG);
    assert.ok(o, name);
    assert.deepEqual(o.theme, R.defaultBookTheme(), name);
    assert.equal(o.level.title, R.DEFAULT_LEVEL_TITLES[0], name);
    assert.ok(!("theme" in o.book), name);
  }
});

test("the overview with its theme is plain JSON (it is cached and compared as JSON)", async () => {
  const o = await R.getOverview(fakeSupabase(routes([bookRow({ theme: { concepts: ["Tide tables"] } })])).client, SLUG);
  assert.deepEqual(JSON.parse(JSON.stringify(o.theme)), o.theme);
});

/* ------------------------------------------------------------------ */
/* The concept picker                                                   */
/* ------------------------------------------------------------------ */

test("conceptOptions: the theme's concepts first, then linked idea titles, repeats ignoring case dropped, capped", () => {
  assert.deepEqual(R.conceptOptions(["Tide tables", "Ledger discipline"], ["Keeping the lamp", "tide TABLES", "Ledger discipline"]), ["Tide tables", "Ledger discipline", "Keeping the lamp"]);
  assert.deepEqual(R.conceptOptions([], ["Keeping the lamp"]), ["Keeping the lamp"]);
  assert.deepEqual(R.conceptOptions(["Tide tables"], []), ["Tide tables"]);
  assert.deepEqual(R.conceptOptions(undefined, undefined), [], "an overview cached before the theme existed offers nothing from it");
  assert.deepEqual(R.conceptOptions(null, null), []);
  assert.deepEqual(R.conceptOptions("not a list", [3, null, "ok"]), ["ok"], "a bad value is skipped, not thrown on");
  const many = R.conceptOptions(Array.from({ length: 60 }, (_, i) => `Theme ${i}`), Array.from({ length: 60 }, (_, i) => `Idea ${i}`));
  assert.equal(many.length, R.CONCEPT_OPTIONS_MAX);
  assert.deepEqual(many.slice(0, 3), ["Theme 0", "Theme 1", "Theme 2"], "the theme keeps its place at the top when the list is cut");
  assert.ok(many.every((c) => c.length <= R.THEME_LIMITS.conceptChars));
});

test("parseIdeaTitles: the database's JSON array of titles, cleaned and capped", () => {
  assert.deepEqual(R.parseIdeaTitles(["Keeping the lamp", "  Reading the tide  ", "keeping the LAMP", "", 4, null]), ["Keeping the lamp", "Reading the tide"]);
  assert.deepEqual(R.parseIdeaTitles(null), []);
  assert.deepEqual(R.parseIdeaTitles({ titles: ["x"] }), [], "only the bare array the function answers");
  assert.equal(R.parseIdeaTitles(Array.from({ length: 80 }, (_, i) => `Idea ${i}`)).length, 40);
  assert.ok(R.parseIdeaTitles(["x".repeat(500)])[0].length <= 90, "an idea title is at most 90 characters in the database");
});

test("getLinkedIdeaTitles: one RPC named for the slug, answers titles, and any failure is no titles", async () => {
  const db = fakeSupabase((u) => (u.pathname === "/rest/v1/rpc/reading_bank_linked_idea_titles" ? [200, ["Keeping the lamp", "Reading the tide"]] : [404, { message: "unexpected" }]));
  assert.deepEqual(await R.getLinkedIdeaTitles(db.client, SLUG), ["Keeping the lamp", "Reading the tide"]);
  assert.equal(db.requests.length, 1);
  assert.equal(db.requests[0].method, "POST");
  assert.deepEqual(JSON.parse(db.requests[0].body), { p_slug: SLUG });
  const dflt = fakeSupabase(() => [200, []]);
  assert.deepEqual(await R.getLinkedIdeaTitles(dflt.client, null), []);
  assert.deepEqual(JSON.parse(dflt.requests[0].body), { p_slug: null }, "no slug: the active book, resolved by the database");
  for (const [name, answer] of [
    ["function not applied", [404, { code: "PGRST202", message: "Could not find the function" }]],
    ["42883", [404, { code: "42883", message: "function does not exist" }]],
    ["a missing bank table", [400, { code: "42P01", message: "relation does not exist" }]],
    ["server error", [500, { code: "XX000", message: "boom" }]],
    ["not an array", [200, { titles: ["x"] }]],
    ["null", [200, null]],
  ]) {
    assert.deepEqual(await R.getLinkedIdeaTitles(fakeSupabase(() => answer).client, SLUG), [], name);
  }
  const throwing = { rpc: () => { throw new Error("network down"); } };
  assert.deepEqual(await R.getLinkedIdeaTitles(throwing, SLUG), [], "a thrown error is no titles too");
});

test("the picker's route: GET only, owner session (never a CI route), a slug or nothing, no-store, fails open", () => {
  const route = read("frontend/src/app/api/reading/idea-titles/route.ts");
  assert.match(route, /export async function GET\(/);
  assert.doesNotMatch(route, /export async function (POST|PUT|PATCH|DELETE)\b/, "it writes nothing");
  assert.match(route, /getLinkedIdeaTitles\(supabase, book\)/);
  assert.match(route, /const SLUG_RE = \/\^\[a-z0-9-\]\{1,80\}\$\/;/);
  assert.match(route, /"Cache-Control": "no-store"/);
  assert.match(route, /status: 400/);
  assert.doesNotMatch(read("frontend/src/middleware.ts"), /idea-titles/, "no CI path: the owner's session is the only way in");
});

test("the highlight form offers the theme's concepts plus the linked idea titles, and asks for the titles only while the bank is on", () => {
  const src = read("frontend/src/app/reading/ReadingClient.tsx");
  assert.match(src, /import \{[^}]*\bconceptOptions\b[^}]*\bparseIdeaTitles\b[^}]*\} from "@\/lib\/reading";/);
  assert.doesNotMatch(src, /\bCONCEPTS\b/, "no constant list of one book's concepts");
  assert.match(src, /conceptOptions\(o\.theme\?\.concepts, ideaTitles\)/);
  assert.match(src, /useLinkedIdeaTitles\(o\.book\.slug, o\.practice\?\.enabled === true\)/, "nothing is read while the book's questions are off");
  assert.match(src, /\{concepts\.map\(\(c\) => \(/);
  assert.match(src, /\/api\/reading\/idea-titles\?book=\$\{encodeURIComponent\(slug\)\}/);
  // The read is a GET through the shared helper (no side effect); the picker never writes it.
  const hook = src.slice(src.indexOf("function useLinkedIdeaTitles"), src.indexOf("function useLinkedIdeaTitles") + 1200);
  assert.match(hook, /getJson\(ideaTitlesUrl\(slug\)\)/);
  assert.doesNotMatch(hook, /method: "(POST|PUT|PATCH|DELETE)"|postJson/);
  assert.equal(read("frontend/src/lib/reading.ts").includes("export const CONCEPTS"), false);
});

/* ------------------------------------------------------------------ */
/* sql/reading_book_theme.sql                                           */
/* ------------------------------------------------------------------ */

test("the theme SQL is additive, shape-checked and service-role only, and its function applies the spoiler gate", () => {
  const sql = read("sql/reading_book_theme.sql");
  assert.doesNotMatch(sql, /\b(DROP|DELETE|TRUNCATE)\b/i, "no destructive keyword anywhere, comments included (it must pass the Supabase MCP)");
  assert.doesNotMatch(sql, /\bCREATE TABLE\b/i);
  assert.match(sql, /ALTER TABLE pds\.books\s+ADD COLUMN IF NOT EXISTS theme JSONB\s+CONSTRAINT books_theme_shape CHECK \(theme IS NULL OR \(jsonb_typeof\(theme\) = 'object' AND length\(theme::text\) <= 6000\)\);/);
  // The function: the bank on, the same gate and edition check and evidence rule as every bank read, a linked highlight, no detail ideas.
  const fn = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION pds.reading_bank_linked_idea_titles"));
  for (const part of [
    "pds.reading_bank_book_id(p_slug)",
    "b.approved_at IS NOT NULL AND b.paused_reason IS DISTINCT FROM 'owner'",
    "pds.reading_bank_quiz_through(v_book)",
    "i.unlock_chapter <= v_through",
    "pds.reading_bank_chapter_hash(v_book, x.chapter)",
    "cur.h = i.chapter_hash",
    "pds.reading_bank_idea_supported(i.idea_id)",
    "src.kind = 'highlight'",
    "NOT h.archived AND pds.reading_sha256(h.passage) = src.passage_sha",
    "i.importance <> 'detail'",
    "i.status = 'active'",
    "LIMIT 40",
  ]) {
    assert.ok(fn.includes(part), part);
  }
  assert.match(fn, /LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = pds, pg_temp/, "read-only; plpgsql so the file applies before the bank's tables exist");
  assert.doesNotMatch(fn, /\b(INSERT|UPDATE)\b/i, "reads only");
  assert.match(sql, /REVOKE ALL ON FUNCTION pds\.reading_bank_linked_idea_titles\(text\) FROM PUBLIC, anon, authenticated;/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION pds\.reading_bank_linked_idea_titles\(text\) TO service_role;/);
  // The functions it uses exist in the bank's own file under these names.
  const bank = read("sql/reading_question_bank.sql");
  for (const name of ["reading_bank_book_id", "reading_bank_quiz_through", "reading_bank_chapter_hash", "reading_bank_idea_supported"]) {
    assert.match(bank, new RegExp(`FUNCTION pds\\.${name}\\(`), name);
  }
  assert.match(bank, /passage_sha\s+TEXT/, "the evidence row keeps the passage hash the function compares");
});

/* ------------------------------------------------------------------ */
/* The public repo names no book                                        */
/* ------------------------------------------------------------------ */

// sha256 of the lower-case words that used to be code here (level titles, concept tags, two badge labels). The words are
// not in this file: every phrase of up to 8 words in the reading files is hashed and looked up.
const FORBIDDEN = new Set(`
3e867737c8d0e653bf38d4bf983e5e6fca795ebc129aa5e1c763c91422e95be5
ba7ba2f0955147301663dc7e2b7f0fb0dad57b5a46786f1c335353cca093527f
a3be111ce43e88091d819490d7ee50e6bac366af94aa51b93d81e6e77c8cf096
8bc0805b7c6997c2ea6ff31ce14d050bc63e6b7a024d0b9d0f15304cf8dc1898
53f321fdfb0fa08781ee73b307c51c35db0d8da9ff1098d2710fbb2ef7f8a7cc
4f1bc9dca73f16a4103b8943a7861b0b9c1b8a47861ef003bfa12cc5c6a25c39
8b94b809f220573194103a5cfd0d730587991a5b023de5e97c8a99c28d17ffc7
438317b65a5b230f34d5bbdffc7232ac71f2d363513317e5ba2a085091a8164f
b2d60d92ca43aa51a0c91ba9fd774aa9a80b5fdf9b6685e0e4c23fc75035db43
798b401fb3205683edcb5bd4ab1947a383047045d63360cfaefdcfe4a449e539
9656490e1c4e17bf63cf09a102fa53b513a7a6e00d2745e4c79778c9d958d1a5
42fbd1d60690107b3da12ce46ea9ac4db91155fc0b2be81abf5588140cf2ce8d
c834e0a1104ee183dbeac83a08ba3d8ab9463414b3ccf8f24aa3d68b39f5fdd0
f95224b65f87805878a5675efbb4ce06b10dc7f342404068a3ba656f2a54fae7
c9e837453a795498fc6e784e585750e5b9f733cb26a07d976205011633a15256
abd084db8b449bd76b4cd97881791fbb0c45a45015fbd0981a2171bba0033f4d
eb2620786780eadebdcba117018ed7e0d0c57776487bbd530b20c33ccd3d9f4d
726e7ee629e03ba29fe23ec07c8e942cf95e9e6d4f96cfb8c9e74a9583909dad
0068336a267c1cfeec52562b17470dda94b8e1d44bebb3ee2997d27726443cb6
54a41de7b6b69d8831c425a12652d20ec6ffc3cc41bfb2ad4f643c7c1d3e4553
4dc7dca15a2347ae459adfdc64c304de97ca9703cd57f049284dbb561c06fb66
`.trim().split(/\s+/));
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
const trimEdges = (s) => s.replace(/^[\s"'`()[\]{}<>.,;:*_#|-]+|[\s"'`()[\]{}<>.,;:*_#|-]+$/g, "");

/** Every phrase of 1 to 8 whitespace-separated words of `text` that is one of the forbidden hashes. */
function forbiddenPhrases(text) {
  const hits = [];
  for (const line of text.split(/\r?\n/)) {
    const words = line.split(/\s+/).filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      for (let len = 1; len <= 8 && i + len <= words.length; len++) {
        const phrase = trimEdges(words.slice(i, i + len).join(" ")).toLowerCase();
        if (phrase && FORBIDDEN.has(sha(phrase))) hits.push(`${hits.length + 1}: ${len} word(s) at word ${i}`);
      }
    }
  }
  return hits;
}

test("the guard itself finds a forbidden phrase: a synthetic stand-in, added to the list for this test only", () => {
  const probe = "lamp room ledger probe";
  FORBIDDEN.add(sha(probe));
  try {
    assert.equal(forbiddenPhrases(`before "Lamp Room Ledger Probe" after`).length, 1, "found inside quotes, whatever the case");
    assert.equal(forbiddenPhrases("nothing of the kind here").length, 0);
    assert.equal(forbiddenPhrases("lamp room ledger").length, 0, "a shorter run of the same words is not the phrase");
  } finally {
    FORBIDDEN.delete(sha(probe));
  }
  assert.equal(forbiddenPhrases(`before "Lamp Room Ledger Probe" after`).length, 0, "and the stand-in is gone again");
});

test("the reading files name no book: no level title, concept tag or badge label of one book is left in code or docs", () => {
  const files = [
    "frontend/src/lib/reading.ts",
    "frontend/src/lib/reading-practice.ts",
    "frontend/src/lib/reading-map.ts",
    "frontend/src/lib/reading-recall.ts",
    "frontend/src/lib/reading-bank.ts",
    "frontend/src/app/reading/ReadingClient.tsx",
    "frontend/src/app/reading/ChapterMap.tsx",
    "frontend/src/app/reading/PracticePart.tsx",
    "frontend/src/app/reading/PracticeRunner.tsx",
    "frontend/src/app/api/reading/idea-titles/route.ts",
    "sql/reading_book_theme.sql",
    "docs/reading-question-bank.md",
    "AGENTS.md",
  ];
  for (const f of files) assert.deepEqual(forbiddenPhrases(read(f)), [], `${f} still holds a word that belongs on a book's row`);
  const reading = read("frontend/src/lib/reading.ts");
  assert.doesNotMatch(reading, /\bLEVEL_TITLES\b/);
  assert.doesNotMatch(reading, /\bCONCEPTS\b/);
  assert.doesNotMatch(reading, /badge\("(herbie|bottleneck)"/, "badge keys name no character or concept either");
});

/* ------------------------------------------------------------------ */
/* Docs                                                                 */
/* ------------------------------------------------------------------ */

test("the docs and AGENTS.md say where a book's flavour lives", () => {
  const doc = read("docs/reading-question-bank.md");
  assert.match(doc, /pds\.books\.theme/);
  assert.match(doc, /sql\/reading_book_theme\.sql/);
  assert.match(doc, /GET \/api\/reading\/idea-titles/);
  const agents = read("AGENTS.md");
  assert.match(agents, /docs\/reading-question-bank\.md/, "AGENTS.md points at the question bank's doc");
  assert.match(agents, /pds\.books\.theme/, "and says the book's flavour is data");
  assert.match(agents, /sql\/reading_book_theme\.sql/);
});
