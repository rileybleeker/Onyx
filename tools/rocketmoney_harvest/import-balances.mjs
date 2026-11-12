// node import-balances.mjs <balances.json> [--dry-run]
// balances.json = [{ institution, account_name, account_type, mask, balance_cents, currency,
//                    kind: 'asset' | 'liability' | null, captured_at: ISO-8601 }]
// Creates any account it has not seen, then inserts one snapshot per entry (an existing
// (account, captured_at) pair is left alone, so re-running the same file inserts nothing).
import { readFileSync } from "node:fs";
import { runImportCli } from "./lib/cli.mjs";
import { importBalances } from "./lib/importer.mjs";

process.exitCode = await runImportCli({
  argv: process.argv.slice(2),
  dataType: "balances",
  usage: "node import-balances.mjs <balances.json> [--dry-run]",
  load: async (path) => {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(data)) throw new Error("balances file must be a JSON array of objects");
    return data;
  },
  execute: importBalances,
});
