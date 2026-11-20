// Pure parsing for the rewards harvester: no I/O, no browser. Everything read from a site goes
// through the allow-lists below, so a member number, name, email, address, phone or card number
// in a response can never be copied (only the named fields are ever looked at, and only numbers,
// a tier word and a date come out).

export const PROGRAMS = {
  amex_mr: {
    label: "Amex Membership Rewards", unit: "points",
    loginUrl: "https://www.americanexpress.com/en-us/account/login",
    pages: ["https://global.americanexpress.com/rewards"],
    urlHint: /reward|points|membership|loyalty/i,
    balanceKeys: ["membershipRewardsBalance", "rewardsBalance", "pointsBalance", "availablePoints", "totalPoints", "points"],
    textBalance: [/([\d,]{3,})\s*(?:available\s*)?(?:membership rewards)?\s*points/i],
    authUrl: /login|logon|signin|sign-in|authenticate/i,
  },
  delta_skymiles: {
    label: "Delta SkyMiles", unit: "miles",
    loginUrl: "https://www.delta.com/login",
    pages: ["https://www.delta.com/myprofile/overview"],
    urlHint: /skymiles|profile|loyalty|medallion|member|mqd/i,
    balanceKeys: ["mileBalance", "skyMilesBalance", "milesBalance", "totalMiles", "miles"],
    tierKeys: ["medallionStatus", "medallionLevel", "tierName", "currentTier", "statusLevel"],
    progress: { mqd: ["mqdTotal", "mqdBalance", "currentMqd", "mqd"], mqd_goal: ["mqdGoal", "nextTierMqd", "mqdRequired", "mqdTarget"] },
    textBalance: [/([\d,]{3,})\s*miles/i],
    textTier: [/\b(Silver|Gold|Platinum|Diamond)\s+Medallion/i],
    textProgress: { mqd: [/\$?([\d,]+)\s*MQDs?\b/i] },
    authUrl: /login|signin|sign-in|authenticate/i,
  },
  hilton_honors: {
    label: "Hilton Honors", unit: "points",
    loginUrl: "https://www.hilton.com/en/auth2/guest/login/",
    pages: ["https://www.hilton.com/en/hilton-honors/guest/my-account/"],
    urlHint: /honors|loyalty|guest|account|points|tier/i,
    balanceKeys: ["hhonorsPointsBalance", "pointsBalance", "totalPoints", "availablePoints", "points"],
    tierKeys: ["tierName", "tierLevel", "tier", "honorsTier", "statusLevel"],
    progress: { nights: ["nightsStayed", "qualifyingNights", "tierNights", "nights"], nights_goal: ["nightsToNextTier", "nightsGoal", "nextTierNights"] },
    expiryKeys: ["pointsExpirationDate", "pointsExpireDate", "expirationDate", "expiryDate"],
    textBalance: [/([\d,]{3,})\s*(?:Hilton Honors\s*)?points/i],
    textTier: [/\b(Diamond|Gold|Silver|Member)\b\s*(?:tier|status)/i],
    authUrl: /login|signin|sign-in|auth2|authenticate/i,
  },
  marriott_bonvoy: {
    label: "Marriott Bonvoy", unit: "points",
    loginUrl: "https://www.marriott.com/sign-in.mi",
    pages: ["https://www.marriott.com/loyalty/myAccount/default.mi"],
    urlHint: /bonvoy|loyalty|account|elite|points|member/i,
    balanceKeys: ["pointsBalance", "availablePoints", "totalPoints", "bonvoyPoints", "points"],
    tierKeys: ["eliteLevel", "eliteTier", "tierName", "memberLevel", "statusLevel"],
    progress: { nights: ["eliteNights", "nightsCredited", "qualifyingNights", "nights"], nights_goal: ["nightsToNextLevel", "nightsGoal", "nextLevelNights"] },
    textBalance: [/([\d,]{3,})\s*(?:Bonvoy\s*)?points/i],
    textTier: [/\b(Titanium|Platinum|Gold|Silver|Member)\s+Elite/i],
    authUrl: /sign-?in|login|authenticate/i,
  },
  uber_cash: {
    label: "Uber Cash", unit: "usd",
    loginUrl: "https://auth.uber.com/v2/",
    pages: ["https://wallet.uber.com/"],
    urlHint: /wallet|cash|balance|credit|payment/i,
    balanceKeys: ["uberCashBalance", "cashBalance", "walletBalance", "balanceAmount"],
    textBalance: [/Uber Cash[^$\d]{0,40}\$\s?([\d,]+(?:\.\d{1,2})?)/i, /\$\s?([\d,]+(?:\.\d{1,2})?)[^$\d]{0,20}Uber Cash/i],
    authUrl: /auth\.uber\.com|login|signin|sign-in/i,
  },
  uber_one: {
    label: "Uber One", unit: "points", // balance 1 = member, 0 = not a member (a flag, not points)
    loginUrl: "https://auth.uber.com/v2/",
    pages: ["https://account.uber.com/", "https://www.uber.com/us/en/u/uber-one/"],
    urlHint: /membership|uber-?one|subscription|billing/i,
    memberKeys: ["isUberOneMember", "isMember", "uberOneActive", "membershipActive", "hasMembership"],
    expiryKeys: ["renewalDate", "nextBillingDate", "renewsOn", "expirationDate", "nextRenewalDate"],
    textMember: [/Uber One\s*(?:member|membership)?[^.]{0,40}\b(active|member|renews)/i],
    textExpiry: [/renews?\s*(?:on)?\s*([A-Z][a-z]{2,8}\.?\s+\d{1,2},?\s*\d{4})/i],
    authUrl: /auth\.uber\.com|login|signin|sign-in/i,
  },
};
export const PROGRAM_IDS = Object.keys(PROGRAMS);

