// Pure functions: Rocket Money export -> rows for pds.finance_*. No I/O, no network, no secrets.
//
// Design notes (decided 2026-11-12, see sql/finance_schema.sql):
//  - The export has NO stable transaction id, and ~14% of rows sit in groups that are identical on
//    (account, date, original date, name, amount). txn_key therefore hashes those fields plus the
//    1-based ordinal of the row inside its group of identical rows, in file order. Category, note,
//    custom name, tags etc. are deliberately NOT in the key, so re-categorizing in Rocket Money
//    updates the same row instead of creating a new one.
//  - ordinals are only stable when the rows are the COMPLETE export (the export is all-time).
//  - Amounts are stored exactly as exported: expenses positive, income/refunds negative.
//  - Only the last four digits of an account number are ever kept.
import { createHash } from "node:crypto";

export const CSV_COLUMNS = [
  "Date",
  "Original Date",
  "Account Type",
  "Account Name",
  "Account Number",
  "Institution Name",
  "Name",
  "Custom Name",
  "Amount",
  "Description",
  "Category",
  "Note",
  "Ignored From",
  "Transaction Tags",
  "Tax Deductible",
];

/** Columns without which a row (or the whole file) cannot be interpreted. */
export const REQUIRED_COLUMNS = ["Date", "Account Type", "Account Name", "Institution Name", "Name", "Amount"];

const headerId = (s) => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const CANONICAL_BY_ID = new Map(CSV_COLUMNS.map((c) => [headerId(c), c]));
// Tolerated aliases (the web export has used both spellings historically).
CANONICAL_BY_ID.set("tags", "Transaction Tags");
CANONICAL_BY_ID.set("institution", "Institution Name");
CANONICAL_BY_ID.set("accountmask", "Account Number");

/** Maps a header (any case/spacing) to the canonical column name, or null when unknown. */
export function canonicalColumn(header) {
  return CANONICAL_BY_ID.get(headerId(header)) ?? null;
}

/** RFC 4180 parser: quoted fields may contain commas, doubled quotes and newlines; CRLF or LF; BOM tolerated. */
export function parseCsv(text) {
  let s = String(text);
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  const endRow = () => {
    row.push(field);
    field = "";
    // A line that is completely empty is not a record.
    if (!(row.length === 1 && row[0] === "")) rows.push(row);
    row = [];
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"' && field === "") {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\r") {
      if (s[i + 1] === "\n") i++;
      endRow();
    } else if (c === "\n") {
      endRow();
    } else {
      field += c;
    }
  }
  if (inQuotes) throw new Error("CSV ends inside a quoted field");
  if (field !== "" || row.length > 0) endRow();
  return rows;
}

/**
 * CSV text -> { rows, malformed }. Rows are objects keyed by canonical column names, whatever order or
 * case the header uses. A row whose field count differs from the header is counted in `malformed` and
 * dropped (a misaligned row would otherwise land its amounts in the wrong columns).
 */
export function rowsFromCsv(text) {
  const table = parseCsv(text);
  if (table.length === 0) throw new Error("CSV is empty");
  const header = table[0].map(canonicalColumn);
  const missing = REQUIRED_COLUMNS.filter((c) => !header.includes(c));
  if (missing.length) throw new Error(`CSV is missing required column(s): ${missing.join(", ")}`);
  const rows = [];
  let malformed = 0;
  for (const rec of table.slice(1)) {
    if (rec.length !== header.length) {
      malformed++;
      continue;
    }
    const obj = {};
    header.forEach((col, i) => {
      if (col) obj[col] = rec[i];
    });
    rows.push(obj);
  }
  return { rows, malformed };
}

/** Re-keys a row object (e.g. from JSON) to canonical column names. Unknown keys are dropped. */
export function canonicalizeRow(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj ?? {})) {
    const col = canonicalColumn(k);
    if (col) out[col] = v;
  }
  return out;
}

const blank = (v) => v == null || (typeof v === "string" && v.trim() === "");

/** Blank -> null, otherwise the trimmed string. */
export function textOrNull(v) {
  return blank(v) ? null : String(v).trim();
}

/**
 * Amount -> integer cents, exactly round(Amount * 100) but computed on the decimal string so binary
 * floating point can never move a cent. Accepts "-12.34", "1,234.50", "$5", numbers. Returns null if unparseable.
 */
