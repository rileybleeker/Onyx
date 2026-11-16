import { test } from "@playwright/test";
import { provenanceDir, readServedRevision, writeServedRevision } from "./provenance";

// Runs once after every smoke test has finished (the `setup` project's teardown in playwright.config.ts) and
// records what production serves now. Together with the record auth.setup.ts made right after signing in,
// it proves the whole run tested one commit and deployment (DEL-02). Never fails on a mismatch: the verdict
// (tools/merge_train.py smoke-verdict) decides, and a mismatch there is deferred, not failed.
test("record the revision production serves after the smoke run", async ({ page }) => {
  test.skip(!provenanceDir(), "provenance is recorded in CI only (SMOKE_PROVENANCE_DIR)");
  writeServedRevision(await readServedRevision(page.request, "after"));
});
