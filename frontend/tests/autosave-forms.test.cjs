// Run: node --test tests/autosave-forms.test.cjs (offline, reads source only). Autosave on the edit forms, 2026-11-15
// (Riley: "Onyx should autosave when I input data"). Each converted form saves through lib/autosave.ts and shows
// components/AutosaveStatus.tsx instead of its old Save button; the forms that keep a button keep it on purpose.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");

const CONVERTED = [
  // file, hook, the old button text that must be gone
  ["components/FocusUnlockSettings.tsx", /useAutosave</, />\s*\{saving \? "Saving…" : dirty \? "Save" : "Saved"\}/],
  ["components/EditIntakeModal.tsx", /useAutosave</, /\{saving \? "Saving…" : "Save"\}/],
  ["components/StackEditorModal.tsx", /useAutosave</, /"Create stack" : "Save changes"/],
  ["app/health/HealthClient.tsx", /useAutosave</, /'Save changes' : 'Add item'/],
  ["app/health/records/RecordsClient.tsx", /useAutosave<LabFields>/, /\{saving \? 'Saving…' : 'Save'\}<\/button>/],
  ["app/financials/forecast/PlanConfig.tsx", /useFinanceAutosave</, />\s*Save (move|settings)\s*</],
  ["app/financials/forecast/ForecastView.tsx", /useFinanceAutosave<CardForm>/, /disabled=\{busy\} onClick=\{save\}/],
  ["app/financials/forecast/TaxAndWhatIf.tsx", /useFinanceAutosave<ProfileForm>/, /Save tax profile/],
  ["app/financials/budgets/BudgetsView.tsx", /useFinanceAutosave<string>/, />\s*(Save|Set|Always)\s*<\/button>/],
  ["app/nyc/NycClient.tsx", /useAutosave</, /Save note/],
];

for (const [file, hook, oldButton] of CONVERTED) {
  test(`${file} autosaves and shows the status line`, () => {
    const src = read(file);
    assert.match(src, hook, "saves through the shared autosave");
    assert.match(src, /<AutosaveStatus\s/, "shows Saving… / Saved / Not saved + Retry");
    assert.doesNotMatch(src, oldButton, "the old Save button is gone");
  });
}

test("typed fields also save when they are left (blur), not only after the pause", () => {
  for (const file of ["components/EditIntakeModal.tsx", "components/StackEditorModal.tsx", "app/health/HealthClient.tsx", "app/health/records/RecordsClient.tsx", "app/nyc/NycClient.tsx"]) {
    assert.match(read(file), /onBlur=\{\(\) => void \w+\.flush\(\)\}|onBlur=\{flush\}/, file);
  }
});

test("a new stack and a new care item are created once complete, then edited in place", () => {
  const stack = read("components/StackEditorModal.tsx");
  assert.match(stack, /stackIdRef\.current === null\)[\s\S]{0,200}method: "POST"/);
  assert.match(stack, /method: "PATCH", body: \{ stack_id: stackIdRef\.current/);
  assert.match(stack, /if \(!f\.name\.trim\(\)\) return "Give the stack a name\."/);
  const care = read("app/health/HealthClient.tsx");
  assert.match(care, /exists \? \{ type: 'update', id, patch: fields \} : \{ type: 'create'/);
  assert.match(care, /Enter a label and a valid date\./);
});

test("a retried stack create returns the same stack (client_key), and the SQL is additive", () => {
  const modal = read("components/StackEditorModal.tsx");
  assert.match(modal, /body: \{ \.\.\.body, client_key: clientKey\.current \}/, "the create carries the key");
  assert.match(modal, /clientKey\.current = stack\.stack_id \? null : newClientKey\(\)/, "one key per new stack");
  const route = read("app/api/supplements/stacks/route.ts");
  assert.match(route, /\.eq\("client_key", key\)\.maybeSingle\(\)/, "looks the key up first");
  assert.match(route, /existing: true/, "answers with the stack already there");
  assert.match(route, /stackErr\.code === "23505"/, "a concurrent insert of the same key is adopted");
  assert.match(route, /missingKeyColumn/, "works before the column exists");
  const sql = fs.readFileSync(path.join(SRC, "..", "..", "sql", "supplement_stack_client_key.sql"), "utf8");
  assert.doesNotMatch(sql, /drop/i, "no DROP anywhere (the Supabase connector declines it)");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS client_key uuid/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS [\s\S]*WHERE client_key IS NOT NULL/);
});

