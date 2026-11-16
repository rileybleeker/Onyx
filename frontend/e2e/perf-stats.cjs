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

/**
 * x-vercel-id looks like "iad1::<request-id>" when the CDN answered and
 * "iad1::iad1::<request-id>" when a function ran. The request id differs on every
 * response, so keep only the region part(s): "iad1 (cdn)" or "iad1>iad1 (function)".
 * Also repairs the first run's samples, which kept the request id as a second part.
 */
function normRegion(raw) {
  if (!raw) return null;
  const parts = String(raw).split(/>|::/);
  const looksLikeId = (x) => /-\d{9,}-/.test(x) || x.length > 12;
  if (parts.length >= 2 && !looksLikeId(parts[1])) return `${parts[0]}>${parts[1]} (function)`;
  return `${parts[0]} (cdn)`;
}

// ---------------------------------------------------------------------------
// Harness version 2 (2026-11-16): scenario and cache state, a fixed observation window split by purpose, request
// origin (network / browser cache / service worker / unknown), sample sizes with robust percentiles, the measured
// production revision and an observe-only phone scenario. Result files without `meta.harness` are version 1; every
// field version 1 recorded keeps its definition, so an older artifact stays a valid baseline.
// ---------------------------------------------------------------------------

const HARNESS_VERSION = 2;
/** Below this many samples a p95 is the worst sample or close to it: the report says so. */
const LOW_N = 10;
/**
 * The observe-only phone scenario runs only on runs of at most this many navigations per page (the hourly run). A
 * manual deep run skips it so its extra minutes never push the run into the job timeout, where it would be cancelled
 * before the speed budget is evaluated; the report says it was not run, never that it was measured.
 */
const PHONE_MAX_RUN_NAVIGATIONS = 4;

/**
 * An error as one short line for a result file: its first line, any address replaced by "<url>" (a result file never
 * holds a URL), at most `max` characters. "unknown error" when there is no message.
 */
function errorLine(err, max = 200) {
  const raw = err && typeof err === "object" && "message" in err ? err.message : err;
  const line = String(raw == null ? "" : raw).split("\n")[0].replace(/https?:\/\/\S+/g, "<url>").trim();
  return (line || "unknown error").slice(0, max);
}

/** True when the error (or reason string) is the harness's bounce to the login page (the saved session was refused). */
const isLoginBounce = (err) => /^bounced-to-login\b/.test(errorLine(err));

/**
 * Why an observe-only loop (the phone scenario) ended early on a failure, for its result file's `stopped`: a bounce to
 * the login page, or the error's first line. `tried` of `planned` navigations / taps were tried before it ended; the
 * rest are not measured, never a pass. The observe-only test itself does not fail on it, so the run's exit code and
 * the enforced speed-budget step depend on the enforced (desktop) pages only, which still fail on a bounce as before.
 */
function observeOnlyStop(err, tried, planned, unit) {
  const what = isLoginBounce(err)
    ? "bounced to the login page (the saved session was not accepted)"
    : `stopped by an error (${errorLine(err, 120)})`;
  return `${what}: ${tried} of ${planned} ${unit} tried`;
}

/** n plus robust spread (median, quartiles, MAD) of one population; never throws on empty input. */
function robust(values) {
  const xs = (values || []).filter(finite).sort((a, b) => a - b);
  const n = xs.length;
  if (n === 0) return { n: 0, p50: null, p75: null, p90: null, p95: null, min: null, max: null, iqr: null, mad: null, lowN: true };
  const p50 = percentile(xs, 50);
  return {
    n,
    p50,
    p75: percentile(xs, 75),
    p90: percentile(xs, 90),
    p95: percentile(xs, 95),
    min: xs[0],
    max: xs[n - 1],
    iqr: percentile(xs, 75) - percentile(xs, 25),
    mad: percentile(xs.map((v) => Math.abs(v - p50)), 50),
    lowN: n < LOW_N,
  };
}

/** Where a response came from. "unknown" whenever the browser did not say (probe missing, request still open). */
const VIAS = ["network", "memory-cache", "disk-cache", "prefetch-cache", "service-worker", "unknown"];
const CACHED_VIAS = new Set(["memory-cache", "disk-cache", "prefetch-cache"]);

/**
 * @param {{servedFromCache?: boolean, fromDiskCache?: boolean, fromPrefetchCache?: boolean, fromServiceWorker?: boolean, responded?: boolean}|undefined} info
 *   what the browser's network log (Chrome DevTools protocol) reported for one request
 */
function viaOf(info) {
  if (!info) return "unknown";
  if (info.fromServiceWorker) return "service-worker";
  if (info.servedFromCache) return "memory-cache";
  if (info.fromDiskCache) return "disk-cache";
  if (info.fromPrefetchCache) return "prefetch-cache";
  if (info.responded) return "network";
  return "unknown";
}

/**
 * Why a request ran, as far as the outside of the browser can tell:
 *   prefetch   = a router prefetch (Next's prefetch header, or an RSC request sent at low priority): warm-up or hover;
 *   routed     = started before the routed page reached data-ready (what the page waited for, or competed with);
 *   background = started after data-ready (neighbour pages of the continuous scroll, the warm-up's data reads,
 *                silent revalidation);
 *   unknown    = the page never reached data-ready, so there is nothing to split on.
 * The split is by start time only: on a page slow enough that the continuous scroll (about 2 s after the page opened)
 * or the warm-up (about 2.5 s after load) starts before data-ready, their requests count as routed. So "routed" is an
 * upper bound on what the routed page itself waited for, exact only for a page that is ready before those start.
 */
const PURPOSES = ["routed", "background", "prefetch", "unknown"];
function purposeOf(rec, readyAtMs) {
  if (rec && rec.prefetch) return "prefetch";
  if (!finite(readyAtMs)) return "unknown";
  return rec.startMs < readyAtMs ? "routed" : "background";
}

const DATA_CLASSES = new Set(["rest", "api", "worker", "supabase-auth"]);

