// node import-rows.mjs <rows.json> [--dry-run]
// Same as import-csv.mjs for rows obtained another way: a JSON array of objects keyed by the Rocket Money
// export column names (Date, Original Date, Account Type, Account Name, Account Number, Institution Name,
// Name, Custom Name, Amount, Description, Category, Note, Ignored From, Transaction Tags, Tax Deductible).
// The array must be the COMPLETE set of transactions (ordinals of identical rows depend on it).
import { readFileSync } from "node:fs";
import { runImportCli } from "./lib/cli.mjs";
import { importTransactions } from "./lib/importer.mjs";

process.exitCode = await runImportCli({
  argv: process.argv.slice(2),
  dataType: "transactions",
  usage: "node import-rows.mjs <rows.json> [--dry-run]",
  load: async (path) => {
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(data)) throw new Error("rows file must be a JSON array of objects");
    return data;
  },
  execute: importTransactions,
});
