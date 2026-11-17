// Run: node --test tests/login-errors.test.cjs
// Offline tests for the sign-in error copy: loginErrorCopy maps each library error to a plain next step, and the
// login page renders that copy instead of the library's own message. All values are invented (test@example.com).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTs } = require("./helpers/load-ts.cjs");

const { loginErrorCopy } = loadTs("lib/login-errors.ts");

const CREDENTIALS = "That email and password don't match. Check them and try again.";
const RATE = "Too many tries. Wait a few minutes, then try again.";
const CONFIRM = "Confirm your email first. Open the link we sent, then sign in.";
const NETWORK = "Couldn't reach the sign-in service. Check your connection and try again.";
const OTHER = "Couldn't sign you in right now. Try again in a moment.";

test("invalid credentials, by message or code", () => {
  assert.equal(loginErrorCopy({ message: "Invalid login credentials" }), CREDENTIALS);
  assert.equal(loginErrorCopy({ message: "x", code: "invalid_credentials" }), CREDENTIALS);
});

test("rate limit, by status, message or wording", () => {
  assert.equal(loginErrorCopy({ message: "anything", status: 429 }), RATE);
  assert.equal(loginErrorCopy({ message: "Rate limit exceeded" }), RATE);
  assert.equal(loginErrorCopy({ message: "Too many requests" }), RATE);
});

test("unconfirmed email", () => {
  assert.equal(loginErrorCopy({ message: "Email not confirmed" }), CONFIRM);
});

test("network and fetch failures", () => {
  assert.equal(loginErrorCopy({ message: "Network request failed" }), NETWORK);
  assert.equal(loginErrorCopy({ message: "TypeError: Failed to fetch" }), NETWORK);
});

test("anything else gets the generic line", () => {
  assert.equal(loginErrorCopy({ message: "Something new from the service" }), OTHER);
  assert.equal(loginErrorCopy({ message: "", status: 500 }), OTHER);
  assert.equal(loginErrorCopy({}), OTHER);
});

test("null and undefined input get the generic line", () => {
  assert.equal(loginErrorCopy(null), OTHER);
  assert.equal(loginErrorCopy(undefined), OTHER);
});

test("order: a credentials message wins over a rate-limit status", () => {
  assert.equal(loginErrorCopy({ message: "Invalid login credentials", status: 429 }), CREDENTIALS);
});

test("login page never renders the library message", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "app", "login", "page.tsx"), "utf8");
  assert.equal(src.includes("authError.message"), false);
  assert.equal(src.includes("loginErrorCopy(authError)"), true);
});
