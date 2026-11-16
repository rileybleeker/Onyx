import { defineConfig, devices } from "@playwright/test";
import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Load frontend/.env.local for LOCAL runs. Playwright does not read .env files
// itself, and we deliberately avoid adding a `dotenv` dependency for one small
// loader. `if (!(key in process.env))` means an env var already set by the
// shell / CI (GitHub secrets) always wins over the file.
// ---------------------------------------------------------------------------
function loadEnvLocal() {
  const envPath = path.join(__dirname, ".env.local");
  if (!fs.existsSync(envPath)) return;
  for (const raw of fs.readFileSync(envPath, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadEnvLocal();

const baseURL =
  process.env.SMOKE_BASE_URL || "https://frontend-six-alpha-69.vercel.app";
const authFile = path.join(__dirname, "e2e/.auth/state.json");

export default defineConfig({
  testDir: "./e2e",
  // Charts fetch async after first paint; give each assertion room to settle.
  timeout: 60_000,
  // CI: the whole run stops after 8 minutes (a normal run takes about 1; the job itself takes about 2),
  // well inside the smoke job's limit. A production that hangs on every page then ends as a FAILED test
  // run, which the verdict step still reads (unverified or fail, a halt or a revert after the retry),
  // instead of the job running out of time and ending cancelled, which reads as "pending" (DEL-02).
  globalTimeout: process.env.CI ? 8 * 60_000 : 0,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 1,
  // All tests hit ONE production deployment, so the bottleneck is server-side,
  // not local CPU. Capping at 2 workers (local + CI) avoids overloading
  // cold-start functions with 6 simultaneous page loads — that contention, not
  // a real bug, caused the heaviest page (/bland-altman) to flake. retries: 1
  // absorbs the occasional genuine transient blip on top of that.
  workers: 2,
  // The repo is public, so CI keeps no trace, screenshot, video or HTML report: each one holds
  // the signed-in pages and API answers (health data, calendar titles, finances) and an
  // uploaded artifact can be downloaded by anyone. The list output names the failing check.
  // In CI each test's output folder (error-context page snapshots) is also deleted when the test
  // ends, so no later upload step could pick one up. Locally (not CI) the debugging aids stay on.
  reporter: [["list"]],
  preserveOutput: process.env.CI ? "never" : "always",
  use: {
    baseURL,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: process.env.CI ? "off" : "on-first-retry",
    screenshot: process.env.CI ? "off" : "only-on-failure",
    video: "off",
  },
  projects: [
    // 1. Authenticate once, persist the session to e2e/.auth/state.json. In CI it also records
    //    which commit + deployment production serves, and stops when it is not the expected one
    //    (smoke provenance, DEL-02: e2e/provenance.ts).
    { name: "setup", testMatch: /auth\.setup\.ts/, teardown: "provenance" },
    // 2. Smoke specs reuse that saved session (no per-test login).
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], storageState: authFile },
      dependencies: ["setup"],
      testMatch: /smoke\.spec\.ts/,
    },
    // 3. After every smoke test: record what production serves again (CI only).
    {
      name: "provenance",
      use: { ...devices["Desktop Chrome"], storageState: authFile },
      testMatch: /provenance\.teardown\.ts/,
    },
  ],
});
