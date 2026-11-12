# Wins board

`/wins` is a curated, authenticated celebration of Onyx improvements, available through shared navigation on desktop, mobile, and command search.

## Stages

Every card is in exactly one stage, shown as its own group, from furthest along to least:

1. **Live on the site**: merged, a website change, and GitHub records a successful Vercel Production deployment made at or after the merge.
2. **Merged**: merged into `master`. Either the change is not a website change (tests, automation, database scripts, the iPhone prototype), so no site deployment applies, or a site deployment could not be confirmed.
3. **Proposed, in review**: open and ready for review. Not merged.
4. **Draft**: open draft. Not merged.
5. **Closed, not merged** and **Status unavailable**: never counted as delivered.

Merged is not deployed, and a database script the owner must run by hand is not "live" even when its PR is merged; its card says so.

## Editorial contract

Add only public-safe product summaries to `frontend/src/lib/wins.ts` with an existing Onyx PR number, what changed, why it helps, and a `surface` (`site` for website changes, `behind` for everything else). Never copy health records, private agent messages, credentials, or unverified attribution. Selected highlights are intentionally not a full activity log. The board does not claim that any item was authored or reviewed by a particular agent, because every PR is opened under one GitHub account and only some carry co-author trailers. Do not add a change that needs a manual database step to the `site` surface without saying so in its summary.

Status is read from the public GitHub PR API, with a five-minute server fetch cache and an eight-second timeout. A merged timestamp on a closed PR is required for Merged. Closed without merge, draft, review, and unavailable states stay distinct. Malformed data, rate limits, and outages show Status unavailable rather than falling back to optimistic editorial status. Only curated text reaches the page; remote titles and bodies are never displayed. No token is sent to GitHub.

Live on the site comes from the public GitHub Deployments API (`environment=Production`, state `success`, posted by Vercel). The board takes the newest successful production deployment of the three most recent, reads the time of the commit it built, and treats a merged `site` change as live when it was merged at or before that commit (or is that commit). If the deployment lookup fails or nothing is successful, site changes stay at Merged. This is a cached snapshot, refreshed about every 15 minutes, and it proves a deployment succeeded, not that a page was exercised in a browser.

Older highlights missing from the latest 100 updated PRs use individual hourly-cached lookups. Cache revalidation can retain older snapshots; the board does not promise a maximum age. The source timestamp comes from the oldest upstream Date header used, not render time. Entries are curated in display order within each stage, not automatically ranked. At most about 40 GitHub requests per hour in total (12 list, 12 deployment, up to 15 hourly fallbacks), under the unauthenticated limit of 60.

## Verification

From `frontend`: `node --test tests/wins.test.cjs`, `npx tsc --noEmit`, and legacy-config lint with `ESLINT_USE_FLAT_CONFIG=false npx eslint src/app/wins src/lib/wins.ts src/lib/wins-server.ts src/lib/nav.ts`. The tests run in the required frontend CI job and include stage separation (live, merged, proposed, draft never mix). Exercise All / Delivered / In progress filters, keyboard focus, mobile widths, GitHub failures, and the owner-auth boundary before reporting deployment verified.
