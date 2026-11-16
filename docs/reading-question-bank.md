# Reading question bank (READ-QUIZ-01)

Quizzes on everything relevant in a book, not only on Riley's highlights. For each book Riley turns on, Onyx builds
a private **question bank**, one chapter at a time, from two kinds of evidence: published chapter guides and
summaries found with Claude's server-side web search and fetch (kept as their API citations), and Riley's own Kindle
highlights. **Onyx never reads the book's text.** Every stored idea cites at least one stored piece of evidence;
nothing comes from model memory alone. Practice is a daily round of 8 cards (Quick 3 is its first 3), with a chapter
recall card the day after a chapter is finished and again 7 and 21 days later.

This file describes the schema and the pure core (slice S1). The generator and worker (S2), the practice API (S3),
the UI (S4), the chapter map / checkpoint / XP (S5) and the chat tools (S6) build on it; S7 refreshes this page.

## Files

| File | What |
|---|---|
| `sql/reading_question_bank.sql` | Tables, columns added to PROD-T07's tables, and every function (additive; MCP-safe) |
| `sql/reading_question_bank_checks.sql` | Widens two PROD-T07 checks (`source_kind 'idea'`, `grader 'local'`); dashboard only |
| `frontend/src/lib/reading-bank.ts` | Generation core: cost, blocked hosts, citations, build gates, planner, heartbeat text |
| `frontend/src/lib/reading-recall.ts` | Practice engine: the round, local grading, score math, schedule replay |
| `frontend/src/lib/reading-model.ts` | The one model call helper (`bankModelCall`) and the price table |

## Apply order (Riley approves production schema writes)

1. `sql/reading_practice_receipts.sql`, then `sql/reading_learning_questions.sql` (the reading lane, PROD-T02 / T07).
2. Read `pds.reading_bank_schema_ok()` after step 3, or check T07's two CHECK constraints before it: when
   `source_kind` does not allow `'idea'` or `grader` does not allow `'local'`, run
   `sql/reading_question_bank_checks.sql` in the Supabase dashboard SQL editor (it replaces two constraints, which
   the MCP refuses). It only widens; every value T07 allows stays allowed.
3. `sql/reading_question_bank.sql` (through the Supabase MCP or the dashboard). Re-apply it whenever
   `sql/reading_learning_questions.sql` is applied again: it re-defines `pds.reading_source_text` with an added
   `idea` branch, and T07's own definition has three branches.

Until step 3, every bank route answers 503 `bank_unavailable` and nothing is written; `/reading` behaves as before
(the review card).

## Data model

All new tables are **service-role only** (row level security on, no policies, nothing granted to anon or
authenticated). The browser never reads them: an owner-readable table would let a signed-in browser read locked
chapters through PostgREST. Rows are never removed: ideas and questions are retired, answers are invalidated (kept,
with the reason), flags are restored.

| Table | One row per |
|---|---|
| `pds.reading_bank_books` | book: Riley's approval and per-book cap, spend, pause, the source map (`mapping`, `narrative`, `map_urls`, `toc_hash`), a "Not read yet" hold |
| `pds.reading_bank_chapters` | chapter: build status (`pending`, `ready`, `thin`, `anchors_only`, `no_sources`, `failed`), counts, rebuild counter, when it became quizzable |
| `pds.reading_bank_sources` | piece of evidence: a web citation (URL, domain, title, the API's `cited_text` cut to 300 characters) or a reference to a highlight (the passage stays in `book_highlights`) |
| `pds.reading_ideas` | idea: kind, importance (core / supporting / detail), title, statement, key points, facts, the chapter, the chapter it unlocks at, the edition hash. Immutable (trigger `OXB10`): a correction retires the row and stores a new one |
| `pds.reading_idea_evidence` | idea × source |
| `pds.reading_idea_state` | idea: the schedule cache (stage, SM-2 lite fields, lapses, last questions asked, `state_version`, `dirty`) |
| `pds.reading_bank_jobs` | model job: step (`map`, `research`, `build`, `highlights`, `grade`), input hash, status, lease, reserved and charged cents, counts, the research notes, an error code |
| `pds.reading_question_flags` | flag on a question (`wrong`, `unclear`, `not_in_chapter`, `not_read_yet`), replay safe by `flag_key` |

Added to PROD-T07's tables: on `pds.reading_questions` the idea, chapter, format (`cued`, `explain`, `order`,
`chapter_recall`), unlock chapter, edition hash, retirement, job and prompt version; on
`pds.reading_question_attempts` the round, the covered ideas of a chapter recall answer, verdict and score, hinted,
rubric hits (ids only), model verdict and override, grade tries and error, response time, and `ext_hash` (the bank's
request identity). Bank questions are T07 question versions with T07's content and source hashes, computed by the
database with T07's formulas; bank answers are T07 attempt rows with T07's answer and request hashes. T07's own
function and parser keep refusing `idea`, so a bank question can only be answered through `pds.reading_bank_attempt`.

