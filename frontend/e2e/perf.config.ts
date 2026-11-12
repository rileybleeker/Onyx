import { defineConfig, devices } from "@playwright/test";
import path from "path";

// Config for the manual production timing run (.github/workflows/perf-timing.yml):
//   npx playwright test -c e2e/perf.config.ts
// Separate from playwright.config.ts on purpose, so the scheduled smoke suite
// can never pick up the timing spec (and the timing run never runs smoke specs).
// Login is the same one-time setup project the smoke suite uses.

const baseURL =
  process.env.SMOKE_BASE_URL || "https://frontend-six-alpha-69.vercel.app";

export default defineConfig({
  testDir: __dirname,
  // Per-test timeouts are set inside the spec from the navigation count.
  timeout: 15 * 60_000,
  expect: { timeout: 15_000 },
  // One page at a time, one worker: concurrent pages would measure each other.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [["list"]],
  use: {
    baseURL,
    actionTimeout: 15_000,
    navigationTimeout: 45_000,
  },
  projects: [
    { name: "setup", testMatch: /auth\.setup\.ts/ },
    {
      name: "perf",
      use: { ...devices["Desktop Chrome"] },
      dependencies: ["setup"],
      testMatch: /perf-timing\.spec\.ts/,
    },
  ],
});
