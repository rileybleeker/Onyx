// READ-QUIZ-01: static guards on sql/reading_question_bank.sql and sql/reading_question_bank_checks.sql (no
// database: the files are read as text). Keeps the bank additive, private, locked, and on PROD-T07's formulas.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { SRC } = require("./helpers/load-ts.cjs");

const read = (rel) => fs.readFileSync(path.join(SRC, "..", "..", rel), "utf8");
const main = read("sql/reading_question_bank.sql");
const checks = read("sql/reading_question_bank_checks.sql");
const t07 = read("sql/reading_learning_questions.sql");

/** Each CREATE OR REPLACE FUNCTION in a file: name, argument types, language, body. */
function functions(sql) {
  const out = [];
  const re = /CREATE OR REPLACE FUNCTION (pds\.\w+)\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(sql))) {
    const start = m.index;
    const open = sql.indexOf("$fn$", start);
    const close = sql.indexOf("$fn$", open + 4);
    const head = sql.slice(start, open);
    const types = m[2].trim() ? m[2].split(",").map((a) => a.replace(/\bDEFAULT\b.*$/i, "").trim().split(/\s+/)[1].toLowerCase()) : [];
    out.push({ name: m[1], sig: `${m[1]}(${types.join(",")})`, language: /LANGUAGE\s+(\w+)/i.exec(head)?.[1].toLowerCase(), body: sql.slice(open + 4, close) });
  }
  return out;
}

/** The argument list of the first jsonb_build_object( after `from`, split at top-level commas. */
function buildObjectArgs(text, from = 0) {
  const at = text.indexOf("jsonb_build_object(", from);
  if (at < 0) return null;
  let i = at + "jsonb_build_object(".length;
  let depth = 0;
  let quote = false;
  let cur = "";
  const args = [];
  for (; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      cur += ch;
      if (ch === "'") quote = false;
      continue;
    }
    if (ch === "'") {
      quote = true;
      cur += ch;
    } else if (ch === "(") {
      depth++;
      cur += ch;
    } else if (ch === ")") {
      if (depth === 0) break;
      depth--;
      cur += ch;
    } else if (ch === "," && depth === 0) {
      args.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  args.push(cur.trim());
  return args;
}
const keysOf = (args) => args.filter((_, i) => i % 2 === 0).map((k) => k.replace(/^'|'$/g, ""));
/** Every jsonb_build_object in `text` whose first key is `firstKey`, as key lists. */
function objectsStartingWith(text, firstKey) {
  const out = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf("jsonb_build_object(", from);
    if (at < 0) return out;
    const args = buildObjectArgs(text, at);
    if (args && args[0] === `'${firstKey}'`) out.push(keysOf(args));
    from = at + 1;
  }
}

const fnsMain = functions(main);
const fn = (fns, name) => fns.find((f) => f.name === name);

test("the main file is additive: no destructive keyword anywhere, comments included", () => {
  assert.doesNotMatch(main, /\b(DROP|DELETE|TRUNCATE)\b/i);
  assert.doesNotMatch(main, /\bCREATE\s+POLICY\b/i, "service role only: no policies");
});

test("no IF / ELSIF / WHILE condition starts with a bare CASE: PL/pgSQL ends the condition at the CASE's own THEN and the function would not create", () => {
  for (const f of fnsMain.filter((x) => x.language === "plpgsql")) {
    const code = f.body.replace(/--[^\n]*/g, "");
    assert.doesNotMatch(code, /\b(IF|ELSIF|WHILE)\s+(NOT\s+)?CASE\b/i, `${f.name}: parenthesize the CASE`);
  }
});

test("every new table: row level security on, revoked from PUBLIC / anon / authenticated, granted to service_role only", () => {
  const tables = [...main.matchAll(/CREATE TABLE IF NOT EXISTS pds\.(\w+)/g)].map((m) => m[1]);
  assert.equal(tables.length, 9);
  const revoke = /REVOKE ALL ON ([^;]+?)\s+FROM PUBLIC, anon, authenticated;/.exec(main)?.[1] ?? "";
  const grant = /GRANT SELECT, INSERT, UPDATE ON ([^;]+?) TO service_role;/.exec(main)?.[1] ?? "";
  for (const t of tables) {
    assert.match(main, new RegExp(`ALTER TABLE pds\\.${t}\\s+ENABLE ROW LEVEL SECURITY`), t);
    assert.ok(revoke.includes(`pds.${t}`), `${t} revoked`);
    assert.ok(grant.includes(`pds.${t}`), `${t} granted to service_role`);
  }
  assert.doesNotMatch(main, /\bGRANT\b[^;]*\bTO\b[^;]*\b(anon|authenticated|PUBLIC)\b/i);
});

test("every function is revoked from the public roles and executable by service_role only", () => {
  const block = main.slice(main.indexOf("DO $grants$"), main.indexOf("END $grants$"));
  const listed = [...block.matchAll(/'(pds\.\w+\([^)]*\))'/g)].map((m) => m[1].replace(/\s+/g, ""));
  const defined = fnsMain.map((f) => f.sig);
  assert.deepEqual([...listed].sort(), [...defined].sort());
  assert.match(block, /REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated/);
  assert.match(block, /GRANT EXECUTE ON FUNCTION %s TO service_role/);
});

test("every write function takes the practice lock or the claim lock before its first write", () => {
  const LOCK = /pg_advisory_xact_lock\(hashtext\('pds\.reading_(practice|bank_claim)'\)\)/;
  const WRITE = /\b(INSERT\s+INTO|UPDATE\s+pds\.)/;
  const writers = fnsMain.filter((f) => WRITE.test(f.body));
  assert.ok(writers.length >= 12);
  for (const f of writers) {
    assert.equal(f.language, "plpgsql", f.name);
    const lock = f.body.search(LOCK);
    assert.ok(lock >= 0 && lock < f.body.search(WRITE), `${f.name} locks before writing`);
  }
  for (const f of fnsMain.filter((x) => x.language === "sql")) assert.doesNotMatch(f.body, WRITE, `${f.name} is read only`);
});

test("PROD-T07's content-hash, request-hash and answer-hash formulas are used unchanged", () => {
  const apply = fn(functions(t07), "pds.reading_question_apply").body;
  const contentT07 = objectsStartingWith(apply, "prompt");
  const requestT07 = objectsStartingWith(apply, "book_id");
  assert.ok(contentT07.length >= 1 && requestT07.length >= 1);
  assert.deepEqual(contentT07[0], ["prompt", "rubric", "source_kind", "source_ref", "source_hash"]);
  assert.deepEqual(requestT07[0], ["book_id", "question_key", "prompt", "rubric", "source_kind", "source_ref", "answer", "quiz_key"]);

  const store = fn(fnsMain, "pds.reading_bank_store").body;
  const attempt = fn(fnsMain, "pds.reading_bank_attempt").body;
  const recall = fn(fnsMain, "pds.reading_bank_recall_refresh").body;
  const contentBank = [...objectsStartingWith(store, "prompt"), ...objectsStartingWith(recall, "prompt"), ...objectsStartingWith(attempt, "prompt")];
  assert.ok(contentBank.length >= 3, "idea questions, chapter recall, and the attempt's re-check");
  for (const keys of contentBank) assert.deepEqual(keys, contentT07[0]);
  const requestBank = objectsStartingWith(attempt, "book_id");
  assert.equal(requestBank.length, 1);
  assert.deepEqual(requestBank[0], requestT07[0]);
  assert.match(apply, /pds\.reading_sha256\(v_answer\)/);
  assert.match(attempt, /answer_hash[\s\S]*pds\.reading_sha256\(v_answer\)/);
  // Rubric and prompt go into the formula as TEXT, like T07's variables (a jsonb value would hash differently).
  assert.match(store, /v_rub := \(v_q->'rubric'\)::text;/);
});

test("reading_source_text keeps T07's three branches verbatim and adds only the idea branch", () => {
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  const closing = /\)\s*x\s+LIMIT 1\s*$/;
  const a = fn(functions(t07), "pds.reading_source_text").body.split("UNION ALL");
  const b = fn(fnsMain, "pds.reading_source_text").body.split("UNION ALL");
  assert.equal(a.length, 3);
  assert.equal(b.length, 4);
  assert.equal(norm(b[0]), norm(a[0]));
  assert.equal(norm(b[1]), norm(a[1]));
  assert.equal(norm(b[2]), norm(a[2].replace(closing, "")));
  assert.match(b[3], /p_kind = 'idea'/);
  assert.match(b[3], /i\.status = 'active'/);
  assert.match(norm(b[3]), closing);
});

test("reading_bank_attempt applies T07's answer rules with T07's refusal codes", () => {
  const body = fn(fnsMain, "pds.reading_bank_attempt").body;
  for (const code of ["quiz_closed", "already_answered", "quiz_other_book", "source_not_permitted", "question_changed", "key_reused", "locked", "chapter_changed", "retired"]) {
    assert.match(body, new RegExp(`'${code}'`), code);
  }
  assert.match(body, /reading_bank_quiz_through/);
});

test("the spoiler gate and the edition check are applied by every read and by the attempt", () => {
  for (const name of ["pds.reading_bank_deck", "pds.reading_bank_summary", "pds.reading_bank_overview", "pds.reading_bank_chapter", "pds.reading_bank_attempt", "pds.reading_bank_flag"]) {
    const body = fn(fnsMain, name).body;
    assert.match(body, /reading_bank_quiz_through/, `${name} gate`);
  }
  for (const name of ["pds.reading_bank_deck", "pds.reading_bank_summary", "pds.reading_bank_overview", "pds.reading_bank_chapter", "pds.reading_bank_attempt"]) {
    assert.match(fn(fnsMain, name).body, /reading_bank_chapter_hash/, `${name} edition`);
  }
  assert.match(fn(fnsMain, "pds.reading_bank_enqueue").body, /BETWEEN 1 AND v_through/, "a chapter is recorded quizzable only below the gate");
});

