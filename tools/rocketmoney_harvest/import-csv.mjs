// node import-csv.mjs <file.csv> [--dry-run]
// Loads a Rocket Money "Export all transactions" CSV into pds.finance_accounts / pds.finance_transactions.
// Prints ONE JSON line of counts; exit 0 = success, 1 = failure. Idempotent. Never deletes anything.
import { readFileSync } from "node:fs";
import { runImportCli } from "./lib/cli.mjs";
import { importTransactions } from "./lib/importer.mjs";
import { rowsFromCsv } from "./lib/normalize.mjs";

process.exitCode = await runImportCli({
  argv: process.argv.slice(2),
  dataType: "transactions",
  usage: "node import-csv.mjs <file.csv> [--dry-run]",
  load: async (path) => {
    const { rows, malformed } = rowsFromCsv(readFileSync(path, "utf8"));
    if (malformed) throw new Error(`${malformed} CSV row(s) had the wrong number of fields; refusing to import a misaligned file`);
    return rows;
  },
  execute: importTransactions,
});