/** Depth-first walk of any JSON value; yields [key, value] for every object property. */
export function* walk(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 12) return;
  if (Array.isArray(node)) { for (const v of node.slice(0, 200)) yield* walk(v, depth + 1); return; }
  for (const [k, v] of Object.entries(node)) {
    yield [k, v];
    yield* walk(v, depth + 1);
  }
}

export function toNumber(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const m = /^\s*\$?\s*(-?[\d,]+(?:\.\d+)?)\s*$/.exec(v);
    if (m) { const n = Number(m[1].replace(/,/g, "")); if (Number.isFinite(n)) return n; }
  }
  return null;
}

/** First numeric value for the keys, tried in priority order, across the payloads. */
export function pickNumber(payloads, keys) {
  for (const want of keys || []) {
    for (const p of payloads) {
      for (const [k, v] of walk(p)) {
        if (k.toLowerCase() !== want.toLowerCase()) continue;
        const n = toNumber(v);
        if (n !== null && n >= 0) return n;
      }
    }
  }
  return null;
}

// Tier words only: a free-text string is never copied.
const TIER_WORDS = /\b(member|silver|gold|platinum|diamond|titanium|ambassador|medallion|elite|blue|basic)\b/i;
export function pickTier(payloads, keys) {
  for (const want of keys || []) {
    for (const p of payloads) {
      for (const [k, v] of walk(p)) {
        if (k.toLowerCase() !== want.toLowerCase()) continue;
        const s = typeof v === "string" ? v : v && typeof v === "object" && typeof v.name === "string" ? v.name : null;
        if (s && s.length <= 40 && !/\d{3}/.test(s) && TIER_WORDS.test(s)) return s.trim();
      }
    }
  }
  return null;
}

