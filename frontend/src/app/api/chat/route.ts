import Anthropic from "@anthropic-ai/sdk";
import { whoopStepsDay, type WhoopStepsRow } from "@/lib/steps";
import { CHAT_SCOPE, MAX_TOOL_ROUNDS, MAX_TOOL_CALLS, REQUEST_ID_RE, RETRIEVED_DATA_NOTE, parseRequestId, validateChatMessages } from "@/lib/chat-contract";
import { authorizeWrite, chatWritesOff, commitWrite, newWriteUsage, writeGrantFor, type ReadingBooks } from "@/lib/chat-write-intent";
import { WRITE_GATE, WRITE_GATE_ANSWER, WRITE_GATE_QUIZ, WRITE_GATE_REQUEST_ONLY, buildWriteReceipt, isWriteTool, readingQuestLine, type QuestBook, type WriteReceipt } from "@/lib/chat-receipts";
import { conversationSha, openLedger, supabaseLedgerStore, supabaseReconcilers, uncertainText, type ChatLedger, type OpenedLedger } from "@/lib/chat-operations";
import { createSupabaseServer } from "@/lib/supabase-server";
import { createClient } from "@supabase/supabase-js";
import { NextRequest } from "next/server";
import { searchTracks, createPlaylist } from "@/lib/spotify-server";
import { logStackIntake, stackEventReplay, type LogStackResult } from "@/lib/supplement-stacks";
import { fallbackBehavioralToday, nightLabel, SLEEP_QUESTIONS, sleepAnswerDate, sleepDateError } from "@/lib/checkin";
import { behavioralToday, currentTimeZone, intakeEventReplay, logSupplementIntake } from "@/lib/supplement-intake";
import { BOOK_COLS, HIGHLIGHT_COLS, HIGHLIGHT_EXISTS, addHighlight, getBook, getOverview, logSession, recordQuiz, summarizeForChat, type Book, type Highlight, type HighlightSource, type Medium, type ReadingSession } from "@/lib/reading";
import { findMirroredEntry, mirrorHighlight } from "@/lib/reading-notion";
import { createEntryClaimOf, discardEntry, placeEntry, rewriteProgressNow } from "@/lib/reading-removal";
import { failureMayHaveWritten } from "@/lib/reading-practice";
import { CHAT_QUESTIONS_MAX, FLAG_KINDS, SLUG_RE, chatAttemptKey, chatFlagKey, chatRoundKey, flagQuestion, questionsForChat, recordAttempt, recordChatAnswer, type ChatQuestion, type FlagKind } from "@/lib/reading-recall-server";
import { DONT_KNOW_ANSWER, isDontKnow, normalizeAnswer, orderAnswerText, parseRubric } from "@/lib/reading-recall";
import { REMOVED_SINCE_ERROR, ambiguousDbError } from "@/lib/write-outcome";

/**
 * Set explicitly: the replay ledger's one-try-at-a-time lease (REQUEST_LEASE_MS in lib/chat-operations.ts, 6 min)
 * relies on the platform stopping a try before its lease runs out. Keep it below that lease.
 */
export const maxDuration = 300;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { db: { schema: "pds" } }
);

const SYSTEM_PROMPT = `${CHAT_SCOPE}

For health and fitness questions, the connected devices are Garmin watch, WHOOP band, and Eight Sleep mattress. Preserve the following domain-specific conventions.

You have access to the user's data via function calls. When the user asks about their health metrics, use the appropriate function to fetch real data before answering. You can call multiple tools to cross-reference data across devices. Be concise and insightful — highlight trends, anomalies, and actionable takeaways.

When the user's latest message reports completing a habit or asks you to mark one (e.g., "I meditated today", "mark vitamins as done"), use mark_habit_complete to log it. A habit that only comes up inside a question about something else is not a report: answer the question and offer to log it. The habit name should match what's defined in their habits list. Use query_journal to see both self-reported behaviors and habit completions together.

The user keeps reusable supplement "stacks" — named lists of supplements + doses (like a bill of materials). When they say they took a named stack or routine (e.g. "log my morning stack", "I took my evening stack"), use log_supplement_stack with the stack name. It records every supplement in that stack at once. If the name doesn't match, the tool returns the list of available stacks so you can confirm which one they mean.

For a single item — any supplement OR medication on their /supplements product list (e.g. "log 15 mg of Adderall at 8:30am and noon", "I took 2 magnesium capsules", "took my creatine") — use log_supplement_intake. Pass the name as they said it (brand names resolve, e.g. Adderall → the amphetamine salts product), the amount + unit they stated, and every clock time they mention in ONE call. The tool converts the amount into servings and stores the times, so never refuse because of a custom dose or time, and never fall back to a habit for this. Confirm in one short line what was logged (product, amount, times, day), taken from the tool result.

The user also keeps a free-form *personal* journal in Notion (prose entries about life, mood, relationships, training, mental health). Use query_journal_entries when they ask about what they wrote, how they were feeling, or to find context behind biometric trends — combine it with biometric tools to answer questions like "what was my HRV on days I logged a 'low' mood?". When a question is thematic rather than date-specific, set semantic_query to do similarity search.

You also have the user's nutrition data. FOOD comes from Cronometer (cutover 2026-05-31; MyFitnessPal for older history). Use query_nutrition for daily macros and query_meals_log for the per-meal food log. For vitamins/minerals use query_vitamins — it already COMBINES dietary intake (food, from Cronometer) with supplemental intake (pills, from Onyx's /supplements tracker) and returns the dietary, supplement, and total amounts per nutrient, so never add supplements on top of those totals. The rule is: Cronometer = food, Onyx /supplements = pills. Use query_micronutrient_trend for single-nutrient trends. A meal can also be logged from a plate photo (query_photo_meals): a photo meal counts toward a day's totals only when that day has no Cronometer log, and it never double-counts an Uber Eats order — do not add photo meals on top of a logged diary day.

You can also create Spotify playlists, but only when the user explicitly asks you to create, make or save one. A request for suggestions, ideas or recommendations (e.g. "suggest music for a focused afternoon") is NOT a request to create a playlist: answer with the suggested tracks in your reply and offer to turn them into a playlist, but do not call create_spotify_playlist. The user has private-playlist write access enabled. When explicitly asked to make a playlist:
- Use query_spotify_tracks_by_features to pick tracks from their listening history (filter by audio-feature ranges like valence, energy, tempo).
- Use search_spotify_catalog when they want tracks they haven't listened to before, or when filling out a playlist beyond what their history covers.
- Once you have track IDs (mix sources freely), call create_spotify_playlist directly — they already asked for it and playlists are private and easily deleted, so no extra confirmation is needed.
- Default to ~25–40 tracks unless the user specifies otherwise. Give the playlist a descriptive name that reflects the user's request.`;

// The reading paragraph is not in here: systemPrompt() adds it per request, because its first sentence names the
// active book (readingQuestLine), which the public code must not.
// After the reading paragraph; the clock follows it (systemPrompt()).
const SYSTEM_PROMPT_TAIL = `Replies are rendered as Markdown. Use a table when comparing several days or metrics side by side (at most about five columns: it is often read on a phone), short lists for steps or options, bold for the key figure, and plain paragraphs otherwise. Do not use raw HTML.

Format numbers clearly. Use relative comparisons (e.g., "your HRV is 15% above your weekly average"). When comparing across devices, note any discrepancies. When you don't have enough data, say so.`;

/**
 * Everything the model is told about reading apart from which book it is (that sentence is readingQuestLine). A quiz
 * runs on the question bank (READ-QUIZ-01): sourced questions on finished chapters, one recorded answer each. The free
 * quiz (record_reading_quiz, shown as unverified) is only the fallback when the bank is off for the book. Onyx records
 * a bank answer only for the question labelled "Q<id>" in your previous message, and only as the user's own latest
 * reply (lib/chat-write-intent.ts), so every question asked carries its label.
 */
const READING_RULES = `Use get_reading_status for progress, pace and coaching. When they report reading ("finished chapters 3 and 4 on my run, here's what I remember: …"), call log_reading_session and pass their recall text VERBATIM — never summarize it. Kindle reading logs ITSELF: a local harvester turns Kindle highlights, notes and the reading position into source='kindle' sessions (recall = their Kindle notes), so never ask them to log Kindle sessions or re-enter Kindle highlights; manual logging is for audiobook/paper reading only. When they ask you to save or highlight a passage ("highlight this: …", "save this quote and note that …"), call add_book_highlight; a passage they merely quote while asking a question is not a request to save it.

When they ask to be quizzed ("quiz me", "quiz me on chapter 12", "quiz me on what I got wrong", "quiz me on the book I finished"), use the question bank: call get_reading_questions (mode 'chapter' with the chapter when they name one, 'weak' for what they missed before, otherwise 'due'; for a finished book pass its slug as book) and ask its questions ONE AT A TIME, each with its prompt and a label with its number and chapter, e.g. "(Q1234 · ch 3)", always written like that: Onyx records an answer only for the question labelled in your previous message. For an order question, also list its steps_to_show exactly as given, numbered 1, 2, 3 …, and ask for the right order as a list of those numbers. Never invent a question, and never show a question's reference, explanation or sources before they have answered it. Your tool results are not kept between messages, so when they answer, call get_reading_questions again with the same mode, chapter, count and book you used to ask, to read that question's reference; if it is not listed, call it once more with mode 'chapter', the chapter from the question's label and count 10. If it is still not listed, it was already answered today or it changed: record nothing, say so in a few words and move on. Their reply to the question you just asked is itself the direct report for record_reading_answer: in that same turn, grade it against that reference only and call record_reading_answer once with their answer VERBATIM, the question_id, the version and your verdict (one call per answer, never several answers at the end of the quiz: "recorded once, at the end" is the free quiz's rule for record_reading_quiz only), then tell them the verdict the tool returns (Onyx checks an order answer itself, so its verdict can differ from yours), what the reference adds and where it comes from, and ask the next question. "I don't know" is an answer (incorrect); "skip" records nothing. Pushback on your grade ("my answer was right") is neither a flag nor a new answer: explain the reference once and say plainly if they were right, but do not record the answer again and do not flag the question (the recorded verdict stays as it is). Call flag_reading_question only when their latest message says the question itself is wrong, unclear, not in that chapter, or from a chapter they have not read yet. Never call record_reading_quiz for bank questions: each answer is already recorded. If get_reading_questions says the bank is off or not available for the book, say so and offer the free quiz instead: call get_reading_status, ask 5 short questions ONE AT A TIME drawn from the chapters they have read, their highlights and recall notes, grade each answer honestly, then call record_reading_quiz with checkpoint 'ch<N>' and the score (Onyx shows that result as unverified). Keep coaching brief and specific (chapters behind pace, streak at risk, reviews due, questions ready).`;

/** The system prompt of one request: the static rules, the reading paragraph for the active book, the reply format, the clock. */
function systemPrompt(book: QuestBook | null | undefined, clock: string): string {
  return [SYSTEM_PROMPT, `${readingQuestLine(book)} ${READING_RULES}`, SYSTEM_PROMPT_TAIL, clock].join("\n\n");
}

/**
 * The active book's public details for the reading sentence, read per request in parallel with the clock reads. With
 * no book in progress, the most recently finished one (its slug keeps its question bank reachable from the chat). A
 * failed read is not an error for the chat: the sentence then sends the model to get_reading_status (undefined).
 */
