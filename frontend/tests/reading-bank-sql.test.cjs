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
  const gates = b.match(/q\.format IS NULL OR q\.unlock_chapter <= \(SELECT through FROM t\)/g) ?? [];
  assert.equal(gates.length, 2, "questions and the attempts on them");
});

test("the chapter recall rubric lists only ideas that unlock with the chapter, and nothing locked is served or answered", () => {
  const recall = fn(fnsMain, "pds.reading_bank_recall_refresh").body;
  assert.match(recall, /i\.unlock_chapter = p_ch/, "an unsure / whole-book / moved idea (unlock at the end) is never listed");
  assert.match(recall, /i\.chapter_hash = v_hash/);
  assert.match(recall, /reading_bank_idea_supported\(i\.idea_id\)/);
  assert.doesNotMatch(fn(fnsMain, "pds.reading_bank_store").body, /'format', 'chapter_recall', 'ideas'/, "one rubric builder");
  const deck = fn(fnsMain, "pds.reading_bank_deck").body;
  assert.match(deck, /jsonb_array_elements\(q\.rubric::jsonb->'ideas'\)[\s\S]*i\.unlock_chapter > \(SELECT through FROM t\)/, "deck backstop");
  const attempt = fn(fnsMain, "pds.reading_bank_attempt").body;
  assert.match(attempt, /i\.idea_id = ANY\(v_covers\)[\s\S]*i\.unlock_chapter > pds\.reading_bank_quiz_through/, "attempt backstop");
  const flag = fn(fnsMain, "pds.reading_bank_flag").body;
  assert.ok((flag.match(/reading_bank_recall_refresh\(/g) ?? []).length >= 4, "wrong, not_in_chapter and their Restores re-version the recall");
});

test("served ideas need valid evidence; flags move state_version; chapter recall hits of a wrong idea are void", () => {
  for (const name of ["pds.reading_bank_deck", "pds.reading_bank_summary", "pds.reading_bank_overview", "pds.reading_bank_chapter", "pds.reading_bank_attempt"]) {
    assert.match(fn(fnsMain, name).body, /reading_bank_idea_supported/, `${name} evidence`);
  }
  assert.match(fn(fnsMain, "pds.reading_bank_idea_supported").body, /pds\.reading_sha256\(h\.passage\) = src\.passage_sha/);
  const flag = fn(fnsMain, "pds.reading_bank_flag").body;
  assert.doesNotMatch(flag, /SET dirty = true WHERE/, "every dirty mark also moves state_version");
  assert.ok((flag.match(/SET dirty = true, state_version = state_version \+ 1/g) ?? []).length >= 2);
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
  assert.match(finish, /OR v_att IS NULL THEN/);
  assert.match(finish, /IF v_att <> v_job\.attempts THEN/);
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

test("schema_ok reports both checks and the idea branch (the worker's preflight)", () => {
  const body = fn(fnsMain, "pds.reading_bank_schema_ok").body;
  for (const k of ["source_kind_idea", "grader_local", "idea_source_branch"]) assert.match(body, new RegExp(`'${k}'`));
});
