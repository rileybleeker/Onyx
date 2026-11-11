# Wins board

`/wins` is a curated, authenticated celebration of Onyx improvements, available through shared navigation on desktop, mobile, and command search.

## Editorial contract

Add only public-safe product summaries to `frontend/src/lib/wins.ts` with an existing Onyx PR number. Never copy health records, private agent messages, credentials, or unverified attribution. Selected highlights are intentionally not a full activity log. The board does not claim that every item was jointly authored or reviewed by both agents.

Status is read from the public GitHub PR API, with a five-minute server fetch cache and an eight-second timeout. A merged timestamp on a closed PR is required for Merged. Closed without merge, draft, review, and unavailable states stay distinct. Merged does not mean deployed. Missing rows (including old PRs outside the latest 100 updated), malformed data, rate limits, and outages show Status unavailable rather than falling back to optimistic editorial status. Only curated text reaches the page; remote titles and bodies are never displayed. No token is sent to GitHub.

`Check again` refreshes the server view and respects the cache. The source timestamp comes from the upstream Date header, not render time. Entries are curated in display order, not automatically ranked.

## Verification

From `frontend`: `node --test tests/wins.test.cjs`, `npx tsc --noEmit`, and legacy-config lint with `ESLINT_USE_FLAT_CONFIG=false npx eslint src/app/wins src/lib/wins.ts src/lib/wins-server.ts src/lib/nav.ts`. The tests run in the required frontend CI job. Exercise All / Merged / In progress filters, repeat refresh, keyboard focus, mobile widths, GitHub failures, and the owner-auth boundary before reporting deployment verified.
