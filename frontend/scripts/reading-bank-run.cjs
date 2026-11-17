// Hourly worker for the Reading question bank (docs/reading-question-bank.md, READ-QUIZ-01). Run by
// .github/workflows/reading-bank.yml (held PR) so builds and grades continue while the collector PC is off.
// One pass (lib/reading-bank-server.ts runWorker): plan every approved book, grade answers still pending after
// 2 minutes, build for up to 10 minutes, repair dirty schedules, and once a day clear raw answers older than
// READING_BANK_CLEAR_ANSWERS_DAYS (180; 0 = off). Writes a reading_bank|generate heartbeat.
// The Actions log is public: it prints ONE line of counts and codes, never a title, an idea or an answer.
// Env: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY,
//      READING_BANK_MONTHLY_CAP_CENTS (default 3000), READING_BANK_CLEAR_ANSWERS_DAYS (default 180).
// (Only a set value is copied: assigning undefined to process.env stores the string "undefined".)
if (!process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_URL) process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.SUPABASE_URL;
const { createClient } = require("@supabase/supabase-js");
const { loadTs } = require("../tests/helpers/load-ts.cjs");

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.log("reading bank: failed missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }
  let result;
  try {
    const db = createClient(url, key, { db: { schema: "pds" }, auth: { persistSession: false, autoRefreshToken: false } });
    const S = loadTs("lib/reading-bank-server.ts", { "server-only": {} });
    result = await S.runWorker(db);
    console.log(S.workerLogLine(result));
  } catch (e) {
    // Never the message (it could quote a row): the error's class name only.
    console.log(`reading bank: failed ${(e && e.name) || "error"}`);
    process.exit(1);
  }
  process.exit(result.status === "failed" ? 1 : 0);
}
main();