export function toCents(v) {
  if (blank(v)) return null;
  let s;
  if (typeof v === "number") {
    if (!Number.isFinite(v)) return null;
    s = /e/i.test(String(v)) ? v.toFixed(6) : String(v);
  } else {
    s = String(v).trim().replace(/[$,\s]/g, "");
    if (/^\(.*\)$/.test(s)) s = "-" + s.slice(1, -1); // accounting negative
  }
  const m = /^([+-])?(\d*)(?:\.(\d*))?$/.exec(s);
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) return null;
  const whole = m[2] === "" ? "0" : m[2];
  const frac = (m[3] ?? "").padEnd(3, "0");
  let cents = Number(whole) * 100 + Number(frac.slice(0, 2)) + (frac[2] >= "5" ? 1 : 0); // half away from zero
  if (!Number.isSafeInteger(cents)) return null;
  if (m[1] === "-") cents = -cents;
  return cents === 0 ? 0 : cents; // never -0
}

/** "2026-11-11", "2026-11-11T05:00:00Z", "11/11/2026" -> "2026-11-11"; null if not a real calendar date. */
export function toIsoDate(v) {
  if (blank(v)) return null;
  const s = String(v).trim();
  let y;
  let mo;
  let d;
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:$|[T\s])/.exec(s);
  if (m) {
    [, y, mo, d] = m;
  } else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) {
    [, mo, d, y] = m;
  } else {
    return null;
  }
  const yy = Number(y);
  const mm = Number(mo);
  const dd = Number(d);
  const t = new Date(Date.UTC(yy, mm - 1, dd));
  if (t.getUTCFullYear() !== yy || t.getUTCMonth() !== mm - 1 || t.getUTCDate() !== dd) return null;
  return `${String(yy).padStart(4, "0")}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
}

/** Account number -> last four digits only (null if there are no digits). Nothing longer is ever kept. */
export function lastFour(v) {
  if (blank(v)) return null;
  const digits = (typeof v === "number" ? String(Math.trunc(v)).padStart(4, "0") : String(v)).replace(/\D/g, "");
  return digits ? digits.slice(-4) : null;
}

export function toBool(v) {
  if (typeof v === "boolean") return v;
  if (blank(v)) return null;
  const s = String(v).trim().toLowerCase();
  if (["true", "yes", "y", "1"].includes(s)) return true;
  if (["false", "no", "n", "0"].includes(s)) return false;
  return null;
}

const sha256hex = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const norm = (s) => String(s ?? "").trim().toLowerCase();

/** First 24 hex of sha256(lower(institution)|lower(account_type)|lower(account_name)|mask). */
export function accountKey({ institution, account_type, account_name, mask }) {
  return sha256hex(`${norm(institution)}|${norm(account_type)}|${norm(account_name)}|${mask ?? ""}`).slice(0, 24);
}

/** First 32 hex of sha256(account_key|txn_date|original_date|name|amount_cents|ordinal). */
export function txnKey({ account_key, txn_date, original_date, name, amount_cents, ordinal }) {
  return sha256hex(`${account_key}|${txn_date}|${original_date ?? ""}|${name}|${amount_cents}|${ordinal}`).slice(0, 32);
}

function bump(counts, reason) {
  counts[reason] = (counts[reason] ?? 0) + 1;
}

/**
 * Raw rows (objects keyed by export column names) -> accounts + transactions ready to upsert.
 * Rows that cannot be interpreted are counted by reason (never echoed) and skipped.
 * Ordinals are assigned in input order among the VALID rows of each identical group.
 */
export function normalizeRows(rawRows) {
  const accounts = new Map();
  const transactions = [];
  const groupCounts = new Map();
  const rejected = {};
  for (const raw of rawRows) {
    const r = canonicalizeRow(raw);
    const txn_date = toIsoDate(r["Date"]);
    if (!txn_date) {
      bump(rejected, "bad_date");
      continue;
    }
    const amount_cents = toCents(r["Amount"]);
    if (amount_cents == null) {
      bump(rejected, "bad_amount");
      continue;
    }
    const institution = textOrNull(r["Institution Name"]);
    const account_name = textOrNull(r["Account Name"]);
    const account_type = textOrNull(r["Account Type"]);
    if (!institution || !account_name || !account_type) {
      bump(rejected, "missing_account");
      continue;
    }
    if (r["Name"] == null) {
      bump(rejected, "missing_name");
      continue;
    }
    const original_raw = r["Original Date"];
    const original_date = blank(original_raw) ? null : toIsoDate(original_raw);
    if (!blank(original_raw) && !original_date) {
      bump(rejected, "bad_original_date");
      continue;
    }
    const mask = lastFour(r["Account Number"]);
    const account_key = accountKey({ institution, account_type, account_name, mask });
    const name = String(r["Name"]); // verbatim: part of the key

    const group = `${account_key}|${txn_date}|${original_date ?? ""}|${name}|${amount_cents}`;
    const ordinal = (groupCounts.get(group) ?? 0) + 1;
    groupCounts.set(group, ordinal);

    const acct = accounts.get(account_key);
    if (acct) {
      if (txn_date < acct.first_seen) acct.first_seen = txn_date;
      if (txn_date > acct.last_seen) acct.last_seen = txn_date;
    } else {
      accounts.set(account_key, { account_key, institution, account_name, account_type, mask, first_seen: txn_date, last_seen: txn_date });
    }

    transactions.push({
      txn_key: txnKey({ account_key, txn_date, original_date, name, amount_cents, ordinal }),
      account_key,
      txn_date,
      original_date,
      name,
      custom_name: textOrNull(r["Custom Name"]),
      amount_cents,
      currency: "USD",
      category: textOrNull(r["Category"]),
      description: textOrNull(r["Description"]),
      note: textOrNull(r["Note"]),
      ignored_from: textOrNull(r["Ignored From"]),
      tax_deductible: toBool(r["Tax Deductible"]),
      tags: textOrNull(r["Transaction Tags"]),
    });
  }
  const rejectedTotal = Object.values(rejected).reduce((a, b) => a + b, 0);
  return { accounts: [...accounts.values()], transactions, rejected, rejectedTotal, inputRows: rawRows.length };
}

/**
 * Balance entries -> accounts + snapshots.
 * Entry: { institution, account_name, account_type, mask, balance_cents, currency, kind, captured_at }.
 */
export function normalizeBalances(list) {
  const accounts = new Map();
  const snapshots = new Map();
  const rejected = {};
  for (const e of list) {
    const institution = textOrNull(e?.institution);
    const account_name = textOrNull(e?.account_name);
    if (!institution || !account_name) {
      bump(rejected, "missing_account");
      continue;
    }
    const account_type = textOrNull(e?.account_type) ?? "Unknown";
    const balance_cents = typeof e?.balance_cents === "string" ? toCents(e.balance_cents) : e?.balance_cents;
    if (!Number.isSafeInteger(balance_cents)) {
      bump(rejected, "bad_balance");
      continue;
    }
    const t = new Date(e?.captured_at);
    if (blank(e?.captured_at) || Number.isNaN(t.getTime())) {
      bump(rejected, "bad_captured_at");
      continue;
    }
    const kind = e?.kind == null ? null : String(e.kind).toLowerCase();
    if (kind !== null && kind !== "asset" && kind !== "liability") {
      bump(rejected, "bad_kind");
      continue;
    }
    const currency = blank(e?.currency) ? "USD" : String(e.currency).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) {
      bump(rejected, "bad_currency");
      continue;
    }
    const mask = lastFour(e?.mask);
    const account_key = accountKey({ institution, account_type, account_name, mask });
    if (!accounts.has(account_key)) accounts.set(account_key, { account_key, institution, account_name, account_type, mask });
    // A repeated (account, captured_at) in one batch keeps the last entry.
    snapshots.set(`${account_key}|${t.toISOString()}`, { account_key, captured_at: t.toISOString(), balance_cents, currency, kind });
  }
  const rejectedTotal = Object.values(rejected).reduce((a, b) => a + b, 0);
  return { accounts: [...accounts.values()], snapshots: [...snapshots.values()], rejected, rejectedTotal, inputRows: list.length };
}

/** Error text that is safe to print/log/store: quoted fragments (which can carry row data) and long digit runs are masked. */
export function safeError(e) {
  const code = e?.code ? `[${e.code}] ` : "";
  const msg = String(e?.message ?? e ?? "unknown error")
    .replace(/sb_(secret|publishable)_\w+/g, "[redacted]")
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[redacted]")
    .replace(/"[^"]*"/g, '"…"')
    .replace(/'[^']*'/g, "'…'")
    .replace(/\d{5,}/g, "#");
  return (code + msg).slice(0, 200);
}
