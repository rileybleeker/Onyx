// READ-QUIZ-01: every place that renders the practice runner passes an answer outbox that outlives the runner.
// The runner keeps answers that were sent but not confirmed in an AttemptOutbox. Without an `outbox` prop it keeps
// its own, so closing the panel drops them. The Practice part, the chapter sheet and the checkpoint quiz each pass
// sharedAttemptOutbox (a module-level Map). This is a source-text check: it reads the render sites with fs and asserts
// each one passes the outbox prop. Offline and synthetic: no network, no data.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const REPO = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

// Each file that renders <PracticeRunner ...> through its dynamic import.
const RENDER_SITES = [
  "src/app/reading/PracticePart.tsx",
  "src/app/reading/ChapterSheet.tsx",
  "src/app/reading/CheckpointQuiz.tsx",
];

// The JSX opening tag of each <PracticeRunner ...> render (up to its closing ">" or "/>").
function runnerTags(source) {
  const tags = [];
  const re = /<PracticeRunner\b/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const start = m.index;
    let depth = 0;
    let i = start;
    for (; i < source.length; i++) {
      const ch = source[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth === 0) break;
    }
    tags.push(source.slice(start, i + 1));
  }
  return tags;
}

test("every PracticeRunner render site passes an outbox prop", () => {
  for (const rel of RENDER_SITES) {
    const source = read(rel);
    const tags = runnerTags(source);
    assert.ok(tags.length >= 1, `${rel}: renders PracticeRunner`);
    for (const tag of tags) {
      assert.match(tag, /\soutbox=\{sharedAttemptOutbox\}/, `${rel}: a PracticeRunner render passes outbox={sharedAttemptOutbox}`);
    }
  }
});

test("each render site imports sharedAttemptOutbox from the practice client", () => {
  for (const rel of RENDER_SITES) {
    const source = read(rel);
    const imported = /import\s*\{[^}]*\bsharedAttemptOutbox\b[^}]*\}\s*from\s*"@\/lib\/reading-practice-client"/.test(source);
    assert.ok(imported, `${rel}: imports sharedAttemptOutbox`);
  }
});

test("the shared outbox is a single module-level Map in the practice client", () => {
  const client = read("src/lib/reading-practice-client.ts");
  assert.match(client, /export const sharedAttemptOutbox: AttemptOutbox = new Map\(\);/);
});