/**
 * How a fixed window's start was found. It is part of the method: only the first two give a comparable window.
 *   navigation-start  a full load: request clock 0;
 *   input             an in-app click: the first pointer event on the link, seen on the same document at or after the
 *                     click was prepared (`inputAnchorOf`);
 *   unobserved        an in-app click whose input was not seen (the pointer read failed or saw no event, or the click
 *                     loaded a new document). Where its window starts is unknown, so the window is recorded as
 *                     unknown (`complete: false`, no counts) and never counted. The click call's own time is NOT used
 *                     as a stand-in: it comes before Playwright's actionability wait, which can use the window up.
 */
const ANCHOR_KINDS = ["navigation-start", "input", "unobserved"];

/** The anchor kind a foldWindow() call gets: an anchor after 0 must say it was an observed input, else it is unobserved. */
function anchorKindOf(anchorMs, anchorKind) {
  if (anchorKind === "input" && finite(anchorMs)) return "input";
  const at = finite(anchorMs) ? anchorMs : 0;
  if ((anchorKind == null || anchorKind === "navigation-start") && at === 0) return "navigation-start";
  return "unobserved";
}

/**
 * Where an in-app click's fixed window starts, from the pointer read made after the click (perf-timing.spec.ts):
 *   pointer      [page time of the first pointer event on the link or null, that document's time origin], or null
 *                when the read itself failed;
 *   clickOrigin  time origin of the document the click was prepared on;
 *   markedAt     page time on that document just before the click call;
 *   clickAtMs    the same moment on the request clock.
 * Only a pointer event seen on the SAME document, at or after the mark, is an observed input: the window starts there
 * (`kind: "input"`, `anchorMs` on the request clock, `clickWaitMs` = Playwright's actionability wait). Anything else
 * is `kind: "unobserved"` with the reason and no anchor; see ANCHOR_KINDS.
 */
function inputAnchorOf({ pointer, clickOrigin, markedAt, clickAtMs }) {
  const unobserved = (reason) => ({ kind: "unobserved", reason, anchorMs: null, clickWaitMs: null });
  if (!Array.isArray(pointer)) return unobserved("pointer read failed");
  const [at, origin] = pointer;
  if (!finite(origin) || origin !== clickOrigin) return unobserved("the click loaded a new document");
  if (!finite(at)) return unobserved("no pointer event seen on the link");
  if (!finite(markedAt) || !finite(clickAtMs) || at < markedAt) return unobserved("pointer event before the click was prepared");
  const wait = at - markedAt;
  return { kind: "input", reason: null, anchorMs: clickAtMs + wait, clickWaitMs: wait };
}

/**
 * Page time `pageMs` on the document with time origin `docOrigin`, as ms since the click was prepared (`markedAt` on
 * the document with time origin `clickOrigin`): how version 1 times an in-app click's data ready and first chart.
 * Same document: the plain difference, exactly as version 1. When the click loaded a new document, its page clock
 * restarted at 0, so both moments go on the shared clock (time origin + page time): the reload is counted, and the
 * result is never a negative time that would pass the budget. Null (not measured) when a moment is missing.
 */
function sinceClickMs(pageMs, docOrigin, markedAt, clickOrigin) {
  if (!finite(pageMs) || !finite(markedAt)) return null;
  if (docOrigin === clickOrigin) return pageMs - markedAt;
  if (!finite(docOrigin) || !finite(clickOrigin)) return null;
  return docOrigin + pageMs - (clickOrigin + markedAt);
}

/** A window that may be counted: observed to its end, from a known start (never an unobserved or unlabelled one). */
function comparableWindow(w) {
  return !!(w && w.complete && (w.anchor === "navigation-start" || w.anchor === "input"));
}

/**
 * The requests that STARTED inside a fixed window [anchorMs, anchorMs + windowMs) on the request clock, split by
 * purpose and by origin. The anchor is the navigation itself: 0 (navigation start) for a full load, the observed input
 * for an in-app navigation (`anchorKind: "input"`), so preparing the click (scrolling to the link, marking the old
 * page, Playwright's actionability checks) never uses up the window and the previous page's leftover work is counted
 * apart as `beforeAnchor`, never in this page's buckets. An anchor after 0 that is not an observed input (no
 * `anchorKind`, or `"unobserved"` with `anchorReason`) gives an unknown window: `anchor: "unobserved"`,
 * `complete: false`, no counts and no times, whatever was observed (see ANCHOR_KINDS). A fixed window
 * makes request totals comparable between pages and runs (the network-quiet window closes at a different moment on
 * every page). `observedMs` = how long the navigation was observed (request clock); a window not observed to its end
 * after the anchor is `complete: false` and is never counted as a measurement. A request still open when observation
 * stopped is counted as `pending`: its duration and size are unknown and are never added as zero (`costComplete`).
 * `settleByMs` (request clock) is the one moment the window's cost is decided at (the window's end plus the drain):
 * a request that finished after it is `pending` too, even when observation went on longer (the network-quiet wait
 * of version 1 closes at a different moment on every navigation), so the same request is counted the same way
 * whatever else was on the network. In the result, `readyAtMs`, `observedMs` and `settleByMs` are relative to the
 * window start.
 */