## Spoiler gate

`pds.reading_bank_quiz_through(book)` is the highest chapter Riley may be quizzed on:

- **stated**: the highest `chapter_through` of a session he logged himself (Log or chat);
- **kindle**: the highest chapter whose *next* chapter (by start position) the Kindle reading position or a highlight
  has reached (a chapter is never counted as done just because a highlight sat near its end);
- **last**: the last chapter, once the book is finished or a session reached it;
- capped at the chapter count, and at `hold − 1` while a "Not read yet" hold stands (released when the reading
  position passes the hold position and reaches the chapter after the held one, when he logs through it himself,
  or when the book is finished).

Every read (`reading_bank_deck` / `_round`, `_summary`, `_overview`, `_chapter`) and the attempt and flag functions
apply it, together with the edition check (an idea's `chapter_hash` must equal the current sha256 of
`chapter|N|<table of contents title>`, so a changed table of contents hides stale ideas at once). Locked rows never
leave the server. An idea the verifier placed as unsure, an idea flagged "Not in this chapter" and whole-book ideas
(chapter 0) unlock at the end of the book. Banks are built up to two chapters ahead and stay locked until then.

## Sources and evidence

- Web evidence: only the citations the API returns on a research or map answer (`citedNotes`); a sentence without a
  citation is thrown away; pages are never stored.
