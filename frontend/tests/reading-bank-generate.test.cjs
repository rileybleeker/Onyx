// READ-QUIZ-01 S2: the generator, its triggers and the worker (lib/reading-bank-server.ts + the bank routes + the
// worker script). Offline: a fake Anthropic client and an in-memory stand-in for the bank's SQL functions
// (sql/reading_question_bank.sql contracts: plan input, enqueue, claim with reservation and caps, reserve, finish,
// set_map, store). Synthetic book only ("The Lighthouse Ledger", invented chapters, snippets and highlights).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { loadTs } = require("./helpers/load-ts.cjs");

const TITLE = "The Lighthouse Ledger";
const AUTHOR = "A. Synthetic Author";
const PASSAGE_MARKER = "SYNTHETIC-PASSAGE-MARKER";
const COMMENT_MARKER = "SYNTHETIC-COMMENT-MARKER";
const BOOK = 7;
const sha = (t) => crypto.createHash("sha256").update(t, "utf8").digest("hex");

function FakeAnthropic() {}
const B = loadTs("lib/reading-bank.ts");
const P = loadTs("lib/reading-bank-prompts.ts");
const REAL_RECALL = loadTs("lib/reading-recall-server.ts", { "server-only": {}, "@anthropic-ai/sdk": FakeAnthropic });

/* ------------------------------------------------------------------ */
/* An in-memory stand-in for the bank's SQL                            */
/* ------------------------------------------------------------------ */

const TOC = [
  { chapter: 1, title: "The Keeper Arrives", start_page: 1, end_page: 30 },
  { chapter: 2, title: "Fog Over the Bay", start_page: 31, end_page: 60 },
  { chapter: 3, title: "The Storm Log", start_page: 61, end_page: 90 },
  { chapter: 4, title: "Lamps and Ledgers", start_page: 91, end_page: 120 },
];

function makeDb(o = {}) {
  const db = {
    clock: Date.now(),
    schema: "ok", // "ok" | "checks" | "missing"
    book: { book_id: BOOK, slug: "lighthouse-ledger", title: TITLE, author: AUTHOR, total_chapters: 4, status: "reading" },
    toc: TOC.map((c) => ({ ...c })),
    through: 2,
    bb: { approved_at: "2031-03-01T00:00:00Z", approved_cents: 1900, spent_cents: 0, paused_at: null, paused_reason: null, mapping: "unknown", narrative: null, map_urls: [], toc_hash: null, map_rebuilds: 0 },
    chapters: new Map(),
    jobs: [],
    nextJob: 1,
    highlights: [
      { highlight_id: 55, book_id: BOOK, chapter: 2, passage: `${PASSAGE_MARKER} the bell must ring until the fog lifts`, comment: `${COMMENT_MARKER} private note`, location: "p. 40", archived: false },
    ],
    seen: new Set(),
    ideas: [],
    nextIdea: 1,
    sources: [],
    nextSource: 1,
    evidence: [],
    flags: [],
    sync: [],
    monthBase: 0,
    monthCap: 3000,
    rpc: [],
    stores: [],
    cleared: [],
    throwOn: null,
    /** A code pds.reading_bank_finish answers instead of finishing (a lease that was lost meanwhile). */
    refuseFinish: null,
    /** The next finish commits, but its answer never arrives (a transport error). */
    loseFinishAnswer: false,
    /** The next finish never commits: the lease ran out first and the claim settled the job (queued again, lease_expired). */
    expireOnFinish: false,
    ...o,
  };
  db.now = () => db.clock;
  db.tick = () => (db.clock += 1000);
  return db;
}

const chHash = (db, n) => (n === 0 ? B.chapterHash(0, "") : B.chapterHash(n, db.toc.find((c) => c.chapter === n)?.title ?? null));
const tocHashOf = (db) => B.tocHash(db.book.total_chapters, db.toc.map((c) => ({ chapter: c.chapter, title: c.title, start_position: c.chapter * 1000 })));
const running = (db) => db.jobs.filter((j) => j.status === "running" && j.lease_until >= db.clock);
const monthSpent = (db) => db.monthBase + db.jobs.reduce((s, j) => s + j.cost_cents, 0) + running(db).reduce((s, j) => s + j.reserved_cents, 0);

function planInput(db) {
  const bb = db.bb;
  const chapters = db.toc.map((c) => ({ chapter: c.chapter, title: c.title, start_page: c.start_page, end_page: c.end_page, chapter_hash: chHash(db, c.chapter) }));
  const cited = new Set(db.evidence.map((e) => db.sources.find((s) => s.source_id === e.source_id)).filter((s) => s && s.kind === "highlight" && db.ideas.find((i) => i.status === "active" && db.evidence.some((e) => e.idea_id === i.idea_id && e.source_id === s.source_id))).map((s) => `${s.highlight_id}|${s.passage_sha}`));
  return {
    book_id: BOOK, title: db.book.title, author: db.book.author, total_chapters: db.book.total_chapters, status: db.book.status,
    approved: !!bb?.approved_at, paused_reason: bb?.paused_reason ?? null, mapping: bb?.mapping ?? "unknown", narrative: bb?.narrative ?? null,
    map_urls: bb?.map_urls ?? [], toc_hash_stored: bb?.toc_hash ?? null, map_rebuilds: bb?.map_rebuilds ?? 0,
    toc_hash: tocHashOf(db), quiz_through: db.through, chapter0_hash: chHash(db, 0), chapters,
    bank: [...db.chapters.entries()].map(([chapter, c]) => ({ chapter, status: c.status, chapter_hash: c.chapter_hash ?? null, rebuilds: c.rebuilds ?? 0, built_rebuilds: c.built_rebuilds ?? 0, built_at: c.built_at ?? null, quizzable_since: c.quizzable_since ?? null })),
    jobs: db.jobs.filter((j) => j.step !== "grade").map((j) => ({ job_id: j.job_id, step: j.step, chapter: j.chapter, input_hash: j.input_hash, status: j.status, result: j.result })),
    highlights: db.highlights
      .filter((h) => !h.archived && !db.seen.has(`${h.highlight_id}|${sha(h.passage)}`) && !cited.has(`${h.highlight_id}|${sha(h.passage)}`))
      .map((h) => ({ highlight_id: h.highlight_id, chapter: h.chapter, passage_sha: sha(h.passage) })),
  };
}

function addJob(db, j) {
  const job = {
    job_id: db.nextJob++, book_id: BOOK, step: j.step, chapter: j.chapter ?? 0, input_hash: j.input_hash, prompt_version: j.prompt_version ?? P.BANK_PROMPT_VERSION,
    attempt_key: j.attempt_key ?? null, status: j.status ?? "queued", priority: j.priority ?? 100, attempts: j.attempts ?? 0, next_attempt_at: j.next_attempt_at ?? db.clock,
    lease_until: j.lease_until ?? null, reserved_cents: j.reserved_cents ?? 0, cost_cents: j.cost_cents ?? 0, usage: null, result: j.result ?? null, counts: null,
    output: j.output ?? null, store_receipt: j.store_receipt ?? null, error_code: j.error_code ?? null, created_at: j.created_at ?? new Date(db.clock).toISOString(),
  };
  db.jobs.push(job);
  return job;
}

