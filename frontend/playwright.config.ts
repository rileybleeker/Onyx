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
  reporter: process.env.CI
    ? [["html", { open: "never" }], ["list"]]
    : [["list"]],
  use: {
    baseURL,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    // 1. Authenticate once, persist the session to e2e/.auth/state.json.
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    // 2. Smoke specs reuse that saved session (no per-test login).
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], storageState: authFile },
      dependencies: ["setup"],
      testMatch: /smoke\.spec\.ts/,
    },
  ],
});
