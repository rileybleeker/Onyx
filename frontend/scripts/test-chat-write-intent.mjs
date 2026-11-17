// Equivalence helpers of the chat write-authority gate (lib/chat-write-intent.ts): word reduction (flat), the
// word-bound occurrence check (verbatimIn), the order-insensitive record match (names) and the clause polarity that
// keeps a negated action from matching. Synthetic messages and values only; no network, no credentials.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import vm from "node:vm";
import test from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");

function compile(path) {
  const source = readFileSync(new URL(path, import.meta.url), "utf8");
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true } }).outputText;
  const exports = {};
  vm.runInNewContext(js, { exports, require: name => { throw new Error(`Unexpected import: ${name}`); }, console, process: { env: {} } });
  return exports;
}

const { flat, verbatimIn, names, polarity, negated } = compile("../src/lib/chat-write-intent.ts");

// --- Word reduction: case, spacing and punctuation aside ----------------------------------------------------------

test("flat reduces text to lowercase words, case, spacing and punctuation aside", () => {
  assert.equal(flat("  Synthetic   FOCUS!! "), "synthetic focus");
  assert.equal(flat("Synthetic-Focus"), "synthetic focus");
  assert.equal(flat("Don’t stop"), "don't stop", "curly apostrophe reads as a straight one");
  assert.equal(flat("Café Rest"), "cafe rest", "accents are dropped");
  assert.equal(flat("!!!"), "", "punctuation only reduces to nothing");
});

test("flat is case and punctuation insensitive and different words stay different", () => {
  assert.equal(flat("Synthetic Focus"), flat("synthetic, focus."));
  assert.notEqual(flat("Synthetic Focus"), flat("Synthetic Calm"));
  assert.notEqual(flat("tablet"), flat("tablets"));
});

// --- Occurrence check: symmetric as an equivalence, word-bound both ways, order-sensitive as a phrase -------------

test("verbatimIn: text reduced to the same words matches in both directions (symmetric)", () => {
  const pairs = [
    ["Synthetic Focus", "synthetic   focus!"],
    ["Synthetic Focus", "SYNTHETIC-FOCUS"],
    ["Don’t stop", "don't stop"],
  ];
  for (const [a, b] of pairs) {
    assert.equal(flat(a), flat(b));
    assert.equal(verbatimIn(a, b), true, `${a} in ${b}`);
    assert.equal(verbatimIn(b, a), true, `${b} in ${a}`);
  }
});

test("verbatimIn is a containment check: a phrase inside a longer message matches, the reverse does not", () => {
  assert.equal(verbatimIn("Synthetic Focus", "I took Synthetic Focus today."), true);
  assert.equal(verbatimIn("take Synthetic Focus", "Synthetic Focus"), false);
});

test("verbatimIn is word-bound both ways: a partial word never satisfies a whole word", () => {
  assert.equal(verbatimIn("tablet", "I took two tablets"), false, "tablets must not satisfy tablet");
  assert.equal(verbatimIn("tablets", "I took one tablet"), false, "tablet must not satisfy tablets");
  assert.equal(verbatimIn("focus", "focusrin"), false);
  assert.equal(verbatimIn("focusrin", "focus"), false);
  assert.equal(verbatimIn("tablet", "one tablet"), true);
});

test("verbatimIn: an empty or punctuation-only part never matches", () => {
  assert.equal(verbatimIn("", "anything"), false);
  assert.equal(verbatimIn("!!!", "anything"), false);
});

test("verbatimIn is word-order sensitive (a phrase must occur word for word); negation is not read here", () => {
  assert.equal(verbatimIn("focus synthetic", "synthetic focus"), false);
  // Negation is the job of polarity() (below), which the clause reader applies before this check.
  assert.equal(verbatimIn("5000 mg", "I did not take 5000 mg"), true);
});

// --- Record match: every identifying word, any order, stems and word bounds, digits exact ----------------------

test("names is order-insensitive: the same words in a shuffled order name the same record", () => {
  const item = "Vitamin C Synthetic";
  for (const text of ["Vitamin C Synthetic", "Synthetic, vitamin c", "c synthetic VITAMIN"]) {
    assert.equal(names(item, text), true, text);
  }
  assert.equal(names("Synthetic Focus", "focus, the synthetic one"), true);
});

test("names: a genuinely different word or number does not match", () => {
  assert.equal(names("Synthetic Focus", "Synthetic Calm"), false);
  assert.equal(names("Vitamin D3", "Vitamin D"), false, "a digit word must be present");
  assert.equal(names("B12", "B6"), false);
  assert.equal(names("Vitamin D", "Vitamin C"), false);
});

test("names: a partial word is not a whole word; a real word form still matches", () => {
  assert.equal(names("Focus", "focusrin"), false);
  assert.equal(names("Magnesium Citrate", "magnesium"), false, "one of two identifying words is not enough");
  assert.equal(names("Journal", "journals"), true, "plural is the same word");
  assert.equal(names("Meditation", "meditated"), true, "word form of the same word");
});

// --- Negation: a negated clause is never read as done ----------------------------------------------------------------

test("polarity reads an affirmative clause as done and a negated one as not done", () => {
  assert.equal(polarity("I took 5000 mg"), "pos");
  assert.equal(polarity("I did not take 5000 mg"), "neg");
  assert.equal(polarity("I didn't take it"), "neg");
  assert.equal(polarity("I skipped the 5000 mg"), "neg");
  assert.equal(polarity("I took 5000 mg because I didn't sleep"), "pos", "a reason after 'because' does not negate the action");
  assert.equal(polarity("no rush, i took 5000 mg"), "pos", "'no rush' is not a negation");
});

test("negated: a double negation or a partial exclusion is never a plain match", () => {
  assert.equal(negated("I took 5000 mg"), false);
  assert.equal(negated("I did not take 5000 mg"), true);
  assert.equal(negated("I didn't not take it"), true, "two negations are unclear, so not affirmative");
  assert.equal(negated("I took it without food"), true, "'without' leaves part of the statement out");
});