function foldWindow(records, { windowMs, readyAtMs, observedMs, anchorMs = 0, settleByMs = null, anchorKind = null, anchorReason = null }) {
  const kind = anchorKindOf(anchorMs, anchorKind);
  if (kind === "unobserved") {
    // Where the window starts is unknown, so what started in it is too: nothing is counted, nothing is complete.
    return {
      windowMs,
      anchor: kind,
      anchorReason: anchorReason || "the window's start was not observed",
      anchorMs: null,
      readyAtMs: null,
      observedMs: null,
      settleByMs: null,
      complete: false,
      costComplete: null,
      beforeAnchor: null,
      total: null,
      purpose: null,
      via: null,
    };
  }
  const anchor = finite(anchorMs) ? anchorMs : 0;
  const end = anchor + windowMs;
  const settleBy = finite(settleByMs) ? settleByMs : null;
  const bucket = () => ({ n: 0, data: 0, ms: 0, bytes: 0, pending: 0, network: 0, cached: 0, serviceWorker: 0, unknownVia: 0, cls: {} });
  const purpose = {};
  for (const p of PURPOSES) purpose[p] = bucket();
  const via = {};
  for (const v of VIAS) via[v] = 0;
  const beforeAnchor = { n: 0, data: 0 };
  let n = 0;
  let bytes = 0;
  let pending = 0;
  for (const r of records || []) {
    if (!r || !finite(r.startMs)) continue;
    if (r.startMs < anchor) {
      beforeAnchor.n += 1;
      if (DATA_CLASSES.has(r.cls)) beforeAnchor.data += 1;
      continue;
    }
    if (r.startMs >= end) continue;
    const b = purpose[purposeOf(r, readyAtMs)];
    const v = VIAS.includes(r.via) ? r.via : "unknown";
    const settled = finite(r.durMs) || finite(r.endMs);
    // Finished after the moment the cost is decided at: unfinished, whatever happened later.
    const late = settleBy != null && finite(r.endMs) && r.endMs > settleBy;
    const finished = settled && !late;
    b.n += 1;
    if (DATA_CLASSES.has(r.cls)) b.data += 1;
    if (finished) {
      b.ms += finite(r.durMs) ? r.durMs : r.endMs - r.startMs;
      b.bytes += r.bytes || 0;
      bytes += r.bytes || 0;
    } else {
      b.pending += 1;
      pending += 1;
    }
    if (v === "network") b.network += 1;
    else if (CACHED_VIAS.has(v)) b.cached += 1;
    else if (v === "service-worker") b.serviceWorker += 1;
    else b.unknownVia += 1;
    b.cls[r.cls] = (b.cls[r.cls] || 0) + 1;
    via[v] += 1;
    n += 1;
  }
  return {
    windowMs,
    anchor: kind,
    anchorReason: null,
    anchorMs: anchor,
    readyAtMs: finite(readyAtMs) ? readyAtMs - anchor : null,
    observedMs: finite(observedMs) ? observedMs - anchor : null,
    settleByMs: settleBy != null ? settleBy - anchor : null,
    complete: finite(observedMs) && finite(windowMs) && observedMs - anchor >= windowMs,
    costComplete: pending === 0,
    beforeAnchor,
    total: { n, bytes, pending },
    purpose,
    via,
  };
}

/**
 * Main-thread long tasks (over 50 ms) that started in [fromMs, toMs): count, total, blocking time (the part of each
 * task over 50 ms, as in Total Blocking Time) and the longest. `entries` are [startMs, durationMs] on one clock.
 */
function foldLongTasks(entries, fromMs, toMs, readyAtMs) {
  let n = 0;
  let totalMs = 0;
  let blockingMs = 0;
  let maxMs = 0;
  let beforeReady = 0;
  for (const e of entries || []) {
    const start = e && e[0];
    const dur = e && e[1];
    if (!finite(start) || !finite(dur) || start < fromMs || start >= toMs) continue;
    const b = Math.max(0, dur - 50);
    n += 1;
    totalMs += dur;
    blockingMs += b;
    if (dur > maxMs) maxMs = dur;
    if (finite(readyAtMs) && start < readyAtMs) beforeReady += b;
  }
  return { n, totalMs, blockingMs, maxMs, blockingBeforeReadyMs: finite(readyAtMs) ? beforeReady : null };
}

/**
 * The cache state of one navigation, with what cannot be known said as such.
 *   browser: "empty" (first navigation in a fresh context), "warm" (later navigations in it), or "prewarmed" (an
 *            in-app click after Today loaded and its warm-up ran: client cache, router prefetch, HTTP cache);
 *   cdn:     the document's x-vercel-cache header (HIT, MISS, STALE, PRERENDER, ...), "unknown" without one, "n/a"
 *            for an in-app click (no document request);
 *   fn:      "ran" when x-vercel-id shows a function region, "not-run" when only the edge answered, else "unknown";
 *   fnWarmth: whether a function that ran was cold is never visible from the browser: always "unknown" then.
 */
function cacheStateOf({ mode, first, vercelCache, vercelId }) {
  if (mode === "click") return { browser: "prewarmed", cdn: "n/a", fn: "n/a", fnWarmth: "n/a" };
  const browser = first ? "empty" : "warm";
  const cdn = vercelCache ? String(vercelCache).toUpperCase() : "unknown";
  const region = normRegion(vercelId);
  const fn = !region ? "unknown" : region.endsWith("(function)") ? "ran" : "not-run";
  return { browser, cdn, fn, fnWarmth: fn === "ran" ? "unknown" : "n/a" };
}

/**
 * The production build a result file measured, from /api/version read at the start and at the end of the page:
 *   the SHA       only when BOTH reads succeeded and agree (the only value that binds a result to one build);
 *   "mixed"       both reads succeeded and differ (a deploy landed during the page);
 *   "partial"     only one read succeeded: a deploy may have landed and nobody saw it, so the result is unbound;
 *   "unknown"     neither read succeeded;
 *   null          not recorded at all (harness 1).
 */
function revisionOf(meta) {
  const d = meta && meta.deployed;
  if (!d) return null;
  const start = d.start || null;
  const end = d.end || null;
  if (start && end) return start === end ? start : "mixed";
  if (start || end) return "partial";
  return "unknown";
}

/** True only for a revision bound to one build (an exact SHA from revisionOf, never mixed / partial / unknown / null). */
function isExactRevision(rev) {
  return typeof rev === "string" && /^[0-9a-f]{7,40}$/i.test(rev);
}

/** Short tag of a revision: 7 characters of an exact SHA, else what made it unbound. */
function revisionTag(rev) {
  if (isExactRevision(rev)) return String(rev).slice(0, 7);
  return rev === "mixed" || rev === "partial" || rev === "unknown" ? rev : "not recorded";
}