test("a care item create retried after a lost answer keeps the newer edits", () => {
  const care = read("app/health/HealthClient.tsx");
  assert.match(care, /const stale = !!stored &&/);
  assert.match(care, /if \(stale && !\(await run\(\{ type: 'update', id, patch: fields \}, 'autosave'\)\)\)/);
});

test("an edit that could not be saved is kept, not dropped, when the form switches", () => {
  const care = read("app/health/HealthClient.tsx");
  assert.match(care, /\(hasInput\(cur\) \|\| cur\.editing\) && !\(await autosave\.flush\(\)\)/);
  assert.match(care, /is not saved yet\. Retry it/);
  const nyc = read("app/nyc/NycClient.tsx");
  assert.match(nyc, /if \(!\(await noteSave\.flush\(\)\)\) \{/);
  assert.match(nyc, /is not saved yet\. Retry it/);
  for (const file of ["components/EditIntakeModal.tsx", "components/StackEditorModal.tsx", "app/health/HealthClient.tsx", "app/health/records/RecordsClient.tsx"]) {
    assert.doesNotMatch(read(file), /failed\.current|formSaveFailed/, `${file}: flush() answers whether anything is left unsaved`);
  }
});

test("the overall budget: an empty field changes nothing, 0 clears it", () => {
  const budgets = read("app/financials/budgets/BudgetsView.tsx");
  assert.match(budgets, /if \(x\.trim\(\)\) autosave\.change\(x\);\s*else autosave\.reset\(lastSaved\.current\);/);
  assert.match(budgets, /monthlyCents: n > 0 \? Math\.round\(n \* 100\) : null/);
});

test("a tax payment never races the profile autosave (both write the whole profile)", () => {
  const tax = read("app/financials/forecast/TaxAndWhatIf.tsx");
  assert.match(tax, /await autosave\.flush\(\);\s*paying\.current = true;/);
  assert.match(tax, /paying\.current \? "Recording the payment…"/);
  assert.match(tax, /estimatesPaid: \[\.\.\.paid\.current/);
});

test("finance autosave: offline is retried, a refusal is shown, the page re-reads after a save", () => {
  const hook = read("lib/use-finance-autosave.ts");
  assert.match(hook, /err === "network error"\) throw new Error/);
  assert.match(hook, /throw new AutosaveRefused\(err\)/);
  assert.match(hook, /run\(async \(\) => null\)/);
});

test("forms that keep a button keep it on purpose", () => {
  // Photo -> product review: a half-reviewed product must not reach the catalog.
  assert.match(read("components/CustomSupplementFlow.tsx"), /Save to library/);
  // A lab report's rows are a batch (POST is insert-only per id).
  assert.match(read("app/health/records/RecordsClient.tsx"), /'Save results'/);
  // Category: "This one" vs "All from this merchant" is the choice itself.
  assert.match(read("app/financials/CategoryEditor.tsx"), /All from this merchant/);
  // Planned items and goals have no update route; stream edits are three different actions on one date.
  assert.match(read("app/financials/forecast/PlanConfig.tsx"), /Stop from then/);
});

// ---- /log Weight, /log Supplements + Uber Eats Say it suggestions (2026-11-15) ----

const { execFileSync } = require("node:child_process");
const { mkdtempSync } = require("node:fs");
const { tmpdir } = require("node:os");

test("weight entry: the Log weight form saves through the shared hook, no Save button", () => {
  for (const f of ["app/log/sections/Weight.tsx"]) {
    const src = read(f);
    assert.match(src, /useWeightAutosave\(/, f);
    assert.match(src, /<AutosaveStatus/, f);
    assert.doesNotMatch(src, /Save weight|LogSaveButton onClick=\{\(\) => void save\(\)\}/, f);
  }
  const hook = read("lib/weight-entry.ts");
  // Moving the day after a save restores the earlier day first; Undo restores the day it wrote.
  assert.match(hook, /if \(prev && prev\.day !== v\.day\) \{\s*const restored = await restoreWeightDay\(prev\.day/);
  // A replaced row gets its value, note AND source back (a Tanita reading stays the scale's: never deleted, the
  // ETL only re-reads 14 days); only a day that had no row is cleared.
  assert.match(hook, /method: "PATCH",\s*body: \{ log_date: day, weight_kg: Number\(prior\.weight_kg\), notes: prior\.notes \?\? "", source: prior\.source \}/);
  assert.match(hook, /method: "DELETE"/);
  const route = read("app/api/weight/route.ts");
  assert.match(route, /body\.source !== "manual" && body\.source !== "tanita"/);
  // An older day than the rows on screen is read from the server before the first write.
  assert.match(hook, /if \(back < coversDays\) return rows\.find/);
});

test("weight rules: what can be saved and how long to wait", () => {
  const out = mkdtempSync(path.join(tmpdir(), "onyx-weight-rules-"));
  execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), path.join(SRC, "lib/weight-rules.ts"), "--outDir", out, "--module", "commonjs", "--target", "ES2022", "--skipLibCheck"]);
  const { parseLb, weightNotReady, weightDelayMs } = require(path.join(out, "weight-rules.js"));
  assert.equal(parseLb("185.4"), 185.4);
  assert.equal(typeof parseLb(""), "string");
  assert.equal(typeof parseLb("0"), "string");
  assert.equal(typeof parseLb("1001"), "string");
  assert.equal(weightNotReady({ day: "2026-11-15", lb: "185" }, "2026-11-15"), null);
  assert.match(weightNotReady({ day: "2026-11-16", lb: "185" }, "2026-11-15"), /today or an earlier day/);
  assert.match(weightNotReady({ day: "2026-11-15", lb: "abc" }, "2026-11-15"), /between 0 and 1000/);
  const kg84 = 84; // ~185 lb
  assert.equal(weightDelayMs("185.2", kg84), 1000);
  assert.equal(weightDelayMs("18", kg84), 4000, "a half-typed number waits longer");
  assert.equal(weightDelayMs("1852", kg84), 4000);
  assert.equal(weightDelayMs("18", null), 1000, "no history: the normal delay");
});

test("Say it suggestions save on their own in Supplements and Uber Eats (each tried once, then Retry)", () => {
  const sup = read("app/log/sections/Supplements.tsx");
  assert.match(sup, /triedDrafts\.add\(suggestionDraftId\);\s*void saveSuggestionsRef\.current\(\);/);
  assert.match(sup, /if \(suggestionDraftId == null \|\| triedDrafts\.has\(suggestionDraftId\) \|\| !stacks \|\| !day\) return;/);
  // Module memory, not a ref: a remount (scroll, leaving /log) never logs the same suggestion twice.
  assert.match(sup, /^const triedDrafts = new Set<number>\(\);$/m);
  assert.match(sup, /\.filter\(\(s\) => !logged\?\.has\(s\.key\)\)/);
  assert.match(sup, /label="Retry"/);
  // "Log a product" keeps its Log tap on purpose: logging a dose is the action itself.
  assert.match(sup, /onClick=\{\(\) => void onLogProduct\(\)\}/);
  const ue = read("app/log/sections/UberEats.tsx");
  assert.match(ue, /for \(const k of freshKey\.split\("\|"\)\) attempted\.current\.add\(k\);\s*void saveRef\.current\(\);/);
  assert.match(ue, /label="Retry"/);
});
