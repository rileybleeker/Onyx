"use strict";

/**
 * Pure helpers for the production timing run (e2e/perf-timing.spec.ts and
 * e2e/perf-report.cjs). No Playwright, no network, no secrets: everything here
 * works on plain numbers and URL strings so it can be unit-tested offline
 * (frontend/tests/perf-stats.test.cjs, run by the frontend-types CI job).
 */

const REQUEST_CLASSES = [
  "document",
  "static",
  "rsc",
  "rest",
  "api",
  "worker",
  "supabase-auth",
  "other",
];

function finite(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/** Linear-interpolated percentile (the common "type 7" definition). */
function percentile(values, p) {
  const xs = values.filter(finite).sort((a, b) => a - b);
  if (xs.length === 0) return null;
  if (xs.length === 1) return xs[0];
  const rank = (p / 100) * (xs.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return xs[lo] + (xs[hi] - xs[lo]) * (rank - lo);
}

const median = (values) => percentile(values, 50);

/**
 * Put one browser request into a class and a stable endpoint key. Query strings
 * are NEVER kept (they carry filters and dates); only the path is, so the raw
 * results hold no health data and no credentials.
 *
 * @param {string} rawUrl
 * @param {string} resourceType Playwright's request.resourceType()
 * @param {string} pageOrigin   origin of the page under test, e.g. https://x.vercel.app
 * @param {string} workerHost   hostname of the agents Worker
 */
function classifyRequest(rawUrl, resourceType, pageOrigin, workerHost) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return { cls: "other", key: "(unparseable)" };
  }
  const path = u.pathname;
  const sameOrigin = u.origin === pageOrigin;

  const isSupabase = u.hostname.endsWith(".supabase.co") || u.hostname.endsWith(".supabase.in");
  if (isSupabase || (!sameOrigin && path.startsWith("/rest/v1/"))) {
    if (path.startsWith("/rest/v1/")) return { cls: "rest", key: path };
    if (path.startsWith("/auth/v1/")) return { cls: "supabase-auth", key: path };
    return { cls: "other", key: `(supabase)${path}` };
  }
  if (workerHost && u.hostname === workerHost) return { cls: "worker", key: path };
  if (!sameOrigin) return { cls: "other", key: `(external) ${u.hostname}${path}` };

  if (u.searchParams.has("_rsc")) return { cls: "rsc", key: `${path}?_rsc` };
  if (path.startsWith("/api/")) return { cls: "api", key: path };
  if (path.startsWith("/_next/")) return { cls: "static", key: "/_next/*" };
  if (resourceType === "document") return { cls: "document", key: path };
  return { cls: "other", key: path };
}

/**
 * Fold the per-request records of ONE navigation into the per-class totals and
 * per-endpoint totals stored in a sample.
 * Each record: { cls, key, startMs, endMs, durMs, bytes, failed }.
 */
function foldRequests(records) {
  const req = {};
  for (const c of REQUEST_CLASSES) req[c] = { n: 0, ms: 0, endMs: 0, bytes: 0, failed: 0 };
  const endpoints = {};
  let n = 0;
  let bytes = 0;
  for (const r of records) {
    const bucket = req[r.cls] || req.other;
    bucket.n += 1;
    bucket.bytes += r.bytes || 0;
    if (r.failed) bucket.failed += 1;
    const dur = finite(r.durMs) ? r.durMs : finite(r.endMs) ? r.endMs - r.startMs : 0;
    bucket.ms += dur;
    if (finite(r.endMs) && r.endMs > bucket.endMs) bucket.endMs = r.endMs;
    n += 1;
    bytes += r.bytes || 0;

    const ek = `${r.cls} ${r.key}`;
    const e = (endpoints[ek] ||= { cls: r.cls, key: r.key, n: 0, ms: 0, maxMs: 0, bytes: 0 });
    e.n += 1;
    e.ms += dur;
    e.bytes += r.bytes || 0;
    if (dur > e.maxMs) e.maxMs = dur;
  }
  return { req, total: { n, bytes }, endpoints };
}

const TIMING_KEYS = ["ttfb", "fcp", "lcp", "ready", "firstChart"];