function rpcs(db) {
  const book = () => db.bb;
  const R = {
    reading_bank_schema_ok: () => ({ all_ok: db.schema === "ok", source_kind_idea: db.schema === "ok", grader_local: db.schema === "ok", idea_source_branch: true, export_gate: true }),
    reading_bank_plan_input: ({ p_book }) => (p_book === BOOK ? planInput(db) : null),
    reading_bank_book_id: () => BOOK,
    reading_bank_overview: () => ({
      book_id: BOOK, total_chapters: db.book.total_chapters, quiz_through: db.through,
      enabled: !!db.bb?.approved_at && db.bb?.paused_reason !== "owner", approved_cents: db.bb?.approved_cents ?? null,
      spent_cents: db.bb?.spent_cents ?? 0, paused_reason: db.bb?.paused_reason ?? null, mapping: db.bb?.mapping ?? "unknown", chapters: [],
    }),
    reading_bank_chapter: ({ p_chapter }) => (p_chapter > db.through ? null : { chapter: p_chapter, title: null, status: "ready", ideas: [], flags: [] }),
    reading_bank_enqueue: ({ p }) => {
      for (const q of p.quizzable ?? []) if (q >= 1 && q <= db.through) {
        const c = db.chapters.get(q) ?? { status: "pending", rebuilds: 0, built_rebuilds: 0 };
        c.quizzable_since = c.quizzable_since ?? "2031-03-10";
        db.chapters.set(q, c);
      }
      for (const id of p.skip_jobs ?? []) {
        const j = db.jobs.find((x) => x.job_id === id && x.status === "queued");
        if (j) j.status = "skipped";
      }
      let n = 0;
      for (const j of p.jobs ?? []) {
        const ex = db.jobs.find((x) => x.step === j.step && x.chapter === j.chapter && x.input_hash === j.input_hash);
        if (!ex) {
          addJob(db, j);
          n++;
        } else if (ex.status === "skipped") {
          Object.assign(ex, { status: "queued", attempts: 0, next_attempt_at: db.clock, error_code: null, priority: j.priority });
          n++;
        }
      }
      return n;
    },
    reading_bank_claim: ({ p }) => {
      for (const j of db.jobs.filter((x) => x.status === "running" && x.lease_until < db.clock)) {
        j.cost_cents += j.reserved_cents;
        if (j.step !== "grade") book().spent_cents += j.reserved_cents;
        Object.assign(j, { status: j.attempts >= 3 ? "failed" : "queued", error_code: "lease_expired", lease_until: null, reserved_cents: 0 });
      }
      const busy = (j) => db.jobs.some((r) => r !== j && r.step !== "grade" && r.status === "running" && r.lease_until >= db.clock);
      const cands = db.jobs
        .filter((j) => j.status === "queued" && j.next_attempt_at <= db.clock && (!p.job_id || j.job_id === p.job_id) && (!p.steps || p.steps.includes(j.step)))
        .filter((j) => j.step === "grade" || (book()?.approved_at && !book()?.paused_at))
        .filter((j) => j.step === "grade" || !busy(j))
        .sort((a, b) => a.priority - b.priority || a.job_id - b.job_id);
      const job = cands[0];
      if (!job) return { ok: true, job: null };
      const est = p.estimates?.[job.step] ?? 50;
      const month = monthSpent(db);
      if (month + est > p.month_cap_cents) return { ok: true, job: null, code: "monthly_cap" };
      let head = p.month_cap_cents - month;
      if (job.step !== "grade") {
        const used = book().spent_cents + running(db).reduce((s, r) => s + r.reserved_cents, 0);
        if (used + est > book().approved_cents) {
          Object.assign(book(), { paused_at: new Date(db.clock).toISOString(), paused_reason: "budget" });
          return { ok: true, job: null, code: "budget", book_id: BOOK };
        }
        head = Math.min(head, book().approved_cents - used);
      }
      Object.assign(job, { status: "running", attempts: job.attempts + 1, lease_until: db.clock + p.lease_seconds * 1000, reserved_cents: est });
      return { ok: true, job: structuredClone(job), headroom_cents: Math.max(head, est) };
    },
    reading_bank_reserve: ({ p }) => {
      const j = db.jobs.find((x) => x.job_id === p.job_id);
      if (!j || j.status !== "running" || j.lease_until < db.clock) return { ok: false, http: 409, code: "not_running" };
      if (p.attempts !== j.attempts) return { ok: false, http: 409, code: "lease_lost" };
      const total = Math.round(p.total_cents * 100) / 100;
      if (total <= j.reserved_cents) return { ok: true, reserved_cents: j.reserved_cents };
      const delta = total - j.reserved_cents;
      if (monthSpent(db) + delta > p.month_cap_cents) return { ok: false, http: 409, code: "monthly_cap" };
      if (j.step !== "grade") {
        const used = book().spent_cents + running(db).reduce((s, r) => s + r.reserved_cents, 0);
        if (used + delta > book().approved_cents) {
          Object.assign(book(), { paused_at: new Date(db.clock).toISOString(), paused_reason: "budget" });
          return { ok: false, http: 409, code: "budget", book_id: BOOK };
        }
      }
      j.reserved_cents = total;
      return { ok: true, reserved_cents: total };
    },
    reading_bank_finish: ({ p }) => {
      const j = db.jobs.find((x) => x.job_id === p.job_id);
      if (!j) return { ok: false, http: 404, code: "not_found" };
      if (db.refuseFinish) return { ok: false, http: 409, code: db.refuseFinish };
      if (db.expireOnFinish && j.status === "running") {
        db.expireOnFinish = false;
        j.cost_cents += j.reserved_cents;
        if (j.step !== "grade") book().spent_cents += j.reserved_cents;
        Object.assign(j, { status: j.attempts >= 3 ? "failed" : "queued", error_code: "lease_expired", lease_until: null, reserved_cents: 0 });
        db.clock += 10 * 60000; // the lease ran out: time has passed, so the run's own deadline is over too
        throw Object.assign(new Error("synthetic transport error"), { code: "08006" });
      }
      if (j.status !== "running") return { ok: false, http: 409, code: "not_running" };
      if (p.attempts !== j.attempts) return { ok: false, http: 409, code: "lease_lost" };
      const status = p.outcome === "retry" ? (j.attempts >= 3 ? "failed" : "queued") : p.outcome;
      Object.assign(j, {
        status, lease_until: null, reserved_cents: 0, cost_cents: j.cost_cents + (p.cost_cents ?? 0), usage: p.usage ?? j.usage,
        result: p.result ?? j.result, counts: p.counts ?? j.counts, output: p.output ?? j.output, error_code: p.error_code ?? null,
        next_attempt_at: p.outcome === "retry" ? db.clock + (p.retry_minutes ?? 30) * 60000 : j.next_attempt_at,
      });
      if (j.step !== "grade") book().spent_cents += p.cost_cents ?? 0;
      if ((j.step === "build" || j.step === "research") && status === "failed") {
        const c = db.chapters.get(j.chapter) ?? { status: "pending", rebuilds: 0, built_rebuilds: 0 };
        if (c.status === "pending") c.status = "failed";
        db.chapters.set(j.chapter, c);
      }
      if (db.loseFinishAnswer) {
        db.loseFinishAnswer = false;
        throw Object.assign(new Error("synthetic transport error"), { code: "08006" });
      }
      return { ok: true, status };
    },
    reading_bank_set_map: ({ p }) => {
      Object.assign(book(), { mapping: p.mapping, narrative: p.narrative, source_chapter_count: p.source_chapter_count, map_urls: p.map_urls, toc_hash: p.toc_hash });
      return { ok: true };
    },
    reading_bank_store: ({ p }) => {
      const j = db.jobs.find((x) => x.job_id === p.job_id);
      if (!j || !["build", "highlights"].includes(j.step) || j.chapter !== p.chapter) return { ok: false, http: 409, code: "job_mismatch" };
      if (j.store_receipt) return { ...j.store_receipt, replayed: true };
      if (p.chapter_hash !== chHash(db, p.chapter)) return { ok: false, http: 409, code: "chapter_changed" };
      for (const s of p.sources) {
        if (s.kind === "highlight") {
          const h = db.highlights.find((x) => x.highlight_id === s.highlight_id && !x.archived);
          if (!h || sha(h.passage) !== s.passage_sha) return { ok: false, http: 409, code: "highlight_changed" };
        }
      }
      db.stores.push(structuredClone(p));
      const hash = chHash(db, p.chapter);
      const keep = p.replace && p.ideas.length === 0 && db.ideas.some((i) => i.chapter === p.chapter && i.status === "active" && i.chapter_hash === hash);
      if (p.replace && !keep) for (const i of db.ideas) if (i.chapter === p.chapter && i.status === "active") i.status = "retired";
      const map = {};
      for (const s of p.sources) {
        const row = { source_id: db.nextSource++, kind: s.kind, url: s.url ?? null, cited_text: s.cited_text ?? null, highlight_id: s.highlight_id ?? null, passage_sha: s.passage_sha ?? null };
        db.sources.push(row);
        map[s.ref] = row.source_id;
      }
      for (const s of p.seen ?? []) db.seen.add(`${s.highlight_id}|${s.passage_sha}`);
      let ideas = 0;
      let questions = 0;
      for (const i of p.ideas) {
        if (!i.evidence.length || i.evidence.some((e) => !map[e])) throw Object.assign(new Error("OXB05"), { code: "OXB05" });
        const row = { idea_id: db.nextIdea++, book_id: BOOK, chapter: p.chapter, unlock_chapter: i.unlock_chapter, chapter_hash: hash, title: i.title, statement: i.statement, importance: i.importance, status: "active" };
        db.ideas.push(row);
        for (const e of i.evidence) db.evidence.push({ idea_id: row.idea_id, source_id: map[e] });
        ideas++;
        questions += i.questions.length;
      }
      for (const l of p.links ?? []) db.evidence.push({ idea_id: l.idea_id, source_id: map[l.source_ref] });
      const prev = db.chapters.get(p.chapter) ?? { rebuilds: 0, built_rebuilds: 0 };
      db.chapters.set(p.chapter, { ...prev, status: keep ? prev.status ?? "ready" : p.status ?? prev.status ?? "ready", chapter_hash: hash, built_rebuilds: p.replace ? p.rebuilds : prev.built_rebuilds, built_at: "2031-03-10T15:00:00Z" });
      const receipt = { ok: true, ideas, questions, kept_existing: keep };
      j.store_receipt = receipt;
      return { ...receipt, replayed: false };
    },
    reading_bank_approve: ({ p }) => {
      db.bb = { ...(db.bb ?? {}), approved_at: p.on ? "2031-03-10T15:00:00Z" : db.bb?.approved_at ?? null, approved_cents: p.on ? p.cap_cents : db.bb?.approved_cents ?? null, paused_at: p.on ? null : "x", paused_reason: p.on ? null : "owner", spent_cents: db.bb?.spent_cents ?? 0 };
      return { ok: true, on: p.on, cap_cents: p.cap_cents };
    },
    // pds.reading_bank_rebuild: decided, counted and enqueued in one call (the claim lock makes it atomic; here one
    // synchronous step does).
    reading_bank_rebuild: ({ p }) => {
      const c = db.chapters.get(p.chapter) ?? { status: "pending", rebuilds: 0, built_rebuilds: 0 };
      const steps = p.chapter === 0 ? ["map", "build"] : ["research", "build"];
      const open = db.jobs.some((j) => j.chapter === p.chapter && steps.includes(j.step) && ["queued", "running"].includes(j.status));
      if (open || (p.expected != null && p.expected !== (c.rebuilds ?? 0))) return { ok: true, pending: true, chapter: p.chapter, rebuilds: c.rebuilds ?? 0 };
      c.rebuilds = (c.rebuilds ?? 0) + 1;
      db.chapters.set(p.chapter, c);
      if (p.chapter === 0) db.bb.map_rebuilds = (db.bb.map_rebuilds ?? 0) + 1;
      const enqueued = p.plan ? R.reading_bank_enqueue({ p: p.plan }) : undefined;
      return { ok: true, pending: false, chapter: p.chapter, rebuilds: c.rebuilds, map_rebuilds: p.chapter === 0 ? db.bb.map_rebuilds : null, enqueued };
    },
    reading_clear_question_answers: ({ p_days }) => (db.cleared.push(p_days), 3),
  };
  return R;
}

const MISSING = { code: "PGRST202", message: "function not found" };
/** Timestamps compare as instants whether a row holds epoch ms (the fake's own) or an ISO string (as sent). */
const instant = (x) => (typeof x === "string" && /^\d{4}-\d{2}-\d{2}T/.test(x) ? Date.parse(x) : x);