/** Scenario name, enforcement and harness version of a result file (version 1 files carry none of them). */
function scenarioOf(meta, slug) {
  const m = meta || {};
  const s = m.scenario || {};
  const name = s.name || (String(slug || m.slug || "").startsWith("nav-") ? "in-app-prewarmed" : "full-load");
  return { name, enforced: s.enforced !== false, harness: finite(m.harness) ? m.harness : 1, detail: m.scenario || null };
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
    const n = xs.filter(finite).length;
    timing[k] = { p50: percentile(xs, 50), p90: percentile(xs, 90), p95: percentile(xs, 95), min: percentile(xs, 0), max: percentile(xs, 100), n, lowN: n < LOW_N, values: xs.filter(finite) };
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
    // The slowest single call in each warm view: the budget is about any one call, so a 1500 ms call next to a
    // 100 ms one must not average to 800 ms (Codex review 2026-11-14).
    const maxPerView = per.filter((e) => e && e.n > 0).map((e) => (finite(e.maxMs) ? e.maxMs : e.ms / e.n));
    endpoints.push({
      cls: first.cls,
      key: first.key,
      callsPerView: median(per.map((e) => (e ? e.n : 0))),
      msPerView: median(per.map((e) => (e ? e.ms : 0))),
      callMsP50: percentile(callMs, 50),
      callMsP95: percentile(callMs, 95),
      callMsMax: percentile(maxPerView, 100),
      callMaxP95: percentile(maxPerView, 95),
      maxPerView,
      bytesPerView: median(per.map((e) => (e ? e.bytes : 0))),
      seenIn: per.filter(Boolean).length,
    });
  }
  // The cold (first) navigation's calls, kept separately: a first visit is something Riley waits for too.
  const coldEndpoints = [];
  if (cold && cold.ok) {
    for (const e of Object.values(cold.endpoints || {})) {
      if (e && e.n > 0) coldEndpoints.push({ cls: e.cls, key: e.key, maxMs: finite(e.maxMs) ? e.maxMs : e.ms / e.n });
    }
  }
  endpoints.sort((a, b) => b.msPerView - a.msPerView || b.callsPerView - a.callsPerView);

  const tally = (field) => {
    const t = {};
    for (const s of samples) if (s[field]) t[s[field]] = (t[s[field]] || 0) + 1;
    return t;
  };

  // Harness 2 fields. A version 1 sample has none of them, so each is then null / empty (never zero). Only comparable
  // windows count (observed to their end from a known start): an incomplete or unobserved one is never averaged in.
  const windowOf = (xs) => {
    const ws = xs.map((s) => s.window).filter(comparableWindow);
    if (ws.length === 0) return null;
    const purpose = {};
    for (const p of PURPOSES) {
      purpose[p] = {};
      for (const f of ["n", "data", "network", "cached", "serviceWorker", "unknownVia", "pending", "bytes", "ms"]) purpose[p][f] = median(ws.map((w) => w.purpose?.[p]?.[f]));
    }
    const via = {};
    for (const v of VIAS) via[v] = median(ws.map((w) => w.via?.[v]));
    return {
      windowMs: ws[0].windowMs,
      n: ws.length,
      // Anchored at the observed click input (in-app) rather than at navigation start: what started before it is shown apart.
      anchored: ws.some((w) => w.anchor === "input"),
      beforeAnchor: median(ws.map((w) => w.beforeAnchor?.n)),
      total: median(ws.map((w) => w.total?.n)),
      bytes: median(ws.map((w) => w.total?.bytes)),
      // Windows in which a request was still open when observation stopped: its cost is unknown, never zero.
      pending: median(ws.map((w) => w.total?.pending)),
      withPending: ws.filter((w) => finite(w.total?.pending) && w.total.pending > 0).length,
      purpose,
      via,
    };
  };
  const stateKey = (c) => (c ? `${c.browser} cdn:${c.cdn} fn:${c.fn}` : null);
  const restStates = {};
  for (const s of samples.slice(1)) {
    const k = stateKey(s.cacheState);
    if (k) restStates[k] = (restStates[k] || 0) + 1;
  }

  // Blocking time and the window's moments are relative to the window start: only comparable windows' are pooled.
  const windowed = warm.filter((s) => comparableWindow(s.window));

  return {
    harness2: samples.some((s) => s.window || s.cacheState),
    windows: {
      recorded: samples.filter((s) => s.window).length,
      complete: samples.filter((s) => comparableWindow(s.window)).length,
      // In-app clicks whose input was not seen: their window is unknown (not measured), never counted as one.
      unobserved: samples.filter((s) => s.window && s.window.anchor === "unobserved").length,
    },
    window: windowOf(warm),
    coldWindow: cold && cold.ok ? windowOf([cold]) : null,
    cacheStates: { first: samples[0] && samples[0].cacheState ? samples[0].cacheState : null, rest: restStates },
    readyRobust: robust(warm.map((s) => s.ready)),
    blocking: robust(windowed.map((s) => s.longTasks?.blockingMs)),
    blockingBeforeReady: robust(windowed.map((s) => s.longTasks?.blockingBeforeReadyMs)),
    feedAt: robust(windowed.map((s) => s.feedAtMs)),
    firstPrefetchAt: robust(windowed.map((s) => s.firstPrefetchAtMs)),
    total: samples.length,
    ok: ok.length,
    failed: samples.length - ok.length,
    degraded: samples.filter((s) => s.degraded).length,
    emptyState: samples.filter((s) => s.emptyState).length,
    quietTimedOut: samples.filter((s) => s.quietTimedOut).length,
    newDocument: samples.filter((s) => s.newDocument).length,
    cold: cold && cold.ok ? pickCold(cold) : null,
    coldEndpoints,
    timing,
    requests,
    total_: total,
    endpoints,
    cache: tally("cache"),
    region: (() => {
      const t = {};
      for (const x of samples) {
        const r = normRegion(x.region);
        if (r) t[r] = (t[r] || 0) + 1;
      }
      return t;
    })(),
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

/**
 * Phone input responsiveness (harness 2, `meta.kind: "input"`): one sample per tap. Per action, in the order the
 * actions were first tried: how many were measured, why the others were not, and robust stats of
 *   inputMs    = finger down to the next frame painted after the click handlers (the INP-style latency),
 *   eventMs    = the longest Event Timing entry of the interaction (null below the API's 16 ms threshold),
 *   readyMs    = finger down to the screen the tap opens being ready,
 *   blockingMs = long-task blocking time from the tap to ready + the settle time.
 * A sample that is not ok never contributes a number: a missing measurement is shown as missing, never as fast.
 */
function summarizeInput(samples) {
  const order = [];
  for (const s of samples || []) if (s && !order.includes(s.action)) order.push(s.action);
  const actions = order.map((action) => {
    const xs = samples.filter((s) => s && s.action === action);
    const ok = xs.filter((s) => s.ok);
    const errors = {};
    for (const s of xs) if (!s.ok) errors[s.error || "not measured"] = (errors[s.error || "not measured"] || 0) + 1;
    return {
      action,
      total: xs.length,
      ok: ok.length,
      failed: xs.length - ok.length,
      errors,
      inputMs: robust(ok.map((s) => s.inputMs)),
      eventMs: robust(ok.map((s) => s.eventMs)),
      readyMs: robust(ok.map((s) => s.readyMs)),
      blockingMs: robust(ok.map((s) => s.longTasks?.blockingMs)),
    };
  });
  const all = samples || [];
  return { total: all.length, ok: all.filter((s) => s && s.ok).length, actions };
}

// ---------------------------------------------------------------------------
// Markdown rendering
// ---------------------------------------------------------------------------

const ms = (v) => (finite(v) ? String(Math.round(v)) : "-");
const kb = (v) => (finite(v) ? (v / 1024).toFixed(0) : "-");
const num = (v) => (finite(v) ? (Number.isInteger(v) ? String(v) : v.toFixed(1)) : "-");
const pair = (t) => (t && t.n > 0 ? `${ms(t.p50)} / ${ms(t.p95)}` : "-");

const isPrewarmed = (p) => p.scenario === "in-app-prewarmed" || (!p.scenario && String(p.slug || "").startsWith("nav-"));
const short = (sha) =>
  isExactRevision(sha) ? String(sha).slice(0, 7)
    : sha === "mixed" ? "mixed (deploy during the page)"
      : sha === "partial" ? "unbound (only one of the start / end reads succeeded)"
        : sha === "unknown" ? "unknown (neither read succeeded)"
          : "not recorded";

function timingTable(pages) {
  const out = [];
  out.push("| Page | ok/total | TTFB p50 / p95 | FCP p50 / p95 | LCP p50 / p95 | Data ready p50 / p95 | First chart p50 / p95 | First navigation: ready (TTFB) |");
  out.push("|---|---|---|---|---|---|---|---|");
  for (const p of pages) {
    const s = p.summary;
    // An in-app click has no document of its own: its first round is the first visit of a session Today already
    // warmed (client cache, router prefetch, HTTP cache), so it is labelled that way and never called cold.
    const cold = !s.cold ? "-" : isPrewarmed(p) ? `${ms(s.cold.ready)} (first visit, prewarmed)` : `${ms(s.cold.ready)} (${ms(s.cold.ttfb)})`;
    out.push(
      `| ${p.label} | ${s.ok}/${s.total} | ${pair(s.timing.ttfb)} | ${pair(s.timing.fcp)} | ${pair(s.timing.lcp)} | ${pair(s.timing.ready)} | ${pair(s.timing.firstChart)} | ${cold} |`
    );
  }
  return out.join("\n");
}

function requestsTable(pages) {
  const out = [];
  out.push("| Page | Requests (all, until network-quiet) | /rest/v1 n | /rest/v1 summed ms | /rest/v1 last finish (ms) | /api n | /api summed ms | worker n | RSC prefetch n / summed ms | static chunk n | KB transferred (all) | KB /rest/v1 |");
  out.push("|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const p of pages) {
    const r = p.summary.requests;
    out.push(
      `| ${p.label} | ${num(p.summary.total_.n)} | ${num(r.rest.n)} | ${ms(r.rest.ms)} | ${ms(r.rest.endMs)} | ${num(r.api.n)} | ${ms(r.api.ms)} | ${num(r.worker.n)} | ${num(r.rsc.n)} / ${ms(r.rsc.ms)} | ${num(r.static.n)} | ${kb(p.summary.total_.bytes)} | ${kb(r.rest.bytes)} |`
    );
  }
  return out.join("\n");
}

function endpointTable(pages, perPage = 5) {
  const out = [];
  out.push("| Page | Endpoint (class, path) | calls / view | summed ms / view | per-call p50 / p95 ms | slowest call (max / p95 of views) ms | KB / view |");
  out.push("|---|---|---|---|---|---|---|");
  for (const p of pages) {
    const rows = p.summary.endpoints.filter((e) => e.cls === "rest" || e.cls === "api" || e.cls === "worker").slice(0, perPage);
    for (const e of rows) {
      out.push(
        `| ${p.label} | ${e.cls} ${e.key} | ${num(e.callsPerView)} | ${ms(e.msPerView)} | ${ms(e.callMsP50)} / ${ms(e.callMsP95)} | ${ms(e.callMsMax)} / ${ms(e.callMaxP95)} | ${kb(e.bytesPerView)} |`
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
    if (s.newDocument) bits.push(`${s.newDocument} in-app click(s) loaded a new document (a full reload, timed from the click on the shared clock)`);
    const cache = Object.entries(s.cache).map(([k, v]) => `${k}:${v}`).join(" ");
    const region = Object.entries(s.region).map(([k, v]) => `${k}:${v}`).join(" ");
    if (cache) bits.push(`document x-vercel-cache ${cache}`);
    if (region) bits.push(`edge/function region ${region}`);
    if (bits.length) lines.push(`- ${p.label}: ${bits.join("; ")}`);
  }
  return lines.join("\n");
}

/**
 * Scenario, cache state and revision per page (harness 2). The browser cache of the first navigation is stated
 * separately from the CDN and the function, which the run cannot control; a function's cold or warm start is never
 * visible from the browser and is always "unknown".
 */
function scenarioTable(pages) {
  const out = [];
  out.push("| Page | Scenario | Viewport / CPU | Budget | First navigation: browser / CDN / function | Later navigations | Function warmth | Production revision |");
  out.push("|---|---|---|---|---|---|---|---|");
  for (const p of pages) {
    const s = p.summary;
    const d = p.detail || {};
    const view = d.viewport ? `${d.viewport}${d.cpuSlowdown > 1 ? `, CPU ${d.cpuSlowdown}x slower` : ""}` : "not recorded";
    const first = s.cacheStates && s.cacheStates.first;
    const rest = s.cacheStates ? Object.entries(s.cacheStates.rest).map(([k, v]) => `${k} x${v}`).join(", ") : "";
    const ran = !!first && (first.fn === "ran" || Object.keys(s.cacheStates.rest).some((k) => k.endsWith("fn:ran")));
    const firstCell = first ? `${first.browser} / ${first.cdn} / ${first.fn}` : "not recorded (harness 1)";
    const warmth = !first ? "not recorded" : ran ? "unknown" : "n/a";
    out.push(`| ${p.label} | ${p.scenario || "full-load"} | ${view} | ${p.enforced === false ? "observed only" : "enforced"} | ${firstCell} | ${rest || "-"} | ${warmth} | ${short(p.revision)} |`);
  }
  return out.join("\n");
}

/**
 * Routed readiness against background work, in the fixed window (warm median). The window starts at navigation start
 * for a full load and at the click's observed input for an in-app navigation; requests that started before it (the
 * previous page's leftovers, preparing the click) are counted apart and excluded. A click whose input was not observed
 * has an unknown window: it is counted in "recorded" and named in the same cell, never in the medians. Routed = started before data-ready,
 * background = after it (continuous-scroll neighbours, warm-up data, revalidation), prefetch = router prefetches; the
 * split is by start time only, so on a slow page routed also holds neighbour and warm-up reads that began early. Each
 * count is split into network / browser cache / service worker / unknown; requests whose origin the browser did not
 * report are counted as unknown, never as network or cache. A request still open when observation stopped is listed
 * as unfinished (cost unknown), never as a zero-cost request.
 */
function windowTable(pages) {
  const out = [];
  out.push("| Page | Fixed window (ms, from) | Windows complete / recorded (navigations) | Data ready p50 / p90 (n) | Routed: requests network / cached / SW / unknown | Routed data calls | Background: requests network / cached / SW / unknown | Background data calls | Prefetch n | Unfinished at window end (cost unknown) | Started before the click (excluded) | KB routed / background | Neighbour page shown at p50 (ms into the window) | First prefetch at p50 (ms into the window) | Blocking time p50 before ready / window (ms) | First navigation: routed / background / prefetch requests |");
  out.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const p of pages) {
    const s = p.summary;
    const w = s.window;
    const rr = s.readyRobust || { n: 0 };
    const readyCell = rr.n ? `${ms(rr.p50)} / ${ms(rr.p90)} (${rr.n})` : "-";
    const unobserved = s.windows && s.windows.unobserved > 0 ? `; ${s.windows.unobserved} with the click input not observed (window unknown, not counted)` : "";
    const counts = s.harness2 && s.windows ? `${s.windows.complete} / ${s.windows.recorded} (${s.total})${unobserved}` : "not recorded (harness 1)";
    const cw = s.coldWindow;
    const firstCell = cw ? `${num(cw.purpose.routed.n)} / ${num(cw.purpose.background.n)} / ${num(cw.purpose.prefetch.n)}` : "-";
    if (!w) {
      out.push(`| ${p.label} | - | ${counts} | ${readyCell} | - | - | - | - | - | - | - | - | - | - | - | ${firstCell} |`);
      continue;
    }
    const r = w.purpose.routed;
    const b = w.purpose.background;
    const split = (x) => `${num(x.network)} / ${num(x.cached)} / ${num(x.serviceWorker)} / ${num(x.unknownVia)}`;
    const blocking = `${ms(s.blockingBeforeReady.p50)} / ${ms(s.blocking.p50)}`;
    const from = w.anchored ? "the click" : "navigation start";
    const unfinished = w.withPending > 0 ? `${num(w.pending)} (${w.withPending} of ${w.n} windows)` : "0";
    const before = w.anchored ? num(w.beforeAnchor) : "-";
    out.push(
      `| ${p.label} | ${ms(w.windowMs)} from ${from} | ${counts} | ${readyCell} | ${split(r)} | ${num(r.data)} | ${split(b)} | ${num(b.data)} | ${num(w.purpose.prefetch.n)} | ${unfinished} | ${before} | ${kb(r.bytes)} / ${kb(b.bytes)} | ${ms(s.feedAt.p50)} | ${ms(s.firstPrefetchAt.p50)} | ${blocking} | ${firstCell} |`
    );
  }
  return out.join("\n");
}

const lowNote = (r) => (r.n === 0 ? "no sample" : r.lowN ? `low n (${r.n} < ${LOW_N}): p95 is about the worst view; pool scheduled runs before acting on it` : "");

/** Warm data-ready percentiles with their sample size and a low-n warning. */
function robustTable(pages) {
  const out = [];
  out.push("| Page | n | p50 | p90 | p95 | max | IQR | MAD | Note |");
  out.push("|---|---|---|---|---|---|---|---|---|");
  for (const p of pages) {
    const r = p.summary.readyRobust || robust((p.summary.timing && p.summary.timing.ready && p.summary.timing.ready.values) || []);
    out.push(`| ${p.label} | ${r.n} | ${ms(r.p50)} | ${ms(r.p90)} | ${ms(r.p95)} | ${ms(r.max)} | ${ms(r.iqr)} | ${ms(r.mad)} | ${lowNote(r)} |`);
  }
  return out.join("\n");
}

/** Phone taps (observed only): input to next paint, Event Timing, tap to ready, blocking time, with n. */
function inputTable(inputs) {
  const out = [];
  out.push("| Scenario | Action | ok/total | Input to next paint p50 / p90 / max (n) | Event Timing longest p50 (n) | Tap to ready p50 / max (n) | Blocking time p50 (ms) | Not measured | Note |");
  out.push("|---|---|---|---|---|---|---|---|---|");
  for (const run of inputs || []) {
    for (const a of run.summary.actions) {
      const i = a.inputMs;
      const e = a.eventMs;
      const r = a.readyMs;
      const missing = Object.entries(a.errors).map(([k, v]) => `${k} x${v}`).join(", ");
      out.push(
        `| ${run.label} | ${a.action} | ${a.ok}/${a.total} | ${i.n ? `${ms(i.p50)} / ${ms(i.p90)} / ${ms(i.max)} (${i.n})` : "-"} | ${e.n ? `${ms(e.p50)} (${e.n})` : "under 16 ms or not reported"} | ${r.n ? `${ms(r.p50)} / ${ms(r.max)} (${r.n})` : "-"} | ${ms(a.blockingMs.p50)} | ${missing || "-"} | ${lowNote(i)} |`
      );
    }
  }
  return out.join("\n");
}

/**
 * Data ready pooled over several runs (directories), one row per page and METHOD: harness version, scenario, viewport,
 * the CPU slowdown actually in force, the fixed window and its rule, and the production revision. Samples of different
 * builds or methods are never mixed (a phone run whose CPU throttle failed, measured at 1x, never pools with a 4x one).
 * Only results bound to one exact build pool across runs; a mixed, unbound, unknown or unrecorded revision keeps one
 * row per run ("not pooled"). Only pooled numbers with a real n are a basis for enforcing a new metric.
 */
function methodOf(p) {
  const d = p.detail || {};
  return {
    scenario: p.scenario || "full-load",
    viewport: d.viewport || "not recorded",
    cpu: finite(d.cpuSlowdown) ? d.cpuSlowdown : null,
    windowMs: finite(p.windowMs) ? p.windowMs : null,
    windowRule: p.windowRule || null,
  };
}

function pooledTable(runs) {
  if (!runs || runs.length < 2) return "";
  const groups = new Map();
  runs.forEach((run, runIdx) => {
    for (const p of run.pages) {
      const m = methodOf(p);
      const exact = isExactRevision(p.revision);
      const key = [p.label, p.harness || 1, m.scenario, m.viewport, m.cpu, m.windowMs, m.windowRule, p.revision || "", exact ? "" : `run${runIdx}`].join("|");
      const g = groups.get(key) || { label: p.label, harness: p.harness || 1, method: m, revision: p.revision || null, exact, runs: 0, values: [], failed: 0 };
      g.runs += 1;
      g.values.push(...(((p.summary.timing || {}).ready || {}).values || []));
      g.failed += p.summary.failed || 0;
      groups.set(key, g);
    }
  });
  const unbound = {
    mixed: "a deploy landed during measurement: not bound to one build, not pooled",
    partial: "only one /api/version read succeeded: not bound to one build, not pooled",
    unknown: "no /api/version read succeeded: not bound to one build, not pooled",
  };
  const out = [];
  out.push("| Page | Harness | Scenario | Viewport / CPU | Fixed window (ms) | Production revision | Runs | Warm n | p50 | p90 | p95 | max | Not reached | Note |");
  out.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const g of groups.values()) {
    const r = robust(g.values);
    const m = g.method;
    const view = `${m.viewport} / ${m.cpu == null ? "CPU not recorded" : `CPU ${m.cpu}x`}`;
    const win = m.windowMs == null ? "not recorded" : `${ms(m.windowMs)}${m.windowRule ? ` (${m.windowRule})` : ""}`;
    const note = g.exact ? lowNote(r) : unbound[g.revision] || "no build recorded (harness 1): not pooled";
    out.push(`| ${g.label} | ${g.harness} | ${m.scenario} | ${view} | ${win} | ${short(g.revision)} | ${g.runs} | ${r.n} | ${ms(r.p50)} | ${ms(r.p90)} | ${ms(r.p95)} | ${ms(r.max)} | ${g.failed} | ${note} |`);
  }
  return out.join("\n");
}

/** Side-by-side p50 stability across repeated runs of the same suite. */
function stabilityTable(runs) {
  if (runs.length < 2) return "";
  const labels = runs[0].pages.map((p) => p.label);
  const out = [];
  const versions = [...new Set(runs.map((r) => r.harness || 1))];
  if (versions.length > 1) {
    out.push(
      `Runs were measured with different harness versions (${versions.join(", ")}). TTFB, data ready and the network-quiet request totals keep their definition; version 2 adds a browser network listener and in-page observers, so a difference between versions is not evidence of a speed-up.\n`
    );
  }
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

/**
 * Speed budget (Riley 2026-11-14: nothing may take a full second). Pure: `pages` are summarizePage() results with
 * their slug, label and `expected` navigation count. Tightened after the Codex review of 2026-11-14 (D4):
 *   - any single API / database / Worker call (warm or the cold first visit) that takes `ms` or more breaks it: the
 *     slowest call per view is compared, not a per-view mean;
 *   - a page's data taking `ms` or more in any warm view, or in the cold first visit, breaks it;
 *   - an incomplete page breaks it: a navigation that never reached data-ready (its data took at least 30 s, or the
 *     page is broken), fewer navigations than planned, or no warm view at all. A missing number is never a pass.
 * Each line says whether the breach is repeatable (slow in two or more warm views) or isolated (one slow view), with
 * the warm p95 beside it, so a persistent regression can be told from a single slow request. Returns one line per breach; empty = within budget.
 */
const SPEED_BUDGET_MS = 1000;
const BUDGET_CLASSES = new Set(["rest", "api", "worker", "supabase-auth"]);
/** The budget lines of ONE page, whether or not the page is enforced. */
function pageBreaches(p, ms = SPEED_BUDGET_MS) {
  const out = [];
  const r = (v) => Math.round(v);
  // Repeatable = slow in two or more warm views; with the hourly 3 warm views a p95 is close to the max, so the count
  // tells a persistent regression from one slow request, and the p95 is reported beside it.
  const kind = (p95, slowViews, views) =>
    `${slowViews >= 2 ? "repeatable" : "isolated"}: ${slowViews} of ${views} warm views${finite(p95) ? `, warm p95 ${r(p95)} ms` : ""}`;
  // An in-app click's first round is the first visit of a session Today already warmed, not a cold one.
  const first = isPrewarmed(p) ? "on the first in-app visit (session prewarmed by Today)" : "on the cold first visit";
  const s = p.summary || {};
  const name = p.label || p.slug;
  const total = s.total ?? 0;
  const expected = finite(p.expected) ? p.expected : total;
  if (total < expected) out.push(`${name}: only ${total} of ${expected} navigations were measured`);
  if (s.failed > 0) out.push(`${name}: ${s.failed} of ${total} navigations never reached data-ready (counts as over ${ms} ms)`);
  const ready = s.timing?.ready || {};
  if (expected >= 2 && !(ready.n > 0)) out.push(`${name}: no warm navigation reached data-ready`);
  if (s.cold && finite(s.cold.ready) && s.cold.ready >= ms) out.push(`${name}: data ready ${r(s.cold.ready)} ms ${first}`);
  if (finite(ready.max) && ready.max >= ms) {
    const slow = (ready.values || []).filter((v) => v >= ms).length || 1;
    out.push(`${name}: data ready ${r(ready.max)} ms in the slowest warm view (${kind(ready.p95, slow, ready.n || 1)})`);
  }
  for (const e of s.endpoints || []) {
    if (!BUDGET_CLASSES.has(e.cls)) continue;
    const max = finite(e.callMsMax) ? e.callMsMax : e.callMsP50;
    if (!(finite(max) && max >= ms)) continue;
    const per = Array.isArray(e.maxPerView) ? e.maxPerView : [];
    const slow = per.filter((v) => v >= ms).length || 1;
    out.push(`${name}: ${e.key} took ${r(max)} ms (${kind(e.callMaxP95, slow, per.length || 1)})`);
  }
  for (const e of s.coldEndpoints || []) {
    if (BUDGET_CLASSES.has(e.cls) && finite(e.maxMs) && e.maxMs >= ms) out.push(`${name}: ${e.key} took ${r(e.maxMs)} ms ${first}`);
  }
  return out;
}

/**
 * The enforced budget: every page except a scenario added as observe-only (`meta.scenario.enforced: false`, the
 * phone scenarios of harness 2). Version 1 result files and every desktop page are enforced exactly as before.
 */
function budgetViolations(pages, ms = SPEED_BUDGET_MS) {
  return (pages || []).filter((p) => p.enforced !== false).flatMap((p) => pageBreaches(p, ms));
}

/** Web Vitals' upper bound for a "good" interaction (INP): a phone tap whose next paint takes longer is reported. */
const INPUT_PAINT_MS = 200;

/**
 * What the observe-only scenarios would break if they were enforced: the same page rules as the budget, plus for
 * phone taps any tap that was not measured, any tap to ready of `ms` or more and any input to next paint of
 * INPUT_PAINT_MS or more. Reported on every run and never turns the run red: a new metric is enforced only after it
 * has been stable across repeated scheduled runs (promote it by setting `enforced: true` on its scenario).
 */
function observedViolations(pages, inputs, ms = SPEED_BUDGET_MS) {
  const out = (pages || []).filter((p) => p.enforced === false).flatMap((p) => pageBreaches(p, ms));
  const r = (v) => Math.round(v);
  for (const run of inputs || []) {
    const expected = finite(run.expected) ? run.expected : null;
    if (expected != null && run.summary.total < expected) out.push(`${run.label}: only ${run.summary.total} of ${expected} taps were tried`);
    for (const a of run.summary.actions) {
      if (a.failed > 0) out.push(`${run.label}: ${a.action}: ${a.failed} of ${a.total} taps not measured (${Object.keys(a.errors).join(", ")}), not a pass`);
      if (finite(a.readyMs.max) && a.readyMs.max >= ms) out.push(`${run.label}: ${a.action}: tap to ready ${r(a.readyMs.max)} ms (slowest of ${a.readyMs.n})`);
      if (finite(a.inputMs.max) && a.inputMs.max >= INPUT_PAINT_MS) out.push(`${run.label}: ${a.action}: input to next paint ${r(a.inputMs.max)} ms (slowest of ${a.inputMs.n}, over ${INPUT_PAINT_MS} ms)`);
    }
  }
  return out;
}

module.exports = {
  SPEED_BUDGET_MS,
  INPUT_PAINT_MS,
  HARNESS_VERSION,
  LOW_N,
  PHONE_MAX_RUN_NAVIGATIONS,
  errorLine,
  isLoginBounce,
  observeOnlyStop,
  VIAS,
  PURPOSES,
  budgetViolations,
  observedViolations,
  pageBreaches,
  robust,
  viaOf,
  purposeOf,
  ANCHOR_KINDS,
  foldWindow,
  foldLongTasks,
  inputAnchorOf,
  sinceClickMs,
  comparableWindow,
  cacheStateOf,
  revisionOf,
  isExactRevision,
  revisionTag,
  scenarioOf,
  summarizeInput,
  scenarioTable,
  windowTable,
  robustTable,
  inputTable,
  pooledTable,
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
  normRegion,
};
