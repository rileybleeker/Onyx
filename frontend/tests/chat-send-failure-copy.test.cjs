// The chat send failure line must be fixed plain copy, never server or browser error text. The page source is read
// as text and checked: the failure line (the catch block's setError) must not render data.error or error.message, and
// the three fixed copies must exist. Synthetic data only, no secrets.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const PAGE = path.join(__dirname, "..", "src", "app", "chat", "page.tsx");
const src = fs.readFileSync(PAGE, "utf8");

// The failure line is built in the send function's catch block: from its `catch (err) {` to its `finally`.
const catchStart = src.indexOf("} catch (err) {", src.indexOf("async function send"));
const catchEnd = src.indexOf("} finally {", catchStart);
const catchBlock = src.slice(catchStart, catchEnd);

test("the send failure catch block exists and shows the failure line", () => {
  assert.ok(catchStart > 0 && catchEnd > catchStart, "found the send catch block");
  assert.match(catchBlock, /setError\(`\$\{reason\} \$\{next\}`\)/);
});

test("the failure line never renders server or browser error text", () => {
  assert.doesNotMatch(catchBlock, /data\??\.error/, "data.error is not rendered in the catch block");
  assert.doesNotMatch(catchBlock, /error\.message|err\.message/, "error.message is not rendered in the catch block");
  // The reason is chosen from fixed copies only.
  assert.match(catchBlock, /const reason = /);
});

test("the three fixed failure copies exist", () => {
  assert.ok(src.includes('const SESSION_EXPIRED_MESSAGE = "Your session may have expired. Sign in again.";'));
  assert.ok(src.includes('"Onyx could not reach the server. Check your connection and try again."'));
  assert.ok(src.includes('"Onyx could not finish this response."'));
});

test("the 'back in the composer' sentences are unchanged", () => {
  assert.ok(src.includes('"Your message is back in the composer."'));
  assert.ok(src.includes("Your message is back in the composer. Sending it again unchanged is safe"));
  assert.ok(src.includes("Your message is back in the composer. If it requested an action, check the relevant page before sending again."));
});
