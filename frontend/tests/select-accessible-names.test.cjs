// Run: node --test tests/select-accessible-names.test.cjs
// Every native <select> under src has an accessible name: aria-label, aria-labelledby,
// an id matched by a label htmlFor, or it sits inside a <label> that is still open.
// Reads the component source as text. SYNTHETIC values only.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { SRC } = require("./helpers/load-ts.cjs");

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(tsx|ts)$/.test(entry.name)) out.push(full);
  }
  return out;
}

// Returns the full opening tag starting at `start` (index of "<select"), stopping at the
// first ">" that is outside {...} expressions, so arrow functions inside props do not end it early.
function openingTag(src, start) {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return src.slice(start, i + 1);
  }
  throw new Error("unterminated <select> tag");
}

// True when the nearest <label> before `index` has not been closed yet.
function insideOpenLabel(src, index) {
  const before = src.slice(0, index);
  const lastOpen = Math.max(...[...before.matchAll(/<label[\s>]/g)].map((m) => m.index), -1);
  const lastClose = before.lastIndexOf("</label>");
  return lastOpen > lastClose;
}

const files = walk(SRC);
const selects = [];
for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  for (const m of src.matchAll(/<select\b/g)) {
    const tag = openingTag(src, m.index);
    const rel = path.relative(SRC, file).split(path.sep).join("/");
    const idMatch = tag.match(/\bid=\{([^}]*)\}|\bid="([^"]*)"/);
    const id = idMatch ? (idMatch[1] ?? idMatch[2]) : null;
    selects.push({ rel, src, index: m.index, tag, id });
  }
}

test("the scan finds the native selects under src", () => {
  assert.ok(selects.length >= 40, `expected at least 40 selects, found ${selects.length}`);
});

test("every native select under src has an accessible name", () => {
  const unnamed = [];
  for (const s of selects) {
    if (/\baria-label(ledby)?=/.test(s.tag)) continue;
    if (s.id && s.src.includes(`htmlFor={${s.id}}`)) continue;
    if (s.id && s.src.includes(`htmlFor="${s.id}"`)) continue;
    if (insideOpenLabel(s.src, s.index)) continue;
    const line = s.src.slice(0, s.index).split("\n").length;
    unnamed.push(`${s.rel}:${line}`);
  }
  assert.deepEqual(unnamed, [], "selects with no accessible name");
});

test("selects that were unlabelled now carry a visible-text aria-label", () => {
  const expected = [
    ["app/financials/FilterBar.tsx", 'aria-label="Month"'],
    ["app/financials/FilterBar.tsx", 'aria-label="Account"'],
    ["app/financials/FinancialsClient.tsx", 'aria-label="Date format"'],
    ["app/financials/FinancialsClient.tsx", 'aria-label="Signed amount convention"'],
    ["app/financials/FinancialsClient.tsx", 'aria-label="Period"'],
    ["app/financials/forecast/TaxAndWhatIf.tsx", 'aria-label="Extra card payment"'],
    ["app/financials/forecast/TaxAndWhatIf.tsx", 'aria-label="Employer withholds state tax for"'],
    ["app/health/records/RecordsClient.tsx", 'aria-label="From document"'],
    ["app/health/records/RecordsClient.tsx", 'aria-label="Kind"'],
    ["app/log/sections/Drinks.tsx", 'aria-label="Day"'],
    ["app/log/sections/WindDown.tsx", 'aria-label="The habit that means you started winding down"'],
    ["components/personalize/NavArranger.tsx", "aria-label={slot < 2"],
    ["components/personalize/PersonalizeEditor.tsx", 'aria-label="Freeze pane through"'],
  ];
  for (const [rel, text] of expected) {
    const file = path.join(SRC, rel);
    assert.ok(fs.readFileSync(file, "utf8").includes(text), `${rel} should contain ${text}`);
  }
});