/** Aggregate the samples of one page (cold = first navigation, warm = the rest). */
function summarizePage(samples) {
  const ok = samples.filter((s) => s.ok);
  const cold = samples.length > 0 && samples[0].cold ? samples[0] : null;
  const warm = ok.filter((s) => !s.cold);

  const timing = {};
  for (const k of TIMING_KEYS) {
    const xs = warm.map((s) => s[k]);
    timing[k] = { p50: percentile(xs, 50), p95: percentile(xs, 95), min: percentile(xs, 0), max: percentile(xs, 100), n: xs.filter(finite).length };
  }

  const requests = {};
  for (const c of REQUEST_CLASSES) {
    requests[c] = {
      n: median(warm.map((s) => s.req?.[c]?.n)),
      ms: median(warm.map((s) => s.req?.[c]?.ms)),
      endMs: median(warm.map((s) => s.req?.[c]?.endMs)),
      bytes: median(warm.map((s) => s.req?.[c]?.bytes)),
    };
  }
  const total = {
    n: median(warm.map((s) => s.total?.n)),
    bytes: median(warm.map((s) => s.total?.bytes)),
  };

  // Per-endpoint cost across warm navigations: median calls and median summed
  // duration per page view (an endpoint absent from a navigation counts as 0).
  const keys = new Set();
  for (const s of warm) for (const k of Object.keys(s.endpoints || {})) keys.add(k);
  const endpoints = [];
  for (const k of keys) {
    const per = warm.map((s) => s.endpoints?.[k]);
    const first = per.find(Boolean);
    const callMs = [];
    for (const e of per) if (e && e.n > 0) callMs.push(e.ms / e.n);
    endpoints.push({
      cls: first.cls,
      key: first.key,
      callsPerView: median(per.map((e) => (e ? e.n : 0))),
      msPerView: median(per.map((e) => (e ? e.ms : 0))),
      callMsP50: percentile(callMs, 50),
      callMsP95: percentile(callMs, 95),
      bytesPerView: median(per.map((e) => (e ? e.bytes : 0))),
      seenIn: per.filter(Boolean).length,
    });
  }
  endpoints.sort((a, b) => b.msPerView - a.msPerView || b.callsPerView - a.callsPerView);

  const tally = (field) => {
    const t = {};
    for (const s of samples) if (s[field]) t[s[field]] = (t[s[field]] || 0) + 1;
    return t;
  };

  return {
    total: samples.length,
    ok: ok.length,
    failed: samples.length - ok.length,
    degraded: samples.filter((s) => s.degraded).length,
    emptyState: samples.filter((s) => s.emptyState).length,
    quietTimedOut: samples.filter((s) => s.quietTimedOut).length,
    cold: cold && cold.ok ? pickCold(cold) : null,
    timing,
    requests,
    total_: total,
    endpoints,
    cache: tally("cache"),
    region: tally("region"),
  };
}

function pickCold(s) {
  return {
    ttfb: s.ttfb,
    fcp: s.fcp,
    lcp: s.lcp,
    ready: s.ready,
    firstChart: s.firstChart,
    requests: s.total?.n ?? null,
    rest: s.req?.rest?.n ?? null,
    api: s.req?.api?.n ?? null,
    bytes: s.total?.bytes ?? null,
  };
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

const ms = (v) => (finite(v) ? String(Math.round(v)) : "-");
const kb = (v) => (finite(v) ? (v / 1024).toFixed(0) : "-");
const num = (v) => (finite(v) ? (Number.isInteger(v) ? String(v) : v.toFixed(1)) : "-");
const pair = (t) => (t && t.n > 0 ? `${ms(t.p50)} / ${ms(t.p95)}` : "-");

function timingTable(pages) {
  const out = [];
  out.push("| Page | ok/total | TTFB p50 / p95 | FCP p50 / p95 | LCP p50 / p95 | Data ready p50 / p95 | First chart p50 / p95 | Cold: ready (TTFB) |");
  out.push("|---|---|---|---|---|---|---|---|");
  for (const p of pages) {
    const s = p.summary;
    const cold = s.cold ? `${ms(s.cold.ready)} (${ms(s.cold.ttfb)})` : "-";
    out.push(
      `| ${p.label} | ${s.ok}/${s.total} | ${pair(s.timing.ttfb)} | ${pair(s.timing.fcp)} | ${pair(s.timing.lcp)} | ${pair(s.timing.ready)} | ${pair(s.timing.firstChart)} | ${cold} |`
    );
  }
  return out.join("\n");
}

function requestsTable(pages) {
  const out = [];
  out.push("| Page | Requests (all) | /rest/v1 n | /rest/v1 summed ms | /rest/v1 last finish (ms) | /api n | /api summed ms | worker n | RSC n | KB transferred (all) | KB /rest/v1 |");
  out.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const p of pages) {
    const r = p.summary.requests;
    out.push(
      `| ${p.label} | ${num(p.summary.total_.n)} | ${num(r.rest.n)} | ${ms(r.rest.ms)} | ${ms(r.rest.endMs)} | ${num(r.api.n)} | ${ms(r.api.ms)} | ${num(r.worker.n)} | ${num(r.rsc.n)} | ${kb(p.summary.total_.bytes)} | ${kb(r.rest.bytes)} |`
    );
  }
  return out.join("\n");
}