export function pickBool(payloads, keys) {
  for (const want of keys || []) {
    for (const p of payloads) {
      for (const [k, v] of walk(p)) if (k.toLowerCase() === want.toLowerCase() && typeof v === "boolean") return v;
    }
  }
  return null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
/** Any plausible date text -> YYYY-MM-DD, else null. */
export function toIsoDate(v) {
  if (typeof v !== "string") return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(v.trim());
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  m = /^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s*(\d{4})$/.exec(v.trim());
  if (m) { const i = MONTHS.indexOf(m[1].toLowerCase()); if (i >= 0) return `${m[3]}-${String(i + 1).padStart(2, "0")}-${m[2].padStart(2, "0")}`; }
  return null;
}
export function pickDate(payloads, keys) {
  for (const want of keys || []) {
    for (const p of payloads) {
      for (const [k, v] of walk(p)) {
        if (k.toLowerCase() !== want.toLowerCase()) continue;
        const d = toIsoDate(v);
        if (d) return d;
      }
    }
  }
  return null;
}

function firstMatch(text, patterns) {
  for (const re of patterns || []) { const m = re.exec(text || ""); if (m) return m[1]; }
  return null;
}

/**
 * Reads one program from the JSON responses captured on its pages (`captured`: [{url, json}]) and the
 * pages' visible text. JSON first (only responses whose address matches the program's hint), then
 * text patterns as a fallback. Returns the row fields, or null when no balance could be read.
 */
export function extractProgram(id, captured, pageText) {
  const cfg = PROGRAMS[id];
  const payloads = (captured || []).filter((c) => c && c.json && cfg.urlHint.test(c.url || "")).map((c) => c.json);
  const text = pageText || "";

  if (id === "uber_one") {
    let member = pickBool(payloads, cfg.memberKeys);
    if (member === null && firstMatch(text, cfg.textMember)) member = true;
    if (member === null) return null;
    const expires = pickDate(payloads, cfg.expiryKeys) || toIsoDate(firstMatch(text, cfg.textExpiry) || "");
    return { balance: member ? 1 : 0, unit: cfg.unit, status_tier: member ? "member" : "none", status_progress: null, expires_on: expires };
  }

  let balance = pickNumber(payloads, cfg.balanceKeys);
  if (balance === null) { const t = toNumber(firstMatch(text, cfg.textBalance)); if (t !== null) balance = t; }
  if (balance === null) return null;

  const textTier = firstMatch(text, cfg.textTier);
  const tier = pickTier(payloads, cfg.tierKeys) || (textTier ? textTier.trim() : null);
  let progress = null;
  for (const [name, keys] of Object.entries(cfg.progress || {})) {
    let n = pickNumber(payloads, keys);
    if (n === null && cfg.textProgress && cfg.textProgress[name]) n = toNumber(firstMatch(text, cfg.textProgress[name]));
    if (n !== null) (progress ||= {})[name] = n;
  }
  const expires = pickDate(payloads, cfg.expiryKeys);
  return { balance, unit: cfg.unit, status_tier: tier, status_progress: progress, expires_on: expires };
}

/** True when the page ended up on a sign-in address (the session is missing or expired). */
export function looksSignedOut(id, url) {
  return PROGRAMS[id].authUrl.test(url || "");
}

// ---- --probe output: nothing here may carry an account identifier ----
// A response address or a JSON property name can itself hold a member id (/members/ID-1/, {"ID-1": ...}),
// so the probe never writes an address and never writes a property name that is not on this list.

/** Fixed endpoint labels (first match wins). The address itself is never written. */
const ENDPOINT_LABELS = [
  ["balance", /balance|points|miles|cash|wallet/i],
  ["tier-status", /tier|status|elite|medallion|honors|bonvoy|skymiles/i],
  ["membership", /member|subscription|uber-?one|billing|renew/i],
  ["profile-account", /profile|account|user|guest|customer/i],
  ["rewards-loyalty", /reward|loyalty|credit|payment/i],
];
export function endpointLabel(url) {
  const s = String(url || "").split("?")[0];
  for (const [label, re] of ENDPOINT_LABELS) if (re.test(s)) return label;
  return "other";
}

/** Property names the probe may write: every key the adapters read, plus common balance/tier/date wording. */
export const PROBE_KEYS = new Set(
  [
    ...Object.values(PROGRAMS).flatMap((c) => [
      ...(c.balanceKeys || []), ...(c.tierKeys || []), ...(c.memberKeys || []), ...(c.expiryKeys || []),
      ...Object.values(c.progress || {}).flat(),
    ]),
    "balance", "tier", "status", "level", "expirationDate", "expiryDate", "renewalDate", "nights", "miles", "points",
  ].map((k) => k.toLowerCase()),
);

/**
 * Allow-listed key names with value types (never a value), plus how many other keys were seen.
 * Unknown keys are counted, never written by name. Returns { keys: {name: type}, unknown_keys: N }.
 */
export function probeShape(json) {
  const keys = {};
  let unknown = 0;
  for (const [k, v] of walk(json)) {
    if (PROBE_KEYS.has(String(k).toLowerCase())) keys[k] = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
    else unknown++;
  }
  return { keys, unknown_keys: unknown };
}

/** Run mode from the command line. --probe is read-only (no upsert, no heartbeat) unless --save is also given. */
export function runMode(args) {
  const dry = args.includes("--dry-run");
  const probe = args.includes("--probe");
  const write = !dry && (!probe || args.includes("--save"));
  return { dry, probe, write };
}

/** The one heartbeat decision: success when every program was read, else partial naming each cause (no values). */
export function summarize(results) {
  const bad = results.filter((r) => !r.ok);
  const ok = results.length - bad.length;
  if (!bad.length) return { status: "success", records: ok, error: null };
  const err = bad.map((r) => `${r.program}: ${r.cause}`).join("; ").slice(0, 500);
  return { status: "partial", records: ok, error: err };
}
