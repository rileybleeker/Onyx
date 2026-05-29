import { test as setup, expect } from "@playwright/test";
import path from "path";

// Persist the logged-in session here; playwright.config.ts points the
// `chromium` project's storageState at the same file. Gitignored.
const authFile = path.join(__dirname, ".auth/state.json");

// Runs once before the smoke suite (the `setup` project). Drives the real
// /login form so the Supabase SSR session cookies land in the browser context,
// then snapshots that context. The app's middleware gates every route on those
// cookies, so without this the smoke specs would all bounce to /login.
setup("authenticate against the app", async ({ page }) => {
  const email = process.env.SMOKE_TEST_EMAIL;
  const password = process.env.SMOKE_TEST_PASSWORD;

  if (!email || !password) {
    throw new Error(
      "Smoke-test credentials missing. Set SMOKE_TEST_EMAIL and " +
        "SMOKE_TEST_PASSWORD as GitHub repo secrets (CI) or in " +
        "frontend/.env.local (local runs)."
    );
  }

  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  // The submit button reads exactly "Sign in" in password mode (login/page.tsx).
  await page.getByRole("button", { name: "Sign in", exact: true }).click();

  // A successful password login does router.replace("/status").
  await page.waitForURL("**/status", { timeout: 30_000 });
  await expect(page).toHaveURL(/\/status/);
  // Confirm we're really authenticated (page rendered, not bounced back).
  await expect(
    page.getByRole("heading", { name: "System Status" })
  ).toBeVisible({ timeout: 15_000 });

  await page.context().storageState({ path: authFile });
});
