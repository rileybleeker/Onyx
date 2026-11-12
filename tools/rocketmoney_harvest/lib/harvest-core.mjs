// Pure helpers for harvest.mjs (no Playwright, no network): response classification, balance
// normalization, the read-only request guard, the 20-hour rule, the lock and temp-folder pruning.
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname } from "node:path";

export const APP_HOST = "app.rocketmoney.com";
export const GRAPHQL_HOST = "client-api.rocketmoney.com";
export const MIN_HOURS_BETWEEN_RUNS = 20;
export const MAX_KEPT_TMP = 3;

/** Signed-out detection: Rocket Money bounces to auth.rocketaccount.com; anything off the app host is not signed in. */
export function isLoginUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname !== APP_HOST || /^\/(login|signin|sign-in)\b/i.test(u.pathname);
  } catch {
    return true;
  }
}

export const isGraphqlUrl = (url) => {
  try {
    return new URL(url).hostname === GRAPHQL_HOST && new URL(url).pathname.startsWith("/graphql");
  } catch {
    return false;
  }
};

/**
 * Read-only guard: true when a GraphQL request body contains a mutation. The harvester aborts those, so
 * even if the app fires one on its own while loading, nothing in the account can change.
 * Unknown / unparsable bodies are NOT treated as mutations (the app's reads must keep working).
 */
