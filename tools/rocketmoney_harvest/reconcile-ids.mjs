// node reconcile-ids.mjs --web <web-history.json> [--csv <export.csv>] [--apply]
// ONE-OFF: ties the ledger rows imported from the export to Rocket Money's own transaction ids (source_txn_id).
// Dry run by default: prints counts (matched / ambiguous / unmatched) and writes nothing. --apply writes, but only
// when at least 98% of the untied ledger rows were matched, and it changes ONLY the source_txn_id column.
// The web file is a scratch file with the app's transaction ids, dates, accounts and amounts; keep it outside the
// repository and OneDrive, and send it to the Recycle Bin afterwards. See README.md, "Reconciling the history".
import { readFileSync } from "node:fs";
import { runReconcileIds } from "./lib/reconcile-run.mjs";
import { safeError } from "./lib/normalize.mjs";
import { createSupabaseStore } from "./lib/store.mjs";

const args = process.argv.slice(2);
const value = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};
const known = new Set(["--web", "--csv", "--apply", "--dry-run"]);
const stray = args.filter((a, i) => a.startsWith("--") ? !known.has(a) : !["--web", "--csv"].includes(args[i - 1]));
const webPath = value("--web");
if (!webPath || stray.length || (args.includes("--apply") && args.includes("--dry-run"))) {
  console.log(JSON.stringify({ ok: false, error: "usage: node reconcile-ids.mjs --web <web-history.json> [--csv <export.csv>] [--apply]" }));
  process.exitCode = 1;
} else {
  try {
    const web = JSON.parse(readFileSync(webPath, "utf8"));
    const csvPath = value("--csv");
    const result = await runReconcileIds({ web, csvText: csvPath ? readFileSync(csvPath, "utf8") : null, store: await createSupabaseStore(), apply: args.includes("--apply") });
    console.log(JSON.stringify(result));
    process.exitCode = result.ok ? 0 : 1;
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: safeError(e) }));
    process.exitCode = 1;
  }
}
