# Reading practice: review grades and quiz results

Spaced-repetition review grades (`/reading` Review card) and checkpoint quiz results (recorded by the chat's
`record_reading_quiz` tool or `POST /api/reading/quiz`).

## One operation, one receipt (PROD-T02)

- `sql/reading_practice_receipts.sql` adds a nullable `op_key` to `pds.reading_reviews` and `pds.reading_quizzes`
  (partial unique indexes), a service-role-only receipt table `pds.reading_practice_ops` and two functions,
  `pds.reading_grade_review(jsonb)` and `pds.reading_record_quiz(jsonb)`. Authored, not applied by the change that
  added it.
- Both functions run in one transaction under the advisory lock `pds.reading_practice`, so grades and quiz results
  never interleave. A grade locks the highlight row, stores the review, writes the schedule and records the receipt;
  any error rolls all of it back, so a failed schedule write never leaves a stored grade behind.
- The receipt is keyed by the operation UUID with a sha-256 of the normalized request (review: highlight + grade;
  quiz: book, checkpoint, score, total, notes, explicit date). The same key and request answers the stored receipt
  (`replayed: true`, no second row, no second XP); the same key with another request is `409 key_reused`.
  Refusals are not recorded, so a refused key is not spent.
- The schedule is computed by `scheduleAfterGrade` in `frontend/src/lib/reading-practice.ts` (the same helper the
  review card's previews use) from the row the server read. The function refuses `raced` when the locked row is no
  longer that state (the server re-reads and recomputes, at most three tries) and `409 changed` when the card on
  screen was an older state than the row (another screen graded it first). An archived highlight is `409 archived`.
- There is no direct-write fallback. Until the SQL is applied both routes answer `503 practice_unavailable` and
  nothing is written.
- Existing reviews and quizzes stay as they are. Rows stored before keys existed keep counting for XP; nothing is
  deduplicated after the fact. A stored quiz row is one durable attempt; a replay adds none.
- Callers without a key (the chat tool, a page loaded before the change) get a key made on the server: the write is
  atomic, but a retry of that request is a new attempt. The chat's replay ledger (SEC-04) can pass its operation id
  as `op_key` to `recordQuiz` to make chat quiz retries exact.

Routes: owner session only (never in `isCiRoute()`), same-origin, JSON only, 8 KB cap, unknown fields refused,
errors are short codes.

## Rollback

Revert the route and card code. The additive columns, the receipt table and the functions can stay (read-only for
recovery); never delete reviews, quizzes or receipts to roll back.

## Tests

`frontend/tests/reading-practice.test.cjs` (synthetic data): request parsing, the single RPC per operation with no
direct table writes, replay, the `raced` re-read, failure mapping without fallback, and SQL ordering / grant guards.
The guards complement SQL review; real rollback and concurrency behaviour is checked after release with an
authorized fixture, never with production data.