function fakeSupabase(db) {
  const R = rpcs(db);
  const tables = {
    sync_log: () => db.sync,
    book_highlights: () => db.highlights,
    reading_ideas: () => db.ideas,
    reading_question_flags: () => db.flags,
    reading_bank_jobs: () => db.jobs,
    reading_bank_books: () => (db.bb ? [{ book_id: BOOK, ...db.bb }] : []),
    reading_idea_state: () => [],
    reading_idea_evidence: () => db.evidence,
    reading_bank_sources: () => db.sources,
  };
  return {
    rpc: (name, args) => {
      const run = () => {
        db.tick();
        db.rpc.push(name);
        if (db.throwOn === name) throw new Error("synthetic rpc failure");
        if (db.schema === "missing") return { data: null, error: MISSING };
        if (!R[name]) throw new Error(`unexpected rpc ${name}`);
        try {
          return { data: structuredClone(R[name](structuredClone(args ?? {}))), error: null };
        } catch (e) {
          if (e && e.code) return { data: null, error: { code: e.code, message: "synthetic" } };
          throw e;
        }
      };
      return { then: (yes, no) => Promise.resolve().then(run).then(yes, no) };
    },
    from: (name) => {
      const filters = [];
      const orders = [];
      let limit = null;
      let range = null;
      let single = false;
      let insertRow = null;
      const run = () => {
        db.tick();
        if (db.schema === "missing" && name !== "sync_log") return { data: null, error: { code: "42P01" } };
        if (!tables[name]) throw new Error(`unexpected table ${name}`);
        if (insertRow) {
          if (name !== "sync_log") throw new Error(`insert on ${name}`);
          db.sync.push({ ...insertRow });
          return { data: null, error: null };
        }
        let list = tables[name]().filter((r) => filters.every((f) => f(r)));
        for (const [col, asc] of [...orders].reverse()) list = [...list].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (asc ? 1 : -1));
        if (range) list = list.slice(range[0], range[1] + 1);
        if (limit != null) list = list.slice(0, limit);
        list = structuredClone(list);
        return single ? { data: list[0] ?? null, error: null } : { data: list, error: null };
      };
      const q = {
        select: () => q,
        eq: (c, v) => (filters.push((r) => r[c] === v), q),
        neq: (c, v) => (filters.push((r) => r[c] !== v), q),
        in: (c, vs) => (filters.push((r) => vs.includes(r[c])), q),
        lt: (c, v) => (filters.push((r) => instant(r[c]) < instant(v)), q),
        lte: (c, v) => (filters.push((r) => instant(r[c]) <= instant(v)), q),
        gt: (c, v) => (filters.push((r) => instant(r[c]) > instant(v)), q),
        gte: (c, v) => (filters.push((r) => instant(r[c]) >= instant(v)), q),
        is: (c, v) => (filters.push((r) => (r[c] ?? null) === v), q),
        not: (c, op, v) => (filters.push((r) => (op === "is" ? (r[c] ?? null) !== v : true)), q),
        order: (c, o) => (orders.push([c, o?.ascending !== false]), q),
        limit: (n) => ((limit = n), q),
        range: (a, b) => ((range = [a, b]), q),
        maybeSingle: () => ((single = true), q),
        insert: (row) => ((insertRow = row), q),
        then: (yes, no) => Promise.resolve().then(run).then(yes, no),
      };
      return q;
    },
  };
}

/* ------------------------------------------------------------------ */
/* A fake model                                                         */
/* ------------------------------------------------------------------ */

const usage = (o = {}) => ({ input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: null, ...o });
const textMsg = (content, o = {}) => ({ model: "claude-sonnet-5-5", stop_reason: "end_turn", content, usage: usage(), ...o });
const jsonMsg = (json, o = {}) => textMsg([{ type: "text", text: JSON.stringify(json) }], o);
const cite = (url, cited_text, title = "Synthetic guide") => ({ type: "web_search_result_location", url, title, cited_text, encrypted_index: "x" });

const GUIDE = "https://guides.example.org/ledger";
const SNIPPET_1 = "The second chapter shows the keeper recording every passing ship in a ledger beside the lamp room.";
const SNIPPET_2 = "Fog closes the bay for nine days, and the keeper rings the bell each hour through the night.";

const chapterOf = (user) => {
  const m = /"chapter":(\d+)/.exec(user);
  return m ? Number(m[1]) : 0;
};

const DEFAULT_HANDLERS = {
  map1: () =>
    textMsg([
      { type: "text", text: "A chapter guide lists four chapters with the titles of the table of contents.", citations: [cite(`${GUIDE}/guide`, "A guide to the four chapters: The Keeper Arrives, Fog Over the Bay, The Storm Log, Lamps and Ledgers.")] },
      { type: "text", text: "It is nonfiction about keeping records.", citations: [cite(`${GUIDE}/about`, "A nonfiction account of keeping records at a light station.")] },
      { type: "text", text: "An uncited sentence that must be thrown away." },
    ], { usage: usage({ server_tool_use: { web_search_requests: 2 } }) }),
  map2: () =>
    jsonMsg({
      narrative: false,
      chapter_count: 4,
      chapters: TOC.map((c) => ({ chapter: c.chapter, title: c.title })),
      sources: [
        { url: `${GUIDE}/guide`, scope: "per_chapter" },
        { url: "https://invented.example.com/not-cited", scope: "per_chapter" },
        { url: `${GUIDE}/about`, scope: "whole_book" },
      ],
    }),
  research: () =>
    textMsg([
      { type: "web_fetch_tool_result", tool_use_id: "t1", content: { type: "web_fetch_tool_error", error_code: "url_not_accessible" } },
      { type: "text", text: "The keeper logs ships by the lamp.", citations: [cite(`${GUIDE}/guide`, SNIPPET_1)] },
      { type: "text", text: "Fog shuts the bay and the bell is rung.", citations: [cite(`${GUIDE}/fog`, SNIPPET_2, "Synthetic fog guide")] },
      { type: "text", text: "A sentence with no citation." },
      { type: "text", text: "UNSURE: nothing" },
    ], { usage: usage({ server_tool_use: { web_search_requests: 1 } }) }),
  structure: (params) => {
    const n = chapterOf(params.messages[0].content);
    return jsonMsg({
      ideas: [{
        kind: "concept", importance: "core", title: `Keeper log part ${n}`, statement: `The keeper keeps a written record in chapter ${n}.`,
        key_points: ["Each ship is noted"], facts: [], support: ["E1"], placement: "this_chapter",
        questions: [{ format: "cued", prompt: "What does the keeper use to note passing ships?", answer: "a ledger", accept: ["the ledger"], options: [], correct_index: -1, steps: [], points: [], explanation: "The record is kept daily." }],
      }],
      highlight_links: [],
      rejected: 0,
    });
  },
  verify: (params) => {
    const material = JSON.parse(params.messages[0].content.split("<material>\n")[1].split("\n</material>")[0]);
    return jsonMsg({ ideas: material.map((m) => ({ index: m.index, supported: "yes", placement: "this", later_content: false, questions: m.questions.map((q) => ({ index: q.index, ok: true, problem: "none" })) })) });
  },
  highlights: () => jsonMsg({ links: [], ideas: [] }),
};

function fakeModel(handlers = {}) {
  const h = { ...DEFAULT_HANDLERS, ...handlers };
  const calls = [];
  const roleOf = (system) => {
    if (system === P.MAP_SYSTEM) return "map1";
    if (system === P.MAP_STRUCT_SYSTEM) return "map2";
    if (system === P.RESEARCH_SYSTEM) return "research";
    if (system === P.STRUCTURE_SYSTEM) return "structure";
    if (system === P.VERIFY_SYSTEM) return "verify";
    if (system === P.HIGHLIGHTS_SYSTEM) return "highlights";
    return "unknown";
  };
  const client = {
    beta: {
      messages: {
        stream(params) {
          const role = roleOf(params.system?.[0]?.text);
          calls.push({ role, params: structuredClone(params) });
          return {
            finalMessage: async () => {
              const r = h[role] ? h[role](params) : null;
              if (r && r.__throw) throw r.__throw;
              return r;
            },
          };
        },
      },
    },
  };
  return { client, calls };
}

/* ------------------------------------------------------------------ */
/* Loading the server module and routes                                 */
/* ------------------------------------------------------------------ */

function load(db, model = fakeModel(), o = {}) {
  const supabase = fakeSupabase(db);
  const queue = [];
  const grades = [];
  const repairs = [];
  const recall = {
    ...REAL_RECALL,
    runGradeJob: async (_s, claim) => {
      grades.push(claim.job.job_id);
      return { outcome: "done", code: null, graded: true, cost_cents: 1 };
    },
    repairDirtyStates: async () => (repairs.push(1), { repaired: o.repaired ?? 0, raced: 0, failed: 0 }),
  };
  const stubs = {
    "server-only": {},
    "@anthropic-ai/sdk": FakeAnthropic,
    "./reading-recall-server": recall,
    "@/lib/reading-recall-server": recall,
    "next/server": {
      NextResponse: { json: (body, init) => ({ status: init?.status ?? 200, body, headers: init?.headers ?? {} }) },
      after: (fn) => queue.push(fn),
    },
    "@supabase/supabase-js": { createClient: () => supabase },
  };
  const S = loadTs("lib/reading-bank-server.ts", stubs);
  stubs["@/lib/reading-bank-server"] = S;
  return { S, supabase, queue, grades, repairs, model, stubs, opts: { client: model.client, now: db.now } };
}

const kick = (env, o = {}) => env.S.kickBank(env.supabase, { bookId: BOOK, reason: "kindle", ...env.opts, ...o });

/** Mark every chapter but `except` as built for the current edition, and the map as current. */
function seedBuilt(db, except = []) {
  db.bb.mapping = "ok";
  db.bb.toc_hash = tocHashOf(db);
  db.bb.map_urls = [`${GUIDE}/guide`];
  for (const c of db.toc) {
    if (except.includes(c.chapter)) continue;
    db.chapters.set(c.chapter, { status: "ready", chapter_hash: chHash(db, c.chapter), rebuilds: 0, built_rebuilds: 0, built_at: "2031-03-01T00:00:00Z", quizzable_since: null });
  }
}
const researchOutput = () => ({
  v: 1,
  notes: [{ text: "The keeper logs ships by the lamp.", sources: [0] }, { text: "Fog shuts the bay.", sources: [1] }],
  sources: [
    { url: `${GUIDE}/guide`, domain: "example.org", title: "Synthetic guide", cited_text: SNIPPET_1 },
    { url: `${GUIDE}/fog`, domain: "example.org", title: "Synthetic fog guide", cited_text: SNIPPET_2 },
  ],
  unsure: "",
});

/* ------------------------------------------------------------------ */
/* map                                                                  */
/* ------------------------------------------------------------------ */

