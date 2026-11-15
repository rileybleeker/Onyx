// Run: node --test tests/feed-no-writes.test.cjs
// Scrolling never writes (2026-11-15): a page drawn inside the continuous scroll (components/ContinuousScroll.tsx)
// makes no request other than GET on mount or on becoming visible, and no GET with a side effect. The routed page
// keeps its own behaviour (e.g. /habits still runs its Notion sync on load). Taps Riley makes inside the scroll
// still write exactly as on the page. Static source checks, offline.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "..", "src");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");

test("every page of the scroll renders inside <InFeed>, the routed page does not", () => {
  const scroll = read("components/ContinuousScroll.tsx");
  assert.match(scroll, /<InFeed>\s*<SectionBoundary/);
  const ctx = read("components/FeedContext.tsx");
  assert.match(ctx, /export function useInFeed\(\): boolean/);
});

test("FeedSection files never write themselves", () => {
  const sections = Object.keys(
    Object.fromEntries([...read("lib/feed-registry.ts").matchAll(/"(\/[^"]*)": \(\) => import\("@\/app(\/[^"]+)\/FeedSection"\)/g)].map((m) => [m[2], 1])),
  );
  assert.ok(sections.length >= 20, "registry parsed");
  for (const dir of sections) {
    const text = read(`app${dir}/FeedSection.tsx`);
    assert.ok(!/method:\s*["'](POST|PATCH|PUT|DELETE)["']/.test(text), `${dir}/FeedSection.tsx must not write`);
    assert.ok(!/habits\/sync|experiments\/today|suggest-tags/.test(text), `${dir}/FeedSection.tsx must not call a side-effect route`);
  }
});

test("/habits: the Notion sync (POST /api/habits/sync) runs only on the routed page", () => {
  const habits = read("app/habits/HabitsClient.tsx");
  assert.match(habits, /import \{ useInFeed \} from "@\/components\/FeedContext"/);
  // Inside the scroll the "already synced" flag starts true, so the once-per-mount sync never runs there.
  assert.match(habits, /const inFeed = useInFeed\(\);\s*const hasSyncedRef = useRef\(inFeed\);/);
  const gate = habits.indexOf("if (hasSyncedRef.current) return;");
  const sync = habits.indexOf('fetch("/api/habits/sync"');
  assert.ok(gate > 0 && sync > gate, "the sync is behind the already-synced check");
});

test("/activities: tag suggestions (model call + stored answer) only on the routed page", () => {
  const acts = read("app/activities/ActivitiesClient.tsx");
  assert.match(acts, /import \{ useInFeed \} from "@\/components\/FeedContext"/);
  const gate = acts.indexOf("if (inFeed || loading || suggestStarted.current) return;");
  const call = acts.indexOf('fetch("/api/activities/suggest-tags"');
  assert.ok(gate > 0 && call > gate, "the suggestion request is behind the inFeed check");
});

test("Today in the scroll never reads the experiment arm (the read stamps it as revealed)", () => {
  const today = read("app/today/TodayClient.tsx");
  assert.match(today, /const experimentRequest = feed \? Promise\.resolve\(\) : request\(EXPERIMENT_URL/);
  assert.match(today, /\}, \[feed, markCheck\]\);/);
  assert.match(read("app/today/FeedSection.tsx"), /<TodayClient headingTestId="feed-page-heading" feed \/>/);
  // The warm-up never calls it either.
  assert.ok(!read("components/AppData.tsx").includes('"/api/experiments/today"'));
});

test("Personalize: a grid in the scroll never syncs its layout with the server or saves an edit", () => {
  const grid = read("components/personalize/PartGrid.tsx");
  const calls = grid.split("\n").filter((l) => l.includes("scheduleSync(key)"));
  assert.ok(calls.length >= 1, "PartGrid schedules the layout sync");
  for (const line of calls) assert.ok(line.includes("!inFeed"), `the sync must be off inside the scroll: ${line.trim()}`);
  assert.match(grid, /const owner = !inFeed && /, "a grid in the scroll never owns a Personalize session (no save on unmount)");
});
