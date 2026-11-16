import { test as setup, expect } from "@playwright/test";
import path from "path";
import { provenanceDir, readServedRevision, staleTarget, writeServedRevision } from "./provenance";

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

  // Smoke provenance (DEL-02, e2e/provenance.ts): save the session and record which commit and deployment
  // production serves as soon as the session exists, BEFORE anything on the page is checked. A commit that
  // breaks Today itself must still leave both records (this one, and the teardown's, which needs the saved
  // session), so the verdict can attribute the failure to it; a record made only after the heading check
  // would be missing exactly then, and the failure could never be attributed. Runs once: right after the
  // redirect to /today, or in the `finally` below when a step before that failed (then the read is usually
  // a sign-in redirect and proves nothing). CI only (SMOKE_PROVENANCE_DIR); the perf run and local runs only
  // save the session.
  let recorded = false;
  const recordBefore = async (): Promise<string | null> => {
    if (recorded) return null;
    recorded = true;
    await page.context().storageState({ path: authFile });
    if (!provenanceDir()) return null;
    const served = await readServedRevision(page.request, "before");
    writeServedRevision(served);
    return staleTarget(served);
  };

  try {
    await page.goto("/login");
    await page.locator("#email").fill(email);
    await page.locator("#password").fill(password);
    // The submit button reads exactly "Sign in" in password mode (login/page.tsx).
    await page.getByRole("button", { name: "Sign in", exact: true }).click();

    // A successful password login lands on Today. The middleware only lets /today through with a valid
    // session, so the session cookies exist from here on.
    await page.waitForURL("**/today", { timeout: 30_000 });

    // When production does not serve the commit this run was started for, stop here: every result would
    // belong to another deployment.
    const stale = await recordBefore();
    if (stale) throw new Error(stale);

    await expect(page).toHaveURL(/\/today$/);
    // Confirm we're really authenticated (page rendered, not bounced back).
    await expect(
      page.getByRole("heading", { name: "Today", exact: true })
    ).toBeVisible({ timeout: 15_000 });
  } finally {
    // A step above failed before the record was made. Never let this replace the original error.
    await recordBefore().catch(() => null);
  }

  // Save again now that Today has rendered, so the smoke specs start from the same state as before DEL-02.
  await page.context().storageState({ path: authFile });
});