test("map: two calls (web tools, then JSON without tools), only cited URLs kept, mapping ok, notes stored", async () => {
  const db = makeDb();
  const env = load(db);
  const r = await kick(env, { steps: ["map"] });
  assert.equal(r.ran, true);
  assert.equal(r.claimed, 1);
  const [c1, c2] = env.model.calls;
  assert.deepEqual([c1.role, c2.role], ["map1", "map2"]);
  assert.deepEqual(c1.params.tools.map((t) => [t.type, t.max_uses]), [["web_search_20260209", 6], ["web_fetch_20260209", 3]]);
  assert.equal(c1.params.tools[1].max_content_tokens, 12000);
  assert.equal(c2.params.tools, undefined, "the JSON call has no tools");
  assert.equal(c2.params.output_config.format.type, "json_schema");
  assert.equal(db.bb.mapping, "ok");
  assert.equal(db.bb.narrative, false);
  assert.deepEqual(db.bb.map_urls, [`${GUIDE}/guide`, `${GUIDE}/about`], "an uncited URL from the JSON call is dropped; per-chapter first");
  assert.equal(db.bb.toc_hash, tocHashOf(db));
  const job = db.jobs.find((j) => j.step === "map");
  assert.equal(job.status, "done");
  assert.equal(job.error_code, null);
  assert.equal(job.output.notes.length, 2, "the uncited sentence is not stored");
  assert.ok(job.cost_cents > 0 && db.bb.spent_cents === job.cost_cents);
});

test("mapVerdict: count and title checks; unknown counts are uncertain", () => {
  const env = load(makeDb());
  const input = { total_chapters: 4, chapters: TOC.map((c) => ({ chapter: c.chapter, title: c.title })) };
  const map = (chapters, count = 4) => ({ narrative: false, chapter_count: count, chapters, sources: [] });
  assert.equal(env.S.mapVerdict(map(TOC.map((c) => ({ chapter: c.chapter, title: `Chapter ${c.chapter}: ${c.title}` }))), input), "ok");
  assert.equal(env.S.mapVerdict(map(TOC.map((c) => ({ chapter: c.chapter, title: c.title })), 5), input), "uncertain", "another chapter count");
  assert.equal(env.S.mapVerdict(map([{ chapter: 1, title: "Something Else" }, { chapter: 2, title: "Other" }, { chapter: 3, title: "The Storm Log" }, { chapter: 4, title: "Lamps and Ledgers" }]), input), "uncertain", "2 of 4 titles");
  assert.equal(env.S.mapVerdict(null, input), "uncertain");
  assert.equal(env.S.mapVerdict(map([]), { total_chapters: 0, chapters: [] }), "uncertain");
  assert.equal(env.S.titlesMatch("Part 2 - Fog over the bay", "Fog Over the Bay"), true);
  assert.equal(env.S.titlesMatch("Chapter IV. Fog Over the Bay", "Fog Over the Bay"), true, "a Roman numeral prefix is removed");
});

test("titlesMatch removes a chapter / part prefix only when the next word is a number, not an ordinary word that looks like one", () => {
  const env = load(makeDb());
  // "Book Value" must keep "book": with the old pattern it became "alue", which sits inside "value chains".
  assert.equal(env.S.titlesMatch("Book Value", "Value Chains"), false);
  assert.equal(env.S.titlesMatch("Part Lighthouse Keepers", "Lighthouse Keepers"), true, "the title is still found inside the longer one");
  assert.equal(env.S.titlesMatch("Section Civil Law", "Section Civil Law"), true);
  assert.equal(env.S.titlesMatch("Section Civil Law", "Law"), false, "'civil' is a word here, not a numeral: it is not stripped");
  assert.equal(env.S.titlesMatch("Part xiv the lamp", "The Lamp"), true);
});

test("a map that cites nothing leaves the mapping uncertain (highlights only) without a second call", async () => {
  const db = makeDb();
  const env = load(db, fakeModel({ map1: () => textMsg([{ type: "text", text: "Nothing could be confirmed." }]) }));
  await kick(env, { steps: ["map"] });
  assert.deepEqual(env.model.calls.map((c) => c.role), ["map1"]);
  assert.equal(db.bb.mapping, "uncertain");
  assert.deepEqual(db.bb.map_urls, []);
  assert.equal(db.jobs[0].result, "no_sources");
  assert.equal(db.sync.at(-1).status, "partial", "uncertain mapping is partial");
});

/* ------------------------------------------------------------------ */
/* research                                                             */
/* ------------------------------------------------------------------ */

test("research: citations become sources, uncited sentences are thrown away, a web tool error object does not stop it", async () => {
  const db = makeDb();
  seedBuilt(db, [2]);
  const env = load(db);
  await kick(env);
  const job = db.jobs.find((j) => j.step === "research" && j.chapter === 2);
  assert.equal(job.status, "done");
  assert.equal(job.result, "ready");
  assert.deepEqual(job.output.sources.map((s) => s.url), [`${GUIDE}/guide`, `${GUIDE}/fog`]);
  assert.ok(job.output.sources.every((s) => s.cited_text.length <= 300));
  assert.equal(job.output.notes.length, 2, "the uncited sentence is dropped");
  assert.equal(job.counts.tool_errors, 1, "the fetch error object is counted and skipped");
  const call = env.model.calls.find((c) => c.role === "research");
  assert.ok(call.params.messages[0].content.includes(`${GUIDE}/guide`), "the map URLs are in the user turn (web_fetch can open them)");
  assert.deepEqual(call.params.tools.map((t) => t.max_uses), [2, 2]);
  // Research done -> the book is planned again and the build runs in the same kick (it was the run's second claim, with
  // a build's 225 s still left).
  assert.ok(db.jobs.some((j) => j.step === "build" && j.chapter === 2 && j.status === "done"));
});

test("research that finds only tool errors is done with no_sources (the build then rests on highlights)", async () => {
  const db = makeDb();
  seedBuilt(db, [2]);
  const env = load(db, fakeModel({ research: () => textMsg([{ type: "web_search_tool_result", tool_use_id: "s", content: { type: "web_search_tool_result_error", error_code: "unavailable" } }]) }));
  await kick(env);
  const job = db.jobs.find((j) => j.step === "research");
  assert.equal(job.status, "done");
  assert.equal(job.result, "no_sources");
});

test("a research call after a max_tokens failure halves its web tool uses", async () => {
  const db = makeDb();
  seedBuilt(db, [2]);
  const v = P.BANK_PROMPT_VERSION;
  addJob(db, { step: "research", chapter: 2, input_hash: B.researchInputHash(v, chHash(db, 2), db.bb.map_urls, 0), priority: 20, attempts: 1, error_code: "max_tokens" });
  const env = load(db);
  await kick(env);
  assert.deepEqual(env.model.calls.find((c) => c.role === "research").params.tools.map((t) => t.max_uses), [1, 1]);
});

/* ------------------------------------------------------------------ */
/* build                                                                */
/* ------------------------------------------------------------------ */

function seedBuild(db) {
  seedBuilt(db, [2]);
  const research = addJob(db, { step: "research", chapter: 2, input_hash: B.researchInputHash(P.BANK_PROMPT_VERSION, chHash(db, 2), db.bb.map_urls, 0), status: "done", result: "ready", output: researchOutput(), attempts: 1 });
  return research;
}

const BUILD_STRUCTURE = {
  ideas: [
    {
      kind: "concept", importance: "core", title: "Ledger of passing ships", statement: "The keeper writes down each ship that passes, using a log near the lamp.",
      key_points: ["Each ship is recorded", "The log sits near the lamp"], facts: [], support: ["E1"], placement: "this_chapter",
      questions: [
        { format: "cued", prompt: "What does the keeper use to record passing ships?", answer: "a ledger", accept: ["the ledger", "log book"], options: ["a ledger", "a map", "a bell", "a lamp"], correct_index: 0, steps: [], points: [], explanation: "The record is the chapter's habit." },
        { format: "explain", prompt: "Explain in your own words why the keeper keeps a record of ships.", answer: "", accept: [], options: [], correct_index: -1, steps: [], points: [{ text: "Every passing ship is noted", must: true }, { text: "The record is kept by the lamp", must: false }], explanation: "" },
      ],
    },
    {
      kind: "event", importance: "supporting", title: "Nine days of fog", statement: "Fog shuts the bay for over a week and the bell is rung hourly.",
      key_points: ["The bay is closed by fog"], facts: [{ claim: "Length of the fog", value: "nine days", exact: true }], support: ["E2"], placement: "this_chapter",
      questions: [{ format: "cued", prompt: "How long does the fog close the bay?", answer: "nine days", accept: ["9 days"], options: [], correct_index: -1, steps: [], points: [], explanation: "" }],
    },
    {
      kind: "lesson", importance: "detail", title: "Bell rings hourly", statement: "The bell is rung every hour while the fog stays.",
      key_points: ["Bell every hour"], facts: [], support: [], placement: "this_chapter",
      questions: [{ format: "cued", prompt: "How often is the bell rung during the fog?", answer: "every hour", accept: ["hourly"], options: [], correct_index: -1, steps: [], points: [], explanation: "" }],
    },
  ],
  highlight_links: [{ highlight: "H55", idea_index: 2 }],
  rejected: 1,
};
const BUILD_VERIFY = {
  ideas: [
    { index: 0, supported: "yes", placement: "this", later_content: false, questions: [{ index: 0, ok: true, problem: "none" }, { index: 1, ok: false, problem: "ambiguous" }] },
    { index: 1, supported: "partly", placement: "this", later_content: false, questions: [{ index: 0, ok: true, problem: "none" }] },
    { index: 2, supported: "yes", placement: "unsure", later_content: false, questions: [{ index: 0, ok: true, problem: "none" }] },
  ],
};

