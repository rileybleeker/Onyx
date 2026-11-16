# Want to read inside Reading

Planned books use existing `pds.books` rows with `status = 'queued'`. The list appears inside Reading, including when no book is active. Title is required; author and verified ISBN/ASIN are optional. No private requested title is seeded in code, migrations or fixtures.

Typing creates one planned book and then edits that same row. Move up/down, Remove/Undo and Start reading are explicit actions. Start changes the existing book's status and optional date; it creates no session, habit stamp, progress, purchase or Notion entry. Existing highlights and history remain attached to the same book ID. Queued books remain outside the default active quest.

## Persistence and concurrency

- `sql/reading_want_list.sql` adds four metadata columns to books, an index/check, a service-only operation-receipt table and `reading_list_apply(jsonb)`. It is authored, not applied.
- The service-invoker RPC serializes list mutations under a transaction advisory lock. Duplicate detection, book changes, reorder renumbering and immutable operation receipt commit together. There is no direct-write fallback. A missing schema/function produces an unavailable response.
- UUID plus canonical payload hash identifies an operation. A repeated key/payload returns its recorded result; a changed payload under the same key is rejected. Replays preserve start/remove/reuse metadata. Existing historical duplicates are not rewritten. The check covers new list mutations; unrelated historical import/harvester reconciliation is outside scope.
- Content edits use the version the editor actually saw. A refresh cannot silently rebase unsaved words. A conflict requires a deliberate Keep my changes or Use the saved version choice. Reorders carry the full shown order and refuse if membership/order changed.
- Normalized draft fields and exact pending request bodies are retained under `onyx.reading.list.v2`. Existing session-end wiping clears the `onyx` prefix. The source refuses a mutation if storage cannot preserve its request. Twenty unknown row actions is a refusal limit, never an eviction limit. Unknown create responses replay the exact request before newer desired fields are edited through the acknowledged version.
- Hydration reads only. Restored words require Keep/edit; unknown row actions require Retry. A removed/started book's retained edit is shown for recovery rather than silently discarded. Raw speech, credentials and reading-session notes are not stored here.

## Integration and boundaries

`ReadingClient.tsx` hosts the list and reloads the quest after acknowledged changes. `AppData.tsx` warms its GET only. Existing `/api/reading` cache invalidation covers writes. Middleware restricts the route to the owner session; POST additionally requires same-origin JSON with an 8 KB limit. No Notion mirror activity is invented for planned books. Order requests are capped at 500 listed IDs; larger-list ordering needs a later bounded design.

## Release and recovery

1. Independently review the additive SQL, grants, transaction boundary and cumulative source diff. Do not apply old reading-schema grants as part of this release.
2. Apply this additive migration through the approved owner-controlled process; preserve existing book data. Deploy the reviewed frontend SHA and verify the matching deployment.
3. Run scheduled post-merge regressions. Verify actual desktop and phone behavior: empty/active Reading, title-only add, duplicate choice, edit, ordering, remove/undo and start preserving identity. Use authorized isolated fixtures for failure/concurrency writes. Verify RPC rollback after an injected failure and simultaneous same-identifier creates before claiming concurrency acceptance.
4. The requested real planned item must be added exactly once after release using the owner's authorized capture flow, without inventing author/ISBN or recording reading progress. That insertion and actual UI verification remain separate acceptance receipts.

Rollback hides/reverts the list UI/route while retaining additive metadata, receipts and all book/history rows. Do not delete user choices or rewrite historical data to roll back.

`frontend/tests/reading-list.test.cjs` exercises actual normalization, draft/replay/baseline/persistence helpers and RPC adapter with synthetic fixtures. SQL boundary guards complement independent SQL review; they do not prove PostgreSQL runtime behavior. Tests are authored only before merge. The only permitted premerge execution check is frontend `npx tsc --noEmit`.
