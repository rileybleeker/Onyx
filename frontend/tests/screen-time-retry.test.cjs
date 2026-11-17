// Run: node --test tests/screen-time-retry.test.cjs
// The Screen Time "Try again" button, checked against the component source as text: RetryButton.tsx,
// ScreenTimeView.tsx (error alert only), the scroll section's attempt counter in FeedSection.tsx, and
// page.tsx passing refreshOnRetry. No network, no env vars, no browser. SYNTHETIC values only.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { SRC } = require("./helpers/load-ts.cjs");

const DIR = path.join(SRC, "app", "screen-time");
const read = (name) => {
  const file = path.join(DIR, name);
  return { file: `src/app/screen-time/${name}`, src: fs.readFileSync(file, "utf8") };
};

const retry = read("RetryButton.tsx");
const view = read("ScreenTimeView.tsx");
const feed = read("FeedSection.tsx");
const page = read("page.tsx");

test("RetryButton is a client component that renders a real button with type=\"button\"", () => {
  const { file, src } = retry;
  assert.ok(/^\s*"use client";/.test(src), `${file}: must start with "use client"`);
  assert.match(src, /export default function RetryButton\b/, `${file}: must default-export RetryButton`);
  assert.match(src, /<button\b/, `${file}: must render a <button> element`);
  assert.match(src, /<button\s[^>]*\btype="button"/, `${file}: the <button> must have type="button"`);
  assert.match(src, />\s*Try again\s*</, `${file}: the button must read "Try again"`);
});

test("RetryButton is disabled while its refresh is in flight", () => {
  const { file, src } = retry;
  assert.match(src, /useTransition\(\)/, `${file}: must track the refresh with useTransition`);
  assert.match(src, /start\(\(\) => router\.refresh\(\)\)/, `${file}: the routed path must run router.refresh() inside the transition`);
  assert.match(src, /disabled=\{pending\}/, `${file}: the <button> must be disabled={pending}`);
});

test("ScreenTimeView renders RetryButton exactly once, inside the error alert branch", () => {
  const { file, src } = view;
  const uses = src.match(/<RetryButton\b/g) ?? [];
  assert.equal(uses.length, 1, `${file}: expected exactly one <RetryButton> element, found ${uses.length}`);

  const errorStart = src.indexOf('data?.kind === "error"');
  const emptyStart = src.indexOf('data?.kind === "empty"');
  const okStart = src.indexOf('data?.kind === "ok"');
  const loadingStart = src.indexOf("Loading Screen Time");
  assert.ok(loadingStart > -1, `${file}: loading branch marker not found`);
  assert.ok(errorStart > -1 && emptyStart > errorStart && okStart > emptyStart, `${file}: error, empty and ok branches must appear in that order`);

  const buttonAt = src.indexOf("<RetryButton");
  assert.ok(buttonAt > errorStart && buttonAt < emptyStart, `${file}: <RetryButton> must sit inside the data?.kind === "error" branch, not loading, empty or ok`);

  const alertAt = src.indexOf('role="alert"');
  assert.ok(alertAt > errorStart && alertAt < buttonAt, `${file}: <RetryButton> must be inside the role="alert" section`);

  const condition = src.slice(errorStart, buttonAt);
  assert.match(condition, /\(onRetry \|\| refreshOnRetry\)/, `${file}: the button must only render when onRetry or refreshOnRetry is set`);
  assert.match(src.slice(buttonAt, buttonAt + 80), /<RetryButton onRetry=\{onRetry\}/, `${file}: RetryButton must receive onRetry`);
});

test("ScreenTimeView takes onRetry and refreshOnRetry props", () => {
  const { file, src } = view;
  assert.match(src, /\bonRetry\?: \(\) => void;/, `${file}: onRetry must be an optional () => void prop`);
  assert.match(src, /\brefreshOnRetry\?: boolean;/, `${file}: refreshOnRetry must be an optional boolean prop`);
  assert.match(src, /\bonRetry,\s*\n\s*refreshOnRetry = false,/, `${file}: onRetry and refreshOnRetry must be destructured in the component signature`);
});

test("FeedSection keeps an attempt counter that starts at 0 and is the remount key of the reader", () => {
  const { file, src } = feed;
  assert.match(src, /const \[attempt, setAttempt\] = useState\(0\);/, `${file}: must hold an attempt counter starting at 0`);
  assert.match(src, /<ScreenTimeReader\s+key=\{attempt\}/, `${file}: the scroll section's ScreenTimeReader must use key={attempt}`);
});

test("FeedSection increments the attempt counter on retry and passes it down as onRetry", () => {
  const { file, src } = feed;
  assert.match(src, /onRetry=\{\(\) => setAttempt\(\(n\) => n \+ 1\)\}/, `${file}: onRetry must increment the counter with setAttempt((n) => n + 1)`);
  assert.match(src, /onRetry: \(\) => void;/, `${file}: ScreenTimeReader must type onRetry as () => void`);
  assert.match(src, /onRetry=\{onRetry\}\s*\/>/, `${file}: ScreenTimeReader must hand onRetry to ScreenTimeView`);
});

test("the routed screen-time page passes refreshOnRetry to ScreenTimeView", () => {
  const { file, src } = page;
  const m = src.match(/<ScreenTimeView\b[^>]*\/>/);
  assert.ok(m, `${file}: <ScreenTimeView ... /> element not found`);
  assert.match(m[0], /\brefreshOnRetry\b(?!=)/, `${file}: <ScreenTimeView> must receive the refreshOnRetry prop`);
  assert.ok(!/\bonRetry\b/.test(m[0]), `${file}: the routed page must not pass onRetry (only the scroll section does)`);
});
