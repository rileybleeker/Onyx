// Weekly cash forecast snapshot (docs/cash-flow-forecast.md, Section 9). Run by cash-forecast-snapshot.yml.
// Runs the same loader as /financials/forecast, saves the 13 weekly balances (likely / low / high) to
// pds.finance_forecast_snapshots, and writes a finance_forecast|snapshot heartbeat on every run (success or
// failure). The Actions log is public: it prints counts and error codes only, never an amount.
// Env: SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
process.env.NEXT_PUBLIC_SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const { createClient } = require("@supabase/supabase-js");
const { loadTs } = require("../tests/helpers/load-ts.cjs");

async function main() {
  const started = new Date();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.log("FAILED: missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }
  const db = createClient(url, key, { db: { schema: "pds" }, auth: { persistSession: false, autoRefreshToken: false } });
  let status = "success";
  let records = 0;
  let error = null;
  try {
    const S = loadTs("lib/cash-forecast-server.ts", { "server-only": {} });
    const load = await S.loadForecast(new Date());
    if (load.kind !== "ok") throw Object.assign(new Error("load"), { code: load.kind === "error" ? `load_${load.code}` : "empty_ledger" });
    const rows = [];
    for (let w = 1; w <= 13; w++) {
      const d = load.result.days[7 * w - 1];
      if (!d) break;
      rows.push({ as_of: load.result.today, week_end: d.date, likely_cents: d.likely, low_cents: d.low, high_cents: d.high });
    }
    const { error: e } = await db.from("finance_forecast_snapshots").upsert(rows);
    if (e) throw Object.assign(new Error("save"), { code: `save_${e.code || "unknown"}` });
    records = rows.length;
  } catch (e) {
    status = "failed";
    error = `snapshot failed: ${(e && e.code) || (e && e.name) || "error"}`;
  }
  const ended = new Date();
  const hb = await db.from("sync_log").insert({
    source: "finance_forecast",
    data_type: "snapshot",
    status,
    records_synced: records,
    duration_seconds: Math.round((ended - started) / 1000),
    error_message: error,
    sync_start: started.toISOString(),
    sync_end: ended.toISOString(),
  });
  if (hb.error) console.log(`heartbeat insert failed: ${hb.error.code || "unknown"}`);
  console.log(status === "success" ? `snapshot saved: ${records} weeks` : error);
  process.exit(status === "success" ? 0 : 1);
}
main();