test("build: Opus structure (no tools) -> Sonnet verify -> code gates -> one store; verify can only take things away", async () => {
  const db = makeDb();
  seedBuild(db);
  const env = load(db, fakeModel({ structure: () => jsonMsg(BUILD_STRUCTURE), verify: () => jsonMsg(BUILD_VERIFY) }));
  await kick(env);
  const s = env.model.calls.find((c) => c.role === "structure");
  const v = env.model.calls.find((c) => c.role === "verify");
  assert.equal(s.params.model, "claude-opus-5-5");
  assert.equal(s.params.tools, undefined);
  assert.equal(s.params.output_config.format.type, "json_schema");
  assert.equal(v.params.model, "claude-sonnet-5-5");
  assert.ok(v.params.messages[0].content.includes('"H55"'), "the merged highlight link is shown to the verifier as support");
  assert.equal(db.stores.length, 1);
  const p = db.stores[0];
  assert.equal(p.replace, true);
  assert.deepEqual(p.ideas.map((i) => i.title), ["Ledger of passing ships", "Bell rings hourly"], "the partly supported idea is not stored");
  assert.equal(p.ideas[0].questions.length, 1, "the question verify rejected is not stored");
  assert.equal(p.ideas[1].unlock_chapter, 4, "an unsure placement unlocks at the end of the book");
  assert.deepEqual(p.ideas[1].evidence, ["H55"]);
  assert.equal(p.ideas[1].origin, "highlight");
  assert.ok(p.sources.some((x) => x.kind === "highlight" && x.passage_sha === sha(db.highlights[0].passage)));
  assert.ok(p.seen.some((x) => x.highlight_id === 55));
  const job = db.jobs.find((j) => j.step === "build");
  assert.equal(job.status, "done");
  assert.equal(job.result, "thin", "2 kept of a target of 9");
  assert.equal(job.counts.reasons.partly_supported, 1);
  assert.equal(job.counts.reasons.q_not_ok, 1);
  assert.equal(db.sync.at(-1).status, "partial", "a thin chapter makes the heartbeat partial");
  assert.match(db.sync.at(-1).error_message, /ch 2 thin 2\/9 ideas 2 q/);
});

test("build with nothing to cite makes no model call and stores no_sources", async () => {
  const db = makeDb({ highlights: [] });
  seedBuilt(db, [2]);
  db.bb.mapping = "uncertain";
  const env = load(db);
  await kick(env);
  assert.equal(env.model.calls.length, 0);
  assert.equal(db.stores.length, 1);
  assert.equal(db.stores[0].status, "no_sources");
  assert.equal(db.jobs.find((j) => j.step === "build").cost_cents, 0);
});

test("a re-claimed build whose batch was already stored finishes without a model call", async () => {
  const db = makeDb();
  const research = seedBuild(db);
  addJob(db, { step: "build", chapter: 2, input_hash: B.buildInputHash(P.BANK_PROMPT_VERSION, chHash(db, 2), research.job_id, 0), priority: 20, store_receipt: { ok: true, ideas: 3, questions: 5, kept_existing: false } });
  const env = load(db);
  await kick(env);
  assert.equal(env.model.calls.length, 0);
  assert.equal(db.jobs.find((j) => j.step === "build").status, "done");
});

test("a build planned for another table of contents is skipped, not run", async () => {
  const db = makeDb();
  seedBuild(db);
  addJob(db, { step: "build", chapter: 2, input_hash: "0".repeat(64), priority: 1 });
  const env = load(db);
  await kick(env);
  const stale = db.jobs.find((j) => j.input_hash === "0".repeat(64));
  assert.equal(stale.status, "skipped");
});

/* ------------------------------------------------------------------ */
/* failures                                                             */
/* ------------------------------------------------------------------ */

test("refusal -> the job fails with code refusal; the heartbeat is partial with that code", async () => {
  const db = makeDb();
  seedBuilt(db, [2]);
  const env = load(db, fakeModel({ research: () => textMsg([], { stop_reason: "refusal" }) }));
  await kick(env);
  const job = db.jobs.find((j) => j.step === "research");
  assert.equal(job.status, "failed");
  assert.equal(job.error_code, "refusal");
  assert.equal(db.chapters.get(2).status, "failed", "the chapter shows Couldn't build");
  assert.equal(db.sync.at(-1).status, "partial");
  assert.match(db.sync.at(-1).error_message, /codes .*refusal/);
});

test("a 5xx retries later (5 minutes after the first try); a bad request fails", async () => {
  const db = makeDb();
  seedBuilt(db, [2]);
  const env = load(db, fakeModel({ research: () => ({ __throw: { status: 500, message: "Synthetic" } }) }));
  await kick(env);
  const job = db.jobs.find((j) => j.step === "research");
  assert.equal(job.status, "queued");
  assert.equal(job.error_code, "server_error");
  assert.ok(job.next_attempt_at >= db.clock + 4 * 60000);
  assert.equal(env.S.retryMinutes(1), 5);
  assert.equal(env.S.retryMinutes(2), 30);
  assert.equal(env.S.retryMinutes(3), 180);

  const db2 = makeDb();
  seedBuilt(db2, [2]);
  const env2 = load(db2, fakeModel({ research: () => ({ __throw: { status: 400, message: "Synthetic" } }) }));
  await kick(env2);
  assert.equal(db2.jobs.find((j) => j.step === "research").status, "failed");
  assert.equal(db2.sync.at(-1).status, "failed");
});

test("invalid JSON from the structure call retries once, then fails bad_output", async () => {
  const db = makeDb();
  seedBuild(db);
  const env = load(db, fakeModel({ structure: () => textMsg([{ type: "text", text: "not json" }]) }));
  await kick(env);
  const job = db.jobs.find((j) => j.step === "build");
  assert.equal(job.status, "queued");
  assert.equal(job.error_code, "bad_output");
  job.next_attempt_at = db.clock;
  await kick(env);
  assert.equal(job.status, "failed");
});

test("a retry that the database fails at the job's third attempt is counted as failed (the heartbeat agrees with the row)", async () => {
  const db = makeDb();
  seedBuilt(db, [2]);
  addJob(db, { step: "research", chapter: 2, input_hash: B.researchInputHash(P.BANK_PROMPT_VERSION, chHash(db, 2), db.bb.map_urls, 0), priority: 20, attempts: 2, error_code: "server_error" });
  const env = load(db, fakeModel({ research: () => ({ __throw: { status: 500, message: "Synthetic" } }) }));
  await kick(env);
  const job = db.jobs.find((j) => j.step === "research");
  assert.equal(job.attempts, 3);
  assert.equal(job.status, "failed", "pds.reading_bank_finish turns the third retry into failed");
  const hb = db.sync.at(-1);
  assert.equal(hb.status, "failed", "and so does the run's summary");
  assert.match(hb.error_message, /failed 1/);
});

test("a finish whose answer never arrived: recorded when it had committed, not recorded when the lease was settled meanwhile", async () => {
  // The first call commits, its answer is lost; the second answers not_running; the job's own row shows done.
  const db = makeDb({ loseFinishAnswer: true });
  seedBuild(db);
  const env = load(db);
  await kick(env);
  assert.equal(db.jobs.find((j) => j.step === "build").status, "done");
  assert.match(db.sync.at(-1).error_message, /ch 2 (ready|thin|anchors_only|no_sources) /, "the chapter is reported: its finish was recorded");
  assert.equal(/not recorded/.test(db.sync.at(-1).error_message), false);

  // The first call never commits: the lease ran out and the claim settled the job (queued again, lease_expired). The
  // second finish also answers not_running, but the row is not this attempt's finish, so nothing is counted.
  const db2 = makeDb({ expireOnFinish: true });
  seedBuild(db2);
  const env2 = load(db2);
  await kick(env2);
  const job = db2.jobs.find((j) => j.step === "build");
  assert.equal(job.status, "queued");
  assert.equal(job.error_code, "lease_expired");
  const hb = db2.sync.at(-1);
  assert.match(hb.error_message, /build ch 2 not recorded/);
  assert.match(hb.error_message, /not_running/);
  assert.equal(/ch 2 (ready|thin|anchors_only|no_sources) /.test(hb.error_message), false, "no stored chapter is reported");
});

/* ------------------------------------------------------------------ */
/* money                                                                */
/* ------------------------------------------------------------------ */

test("the reservation before a request pauses the book at its cap: nothing is sent, the job is skipped", async () => {
  const db = makeDb();
  seedBuilt(db, [2]);
  db.bb.approved_cents = 100;
  db.bb.spent_cents = 60;
  const env = load(db);
  await kick(env);
  assert.equal(env.model.calls.length, 0, "no request was sent");
  assert.equal(db.bb.paused_reason, "budget");
  const job = db.jobs.find((j) => j.step === "research");
  assert.equal(job.status, "skipped");
  assert.equal(job.error_code, "budget");
  assert.equal(db.sync.at(-1).status, "partial");
  assert.match(db.sync.at(-1).error_message, /budget/);
});

test("the monthly cap stops claims; the heartbeat says monthly_cap", async () => {
  const db = makeDb({ monthBase: 2995 });
  seedBuilt(db, [2]);
  const env = load(db);
  const r = await kick(env, { monthCapCents: 3000 });
  assert.equal(r.claimed, 0);
  assert.equal(env.model.calls.length, 0);
  assert.equal(db.sync.at(-1).status, "partial");
  assert.match(db.sync.at(-1).error_message, /monthly_cap/);
});

test("an expired lease is charged its reservation before the job is claimed again", async () => {
  const db = makeDb();
  seedBuilt(db, [2]);
  const hash = B.researchInputHash(P.BANK_PROMPT_VERSION, chHash(db, 2), db.bb.map_urls, 0);
  addJob(db, { step: "research", chapter: 2, input_hash: hash, priority: 20, status: "running", attempts: 1, lease_until: db.clock - 1, reserved_cents: 12 });
  const env = load(db);
  await kick(env);
  const job = db.jobs.find((j) => j.step === "research");
  assert.equal(job.attempts, 2, "claimed again");
  assert.ok(job.cost_cents >= 12, "the expired run's reservation is charged");
  assert.ok(db.bb.spent_cents >= 12);
});

/* ------------------------------------------------------------------ */
/* preflight, kick, privacy                                             */
/* ------------------------------------------------------------------ */

test("schema checks missing: no claim, a partial heartbeat naming the checks file", async () => {
  const db = makeDb({ schema: "checks" });
  const env = load(db);
  const r = await kick(env);
  assert.equal(r.code, "schema_checks");
  assert.equal(db.rpc.includes("reading_bank_claim"), false);
  assert.equal(db.sync.at(-1).status, "partial");
  assert.match(db.sync.at(-1).error_message, /sql\/reading_question_bank_checks\.sql/);
});