test("an idea needs evidence; ideas are immutable; the planner input carries no highlight text", () => {
  const store = fn(fnsMain, "pds.reading_bank_store").body;
  assert.match(store, /OXB03/);
  assert.match(store, /OXB05/);
  assert.match(fn(fnsMain, "pds.reading_ideas_guard").body, /OXB10/);
  assert.match(main, /CREATE OR REPLACE TRIGGER trg_reading_ideas_guard BEFORE UPDATE ON pds\.reading_ideas/);
  const plan = fn(fnsMain, "pds.reading_bank_plan_input").body;
  assert.doesNotMatch(plan, /'passage',|'comment',|'recall',/);
  assert.match(plan, /pds\.reading_sha256\(h\.passage\)/);
  assert.doesNotMatch(fn(fnsMain, "pds.reading_bank_status").body, /title|statement|prompt|answer'/);
});

test("the checks file only widens T07's two checks", () => {
  const stmts = checks.replace(/--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean);
  assert.deepEqual(stmts[0], "BEGIN");
  assert.deepEqual(stmts.at(-1), "COMMIT");
  for (const s of stmts.slice(1, -1)) assert.match(s, /^ALTER TABLE pds\.(reading_questions|reading_question_attempts) (DROP CONSTRAINT IF EXISTS \w+|ADD CONSTRAINT \w+\s+CHECK \([\s\S]+\))$/);
  const list = (src, col) => [...(new RegExp(`${col}\\s+IN\\s+\\(([^)]*)\\)`).exec(src)?.[1] ?? "").matchAll(/'(\w+)'/g)].map((m) => m[1]);
  const t07Kinds = list(t07, "source_kind");
  const t07Graders = list(t07, "grader");
  assert.deepEqual(t07Kinds, ["highlight", "session", "chapter"]);
  assert.deepEqual(t07Graders, ["model", "self"]);
  const kinds = list(checks, "source_kind");
  const graders = list(checks, "grader");
  assert.ok(t07Kinds.every((k) => kinds.includes(k)) && kinds.includes("idea"));
  assert.ok(t07Graders.every((g) => graders.includes(g)) && graders.includes("local"));
  assert.match(checks, /grader IS NULL OR grader IN/);
  assert.match(checks, /DROP CONSTRAINT IF EXISTS reading_questions_source_kind_check/);
  assert.match(checks, /DROP CONSTRAINT IF EXISTS reading_question_attempts_grader_check/);
});

test("T07's export is re-defined with T07's fields unchanged and the spoiler gate on bank rows", () => {
  const a = fn(functions(t07), "pds.reading_questions_export").body;
  const b = fn(fnsMain, "pds.reading_questions_export").body;
  assert.deepEqual(objectsStartingWith(b, "question_id"), objectsStartingWith(a, "question_id"));
  assert.deepEqual(objectsStartingWith(b, "attempt_key"), objectsStartingWith(a, "attempt_key"));
  assert.deepEqual(objectsStartingWith(b, "questions"), objectsStartingWith(a, "questions"));
  assert.match(b, /reading_bank_quiz_through\(p_book\)/);
  const gates = b.match(/pds\.reading_bank_question_open\(q\.question_id, \(SELECT through FROM t\)\)/g) ?? [];
  assert.equal(gates.length, 2, "questions and the attempts on them");
  // The gate: unlocked, current edition, the idea unlocked, and every idea an (older) recall rubric names unlocked.
  const open = fn(fnsMain, "pds.reading_bank_question_open").body;
  assert.match(open, /WHEN q\.format IS NULL THEN true/);
  assert.match(open, /q\.unlock_chapter <= p_through/);
  assert.match(open, /q\.chapter_hash IS NOT DISTINCT FROM pds\.reading_bank_chapter_hash\(q\.book_id, q\.bank_chapter\)/);
  assert.match(open, /i\.idea_id = q\.idea_id AND i\.unlock_chapter > p_through/);
  assert.match(open, /q\.format = 'chapter_recall' THEN q\.rubric::jsonb->'ideas'[\s\S]*i\.unlock_chapter > p_through/);
});

test("the chapter recall rubric lists only ideas that unlock with the chapter, and nothing locked is served or answered", () => {
  const recall = fn(fnsMain, "pds.reading_bank_recall_rubric").body;
  assert.match(recall, /i\.unlock_chapter = p_ch/, "an unsure / whole-book / moved idea (unlock at the end) is never listed");
  assert.match(recall, /i\.chapter_hash = v_hash/);
  assert.match(recall, /reading_bank_idea_supported\(i\.idea_id\)/);
  assert.match(fn(fnsMain, "pds.reading_bank_recall_refresh").body, /v_rj := pds\.reading_bank_recall_rubric\(p_book, p_ch\)/);
  assert.doesNotMatch(fn(fnsMain, "pds.reading_bank_store").body, /'format', 'chapter_recall', 'ideas'/, "one rubric builder");
  const deck = fn(fnsMain, "pds.reading_bank_deck").body;
  assert.match(deck, /jsonb_array_elements\(q\.rubric::jsonb->'ideas'\)[\s\S]*i\.unlock_chapter > \(SELECT through FROM t\)/, "deck backstop");
  assert.match(deck, /pds\.reading_bank_recall_valid\(q\.rubric, p_book, c\.chapter\)/, "deck: every listed idea still valid");
  const attempt = fn(fnsMain, "pds.reading_bank_attempt").body;
  assert.match(attempt, /i\.idea_id = ANY\(v_covers\)[\s\S]*i\.unlock_chapter > pds\.reading_bank_quiz_through/, "attempt backstop");
  assert.match(attempt, /NOT pds\.reading_bank_recall_valid\(v_q\.rubric, v_q\.book_id, v_q\.bank_chapter\)[\s\S]{0,120}'question_changed'/, "attempt: never scores an idea without evidence");
  const valid = fn(fnsMain, "pds.reading_bank_recall_valid").body;
  for (const cond of ["i.status <> 'active'", "i.unlock_chapter <> p_ch", "i.chapter_hash <> pds.reading_bank_chapter_hash(p_book, p_ch)", "NOT pds.reading_bank_idea_supported(i.idea_id)"]) {
    assert.ok(valid.includes(cond), cond);
  }
  const flag = fn(fnsMain, "pds.reading_bank_flag").body;
  assert.ok((flag.match(/reading_bank_recall_refresh\(/g) ?? []).length >= 4, "wrong, not_in_chapter and their Restores re-version the recall");
});

test("served ideas need valid evidence; flags move state_version; chapter recall hits of a wrong idea are void", () => {
  for (const name of ["pds.reading_bank_deck", "pds.reading_bank_summary", "pds.reading_bank_overview", "pds.reading_bank_chapter", "pds.reading_bank_attempt"]) {
    assert.match(fn(fnsMain, name).body, /reading_bank_idea_supported/, `${name} evidence`);
  }
  assert.match(fn(fnsMain, "pds.reading_bank_idea_supported").body, /pds\.reading_sha256\(h\.passage\) = src\.passage_sha/);
  const flag = fn(fnsMain, "pds.reading_bank_flag").body;
  assert.doesNotMatch(flag, /SET dirty = true/, "dirty marks go through reading_bank_touch_states (which also moves state_version)");
  assert.ok((flag.match(/pds\.reading_bank_touch_states\(v_ideas, true\)/g) ?? []).length >= 2);
  const touch = fn(fnsMain, "pds.reading_bank_touch_states").body;
  assert.match(touch, /INSERT INTO pds\.reading_idea_state[\s\S]*1, COALESCE\(p_dirty, false\)[\s\S]*ON CONFLICT \(idea_id\) DO UPDATE SET state_version = s\.state_version \+ 1/,
    "an idea with no state row gets one at version 1, so a replay with basis 0 from before cannot pass");
  assert.match(fn(fnsMain, "pds.reading_bank_events").body, /f\.kind = 'wrong' AND f\.idea_id = c\.idea_id AND f\.created_at > a\.answered_at/);
  const grade = fn(fnsMain, "pds.reading_bank_grade").body;
  assert.match(grade, /v_a\.covers/, "a chapter recall grade carries every covered idea's state");
  assert.match(fn(fnsMain, "pds.reading_bank_attempt").body, /unnest\(v_need\)/);
});

test("the store is replay safe per job, bound to the planned edition, and keeps a working bank over an empty rebuild", () => {
  const store = fn(fnsMain, "pds.reading_bank_store").body;
  assert.match(store, /v_job IS NULL/, "job_id is required");
  assert.match(store, /v_jobrow\.store_receipt IS NOT NULL[\s\S]*'replayed', true/);
  assert.match(store, /UPDATE pds\.reading_bank_jobs SET store_receipt = v_receipt/);
  assert.match(store, /v_chash <> v_hash[\s\S]*'chapter_changed'/);
  assert.match(store, /'highlight_changed'/);
  assert.match(store, /v_keep := v_replace AND jsonb_array_length/);
  assert.match(store, /IF v_replace AND NOT v_keep THEN/);
  // Every refusal before the first write returns; nothing is retired before the edition and replay checks.
  assert.ok(store.indexOf("'chapter_changed'") < store.indexOf("SET status = 'retired'"));
  assert.match(store, /INSERT INTO pds\.reading_bank_highlight_seen/);
});

test("the store is fenced like finish: live lease, the claim's attempt, and the chapter's rebuild generation", () => {
  const store = fn(fnsMain, "pds.reading_bank_store").body;
  assert.match(store, /v_att := NULLIF\(p->>'attempts', ''\)::int;/);
  assert.match(store, /OR v_att IS NULL OR/, "attempts is required");
  assert.match(store, /OR \(v_replace AND v_rebuild IS NULL\)/, "a replacing store names the generation it was planned for");
  assert.match(store, /v_jobrow\.status <> 'running' OR v_jobrow\.lease_until IS NULL OR v_jobrow\.lease_until < NOW\(\)[\s\S]{0,120}'not_running'/);
  assert.match(store, /IF v_att <> v_jobrow\.attempts OR v_seq <> v_jobrow\.claim_seq THEN[\s\S]{0,120}'lease_lost'/);
  assert.match(store, /v_seq := NULLIF\(p->>'claim_seq', ''\)::bigint;/);
  assert.match(store, /OR v_att IS NULL OR v_seq IS NULL OR/, "claim_seq is required too");
  assert.match(store, /v_rebuild < COALESCE\(\s*\(SELECT c\.rebuilds FROM pds\.reading_bank_chapters c[\s\S]{0,160}'stale_generation'/);
  // A receipt replay needs no lease; every fence answers before the first write (nothing is retired by a stale run).
  const at = (needle) => store.indexOf(needle);
  assert.ok(at("store_receipt IS NOT NULL") < at("'not_running'"));
  for (const code of ["'not_running'", "'lease_lost'", "'stale_generation'"]) {
    assert.ok(at(code) > 0 && at(code) < at("SET status = 'retired'"), code);
    assert.ok(at(code) < at("INSERT INTO pds.reading_bank_sources"), code);
  }
});

test("a month's spend is read from charged_at, which only a charge sets, so a re-queued job keeps its earlier cost", () => {
  assert.match(main, /charged_at\s+TIMESTAMPTZ,/);
  for (const name of ["pds.reading_bank_claim", "pds.reading_bank_reserve", "pds.reading_bank_status"]) {
    const body = fn(fnsMain, name).body;
    assert.match(body, /sum\(cost_cents\)[^;]*charged_at >= \(date_trunc\('month'/, `${name} sums by charge time`);
    assert.doesNotMatch(body, /finished_at >= \(date_trunc\('month'/, `${name} never by the queue's own time`);
  }
  assert.match(fn(fnsMain, "pds.reading_bank_claim").body, /charged_at = CASE WHEN reserved_cents > 0 THEN NOW\(\) ELSE charged_at END/);
  assert.match(fn(fnsMain, "pds.reading_bank_finish").body, /charged_at = CASE WHEN v_cost > 0 THEN NOW\(\) ELSE charged_at END/);
  // The re-queue clears the queue's times but touches neither the cost nor its date.
  const enq = fn(fnsMain, "pds.reading_bank_enqueue").body;
  const set = /SET status = 'queued'[^;]*/.exec(enq)?.[0] ?? "";
  assert.ok(set && !/cost_cents|charged_at/.test(set));
});

test("a flag voids the ideas fed by every answer it invalidated, across question versions; a moved idea's flag stays listed", () => {
  const flag = fn(fnsMain, "pds.reading_bank_flag").body;
  assert.match(flag, /SELECT a\.idea_id FROM pds\.reading_question_attempts a WHERE a\.attempt_key = ANY\(v_hit\)/);
  assert.match(flag, /SELECT unnest\(a\.covers\) FROM pds\.reading_question_attempts a WHERE a\.attempt_key = ANY\(v_hit\)/);
  assert.ok(flag.indexOf("reading_bank_touch_states(v_ideas, true)", flag.indexOf("unnest(a.covers)")) > 0, "collected before the states are marked");
  const chapter = fn(fnsMain, "pds.reading_bank_chapter").body;
  assert.match(chapter, /f\.kind = 'not_in_chapter' AND COALESCE\(f\.prev_unlock, q\.bank_chapter\) <= \(SELECT through FROM t\)/);
  assert.match(chapter, /q\.unlock_chapter <= \(SELECT through FROM t\)/, "other flags stay on the unlock gate");
});

test("the planner keys highlight freshness on content, never on updated_at", () => {
  const plan = fn(fnsMain, "pds.reading_bank_plan_input").body;
  assert.doesNotMatch(plan, /updated_at|changed_at/);
  assert.match(plan, /reading_bank_highlight_seen/);
  assert.match(plan, /src\.passage_sha = x\.sha/);
});

test("a Kindle note with no highlight under it (highlighted_at NULL, note_at set) is a comment: not offered, not evidence, not marked seen", () => {
  const plan = fn(fnsMain, "pds.reading_bank_plan_input").body;
  assert.match(plan, /NOT \(h\.highlighted_at IS NULL AND h\.note_at IS NOT NULL\)/, "the planner's highlight list");
  const store = fn(fnsMain, "pds.reading_bank_store").body;
  assert.match(store, /NOT \(h\.highlighted_at IS NULL AND h\.note_at IS NOT NULL\)/, "a highlight source must not be a standalone note");
  assert.match(store, /NOT \(h2\.highlighted_at IS NULL AND h2\.note_at IS NOT NULL\)/, "the seen fallback");
});

test("the queue charges an expired lease's reservation and fences finish by attempt", () => {
  const claim = fn(fnsMain, "pds.reading_bank_claim").body;
  assert.match(claim, /cost_cents = cost_cents \+ reserved_cents/);
  assert.match(claim, /spent_cents = spent_cents \+ v_exp\.reserved_cents/);
  assert.match(claim, /'headroom_cents'/);
  assert.doesNotMatch(claim, /j\.status = 'running' AND j\.lease_until < NOW\(\)\)/, "expired leases are settled first, never re-claimed as running");
  const finish = fn(fnsMain, "pds.reading_bank_finish").body;
  assert.match(finish, /OR v_att IS NULL OR v_seq IS NULL THEN/);
  assert.match(finish, /IF v_att <> v_job\.attempts OR v_seq <> v_job\.claim_seq THEN/);
});

test("T07's own paths are fenced off bank rows (answers, grades, new versions)", () => {
  assert.match(main, /CREATE OR REPLACE TRIGGER trg_reading_bank_attempt_guard BEFORE INSERT OR UPDATE ON pds\.reading_question_attempts/);
  assert.match(main, /CREATE OR REPLACE TRIGGER trg_reading_bank_question_guard BEFORE INSERT ON pds\.reading_questions/);
  const guard = fn(fnsMain, "pds.reading_bank_attempt_guard").body;
  assert.match(guard, /NEW\.ext_hash IS NULL[\s\S]*q\.format IS NOT NULL/);
  assert.match(guard, /NEW\.verdict IS NULL/);
  assert.match(fn(fnsMain, "pds.reading_bank_question_guard").body, /current_setting\('pds\.reading_bank_write', true\)/);
  assert.match(fn(fnsMain, "pds.reading_bank_recall_refresh").body, /set_config\('pds\.reading_bank_write', 'on', true\)/);
});

test("the last chapter unlocks from a session Riley logged himself, not a Kindle-made one", () => {
  const gate = fn(fnsMain, "pds.reading_bank_quiz_through").body;
  const last = gate.slice(gate.indexOf("last_ch AS"), gate.indexOf("raw AS"));
  assert.match(last, /s\.source <> 'kindle'/);
});

test("schema_ok reports both checks, the idea branch and the export gate (the worker's preflight)", () => {
  const body = fn(fnsMain, "pds.reading_bank_schema_ok").body;
  for (const k of ["source_kind_idea", "grader_local", "idea_source_branch", "export_gate", "all_ok"]) assert.match(body, new RegExp(`'${k}'`));
  // Every check on the value list must allow the bank's value (a narrower one left under another name still refuses).
  assert.match(body, /NOT EXISTS \(SELECT 1 FROM c WHERE conrelid = 'pds\.reading_questions'::regclass AND def ~ '\\msource_kind = ANY'\s+AND def NOT LIKE '%''idea''%'\)/);
  assert.match(body, /NOT EXISTS \(SELECT 1 FROM c WHERE conrelid = 'pds\.reading_question_attempts'::regclass AND def ~ '\\mgrader = ANY'\s+AND def NOT LIKE '%''local''%'\)/);
  assert.match(body, /position\('reading_bank_question_open' IN pg_get_functiondef\('pds\.reading_questions_export\(bigint\)'::regprocedure\)\)/);
});

test("a chapter recall graded with no hit for an idea gives it the answer's verdict, never a blanket 'incorrect'", () => {
  const ev = fn(fnsMain, "pds.reading_bank_events").body;
  assert.match(ev, /WHEN h\.hit = 'no' THEN 'incorrect'\s+ELSE a\.verdict END/);
  assert.doesNotMatch(ev, /WHEN h\.hit = 'partial' THEN 'partial' ELSE 'incorrect'/);
});

test("pending answers move the state_version of what they cover; grade jobs of answers no longer pending are never claimed", () => {
  const attempt = fn(fnsMain, "pds.reading_bank_attempt").body;
  assert.match(attempt, /ELSE\s+PERFORM pds\.reading_bank_touch_states\(v_need, false\);\s+INSERT INTO pds\.reading_bank_jobs/);
  assert.match(attempt, /CASE WHEN v_inline THEN NOW\(\) \+ interval '10 minutes' ELSE NOW\(\) END/, "an inline (chat) grade's job is only a safety net");
  const claim = fn(fnsMain, "pds.reading_bank_claim").body;
  const skip = claim.indexOf("SET status = 'skipped'");
  assert.ok(skip > 0 && skip < claim.indexOf("SELECT j.* INTO v_job"), "skipped before the pick");
  assert.match(claim, /j\.step = 'grade' AND j\.status = 'queued'\s+AND NOT EXISTS \(SELECT 1 FROM pds\.reading_question_attempts a WHERE a\.attempt_key = j\.attempt_key AND a\.grading_status = 'pending'\)/);
});

test("reserve raises a running job's reservation only within both caps, under the claim lock", () => {
  const r = fn(fnsMain, "pds.reading_bank_reserve").body;
  const lock = r.indexOf("pg_advisory_xact_lock(hashtext('pds.reading_bank_claim'))");
  assert.ok(lock > 0 && lock < r.indexOf("UPDATE pds.reading_bank_jobs SET reserved_cents"));
  assert.match(r, /v_job\.status <> 'running' OR v_job\.lease_until IS NULL OR v_job\.lease_until < NOW\(\)/);
  assert.match(r, /IF v_att <> v_job\.attempts OR v_seq <> v_job\.claim_seq THEN[\s\S]{0,80}'lease_lost'/);
  assert.match(r, /v_month \+ v_delta > v_capm[\s\S]{0,120}'monthly_cap'/);
  assert.match(r, /v_used \+ v_delta > v_bk\.approved_cents[\s\S]{0,260}'budget'/);
  assert.match(r, /sum\(reserved_cents\) FILTER \(WHERE status = 'running'\)/, "every other running job's reservation counts");
});

test("reserve counts a running job's reservation until its lease is settled, an expired one included", () => {
  const r = fn(fnsMain, "pds.reading_bank_reserve").body;
  // An expired lease is billed work that no claim has charged yet: it must not free its headroom to another job.
  assert.doesNotMatch(r, /lease_until >= NOW\(\)/, "no sum drops a running job because its lease ran out");
  assert.match(r, /sum\(r\.reserved_cents\) FROM pds\.reading_bank_jobs r\s+WHERE r\.book_id = v_bk\.book_id AND r\.status = 'running'\)/);
  const claim = fn(fnsMain, "pds.reading_bank_claim").body;
  assert.match(claim, /sum\(reserved_cents\) FILTER \(WHERE status = 'running'\)/);
  assert.doesNotMatch(claim, /status = 'running' AND lease_until >= NOW\(\)/);
  assert.match(claim, /sum\(r\.reserved_cents\) FROM pds\.reading_bank_jobs r\s+WHERE r\.book_id = b\.book_id AND r\.status = 'running'\)/);
});

test("reserve refuses a book that is off or paused before it looks at the money, even a request that needs no more", () => {
  const r = fn(fnsMain, "pds.reading_bank_reserve").body;
  assert.match(r, /IF v_job\.step <> 'grade' THEN\s+SELECT \* INTO v_bk FROM pds\.reading_bank_books WHERE book_id = v_job\.book_id FOR UPDATE;/, "grading is not tied to a book's approval");
  const gate = r.indexOf("v_bk.approved_at IS NULL OR v_bk.paused_at IS NOT NULL");
  assert.ok(gate > 0, "the book must be approved and not paused");
  assert.ok(gate < r.indexOf("IF v_total <= v_job.reserved_cents THEN"), "checked before the early success for a total already reserved");
  assert.ok(gate < r.indexOf("UPDATE pds.reading_bank_jobs SET reserved_cents"), "and before anything is reserved");
  assert.match(r, /CASE WHEN v_bk\.paused_reason = 'budget' THEN 'budget' ELSE 'paused' END/);
  // The lock order stays claim lock, then job row, then book row (as the claim takes them).
  assert.ok(r.indexOf("pg_advisory_xact_lock(hashtext('pds.reading_bank_claim'))") < r.indexOf("FROM pds.reading_bank_jobs WHERE job_id") && r.indexOf("FROM pds.reading_bank_jobs WHERE job_id") < r.indexOf("INTO v_bk"));
});

test("the queue fence is two numbers: attempts (a re-queue resets it) and claim_seq (never), both required by reserve, finish, store and the map write", () => {
  assert.match(main, /claim_seq\s+BIGINT\s+NOT NULL DEFAULT 0,/);
  assert.match(main, /ALTER TABLE pds\.reading_bank_jobs ADD COLUMN IF NOT EXISTS claim_seq BIGINT NOT NULL DEFAULT 0;/);
  assert.match(fn(fnsMain, "pds.reading_bank_claim").body, /attempts = attempts \+ 1, claim_seq = claim_seq \+ 1,/);
  const enq = fn(fnsMain, "pds.reading_bank_enqueue").body;
  const set = /SET status = 'queued'[^;]*/.exec(enq)?.[0] ?? "";
  assert.match(set, /attempts = 0/, "a re-queue gives the tries back");
  assert.doesNotMatch(set, /claim_seq/, "and never touches the claim counter, so a worker from before can never match a later claim");
  assert.deepEqual(fnsMain.filter((f) => /claim_seq\s*=\s*/.test(f.body)).map((f) => f.name), ["pds.reading_bank_claim"], "only the claim moves it, and only up");
  for (const name of ["pds.reading_bank_reserve", "pds.reading_bank_finish", "pds.reading_bank_store", "pds.reading_bank_set_map"]) {
    const body = fn(fnsMain, name).body;
    assert.match(body, /v_seq := NULLIF\(p->>'claim_seq', ''\)::bigint;/, `${name} reads claim_seq`);
    assert.match(body, /v_seq IS NULL/, `${name} requires it`);
    assert.match(body, /v_seq <> v_job(row)?\.claim_seq/, `${name} compares it`);
  }
});

test("the source map is written only by the run holding the map job's live lease, and only for the book's current table of contents", () => {
  const m = fn(fnsMain, "pds.reading_bank_set_map").body;
  for (const v of ["v_book", "v_jid", "v_att", "v_seq"]) assert.match(m, new RegExp(`${v} IS NULL`), `${v} is required`);
  assert.match(m, /v_toc !~ '\^\[0-9a-f\]\{64\}\$'/);
  const at = (needle) => m.indexOf(needle);
  assert.ok(at("pg_advisory_xact_lock(hashtext('pds.reading_bank_claim'))") > 0 && at("pg_advisory_xact_lock") < at("FROM pds.reading_bank_jobs WHERE job_id = v_jid FOR UPDATE"));
  assert.match(m, /v_job\.book_id <> v_book OR v_job\.step <> 'map' THEN\s+RETURN jsonb_build_object\('ok', false, 'http', 409, 'code', 'job_mismatch'\)/);
  assert.match(m, /v_job\.status <> 'running' OR v_job\.lease_until IS NULL OR v_job\.lease_until < NOW\(\) THEN\s+RETURN jsonb_build_object\('ok', false, 'http', 409, 'code', 'not_running'\)/);
  assert.match(m, /IF v_att <> v_job\.attempts OR v_seq <> v_job\.claim_seq THEN\s+RETURN jsonb_build_object\('ok', false, 'http', 409, 'code', 'lease_lost'\)/);
  assert.match(m, /v_toc IS NOT NULL AND v_toc <> pds\.reading_bank_toc_hash\(v_book\) THEN\s+RETURN jsonb_build_object\('ok', true, 'stored', false, 'code', 'toc_changed'\)/, "a stale table of contents stores nothing and costs no retry");
  for (const code of ["'job_mismatch'", "'not_running'", "'lease_lost'", "'toc_changed'"]) assert.ok(at(code) > 0 && at(code) < at("UPDATE pds.reading_bank_books"), `${code} answers before the write`);
  assert.match(m, /WHERE book_id = v_book;/, "the book the job belongs to, never another");
});

test("a refusal to spend is not a failed try: a cost-free retry with a cost-refusal code gives the try back", () => {
  const f = fn(fnsMain, "pds.reading_bank_finish").body;
  assert.match(f, /v_defer := v_out = 'retry' AND v_cost = 0 AND COALESCE\(p->>'error_code', ''\) IN \('cost_limit', 'monthly_cap', 'budget', 'paused'\);/);
  assert.match(f, /CASE WHEN attempts >= 3 AND NOT v_defer THEN 'failed' ELSE 'queued' END/, "never failed by refusals");
  assert.match(f, /attempts = CASE WHEN v_defer THEN GREATEST\(attempts - 1, 0\) ELSE attempts END/);
  assert.match(f, /v_job\.step = 'grade' AND v_out <> 'done' AND NOT v_defer THEN/, "and not a grade try either");
  // A retry that billed something still uses its try (a request that always stops half way cannot repeat for ever).
  assert.match(f, /v_cost = 0/);
});

test("claim: the first request's bound, when sent, is the cap test (with the pause); the estimate is still what is reserved", () => {
  const c = fn(fnsMain, "pds.reading_bank_claim").body;
  assert.match(c, /v_need := GREATEST\(v_est, LEAST\(GREATEST\(COALESCE\(NULLIF\(p->'bounds'->>v_job\.step, ''\)::numeric, 0\), 0\), 100000\)\);/);
  assert.match(c, /IF v_month \+ v_need > v_capm THEN\s+RETURN jsonb_build_object\('ok', true, 'job', NULL, 'code', 'monthly_cap'\)/);
  assert.match(c, /v_used \+ v_need > v_cap THEN[\s\S]{0,260}paused_reason = 'budget'/);
  assert.match(c, /reserved_cents = v_est\b/);
});

test("a failed job has a way back: web_search_disabled retried after 6 h, the map through the book-level Rebuild", () => {
  const enq = fn(fnsMain, "pds.reading_bank_enqueue").body;
  assert.match(enq, /WHERE jb\.status = 'skipped'\s+OR \(jb\.status = 'failed' AND jb\.error_code = 'web_search_disabled' AND jb\.finished_at < NOW\(\) - interval '6 hours'\)/);
  assert.match(enq, /PERFORM pds\.reading_bank_recall_sync\(v_book\)/);
  const rb = fn(fnsMain, "pds.reading_bank_rebuild").body;
  assert.match(rb, /IF v_ch = 0 THEN[\s\S]*map_rebuilds = b\.map_rebuilds \+ 1/);
  assert.match(fn(fnsMain, "pds.reading_bank_plan_input").body, /'map_rebuilds', COALESCE\(\(SELECT map_rebuilds FROM bb\), 0\)/);
  assert.match(main, /map_rebuilds\s+INTEGER\s+NOT NULL DEFAULT 0/);
});

test("a Rebuild is decided, counted and enqueued in one call under the claim lock (two overlapping taps cannot both count)", () => {
  const rb = fn(fnsMain, "pds.reading_bank_rebuild").body;
  const lock = rb.indexOf("pg_advisory_xact_lock(hashtext('pds.reading_bank_claim'))");
  const pending = rb.indexOf("'pending', true");
  const count = rb.indexOf("INSERT INTO pds.reading_bank_chapters AS c");
  const enqueue = rb.indexOf("pds.reading_bank_enqueue(p->'plan')");
  assert.ok(lock > 0 && lock < pending && pending < count && count < enqueue, "lock, then the pending check, then the count, then the enqueue");
  assert.match(rb, /SELECT c\.rebuilds INTO v_cur FROM pds\.reading_bank_chapters c WHERE c\.book_id = v_book AND c\.chapter = v_ch;/, "the stored count is read after the lock");
  assert.match(rb, /v_exp IS NOT NULL AND v_exp <> v_cur/, "a count that moved since the caller read it is not counted again");
  assert.match(rb, /j\.status IN \('queued', 'running'\)\s+AND j\.step = ANY \(CASE WHEN v_ch = 0 THEN ARRAY\['map', 'build'\] ELSE ARRAY\['research', 'build'\] END\)/, "open work of the chapter (the map and the whole-book build for chapter 0)");
  assert.match(rb, /IF v_has_plan THEN v_enq := pds\.reading_bank_enqueue\(p->'plan'\)/);
  assert.match(rb, /v_has_plan AND v_plan_book IS DISTINCT FROM v_book/, "a plan for another book is refused");
});

test("the recall rubric follows its ideas: every store refreshes it, the sync re-versions a stale one without voiding answers", () => {
  const store = fn(fnsMain, "pds.reading_bank_store").body;
  assert.match(store, /IF v_ch >= 1 AND NOT v_keep THEN\s+v_qs := v_qs \+ pds\.reading_bank_recall_refresh/);
  assert.match(store, /CASE WHEN v_replace THEN NULL ELSE false END, v_replace\)/, "the highlights step keeps the answers already given");
  const sync = fn(fnsMain, "pds.reading_bank_recall_sync").body;
  assert.match(sync, /q\.rubric IS DISTINCT FROM pds\.reading_bank_recall_rubric\(p_book, q\.bank_chapter\)::text/);
  assert.match(sync, /reading_bank_recall_refresh\(p_book, v_ch, NULL, NULL, 'chapter ideas changed', false, false\)/);
});

test("the end of the book is never 'now': the store and the flag unlock unsure, moved and whole-book ideas there", () => {
  assert.match(fn(fnsMain, "pds.reading_bank_end_chapter").body, /ELSE 2147483647 END/);
  const store = fn(fnsMain, "pds.reading_bank_store").body;
  assert.match(store, /v_unlock := CASE WHEN v_ch = 0 OR v_unlock > v_ch THEN GREATEST\(v_ch, v_end\) ELSE v_ch END;/);
  assert.match(store, /v_end := pds\.reading_bank_end_chapter\(v_book\)/);
  assert.match(fn(fnsMain, "pds.reading_bank_flag").body, /v_total := pds\.reading_bank_end_chapter\(v_q\.book_id\)/);
});

test("a flag on an older question version acts on the current one; a chapter never gets two live recall questions back", () => {
  const flag = fn(fnsMain, "pds.reading_bank_flag").body;
  assert.match(flag, /IF v_q\.superseded_at IS NOT NULL THEN[\s\S]{0,200}question_key = v_q\.question_key AND superseded_at IS NULL[\s\S]{0,200}'question_changed'/);
  assert.match(flag, /CASE WHEN question_id = v_q\.question_id THEN v_kind ELSE 'idea_retired' END/);
  assert.match(flag, /VALUES \(v_key, v_q\.question_id, v_q\.idea_id/, "the flag row records the version acted on");
  assert.match(flag, /o\.question_key <> v_q\.question_key AND o\.superseded_at IS NULL AND o\.retired_at IS NULL\) THEN\s+RETURN jsonb_build_object\('ok', false, 'http', 409, 'code', 'superseded'\)/);
});
// READ-QUIZ-01: static guards on sql/reading_question_bank.sql and sql/reading_question_bank_checks.sql (no
// database: the files are read as text). Keeps the bank additive, private, locked, and on PROD-T07's formulas.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { SRC } = require("./helpers/load-ts.cjs");

const read = (rel) => fs.readFileSync(path.join(SRC, "..", "..", rel), "utf8");
const main = read("sql/reading_question_bank.sql");
const checks = read("sql/reading_question_bank_checks.sql");
const t07 = read("sql/reading_learning_questions.sql");

/** Each CREATE OR REPLACE FUNCTION in a file: name, argument types, language, body. */
function functions(sql) {
  const out = [];
  const re = /CREATE OR REPLACE FUNCTION (pds\.\w+)\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(sql))) {
    const start = m.index;
    const open = sql.indexOf("$fn$", start);
    const close = sql.indexOf("$fn$", open + 4);
    const head = sql.slice(start, open);
    const types = m[2].trim() ? m[2].split(",").map((a) => a.replace(/\bDEFAULT\b.*$/i, "").trim().split(/\s+/)[1].toLowerCase()) : [];
    out.push({ name: m[1], sig: `${m[1]}(${types.join(",")})`, language: /LANGUAGE\s+(\w+)/i.exec(head)?.[1].toLowerCase(), body: sql.slice(open + 4, close) });
  }
  return out;
}

/** The argument list of the first jsonb_build_object( after `from`, split at top-level commas. */
function buildObjectArgs(text, from = 0) {
  const at = text.indexOf("jsonb_build_object(", from);
  if (at < 0) return null;
  let i = at + "jsonb_build_object(".length;
  let depth = 0;
  let quote = false;
  let cur = "";
  const args = [];
  for (; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      cur += ch;
      if (ch === "'") quote = false;
      continue;
    }
    if (ch === "'") {
      quote = true;
      cur += ch;
    } else if (ch === "(") {
      depth++;
      cur += ch;
    } else if (ch === ")") {
      if (depth === 0) break;
      depth--;
      cur += ch;
    } else if (ch === "," && depth === 0) {
      args.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  args.push(cur.trim());
  return args;
}
const keysOf = (args) => args.filter((_, i) => i % 2 === 0).map((k) => k.replace(/^'|'$/g, ""));
/** Every jsonb_build_object in `text` whose first key is `firstKey`, as key lists. */
function objectsStartingWith(text, firstKey) {
  const out = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf("jsonb_build_object(", from);
    if (at < 0) return out;
    const args = buildObjectArgs(text, at);
    if (args && args[0] === `'${firstKey}'`) out.push(keysOf(args));
    from = at + 1;
  }
}

const fnsMain = functions(main);
const fn = (fns, name) => fns.find((f) => f.name === name);

test("the main file is additive: no destructive keyword anywhere, comments included", () => {
  assert.doesNotMatch(main, /\b(DROP|DELETE|TRUNCATE)\b/i);
  assert.doesNotMatch(main, /\bCREATE\s+POLICY\b/i, "service role only: no policies");
});

test("no IF / ELSIF / WHILE condition starts with a bare CASE: PL/pgSQL ends the condition at the CASE's own THEN and the function would not create", () => {
  for (const f of fnsMain.filter((x) => x.language === "plpgsql")) {
    const code = f.body.replace(/--[^\n]*/g, "");
    assert.doesNotMatch(code, /\b(IF|ELSIF|WHILE)\s+(NOT\s+)?CASE\b/i, `${f.name}: parenthesize the CASE`);
  }
});

test("every new table: row level security on, revoked from PUBLIC / anon / authenticated, granted to service_role only", () => {
  const tables = [...main.matchAll(/CREATE TABLE IF NOT EXISTS pds\.(\w+)/g)].map((m) => m[1]);
  assert.equal(tables.length, 9);
  const revoke = /REVOKE ALL ON ([^;]+?)\s+FROM PUBLIC, anon, authenticated;/.exec(main)?.[1] ?? "";
  const grant = /GRANT SELECT, INSERT, UPDATE ON ([^;]+?) TO service_role;/.exec(main)?.[1] ?? "";
  for (const t of tables) {
    assert.match(main, new RegExp(`ALTER TABLE pds\\.${t}\\s+ENABLE ROW LEVEL SECURITY`), t);
    assert.ok(revoke.includes(`pds.${t}`), `${t} revoked`);
    assert.ok(grant.includes(`pds.${t}`), `${t} granted to service_role`);
  }
  assert.doesNotMatch(main, /\bGRANT\b[^;]*\bTO\b[^;]*\b(anon|authenticated|PUBLIC)\b/i);
});

test("every function is revoked from the public roles and executable by service_role only", () => {
  const block = main.slice(main.indexOf("DO $grants$"), main.indexOf("END $grants$"));
  const listed = [...block.matchAll(/'(pds\.\w+\([^)]*\))'/g)].map((m) => m[1].replace(/\s+/g, ""));
  const defined = fnsMain.map((f) => f.sig);
  assert.deepEqual([...listed].sort(), [...defined].sort());
  assert.match(block, /REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated/);
  assert.match(block, /GRANT EXECUTE ON FUNCTION %s TO service_role/);
});

test("every write function takes the practice lock or the claim lock before its first write", () => {
  const LOCK = /pg_advisory_xact_lock\(hashtext\('pds\.reading_(practice|bank_claim)'\)\)/;
  const WRITE = /\b(INSERT\s+INTO|UPDATE\s+pds\.)/;
  const writers = fnsMain.filter((f) => WRITE.test(f.body));
  assert.ok(writers.length >= 12);
  for (const f of writers) {
    assert.equal(f.language, "plpgsql", f.name);
    const lock = f.body.search(LOCK);
    assert.ok(lock >= 0 && lock < f.body.search(WRITE), `${f.name} locks before writing`);
  }
  for (const f of fnsMain.filter((x) => x.language === "sql")) assert.doesNotMatch(f.body, WRITE, `${f.name} is read only`);
});

test("PROD-T07's content-hash, request-hash and answer-hash formulas are used unchanged", () => {
  const apply = fn(functions(t07), "pds.reading_question_apply").body;
  const contentT07 = objectsStartingWith(apply, "prompt");
  const requestT07 = objectsStartingWith(apply, "book_id");
  assert.ok(contentT07.length >= 1 && requestT07.length >= 1);
  assert.deepEqual(contentT07[0], ["prompt", "rubric", "source_kind", "source_ref", "source_hash"]);
  assert.deepEqual(requestT07[0], ["book_id", "question_key", "prompt", "rubric", "source_kind", "source_ref", "answer", "quiz_key"]);

  const store = fn(fnsMain, "pds.reading_bank_store").body;
  const attempt = fn(fnsMain, "pds.reading_bank_attempt").body;
  const recall = fn(fnsMain, "pds.reading_bank_recall_refresh").body;
  const contentBank = [...objectsStartingWith(store, "prompt"), ...objectsStartingWith(recall, "prompt"), ...objectsStartingWith(attempt, "prompt")];
  assert.ok(contentBank.length >= 3, "idea questions, chapter recall, and the attempt's re-check");
  for (const keys of contentBank) assert.deepEqual(keys, contentT07[0]);
  const requestBank = objectsStartingWith(attempt, "book_id");
  assert.equal(requestBank.length, 1);
  assert.deepEqual(requestBank[0], requestT07[0]);
  assert.match(apply, /pds\.reading_sha256\(v_answer\)/);
  assert.match(attempt, /answer_hash[\s\S]*pds\.reading_sha256\(v_answer\)/);
  // Rubric and prompt go into the formula as TEXT, like T07's variables (a jsonb value would hash differently).
  assert.match(store, /v_rub := \(v_q->'rubric'\)::text;/);
});

test("reading_source_text keeps T07's three branches verbatim and adds only the idea branch", () => {
  const norm = (s) => s.replace(/\s+/g, " ").trim();
  const closing = /\)\s*x\s+LIMIT 1\s*$/;
  const a = fn(functions(t07), "pds.reading_source_text").body.split("UNION ALL");
  const b = fn(fnsMain, "pds.reading_source_text").body.split("UNION ALL");
  assert.equal(a.length, 3);
  assert.equal(b.length, 4);
  assert.equal(norm(b[0]), norm(a[0]));
  assert.equal(norm(b[1]), norm(a[1]));
  assert.equal(norm(b[2]), norm(a[2].replace(closing, "")));
  assert.match(b[3], /p_kind = 'idea'/);
  assert.match(b[3], /i\.status = 'active'/);
  assert.match(norm(b[3]), closing);
});

test("reading_bank_attempt applies T07's answer rules with T07's refusal codes", () => {
  const body = fn(fnsMain, "pds.reading_bank_attempt").body;
  for (const code of ["quiz_closed", "already_answered", "quiz_other_book", "source_not_permitted", "question_changed", "key_reused", "locked", "chapter_changed", "retired"]) {
    assert.match(body, new RegExp(`'${code}'`), code);
  }
  assert.match(body, /reading_bank_quiz_through/);
});

test("the spoiler gate and the edition check are applied by every read and by the attempt", () => {
  for (const name of ["pds.reading_bank_deck", "pds.reading_bank_summary", "pds.reading_bank_overview", "pds.reading_bank_chapter", "pds.reading_bank_attempt", "pds.reading_bank_flag"]) {
    const body = fn(fnsMain, name).body;
    assert.match(body, /reading_bank_quiz_through/, `${name} gate`);
  }
  for (const name of ["pds.reading_bank_deck", "pds.reading_bank_summary", "pds.reading_bank_overview", "pds.reading_bank_chapter", "pds.reading_bank_attempt"]) {
    assert.match(fn(fnsMain, name).body, /reading_bank_chapter_hash/, `${name} edition`);
  }
  assert.match(fn(fnsMain, "pds.reading_bank_enqueue").body, /BETWEEN 1 AND v_through/, "a chapter is recorded quizzable only below the gate");
});

test("an idea needs evidence; ideas are immutable; the planner input carries no highlight text", () => {
  const store = fn(fnsMain, "pds.reading_bank_store").body;
  assert.match(store, /OXB03/);
  assert.match(store, /OXB05/);
  assert.match(fn(fnsMain, "pds.reading_ideas_guard").body, /OXB10/);
  assert.match(main, /CREATE OR REPLACE TRIGGER trg_reading_ideas_guard BEFORE UPDATE ON pds\.reading_ideas/);
  const plan = fn(fnsMain, "pds.reading_bank_plan_input").body;
  assert.doesNotMatch(plan, /'passage',|'comment',|'recall',/);
  assert.match(plan, /pds\.reading_sha256\(h\.passage\)/);
  assert.doesNotMatch(fn(fnsMain, "pds.reading_bank_status").body, /title|statement|prompt|answer'/);
});

test("the checks file only widens T07's two checks", () => {
  const stmts = checks.replace(/--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean);
  assert.deepEqual(stmts[0], "BEGIN");
  assert.deepEqual(stmts.at(-1), "COMMIT");
  for (const s of stmts.slice(1, -1)) assert.match(s, /^ALTER TABLE pds\.(reading_questions|reading_question_attempts) (DROP CONSTRAINT IF EXISTS \w+|ADD CONSTRAINT \w+\s+CHECK \([\s\S]+\))$/);
  const list = (src, col) => [...(new RegExp(`${col}\\s+IN\\s+\\(([^)]*)\\)`).exec(src)?.[1] ?? "").matchAll(/'(\w+)'/g)].map((m) => m[1]);
  const t07Kinds = list(t07, "source_kind");
  const t07Graders = list(t07, "grader");
  assert.deepEqual(t07Kinds, ["highlight", "session", "chapter"]);
  assert.deepEqual(t07Graders, ["model", "self"]);
  const kinds = list(checks, "source_kind");
  const graders = list(checks, "grader");
  assert.ok(t07Kinds.every((k) => kinds.includes(k)) && kinds.includes("idea"));
  assert.ok(t07Graders.every((g) => graders.includes(g)) && graders.includes("local"));
  assert.match(checks, /grader IS NULL OR grader IN/);
  assert.match(checks, /DROP CONSTRAINT IF EXISTS reading_questions_source_kind_check/);
  assert.match(checks, /DROP CONSTRAINT IF EXISTS reading_question_attempts_grader_check/);
});

test("T07's export is re-defined with T07's fields unchanged and the spoiler gate on bank rows", () => {
  const a = fn(functions(t07), "pds.reading_questions_export").body;
  const b = fn(fnsMain, "pds.reading_questions_export").body;
  assert.deepEqual(objectsStartingWith(b, "question_id"), objectsStartingWith(a, "question_id"));
  assert.deepEqual(objectsStartingWith(b, "attempt_key"), objectsStartingWith(a, "attempt_key"));
  assert.deepEqual(objectsStartingWith(b, "questions"), objectsStartingWith(a, "questions"));
  assert.match(b, /reading_bank_quiz_through\(p_book\)/);
  const gates = b.match(/pds\.reading_bank_question_open\(q\.question_id, \(SELECT through FROM t\)\)/g) ?? [];
  assert.equal(gates.length, 2, "questions and the attempts on them");
  // The gate: unlocked, current edition, the idea unlocked, and every idea an (older) recall rubric names unlocked.
  const open = fn(fnsMain, "pds.reading_bank_question_open").body;
  assert.match(open, /WHEN q\.format IS NULL THEN true/);
  assert.match(open, /q\.unlock_chapter <= p_through/);
  assert.match(open, /q\.chapter_hash IS NOT DISTINCT FROM pds\.reading_bank_chapter_hash\(q\.book_id, q\.bank_chapter\)/);
  assert.match(open, /i\.idea_id = q\.idea_id AND i\.unlock_chapter > p_through/);
  assert.match(open, /q\.format = 'chapter_recall' THEN q\.rubric::jsonb->'ideas'[\s\S]*i\.unlock_chapter > p_through/);
});

test("the chapter recall rubric lists only ideas that unlock with the chapter, and nothing locked is served or answered", () => {
  const recall = fn(fnsMain, "pds.reading_bank_recall_rubric").body;
  assert.match(recall, /i\.unlock_chapter = p_ch/, "an unsure / whole-book / moved idea (unlock at the end) is never listed");
  assert.match(recall, /i\.chapter_hash = v_hash/);
  assert.match(recall, /reading_bank_idea_supported\(i\.idea_id\)/);
  assert.match(fn(fnsMain, "pds.reading_bank_recall_refresh").body, /v_rj := pds\.reading_bank_recall_rubric\(p_book, p_ch\)/);
  assert.doesNotMatch(fn(fnsMain, "pds.reading_bank_store").body, /'format', 'chapter_recall', 'ideas'/, "one rubric builder");
  const deck = fn(fnsMain, "pds.reading_bank_deck").body;
  assert.match(deck, /jsonb_array_elements\(q\.rubric::jsonb->'ideas'\)[\s\S]*i\.unlock_chapter > \(SELECT through FROM t\)/, "deck backstop");
  assert.match(deck, /pds\.reading_bank_recall_valid\(q\.rubric, p_book, c\.chapter\)/, "deck: every listed idea still valid");
  const attempt = fn(fnsMain, "pds.reading_bank_attempt").body;
  assert.match(attempt, /i\.idea_id = ANY\(v_covers\)[\s\S]*i\.unlock_chapter > pds\.reading_bank_quiz_through/, "attempt backstop");
  assert.match(attempt, /NOT pds\.reading_bank_recall_valid\(v_q\.rubric, v_q\.book_id, v_q\.bank_chapter\)[\s\S]{0,120}'question_changed'/, "attempt: never scores an idea without evidence");
  const valid = fn(fnsMain, "pds.reading_bank_recall_valid").body;
  for (const cond of ["i.status <> 'active'", "i.unlock_chapter <> p_ch", "i.chapter_hash <> pds.reading_bank_chapter_hash(p_book, p_ch)", "NOT pds.reading_bank_idea_supported(i.idea_id)"]) {
    assert.ok(valid.includes(cond), cond);
  }
  const flag = fn(fnsMain, "pds.reading_bank_flag").body;
  assert.ok((flag.match(/reading_bank_recall_refresh\(/g) ?? []).length >= 4, "wrong, not_in_chapter and their Restores re-version the recall");
});

test("served ideas need valid evidence; flags move state_version; chapter recall hits of a wrong idea are void", () => {
  for (const name of ["pds.reading_bank_deck", "pds.reading_bank_summary", "pds.reading_bank_overview", "pds.reading_bank_chapter", "pds.reading_bank_attempt"]) {
    assert.match(fn(fnsMain, name).body, /reading_bank_idea_supported/, `${name} evidence`);
  }
  assert.match(fn(fnsMain, "pds.reading_bank_idea_supported").body, /pds\.reading_sha256\(h\.passage\) = src\.passage_sha/);
  const flag = fn(fnsMain, "pds.reading_bank_flag").body;
  assert.doesNotMatch(flag, /SET dirty = true/, "dirty marks go through reading_bank_touch_states (which also moves state_version)");
  assert.ok((flag.match(/pds\.reading_bank_touch_states\(v_ideas, true\)/g) ?? []).length >= 2);
  const touch = fn(fnsMain, "pds.reading_bank_touch_states").body;
  assert.match(touch, /INSERT INTO pds\.reading_idea_state[\s\S]*1, COALESCE\(p_dirty, false\)[\s\S]*ON CONFLICT \(idea_id\) DO UPDATE SET state_version = s\.state_version \+ 1/,
    "an idea with no state row gets one at version 1, so a replay with basis 0 from before cannot pass");
  assert.match(fn(fnsMain, "pds.reading_bank_events").body, /f\.kind = 'wrong' AND f\.idea_id = c\.idea_id AND f\.created_at > a\.answered_at/);
  const grade = fn(fnsMain, "pds.reading_bank_grade").body;
  assert.match(grade, /v_a\.covers/, "a chapter recall grade carries every covered idea's state");
  assert.match(fn(fnsMain, "pds.reading_bank_attempt").body, /unnest\(v_need\)/);
});

test("the store is replay safe per job, bound to the planned edition, and keeps a working bank over an empty rebuild", () => {
  const store = fn(fnsMain, "pds.reading_bank_store").body;
  assert.match(store, /v_job IS NULL/, "job_id is required");
  assert.match(store, /v_jobrow\.store_receipt IS NOT NULL[\s\S]*'replayed', true/);
  assert.match(store, /UPDATE pds\.reading_bank_jobs SET store_receipt = v_receipt/);
  assert.match(store, /v_chash <> v_hash[\s\S]*'chapter_changed'/);
  assert.match(store, /'highlight_changed'/);
  assert.match(store, /v_keep := v_replace AND jsonb_array_length/);
  assert.match(store, /IF v_replace AND NOT v_keep THEN/);
  // Every refusal before the first write returns; nothing is retired before the edition and replay checks.
  assert.ok(store.indexOf("'chapter_changed'") < store.indexOf("SET status = 'retired'"));
  assert.match(store, /INSERT INTO pds\.reading_bank_highlight_seen/);
});

test("the store is fenced like finish: live lease, the claim's attempt, and the chapter's rebuild generation", () => {
  const store = fn(fnsMain, "pds.reading_bank_store").body;
  assert.match(store, /v_att := NULLIF\(p->>'attempts', ''\)::int;/);
  assert.match(store, /OR v_att IS NULL OR/, "attempts is required");
  assert.match(store, /OR \(v_replace AND v_rebuild IS NULL\)/, "a replacing store names the generation it was planned for");
  assert.match(store, /v_jobrow\.status <> 'running' OR v_jobrow\.lease_until IS NULL OR v_jobrow\.lease_until < NOW\(\)[\s\S]{0,120}'not_running'/);
  assert.match(store, /IF v_att <> v_jobrow\.attempts OR v_seq <> v_jobrow\.claim_seq THEN[\s\S]{0,120}'lease_lost'/);
  assert.match(store, /v_seq := NULLIF\(p->>'claim_seq', ''\)::bigint;/);
  assert.match(store, /OR v_att IS NULL OR v_seq IS NULL OR/, "claim_seq is required too");
  assert.match(store, /v_rebuild < COALESCE\(\s*\(SELECT c\.rebuilds FROM pds\.reading_bank_chapters c[\s\S]{0,160}'stale_generation'/);
  // A receipt replay needs no lease; every fence answers before the first write (nothing is retired by a stale run).
  const at = (needle) => store.indexOf(needle);
  assert.ok(at("store_receipt IS NOT NULL") < at("'not_running'"));
  for (const code of ["'not_running'", "'lease_lost'", "'stale_generation'"]) {
    assert.ok(at(code) > 0 && at(code) < at("SET status = 'retired'"), code);
    assert.ok(at(code) < at("INSERT INTO pds.reading_bank_sources"), code);
  }
});

test("a month's spend is read from charged_at, which only a charge sets, so a re-queued job keeps its earlier cost", () => {
  assert.match(main, /charged_at\s+TIMESTAMPTZ,/);
  for (const name of ["pds.reading_bank_claim", "pds.reading_bank_reserve", "pds.reading_bank_status"]) {
    const body = fn(fnsMain, name).body;
    assert.match(body, /sum\(cost_cents\)[^;]*charged_at >= \(date_trunc\('month'/, `${name} sums by charge time`);
    assert.doesNotMatch(body, /finished_at >= \(date_trunc\('month'/, `${name} never by the queue's own time`);
  }
  assert.match(fn(fnsMain, "pds.reading_bank_claim").body, /charged_at = CASE WHEN reserved_cents > 0 THEN NOW\(\) ELSE charged_at END/);
  assert.match(fn(fnsMain, "pds.reading_bank_finish").body, /charged_at = CASE WHEN v_cost > 0 THEN NOW\(\) ELSE charged_at END/);
  // The re-queue clears the queue's times but touches neither the cost nor its date.
  const enq = fn(fnsMain, "pds.reading_bank_enqueue").body;
  const set = /SET status = 'queued'[^;]*/.exec(enq)?.[0] ?? "";
  assert.ok(set && !/cost_cents|charged_at/.test(set));
});

test("a flag voids the ideas fed by every answer it invalidated, across question versions; a moved idea's flag stays listed", () => {
  const flag = fn(fnsMain, "pds.reading_bank_flag").body;
  assert.match(flag, /SELECT a\.idea_id FROM pds\.reading_question_attempts a WHERE a\.attempt_key = ANY\(v_hit\)/);
  assert.match(flag, /SELECT unnest\(a\.covers\) FROM pds\.reading_question_attempts a WHERE a\.attempt_key = ANY\(v_hit\)/);
  assert.ok(flag.indexOf("reading_bank_touch_states(v_ideas, true)", flag.indexOf("unnest(a.covers)")) > 0, "collected before the states are marked");
  const chapter = fn(fnsMain, "pds.reading_bank_chapter").body;
  assert.match(chapter, /f\.kind = 'not_in_chapter' AND COALESCE\(f\.prev_unlock, q\.bank_chapter\) <= \(SELECT through FROM t\)/);
  assert.match(chapter, /q\.unlock_chapter <= \(SELECT through FROM t\)/, "other flags stay on the unlock gate");
});

test("the planner keys highlight freshness on content, never on updated_at", () => {
  const plan = fn(fnsMain, "pds.reading_bank_plan_input").body;
  assert.doesNotMatch(plan, /updated_at|changed_at/);
  assert.match(plan, /reading_bank_highlight_seen/);
  assert.match(plan, /src\.passage_sha = x\.sha/);
});

test("the queue charges an expired lease's reservation and fences finish by attempt", () => {
  const claim = fn(fnsMain, "pds.reading_bank_claim").body;
  assert.match(claim, /cost_cents = cost_cents \+ reserved_cents/);
  assert.match(claim, /spent_cents = spent_cents \+ v_exp\.reserved_cents/);
  assert.match(claim, /'headroom_cents'/);
  assert.doesNotMatch(claim, /j\.status = 'running' AND j\.lease_until < NOW\(\)\)/, "expired leases are settled first, never re-claimed as running");
  const finish = fn(fnsMain, "pds.reading_bank_finish").body;
  assert.match(finish, /OR v_att IS NULL OR v_seq IS NULL THEN/);
  assert.match(finish, /IF v_att <> v_job\.attempts OR v_seq <> v_job\.claim_seq THEN/);
});

test("T07's own paths are fenced off bank rows (answers, grades, new versions)", () => {
  assert.match(main, /CREATE OR REPLACE TRIGGER trg_reading_bank_attempt_guard BEFORE INSERT OR UPDATE ON pds\.reading_question_attempts/);
  assert.match(main, /CREATE OR REPLACE TRIGGER trg_reading_bank_question_guard BEFORE INSERT ON pds\.reading_questions/);
  const guard = fn(fnsMain, "pds.reading_bank_attempt_guard").body;
  assert.match(guard, /NEW\.ext_hash IS NULL[\s\S]*q\.format IS NOT NULL/);
  assert.match(guard, /NEW\.verdict IS NULL/);
  assert.match(fn(fnsMain, "pds.reading_bank_question_guard").body, /current_setting\('pds\.reading_bank_write', true\)/);
  assert.match(fn(fnsMain, "pds.reading_bank_recall_refresh").body, /set_config\('pds\.reading_bank_write', 'on', true\)/);
});

test("the last chapter unlocks from a session Riley logged himself, not a Kindle-made one", () => {
  const gate = fn(fnsMain, "pds.reading_bank_quiz_through").body;
  const last = gate.slice(gate.indexOf("last_ch AS"), gate.indexOf("raw AS"));
  assert.match(last, /s\.source <> 'kindle'/);
});

test("schema_ok reports both checks, the idea branch and the export gate (the worker's preflight)", () => {
  const body = fn(fnsMain, "pds.reading_bank_schema_ok").body;
  for (const k of ["source_kind_idea", "grader_local", "idea_source_branch", "export_gate", "all_ok"]) assert.match(body, new RegExp(`'${k}'`));
  // Every check on the value list must allow the bank's value (a narrower one left under another name still refuses).
  assert.match(body, /NOT EXISTS \(SELECT 1 FROM c WHERE conrelid = 'pds\.reading_questions'::regclass AND def ~ '\\msource_kind = ANY'\s+AND def NOT LIKE '%''idea''%'\)/);
  assert.match(body, /NOT EXISTS \(SELECT 1 FROM c WHERE conrelid = 'pds\.reading_question_attempts'::regclass AND def ~ '\\mgrader = ANY'\s+AND def NOT LIKE '%''local''%'\)/);
  assert.match(body, /position\('reading_bank_question_open' IN pg_get_functiondef\('pds\.reading_questions_export\(bigint\)'::regprocedure\)\)/);
});

test("a chapter recall graded with no hit for an idea gives it the answer's verdict, never a blanket 'incorrect'", () => {
  const ev = fn(fnsMain, "pds.reading_bank_events").body;
  assert.match(ev, /WHEN h\.hit = 'no' THEN 'incorrect'\s+ELSE a\.verdict END/);
  assert.doesNotMatch(ev, /WHEN h\.hit = 'partial' THEN 'partial' ELSE 'incorrect'/);
});

test("pending answers move the state_version of what they cover; grade jobs of answers no longer pending are never claimed", () => {
  const attempt = fn(fnsMain, "pds.reading_bank_attempt").body;
  assert.match(attempt, /ELSE\s+PERFORM pds\.reading_bank_touch_states\(v_need, false\);\s+INSERT INTO pds\.reading_bank_jobs/);
  assert.match(attempt, /CASE WHEN v_inline THEN NOW\(\) \+ interval '10 minutes' ELSE NOW\(\) END/, "an inline (chat) grade's job is only a safety net");
  const claim = fn(fnsMain, "pds.reading_bank_claim").body;
  const skip = claim.indexOf("SET status = 'skipped'");
  assert.ok(skip > 0 && skip < claim.indexOf("SELECT j.* INTO v_job"), "skipped before the pick");
  assert.match(claim, /j\.step = 'grade' AND j\.status = 'queued'\s+AND NOT EXISTS \(SELECT 1 FROM pds\.reading_question_attempts a WHERE a\.attempt_key = j\.attempt_key AND a\.grading_status = 'pending'\)/);
});

test("reserve raises a running job's reservation only within both caps, under the claim lock", () => {
  const r = fn(fnsMain, "pds.reading_bank_reserve").body;
  const lock = r.indexOf("pg_advisory_xact_lock(hashtext('pds.reading_bank_claim'))");
  assert.ok(lock > 0 && lock < r.indexOf("UPDATE pds.reading_bank_jobs SET reserved_cents"));
  assert.match(r, /v_job\.status <> 'running' OR v_job\.lease_until IS NULL OR v_job\.lease_until < NOW\(\)/);
  assert.match(r, /IF v_att <> v_job\.attempts OR v_seq <> v_job\.claim_seq THEN[\s\S]{0,80}'lease_lost'/);
  assert.match(r, /v_month \+ v_delta > v_capm[\s\S]{0,120}'monthly_cap'/);
  assert.match(r, /v_used \+ v_delta > v_bk\.approved_cents[\s\S]{0,260}'budget'/);
  assert.match(r, /sum\(reserved_cents\) FILTER \(WHERE status = 'running'\)/, "every other running job's reservation counts");
});

test("reserve counts a running job's reservation until its lease is settled, an expired one included", () => {
  const r = fn(fnsMain, "pds.reading_bank_reserve").body;
  // An expired lease is billed work that no claim has charged yet: it must not free its headroom to another job.
  assert.doesNotMatch(r, /lease_until >= NOW\(\)/, "no sum drops a running job because its lease ran out");
  assert.match(r, /sum\(r\.reserved_cents\) FROM pds\.reading_bank_jobs r\s+WHERE r\.book_id = v_bk\.book_id AND r\.status = 'running'\)/);
  const claim = fn(fnsMain, "pds.reading_bank_claim").body;
  assert.match(claim, /sum\(reserved_cents\) FILTER \(WHERE status = 'running'\)/);
  assert.doesNotMatch(claim, /status = 'running' AND lease_until >= NOW\(\)/);
  assert.match(claim, /sum\(r\.reserved_cents\) FROM pds\.reading_bank_jobs r\s+WHERE r\.book_id = b\.book_id AND r\.status = 'running'\)/);
});

test("reserve refuses a book that is off or paused before it looks at the money, even a request that needs no more", () => {
  const r = fn(fnsMain, "pds.reading_bank_reserve").body;
  assert.match(r, /IF v_job\.step <> 'grade' THEN\s+SELECT \* INTO v_bk FROM pds\.reading_bank_books WHERE book_id = v_job\.book_id FOR UPDATE;/, "grading is not tied to a book's approval");
  const gate = r.indexOf("v_bk.approved_at IS NULL OR v_bk.paused_at IS NOT NULL");
  assert.ok(gate > 0, "the book must be approved and not paused");
  assert.ok(gate < r.indexOf("IF v_total <= v_job.reserved_cents THEN"), "checked before the early success for a total already reserved");
  assert.ok(gate < r.indexOf("UPDATE pds.reading_bank_jobs SET reserved_cents"), "and before anything is reserved");
  assert.match(r, /CASE WHEN v_bk\.paused_reason = 'budget' THEN 'budget' ELSE 'paused' END/);
  // The lock order stays claim lock, then job row, then book row (as the claim takes them).
  assert.ok(r.indexOf("pg_advisory_xact_lock(hashtext('pds.reading_bank_claim'))") < r.indexOf("FROM pds.reading_bank_jobs WHERE job_id") && r.indexOf("FROM pds.reading_bank_jobs WHERE job_id") < r.indexOf("INTO v_bk"));
});

test("the queue fence is two numbers: attempts (a re-queue resets it) and claim_seq (never), both required by reserve, finish, store and the map write", () => {
  assert.match(main, /claim_seq\s+BIGINT\s+NOT NULL DEFAULT 0,/);
  assert.match(main, /ALTER TABLE pds\.reading_bank_jobs ADD COLUMN IF NOT EXISTS claim_seq BIGINT NOT NULL DEFAULT 0;/);
  assert.match(fn(fnsMain, "pds.reading_bank_claim").body, /attempts = attempts \+ 1, claim_seq = claim_seq \+ 1,/);
  const enq = fn(fnsMain, "pds.reading_bank_enqueue").body;
  const set = /SET status = 'queued'[^;]*/.exec(enq)?.[0] ?? "";
  assert.match(set, /attempts = 0/, "a re-queue gives the tries back");
  assert.doesNotMatch(set, /claim_seq/, "and never touches the claim counter, so a worker from before can never match a later claim");
  assert.deepEqual(fnsMain.filter((f) => /claim_seq\s*=\s*/.test(f.body)).map((f) => f.name), ["pds.reading_bank_claim"], "only the claim moves it, and only up");
  for (const name of ["pds.reading_bank_reserve", "pds.reading_bank_finish", "pds.reading_bank_store", "pds.reading_bank_set_map"]) {
    const body = fn(fnsMain, name).body;
    assert.match(body, /v_seq := NULLIF\(p->>'claim_seq', ''\)::bigint;/, `${name} reads claim_seq`);
    assert.match(body, /v_seq IS NULL/, `${name} requires it`);
    assert.match(body, /v_seq <> v_job(row)?\.claim_seq/, `${name} compares it`);
  }
});

test("the source map is written only by the run holding the map job's live lease, and only for the book's current table of contents", () => {
  const m = fn(fnsMain, "pds.reading_bank_set_map").body;
  for (const v of ["v_book", "v_jid", "v_att", "v_seq"]) assert.match(m, new RegExp(`${v} IS NULL`), `${v} is required`);
  assert.match(m, /v_toc !~ '\^\[0-9a-f\]\{64\}\$'/);
  const at = (needle) => m.indexOf(needle);
  assert.ok(at("pg_advisory_xact_lock(hashtext('pds.reading_bank_claim'))") > 0 && at("pg_advisory_xact_lock") < at("FROM pds.reading_bank_jobs WHERE job_id = v_jid FOR UPDATE"));
  assert.match(m, /v_job\.book_id <> v_book OR v_job\.step <> 'map' THEN\s+RETURN jsonb_build_object\('ok', false, 'http', 409, 'code', 'job_mismatch'\)/);
  assert.match(m, /v_job\.status <> 'running' OR v_job\.lease_until IS NULL OR v_job\.lease_until < NOW\(\) THEN\s+RETURN jsonb_build_object\('ok', false, 'http', 409, 'code', 'not_running'\)/);
  assert.match(m, /IF v_att <> v_job\.attempts OR v_seq <> v_job\.claim_seq THEN\s+RETURN jsonb_build_object\('ok', false, 'http', 409, 'code', 'lease_lost'\)/);
  assert.match(m, /v_toc IS NOT NULL AND v_toc <> pds\.reading_bank_toc_hash\(v_book\) THEN\s+RETURN jsonb_build_object\('ok', true, 'stored', false, 'code', 'toc_changed'\)/, "a stale table of contents stores nothing and costs no retry");
  for (const code of ["'job_mismatch'", "'not_running'", "'lease_lost'", "'toc_changed'"]) assert.ok(at(code) > 0 && at(code) < at("UPDATE pds.reading_bank_books"), `${code} answers before the write`);
  assert.match(m, /WHERE book_id = v_book;/, "the book the job belongs to, never another");
});

test("a refusal to spend is not a failed try: a cost-free retry with a cost-refusal code gives the try back", () => {
  const f = fn(fnsMain, "pds.reading_bank_finish").body;
  assert.match(f, /v_defer := v_out = 'retry' AND v_cost = 0 AND COALESCE\(p->>'error_code', ''\) IN \('cost_limit', 'monthly_cap', 'budget', 'paused'\);/);
  assert.match(f, /CASE WHEN attempts >= 3 AND NOT v_defer THEN 'failed' ELSE 'queued' END/, "never failed by refusals");
  assert.match(f, /attempts = CASE WHEN v_defer THEN GREATEST\(attempts - 1, 0\) ELSE attempts END/);
  assert.match(f, /v_job\.step = 'grade' AND v_out <> 'done' AND NOT v_defer THEN/, "and not a grade try either");
  // A retry that billed something still uses its try (a request that always stops half way cannot repeat for ever).
  assert.match(f, /v_cost = 0/);
});

test("claim: the first request's bound, when sent, is the cap test (with the pause); the estimate is still what is reserved", () => {
  const c = fn(fnsMain, "pds.reading_bank_claim").body;
  assert.match(c, /v_need := GREATEST\(v_est, LEAST\(GREATEST\(COALESCE\(NULLIF\(p->'bounds'->>v_job\.step, ''\)::numeric, 0\), 0\), 100000\)\);/);
  assert.match(c, /IF v_month \+ v_need > v_capm THEN\s+RETURN jsonb_build_object\('ok', true, 'job', NULL, 'code', 'monthly_cap'\)/);
  assert.match(c, /v_used \+ v_need > v_cap THEN[\s\S]{0,260}paused_reason = 'budget'/);
  assert.match(c, /reserved_cents = v_est\b/);
});

test("a failed job has a way back: web_search_disabled retried after 6 h, the map through the book-level Rebuild", () => {
  const enq = fn(fnsMain, "pds.reading_bank_enqueue").body;
  assert.match(enq, /WHERE jb\.status = 'skipped'\s+OR \(jb\.status = 'failed' AND jb\.error_code = 'web_search_disabled' AND jb\.finished_at < NOW\(\) - interval '6 hours'\)/);
  assert.match(enq, /PERFORM pds\.reading_bank_recall_sync\(v_book\)/);
  const rb = fn(fnsMain, "pds.reading_bank_rebuild").body;
  assert.match(rb, /IF v_ch = 0 THEN[\s\S]*map_rebuilds = b\.map_rebuilds \+ 1/);
  assert.match(fn(fnsMain, "pds.reading_bank_plan_input").body, /'map_rebuilds', COALESCE\(\(SELECT map_rebuilds FROM bb\), 0\)/);
  assert.match(main, /map_rebuilds\s+INTEGER\s+NOT NULL DEFAULT 0/);
});

test("the recall rubric follows its ideas: every store refreshes it, the sync re-versions a stale one without voiding answers", () => {
  const store = fn(fnsMain, "pds.reading_bank_store").body;
  assert.match(store, /IF v_ch >= 1 AND NOT v_keep THEN\s+v_qs := v_qs \+ pds\.reading_bank_recall_refresh/);
  assert.match(store, /CASE WHEN v_replace THEN NULL ELSE false END, v_replace\)/, "the highlights step keeps the answers already given");
  const sync = fn(fnsMain, "pds.reading_bank_recall_sync").body;
  assert.match(sync, /q\.rubric IS DISTINCT FROM pds\.reading_bank_recall_rubric\(p_book, q\.bank_chapter\)::text/);
  assert.match(sync, /reading_bank_recall_refresh\(p_book, v_ch, NULL, NULL, 'chapter ideas changed', false, false\)/);
});

test("the end of the book is never 'now': the store and the flag unlock unsure, moved and whole-book ideas there", () => {
  assert.match(fn(fnsMain, "pds.reading_bank_end_chapter").body, /ELSE 2147483647 END/);
  const store = fn(fnsMain, "pds.reading_bank_store").body;
  assert.match(store, /v_unlock := CASE WHEN v_ch = 0 OR v_unlock > v_ch THEN GREATEST\(v_ch, v_end\) ELSE v_ch END;/);
  assert.match(store, /v_end := pds\.reading_bank_end_chapter\(v_book\)/);
  assert.match(fn(fnsMain, "pds.reading_bank_flag").body, /v_total := pds\.reading_bank_end_chapter\(v_q\.book_id\)/);
});

test("a flag on an older question version acts on the current one; a chapter never gets two live recall questions back", () => {
  const flag = fn(fnsMain, "pds.reading_bank_flag").body;
  assert.match(flag, /IF v_q\.superseded_at IS NOT NULL THEN[\s\S]{0,200}question_key = v_q\.question_key AND superseded_at IS NULL[\s\S]{0,200}'question_changed'/);
  assert.match(flag, /CASE WHEN question_id = v_q\.question_id THEN v_kind ELSE 'idea_retired' END/);
  assert.match(flag, /VALUES \(v_key, v_q\.question_id, v_q\.idea_id/, "the flag row records the version acted on");
  assert.match(flag, /o\.question_key <> v_q\.question_key AND o\.superseded_at IS NULL AND o\.retired_at IS NULL\) THEN\s+RETURN jsonb_build_object\('ok', false, 'http', 409, 'code', 'superseded'\)/);
});
