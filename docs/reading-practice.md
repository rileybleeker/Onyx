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

## The Review card (PROD-T03)

`frontend/src/app/reading/ReviewCard.tsx`, pure rules in `lib/reading-practice.ts`.

- Each grade button shows its label and the interval the server will store, computed with `reviewPreview` (the
  same `scheduleAfterGrade` the commit uses). The first Good is 1 day, the second 3 days.
- One request at a time. While a grade is saving, the buttons are `aria-disabled` (a pressed button keeps focus) and
  a status line says the buttons wait for Onyx's answer. The card and the revealed note stay on screen.
- No answer or a server error: an inline "Not saved" alert (a word and an icon, not color alone) with Retry. The
  card keeps ONE operation key until it hears a definite answer, so Retry, or a different grade, reuses it: a
  grade that did land is answered from its receipt, and `key_reused` (another grade was stored first under that
  key) counts as graded. A reload loses the key, which stays safe: every grade carries the card's review count, and
  a grade on an older state of the row is `409 changed`, so a card is still graded once.
- A refusal (4xx) wrote nothing: no Retry, any grade can be picked, the next try gets a new key. Graded on another
  screen, archived or gone (409 / 404): grades are blocked and Refresh re-reads the overview.
- Success advances exactly once: the card's graded highlight ids are kept for the day, so a reload that raced the
  grade cannot bring a card back. Focus moves to the next card's reveal button or to the "Nothing due" line; the
  reveal moves focus to the note. Each failure is announced once (the alert is removed while a retry is saving).
  Retry and Refresh leave the screen while they work, so focus never drops to the page: a Retry that fails again
  puts focus on the new Retry button, and Refresh puts it on the note, then on the next card once the re-read
  overview replaces this one.
- Controls are at least 44 px high with 12 px between grade buttons, on desktop and at 390 px.

Tests: `frontend/tests/reading-review-card.test.cjs` (the real component under the hook harness, synthetic cards).

## Learning questions: source versions and attempt receipts (PROD-T07)

`sql/reading_learning_questions.sql` (apply after `reading_practice_receipts.sql`), `lib/reading-questions.ts`,
`lib/reading-questions-server.ts`, `GET / POST /api/reading/questions`.

- **Questions and versions.** `pds.reading_questions` holds one row per version of a question: `question_key`
  (stable across versions), `version`, prompt, optional rubric (expected answer / grading guide), the source it is
  drawn from and a sha-256 of that source's normalized text, computed by the database (`pds.reading_source_text`)
  when the version is written. The client never sends a hash.
- **Permitted sources only.** `highlight` (a highlight of the same book, passage + comment, not archived),
  `session` (the recall note of a session of the same book; the session's `question` field, a question for a
  client, is never read) and `chapter` (a chapter of the same book). Journals, email, health, finance and client
  material cannot be a source: the column's check allows nothing else.
- **Attempts.** `pds.reading_question_attempts` keys each answer by the client's UUID. The same key and answer
  replays; another answer under that key is `409 key_reused`, and a second answer to the same question in one quiz
  under a new key is `409 already_answered` (it would raise the quiz's total). The answer is stored as `pending`;
  grading (`correct`, `grader` model | self, feedback, `graded_at`) is a separate call, so an answer whose grading
  never finished stays visible. Grading again with the same grade replays, another grade is `409 already_graded`.
- **Quiz results.** A quiz result recorded under op_key K (`/api/reading/quiz`, `recordQuiz`) is checked against
  the answers given with `quiz_key` K: refused while any is ungraded (`409 attempts_pending`) or when its score /
  total differ from the graded answers (`409 score_mismatch`, also when every answer was invalidated by a
  correction, leaving nothing to check against); `question_count` is then set. A result without such
  answers (every result stored before this change, and the chat's results until its tool sends questions) has
  `question_count` NULL and is shown as `unverified` in the overview and the chat summary; it still counts for XP.
- **Corrections.** `op: "correct"` with the version on screen (`expected_version`) makes the next version and
  supersedes the old one (kept, with the reason). Every answer to an older version is marked `invalidated` (kept,
  with its grade and the reason), and a recorded result that counted one gets `invalidated_count` > 0: the
  checkpoint tile shows it as "corrected", and it earns no XP and no pass badge. Answering a question whose prompt,
  rubric or source text no longer matches the stored version is `409 question_changed`, never silently accepted.
- **Inspection and export.** `GET /api/reading/questions?book=<slug>` (owner session, `no-store`) returns every
  version with its source reference, hash and `source_status` now (`same`, `changed` or `removed`) and every
  attempt with its raw answer. It is the export. The client cache keeps this key in memory only
  (`isSensitiveKey`), never in IndexedDB.
- **Source deletion.** Removing a source (archiving a highlight, deleting a session) never removes a question or an
  attempt: the version keeps its hash, inspection shows `removed`, and the question cannot be answered again until
  it is corrected to a permitted source.
- **Raw-exchange retention (defined, not yet scheduled).** `pds.reading_clear_question_answers(days)` clears the
  answer and feedback text of attempts graded or invalidated more than `days` ago (at least 30), keeping the
  answer's hash, the grade and every timestamp. Proposed: 180 days, run daily. Scheduling it is a rollout decision
  for Riley; nothing runs it yet. Pending (ungraded) answers are never cleared.
- Access: tables and functions are service_role only (row level security on, no policies, nothing granted to anon
  or authenticated). Errors are codes; no prompt, answer or feedback text is logged.
- **Not wired yet:** no screen or chat tool writes questions. The chat quiz flow (`record_reading_quiz`, chat
  route) should record each question with `op: "answer"` / `"grade"` and the quiz's op_key as `quiz_key`, then the
  result under that op_key; that change waits for the chat replay work (SEC-04) to land.

Tests: `frontend/tests/reading-questions.test.cjs` (synthetic): parsing (only permitted sources), the single RPC
per operation, replay / conflict codes, export, verification and XP rules, the memory-only cache key, and SQL
guards (permitted sources, database-made hashes, lock order, invalidate-never-remove, grants, additive only).

## Rollback

Revert the route and card code. The additive columns, the receipt table and the functions can stay (read-only for
recovery); never delete reviews, quizzes or receipts to roll back.

## Tests

`frontend/tests/reading-practice.test.cjs` (synthetic data): request parsing, the single RPC per operation with no
direct table writes, replay, the `raced` re-read, failure mapping without fallback, and SQL ordering / grant guards.
The guards complement SQL review; real rollback and concurrency behaviour is checked after release with an
authorized fixture, never with production data.