test("SQL not applied: a kick is quiet (no heartbeat); the worker writes a failed heartbeat naming the SQL file", async () => {
  const db = makeDb({ schema: "missing" });
  const env = load(db);
  const r = await kick(env);
  assert.equal(r.code, "schema_missing");
  assert.equal(db.sync.length, 0);
  const w = await env.S.runWorker(env.supabase, { client: env.model.client, now: db.now });
  assert.equal(w.status, "failed");
  assert.equal(db.sync.at(-1).status, "failed");
  assert.match(db.sync.at(-1).error_message, /sql\/reading_question_bank\.sql/);
});

test("a book that is off: nothing enqueued, nothing run, no heartbeat", async () => {
  const db = makeDb();
  db.bb = null;
  const env = load(db);
  const r = await kick(env);
  assert.equal(r.code, "off");
  assert.equal(db.rpc.includes("reading_bank_enqueue"), false);
  assert.equal(db.rpc.includes("reading_bank_claim"), false);
  assert.equal(db.sync.length, 0);
});

test("Riley's own highlight edits kick without the highlights step (an autosaving form is never paid for)", async () => {
  const db = makeDb();
  seedBuilt(db);
  db.highlights[0].chapter = 2;
  const env = load(db);
  await kick(env, { reason: "highlight", steps: env.S.HIGHLIGHT_EDIT_STEPS });
  const hj = db.jobs.find((j) => j.step === "highlights");
  assert.ok(hj, "the highlights job is planned");
  assert.equal(hj.status, "queued", "and left for the Kindle kick or the worker");
  assert.equal(env.model.calls.length, 0);
  await kick(env);
  assert.equal(db.jobs.find((j) => j.step === "highlights").status, "done");
  assert.ok(env.model.calls.some((c) => c.role === "highlights"));
});

test("highlights step: a link is stored only when the verifier confirms it; a new idea rests on exactly one highlight", async () => {
  const db = makeDb();
  seedBuilt(db);
  db.ideas.push({ idea_id: 900, book_id: BOOK, chapter: 2, unlock_chapter: 2, chapter_hash: chHash(db, 2), title: "Fog bell", statement: "The bell is rung in fog.", importance: "core", status: "active" });
  const idea = (support) => ({ ...BUILD_STRUCTURE.ideas[2], title: `New idea ${support.join(" ")}`, support });
  const env = load(db, fakeModel({
    highlights: () => jsonMsg({ links: [{ highlight: "H55", idea_id: 900 }, { highlight: "H99", idea_id: 900 }], ideas: [idea(["H55"]), idea(["H55", "E1"])] }),
    verify: (params) => {
      const material = JSON.parse(params.messages[0].content.split("<material>\n")[1].split("\n</material>")[0]);
      return jsonMsg({ ideas: material.map((m) => ({ index: m.index, supported: "yes", placement: "this", later_content: false, questions: m.questions.map((q) => ({ index: q.index, ok: true, problem: "none" })) })) });
    },
  }));
  await kick(env);
  const p = db.stores.at(-1);
  assert.equal(p.replace, false);
  assert.deepEqual(p.ideas.map((i) => i.evidence), [["H55"]], "the two-source idea and the unknown highlight are dropped");
  assert.deepEqual(p.links, [{ idea_id: 900, source_ref: "H55" }]);
  assert.ok(p.seen.some((s) => s.highlight_id === 55));
});

test("privacy: web-enabled calls never see a highlight; no call ever sees a comment", async () => {
  const db = makeDb();
  const env = load(db);
  await kick(env); // map, then research (each finished stage plans the book again)
  await kick(env); // a build (a kick claims a build only as its first claim: 225 s)
  await kick(env); // another build
  const roles = new Set(env.model.calls.map((c) => c.role));
  for (const r of ["map1", "research", "structure", "verify"]) assert.ok(roles.has(r), `ran ${r}`);
  for (const c of env.model.calls) {
    const text = JSON.stringify(c.params);
    assert.equal(text.includes(COMMENT_MARKER), false, `${c.role} saw a comment`);
    if (c.params.tools) assert.equal(text.includes(PASSAGE_MARKER), false, `${c.role} (web tools) saw a highlight`);
  }
  assert.ok(env.model.calls.some((c) => c.role === "structure" && JSON.stringify(c.params).includes(PASSAGE_MARKER)), "the structure call sees chapter 2's highlight");
});

/* ------------------------------------------------------------------ */
/* one trigger, several stages; time budgets                            */
/* ------------------------------------------------------------------ */

test("one kick goes from the source map to research to a stored build when its deadline allows (planned again after each stage)", async () => {
  const db = makeDb();
  const env = load(db);
  const t0 = db.clock;
  // A clock that does not move: every step fits the kick's deadline (the fake model answers at once).
  const r = await kick(env, { now: () => t0 });
  assert.equal(r.ran, true);
  const roles = env.model.calls.map((c) => c.role);
  const at = (role) => roles.indexOf(role);
  assert.ok(at("map1") === 0 && at("map2") === 1, "the source map first");
  assert.ok(at("research") > at("map2"), "research in the same kick, once the map is stored");
  assert.ok(at("structure") > at("research") && at("verify") > at("structure"), "and the build once its research is done");
  const build2 = db.jobs.find((j) => j.step === "build" && j.chapter === 2);
  assert.equal(build2?.status, "done", "chapter 2 (the newest quizzable chapter) is built in the approval kick");
  assert.ok(db.stores.some((p) => p.chapter === 2), "and stored");
});

test("a kick claims a build only with 225 s left: the approval kick maps and researches, the next trigger builds", async () => {
  const db = makeDb();
  const env = load(db);
  assert.equal(env.S.stepBudgetMs("build", 1), 225000, "a kick gives a build 225 s, not STEP_MAX_SECONDS' 150");
  assert.equal(env.S.stepBudgetMs("build", 2), 300000, "the worker's 2x");
  assert.equal(env.S.stepBudgetMs("map", 1), 120000);
  await kick(env); // the fake's clock moves 1 s per database call
  assert.equal(db.jobs.find((j) => j.step === "map").status, "done");
  assert.equal(db.jobs.find((j) => j.step === "research" && j.chapter === 2).status, "done", "research ran in the same kick");
  const build = db.jobs.find((j) => j.step === "build" && j.chapter === 2);
  assert.equal(build?.status, "queued", "the build is planned, but less than 225 s are left");
  assert.equal(env.model.calls.some((c) => c.role === "structure"), false);
  await kick(env);
  assert.equal(build && db.jobs.find((j) => j.job_id === build.job_id).status, "done", "the next kick's first claim is the build");
});

test("a build that timed out keeps its full target on the next try; only max_tokens halves it", async () => {
  const target = (env) => Number(/"target":(\d+)/.exec(env.model.calls.find((c) => c.role === "structure").params.messages[0].content)[1]);
  const full = B.chapterTarget({ start_page: 31, end_page: 60 });
  for (const [code, want] of [["timeout", full], ["max_tokens", B.chapterTarget({ start_page: 31, end_page: 60 }, true)]]) {
    const db = makeDb();
    const research = seedBuild(db);
    addJob(db, { step: "build", chapter: 2, input_hash: B.buildInputHash(P.BANK_PROMPT_VERSION, chHash(db, 2), research.job_id, 0), priority: 20, attempts: 1, error_code: code });
    const env = load(db);
    await kick(env);
    assert.equal(target(env), want, `after ${code}`);
  }
  assert.ok(B.chapterTarget({ start_page: 31, end_page: 60 }, true) < full);
});

test("a finish the database does not record is never counted: a retry with lease_lost, no chapter, no next stage", async () => {
  const db = makeDb({ refuseFinish: "lease_lost" });
  seedBuild(db);
  const env = load(db);
  const r = await kick(env);
  assert.equal(r.claimed, 1, "the job stays running (leased), so nothing else of the book is claimed");
  const job = db.jobs.find((j) => j.step === "build");
  assert.equal(job.status, "running", "left for its lease to run out and a later claim");
  const hb = db.sync.at(-1);
  assert.match(hb.error_message, /lease_lost/);
  assert.match(hb.error_message, /build ch 2 not recorded/);
  assert.equal(/ch 2 (ready|thin|anchors_only|no_sources) /.test(hb.error_message), false, "no stored chapter is reported");
  assert.equal(hb.records_synced, 0);
});

test("a kick ends 280 s after its request started, however late after() began", async () => {
  const db = makeDb();
  const env = load(db);
  assert.equal(env.S.kickDeadline(0, null), 240000);
  assert.equal(env.S.kickDeadline(100000, 0), 280000, "a request that took 100 s leaves the kick 180 s");
  const r = await kick(env, { requestStartedAt: db.clock - 200000 });
  assert.equal(r.claimed, 0, "80 s left: the source map (120 s) is not claimed");
  assert.equal(env.model.calls.length, 0);
  assert.equal(db.jobs.find((j) => j.step === "map").status, "queued");
});

test("the worker settles and grades an answer whose grade run stopped, even with every book off", async () => {
  const db = makeDb();
  db.bb.approved_at = null;
  const grade = addJob(db, {
    step: "grade", attempt_key: "00000000-0000-4000-8000-000000000003", input_hash: "c".repeat(64), priority: 5,
    status: "running", attempts: 1, lease_until: db.clock - 1000, reserved_cents: 1, next_attempt_at: db.clock - 600000,
    created_at: new Date(db.clock - 10 * 60000).toISOString(),
  });
  const env = load(db);
  const w = await env.S.runWorker(env.supabase, { client: env.model.client, now: db.now, clearAnswersDays: 0 });
  assert.equal(w.books, 0, "no book turned on: no generation run (and so no other claim)");
  assert.deepEqual(env.grades, [grade.job_id], "the expired lease is settled by the claim and the grade runs");
});

test("a build's not_in_book lists this chapter's Wrong flags, however many newer flags other chapters have", async () => {
  const db = makeDb();
  seedBuild(db);
  db.ideas.push({ idea_id: 901, book_id: BOOK, chapter: 2, unlock_chapter: 2, chapter_hash: chHash(db, 2), title: "Flagged", statement: "Synthetic statement flagged wrong in chapter two", importance: "core", status: "retired" });
  db.ideas.push({ idea_id: 902, book_id: BOOK, chapter: 3, unlock_chapter: 3, chapter_hash: chHash(db, 3), title: "Elsewhere", statement: "Synthetic statement flagged wrong in chapter three", importance: "core", status: "retired" });
  const flag = (idea_id, minutesAgo) => ({ flag_key: `f-${idea_id}`, question_id: 1, idea_id, kind: "wrong", restored_at: null, created_at: new Date(db.clock - minutesAgo * 60000).toISOString() });
  db.flags.push(flag(901, 600), flag(902, 500));
  for (let i = 0; i < 250; i++) db.flags.push(flag(5000 + i, i));
  const env = load(db);
  await kick(env);
  const user = env.model.calls.find((c) => c.role === "structure").params.messages[0].content;
  assert.ok(user.includes("Synthetic statement flagged wrong in chapter two"), "an older flag on this chapter still reaches the build");
  assert.equal(user.includes("chapter three"), false, "another chapter's flag does not");
});