export function isMutationRequest(postData) {
  if (!postData) return false;
  let body;
  try {
    body = JSON.parse(postData);
  } catch {
    return /^\s*mutation\b/.test(String(postData));
  }
  const ops = Array.isArray(body) ? body : [body];
  return ops.some((op) => typeof op?.query === "string" && /^\s*(#[^\n]*\n\s*)*mutation\b/.test(op.query));
}

/** Which of the app's own GraphQL responses is this? 'networth' (NetWorthQuery), 'accounts' (SettingsAccountsPage) or null. */
export function classifyResponse(json) {
  const viewer = json?.data?.viewer;
  if (!viewer) return null;
  const nw = viewer.netWorth;
  if (nw && Array.isArray(nw.cash) && Array.isArray(nw.creditCardDebts)) return "networth";
  const masters = viewer.masterAccounts?.edges;
  if (Array.isArray(masters)) {
    const first = masters.flatMap((m) => m?.node?.accounts?.edges ?? []).map((e) => e?.node)[0];
    if (first && "number" in first && "customType" in first && "displayedBalance" in first) return "accounts";
  }
  return null;
}

const ASSET_BUCKETS = [
  ["cash", "Cash"],
  ["savings", "Cash"],
  ["investments", "Investment"],
  ["other", "Other asset"],
  ["assetsWithLoan", "Other asset"],
];
const LIABILITY_BUCKETS = [
  ["creditCardDebts", "Credit Card"],
  ["longTermDebts", "Loan"],
  ["assetBackedLoans", "Loan"],
  ["otherDebts", "Other debt"],
];

/** Rocket Money's customType -> the label its transaction export uses (checking and savings both export as "Cash"). */
export function accountTypeLabel(customType) {
  const t = String(customType ?? "").toLowerCase();
  if (t === "checking" || t === "saving" || t === "savings") return "Cash";
  if (t === "credit") return "Credit Card";
  if (t === "investment") return "Investment";
  if (t === "loan" || t === "mortgage") return "Loan";
  return t ? t[0].toUpperCase() + t.slice(1) : "Unknown";
}

const LIABILITY_TYPES = new Set(["credit", "loan", "mortgage"]);

function accountNodes(accountsJson) {
  const masters = accountsJson?.data?.viewer?.masterAccounts?.edges ?? [];
  return masters.flatMap((m) => {
    const institution = m?.node?.institution?.name ?? null;
    return (m?.node?.accounts?.edges ?? []).map((e) => ({ ...e.node, __institution: institution }));
  });
}

/**
 * Builds the balances.json entries from the two responses. Liabilities are positive amounts owed (as the app
 * shows them) with kind 'liability'; net worth = assets - liabilities.
 *   - the account list (SettingsAccountsPage) supplies name, institution, last four digits, type and balance
 *   - NetWorthQuery decides asset vs liability (joined on accountNodeId) and adds manual assets/debts that
 *     have no linked account
 */
export function buildBalanceEntries({ networth, accounts, capturedAt }) {
  const nw = networth?.data?.viewer?.netWorth ?? {};
  const kindByAccountId = new Map();
  const nwCentsByAccountId = new Map();
  for (const [bucket] of ASSET_BUCKETS) for (const a of nw[bucket] ?? []) if (a.accountNodeId) { kindByAccountId.set(a.accountNodeId, "asset"); nwCentsByAccountId.set(a.accountNodeId, a.valueCents); }
  for (const [bucket] of LIABILITY_BUCKETS) for (const a of nw[bucket] ?? []) if (a.accountNodeId) { kindByAccountId.set(a.accountNodeId, "liability"); nwCentsByAccountId.set(a.accountNodeId, a.balanceCents); }

  const entries = [];
  for (const a of accountNodes(accounts)) {
    if (a.enabled === false || a.applicable === false) continue;
    const cents = Number.isSafeInteger(a.displayedBalance) ? a.displayedBalance : nwCentsByAccountId.get(a.id);
    if (!Number.isSafeInteger(cents) || !a.name || !a.__institution) continue;
    const digits = String(a.number ?? "").replace(/\D/g, "");
    entries.push({
      institution: a.__institution,
      account_name: String(a.name).trim(),
      account_type: accountTypeLabel(a.customType),
      mask: digits ? digits.slice(-4) : null,
      balance_cents: cents,
      currency: "USD",
      kind: kindByAccountId.get(a.id) ?? (LIABILITY_TYPES.has(String(a.customType).toLowerCase()) ? "liability" : "asset"),
      captured_at: capturedAt,
    });
  }
  // Manual assets / debts (a home, a car, a private loan) have no linked account: take them from net worth.
  for (const [buckets, kind, field] of [[ASSET_BUCKETS, "asset", "valueCents"], [LIABILITY_BUCKETS, "liability", "balanceCents"]]) {
    for (const [bucket, label] of buckets) {
      for (const a of nw[bucket] ?? []) {
        if (a.accountNodeId) continue; // a linked account: the account list owns it (and if it did not return it, do not guess its identity)
        if (!Number.isSafeInteger(a[field]) || !a.name) continue;
        entries.push({
          institution: a.institution?.name || "Manual",
          account_name: String(a.name).trim(),
          account_type: label,
          mask: null,
          balance_cents: a[field],
          currency: "USD",
          kind,
          captured_at: capturedAt,
        });
      }
    }
  }
  return entries;
}

/** The 20-hour rule. A missing or unreadable timestamp never blocks a run. */
export function shouldRun({ lastAttemptAt, now = new Date(), force = false, minHours = MIN_HOURS_BETWEEN_RUNS }) {
  if (force || !lastAttemptAt) return { run: true };
  const last = new Date(lastAttemptAt);
  if (Number.isNaN(last.getTime())) return { run: true };
  const hours = (now - last) / 36e5;
  if (hours < 0 || hours >= minHours) return { run: true };
  return { run: false, hoursSince: Math.round(hours * 10) / 10 };
}

/**
 * Exclusive lock file. Returns a release function, or null when another live run holds it. A lock older than
 * staleMs (a crashed run) is taken over.
 */
export function acquireLock(path, { now = Date.now(), staleMs = 30 * 60 * 1000 } = {}) {
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      writeSync(fd, String(now));
      closeSync(fd);
      return () => {
        try { rmSync(path, { force: true }); } catch { /* already gone */ }
      };
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let age = Infinity;
      try { age = now - statSync(path).mtimeMs; } catch { continue; }
      if (age < staleMs) return null;
      try { rmSync(path, { force: true }); } catch { return null; }
    }
  }
  return null;
}

/** Which kept (failed-import) folders to recycle so that at most `keep` remain: the oldest by name (ISO stamps sort). */
export function selectToPrune(names, keep = MAX_KEPT_TMP) {
  const sorted = [...names].sort();
  return sorted.length > keep ? sorted.slice(0, sorted.length - keep) : [];
}

/** Folder name for one run's scratch files: an ISO timestamp with the colons Windows does not allow replaced. */
export const tmpFolderName = (d = new Date()) => d.toISOString().replace(/[:.]/g, "-");

export function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

/** Parses the single JSON summary line an importer prints; null if the output holds no JSON object line. */
export function parseSummaryLine(stdout) {
  const lines = String(stdout).split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("{") && l.endsWith("}"));
  for (const line of lines.reverse()) {
    try {
      return JSON.parse(line);
    } catch { /* keep looking */ }
  }
  return null;
}