function endpointTable(pages, perPage = 5) {
  const out = [];
  out.push("| Page | Endpoint (class, path) | calls / view | summed ms / view | per-call p50 / p95 ms | KB / view |");
  out.push("|---|---|---|---|---|---|");
  for (const p of pages) {
    const rows = p.summary.endpoints.filter((e) => e.cls === "rest" || e.cls === "api" || e.cls === "worker").slice(0, perPage);
    for (const e of rows) {
      out.push(
        `| ${p.label} | ${e.cls} ${e.key} | ${num(e.callsPerView)} | ${ms(e.msPerView)} | ${ms(e.callMsP50)} / ${ms(e.callMsP95)} | ${kb(e.bytesPerView)} |`
      );
    }
  }
  return out.join("\n");
}

function runNotes(pages) {
  const lines = [];
  for (const p of pages) {
    const s = p.summary;
    const bits = [];
    if (s.failed) bits.push(`${s.failed} navigation(s) failed to reach the data-ready state`);
    if (s.degraded) bits.push(`${s.degraded} showed an error/degraded state`);
    if (s.emptyState) bits.push(`${s.emptyState} ended on the page's empty state (no chart drawn)`);
    if (s.quietTimedOut) bits.push(`${s.quietTimedOut} never went network-quiet within the window cap`);
    const cache = Object.entries(s.cache).map(([k, v]) => `${k}:${v}`).join(" ");
    const region = Object.entries(s.region).map(([k, v]) => `${k}:${v}`).join(" ");
    if (cache) bits.push(`document x-vercel-cache ${cache}`);
    if (region) bits.push(`edge/function region ${region}`);
    if (bits.length) lines.push(`- ${p.label}: ${bits.join("; ")}`);
  }
  return lines.join("\n");
}

/** Side-by-side p50 stability across repeated runs of the same suite. */
function stabilityTable(runs) {
  if (runs.length < 2) return "";
  const labels = runs[0].pages.map((p) => p.label);
  const out = [];
  const head = ["Page", "Metric"];
  runs.forEach((_, i) => head.push(`run ${i + 1} p50`));
  head.push("max spread");
  out.push(`| ${head.join(" | ")} |`);
  out.push(`|${head.map(() => "---").join("|")}|`);
  for (const label of labels) {
    for (const [metric, key] of [["TTFB", "ttfb"], ["Data ready", "ready"]]) {
      const vals = runs.map((r) => r.pages.find((p) => p.label === label)?.summary.timing[key].p50);
      const good = vals.filter(finite);
      const spread = good.length > 1 ? ((Math.max(...good) - Math.min(...good)) / Math.min(...good)) * 100 : null;
      out.push(`| ${label} | ${metric} | ${vals.map(ms).join(" | ")} | ${finite(spread) ? spread.toFixed(0) + "%" : "-"} |`);
    }
  }
  return out.join("\n");
}

module.exports = {
  REQUEST_CLASSES,
  percentile,
  median,
  classifyRequest,
  foldRequests,
  summarizePage,
  timingTable,
  requestsTable,
  endpointTable,
  runNotes,
  stabilityTable,
};
