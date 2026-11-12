// Shared command-line wrapper for the three importers.
// Contract: ONE JSON line on stdout with counts only (never merchant names, notes, amounts or balances),
// exit code 0 on success and 1 on failure, and a pds.sync_log heartbeat on every non-dry run.
import { safeError } from "./normalize.mjs";
import { createSupabaseStore } from "./store.mjs";

export const SOURCE = "rocketmoney";

/** Builds the sync_log row. Error text is passed through safeError so no row data can leak into the table. */
export function heartbeatRow({ dataType, status, records, startedAt, endedAt, error, dateMin, dateMax }) {
  const row = {
    source: SOURCE,
    data_type: dataType,
    status,
    records_synced: records,
    sync_start: startedAt.toISOString(),
    sync_end: endedAt.toISOString(),
    duration_seconds: Math.max(0, Math.round((endedAt - startedAt) / 1000)),
    error_message: error ? safeError({ message: error }) : null,
  };
  if (dateMin) row.date_range_start = dateMin;
  if (dateMax) row.date_range_end = dateMax;
  return row;
}

function parseArgs(argv) {
  const flags = new Set();
  const positional = [];
  for (const a of argv) {
    if (a.startsWith("--")) flags.add(a);
    else positional.push(a);
  }
  const unknown = [...flags].filter((f) => f !== "--dry-run");
  return { dryRun: flags.has("--dry-run"), positional, unknown };
}

function summarizeReasons(reasons) {
  const parts = Object.entries(reasons ?? {}).map(([k, v]) => `${k}=${v}`);
  return parts.join(", ");
}

/**
 * @param {object} o
 * @param {string[]} o.argv            process.argv.slice(2)
 * @param {string} o.dataType          'transactions' | 'balances' (sync_log.data_type)
 * @param {string} o.usage             shown on a usage error
 * @param {(path: string) => Promise<any>} o.load   file -> input for execute()
 * @param {(input: any, ctx: {store, dryRun}) => Promise<object>} o.execute  importer
 * @param {() => Promise<object>} [o.storeFactory]
 * @param {(line: string) => void} [o.print]
 * @returns {Promise<number>} exit code
 */
export async function runImportCli({ argv, dataType, usage, load, execute, storeFactory = createSupabaseStore, print = (l) => process.stdout.write(l + "\n") }) {
  const { dryRun, positional, unknown } = parseArgs(argv);
  if (positional.length !== 1 || unknown.length) {
    print(JSON.stringify({ ok: false, dry_run: dryRun, error: `usage: ${usage}` }));
    return 1;
  }
  const startedAt = new Date();
  let store = null;
  try {
    const input = await load(positional[0]);
    store = await storeFactory();
    const result = await execute(input, { store, dryRun, now: startedAt });
    if (result.rows === 0) throw new Error("input contained no rows");
    if (result.errors >= result.rows) throw new Error(`every row was rejected (${summarizeReasons(result.rejected_by_reason)})`);
    const { rejected_by_reason, date_min, date_max, ...counts } = result;
    let heartbeat = "skipped";
    if (!dryRun) {
      const partial = result.errors > 0;
      try {
        await store.logHeartbeat(
          heartbeatRow({
            dataType,
            status: partial ? "partial" : "success",
            records: result.inserted + result.updated,
            startedAt,
            endedAt: new Date(),
            error: partial ? `${result.errors} row(s) rejected: ${summarizeReasons(rejected_by_reason)}` : null,
            dateMin: date_min,
            dateMax: date_max,
          }),
        );
        heartbeat = "ok";
      } catch {
        heartbeat = "failed";
      }
    }
    print(JSON.stringify({ ok: true, dry_run: dryRun, ...counts, ...(result.errors ? { rejected_by_reason } : {}), heartbeat }));
    return 0;
  } catch (e) {
    const error = safeError(e);
    let heartbeat = "skipped";
    if (!dryRun) {
      heartbeat = "failed";
      try {
        store ??= await storeFactory();
        await store.logHeartbeat(heartbeatRow({ dataType, status: "failed", records: 0, startedAt, endedAt: new Date(), error }));
        heartbeat = "ok";
      } catch {
        /* the heartbeat is best effort; the exit code and stdout still report the failure */
      }
    }
    print(JSON.stringify({ ok: false, dry_run: dryRun, error, heartbeat }));
    return 1;
  }
}
