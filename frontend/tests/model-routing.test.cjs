// Run: node --test tests/model-routing.test.cjs
// Model routing policy (OPS-MODEL-01, 2026-11-16): the app's single-purpose model calls use
// Sonnet 5.5 at effort low, set explicitly. Reads the route sources only; no network, no database.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { SRC } = require("./helpers/load-ts.cjs");

const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");

// Every messages.create call in the file, with the text between its "(" and the matching ")".
function createCalls(src) {
  const calls = [];
  let i = src.indexOf("messages.create(");
  while (i !== -1) {
    let depth = 0;
    let j = src.indexOf("(", i);
    const start = j;
    for (; j < src.length; j++) {
      if (src[j] === "(") depth++;
      else if (src[j] === ")" && --depth === 0) break;
    }
    calls.push(src.slice(start, j + 1));
    i = src.indexOf("messages.create(", j);
  }
  return calls;
}

// route -> how the model id is written in it
const ROUTES = {
  "app/api/delivery/items/import/route.ts": "MODEL",
  "app/api/spotify/generate-playlist/route.ts": "MODEL",
  "app/api/supplements/extract-from-photo/route.ts": "MODEL",
  "app/api/habits/checkin/voice/route.ts": "MODEL",
  "app/api/log/voice/route.ts": "MODEL",
  "app/api/activities/suggest-tags/route.ts": "MODEL",
  "lib/journal-file-server.ts": "MODEL",
};

for (const [rel, ident] of Object.entries(ROUTES)) {
  test(`${rel}: Sonnet 5.5, every call at effort low`, () => {
    const src = read(rel);
    assert.match(src, new RegExp(`const ${ident} = "claude-sonnet-5-5";`));
    assert.equal(/claude-opus|claude-fable/.test(src), false, "no Opus / Fable model id");
    const calls = createCalls(src);
    assert.ok(calls.length >= 1, "at least one model call");
    for (const c of calls) {
      assert.match(c, new RegExp(`model: ${ident}\\b`));
      assert.match(c, /effort: "low"/, "effort set explicitly to low");
    }
  });
}

test("the playlist builder sets effort on both the first call and the tool-loop call", () => {
  const calls = createCalls(read("app/api/spotify/generate-playlist/route.ts"));
  assert.equal(calls.length, 2);
  for (const c of calls) assert.match(c, /output_config: \{ effort: "low" \}/);
});

test("dish estimates record the model that made them (the Sonnet id)", () => {
  const src = read("app/api/delivery/items/import/route.ts");
  assert.match(src, /model: MODEL,\n\s+\}\);/);
});

test("a model id the estimators must not use is caught by the checks above", () => {
  // negative case for the helper: a fake source on Opus with no effort fails both rules
  const fake = 'const MODEL = "claude-opus-5-5";\nawait anthropic.messages.create({ model: MODEL, max_tokens: 10, messages });';
  assert.equal(/const MODEL = "claude-sonnet-5-5";/.test(fake), false);
  const [call] = createCalls(fake);
  assert.equal(/effort: "low"/.test(call), false);
});