test("export keeps the ideas of a chapter with no table of contents row, and leaves out another edition's", async () => {
  const db = makeDb();
  db.toc = db.toc.filter((c) => c.chapter !== 2);
  db.ideas.push({ idea_id: 11, book_id: BOOK, chapter: 2, unlock_chapter: 2, chapter_hash: B.chapterHash(2, null), title: "Kept", statement: "s", importance: "core", status: "active" });
  db.ideas.push({ idea_id: 12, book_id: BOOK, chapter: 2, unlock_chapter: 2, chapter_hash: "f".repeat(64), title: "Stale", statement: "s", importance: "core", status: "active" });
  const env = load(db);
  const r = await env.S.getBankExport(env.supabase, null);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.ideas.map((i) => i.idea_id), [11]);
});

test("research notes are trimmed to the column's limit as Postgres prints jsonb (a space after every ':' and ',')", () => {
  const env = load(makeDb());
  assert.equal(env.S.jsonbTextLength({ a: 1, b: [1, 2] }), '{"a": 1, "b": [1, 2]}'.length);
  assert.equal(env.S.jsonbTextLength([]), 2);
  const sources = Array.from({ length: 3000 }, (_, i) => ({ url: `${GUIDE}/p${i}`, domain: "example.org", title: "T", cited_text: "Short synthetic snippet." }));
  const notes = sources.map((_, i) => ({ text: "A short synthetic note.", sources: [i] }));
  const out = env.S.trimOutput({ notes, sources, unsure: "" });
  assert.ok(env.S.jsonbTextLength(out) <= env.S.OUTPUT_MAX_CHARS);
  assert.ok(out.sources.length > 0 && out.sources.length < sources.length);
});

/* ------------------------------------------------------------------ */
/* heartbeat                                                            */
/* ------------------------------------------------------------------ */

const SAFE_MESSAGE = /^[a-z0-9 .;:/_+\-]+$/i;

test("heartbeat: success with counts only, throttled to one per 50 minutes when nothing was claimed", async () => {
  const db = makeDb();
  seedBuilt(db);
  db.highlights = [];
  const env = load(db);
  await kick(env);
  assert.equal(db.sync.length, 1, "nothing to do: the first heartbeat still lands");
  assert.equal(db.sync[0].source, "reading_bank");
  assert.equal(db.sync[0].data_type, "generate");
  assert.equal(db.sync[0].status, "success");
  await kick(env);
  assert.equal(db.sync.length, 1, "a second quiet run within 50 minutes repeats nothing");
  db.clock += 51 * 60000;
  await kick(env);
  assert.equal(db.sync.length, 2);
});

test("heartbeat on a crash is failed; no heartbeat, log line or worker output carries the book's title or a highlight", async () => {
  const db = makeDb();
  const env = load(db);
  await kick(env);
  await kick(env);
  await kick(env);
  db.throwOn = "reading_bank_enqueue";
  const r = await kick(env);
  assert.equal(r.code, "other");
  assert.equal(db.sync.at(-1).status, "failed");
  db.throwOn = null;
  const w = await env.S.runWorker(env.supabase, { client: env.model.client, now: db.now, clearAnswersDays: 0 });
  const line = env.S.workerLogLine(w);
  for (const row of db.sync) {
    assert.match(row.error_message, SAFE_MESSAGE);
    for (const marker of [TITLE, AUTHOR, PASSAGE_MARKER, COMMENT_MARKER, ...TOC.map((c) => c.title)]) assert.equal(row.error_message.includes(marker), false);
  }
  assert.match(line, SAFE_MESSAGE);
  for (const marker of [TITLE, AUTHOR, PASSAGE_MARKER, ...TOC.map((c) => c.title)]) assert.equal(line.includes(marker), false);
});

/* ------------------------------------------------------------------ */
/* worker                                                               */
/* ------------------------------------------------------------------ */

test("worker: plans every approved book, sweeps grades older than 2 minutes only, clears answers once a day", async () => {
  const db = makeDb();
  const at4 = Date.parse("2031-01-15T09:30:00Z"); // 04:30 in New York (EST)
  db.clock = at4;
  seedBuilt(db);
  db.highlights = [];
  addJob(db, { step: "grade", attempt_key: "00000000-0000-4000-8000-000000000001", input_hash: "a".repeat(64), priority: 5, created_at: new Date(db.clock - 3 * 60000).toISOString() });
  addJob(db, { step: "grade", attempt_key: "00000000-0000-4000-8000-000000000002", input_hash: "b".repeat(64), priority: 5, created_at: new Date(db.clock - 30000).toISOString() });
  const env = load(db);
  assert.equal(env.S.clearAnswersDue(at4), true);
  assert.equal(env.S.clearAnswersDue(Date.parse("2031-01-15T11:30:00Z")), false);
  const w = await env.S.runWorker(env.supabase, { client: env.model.client, now: db.now, clearAnswersDays: 180 });
  assert.deepEqual(env.grades, [1], "only the grade job queued more than 2 minutes ago");
  assert.equal(w.books, 1);
  assert.deepEqual(db.cleared, [180]);
  assert.equal(w.cleared, 3);
  assert.equal(env.repairs.length, 1, "dirty states repaired");
  assert.equal(env.S.clearAnswersDays("0"), 0);
  assert.equal(env.S.clearAnswersDays("10"), 180, "below T07's 30-day floor: the default");
  assert.equal(env.S.clearAnswersDays(undefined), 180);
});

test("the worker script prints one counts-only line and never a row or a message", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "scripts", "reading-bank-run.cjs"), "utf8");
  const logs = src.match(/console\.(log|error|warn)\([^;]*\);/g) ?? [];
  assert.ok(logs.length >= 1);
  const allowed = ["workerLogLine(result)", '"reading bank: failed missing', "e && e.name"];
  for (const l of logs) {
    assert.ok(allowed.some((a) => l.includes(a)), `unexpected log: ${l}`);
    assert.equal(/\.message/.test(l), false, "never an error message (it could quote a row)");
  }
  assert.ok(src.includes('loadTs("lib/reading-bank-server.ts", { "server-only": {} })'));
});

/* ------------------------------------------------------------------ */
/* routes                                                               */
/* ------------------------------------------------------------------ */

const req = (body, o = {}) => {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const headers = new Map(Object.entries({ origin: "https://onyx.example", "content-type": "application/json", "content-length": String(Buffer.byteLength(text)), ...(o.headers ?? {}) }));
  return {
    headers: { get: (k) => headers.get(k.toLowerCase()) ?? null },
    nextUrl: { origin: "https://onyx.example", searchParams: new URLSearchParams(o.query ?? "") },
    text: async () => text,
  };
};

test("approval: the server's cap must match the card's (409 estimate_changed); turning on kicks in after()", async () => {
  const db = makeDb();
  db.bb.approved_at = null;
  db.bb.approved_cents = null;
  const env = load(db);
  const route = loadTs("app/api/reading/bank/approval/route.ts", env.stubs);
  assert.equal(route.maxDuration, 300);
  const est = env.S.bookEstimate(planInput(db), 0);
  assert.equal(est.cap_cents, B.approvalCapCents(0, B.estimateBookCents(4)));
  const bad = await route.PUT(req({ on: true, cap_cents: est.cap_cents + 100 }));
  assert.equal(bad.status, 409);
  assert.equal(bad.body.error, "estimate_changed");
  assert.equal(bad.body.cap_cents, est.cap_cents);
  assert.equal(env.queue.length, 0);
  const good = await route.PUT(req({ on: true, cap_cents: est.cap_cents }));
  assert.equal(good.status, 200);
  assert.equal(db.bb.approved_cents, est.cap_cents);
  assert.equal(env.queue.length, 1, "the kick runs after the response");
  const unknown = await route.PUT(req({ on: true, cap_cents: est.cap_cents, extra: 1 }));
  assert.equal(unknown.status, 400, "unknown fields are refused");
  const cross = await route.PUT(req({ on: false }, { headers: { origin: "https://elsewhere.example" } }));
  assert.equal(cross.status, 403);
});

test("run: 409 bank_off for a book that is off; a rebuild bumps the counter and answers 202 with the work in after()", async () => {
  const db = makeDb();
  seedBuilt(db);
  const env = load(db);
  const route = loadTs("app/api/reading/bank/run/route.ts", env.stubs);
  const r = await route.POST(req({ chapter: 2, rebuild: true }));
  assert.equal(r.status, 202);
  assert.equal(db.chapters.get(2).rebuilds, 1);
  assert.ok(db.jobs.some((j) => j.step === "research" && j.chapter === 2 && j.status === "queued"), "a fresh research job for the rebuilt chapter");
  assert.equal(env.queue.length, 1);
  // A double tap (or a retry after a lost answer) while that research is still queued is not counted again.
  const again = await route.POST(req({ chapter: 2, rebuild: true }));
  assert.equal(again.status, 202);
  assert.equal(again.body.pending, true);
  assert.equal(db.chapters.get(2).rebuilds, 1, "the first rebuild's jobs stay current");
  assert.equal(db.jobs.filter((j) => j.step === "research" && j.chapter === 2).length, 1);
  db.bb.paused_reason = "owner";
  const off = await route.POST(req({}));
  assert.equal(off.status, 409);
  assert.equal(off.body.error, "bank_off");
  assert.equal((await route.POST(req({ chapter: -1 }))).status, 400);
});