- Blocked: `BLOCKED_DOMAINS` (e-reader hosts and shadow-library / full-text-copy hosts, at most 64) on both web
  tools, and `isBlockedUrl()` after the call (book files off publisher hosts, "free download", "full text", "read
  online").
- Highlight evidence: an idea may cite a highlight only when the highlight states it (the verifier checks; the
  exact-fact gate checks values against the passage).
- Never sent to a web-enabled call: highlight passages, comments, recall notes, answers. Research calls get public
  book details only (title, author, chapter number, table-of-contents titles, source URLs).

## Build gates (`applyVerify` + `validateBuild`, pure)

1. The verify pass (a second model, fresh context, same evidence) can only take things away: `supported` no or
   partly, later content or a later placement → not stored; earlier → stored in this chapter; unsure → stored,
   unlocked at the end of the book. A question it did not mark ok is not stored; an idea left without a question is
   not stored.
2. Code gates: every support id exists in the build; **exact-fact gate** (a fact marked exact must have its value,
   number words and digits unified and units kept, in the idea's own cited snippet or highlight, else it becomes
   non-exact and any question answered by it is left out); **copy guard** (no stored text shares 12 consecutive
   words with a snippet or a highlight); the answer is not in the prompt (no run of 3 answer words; a shorter answer
   not at all); a multiple-choice hint has 4 distinct options with the answer marked; order has 3 to 7 steps;
   explain has 2 to 4 points with exactly one `must`; length limits; the rubric is at most 1,800 characters as
   JSON (the database allows 2,000).
3. Dedupe: a title with token Jaccard ≥ 0.8 against an existing idea of this or an earlier chapter is not stored.
4. Status: `ready` at 60% of the chapter's target (from its print page span), `thin` below, `anchors_only` when
   every idea rests on highlights only, `no_sources` when none survive.
5. Stored through `pds.reading_bank_store` in one transaction (replace for a build, add for the highlights step).

## Planning and money

- `planBankJobs(pds.reading_bank_plan_input(book))`: nothing while the book is off; the source map first (and again
  when the table of contents changes); then research → build per chapter up to `quiz_through + 2` that has no
  current bank (newest quizzable chapter 20, the next one 30, older ones 40 + n, two ahead 80); a highlights job
  (60) for new or edited unlinked highlights of a built chapter (its hash follows the highlight content); with an
  uncertain mapping, chapters are built from highlights only and a whole-book chapter 0 (90) once the book is
  finished. Queued jobs no longer planned are skipped (and queued again if planned again later).
- Estimate: 20¢ + 37¢ per chapter (40 chapters ≈ $15). Riley's one tap per book approves the cap: estimate × 1.25,
  rounded up to whole dollars, at most $25. A monthly cap of $30 across generation and grading
  (`READING_BANK_MONTHLY_CAP_CENTS`). `pds.reading_bank_claim` reserves the step's estimate before a call and pauses
  the book (`budget`) when its cap would be passed; `pds.reading_bank_finish` charges the real cost.
- `bankModelCall` (one helper for every call): streaming, the server-side refusal fallback, explicit effort, no
  `thinking` parameter, the system prompt as a cached prefix, stop reasons checked before content (`refusal`,
  `max_tokens`, `pause_turn` continued up to 3 times), cost from usage (Opus 5.5 $4 / $20 per million tokens,
  Sonnet 5.5 $2 / $10, web search $10 per 1,000), errors as codes only.

## Practice (`lib/reading-recall.ts`, pure)

- **Round**: 8 cards. At most 1 chapter recall (the oldest due, first); due ideas, up to 5, most overdue first; new
  ideas, up to 3 (5 when fewer than 3 are due), core first, earliest chapter first, one slot for the newest
  chapter's core idea; at most 2 highlight reviews (highlights not linked to an idea); detail ideas only in
  leftover slots. A backlog never makes it longer. Interleaved by chapter distance, at most 2 cards of one format in
  a row. Deterministic for a deck and a day (round key = UUID of sha256(`book|day|kind|n`)), so the GET writes
  nothing and a reopened round resumes: answered cards are shown done. "One more round" takes the next candidates;
  "Practice 5" takes one chapter.
- **Variants** by stage: New / Seen → cued (or order), Recalled → explain, Explained / Kept → explain and cued
  alternating; detail ideas never explain; never one of the last 2 questions when another exists. "Again" brings a
  wrong idea back once at the end with another variant; it never touches the schedule.
- **Local grade** (`gradeLocal`, the server re-grades with it): normalized short answers with accepted forms, token
  containment and typo tolerance; a right choice after "Show choices" is partly right (0.6); order with one
  adjacent swap is partly right; "I don't know" is graded 0. A miss of 3 or more words goes to the model.
- **Model score**: explain = points (yes 1, partial 0.5) over their count, at most 0.39 when the `must` point is
  missed; chapter recall = (2 × core hits + supporting hits) / (2 × core + supporting). Score ≥ 0.8 right, ≥ 0.4
  partly right.
- **Schedule** (`replayIdeaState`): the existing SM-2 lite scheduler (`scheduleAfterGrade`), only the first answer
  of a day per idea counting (a pending first answer holds its day). Stages New, Seen, Recalled, Explained, Kept
  (a correct explanation at least 7 days after the one that reached Explained, with no lapse since); a wrong answer
  at Recalled or above drops one stage. Every write is a full replay with compare-and-set on `state_version`, and
  the "Next: in 3 days" preview is the same replay: preview equals commit.
- **Chapter recall**: one dictated answer per chapter, the day after it became quizzable, then day 7 and day 21. The
  model marks each covered idea; each gets that verdict as its event for the day, so a missed core idea is due
  tomorrow.

## Privacy and the public repo

- Sent to Anthropic: book title, author and table-of-contents titles (also seen by the web search provider);
  snippets of public pages; Riley's highlight passages (build and highlights steps); his answers to explain,
  cued-fallback and chapter recall questions (grading). Never: comments, recall notes, journal, email, health,
  finance or client material.
- Logs and heartbeats carry counts, chapter numbers and codes from a fixed list (`BANK_CODES`) only, never a title
  or any text.
- Code, tests and docs are generic; tests use a synthetic book.