async function activeQuestBook(): Promise<QuestBook | null | undefined> {
  let book: Awaited<ReturnType<typeof getBook>>;
  try {
    book = await getBook(supabase, null);
  } catch {
    return undefined;
  }
  if (book) {
    return { title: book.title, author: book.author, total_chapters: book.total_chapters, target_date: book.target_date, slug: book.slug, status: "reading" };
  }
  try {
    const { data, error } = await supabase
      .from("books")
      .select("slug,title,author,total_chapters,finished_on")
      .eq("status", "finished")
      .order("finished_on", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(1);
    const done = !error && Array.isArray(data) ? (data[0] as { slug?: unknown; title?: unknown; author?: unknown; total_chapters?: unknown; finished_on?: unknown } | undefined) : undefined;
    if (!done || typeof done.title !== "string") return null;
    return {
      title: done.title,
      author: typeof done.author === "string" ? done.author : null,
      total_chapters: typeof done.total_chapters === "number" ? done.total_chapters : null,
      slug: typeof done.slug === "string" ? done.slug : null,
      finished_on: typeof done.finished_on === "string" ? done.finished_on : null,
      status: "finished",
    };
  } catch {
    // No book in progress is known; only the finished one could not be read.
    return null;
  }
}

const tools: Anthropic.Tool[] = [
  {
    name: "query_daily_summary",
    description: "Get Garmin daily summary stats (steps, heart rate, stress, body battery, SpO2) for a date range. Use this for general health questions. The Garmin watch is rarely worn: a day with 0 or missing total_steps means the watch was off, not that no steps were taken, so use query_whoop_cycles (step_count, steps_day) for steps on those days. Garmin's calorie estimate is returned as garmin_total_kcal_NOT_TDEE and must NOT be reported as calories burned — use query_whoop_cycles (tdee_kcal) for daily energy expenditure.",
    input_schema: {
      type: "object" as const,
      properties: {
        days: { type: "number", description: "Number of past days to query (default 7)" },
      },
      required: [],
    },
  },
  {
    name: "query_sleep",
    description: "Get sleep data (duration, stages, scores, HRV, heart rate) for a date range.",
    input_schema: {
      type: "object" as const,
      properties: {
        days: { type: "number", description: "Number of past days to query (default 7)" },
      },
      required: [],
    },
  },
  {
    name: "query_hrv",
    description: "Get HRV (heart rate variability) data including weekly average, last night average, and baseline ranges.",
    input_schema: {
      type: "object" as const,
      properties: {
        days: { type: "number", description: "Number of past days to query (default 7)" },
      },
      required: [],
    },
  },
  {
    name: "query_activities",
    description: "Get workout/activity data (type, distance, duration, pace, heart rate, training effect, VO2 max).",
    input_schema: {
      type: "object" as const,
      properties: {
        days: { type: "number", description: "Number of past days to query (default 30)" },
      },
      required: [],
    },
  },
  {
    name: "query_training_status",
    description: "Get training readiness scores and contributing factors (sleep, recovery, HRV, stress, training load).",
    input_schema: {
      type: "object" as const,
      properties: {
        days: { type: "number", description: "Number of past days to query (default 7)" },
      },
      required: [],
    },
  },
  {
    name: "query_stress",
    description: "Get stress level data including duration breakdowns by intensity.",
    input_schema: {
      type: "object" as const,
      properties: {
        days: { type: "number", description: "Number of past days to query (default 7)" },
      },
      required: [],
    },
  },
  {
    name: "query_whoop_recovery",
    description: "Get WHOOP recovery data including recovery score, HRV (RMSSD), resting heart rate, SpO2, and skin temperature.",
    input_schema: {
      type: "object" as const,
      properties: {
        days: { type: "number", description: "Number of past days to query (default 7)" },
      },
      required: [],
    },
  },
  {
    name: "query_whoop_cycles",
    description: "Get WHOOP daily cycle data including strain, kilojoules, average and max heart rate, and step_count. tdee_kcal (kilojoule / 4.184) is THE canonical daily calories-burned / TDEE figure — always use it for 'calories burned' questions. step_count is the WHOOP strap's steps for the cycle; steps_day is the calendar day those steps belong to (a cycle starts at a sleep onset, so its steps are the following waking day's). A cycle with no end_time is still in progress and its step_count is the count so far. Say the steps come from WHOOP; never add them to Garmin steps.",
    input_schema: {
      type: "object" as const,
      properties: {
        days: { type: "number", description: "Number of past days to query (default 7)" },
      },
      required: [],
    },
  },
  {
    name: "query_whoop_sleep",
    description: "Get WHOOP sleep data including sleep performance, efficiency, stages (in milliseconds), disturbances, and respiratory rate.",
    input_schema: {
      type: "object" as const,
      properties: {
        days: { type: "number", description: "Number of past days to query (default 7)" },
      },
      required: [],
    },
  },
  {
    name: "query_whoop_workouts",
    description: "Get WHOOP workout data including sport type, strain, heart rate zones, distance, and altitude.",
    input_schema: {
      type: "object" as const,
      properties: {
        days: { type: "number", description: "Number of past days to query (default 30)" },
      },
      required: [],
    },
  },
  {
    name: "query_behaviors",
    description: "Get self-reported behavior entries — caffeine, alcohol, supplements, sleep habits, recovery activities, and more. Each entry has a date, behavior name, category, and answer (Yes/No or a value).",
    input_schema: {
      type: "object" as const,
      properties: {
        days: { type: "number", description: "Number of past days to query (default 30)" },
        question: { type: "string", description: "Optional: filter by specific behavior name (e.g., 'Caffeine', 'Melatonin')" },
        category: { type: "string", description: "Optional: filter by category (e.g., 'Supplements', 'Lifestyle', 'Sleep')" },
      },
      required: [],
    },
  },
  {
    name: "query_journal",
    description: "Get the unified behavior journal combining self-reported behaviors AND habit completions. Each entry has a date, behavior/habit name, category, answer, and source ('whoop' = imported behavior history, 'habit' = tracked habit). Use this for cross-analysis of habits and self-reported behaviors.",
    input_schema: {
      type: "object" as const,
      properties: {
        days: { type: "number", description: "Number of past days to query (default 30)" },
        source: { type: "string", description: "Optional: filter by source — 'whoop' or 'habit'" },
        question: { type: "string", description: "Optional: filter by specific behavior/habit name" },
      },
      required: [],
    },
  },
  {
    name: "mark_habit_complete",
    description: "Record a habit answer for a given date — 'Yes' (did it, default) or 'No' (explicitly did NOT do it, e.g. 'I skipped meditation today'). The habit name must match one defined in the user's Notion Habits database (e.g., 'Meditated', 'Exercised', 'Read'). Defaults to today. Only record 'No' when the user explicitly says they didn't do the habit — an unmentioned habit should stay unlogged. Sleep questions (mouth tape, nightguard or retainer, nasal strip, ear plugs, sleep mask, same bed as usual, screen in bed, read in bed) describe a night that already happened: leave date empty for last night (it is stored on yesterday, the day that night closed), and never log them for tonight. The result's stored_for_night names the night (e.g. 'Wed night → Thu morning'): repeat it to the user, and if they meant another night call again with that night's date (the date of the evening it started). " + WRITE_GATE,
    input_schema: {
      type: "object" as const,
      properties: {
        habit: { type: "string", description: "The habit name exactly as defined in Notion (e.g., 'Meditated', 'Exercised')" },
        date: { type: "string", description: "Date in YYYY-MM-DD format (defaults to today; a sleep question defaults to yesterday = last night)" },
        category: { type: "string", description: "Optional: habit category (e.g., 'mindfulness', 'fitness')" },
        answer: { type: "string", enum: ["Yes", "No"], description: "'Yes' = completed (default); 'No' = explicitly not done" },
      },
      required: ["habit"],
    },
  },
  {
    name: "log_supplement_stack",
    description: "Record a whole supplement 'stack' (a saved, named list of supplements + doses) as consumed. Use when the user says they took a named stack or routine, e.g. 'log my morning stack' or 'I took my evening stack'. Writes one intake event per supplement in the stack. If the stack name doesn't match, the response lists available stacks — relay them and ask which one. " + WRITE_GATE,
    input_schema: {
      type: "object" as const,
      properties: {
        stack: { type: "string", description: "The stack name as the user refers to it (e.g. 'Morning', 'Evening stack'). Matched case-insensitively." },
        date: { type: "string", description: "Date in YYYY-MM-DD format (defaults to the current behavioral day)" },
      },
      required: ["stack"],
    },
  },
  {
    name: "log_supplement_intake",
    description: "Record ONE supplement or medication from the user's /supplements product list as taken, with an optional custom amount and optional clock times. Use for 'log 15 mg of Adderall at 8:30am and noon', 'I took 2 magnesium capsules', 'took melatonin at 11pm'. Writes one intake per time. The product is matched by name, brand, or ingredient (so 'Adderall' finds the amphetamine salts product); on no match or several matches the response lists candidates — relay them and ask. A weight amount (mg/mcg/g/IU) is converted to servings from the product's label; a count (capsules, tablets, scoops) is divided by the serving size. Re-sending the same timed entry is skipped, not duplicated. " + WRITE_GATE,
    input_schema: {
      type: "object" as const,
      properties: {
        product: { type: "string", description: "The product as the user named it (e.g. 'Adderall', 'magnesium', 'Creatine Monohydrate')" },
        amount: { type: "number", description: "Amount PER intake, as the user stated it (e.g. 15 for '15 mg', 2 for '2 capsules'). Omit for one standard serving." },
        unit: { type: "string", description: "Unit of amount: 'mg', 'mcg', 'g', 'IU', a count unit like 'capsule' / 'tablet' / 'scoop', or 'serving'" },
        times: { type: "array", items: { type: "string" }, description: "Local clock time of each intake in 24-hour HH:MM (e.g. ['08:30','12:00']). One intake is written per time. Omit when no time was given (today → stamped now; a past day → no time stored)." },
        date: { type: "string", description: "Day the intake belongs to, YYYY-MM-DD (defaults to the current behavioral day — a dose taken after midnight but before sleep still belongs to the day that is ending)" },
      },
      required: ["product"],
    },
  },
  {
    name: "get_reading_status",
    description: "Get the user's reading quest for the book in progress (default: the active book): chapters done vs total, pace vs target date, streak, XP/level, badges, checkpoints with quiz results, recent sessions WITH their from-memory recall notes, highlights WITH comments, and highlights due for review. Use it for 'how is my reading going', to coach pace, and as the source material for the free quiz when get_reading_questions says the question bank is off for the book.",
    input_schema: {
      type: "object" as const,
      properties: {
        book: { type: "string", description: "Book slug (e.g. 'synthetic-book'). Omit for the active book." },
      },
      required: [],
    },
  },
  {
    name: "log_reading_session",
    description: "Record a reading session for the active book: the chapter reached, minutes, medium, and the user's from-memory recall note (what happened, what principle, where it shows up in a BC implementation) plus one question. Use when the user says they read/listened to chapters ('I finished chapters 5 and 6 on my run', 'log my reading: through chapter 8, here is what I remember…'). Pass their recall text VERBATIM as `recall`. Also marks the book's habit for that day and mirrors the entry to Notion. Returns XP gained. " + WRITE_GATE,
    input_schema: {
      type: "object" as const,
      properties: {
        chapter_through: { type: "number", description: "Last chapter completed (cumulative, e.g. 6)" },
        chapter_from: { type: "number", description: "First chapter of this session (optional; defaults to previous max + 1)" },
        minutes: { type: "number", description: "Minutes spent (optional)" },
        medium: { type: "string", enum: ["audio", "kindle", "paper", "other"], description: "How they read (optional)" },
        recall: { type: "string", description: "The user's own words, verbatim: what happened, the principle, the BC mapping" },
        question: { type: "string", description: "One question they'd ask a plant manager / client (optional)" },
        date: { type: "string", description: "YYYY-MM-DD (defaults to the current behavioral day)" },
        book: { type: "string", description: "Book slug (optional; defaults to the active book)" },
      },
      required: ["chapter_through"],
    },
  },
  {
    name: "add_book_highlight",
    description: "Save a highlighted passage from the book with the user's comment, chapter and concept tag (e.g. 'Bottleneck / capacity-constrained resource'). Use when the user quotes or paraphrases a passage they want to keep ('highlight this: …', 'save this quote and note that …'). Idempotent on passage. Mirrors to Notion and enters the spaced-repetition review queue. " + WRITE_GATE,
    input_schema: {
      type: "object" as const,
      properties: {
        passage: { type: "string", description: "The passage text" },
        comment: { type: "string", description: "The user's comment / annotation (optional but encouraged)" },
        chapter: { type: "number", description: "Chapter number (optional)" },
        concept: { type: "string", description: "Concept tag for the TOC→BC mapping (optional)" },
        source: { type: "string", enum: ["manual", "kindle", "audible", "paper", "photo"], description: "Where it came from (optional)" },
        book: { type: "string", description: "Book slug (optional)" },
      },
      required: ["passage"],
    },
  },
  {
    name: "record_reading_quiz",
    description: "Record the result of a checkpoint quiz you just ran with the user about the book. Call it AFTER asking the questions one at a time and grading the answers. checkpoint is 'ch<N>' for a chapter checkpoint (N = the checkpoint's chapter number) or 'review' for a later spaced review. 80%+ passes and earns the Quiz Master badge. " + WRITE_GATE_QUIZ,
    input_schema: {
      type: "object" as const,
      properties: {
        checkpoint: { type: "string", description: "'ch<N>' (a chapter checkpoint) | 'review' | other label" },
        score: { type: "number", description: "Correct answers" },
        total: { type: "number", description: "Questions asked" },
        notes: { type: "string", description: "What they missed, in one or two lines (optional)" },
        book: { type: "string", description: "Book slug (optional)" },
      },
      required: ["checkpoint", "score", "total"],
    },
  },
  {
    name: "get_reading_questions",
    description: "Get questions from the user's reading question bank: sourced questions on the chapters they have finished (a chapter they have not finished is never returned). Each has question_id, version, chapter, format (cued = short answer, explain = in their own words, order = put the steps in order), the prompt to ask, steps_to_show (order questions only: the same steps shuffled, never in the right order; list exactly these, numbered, when you ask), the reference to grade against (cued: the answer and accepted forms; explain: the points, the one marked must is essential; order: the steps in the right order; each with an explanation), the idea it tests and its sources. mode 'due' (default) = ideas due for practice first, then new ones; 'chapter' = one chapter's questions (pass chapter); 'weak' = ideas they missed before. Ideas already answered today are left out. Use it when the user asks to be quizzed, and again on each answer to read that question's reference. Never show a reference, explanation or source to the user before they have answered. enabled: false = the bank is off for this book (offer the free quiz instead).",
    input_schema: {
      type: "object" as const,
      properties: {
        mode: { type: "string", enum: ["due", "chapter", "weak"], description: "'due' (default), 'chapter' (with chapter) or 'weak'" },
        chapter: { type: "number", description: "Chapter number: required for mode 'chapter'; with 'weak' it keeps to that chapter" },
        count: { type: "number", description: `How many questions (default 5, at most ${CHAT_QUESTIONS_MAX})` },
        book: { type: "string", description: "Book slug (optional; defaults to the book in progress; pass it for a finished book)" },
      },
      required: [],
    },
  },
  {
    name: "record_reading_answer",
    description: "Record the user's answer to ONE question from get_reading_questions, with your grade, right after they answered it. Grade against that question's reference only: correct = it matches the answer (or an accepted form) or covers the points including the must point; partial = partly right; incorrect = wrong, missing the must point, or 'I don't know'. An order question is graded by Onyx itself: pass their reply as given (the numbers of the steps_to_show you listed, e.g. '3 1 4 2', or the steps written out one per line) and any verdict; Onyx maps it to the steps and checks the order. Pass their answer VERBATIM (their whole reply to the question, unedited), the question_id and version from get_reading_questions, your verdict, and optionally one short line of feedback. Onyx records it only for the question you asked in your previous message (its label, e.g. Q1234, is in that message) and only as the user's own latest reply. A skipped question records nothing. Returns the stored verdict (tell them that one); a refusal means nothing was recorded. " + WRITE_GATE_ANSWER,
    input_schema: {
      type: "object" as const,
      properties: {
        question_id: { type: "number", description: "question_id from get_reading_questions" },
        version: { type: "number", description: "version from get_reading_questions" },
        answer: { type: "string", description: "The user's answer, verbatim" },
        verdict: { type: "string", enum: ["correct", "partial", "incorrect"], description: "Your grade against the reference" },
        feedback: { type: "string", description: "One short line on what was missing (optional, at most 240 characters)" },
      },
      required: ["question_id", "version", "answer", "verdict"],
    },
  },
  {
    name: "flag_reading_question",
    description: "Flag a question from get_reading_questions when the user says it is wrong (the idea itself is wrong: it is retired and the answers to it stop counting), unclear (only that question is retired), not in this chapter (the idea moves to the end of the book), or about a chapter they have not read yet (that chapter is held back until they read further). Pass the question_id and the kind. Onyx flags it only when the user's own latest message says so about that question. " + WRITE_GATE,
    input_schema: {
      type: "object" as const,
      properties: {
        question_id: { type: "number", description: "question_id from get_reading_questions" },
        kind: { type: "string", enum: [...FLAG_KINDS], description: "wrong | unclear | not_in_chapter | not_read_yet" },
      },
      required: ["question_id", "kind"],
    },
  },
  {
    name: "query_eight_sleep",
    description: "Get Eight Sleep mattress data including sleep score, fitness score, HRV, heart rate, breath rate, bed/room temperature, sleep stages, and toss & turns.",
    input_schema: {
      type: "object" as const,
      properties: {
        days: { type: "number", description: "Number of past days to query (default 7)" },
      },
      required: [],
    },
  },
  {
    name: "search_spotify_catalog",
    description: "Search Spotify's full catalog for tracks (not just the user's listening history). Use this when the user wants tracks they haven't played before, or to fill out a playlist beyond what their history covers. Returns track ID, name, artists, album, duration, and popularity. Query syntax supports filters like 'genre:ambient', 'year:2020-2024', 'artist:Tycho'.",
    input_schema: {
      type: "object" as const,
      properties: {
        query: { type: "string", description: "Spotify search query (supports field filters: artist:, album:, genre:, year:, etc.)" },
        limit: { type: "number", description: "Max tracks to return (default 20, max 50)" },
      },
      required: ["query"],
    },
  },
  {
    name: "query_spotify_tracks_by_features",
    description: "Query the user's listening-history track library by audio features (valence, energy, danceability, tempo). Use this to curate playlists from tracks they already know. Audio features are normalized 0–1 except tempo (BPM, ~50–200). Only returns tracks with audio features attached (~78% of plays).",
    input_schema: {
      type: "object" as const,
      properties: {
        min_valence: { type: "number", description: "Minimum valence 0–1 (positivity)" },
        max_valence: { type: "number", description: "Maximum valence 0–1" },
        min_energy: { type: "number", description: "Minimum energy 0–1" },
        max_energy: { type: "number", description: "Maximum energy 0–1" },
        min_danceability: { type: "number", description: "Minimum danceability 0–1" },
        max_danceability: { type: "number", description: "Maximum danceability 0–1" },
        min_tempo: { type: "number", description: "Minimum tempo in BPM" },
        max_tempo: { type: "number", description: "Maximum tempo in BPM" },
        limit: { type: "number", description: "Max tracks to return (default 50, max 200)" },
      },
      required: [],
    },
  },
  {
    name: "query_journal_entries",
    description: "Search the user's personal Notion journal (free-form prose entries about their life — relationships, mental health, work, training, etc., distinct from the behavior journal of self-reported behaviors and habits). Use this when the user asks about how they were feeling, what they wrote about, or to find context behind health data. Supports filters and optional semantic search via 'semantic_query'. Returns entries sorted by similarity (when semantic_query given) or by date desc.",
    input_schema: {
      type: "object" as const,
      properties: {
        date_from: { type: "string", description: "ISO date (YYYY-MM-DD), inclusive" },
        date_to: { type: "string", description: "ISO date (YYYY-MM-DD), inclusive" },
        mood: { type: "string", description: "Filter by mood: 'low' | 'neutral' | 'good' | 'great'" },
        topics: { type: "array", items: { type: "string" }, description: "ANY-match against Notion Topics (e.g., ['gym','mental-health']). Empty/omit for no topic filter." },
        semantic_query: { type: "string", description: "Optional free-text query for embedding-based similarity (e.g., 'feeling unmotivated about training'). When provided, results are ordered by similarity." },
        limit: { type: "number", description: "Max entries to return (default 10, max 25)" },
      },
      required: [],
    },
  },
  {
    name: "create_spotify_playlist",
    description: "Create a private Spotify playlist with the given tracks. Playlists are added to the user's Spotify account and a link is returned. Call this ONLY when the user explicitly asked to create, make or save a playlist; never for a request for suggestions or recommendations (list the tracks in the reply instead and offer to create it). Always private; once explicitly asked, create it without further confirmation (easy to delete in Spotify). " + WRITE_GATE_REQUEST_ONLY,
    input_schema: {
      type: "object" as const,
      properties: {
        name: { type: "string", description: "Playlist name (e.g., 'Onyx — High-energy workout')" },
        description: { type: "string", description: "Optional playlist description shown in Spotify" },
        track_ids: { type: "array", items: { type: "string" }, description: "Ordered array of Spotify track IDs (just the ID portion, not full URIs)" },
      },
      required: ["name", "track_ids"],
    },
  },
  {
    name: "query_nutrition",
    description:
      "Daily nutrition macros (calories, protein, carbs, fat, fiber, sugar, sodium, water) plus caffeine per behavioral day. caffeine_total_mg (diet + supplement) is the canonical total caffeine — nutrition_caffeine_mg is the dietary-only archive. Also returns caffeine_supplement_mg, caffeine_mg_at_bedtime (5h half-life residual at sleep onset; null without trusted timestamps), and caffeine_to_bedtime_min. Source is Cronometer for new days and MyFitnessPal for pre-2026-05-31 history, transparently COALESCE'd. Macros are FOOD intake only — for supplement-inclusive vitamin/mineral totals use query_vitamins. Meals logged from a photo (query_photo_meals) count toward a day only when it has no Cronometer/MFP log here — never add them on top of a logged day.",
    input_schema: {
      type: "object" as const,
      properties: { days: { type: "number", description: "How many days back (default 7)" } },
    },
  },
  {
    name: "query_meals_log",
    description:
      "Per-entry Cronometer food log: each logged food with its meal group (Breakfast/Lunch/Dinner/Snacks/Uncategorized), amount, and macros. Use for 'what did I eat' / meal-by-meal questions. Pass `date` (YYYY-MM-DD, ET behavioral day) for a single day, or `days` for a range. This is the Cronometer diary only — meals the user logged from a photo (query_photo_meals) are NOT in it unless they also logged them in Cronometer.",
    input_schema: {
      type: "object" as const,
      properties: {
        days: { type: "number", description: "Days back (default 7)" },
        date: { type: "string", description: "Single ET behavioral day, YYYY-MM-DD" },
        limit: { type: "number", description: "Max entries (default 100)" },
      },
    },
  },
  {
    name: "query_photo_meals",
    description:
      "Meals the user logged from a plate photo (a vision estimate they confirmed or edited): per-meal rows with the behavioral eaten_date, local eaten_time, the item list (name, portion, kcal, macros), the meal's totals and confidence, PLUS per-day totals (meal_count, est_kcal, est macros). Use for 'what did I log by photo' or meals on days without a Cronometer diary log. Counting rule: a photo meal only counts toward a day's nutrition when that day has NO Cronometer/MyFitnessPal log (a logged diary day already contains the meal), and it never double-counts an Uber Eats order — the save screen warns when a delivery landed within 2 h of the meal. Combine with query_nutrition / query_meals_log instead of adding these numbers on top of a diary day.",
    input_schema: {
      type: "object" as const,
      properties: {
        days: { type: "number", description: "Days back (default 14, max 90)" },
      },
      required: [],
    },
  },
  {
    name: "query_vitamins",
    description:
      "Daily micronutrient intake WITH the dietary-vs-supplement split. For each vitamin/mineral you get the amount from FOOD (Cronometer), from SUPPLEMENTS (Onyx UNII rollup), and the TOTAL — columns like vit_d_dietary_iu / vit_d_supplement_iu / vit_d_total_iu, magnesium_total_mg, omega3_total_g, etc. Use for 'did I hit my RDA of X', 'how much Y am I getting', or food-vs-pill questions. This view ALREADY combines food + supplements, so never add supplement amounts on top of the totals.",
    input_schema: {
      type: "object" as const,
      properties: { days: { type: "number", description: "Days back (default 7)" } },
    },
  },
  {
    name: "query_micronutrient_trend",
    description:
      "Time series (dietary / supplement / total columns) for ONE micronutrient over the window, for trend questions ('how has my magnesium been', '7-day avg vitamin D'). Pass `nutrient` as a key fragment like 'magnesium', 'vit_d', 'omega3', 'b12', 'calcium'.",
    input_schema: {
      type: "object" as const,
      properties: {
        nutrient: { type: "string", description: "Nutrient key fragment, e.g. 'magnesium', 'vit_d', 'omega3'" },
        days: { type: "number", description: "Days back (default 30)" },
      },
      required: ["nutrient"],
    },
  },
];

// Explicit column lists for the chat tools that hand whole rows to the model
// (re-audit 2026-06-07, units/gpt-5/F-004: select("*") lets a new, similarly
// named column reach the model unnoticed). Each list is every column the tool
// returned before, i.e. every column of the relation minus the raw blobs that
// stripRawFields dropped anyway (raw_json, raw_hr_values, raw_stress_values,
// raw_hrv_readings). Checked against information_schema on 2026-11-14. These
// differ from the queries.ts lists on purpose: the model also gets
// garmin_training_status.load_focus, and garmin_activities has no
// raw_json->workoutId pick. If the ETL adds a column the model should see,
// append it here.
const CHAT_TABLE_COLS: Record<string, string> = {
  garmin_daily_summary:
    "ts, calendar_date, total_steps, daily_step_goal, total_distance_meters, floors_ascended, floors_descended, total_kilocalories, active_kilocalories, bmr_kilocalories, resting_heart_rate, min_heart_rate, max_heart_rate, last_seven_days_avg_rhr, avg_stress_level, max_stress_level, stress_duration_minutes, rest_stress_duration_min, low_stress_duration_min, medium_stress_duration_min, high_stress_duration_min, stress_qualifier, body_battery_charged, body_battery_drained, body_battery_highest, body_battery_lowest, body_battery_most_recent, avg_spo2, lowest_spo2, avg_waking_respiration, highest_respiration, lowest_respiration, moderate_intensity_minutes, vigorous_intensity_minutes, intensity_minutes_goal, highly_active_seconds, active_seconds, sedentary_seconds, sleeping_seconds, abnormal_hr_count, min_avg_heart_rate, max_avg_heart_rate, source, synced_at",
  garmin_sleep:
    "ts, calendar_date, sleep_id, sleep_start, sleep_end, sleep_duration_seconds, unmeasurable_seconds, deep_sleep_seconds, light_sleep_seconds, rem_sleep_seconds, awake_seconds, overall_sleep_score, quality_score, duration_score, recovery_score, rem_score, light_score, deep_score, restlessness_score, avg_sleep_heart_rate, avg_respiration_rate, avg_spo2, lowest_spo2, avg_hrv, hrv_status, avg_sleep_stress, sleep_need_seconds, sleep_debt_seconds, is_nap, auto_detected, sleep_result_type, source, synced_at, onyx_et_date, onyx_behavioral_date, onyx_local_date, onyx_tz_source",
  garmin_hrv:
    "ts, calendar_date, weekly_avg_ms, last_night_avg_ms, last_night_5min_high_ms, baseline_low_upper_ms, baseline_balanced_low_ms, baseline_balanced_upper_ms, baseline_marker_upper_ms, hrv_status, start_timestamp, end_timestamp, create_timestamp, source, synced_at, onyx_et_date, onyx_behavioral_date, onyx_local_date, onyx_tz_source",
  garmin_stress:
    "ts, calendar_date, overall_stress_level, rest_stress_duration_sec, low_stress_duration_sec, medium_stress_duration_sec, high_stress_duration_sec, stress_qualifier, source, synced_at",
  garmin_training_status:
    "ts, calendar_date, training_readiness_score, training_readiness_level, sleep_score_factor, recovery_time_factor, hrv_factor, sleep_history_factor, stress_history_factor, training_load_factor, training_status, training_status_message, acute_training_load, chronic_training_load, training_load_balance, load_focus, vo2_max_running, vo2_max_cycling, fitness_age, recovery_time_hours, recovery_heart_rate, source, synced_at",
  eight_sleep_trends:
    "calendar_date, bed_side, sleep_score, sleep_fitness_score, sleep_quality_score, sleep_duration_score, latency_asleep_score, latency_out_score, wakeup_consistency_score, sleep_routine_score, avg_heart_rate, avg_hrv, avg_breath_rate, median_bed_temp, median_room_temp, time_slept_seconds, awake_seconds, light_sleep_seconds, deep_sleep_seconds, rem_sleep_seconds, toss_and_turns, session_date, synced_at, latency_asleep_seconds, snore_duration_seconds, heavy_snore_duration_seconds, time_slept_main_session_seconds, awake_main_session_seconds, light_sleep_main_session_seconds, deep_sleep_main_session_seconds, rem_sleep_main_session_seconds, onyx_et_date, onyx_behavioral_date, onyx_local_date, onyx_tz_source",
  garmin_activities:
    "ts, activity_id, activity_type, activity_type_id, activity_name, sport_type, start_time_local, start_time_gmt, duration_seconds, elapsed_duration_seconds, moving_duration_seconds, distance_meters, avg_speed_mps, max_speed_mps, avg_heart_rate, max_heart_rate, avg_running_cadence, max_running_cadence, avg_pace_min_per_km, avg_cycling_cadence, max_cycling_cadence, avg_power_watts, max_power_watts, normalized_power, elevation_gain_meters, elevation_loss_meters, min_elevation_meters, max_elevation_meters, calories, avg_stress, aerobic_training_effect, anaerobic_training_effect, training_effect_label, training_load, vo2_max, avg_temperature_c, max_temperature_c, min_temperature_c, start_latitude, start_longitude, performance_condition, total_sets, total_reps, avg_strokes_per_length, pool_length_meters, total_lengths, manual_activity, has_splits, has_polyline, source, synced_at, onyx_et_date, onyx_behavioral_date, onyx_local_date, onyx_tz_source, is_excluded, split_label, split_labels, muscle_groups, is_sauna",
  whoop_cycles:
    "cycle_id, user_id, created_at, updated_at, start_time, end_time, timezone_offset, score_state, strain, kilojoule, average_heart_rate, max_heart_rate, synced_at, onyx_et_date, onyx_behavioral_date, onyx_local_date, onyx_tz_source, onyx_is_transition_day, step_count",
  whoop_recovery:
    "cycle_id, sleep_id, user_id, created_at, updated_at, score_state, recovery_score, resting_heart_rate, hrv_rmssd_milli, spo2_percentage, skin_temp_celsius, user_calibrating, synced_at",
  whoop_sleep:
    "sleep_id, cycle_id, user_id, created_at, updated_at, start_time, end_time, timezone_offset, is_nap, score_state, total_in_bed_time_milli, total_awake_time_milli, total_no_data_time_milli, total_light_sleep_time_milli, total_slow_wave_sleep_time_milli, total_rem_sleep_time_milli, sleep_cycle_count, disturbance_count, baseline_milli, need_from_sleep_debt_milli, need_from_recent_strain_milli, need_from_recent_nap_milli, respiratory_rate, sleep_performance_percentage, sleep_consistency_percentage, sleep_efficiency_percentage, synced_at, onyx_et_date, onyx_behavioral_date, onyx_local_date, onyx_tz_source",
  whoop_workouts:
    "workout_id, user_id, created_at, updated_at, start_time, end_time, timezone_offset, sport_id, sport_name, score_state, strain, average_heart_rate, max_heart_rate, kilojoule, percent_recorded, distance_meter, altitude_gain_meter, altitude_change_meter, zone_zero_milli, zone_one_milli, zone_two_milli, zone_three_milli, zone_four_milli, zone_five_milli, synced_at, onyx_et_date, onyx_behavioral_date, onyx_local_date, onyx_tz_source, is_excluded, split_label, split_labels, muscle_groups, is_sauna",
};
// pds.daily_micronutrient_totals: all 76 columns. query_vitamins returns every
// nutrient, and query_micronutrient_trend picks columns by name fragment, so a
// column left out here would silently drop out of both answers.
const CHAT_MICRONUTRIENT_COLS =
  "onyx_behavioral_date, vit_a_dietary_mcg, vit_a_supplement_mcg, vit_a_total_mcg, vit_c_dietary_mg, vit_c_supplement_mg, vit_c_total_mg, vit_d_dietary_iu, vit_d_supplement_iu, vit_d_total_iu, vit_e_dietary_mg, vit_e_supplement_mg, vit_e_total_mg, vit_k_dietary_mcg, vit_k_supplement_mcg, vit_k_total_mcg, b1_dietary_mg, b1_supplement_mg, b1_total_mg, b2_dietary_mg, b2_supplement_mg, b2_total_mg, b3_dietary_mg, b3_supplement_mg, b3_total_mg, b5_dietary_mg, b5_supplement_mg, b5_total_mg, b6_dietary_mg, b6_supplement_mg, b6_total_mg, b12_dietary_mcg, b12_supplement_mcg, b12_total_mcg, folate_dietary_mcg, folate_supplement_mcg, folate_total_mcg, calcium_dietary_mg, calcium_supplement_mg, calcium_total_mg, iron_dietary_mg, iron_supplement_mg, iron_total_mg, magnesium_dietary_mg, magnesium_supplement_mg, magnesium_total_mg, phosphorus_dietary_mg, phosphorus_supplement_mg, phosphorus_total_mg, potassium_dietary_mg, potassium_supplement_mg, potassium_total_mg, zinc_dietary_mg, zinc_supplement_mg, zinc_total_mg, copper_dietary_mg, copper_supplement_mg, copper_total_mg, manganese_dietary_mg, manganese_supplement_mg, manganese_total_mg, selenium_dietary_mcg, selenium_supplement_mcg, selenium_total_mcg, sodium_dietary_mg, sodium_supplement_mg, sodium_total_mg, omega3_dietary_g, omega3_supplement_g, omega3_total_g, epa_dietary_g, epa_supplement_g, epa_total_g, dha_dietary_g, dha_supplement_g, dha_total_g";
// pds.journal view: all 8 columns (query_behaviors and query_journal return whole rows).
const CHAT_JOURNAL_COLS = "cycle_date, behaviors_date, question, category, answer, notes, synced_at, source";

function stripRawFields(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map((row) => {
    const { raw_json, raw_hr_values, raw_stress_values, raw_hrv_readings, ...rest } = row;
    void raw_json; void raw_hr_values; void raw_stress_values; void raw_hrv_readings;
    return rest;
  });
}

// TDEE guard (mirrors queries.ts:getDailySummaries): WHOOP kJ / 4.184 is the
// canonical calories-burned figure. Rename Garmin's estimate so the model
// can't mistake it for TDEE, and hand WHOOP rows a ready-made tdee_kcal.
function tagCalorieSources(table: string, rows: Record<string, unknown>[]): Record<string, unknown>[] {
  if (table === "garmin_daily_summary") {
    return rows.map(({ total_kilocalories, ...rest }) => ({ ...rest, garmin_total_kcal_NOT_TDEE: total_kilocalories }));
  }
  if (table === "whoop_cycles") {
    return rows.map((r) => ({
      ...r,
      tdee_kcal: typeof r.kilojoule === "number" ? Math.round(r.kilojoule / 4.184) : null,
      // The day step_count belongs to (the waking day after the cycle's opening sleep, from its local start).
      steps_day: r.step_count == null ? null : whoopStepsDay(r as WhoopStepsRow),
    }));
  }
  return rows;
}

/**
 * Read back the intake rows a stack log just wrote (product names, servings,
 * clock time) for the receipt. Best-effort: on any failure the receipt falls
 * back to the counts logStackIntake returned.
 */
async function describeStackIntakes(intakeIds: number[]): Promise<Record<string, unknown>> {
  if (intakeIds.length === 0) return {};
  try {
    const { data: rows, error } = await supabase
      .from("supplement_intake")
      .select("intake_id,product_id,doses,intake_time")
      .in("intake_id", intakeIds)
      .order("intake_id", { ascending: true });
    if (error || !rows || rows.length === 0) return {};
    const { data: products } = await supabase
      .from("supplement_products")
      .select("product_id,brand_name,full_name")
      .in("product_id", rows.map((r) => r.product_id));
    const names = new Map((products ?? []).map((p) => [p.product_id, [p.brand_name, p.full_name].filter(Boolean).join(" ")]));
    const stamp = rows[0].intake_time as string | null;
    const tz = stamp ? await currentTimeZone(supabase, new Date(stamp)) : null;
    return {
      items: rows.map((r) => ({ product: names.get(r.product_id) || r.product_id, doses: Number(r.doses) })),
      time: stamp && tz ? new Date(stamp).toLocaleTimeString("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }) : null,
      ...(tz ? { timezone: tz } : {}),
    };
  } catch {
    return {};
  }
}

/** createPlaylist errors raised before the create call reached Spotify, or a 4xx answer to it: nothing was created. */
const PLAYLIST_NOT_CREATED =
  /^(Playlist name is required|track_ids must be a non-empty array|Spotify playlist key unavailable|Spotify is not configured|Spotify tokens not found|Spotify refresh token rejected|Spotify token refresh failed|Spotify playlist create failed \(4\d\d\))/;
const PLAYLIST_MAYBE_CREATED =
  "Spotify may have created the playlist before this failed, possibly without all its tracks. Do not create it again: tell the user to check Spotify first.";

/**
 * A write-tool call that runs through the replay ledger (lib/chat-operations.ts), when the request carries a
 * request_id. `id` = the operation id: the supplement, stack, reading, quiz and playlist writes use it as their own
 * key, so a retry that re-runs the tool finds what an earlier try already wrote. `day` = the behavioral day the
 * operation first ran on (a new operation: the day the request was first sent). Every omitted date is that day, sent
 * explicitly: a re-run on a later day, and a request that crosses the behavioral-day boundary while the model runs,
 * both keep the date the request was sent on instead of re-reading "today" at write time.
 */
interface OpContext {
  id: string;
  day: string;
  /** The instant the request was first sent (ISO): an implicit "now" clock time of a write stays on it across retries. */
  now?: string;
  /** The book being read when the operation first ran (a reading call that names no book): re-runs keep it. */
  bookId?: number;
  /** When the operation first ran (ISO): in check mode, a highlight changed since then may have been changed by it. */
  startedAt?: string;
  /**
   * Check mode (lib/chat-operations.ts): an earlier try of this call may have written. Never write over what is there.
   * A habit answer is only read (confirmed when the day holds exactly that answer, otherwise unconfirmed, also when
   * the day holds none); a highlight is confirmed by its key, or written only when provably nothing the earlier try
   * could have changed exists; a keyed intake, stack or session (RERUN_SAFE, when another call of the earlier try also
   * wrote) only reads back what its key holds and is otherwise unconfirmed, never written now.
   */
  check?: boolean;
}

/** A check-mode re-run that found something other than what the call asked for: nothing written, "check this". */
const HABIT_UNCONFIRMED =
  "An earlier try of this message started this answer and Onyx cannot confirm it: the day shows another answer or none (possibly a change made since), or could not be read. Nothing was written now. Tell the user to check /habits first.";
const HABIT_MAYBE_SAVED =
  "The database did not confirm this answer, and it may have been saved anyway. Do not send it again: tell the user to check /habits first.";
const HIGHLIGHT_UNCONFIRMED =
  "An earlier try of this message started this highlight and Onyx cannot confirm it: the saved one differs now (possibly an edit made since) or could not be read. Nothing was changed now. Tell the user to check /reading first.";
/** A keyed write whose key column cannot be read: it is refused, never written without its key. */
const KEY_UNAVAILABLE =
  "Onyx could not set up safe logging for this action, so it was not done and nothing was written. Tell the user to try again in a moment.";

/** A keyed re-run in check mode whose key holds nothing: not written now, reported as unconfirmed. */
const keyedUnconfirmed = (tool: string): string => JSON.stringify({ error: uncertainText(tool), incomplete: true, uncertain: true });

/** What an earlier try wrote under this operation id was removed since: settled, never written again. */
const REMOVED_RESULT = JSON.stringify({ error: REMOVED_SINCE_ERROR, removed_since: true });

/** SQLSTATE / PostgREST codes of a missing table or column (a schema file not applied yet, or rolled back). */
const MISSING_SCHEMA = new Set(["42P01", "PGRST205", "42703", "PGRST204"]);

/**
 * Was the supplement intake / stack / reading session written under this operation id removed since (a tombstone,
 * sql/chat_operations.sql)? "missing" (the tombstone table is not there) and "error" (the read failed) mean it cannot
 * be told, so the keyed write is refused: written now, it could repeat one that Riley removed.
 */
async function removedSince(opId: string): Promise<"removed" | "none" | "missing" | "error"> {
  const { data, error } = await supabase.from("chat_operation_tombstones").select("op_id").eq("op_id", opId).maybeSingle();
  if (error) return MISSING_SCHEMA.has(error.code) ? "missing" : "error";
  return data ? "removed" : "none";
}

/** The answer to a keyed write that must not run now (removed since, or its tombstone cannot be read); null = run it. */
async function removedGate(opId: string | undefined): Promise<string | null> {
  if (!opId) return null;
  const removed = await removedSince(opId);
  if (removed === "removed") return REMOVED_RESULT;
  return removed === "none" ? null : JSON.stringify({ error: KEY_UNAVAILABLE });
}

/**
 * The date to use when the model gave none: always the operation's day when the call runs through the ledger. Never
 * left to the writer's own "today": that is read at write time, which after a day boundary crossed during the request
 * (or on a later retry) is a different day from the one the request was sent on.
 */
const pinnedDate = (op?: OpContext): string | null => (op ? op.day : null);

/** The book a reading call uses when it names none: the one pinned when the operation first ran. */
const pinnedBook = (op: OpContext | undefined, input: Record<string, unknown>): { book_id: number } | Record<string, never> =>
  op?.bookId !== undefined && !(typeof input.book === "string" && input.book.trim()) ? { book_id: op.bookId } : {};

/** Reading tools that resolve "the book being read" when the model names no book. */
const READING_BOOK_TOOLS = new Set(["log_reading_session", "add_book_highlight", "record_reading_quiz"]);

/** The book being read right now (lib/reading.ts getBook), for a new reading operation that names no book. */
async function currentBookId(): Promise<number | undefined> {
  try {
    const book = await getBook(supabase, null);
    return typeof book?.book_id === "number" ? book.book_id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The books a reading write may go to (SEC-05): every known book, and the one being read (the newest with status
 * "reading", as lib/reading.ts getBook picks it), so a call can be checked against the book the user named. null when
 * they could not be read: reading writes are then refused (the write itself reads the same table).
 */
async function readingBooks(): Promise<ReadingBooks | null> {
  try {
    const { data, error } = await supabase.from("books").select("book_id,slug,title,status,total_chapters").order("created_at", { ascending: false });
    if (error) return null;
    const list: ReadingBooks["list"][number][] = [];
    let active: string | null = null;
    for (const b of (Array.isArray(data) ? data : []) as Array<Record<string, unknown>>) {
      if (typeof b?.slug !== "string" || typeof b?.title !== "string") continue;
      list.push({
        slug: b.slug,
        title: b.title,
        total_chapters: typeof b.total_chapters === "number" ? b.total_chapters : null,
        ...(typeof b.book_id === "number" ? { id: b.book_id } : {}),
      });
      if (active === null && b.status === "reading") active = b.slug;
    }
    return { active, list };
  } catch {
    return null;
  }
}

/** logSession / addHighlight refusals from before anything was written. Any other error came from a write. */
const SESSION_NOT_WRITTEN = /^(No active book found|chapter_through must be|chapter_through cannot exceed)/;
/** lib/reading.ts SESSION_KEY_REQUIRED: a session that must carry its key could not (nothing was written). */
const SESSION_KEY_REFUSED = /^client_key could not be stored with this session/;
const SESSION_MAYBE_WRITTEN =
  "The database did not confirm this reading session, and it may have been saved anyway. Do not log it again: tell the user to check /reading first.";
const HIGHLIGHT_NOT_WRITTEN = /^(No active book found|passage is required|client_key must be a UUID)/;
const HIGHLIGHT_MAYBE_WRITTEN =
  "The database did not confirm this highlight, and it may have been saved anyway. Do not add it again: tell the user to check /reading first.";

/** Clock skew allowed between this server and the database when asking "changed since the operation began". */
const CHANGED_SINCE_MARGIN_MS = 5_000;

interface HighlightCall {
  book_id?: number;
  slug: string | null;
  passage: string;
  comment: string | null;
  chapter: number | null;
  concept: string | null;
}

/**
 * Check mode: the highlight this call names as it stands now, read-only, on the same book addHighlight would use
 * (the pinned one, the named one, else the book being read). highlight null = no highlight with that passage there.
 */
async function highlightFor(call: HighlightCall): Promise<{ book: Book; highlight: Highlight | null } | "no_book" | "no_passage" | "error"> {
  let book: Book | null;
  try {
    book = call.book_id !== undefined
      ? ((await supabase.from("books").select(BOOK_COLS).eq("book_id", call.book_id).maybeSingle()).data as Book | null)
      : await getBook(supabase, call.slug);
  } catch {
    return "error";
  }
  if (!book) return "no_book";
  const passage = call.passage.trim();
  if (!passage) return "no_passage";
  const { data, error } = await supabase
    .from("book_highlights")
    .select(HIGHLIGHT_COLS)
    .eq("book_id", book.book_id)
    .eq("passage", passage)
    .maybeSingle();
  if (error) return "error";
  return { book, highlight: (data as Highlight | null) ?? null };
}

/**
 * The highlight this operation created (lib/reading.ts addHighlight stores the operation id as client_key on insert),
 * with its book: "none" (no highlight carries the key, so this operation created none), "missing" (the key column is
 * not there: the write is refused, never made without its key) or "error" (the read failed).
 */
async function highlightByKey(opId: string): Promise<{ book: Book; highlight: Highlight } | "none" | "missing" | "error"> {
  const { data, error } = await supabase.from("book_highlights").select(HIGHLIGHT_COLS).eq("client_key", opId).maybeSingle();
  if (error) return MISSING_SCHEMA.has(error.code) ? "missing" : "error";
  if (!data) return "none";
  const highlight = data as Highlight;
  const { data: book, error: bookError } = await supabase.from("books").select(BOOK_COLS).eq("book_id", highlight.book_id).maybeSingle();
  if (bookError || !book) return "error";
  return { book: book as Book, highlight };
}

/**
 * Was any highlight of this book created or changed since the operation began (updated_at moves on every change,
 * sql/reading_schema.sql)? null = cannot tell (no start time, or the read failed).
 */
async function highlightsChangedSince(bookId: number, startedAt: string | undefined): Promise<boolean | null> {
  const began = startedAt ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(began)) return null;
  const { data, error } = await supabase
    .from("book_highlights")
    .select("highlight_id")
    .eq("book_id", bookId)
    .gte("updated_at", new Date(began - CHANGED_SINCE_MARGIN_MS).toISOString())
    .limit(1);
  if (error || !Array.isArray(data)) return null;
  return data.length > 0;
}

/** The tool's answer for a highlight, after making its Notion entry when `mirrorNow` (none was made yet). */
async function highlightReply(
  book: Book,
  highlight: Highlight,
  opts: { created: boolean; replayed: boolean; mirrorNow: boolean; unconfirmed?: string[] },
): Promise<string> {
  let mirrored = false;
  if (opts.mirrorNow) {
    const blockId = await mirrorHighlight(book, highlight);
    if (blockId) {
      await supabase.from("book_highlights").update({ notion_block_id: blockId }).eq("highlight_id", highlight.highlight_id);
      mirrored = true;
    }
  }
  return JSON.stringify({
    success: true,
    created: opts.created,
    highlight_id: highlight.highlight_id,
    book: book.title,
    chapter: highlight.chapter,
    passage_excerpt: highlight.passage.slice(0, 200),
    has_comment: !!highlight.comment,
    next_review: highlight.next_review,
    notion_mirrored: mirrored,
    // Nothing was written to the highlight now: it is what an earlier try (or Riley) left.
    ...(opts.replayed ? { replayed: true } : {}),
    // Steps an earlier call may or may not have done, not done now: tell the user each one.
    ...(opts.unconfirmed && opts.unconfirmed.length > 0 ? { unconfirmed: opts.unconfirmed } : {}),
  });
}

/**
 * Is the stored highlight what this call asked for? Each field the call gives (addHighlight only changes the fields
 * it is given) must equal the stored one, and the highlight must not be removed (archived) since.
 */
function highlightMatches(h: Highlight, call: HighlightCall): boolean {
  if (h.archived) return false;
  const comment = call.comment?.trim() || null;
  const concept = call.concept?.trim() || null;
  const chapter = call.chapter != null && Number.isFinite(Number(call.chapter)) ? Math.round(Number(call.chapter)) : null;
  if (comment !== null && comment !== h.comment) return false;
  if (concept !== null && concept !== h.concept) return false;
  if (chapter !== null && chapter !== h.chapter) return false;
  return true;
}

interface StoredQuiz {
  quiz_id: number;
  checkpoint: string;
  score: number;
  total: number;
  quiz_date: string;
  passed: boolean;
}

/**
 * The quiz result stored under this operation key (pds.reading_practice_ops, written in the same transaction as the
 * quiz row), read only: "none" = nothing was stored under it; "error" = it cannot be read (unknown, never "none").
 */
async function quizByKey(opId: string): Promise<StoredQuiz | "none" | "error"> {
  const { data, error } = await supabase.from("reading_practice_ops").select("kind, result").eq("op_key", opId.toLowerCase()).maybeSingle();
  if (error) return "error";
  if (!data) return "none";
  const row = data as { kind?: unknown; result?: Record<string, unknown> | null };
  const r = row.result ?? {};
  // A review grade under this key (never written by chat) or a receipt without its numbers: cannot be told.
  if (row.kind !== "quiz" || !Number.isFinite(Number(r.quiz_id))) return "error";
  return {
    quiz_id: Number(r.quiz_id),
    checkpoint: String(r.checkpoint ?? ""),
    score: Number(r.score),
    total: Number(r.total),
    quiz_date: String(r.quiz_date ?? ""),
    passed: r.passed === true,
  };
}

/** The tool's answer for a quiz result; `replayed` = recorded by an earlier try, nothing recorded now. */
const quizReply = (q: StoredQuiz, replayed: boolean): string =>
  JSON.stringify({
    success: true,
    passed: q.passed,
    score: `${q.score}/${q.total}`,
    checkpoint: q.checkpoint,
    quiz_date: q.quiz_date,
    quiz_id: q.quiz_id,
    ...(replayed ? { replayed: true } : {}),
  });

/**
 * The reading session written under this operation id: its book, "none" (nothing under the key), "missing" (the key
 * column is not there: the write must be refused, never made without its key) or "error" (the read failed).
 */
async function sessionByKey(opId: string): Promise<{ book: number } | "none" | "missing" | "error"> {
  const { data, error } = await supabase.from("reading_sessions").select("book_id").eq("client_key", opId).maybeSingle();
  if (error) return error.code === "42703" || error.code === "PGRST204" || error.code === "42P01" ? "missing" : "error";
  const id = (data as { book_id?: unknown } | null)?.book_id;
  return typeof id === "number" ? { book: id } : "none";
}

/** What a session or highlight an earlier call wrote may lack, named on the receipt (nothing is written for it now). */
const FINISH_UNCONFIRMED = "The book is not marked finished, and Onyx did not change it now. Check /reading.";
const habitUnconfirmed = (day: string): string =>
  `Onyx cannot confirm a reading-habit Yes for ${day} and did not mark it now (it may have been cleared since). Check /habits.`;
const NOTION_UNCONFIRMED =
  "No Notion entry is recorded for it, and Onyx made none now: an earlier try may have made one. Check the book's Notion page.";

/**
 * A session or highlight an earlier call wrote that has no Notion block id stored: that call may have appended the entry
 * and stopped before storing the id. The book's page is searched (read-only) for that exact entry: exactly one unclaimed
 * match is adopted (its id is stored on the row, only while the row still has none) and nothing is named for Riley to
 * check; no match, or several, stays unconfirmed. An entry is never made here, so a stopped try cannot be repeated into
 * a second one. Returns the lines to name on the receipt.
 */
async function notionUnconfirmed(kind: "session" | "highlight", book: Book, row: ReadingSession | Highlight): Promise<string[]> {
  if (row.notion_block_id) return [];
  try {
    const table = kind === "session" ? "reading_sessions" : "book_highlights";
    const idColumn = kind === "session" ? "session_id" : "highlight_id";
    const rowId = kind === "session" ? (row as ReadingSession).session_id : (row as Highlight).highlight_id;
    const { data, error } = await supabase.from(table).select("notion_block_id").eq("book_id", book.book_id).not("notion_block_id", "is", null);
    if (error || !Array.isArray(data)) return [NOTION_UNCONFIRMED];
    const claimed = new Set((data as Array<{ notion_block_id: string | null }>).flatMap((r) => (r.notion_block_id ? [r.notion_block_id] : [])));
    const id = await findMirroredEntry(book, kind, row, claimed);
    if (!id) return [NOTION_UNCONFIRMED];
    const { data: stored, error: storeError } = await supabase.from(table).update({ notion_block_id: id }).eq(idColumn, rowId).is("notion_block_id", null).select(idColumn);
    if (storeError || !Array.isArray(stored) || stored.length === 0) return [NOTION_UNCONFIRMED];
    row.notion_block_id = id;
    return [];
  } catch {
    // Whatever cannot be read leaves it unconfirmed, as before.
    return [NOTION_UNCONFIRMED];
  }
}

/**
 * A session an EARLIER call wrote (an earlier try of the message, or an earlier call of this try) and that stopped
 * before the ledger recorded it. Whether that call also finished the book, stamped the habit and made the Notion entry
 * cannot be told from what is stored, and Riley may have changed any of them since (a habit answer cleared on purpose
 * would come back with a new stamp, which no conflict rule can stop). So nothing is written: what is there now is
 * reported, and each step that shows nothing is named for Riley to check.
 */
async function inspectReplayedSession(book: Book, session: ReadingSession): Promise<{ habitMarked: boolean; unconfirmed: string[] }> {
  const unconfirmed: string[] = [];
  const total = book.total_chapters;
  if (total && (session.chapter_through ?? 0) >= total && book.status !== "finished") unconfirmed.push(FINISH_UNCONFIRMED);
  let habitMarked = false;
  if (book.habit_name) {
    const { data, error } = await supabase
      .from("habit_journal")
      .select("answer")
      .eq("cycle_date", session.session_date)
      .eq("question", book.habit_name)
      .maybeSingle();
    habitMarked = !error && (data as { answer?: unknown } | null)?.answer === "Yes";
    if (!habitMarked) unconfirmed.push(habitUnconfirmed(session.session_date));
  }
  unconfirmed.push(...(await notionUnconfirmed("session", book, session)));
  return { habitMarked, unconfirmed };
}

/**
 * The steps logSession takes after its insert, for a session THIS call's own insert wrote (no session carried the key
 * when the call began) and whose answer was lost: logSession returned before any of them, so none of them happened.
 * The book is marked finished when the session reached its last chapter and it is not finished yet, and the book's
 * habit gets a Yes for the session day only when that day has no answer for it at all. The stamp is one insert that
 * does nothing on a conflict (never a read, then a write), so an answer given meanwhile is never changed.
 */
async function completeReplayedSession(book: Book, session: ReadingSession): Promise<{ book: Book; finished: boolean; habitMarked: boolean }> {
  let current = book;
  let finished = false;
  const total = book.total_chapters;
  if (total && (session.chapter_through ?? 0) >= total && book.status !== "finished") {
    const { data, error } = await supabase
      .from("books")
      .update({ status: "finished", finished_on: session.session_date })
      .eq("book_id", book.book_id)
      .neq("status", "finished")
      .select("book_id");
    if (!error && Array.isArray(data) && data.length > 0) {
      finished = true;
      current = { ...book, status: "finished", finished_on: session.session_date };
    }
  }
  let habitMarked = false;
  if (book.habit_name) {
    // INSERT ... ON CONFLICT DO NOTHING: a row for that day (Yes, No, given before or since) is left as it is.
    const { error: stampError } = await supabase
      .from("habit_journal")
      .upsert(
        { cycle_date: session.session_date, question: book.habit_name, category: "learning", answer: "Yes" },
        { onConflict: "cycle_date,question", ignoreDuplicates: true },
      );
    if (!stampError) {
      // What the day holds now (written by this insert, by the earlier try, or by Riley): reported, never changed.
      const { data: now, error } = await supabase
        .from("habit_journal")
        .select("answer")
        .eq("cycle_date", session.session_date)
        .eq("question", book.habit_name)
        .maybeSingle();
      habitMarked = !error && (now as { answer?: unknown } | null)?.answer === "Yes";
    }
  }
  return { book: current, finished, habitMarked };
}

/* ---- Reading question bank tools: input checks and the words the model gets back (codes only, never text) ---- */

const BANK_MODES = ["due", "chapter", "weak"] as const;
type BankMode = (typeof BANK_MODES)[number];
const BANK_VERDICTS = ["correct", "partial", "incorrect"] as const;
type BankVerdict = (typeof BANK_VERDICTS)[number];

const BANK_OFF =
  "The question bank is off for this book, so there are no bank questions to ask. Say so, and offer the free quiz instead (get_reading_status, then record_reading_quiz; Onyx shows that result as unverified). The bank is turned on with one tap on /reading.";

const BANK_UNAVAILABLE =
  "The question bank is not available yet, so there are no bank questions to ask. Say so, and offer the free quiz instead (get_reading_status, then record_reading_quiz; Onyx shows that result as unverified).";

/**
 * Why get_reading_questions has nothing to ask: no chapter is quizzable yet, the chapter asked for is past the gate
 * (it names only the chapter numbers, never what the chapter holds), or nothing is ready for this request.
 */
function noQuestionsMessage(chapter: number | null, quizThrough: number): string {
  if (quizThrough < 1) return "No chapter is quizzable yet: a chapter unlocks once the next one is reached, they log through it, or the book is finished.";
  if (chapter !== null && chapter > quizThrough) {
    return `Chapter ${chapter} is not quizzable yet: questions are open through chapter ${quizThrough} (a chapter unlocks once the next one is reached, they log through it, or the book is finished). Say so, and do not quiz them on it from memory.`;
  }
  return "No questions are ready for this request: nothing is due, everything was answered today, or this chapter's questions are still being built.";
}

/** get_reading_questions input → questionsForChat's, or a message for the model. */
function parseQuestionsInput(input: Record<string, unknown>): { book: string | null; chapter: number | null; mode: BankMode; count: number } | { error: string } {
  const book = typeof input.book === "string" && input.book.trim() ? input.book.trim() : null;
  if (book !== null && !SLUG_RE.test(book)) return { error: "Unknown book: omit book for the active book." };
  const mode = (input.mode ?? "due") as BankMode;
  if (!BANK_MODES.includes(mode)) return { error: "mode must be due, chapter or weak" };
  const chapter = input.chapter == null || input.chapter === "" ? null : Number(input.chapter);
  if (chapter !== null && !(Number.isInteger(chapter) && chapter >= 0 && chapter <= 100000)) return { error: "chapter must be a chapter number" };
  if (mode === "chapter" && chapter === null) return { error: "mode 'chapter' needs the chapter number" };
  const n = input.count == null ? 5 : Math.trunc(Number(input.count));
  const count = Number.isFinite(n) ? Math.max(1, Math.min(CHAT_QUESTIONS_MAX, n)) : 5;
  return { book, chapter, mode, count };
}

/** record_reading_answer input → recordChatAnswer's (without the tool_use id), or a message for the model. */
function parseAnswerInput(input: Record<string, unknown>): { question_id: number; version: number; answer: string; verdict: BankVerdict; feedback: string | null } | { error: string } {
  const questionId = Number(input.question_id);
  const version = Number(input.version);
  if (!Number.isInteger(questionId) || questionId < 1 || !Number.isInteger(version) || version < 1) {
    return { error: "question_id and version must be the numbers from get_reading_questions" };
  }
  // Kept exactly as given (no trim): the answer is the user's own words.
  if (typeof input.answer !== "string" || !input.answer.trim()) return { error: "answer is required: pass the user's answer verbatim" };
  const verdict = input.verdict as BankVerdict;
  if (!BANK_VERDICTS.includes(verdict)) return { error: "verdict must be correct, partial or incorrect" };
  const feedback = typeof input.feedback === "string" && input.feedback.trim() ? input.feedback.trim() : null;
  return { question_id: questionId, version, answer: input.answer, verdict, feedback };
}

function bankReadError(code: string): Record<string, unknown> {
  if (code === "bank_unavailable") return { error: "The question bank is not set up yet.", bank: "unavailable", message: BANK_UNAVAILABLE };
  if (code === "book_not_found") return { error: "No book in progress (or no book with that slug). For a finished book, pass its slug as book: the reading sentence names the most recently finished one." };
  if (code === "bad_request") return { error: "That request is not valid: check mode and chapter." };
  return { error: "The question bank could not be read right now. Say so, and do not invent questions.", code };
}

function answerRefusal(code: string): string {
  switch (code) {
    case "question_changed": return "This question changed since you read it, so the answer was not recorded. Call get_reading_questions again and use the current question_id and version.";
    case "bank_off": return "The question bank is off for this book, so the answer was not recorded.";
    case "locked": return "That chapter is not unlocked, so the answer was not recorded.";
    case "retired": return "That question was retired after a correction, so the answer was not recorded.";
    case "not_found": return "There is no such question, so the answer was not recorded.";
    case "bad_answer": return "The answer is empty or longer than 4000 characters, so it was not recorded.";
    case "bank_unavailable": return "The question bank is not set up yet, so the answer was not recorded.";
    case "key_reused": return "A different answer is already stored under this call's key, so this one was not recorded. Do not record it again.";
    case "bad_order": return "That reply is not an order of the steps (each step number you listed once, or every step written out one per line), so nothing was recorded. Ask them again for the order as the numbers of the steps you listed, and record that reply.";
    case "unreadable": return "The question could not be read right now, so the answer was not recorded. Try record_reading_answer once more.";
    default: return `The answer was not recorded (${code}).`;
  }
}

function flagRefusal(code: string): string {
  switch (code) {
    case "locked": return "That question's chapter is not unlocked, so it was not flagged.";
    case "question_changed": return "That question has changed since you read it, so it was not flagged. Call get_reading_questions again.";
    case "not_found": return "There is no such question, so nothing was flagged.";
    case "bank_unavailable": return "The question bank is not set up yet, so nothing was flagged.";
    case "key_reused": return "A different flag is already stored under this call's key, so this one was not saved. Do not flag it again.";
    case "unchecked": return "Onyx could not check that question's chapter right now, so nothing was flagged. Try flag_reading_question once more.";
    default: return `The question was not flagged (${code}).`;
  }
}

/**
 * What a key lookup after a failed write found: this request's own row (`found`), nothing, a row that holds another
 * request (`conflict`: never reported as this request's write), or no answer (`unknown`).
 */
type Lookup<T> = ({ state: "found" } & T) | { state: "absent" } | { state: "conflict" } | { state: "unknown" };

/**
 * After a failed record_reading_answer: is THIS answer stored under its key? The row counts only when it is this
 * request (the same question, the chat round of this tool call, the same answer text as given: every answer is stored
 * verbatim, an order answer too); a row under the key that holds anything else is a conflict, and an answer
 * text already cleared cannot be compared (unknown). A 503 means the bank's SQL is not applied, so nothing can have
 * been written (and the read would fail too). The question's chapter comes with it, for the receipt.
 */
async function storedChatAnswer(
  keyId: string,
  request: { question_id: number; answer: string },
  status: number,
): Promise<Lookup<{ grading_status: string; verdict: string | null; chapter: number | null }>> {
  if (status === 503) return { state: "absent" };
  try {
    const { data, error } = await supabase
      .from("reading_question_attempts")
      .select("question_id,round_key,round_kind,answer,grading_status,verdict,reading_questions(bank_chapter)")
      .eq("attempt_key", chatAttemptKey(keyId))
      .maybeSingle();
    if (error) return { state: "unknown" };
    if (!data) return { state: "absent" };
    const row = data as { question_id?: unknown; round_key?: unknown; round_kind?: unknown; answer?: unknown; grading_status?: unknown; verdict?: unknown; reading_questions?: unknown };
    const sameRound = typeof row.round_key === "string" && row.round_key.toLowerCase() === chatRoundKey(keyId).toLowerCase();
    if (Number(row.question_id) !== request.question_id || row.round_kind !== "chat" || !sameRound) return { state: "conflict" };
    if (typeof row.answer !== "string") return { state: "unknown" };
    if (row.answer !== request.answer) return { state: "conflict" };
    const q = (Array.isArray(row.reading_questions) ? row.reading_questions[0] : row.reading_questions) as { bank_chapter?: unknown } | null | undefined;
    const chapter = q && Number.isInteger(q.bank_chapter) ? (q.bank_chapter as number) : null;
    return { state: "found", grading_status: String(row.grading_status ?? ""), verdict: typeof row.verdict === "string" ? row.verdict : null, chapter };
  } catch {
    return { state: "unknown" };
  }
}

/**
 * The same check for a flag, by its flag_key: it counts only when it is via chat with the same kind and flags the
 * same question. pds.reading_bank_flag acts on a question's CURRENT version (a superseded id sent is redirected) and
 * stores that version's id, so a row on another id counts when both ids are versions of one question (question_key).
 */
async function storedChatFlag(
  flagKey: string,
  request: { question_id: number; kind: FlagKind },
  status: number,
): Promise<Lookup<{ kind: string; invalidated: number }>> {
  if (status === 503) return { state: "absent" };
  try {
    const { data, error } = await supabase.from("reading_question_flags").select("question_id,kind,via,invalidated_attempts").eq("flag_key", flagKey).maybeSingle();
    if (error) return { state: "unknown" };
    if (!data) return { state: "absent" };
    const row = data as { question_id?: unknown; kind?: unknown; via?: unknown; invalidated_attempts?: unknown };
    if (row.kind !== request.kind || row.via !== "chat") return { state: "conflict" };
    const storedId = Number(row.question_id);
    if (storedId !== request.question_id) {
      const same = await sameQuestion(storedId, request.question_id);
      if (same === null) return { state: "unknown" };
      if (!same) return { state: "conflict" };
    }
    return { state: "found", kind: String(row.kind), invalidated: Number(row.invalidated_attempts) || 0 };
  } catch {
    return { state: "unknown" };
  }
}

/** Whether two question ids are versions of one question (the same question_key); null when that cannot be read. */
async function sameQuestion(a: number, b: number): Promise<boolean | null> {
  if (!Number.isInteger(a) || a < 1) return false;
  const { data, error } = await supabase.from("reading_questions").select("question_id,question_key").in("question_id", [a, b]);
  if (error || !Array.isArray(data)) return null;
  const key = (id: number) => (data as { question_id?: unknown; question_key?: unknown }[]).find((r) => Number(r.question_id) === id)?.question_key;
  const ka = key(a);
  const kb = key(b);
  return typeof ka === "string" && ka === kb;
}

/**
 * "Not read yet" holds a chapter back (pds.reading_bank_flag sets the hold to that question's chapter and checks no
 * lock for it), so the chat sends it only for a question the gate would serve now: a question id the model did not
 * get from get_reading_questions (one of a chapter already held back) must not move an existing hold later. Null =
 * could not be checked (nothing is sent then). A question that does not exist is left to the flag (404 not_found).
 * This is a pre-check, not the guard: it and the flag write are separate requests, so another flag can land between
 * them. The authority is pds.reading_bank_flag, which runs under its advisory lock; when it answers `locked` the chat
 * reports "not flagged" and never success (the flag is not looked up as saved, flagRefusal("locked")).
 */
async function servedByGate(questionId: number): Promise<boolean | null> {
  try {
    const { data, error } = await supabase.from("reading_questions").select("book_id,unlock_chapter").eq("question_id", questionId).maybeSingle();
    if (error) return null;
    if (!data) return true;
    const q = data as { book_id?: unknown; unlock_chapter?: unknown };
    const through = await supabase.rpc("reading_bank_quiz_through", { p_book: Number(q.book_id) });
    if (through.error || through.data == null || !Number.isFinite(Number(through.data))) return null;
    return Number(q.unlock_chapter) <= Number(through.data);
  } catch {
    return null;
  }
}

/**
 * An order question's steps as the chat shows them when it asks: the reference steps in a fixed shuffled order (seeded
 * by the question id), never the right order. The reference keeps the right order; the model is told never to show it
 * before the answer. The seed is the question id alone, never the day: record_reading_answer maps the user's numbers
 * back through this same list (orderAnswer), and the chat's tool results do not survive to the next message, so a
 * list that changed at the 06:00 rollover between asking and answering would grade the answer against the wrong steps.
 */
function stepsToShow(steps: readonly string[], seed: number): string[] {
  const out = [...steps];
  let a = (Math.trunc(seed) >>> 0) ^ 0x9e3779b9;
  const random = () => {
    // mulberry32
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  // A shuffle that came out in the right order is turned by one place (with 2+ distinct steps that always differs).
  if (out.length > 1 && out.every((step, i) => step === steps[i])) out.push(out.shift()!);
  return out;
}

/** A bank question as the model gets it: an order question also carries the shuffled steps to show when asking. */
function chatQuestionOut(q: ChatQuestion): ChatQuestion & { steps_to_show?: string[] } {
  const steps = q.format === "order" ? q.reference.steps : undefined;
  if (!Array.isArray(steps) || !steps.every((x) => typeof x === "string")) return q;
  return { ...q, steps_to_show: stepsToShow(steps as string[], q.question_id) };
}

/**
 * An order reply read for the code grade: the steps one per line in the user's order (the form gradeLocal reads). It is
 * only what the grade reads: the reply itself is what is stored (record_reading_answer keeps the user's own words,
 * qualifications and "no idea" included). The numbers refer to steps_to_show, the shuffle get_reading_questions showed
 * (from the question id, so it is the same list here); the steps written out one per line are taken as they are;
 * "I don't know" is the app's DONT_KNOW_ANSWER. Null = the reply is not an order of the steps.
 */
function orderAnswer(reply: string, steps: string[], questionId: number): string | null {
  if (isDontKnow(reply)) return DONT_KNOW_ANSWER;
  const n = steps.length;
  // Written out: every line is one of the steps (a leading "1." or "2)" is dropped), each step once.
  const byText = new Map(steps.map((step) => [normalizeAnswer(step), step]));
  const lines = reply.split(/\r?\n/).map((l) => l.replace(/^\s*\d+\s*[.):-]\s*/, "")).filter((l) => l.trim());
  const written = lines.map((l) => byText.get(normalizeAnswer(l)));
  if (byText.size === n && lines.length === n && written.every((w) => w !== undefined) && new Set(written).size === n) {
    return orderAnswerText(written as string[]);
  }
  // The numbers of the listed steps: "3 1 4 2", "3, 1, 4, 2", "3-1-4-2" or "3142".
  let nums: string[] = [...(reply.match(/\d+/g) ?? [])];
  if (nums.length === 1 && nums[0].length === n) nums = nums[0].split("");
  const picks = nums.map(Number);
  if (picks.length !== n || new Set(picks).size !== n || !picks.every((i) => Number.isInteger(i) && i >= 1 && i <= n)) return null;
  const shown = stepsToShow(steps, questionId);
  return orderAnswerText(picks.map((i) => shown[i - 1]));
}

/**
 * What record_reading_answer needs to know about a question before it writes: whether it is an order question (its
 * steps and chapter), another bank question, or none (`undefined`: the write answers not_found). Read server-side
 * only; nothing of it reaches the model. "unavailable" = the bank's SQL is not applied; "unreadable" = the read failed.
 */
async function answerShape(
  questionId: number,
): Promise<{ format: string | null; steps: string[] | null; chapter: number | null } | undefined | "unavailable" | "unreadable"> {
  try {
    const { data, error } = await supabase.from("reading_questions").select("format,rubric,bank_chapter").eq("question_id", questionId).maybeSingle();
    if (error) return ["42703", "42P01", "PGRST205"].includes(String((error as { code?: unknown }).code)) ? "unavailable" : "unreadable";
    if (!data) return undefined;
    const row = data as { format?: unknown; rubric?: unknown; bank_chapter?: unknown };
    const rubric = parseRubric(row.rubric);
    return {
      format: typeof row.format === "string" ? row.format : null,
      steps: rubric?.format === "order" ? rubric.steps : null,
      chapter: Number.isInteger(row.bank_chapter) ? (row.bank_chapter as number) : null,
    };
  } catch {
    return "unreadable";
  }
}

type AnswerInput = { question_id: number; version: number; answer: string; verdict: BankVerdict; feedback: string | null };

const MAY_BE_RECORDED = "Onyx could not confirm this answer and it may have been recorded. Do not record it again: tell the user to check /reading.";

/**
 * An order answer: the reply is read as an order of the steps (orderAnswer) for the code grade only, then recorded
 * through recordAttempt, which grades it in code and stores answer and grade in one transaction (round kind 'chat',
 * the keys from the tool_use id, so a replayed tool call is the same write). What is stored, and what the replay is
 * keyed on, is the reply as the user gave it (spec 12: "answer (verbatim)"): two different replies that read as the
 * same order are still two different answers, and the original wording is the primary record. The model's own verdict
 * is not used: the code grade is the one returned.
 */
async function recordOrderAnswer(parsed: AnswerInput, steps: string[] | null, chapter: number | null, keyId: string): Promise<string> {
  if (!steps || steps.length < 2) {
    return JSON.stringify({ error: "That order question cannot be graded, so nothing was recorded. Move on to the next question.", code: "bad_question" });
  }
  const asOrder = orderAnswer(parsed.answer, steps, parsed.question_id);
  if (asOrder === null) return JSON.stringify({ error: answerRefusal("bad_order"), code: "bad_order" });
  const r = await recordAttempt(supabase, {
    attempt_key: chatAttemptKey(keyId),
    question_id: parsed.question_id,
    version: parsed.version,
    round_key: chatRoundKey(keyId),
    round_date: null,
    round_kind: "chat",
    answer: parsed.answer,
    grade_answer: asOrder,
    hinted: false,
    response_ms: null,
    quiz_key: null,
  });
  const graded = (verdict: unknown, status: unknown, replayed: boolean) =>
    JSON.stringify({
      success: true,
      question_id: parsed.question_id,
      chapter,
      verdict: typeof verdict === "string" ? verdict : null,
      grading_status: String(status ?? ""),
      replayed,
      graded_by: "onyx",
    });
  if (r.status === 200 && r.body.success === true) return graded(r.body.verdict, r.body.grading_status, r.body.replayed === true);
  const code = typeof r.body.error === "string" ? r.body.error : "failed";
  if (code === "key_reused") return JSON.stringify({ error: answerRefusal(code), code });
  const found = await storedChatAnswer(keyId, parsed, r.status);
  if (found.state === "conflict") return JSON.stringify({ error: answerRefusal("key_reused"), code: "key_reused" });
  if (found.state === "found") return graded(found.grading_status === "graded" ? found.verdict : null, found.grading_status, false);
  if (found.state === "unknown" || failureMayHaveWritten(r)) return JSON.stringify({ error: MAY_BE_RECORDED, incomplete: true });
  return JSON.stringify({ error: answerRefusal(code), code });
}

/**
 * A cued or explain answer, graded by the chat model: recordChatAnswer stores it and writes that grade at once. When
 * the grade write fails after the answer was stored (a race, a lost response), the stored answer is looked up by its
 * key, and a pending one gets the chat's grade once more (the same tool call replayed: the stored answer, then the
 * grade write again). Only if that fails too does it stay for the bank's own grade job.
 */
async function recordGradedAnswer(parsed: AnswerInput, keyId: string): Promise<string> {
  const request = { ...parsed, tool_use_id: keyId };
  const r = await recordChatAnswer(supabase, request);
  if (r.ok) {
    return JSON.stringify({ success: true, question_id: parsed.question_id, chapter: r.chapter, verdict: r.verdict, grading_status: r.grading_status, replayed: r.replayed });
  }
  // The key already holds another request: a definite refusal, never confirmed by the lookup below.
  if (r.error === "key_reused") return JSON.stringify({ error: answerRefusal(r.error), code: r.error });
  // A failure after the answer was stored must not read as "not recorded": this answer is looked up by its key (and
  // checked to be this request) before anything is said about it.
  const stored = await storedChatAnswer(keyId, parsed, r.status);
  if (stored.state === "conflict") return JSON.stringify({ error: answerRefusal("key_reused"), code: "key_reused" });
  if (stored.state === "found") {
    if (stored.grading_status === "pending") {
      const again = await recordChatAnswer(supabase, request);
      if (again.ok && again.grading_status !== "pending") {
        // This call stored the answer, so it is a new write even though the second call replayed it.
        return JSON.stringify({
          success: true,
          question_id: parsed.question_id,
          chapter: again.chapter ?? stored.chapter,
          verdict: again.verdict,
          grading_status: again.grading_status,
          replayed: false,
        });
      }
    }
    return JSON.stringify({
      success: true,
      question_id: parsed.question_id,
      chapter: stored.chapter,
      verdict: stored.grading_status === "graded" ? stored.verdict : null,
      grading_status: stored.grading_status,
      replayed: false,
      ...(stored.grading_status === "pending"
        ? { note: "The answer is saved but your grade could not be stored; Onyx grades it later on its own, and that grade may differ from yours. Do not record it again." }
        : {}),
    });
  }
  if (stored.state === "unknown" || failureMayHaveWritten(r)) return JSON.stringify({ error: MAY_BE_RECORDED, incomplete: true });
  return JSON.stringify({ error: answerRefusal(r.error), code: r.error });
}

/**
 * One tool call. `callId` = the model's id for the call: the key of a question-bank write that runs without the replay
 * ledger (a request with no request_id); through the ledger the operation id is the key, so a retry finds its row.
 */
async function executeTool(name: string, input: Record<string, unknown>, op?: OpContext, callId?: string): Promise<string> {
  const opId = op?.id;
  const keyId = opId ?? callId;
  const days = (input.days as number) || 7;
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString().split("T")[0];

  // Tables queried by calendar_date
  const calendarDateTables: Record<string, string> = {
    query_daily_summary: "garmin_daily_summary",
    query_sleep: "garmin_sleep",
    query_hrv: "garmin_hrv",
    query_stress: "garmin_stress",
    query_training_status: "garmin_training_status",
    query_eight_sleep: "eight_sleep_trends",
  };

  // Tables queried by timestamp columns
  const timestampTables: Record<string, { table: string; timeCol: string; extra?: Record<string, unknown> }> = {
    query_activities: { table: "garmin_activities", timeCol: "start_time_local" },
    query_whoop_cycles: { table: "whoop_cycles", timeCol: "start_time" },
    query_whoop_recovery: { table: "whoop_recovery", timeCol: "created_at", extra: { score_state: "SCORED" } },
    query_whoop_sleep: { table: "whoop_sleep", timeCol: "start_time", extra: { is_nap: false, score_state: "SCORED" } },
    query_whoop_workouts: { table: "whoop_workouts", timeCol: "start_time" },
  };

  // Nutrition: daily macros (Cronometer→MFP COALESCE via the behavioral matrix)
  if (name === "query_nutrition") {
    const { data, error } = await supabase
      .from("daily_health_matrix_behavioral")
      .select(
        "calendar_date, nutrition_source, nutrition_calories, nutrition_protein_g, " +
          "nutrition_carbs_g, nutrition_fat_g, nutrition_fiber_g, nutrition_sugar_g, " +
          "nutrition_sodium_mg, nutrition_water_ml, nutrition_caffeine_mg, " +
          "caffeine_total_mg, caffeine_supplement_mg, caffeine_mg_at_bedtime, caffeine_to_bedtime_min"
      )
      .gte("calendar_date", sinceStr)
      .not("nutrition_calories", "is", null)
      .order("calendar_date", { ascending: false });
    if (error) return JSON.stringify({ error: error.message });
    return JSON.stringify(data ?? []);
  }

  // Nutrition: per-entry Cronometer food log
  if (name === "query_meals_log") {
    let q = supabase
      .from("cronometer_servings")
      .select(
        "calendar_date, event_time, meal_group, food_name, amount_raw, food_category, calories, protein_g, carbs_g, fat_g"
      )
      .order("calendar_date", { ascending: false })
      .order("serving_id", { ascending: false })
      .limit(Math.min((input.limit as number) ?? 100, 400));
    const date = input.date as string | undefined;
    if (date) q = q.eq("calendar_date", date);
    else q = q.gte("calendar_date", sinceStr);
    const { data, error } = await q;
    if (error) return JSON.stringify({ error: error.message });
    return JSON.stringify(data ?? []);
  }

  // Nutrition: meals logged from a plate photo (pds.photo_meals / pds.photo_meal_daily, sql/photo_meals.sql).
  // Read-only. Fail open (empty result with a note) while the schema file is not applied yet, like getNutrition's
  // photo add-on: a missing relation must not break a nutrition answer.
  if (name === "query_photo_meals") {
    const photoDays = Math.min(Math.max((input.days as number) || 14, 1), 90);
    const photoSince = new Date();
    photoSince.setDate(photoSince.getDate() - photoDays);
    const photoSinceStr = photoSince.toISOString().split("T")[0];
    // Photo rows only: the table also holds direct drink captures (capture_kind = 'drink', sql/direct_drink_capture.sql);
    // before that migration the column does not exist and every row is a photo (same pin/fallback as queries.ts).
    const photoQuery = (pin: boolean) => {
      const q = supabase
        .from("photo_meals")
        .select("meal_id, eaten_date, eaten_time, time_source, items, kcal, protein_g, carbs_g, fat_g, confidence")
        .gte("eaten_date", photoSinceStr);
      return (pin ? q.eq("capture_kind", "photo") : q)
        .order("eaten_date", { ascending: false })
        .order("meal_id", { ascending: false })
        .limit(200);
    };
    let meals = await photoQuery(true);
    if (meals.error && meals.error.code === "42703") meals = await photoQuery(false);
    const daily = await supabase
      .from("photo_meal_daily")
      .select("behavioral_date, meal_count, est_kcal, est_protein_g, est_carbs_g, est_fat_g")
      .gte("behavioral_date", photoSinceStr)
      .order("behavioral_date", { ascending: false });
    if (MISSING_SCHEMA.has(meals.error?.code ?? "") || MISSING_SCHEMA.has(daily.error?.code ?? "")) {
      return JSON.stringify({ meals: [], daily_totals: [], note: "Photo meals are not set up yet, so none exist." });
    }
    if (meals.error) return JSON.stringify({ error: meals.error.message });
    if (daily.error) return JSON.stringify({ error: daily.error.message });
    return JSON.stringify({ meals: meals.data ?? [], daily_totals: daily.data ?? [] });
  }

  // Nutrition: micronutrient totals (dietary + supplement + total per nutrient)
  if (name === "query_vitamins") {
    const { data, error } = await supabase
      .from("daily_micronutrient_totals")
      .select(CHAT_MICRONUTRIENT_COLS)
      .gte("onyx_behavioral_date", sinceStr)
      .order("onyx_behavioral_date", { ascending: false });
    if (error) return JSON.stringify({ error: error.message });
    return JSON.stringify(data ?? []);
  }

  // Nutrition: single-nutrient trend (dietary/supplement/total columns over time)
  if (name === "query_micronutrient_trend") {
    const nutrient = ((input.nutrient as string) ?? "").toLowerCase().trim();
    const trendDays = (input.days as number) || 30;
    const trendSince = new Date();
    trendSince.setDate(trendSince.getDate() - trendDays);
    const { data, error } = await supabase
      .from("daily_micronutrient_totals")
      .select(CHAT_MICRONUTRIENT_COLS)
      .gte("onyx_behavioral_date", trendSince.toISOString().split("T")[0])
      .order("onyx_behavioral_date", { ascending: false });
    if (error) return JSON.stringify({ error: error.message });
    const rows = (data ?? []) as Record<string, unknown>[];
    const cols = rows.length
      ? Object.keys(rows[0]).filter((c) => nutrient && c.includes(nutrient))
      : [];
    const series = rows.map((r) => {
      const o: Record<string, unknown> = { date: r.onyx_behavioral_date };
      for (const c of cols) o[c] = r[c];
      return o;
    });
    return JSON.stringify({ nutrient, matched_columns: cols, series });
  }

  // Spotify: search the full catalog
  if (name === "search_spotify_catalog") {
    try {
      const query = (input.query as string) ?? "";
      const limit = (input.limit as number) ?? 20;
      const tracks = await searchTracks(query, limit);
      return JSON.stringify(tracks);
    } catch (e) {
      return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
    }
  }

  // Spotify: query the user's track library by audio-feature ranges
  if (name === "query_spotify_tracks_by_features") {
    const limit = Math.min((input.limit as number) ?? 50, 200);
    let q = supabase
      .from("spotify_tracks")
      .select("track_id,name,artists,album,valence,energy,danceability,tempo,duration_ms")
      .not("features_source", "is", null)
      .limit(limit);
    const pairs: Array<[string, string, unknown]> = [
      ["min_valence", "gte", input.min_valence],
      ["max_valence", "lte", input.max_valence],
      ["min_energy", "gte", input.min_energy],
      ["max_energy", "lte", input.max_energy],
      ["min_danceability", "gte", input.min_danceability],
      ["max_danceability", "lte", input.max_danceability],
      ["min_tempo", "gte", input.min_tempo],
      ["max_tempo", "lte", input.max_tempo],
    ];
    const colMap: Record<string, string> = {
      min_valence: "valence", max_valence: "valence",
      min_energy: "energy", max_energy: "energy",
      min_danceability: "danceability", max_danceability: "danceability",
      min_tempo: "tempo", max_tempo: "tempo",
    };
    for (const [key, op, val] of pairs) {
      if (typeof val !== "number") continue;
      const col = colMap[key];
      if (op === "gte") q = q.gte(col, val);
      else q = q.lte(col, val);
    }
    const { data, error } = await q;
    if (error) return JSON.stringify({ error: error.message });
    // Flatten artists JSONB to a readable string for Claude
    const out = (data ?? []).map((r) => ({
      track_id: r.track_id,
      name: r.name,
      artists: Array.isArray(r.artists)
        ? r.artists.map((a: { name?: string }) => a?.name).filter(Boolean).join(", ")
        : null,
      album: (r.album as { name?: string } | null)?.name ?? null,
      valence: r.valence,
      energy: r.energy,
      danceability: r.danceability,
      tempo: r.tempo,
      duration_ms: r.duration_ms,
    }));
    return JSON.stringify(out);
  }

  // Spotify: create a private playlist
  if (name === "create_spotify_playlist") {
    try {
      const trackIds = input.track_ids as string[];
      const result = await createPlaylist({
        name: input.name as string,
        description: input.description as string | undefined,
        trackIds,
        isPublic: false,
        createdVia: "chat",
        // The audit row carries the operation id, so a retry can look the playlist up instead of creating another.
        ...(opId ? { clientKey: opId } : {}),
      });
      return JSON.stringify({ success: true, ...result });
    } catch (e) {
      // Read the message by shape, not instanceof: an Error from another realm (tests run this file in a vm) is still one.
      const message = typeof (e as { message?: unknown })?.message === "string" ? (e as { message: string }).message : String(e);
      // Only a failure from before Spotify was asked to create the playlist (bad arguments, no token, a 4xx on the
      // create call) is a clean "not created". Anything later, or a network error on the create call itself, may have
      // left a playlist on Spotify: report it as possibly done, so neither the model nor a retry creates a second one.
      if (PLAYLIST_NOT_CREATED.test(message)) return JSON.stringify({ error: message });
      return JSON.stringify({ error: PLAYLIST_MAYBE_CREATED, incomplete: true });
    }
  }

  // Handle self-reported behaviors (special: calendar_date + optional filters)
  if (name === "query_behaviors") {
    const journalDays = (input.days as number) || 30;
    const jSince = new Date();
    jSince.setDate(jSince.getDate() - journalDays);
    // Self-reported behavior rows live in habit_journal via the pds.journal
    // view (source='whoop'); pds.whoop_journal is a frozen archive.
    // Descending so the 200-row cap keeps the most RECENT entries (ascending
    // returned the oldest week of the window).
    let query = supabase.from("journal").select(CHAT_JOURNAL_COLS)
      .eq("source", "whoop")
      .gte("cycle_date", jSince.toISOString().split("T")[0])
      .order("cycle_date", { ascending: false })
      .limit(200);
    if (input.question) query = query.ilike("question", `%${input.question}%`);
    if (input.category) query = query.ilike("category", `%${input.category}%`);
    const { data, error } = await query;
    if (error) return JSON.stringify({ error: error.message });
    return JSON.stringify(data ?? []);
  }

  // Unified behavior journal (imported behaviors + habits)
  if (name === "query_journal") {
    const journalDays = (input.days as number) || 30;
    const jSince = new Date();
    jSince.setDate(jSince.getDate() - journalDays);
    // Descending so the 500-row cap keeps the most RECENT entries (the merged
    // table is ~12k rows; ascending returned only the oldest slice).
    let query = supabase.from("journal").select(CHAT_JOURNAL_COLS)
      .gte("cycle_date", jSince.toISOString().split("T")[0])
      .order("cycle_date", { ascending: false })
      .limit(500);
    if (input.source) query = query.eq("source", input.source as string);
    if (input.question) query = query.ilike("question", `%${input.question}%`);
    const { data, error } = await query;
    if (error) return JSON.stringify({ error: error.message });
    return JSON.stringify(data ?? []);
  }

  // Personal Notion journal — metadata filters + optional semantic search
  if (name === "query_journal_entries") {
    const limit = Math.min((input.limit as number) ?? 10, 25);
    const semantic = (input.semantic_query as string | undefined)?.trim();

    let queryEmbedding: number[] | null = null;
    if (semantic) {
      const voyageKey = process.env.VOYAGE_API_KEY;
      if (!voyageKey) {
        return JSON.stringify({ error: "VOYAGE_API_KEY not configured; semantic_query unavailable" });
      }
      try {
        const r = await fetch("https://api.voyageai.com/v1/embeddings", {
          method: "POST",
          headers: { Authorization: `Bearer ${voyageKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            input: [semantic],
            model: "voyage-3-large",
            input_type: "query",
            output_dimension: 1024,
          }),
        });
        if (!r.ok) {
          const t = await r.text();
          return JSON.stringify({ error: `Voyage embed failed: ${r.status} ${t.slice(0, 200)}` });
        }
        const data = await r.json();
        queryEmbedding = data.data?.[0]?.embedding ?? null;
      } catch (e) {
        return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
      }
    }

    const topics = Array.isArray(input.topics) ? (input.topics as string[]) : null;
    const { data, error } = await supabase.rpc("search_journal_entries", {
      query_embedding: queryEmbedding,
      date_from: (input.date_from as string) ?? null,
      date_to: (input.date_to as string) ?? null,
      mood_filter: (input.mood as string) ?? null,
      topic_filters: topics && topics.length > 0 ? topics : null,
      result_limit: limit,
    });
    if (error) return JSON.stringify({ error: error.message });

    type JournalRow = {
      notion_page_id: string;
      entry_date: string;
      title: string | null;
      mood: string | null;
      source: string | null;
      topics: string[] | null;
      content_md: string | null;
      word_count: number | null;
      similarity: number | null;
    };

    const out = (data ?? []).map((r: JournalRow) => ({
      notion_page_id: r.notion_page_id,
      entry_date: r.entry_date,
      title: r.title,
      mood: r.mood,
      source: r.source,
      topics: r.topics,
      word_count: r.word_count,
      similarity: r.similarity != null ? Number(r.similarity.toFixed(4)) : undefined,
      snippet: (r.content_md ?? "").slice(0, 600),
      truncated: (r.content_md ?? "").length > 600,
    }));
    return JSON.stringify(out);
  }

  // Record a habit answer — Yes (default) or explicit No (tri-state,
  // 2026-06-11). Writes to both Supabase and Notion.
  if (name === "mark_habit_complete") {
    const habit = input.habit as string;
    const category = (input.category as string) || null;
    const answer = (input.answer as string)?.toLowerCase() === "no" ? "No" : "Yes";

    // Default to the behavioral day (TZ + awake-tail aware) — the previous
    // naive-UTC default tagged late-evening ET logs with TOMORROW's date.
    let date = input.date as string | undefined;
    let storedFor: string | undefined;
    if (!date || SLEEP_QUESTIONS.has(habit)) {
      let today: string;
      const pinned = pinnedDate(op);
      if (pinned) {
        // A re-run of an operation that first ran on an earlier day: resolve against THAT day, so the answer lands on
        // the same day (and the same night) as the first try, never on a second one.
        today = pinned;
      } else {
        try {
          const { data: bday } = await supabase.rpc("behavioral_today_now");
          today = (bday as string) || fallbackBehavioralToday(new Date());
        } catch {
          today = fallbackBehavioralToday(new Date());
        }
      }
      if (SLEEP_QUESTIONS.has(habit)) {
        // A sleep question (mouth tape, same bed, ...) describes a finished night, and a night's answers live on
        // the behavior day it closed. "I wore mouth tape last night" with no date is therefore yesterday, never today.
        if (!date) date = sleepAnswerDate(today);
        const tonight = sleepDateError(habit, date, today, answer);
        if (tonight) return JSON.stringify({ error: tonight });
        storedFor = nightLabel(date, today).span;
      } else if (!date) {
        date = today;
      }
    }
    if (!date) return JSON.stringify({ error: "Could not work out the date." });

    // WHOOP-era rows (cycle_date <= 2026-06-08, the last WHOOP export) are a
    // frozen historical record carrying explicit Yes/No answers. A backdated
    // completion into that era would overwrite real history for WHOOP-derived
    // habits — reject it (post-merge guard, see sql/whoop_journal_merge.sql).
    const WHOOP_JOURNAL_FROZEN_THROUGH = "2026-06-08";
    const { data: mapRow } = await supabase
      .from("habit_name_map")
      .select("channel")
      .eq("habit_name", habit)
      .maybeSingle();
    const isWhoopChannel = mapRow?.channel === "whoop";
    if (isWhoopChannel && date <= WHOOP_JOURNAL_FROZEN_THROUGH) {
      return JSON.stringify({
        error: `"${habit}" has frozen historical entries through ${WHOOP_JOURNAL_FROZEN_THROUGH}; completions can only be logged for later dates.`,
      });
    }

    if (op?.check) {
      // An earlier try of this call may have written, and Riley may have answered the day differently since (or
      // cleared it, which deletes the row): read what is there and never write. The same answer = confirmed; any
      // other answer, or none, = unconfirmed. Notion's Last Completed is recomputed by the hourly habits sync.
      const { data: now, error: readError } = await supabase
        .from("habit_journal")
        .select("cycle_date,question,category,answer,notes")
        .eq("cycle_date", date)
        .eq("question", habit)
        .maybeSingle();
      if (readError || (now as { answer?: unknown } | null)?.answer !== answer) {
        return JSON.stringify({ error: HABIT_UNCONFIRMED, incomplete: true, uncertain: true });
      }
      return JSON.stringify({ success: true, entry: now, replayed: true, ...(storedFor ? { stored_for_night: storedFor } : {}) });
    }

    const { data, error } = await supabase
      .from("habit_journal")
      .upsert(
        {
          cycle_date: date,
          question: habit,
          category,
          answer,
          notes: answer === "Yes" ? "Completed via Claude chat" : "Marked not done via Claude chat",
        },
        { onConflict: "cycle_date,question" }
      )
      .select()
      .single();
    // Only a definite refusal (lib/write-outcome.ts: a code known to roll the statement back) wrote nothing. Any other
    // error, coded or not (08007 transaction_resolution_unknown, a lost connection, a code not on that list), may have
    // come after the commit: "may be saved, check first", so a retry only checks (op.check) instead of writing again.
    if (error) return JSON.stringify(ambiguousDbError(error) ? { error: HABIT_MAYBE_SAVED, incomplete: true } : { error: error.message });

    // Also update Notion "Last Completed"
    const notionKey = process.env.NOTION_API_KEY;
    const notionDb = process.env.NOTION_HABITS_DB || "29cc936fd5e14ae8b10a4fe5c5f7a6cd";
    if (notionKey) {
      try {
        const searchRes = await fetch(`https://api.notion.com/v1/databases/${notionDb}/query`, {
          method: "POST",
          headers: { Authorization: `Bearer ${notionKey}`, "Content-Type": "application/json", "Notion-Version": "2022-06-28" },
          body: JSON.stringify({ filter: { property: "Habit", title: { equals: habit } } }),
        });
        if (searchRes.ok) {
          const searchData = await searchRes.json();
          if (searchData.results.length > 0) {
            // Recompute Last Completed from the actual max completion (mirrors
            // /api/habits/complete) — direct-setting the supplied date moved
            // LC BACKWARD on backdated logs. Yes-only, and post-freeze-era
            // for WHOOP-derived habits.
            let lcQuery = supabase
              .from("habit_journal")
              .select("cycle_date")
              .eq("question", habit)
              .eq("answer", "Yes")
              .order("cycle_date", { ascending: false })
              .limit(1);
            if (isWhoopChannel) {
              lcQuery = lcQuery.gt("cycle_date", WHOOP_JOURNAL_FROZEN_THROUGH);
            }
            const { data: latest } = await lcQuery;
            const latestDate = latest?.[0]?.cycle_date ?? null;
            await fetch(`https://api.notion.com/v1/pages/${searchData.results[0].id}`, {
              method: "PATCH",
              headers: { Authorization: `Bearer ${notionKey}`, "Content-Type": "application/json", "Notion-Version": "2022-06-28" },
              body: JSON.stringify({ properties: { "Last Completed": { date: latestDate ? { start: latestDate } : null } } }),
            });
          }
        }
      } catch (e) {
        console.error("Notion sync from chat failed:", e);
      }
    }

    // For a sleep question, name the night it was stored for so the model can say it back and Riley can correct it.
    return JSON.stringify({ success: true, entry: data, ...(storedFor ? { stored_for_night: storedFor } : {}) });
  }

  // Log a whole supplement stack (writes one intake per item)
  // ---- Reading quest tools (lib/reading.ts) ----
  if (name === "get_reading_status") {
    try {
      const o = await getOverview(supabase, (input.book as string) || null);
      if (!o) return JSON.stringify({ error: "No book in progress" });
      return JSON.stringify(summarizeForChat(o));
    } catch (e) {
      return JSON.stringify({ error: e instanceof Error ? e.message : "failed" });
    }
  }

  if (name === "log_reading_session") {
    // Written by an earlier try of this operation and removed since: never written again.
    const gate = await removedGate(opId);
    if (gate) return gate;
    // A re-run of an operation that already wrote its session: name that session's book, so logSession finds it by
    // its key even when the book is no longer the one being read (it resolves the book before it checks the key).
    // Otherwise the book pinned when the operation first ran, so a re-run never logs to a book started since.
    const prior = opId ? await sessionByKey(opId) : "none";
    // The key column could not be read (missing, or the read failed): refuse. lib/reading.ts logSession writes a
    // session WITHOUT its key when the column is missing, which a retry could never find again (fail closed). A
    // refusal on a re-run is kept as "unconfirmed" by the ledger, never "not saved".
    if (prior === "missing" || prior === "error") return JSON.stringify({ error: KEY_UNAVAILABLE });
    // Check mode: only what the key already holds is reported; a session the earlier try never wrote is not written now.
    if (op?.check && prior === "none") return keyedUnconfirmed(name);
    const priorBook = typeof prior === "object" ? prior.book : null;
    const sessionInput = {
      ...(priorBook !== null ? { book_id: priorBook } : pinnedBook(op, input)),
      slug: (input.book as string) || null,
      date: (input.date as string) || pinnedDate(op),
      chapter_through: Number(input.chapter_through),
      chapter_from: input.chapter_from != null ? Number(input.chapter_from) : null,
      minutes: input.minutes != null ? Number(input.minutes) : null,
      medium: (input.medium as Medium) || null,
      recall: (input.recall as string) || null,
      question: (input.question as string) || null,
      source: "chat" as const,
      // The library's own idempotency key (sql/reading_sessions_client_key.sql): a retry gets the stored session back.
      // Required: logSession refuses rather than write the session without it (its key column missing, even after
      // the read above found it), because a retry could never find an unkeyed session again (fail closed).
      ...(opId ? { client_key: opId, require_client_key: true } : {}),
    };
    let result = await logSession(supabase, sessionInput);
    // The key could not go on the session: refused before anything was written.
    if (!result.ok && SESSION_KEY_REFUSED.test(result.error)) return JSON.stringify({ error: KEY_UNAVAILABLE });
    if (!result.ok && opId && !SESSION_NOT_WRITTEN.test(result.error)) {
      // The insert failed in a way that may have committed (its answer lost on the way): find it by its key.
      const found = await sessionByKey(opId);
      if (typeof found === "object") result = await logSession(supabase, { ...sessionInput, book_id: found.book });
    }
    if (!result.ok) {
      // A refusal wrote nothing; a failed insert may have committed: never "not logged".
      return JSON.stringify(SESSION_NOT_WRITTEN.test(result.error) ? { error: result.error } : { error: SESSION_MAYBE_WRITTEN, incomplete: true });
    }
    // A replay (same client_key): the session exists under this operation id. Two cases:
    //  - this very call wrote it: no session carried the key when the call began (`prior` "none"), its own insert
    //    committed and the answer was lost, so logSession stopped before the book finish, the habit stamp and the
    //    Notion entry. They are done now, each only when still missing. (One try at a time: no other try runs.)
    //  - an earlier call wrote it (`prior` held it): whether that call also did those steps cannot be told, and Riley
    //    may have undone one since (a cleared habit answer). Read only: what is there is reported, nothing written.
    const replayed = result.replayed === true;
    const ownInsert = replayed && prior === "none";
    const completed = ownInsert ? await completeReplayedSession(result.book, result.session) : null;
    const inspected = replayed && !ownInsert ? await inspectReplayedSession(result.book, result.session) : null;
    const book = completed?.book ?? result.book;
    const finished = completed ? completed.finished : inspected ? false : result.finished;
    const habitMarked = completed ? completed.habitMarked : inspected ? inspected.habitMarked : result.habitMarked;
    // Mirror inline (the chat loop has no after() boundary worth protecting). An earlier call's session with no block
    // id stored may still have its Notion entry (the call can stop between the append and storing the id), so none is
    // made for it now: inspectReplayedSession names it for Riley to check instead.
    // A keyed create stored the claim that owes this entry in its own transaction (pds.create_reading_session; Codex
    // review of PR 376, round 2 of T01-R14): the entry is written under it and attached conditionally, so a write whose
    // block id is lost is still found by its marker, and an entry this call never writes is written by the sweep. For
    // this call's own insert replayed (its answer lost) the claim is looked up; none found = written as before.
    const entryClaim =
      result.session.notion_block_id || inspected
        ? null
        : (result.mirrorClaimId ?? (ownInsert ? await createEntryClaimOf(supabase, result.session.session_id, result.session.book_id) : null));
    let blockId: string | null = result.session.notion_block_id ?? null;
    if (entryClaim === "error") {
      // The claim that owes this entry could not be looked up: nothing is written now (an entry with no claim to find
      // it would be an orphan); the claim, if there is one, is written by the sweep (Codex review of PR 376, round 3).
    } else if (!blockId && !inspected && entryClaim) {
      const placed = await placeEntry(supabase, book, result.session, null, entryClaim);
      if (placed.kind === "attached") blockId = placed.blockId;
      else if (placed.kind === "gone") await discardEntry(supabase, placed.blockId, placed.claimId);
    } else if (!blockId && !inspected) {
      // No stored claim: placeEntry stores one before it writes (a marked entry the sweep can find, attached
      // conditionally), and writes best effort only while the claims table does not exist.
      const placed = await placeEntry(supabase, book, result.session, null);
      if (placed.kind === "attached") blockId = placed.blockId;
      else if (placed.kind === "gone") await discardEntry(supabase, placed.blockId, placed.claimId);
    }
    const o = await getOverview(supabase, book.slug).catch(() => null);
    // Rewrites one progress line in Notion: the same text when it is already up to date. Not for an earlier call's
    // session (read only): its date could put an older "last session" over a newer one written since. Under the
    // obligation a keyed create stored, written from the database and checked (rewriteProgressNow).
    // A replay has no stored obligation: rewriteProgressNow stores its own before it writes, never an untracked write.
    if (!inspected) await rewriteProgressNow(supabase, book.book_id, result.progressOwedId ?? null);
    return JSON.stringify({
      success: true,
      book: book.title,
      session_date: result.session.session_date,
      chapter_from: result.session.chapter_from,
      chapter_through: result.session.chapter_through,
      minutes: result.session.minutes,
      medium: result.session.medium,
      recall_chars: (result.session.recall ?? "").length,
      habit: habitMarked ? book.habit_name : null,
      xp_gained: result.xpGained,
      finished,
      habit_marked: habitMarked,
      chapters_done: o?.chaptersDone,
      total_chapters: o?.totalChapters,
      pace: o?.pace,
      streak: o?.streak,
      level: o?.level,
      notion_mirrored: !!blockId,
      ...(replayed ? { replayed: true } : {}),
      // Steps an earlier call may or may not have done, not done now: tell the user each one.
      ...(inspected && inspected.unconfirmed.length > 0 ? { unconfirmed: inspected.unconfirmed } : {}),
    });
  }

  if (name === "add_book_highlight") {
    const highlightInput = {
      // The book pinned when the operation first ran (a call that names no book): a re-run stays on it.
      ...pinnedBook(op, input),
      slug: (input.book as string) || null,
      passage: String(input.passage ?? ""),
      comment: (input.comment as string) || null,
      chapter: input.chapter != null ? Number(input.chapter) : null,
      concept: (input.concept as string) || null,
      source: (input.source as HighlightSource) || null,
      // A re-run on a later day schedules the first review from the day the highlight was first sent.
      ...(pinnedDate(op) ? { date: pinnedDate(op) } : {}),
    };
    if (opId) {
      // The highlight this operation created, found by its key: an earlier try made it and stopped before the ledger
      // recorded it. It is that earlier write, whatever was edited since (its passage included), so nothing is written
      // to it now, its Notion entry included (below). Removed (archived) since: never written again. A key column that
      // cannot be read: refused, never written without its key.
      const own = await highlightByKey(opId);
      if (own === "missing" || own === "error") return JSON.stringify({ error: KEY_UNAVAILABLE });
      if (own !== "none") {
        if (own.highlight.archived) return REMOVED_RESULT;
        // Its Notion entry: an earlier call can stop between the append and storing the block id, so a missing id does
        // not prove there is no entry; none is made now, and the receipt names it for Riley to check.
        return highlightReply(own.book, own.highlight, {
          created: true,
          replayed: true,
          mirrorNow: false,
          unconfirmed: await notionUnconfirmed("highlight", own.book, own.highlight),
        });
      }
    }
    let checked: { book: Book; highlight: Highlight } | null = null;
    let insertOnly = false;
    if (op?.check) {
      // No highlight carries this operation's key, so the earlier try created none. It may still have changed one that
      // already had this passage (addHighlight then updates it), and Riley may have edited that one since: addHighlight
      // would write this call's comment / chapter / concept over the edit. So the highlight with this passage is only
      // confirmed when it is what the call asked for, and a new one is written only when no highlight of the book
      // changed since the operation began (nothing the earlier try could have changed exists, renamed or not).
      const found = await highlightFor(highlightInput);
      if (found === "no_book") return JSON.stringify({ error: "No active book found" });
      if (found === "no_passage") return JSON.stringify({ error: "passage is required" });
      if (found === "error") return JSON.stringify({ error: HIGHLIGHT_UNCONFIRMED, incomplete: true, uncertain: true });
      if (found.highlight) {
        if (!highlightMatches(found.highlight, highlightInput)) return JSON.stringify({ error: HIGHLIGHT_UNCONFIRMED, incomplete: true, uncertain: true });
        checked = { book: found.book, highlight: found.highlight };
      } else if ((await highlightsChangedSince(found.book.book_id, op.startedAt)) !== false) {
        return JSON.stringify({ error: HIGHLIGHT_UNCONFIRMED, incomplete: true, uncertain: true });
      } else {
        // Nothing to confirm and nothing the earlier try could have changed: the highlight is created now, but only
        // by one insert (never addHighlight's update of an existing passage). A highlight with this passage written
        // between the reads above and that insert (by Riley, the Kindle harvester or anything else) is left exactly
        // as it is: confirmed when it is what the call asked for, otherwise unconfirmed.
        insertOnly = true;
      }
    }
    if (checked) return highlightReply(checked.book, checked.highlight, { created: false, replayed: true, mirrorNow: false });
    // The operation id goes on a highlight this call creates (lib/reading.ts addHighlight), so a retry finds it.
    const result = await addHighlight(supabase, { ...highlightInput, ...(opId ? { client_key: opId } : {}), ...(insertOnly ? { insert_only: true } : {}) });
    if (!result.ok && result.error === HIGHLIGHT_EXISTS) {
      // insert_only lost the race to another write of this passage: read it, never change it.
      const now = await highlightFor(highlightInput);
      if (now !== "no_book" && now !== "no_passage" && now !== "error" && now.highlight && highlightMatches(now.highlight, highlightInput)) {
        return highlightReply(now.book, now.highlight, { created: false, replayed: true, mirrorNow: false });
      }
      return JSON.stringify({ error: HIGHLIGHT_UNCONFIRMED, incomplete: true, uncertain: true });
    }
    if (!result.ok) {
      // A refusal wrote nothing; a failed write may have committed, so the model and the receipt must not read it as
      // "not saved" (a retry then finds it by its key, or re-runs it in check mode, which never overwrites).
      return JSON.stringify(HIGHLIGHT_NOT_WRITTEN.test(result.error) ? { error: result.error } : { error: HIGHLIGHT_MAYBE_WRITTEN, incomplete: true });
    }
    if (result.readBack) {
      // A copy of this same call wrote it: reported, its Notion entry not made now (that copy may have made it).
      return highlightReply(result.book, result.highlight, {
        created: true,
        replayed: true,
        mirrorNow: false,
        unconfirmed: await notionUnconfirmed("highlight", result.book, result.highlight),
      });
    }
    return highlightReply(result.book, result.highlight, { created: result.created, replayed: false, mirrorNow: result.created });
  }

  if (name === "record_reading_quiz") {
    // The operation id is the quiz's op_key (lib/reading.ts recordQuiz, sql/reading_practice_receipts.sql): the RPC
    // stores the result and its receipt in one transaction, and the same key answers that receipt again, so a re-run
    // after a lost answer never records a second attempt. The day is always the operation's own (sent on the first
    // run too), so a re-run after midnight carries the same payload and gets the stored receipt, not key_reused.
    if (op?.check && opId) {
      // Another call of this request wrote, or may have: only read back what this key stored, never record now.
      const stored = await quizByKey(opId);
      if (stored === "error") return keyedUnconfirmed(name);
      if (stored === "none") return keyedUnconfirmed(name);
      return quizReply(stored, true);
    }
    const result = await recordQuiz(supabase, {
      ...pinnedBook(op, input),
      slug: (input.book as string) || null,
      checkpoint: String(input.checkpoint ?? ""),
      score: Number(input.score),
      total: Number(input.total),
      notes: (input.notes as string) || null,
      ...(op ? { date: op.day, op_key: opId } : {}),
    });
    // A 500 may have committed (the answer was lost): never "not recorded" then (lib/reading-practice.ts). A retry
    // re-runs it under the same op_key, which answers the stored receipt if it did.
    if (!result.ok) {
      return JSON.stringify(failureMayHaveWritten(result)
        ? { error: "Onyx could not confirm this quiz result and it may have been recorded. Do not record it again: tell the user to check /reading first.", incomplete: true }
        : { error: result.error });
    }
    return quizReply({ quiz_id: result.quiz.quiz_id, checkpoint: result.quiz.checkpoint, score: result.quiz.score, total: result.quiz.total, quiz_date: result.quiz.quiz_date, passed: result.passed }, result.replayed);
  }

  // ---- Reading question bank (READ-QUIZ-01; lib/reading-recall-server.ts, every read through the SQL spoiler gate) ----
  // The bank's writes are keyed by the operation id (keyId): the attempt key, the round key and the flag key are derived
  // from it, so a retry that re-runs the call finds what an earlier try stored. They go through the ledger with the other
  // write tools, after authorizeWrite (lib/chat-write-intent.ts: the reply to the question just asked, labelled Q<id>).
  if (name === "get_reading_questions") {
    const parsed = parseQuestionsInput(input);
    if ("error" in parsed) return JSON.stringify(parsed);
    const r = await questionsForChat(supabase, parsed);
    if (!r.ok) return JSON.stringify(bankReadError(r.error));
    // A bank turned off takes no answers (recordChatAnswer refuses them), so its questions are not offered either.
    if (!r.enabled) return JSON.stringify({ enabled: false, quiz_through: r.quiz_through, questions: [], message: BANK_OFF });
    return JSON.stringify({
      enabled: true,
      today: r.today,
      quiz_through: r.quiz_through,
      questions: r.questions.map(chatQuestionOut),
      ...(r.questions.length === 0 ? { message: noQuestionsMessage(parsed.chapter, r.quiz_through) } : {}),
    });
  }

  if (name === "record_reading_answer") {
    const parsed = parseAnswerInput(input);
    if ("error" in parsed) return JSON.stringify(parsed);
    if (!keyId) return JSON.stringify({ error: KEY_UNAVAILABLE });
    if (op?.check) {
      // Another call of this request wrote, or may have: only read back what this key stored, never record now.
      const stored = await storedChatAnswer(keyId, parsed, 200);
      if (stored.state !== "found") return keyedUnconfirmed(name);
      return JSON.stringify({
        success: true,
        question_id: parsed.question_id,
        chapter: stored.chapter,
        verdict: stored.grading_status === "graded" ? stored.verdict : null,
        grading_status: stored.grading_status,
        replayed: true,
      });
    }
    const shape = await answerShape(parsed.question_id);
    if (shape === "unavailable") return JSON.stringify({ error: answerRefusal("bank_unavailable"), code: "bank_unavailable" });
    if (shape === "unreadable") return JSON.stringify({ error: answerRefusal("unreadable"), code: "unreadable" });
    // An order answer is graded by code and stored with its grade in one transaction (pds.reading_bank_attempt's
    // local path, as the app's are), so it is never left pending: the grade job cannot grade an order answer.
    if (shape?.format === "order") return recordOrderAnswer(parsed, shape.steps, shape.chapter, keyId);
    return recordGradedAnswer(parsed, keyId);
  }

  if (name === "flag_reading_question") {
    const questionId = Number(input.question_id);
    const kind = input.kind as FlagKind;
    if (!Number.isInteger(questionId) || questionId < 1) return JSON.stringify({ error: "question_id must be the number from get_reading_questions" });
    if (!FLAG_KINDS.includes(kind)) return JSON.stringify({ error: `kind must be one of ${FLAG_KINDS.join(", ")}` });
    if (!keyId) return JSON.stringify({ error: KEY_UNAVAILABLE });
    const flagKey = chatFlagKey(keyId);
    if (op?.check) {
      // Another call of this request wrote, or may have: only read back what this key stored, never flag now.
      const stored = await storedChatFlag(flagKey, { question_id: questionId, kind }, 200);
      if (stored.state !== "found") return keyedUnconfirmed(name);
      return JSON.stringify({ success: true, question_id: questionId, kind: stored.kind, invalidated: stored.invalidated, replayed: true });
    }
    if (kind === "not_read_yet") {
      const served = await servedByGate(questionId);
      if (served === null) return JSON.stringify({ error: flagRefusal("unchecked"), code: "unchecked" });
      if (!served) {
        // Already held back: by this very flag (a replay of this tool call answers as one), or it was never served.
        const mine = await storedChatFlag(flagKey, { question_id: questionId, kind }, 200);
        if (mine.state === "found") return JSON.stringify({ success: true, question_id: questionId, kind: mine.kind, invalidated: mine.invalidated, replayed: true });
        return JSON.stringify({ error: flagRefusal("locked"), code: "locked" });
      }
    }
    const r = await flagQuestion(supabase, { restore: false, flag_key: flagKey, question_id: questionId, kind, via: "chat" });
    if (r.status === 200 && r.body.success === true) {
      return JSON.stringify({ success: true, question_id: questionId, kind: r.body.kind ?? kind, invalidated: r.body.invalidated ?? 0, replayed: r.body.replayed === true });
    }
    const code = typeof r.body.error === "string" ? r.body.error : "failed";
    if (code === "key_reused") return JSON.stringify({ error: flagRefusal(code), code });
    const stored = await storedChatFlag(flagKey, { question_id: questionId, kind }, r.status);
    if (stored.state === "conflict") return JSON.stringify({ error: flagRefusal("key_reused"), code: "key_reused" });
    if (stored.state === "found") {
      return JSON.stringify({ success: true, question_id: questionId, kind: stored.kind, invalidated: stored.invalidated, replayed: false });
    }
    if (stored.state === "unknown" || failureMayHaveWritten(r)) {
      return JSON.stringify({ error: "Onyx could not confirm this flag and it may have been saved. Do not flag it again: tell the user to check /reading.", incomplete: true });
    }
    return JSON.stringify({ error: flagRefusal(code), code });
  }

  if (name === "log_supplement_intake") {
    // Written by an earlier try of this operation and removed since: never written again.
    const gate = await removedGate(opId);
    if (gate) return gate;
    if (op?.check && opId) {
      // Check mode: read back what the key holds; an intake the earlier try never wrote is not written now.
      const prior = await intakeEventReplay(supabase, opId);
      return prior ? JSON.stringify({ ...prior, ok: undefined, success: true }) : keyedUnconfirmed(name);
    }
    const result = await logSupplementIntake(supabase, {
      product: String(input.product ?? ""),
      amount: input.amount != null ? Number(input.amount) : null,
      unit: (input.unit as string) || null,
      times: Array.isArray(input.times) ? (input.times as string[]) : null,
      date: (input.date as string) || pinnedDate(op),
      ...(op?.now ? { now: op.now, today: op.day } : {}),
      ...(opId ? { event_key: opId } : {}),
    });
    const { ok, ...rest } = result;
    return JSON.stringify(ok ? { success: true, ...rest } : rest);
  }

  if (name === "log_supplement_stack") {
    const wanted = (input.stack as string)?.trim();
    if (!wanted) return JSON.stringify({ error: "stack name is required" });
    const date = (input.date as string) || pinnedDate(op) || undefined;

    // Logged by an earlier try of this operation and removed since (any of its rows): never logged again.
    const gate = await removedGate(opId);
    if (gate) return gate;
    // A re-run of an operation that already logged its stack: answer from those rows before resolving the name (the
    // stack may have been renamed or archived since, which would otherwise read as "not logged").
    let result: LogStackResult | null = opId ? await stackEventReplay(supabase, opId) : null;
    // Check mode: only what the key already holds is reported; a stack the earlier try never logged is not logged now.
    if (!result && op?.check) return keyedUnconfirmed(name);
    if (!result) {
      // Resolve the stack by case-insensitive name among active stacks.
      const { data: candidates, error: lookupErr } = await supabase
        .from("supplement_stack")
        .select("stack_id,name")
        .eq("is_active", true);
      if (lookupErr) {
        // Code only: a database message can echo upstream detail, and it reaches the model and the receipt.
        console.error("log_supplement_stack: stack lookup failed", lookupErr.code ?? "unknown");
        return JSON.stringify({ error: "Onyx could not read your supplement stacks, so nothing was logged. Try again in a moment." });
      }

      const lc = wanted.toLowerCase();
      const match =
        (candidates ?? []).find((s) => s.name.toLowerCase() === lc) ??
        (candidates ?? []).find((s) => s.name.toLowerCase().includes(lc));
      if (!match) {
        return JSON.stringify({
          error: `No stack named "${wanted}".`,
          available: (candidates ?? []).map((s) => s.name),
        });
      }

      // A stack logged for an earlier day carries no clock time (same rule as
      // /supplements and log_supplement_intake): stamping "now" on a past day
      // gives it a next-day timestamp the caffeine timing layer has to quarantine.
      const backdated = !!date && date !== (op?.now ? op.day : await behavioralToday(supabase));
      const event = opId ? { event_key: opId } : {};
      result = await logStackIntake(supabase, match.stack_id, backdated ? { intake_date: date, intake_time: null, ...event } : { intake_date: date, ...(op?.now ? { intake_time: op.now } : {}), ...event });
    }
    // incomplete = the insert may have committed before its answer was lost: "check first", never "not logged".
    if (!result.ok) {
      return JSON.stringify({ error: result.error, ...(result.incomplete ? { incomplete: true } : {}), ...(result.removed_since ? { removed_since: true } : {}) });
    }
    const written = await describeStackIntakes(result.intake_ids ?? []);
    return JSON.stringify({
      success: true,
      stack: result.stack_name,
      products: result.count,
      total_doses: result.total_doses,
      date: result.intake_date,
      ...written,
      ...(result.replayed ? { replayed: true } : {}),
    });
  }

  // Handle timestamp-based tables
  if (name in timestampTables) {
    const { table, timeCol, extra } = timestampTables[name];
    const cols = CHAT_TABLE_COLS[table];
    if (!cols) return JSON.stringify({ error: `No column list for ${table}` });
    let query = supabase.from(table).select<string, Record<string, unknown>>(cols).gte(timeCol, since.toISOString()).order(timeCol, { ascending: true }).limit(50);
    if (extra) {
      for (const [k, v] of Object.entries(extra)) {
        query = query.eq(k, v);
      }
    }
    const { data, error } = await query;
    if (error) return JSON.stringify({ error: error.message });
    return JSON.stringify(tagCalorieSources(table, stripRawFields(data ?? [])));
  }

  // Handle calendar_date-based tables
  const table = calendarDateTables[name];
  if (!table) return JSON.stringify({ error: "Unknown tool" });
  const cols = CHAT_TABLE_COLS[table];
  if (!cols) return JSON.stringify({ error: `No column list for ${table}` });

  const { data, error } = await supabase
    .from(table)
    .select<string, Record<string, unknown>>(cols)
    .gte("calendar_date", sinceStr)
    .order("calendar_date", { ascending: true })
    .limit(60);

  if (error) return JSON.stringify({ error: error.message });
  return JSON.stringify(tagCalorieSources(table, stripRawFields(data ?? [])));
}

/** Run one tool; a throw becomes an "incomplete" result (write) or "unavailable" (lookup), never a failed request. */
async function runTool(name: string, input: Record<string, unknown>, op?: OpContext, callId?: string): Promise<{ result: string; failed: boolean }> {
  try {
    return { result: await executeTool(name, input, op, callId), failed: false };
  } catch (toolError) {
    // A tool that throws may have written part of its work. Tell the
    // model (and the receipt) so, instead of failing the whole request
    // with nothing on screen. Tool name and error class only: never the
    // message, which can echo user text.
    const { name: errorName } = (toolError ?? {}) as { name?: unknown };
    console.error("Chat tool failed", { tool: name, name: typeof errorName === "string" ? errorName : typeof toolError });
    return {
      failed: true,
      result: JSON.stringify(isWriteTool(name)
        ? { error: "This tool failed unexpectedly and may have completed only part of its work. Do not retry it; tell the user to check the relevant page.", incomplete: true }
        : { error: "This lookup failed unexpectedly. Say that this data is unavailable right now; do not guess its contents." }),
    };
  }
}

/** The signed-in owner's user id from the session (middleware already admits the owner only). */
async function sessionOwnerId(): Promise<string | null> {
  try {
    const client = await createSupabaseServer();
    const { data } = await client.auth.getClaims();
    const sub = data?.claims?.sub;
    return typeof sub === "string" && REQUEST_ID_RE.test(sub) ? sub.toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Record this request (first try or retry) in the replay ledger for the signed-in owner. Never throws. The middleware
 * has already admitted the owner's session, so a missing owner id here is a failed check (e.g. the signing keys could
 * not be fetched), not a signed-out user: writes pause and read-only answers go on.
 */
async function openRequestLedger(
  requestId: string,
  messages: ReadonlyArray<{ role: string; content: string }>,
  temporal: Promise<RequestTemporal>,
): Promise<OpenedLedger> {
  const [ownerId, requestContext] = await Promise.all([sessionOwnerId(), temporal]);
  if (!ownerId) return { kind: "failed", code: "no_owner" };
  return openLedger(supabaseLedgerStore(supabase), {
    ownerId,
    requestId,
    conversationSha: conversationSha(messages),
    // Stored with the request on its first try; a retry gets the first try's back (ledger.requestContext).
    requestContext: { ...requestContext },
    buildReceipt: buildWriteReceipt,
    reconcilers: supabaseReconcilers(supabase),
    onError: logLedger,
  });
}

/**
 * When and where a request runs: the instant (ISO), the time zone and the behavioral day. A retry of a recorded
 * request uses the first try's (SEC-04), so its prompt and every write default stay on the day it was first sent.
 */
interface RequestTemporal {
  now: string;
  time_zone: string;
  behavioral_today: string;
}

/** The first try's temporal context stored on the request row, when it is complete; null otherwise. */
function storedTemporal(ctx: Record<string, unknown> | null | undefined): RequestTemporal | null {
  if (!ctx) return null;
  const { now, time_zone, behavioral_today } = ctx;
  if (typeof now !== "string" || !Number.isFinite(Date.parse(now))) return null;
  if (typeof time_zone !== "string" || !time_zone) return null;
  if (typeof behavioral_today !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(behavioral_today)) return null;
  return { now, time_zone, behavioral_today };
}

/** Ledger problems are logged by stage and database code only. */
const logLedger = (stage: string, code: string) => console.error("Chat ledger", { stage, code });

/** Shown on the receipt too, so at most 240 characters (the receipt's limit). */
const WRITES_PAUSED =
  "Onyx could not set up safe logging for this message, so this action was not done now. An earlier send of this message may already have saved it. Answer the rest normally; tell the user to check the relevant page before trying again.";

export async function POST(req: NextRequest) {
  // One receipt per executed write tool, built from the tool's own result (see
  // lib/chat-receipts.ts). Returned with every response after a write ran,
  // error responses included, so the page can show exactly what was saved.
  const receipts: WriteReceipt[] = [];
  // Replay ledger (SEC-04, lib/chat-operations.ts): set when the page sent a request_id and the ledger is there.
  let ledger: ChatLedger | null = null;
  // The page sent a request_id but the ledger could not record it (tables missing, or any other failure): write
  // tools are refused, lookups still answer.
  let writesPaused = false;
  // What an earlier try of this request id saved could not be read back: unknown, not "nothing", so the answer says
  // so (earlier_unconfirmed) and the page keeps the request remembered instead of settling it. Set on a retry whose
  // ledger rows cannot be listed, and whenever a keyed request's ledger cannot be opened at all (that try cannot
  // tell a first try from a retry, so an earlier try may have written).
  let earlierUnconfirmed = false;
  const withReceipts = <T extends object>(body: T): T | (T & { receipts?: WriteReceipt[]; replay_safe?: true; earlier_unconfirmed?: true }) => {
    if (receipts.length === 0 && !ledger && !earlierUnconfirmed) return body;
    return {
      ...body,
      ...(receipts.length > 0 ? { receipts } : {}),
      ...(ledger ? { replay_safe: true as const } : {}),
      ...(earlierUnconfirmed ? { earlier_unconfirmed: true as const } : {}),
    };
  };
  // On a retry, the receipts of what an earlier try saved that this try did not repeat, listed first.
  let earlierAdded = false;
  const addEarlierReceipts = async () => {
    if (earlierAdded || !ledger?.retry) return;
    earlierAdded = true;
    const earlier = await ledger.earlierReceipts();
    if (earlier === null) earlierUnconfirmed = true;
    else receipts.unshift(...earlier);
  };
  // The ledger being opened (it takes this try's lease on the request), so `finally` can give the lease back.
  let opening: Promise<OpenedLedger> | null = null;
  try {
    let body: unknown;
    try { body = await req.json(); } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const rawMessages = body && typeof body === "object" && "messages" in body ? body.messages : undefined;

    if (!validateChatMessages(rawMessages)) {
      return Response.json({ error: "Use a nonempty, alternating text conversation of at most 60 messages and 60,000 characters." }, { status: 400 });
    }
    const requestId = parseRequestId(body && typeof body === "object" && "request_id" in body ? body.request_id : undefined);
    if (requestId === false) return Response.json({ error: "request_id must be a UUID." }, { status: 400 });
    // Only role + text reach the model; any other field a client attaches is dropped.
    const messages = rawMessages.map(({ role, content }) => ({ role, content }));
    // Write authority (SEC-05, lib/chat-write-intent.ts): computed from the conversation the user sent, before the
    // model reads anything, so no tool result or retrieved record can mint or widen it. Every write-tool call is
    // checked against it before it runs (and before the ledger records it); a refused call gets a receipt saying why.
    const grant = writeGrantFor(messages, { off: chatWritesOff(process.env) });
    const writesAllowed = newWriteUsage();
    let books: Promise<ReadingBooks | null> | undefined;

    if (req.signal.aborted) return Response.json({ error: "Request cancelled" }, { status: 499 });

    // The model has no clock of its own: tell it the local time and the
    // behavioral day so "today", "yesterday" and "this morning" resolve.
    // The request is recorded in the replay ledger with them (one insert, made once the time zone, the behavioral day
    // and the owner check are in: one database round trip after the slowest of the three).
    const now = new Date();
    const tzRead = currentTimeZone(supabase, now);
    const bdayRead = behavioralToday(supabase);
    // The active book, for the reading sentence of the prompt (read in the same parallel step as the clock reads).
    const questBookRead = activeQuestBook();
    // Kept so the lease is given back in `finally` even when the other two reads fail. The request row is written
    // with this try's time, time zone and behavioral day (a retry reads the first try's back).
    opening = requestId
      ? openRequestLedger(
          requestId,
          messages,
          Promise.all([tzRead, bdayRead]).then(([t, b]) => ({ now: now.toISOString(), time_zone: t, behavioral_today: b })),
        )
      : null;
    const [opened, tz, bday, questBook] = await Promise.all([opening ?? Promise.resolve(null), tzRead, bdayRead, questBookRead]);
    if (opened?.kind === "conflict") {
      return Response.json({ error: "This retry does not match the message it was first sent with, so nothing was run. Send your message again.", code: "request_conflict" }, { status: 409 });
    }
    if (opened?.kind === "busy") {
      // Another try of this same message is still running: one try at a time, so nothing runs now.
      return Response.json({ error: "An earlier try of this message is still running. Wait a moment, then send it again unchanged.", code: "request_in_progress" }, { status: 409 });
    }
    if (opened?.kind === "ledger") ledger = opened.ledger;
    else if (opened && "code" in opened) {
      logLedger("open", opened.code);
      // Fail closed: the page asked for a replay-safe request and the ledger cannot record it (its tables are
      // missing, or any other failure). No write runs without a record of it; questions are still answered. Only a
      // request with no request_id (an older page) runs write tools without the ledger, and it is not called safe.
      writesPaused = true;
      // Nor can it say what an earlier try of this id saved (this may be a retry of a send whose writes committed
      // before its answer was lost): unknown, so the page keeps the id remembered until its account can be read back,
      // and a later "log it" is not taken as the first time.
      earlierUnconfirmed = true;
    }
    // A retry answers as of when the message was FIRST sent: its prompt time and behavioral day, and the day every new
    // operation defaults to (an operation stored by an earlier try keeps its own context). Every omitted date of a
    // ledger write is sent as that day explicitly (pinnedDate), so a day boundary crossed later changes nothing.
    const pinned = ledger?.retry ? storedTemporal(ledger.requestContext) : null;
    const requestDay = pinned?.behavioral_today ?? bday;
    const requestNow = pinned?.now ?? now.toISOString();
    const promptTz = pinned?.time_zone ?? tz;
    const localNow = (pinned ? new Date(pinned.now) : now).toLocaleString("en-US", {
      timeZone: promptTz, weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "numeric", minute: "2-digit",
    });
    const system = systemPrompt(
      questBook,
      pinned
        ? `This message is a retry of one first sent at ${localNow} (${promptTz}); answer as of then. Behavioral day it was sent on ("today" for logging; it runs until the user sleeps, so it can lag the calendar date after midnight): ${requestDay}.`
        : `Current local time: ${localNow} (${tz}). Current behavioral day ("today" for logging; it runs until the user sleeps, so it can lag the calendar date after midnight): ${bday}.`,
    );

    // Initial Claude call with tools
    let response = await anthropic.messages.create({
      model: "claude-sonnet-5-5",
      max_tokens: 2048,
      system,
      tools,
      messages,
    }, { signal: req.signal });

    // Agentic tool-use loop
    const allMessages: Anthropic.MessageParam[] = [...messages];
    let toolRounds = 0;
    let toolCalls = 0;

    // A tool batch is never cut in half: the client disconnecting is checked
    // only BETWEEN rounds (before a batch starts and after it finishes), so a
    // retry cannot double-log the first write of a half-run batch. The batch
    // size is also checked up front for the same reason.
    const cancelled = () =>
      Response.json(withReceipts({ error: "Request cancelled. Check the relevant page before retrying any action." }), { status: 499 });

    while (response.stop_reason === "tool_use") {
      if (toolRounds++ >= MAX_TOOL_ROUNDS) {
        await addEarlierReceipts();
        return Response.json(withReceipts({ error: "This request reached the tool limit. Some actions may already have completed; check the relevant page before retrying any logging request." }), { status: 422 });
      }
      if (req.signal.aborted) return cancelled();
      const assistantContent = response.content;
      const batchSize = assistantContent.filter((b) => b.type === "tool_use").length;
      if (toolCalls + batchSize > MAX_TOOL_CALLS) {
        await addEarlierReceipts();
        return Response.json(withReceipts({ error: "This request reached the tool-call limit. Some actions may already have completed; check the relevant page before repeating an action." }), { status: 422 });
      }
      toolCalls += batchSize;
      allMessages.push({ role: "assistant", content: assistantContent });

      const toolResults: Anthropic.ContentBlockParam[] = [];
      let retrieved = false;
      for (const block of assistantContent) {
        if (block.type === "tool_use") {
          const input = block.input as Record<string, unknown>;
          let outcome: { result: string; failed: boolean; receipt: WriteReceipt | null };
          // A reading write goes to the book the user named, or the book being read when they name none.
          let readingCtx = isWriteTool(block.name) && READING_BOOK_TOOLS.has(block.name) ? await (books ??= readingBooks()) : null;
          // A retry of a call an earlier try ran is checked against the book that try was pinned to, not the one being
          // read now: "I finished the book" finished it, and the retry must reach the ledger to get its stored result.
          if (readingCtx && ledger?.retry) {
            const pinned = (await ledger.storedContext(block.name, input ?? {}))?.book_id;
            const slug = typeof pinned === "number" ? readingCtx.list.find((b) => b.id === pinned)?.slug : undefined;
            if (slug) readingCtx = { ...readingCtx, active: slug };
          }
          const decision = isWriteTool(block.name)
            ? authorizeWrite(grant, block.name, input ?? {}, { requestDay, used: writesAllowed, books: readingCtx, isSleepHabit: (h) => SLEEP_QUESTIONS.has(h) })
            : null;
          // An allowed call consumes the granted action's canonical identity (the tool, the record as the user's
          // words name it, the arguments the user's action states — lib/chat-write-intent.ts), so a second call for
          // the same grant in this request is refused with a receipt whatever arguments the model sends. A retry of
          // the whole message builds a fresh set here and reconciles through the SEC-04 ledger, which mints no new
          // action either; nothing here persists across requests.
          if (decision?.allowed) commitWrite(writesAllowed, decision);
          if (decision && !decision.allowed) {
            // Not asked for in the user's own latest message: never run, never recorded in the ledger.
            const result = JSON.stringify({ error: decision.reason, refused: decision.code });
            outcome = { result, failed: false, receipt: buildWriteReceipt(block.name, input, result) };
          } else if (isWriteTool(block.name) && ledger) {
            // Through the ledger: a retry of this message gets the stored result instead of writing again. A re-run
            // of a stored call gets what that call first ran with (its context: the day, the book), not today's.
            const bookId = READING_BOOK_TOOLS.has(block.name) && !(typeof input.book === "string" && input.book.trim()) ? await currentBookId() : undefined;
            outcome = await ledger.run(
              block.name,
              input,
              (id, context, check) => runTool(block.name, input, {
                id,
                day: typeof context.behavioral_today === "string" ? context.behavioral_today : requestDay,
                now: typeof context.now === "string" && Number.isFinite(Date.parse(context.now)) ? context.now : requestNow,
                ...(typeof context.book_id === "number" ? { bookId: context.book_id } : {}),
                ...(typeof context.started_at === "string" ? { startedAt: context.started_at } : {}),
                ...(check ? { check: true } : {}),
              }, block.id),
              { behavioral_today: requestDay, now: requestNow, started_at: new Date().toISOString(), ...(bookId !== undefined ? { book_id: bookId } : {}) },
            );
          } else if (isWriteTool(block.name) && writesPaused) {
            const result = JSON.stringify({ error: WRITES_PAUSED });
            outcome = { result, failed: false, receipt: buildWriteReceipt(block.name, input, result) };
          } else {
            if (!isWriteTool(block.name)) retrieved = true;
            const ran = await runTool(block.name, input, undefined, block.id);
            outcome = { ...ran, receipt: buildWriteReceipt(block.name, block.input, ran.result) };
          }
          if (outcome.receipt) receipts.push(outcome.receipt);
          toolResults.push({
            type: "tool_result" as const,
            tool_use_id: block.id,
            content: outcome.result,
            ...(outcome.failed ? { is_error: true } : {}),
          });
        }
      }
      // What lookups returned is data, never the user speaking: said once per round, after the results.
      if (retrieved) toolResults.push({ type: "text", text: RETRIEVED_DATA_NOTE });

      allMessages.push({ role: "user", content: toolResults });

      if (req.signal.aborted) return cancelled();

      response = await anthropic.messages.create({
        model: "claude-sonnet-5-5",
        max_tokens: 2048,
        system,
        tools,
        messages: allMessages,
      }, { signal: req.signal });
    }

    // Extract final text
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    const summary = text.trim() || (toolRounds > 0
      ? "No final summary was produced. Tool requests were processed, but that does not confirm every action succeeded. Check the relevant page before repeating an action."
      : "No answer was produced. Please try rephrasing your question.");
    const suffix = response.stop_reason === "max_tokens" ? "\n\nThis response reached its length limit. Ask me to continue if needed; do not repeat an action without checking its result." : "";
    await addEarlierReceipts();
    return Response.json(withReceipts({ response: summary + suffix }));
  } catch (err) {
    // The client is gone (the SDK throws when the abort signal fires).
    if (req.signal.aborted) {
      return Response.json(withReceipts({ error: "Request cancelled. Check the relevant page before retrying any action." }), { status: 499 });
    }
    // Server-side diagnostics only: error class and HTTP status, never the
    // message (it can echo user text or upstream detail). The client gets the
    // generic text below.
    const { name, status } = (err ?? {}) as { name?: unknown; status?: unknown };
    console.error("Chat API request failed", {
      name: typeof name === "string" ? name : typeof err,
      status: typeof status === "number" ? status : undefined,
    });
    await addEarlierReceipts().catch(() => {});
    return Response.json(
      withReceipts({ error: "Unable to finish this request. If you asked to log or create something, check the relevant page before retrying." }),
      { status: 500 }
    );
  } finally {
    // One try at a time: give the request back so a retry of this message can run (never throws).
    const held = opening ? await (opening as Promise<OpenedLedger>).catch(() => null) : null;
    if (held?.kind === "ledger") await held.ledger.release();
  }
}