test("run: overlapping Rebuild taps count once: the pending check, the count and the new jobs are one call", async () => {
  // Both requests read the plan input before either has written anything, as two function instances would.
  const db = makeDb();
  seedBuilt(db);
  const env = load(db);
  const route = loadTs("app/api/reading/bank/run/route.ts", env.stubs);
  const [a, b] = await Promise.all([route.POST(req({ chapter: 2, rebuild: true })), route.POST(req({ chapter: 2, rebuild: true }))]);
  assert.deepEqual([a.status, b.status], [202, 202]);
  assert.deepEqual([a.body.pending, b.body.pending].sort(), [false, true], "one tap counts, the other is told it is pending");
  assert.equal(db.chapters.get(2).rebuilds, 1, "counted once: the first tap's jobs stay current");
  const research = db.jobs.filter((j) => j.step === "research" && j.chapter === 2);
  assert.equal(research.length, 1, "one research job, paid for once");
  assert.equal(research[0].input_hash, B.researchInputHash(P.BANK_PROMPT_VERSION, chHash(db, 2), db.bb.map_urls, 1), "and it is the hash of the new count");
  assert.equal(db.jobs.filter((j) => j.status === "skipped").length, 0, "no job of the first tap was made obsolete");
  // A third tap once more (the jobs are queued now): still pending, still not counted.
  assert.equal((await route.POST(req({ chapter: 2, rebuild: true }))).body.pending, true);
  assert.equal(db.chapters.get(2).rebuilds, 1);

  // The book-level Rebuild (the source map and the whole-book build) the same.
  const db0 = makeDb();
  seedBuilt(db0);
  const env0 = load(db0);
  const route0 = loadTs("app/api/reading/bank/run/route.ts", env0.stubs);
  const [c, d] = await Promise.all([route0.POST(req({ rebuild: true })), route0.POST(req({ rebuild: true }))]);
  assert.deepEqual([c.body.pending, d.body.pending].sort(), [false, true]);
  assert.equal(db0.bb.map_rebuilds, 1);
  assert.equal(db0.chapters.get(0).rebuilds, 1);
  assert.equal(db0.jobs.filter((j) => j.step === "map").length, 1);
});

test("run: a Rebuild that read the count before another one was counted does not count again, even with no job open", async () => {
  const db = makeDb();
  seedBuilt(db);
  const env = load(db);
  const route = loadTs("app/api/reading/bank/run/route.ts", env.stubs);
  const real = env.supabase.rpc;
  let raced = false;
  env.supabase.rpc = (name, args) => {
    if (name === "reading_bank_rebuild" && !raced) {
      raced = true;
      db.chapters.get(2).rebuilds = 1; // another tap was counted, and its work already finished: nothing is open
    }
    return real(name, args);
  };
  const r = await route.POST(req({ chapter: 2, rebuild: true }));
  assert.equal(r.status, 202);
  assert.equal(r.body.pending, true);
  assert.equal(r.body.rebuilds, null);
  assert.equal(db.chapters.get(2).rebuilds, 1, "not raised to 2");
  assert.equal(db.jobs.filter((j) => j.step === "research" && j.chapter === 2 && j.status === "queued").length, 1, "the planner after it queues what the stored count needs");
});

test("withRebuild: the plan made from it is the plan the planner makes once the count really is one higher", () => {
  const v = P.BANK_PROMPT_VERSION;
  for (const chapter of [2, 0]) {
    const db = makeDb();
    seedBuilt(db);
    const env = load(db);
    const input = planInput(db);
    const snapshot = structuredClone(input);
    const simulated = env.S.planForBook(env.S.withRebuild(input, chapter), v);
    assert.deepEqual(input, snapshot, "the input read is not changed");
    assert.ok(simulated.jobs.length >= 1, "a Rebuild always has something to queue");
    const c = db.chapters.get(chapter) ?? { status: "pending", rebuilds: 0, built_rebuilds: 0 };
    c.rebuilds += 1;
    db.chapters.set(chapter, c);
    if (chapter === 0) db.bb.map_rebuilds += 1;
    assert.deepEqual(simulated, env.S.planForBook(planInput(db), v), `chapter ${chapter}`);
  }
});

test("chapter sheet: a chapter above the spoiler gate is 404 locked; GETs write nothing", async () => {
  const db = makeDb();
  const env = load(db);
  const route = loadTs("app/api/reading/bank/chapter/[n]/route.ts", env.stubs);
  const locked = await route.GET(req("", { query: "" }), { params: Promise.resolve({ n: "3" }) });
  assert.equal(locked.status, 404);
  assert.equal(locked.body.error, "locked");
  const open = await route.GET(req("", { query: "" }), { params: Promise.resolve({ n: "2" }) });
  assert.equal(open.status, 200);
  assert.equal(open.body.rebuild_cents, B.PER_CHAPTER_CENTS);
  assert.equal((await route.GET(req(""), { params: Promise.resolve({ n: "x" }) })).status, 400);
  assert.equal(env.queue.length, 0);
  assert.equal(db.rpc.some((n) => /enqueue|claim|store|approve|rebuild/.test(n)), false);
});

test("a book-level Rebuild on a mapped book plans a fresh source map once; a done or failed one is not planned again", async () => {
  const db = makeDb();
  seedBuilt(db);
  const env = load(db);
  const v = P.BANK_PROMPT_VERSION;
  const route = loadTs("app/api/reading/bank/run/route.ts", env.stubs);
  const maps = (plan) => plan.jobs.filter((j) => j.step === "map");
  assert.equal(maps(env.S.planForBook(planInput(db), v)).length, 0, "a mapped book plans no map");
  assert.equal(maps(B.planBankJobs({ ...planInput(db), map_rebuilds: 1 }, v)).length, 0, "the planner alone: a Rebuild would count and plan nothing");

  const r = await route.POST(req({ rebuild: true }));
  assert.equal(r.status, 202);
  assert.equal(db.bb.map_rebuilds, 1, "the Rebuild counts a map rebuild");
  const job = db.jobs.find((j) => j.step === "map");
  assert.ok(job && job.status === "queued", "and queues the map job");
  assert.equal(job.input_hash, B.mapInputHash(v, planInput(db)));
  assert.ok(r.body.queued >= 1, "the map is among the planned jobs");

  // Planned again while it is queued: not skipped (a skip then re-queue would reset its attempts), not doubled.
  const again = env.S.planForBook(planInput(db), v);
  assert.equal(maps(again).length, 1);
  assert.deepEqual(again.skip_jobs, []);
  await env.supabase.rpc("reading_bank_enqueue", { p: again });
  assert.equal(db.jobs.filter((j) => j.step === "map").length, 1);

  // The kick runs it; the book is then planned again and no second map is queued.
  await kick(env, { steps: ["map"] });
  assert.equal(job.status, "done");
  assert.deepEqual(db.bb.map_urls, [`${GUIDE}/guide`, `${GUIDE}/about`]);
  assert.equal(maps(env.S.planForBook(planInput(db), v)).length, 0);
  job.status = "failed";
  assert.equal(maps(env.S.planForBook(planInput(db), v)).length, 0, "failed for good: the old map stays in use until the next Rebuild");

  // The next Rebuild is a new hash.
  db.bb.map_rebuilds = 2;
  const next = maps(env.S.planForBook(planInput(db), v));
  assert.equal(next.length, 1);
  assert.notEqual(next[0].input_hash, job.input_hash);
  // A book that is off plans nothing.
  db.bb.paused_reason = "owner";
  assert.equal(env.S.planForBook(planInput(db), v).jobs.length, 0);
});

test("a requeued job keeps its charge in the month's spend: pds.reading_bank_enqueue does not clear finished_at", () => {
  const sql = fs.readFileSync(path.join(__dirname, "..", "..", "sql", "reading_question_bank.sql"), "utf8");
  const start = sql.indexOf("CREATE OR REPLACE FUNCTION pds.reading_bank_enqueue");
  const body = sql.slice(start, sql.indexOf("$fn$;", sql.indexOf("$fn$", start) + 4));
  const update = /ON CONFLICT \(book_id, step, chapter, input_hash\) DO UPDATE\s+SET ([^;]*?)\s+WHERE jb\.status = 'skipped'/.exec(body);
  assert.ok(update, "the requeue clause is found");
  assert.match(update[1], /status = 'queued'/);
  assert.doesNotMatch(update[1], /finished_at/, "this month's spend is summed over jobs by finished_at: a requeued job with a charge must stay in it");
  // Every charge is dated by the same column, so a requeue that cleared it would lower the month's spend.
  assert.match(sql, /sum\(cost_cents\) FILTER \(WHERE finished_at >= \(date_trunc\('month'/);
});

test("the write routes kick in after(), each with maxDuration 300; the session PATCH only when the chapter reached changed", () => {
  const dir = path.join(__dirname, "..", "src", "app", "api", "reading");
  const lazy = ["highlights/import/route.ts", "highlights/route.ts", "highlights/[id]/route.ts", "sessions/route.ts", "sessions/[id]/route.ts"];
  for (const f of lazy) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    assert.match(src, /export const maxDuration = 300;/, f);
    // The bank (and the Anthropic SDK graph it pulls in) loads inside after(), never at the route's cold start.
    assert.doesNotMatch(src, /^import .* from "@\/lib\/reading-bank-server";/m, `${f} has no static import of the bank`);
    assert.match(src, /after\(async \(\) => \{\s*const \{[^}]*\} = await import\("@\/lib\/reading-bank-server"\);[^\n]*\s*(for \(const bookId of bookIds\) )?await kickBank\(/, f);
  }
  const edit = fs.readFileSync(path.join(dir, "highlights/[id]/route.ts"), "utf8");
  assert.match(edit, /kickAfter\(h\.book_id, requestStartedAt\)/, "an edit's kick ends 280 s after its request started");
  assert.match(edit, /kickAfter\(bookId, requestStartedAt\)/, "so does a removal's");
  for (const f of ["bank/approval/route.ts", "bank/run/route.ts"]) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    assert.match(src, /export const maxDuration = 300;/, f);
    assert.match(src, /after\(async \(\) => \{\s*await kickBank\(/, f);
  }
  const patch = fs.readFileSync(path.join(dir, "sessions/[id]/route.ts"), "utf8");
  assert.match(patch, /r\.session\.chapter_through !== r\.previous\.chapter_through/);
  for (const f of ["bank/route.ts", "bank/chapter/[n]/route.ts", "bank/export/route.ts"]) {
    const src = fs.readFileSync(path.join(dir, f), "utf8");
    assert.equal(/kickBank|after\(/.test(src), false, `${f} is a GET: it never starts generation`);
  }
});
