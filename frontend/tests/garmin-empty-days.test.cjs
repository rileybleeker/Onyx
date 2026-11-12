// Runs tests/test_garmin_empty_days.py inside the frontend-types job. The
// offline-checks job lists its Python tests in .github/workflows/, a path the
// merge train leaves to the owner, while tests/*.test.cjs here is discovered
// automatically. The Python test uses fakes only (no credentials, no network)
// and stubs garminconnect / supabase / dotenv when they are not installed.
// Locally on Windows, set PYTHON to a real interpreter if python3 is the Store alias.
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const script = path.join(__dirname, "..", "..", "tests", "test_garmin_empty_days.py");

test("Garmin empty-day heartbeat tests (python)", (t) => {
  for (const python of [process.env.PYTHON, "python3", "python"].filter(Boolean)) {
    const run = spawnSync(python, [script], { encoding: "utf8" });
    if (run.error && run.error.code === "ENOENT") continue;
    assert.equal(run.status, 0, `${python} ${script} failed:\n${run.stdout}\n${run.stderr}`);
    assert.match(run.stderr, /\nOK\s*$/);
    return;
  }
  if (process.env.CI) assert.fail("no Python interpreter on PATH in CI");
  t.skip("no Python interpreter on PATH");
});
