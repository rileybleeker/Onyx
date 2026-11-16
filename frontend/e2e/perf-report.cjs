#!/usr/bin/env node
"use strict";

/**
 * Turn the raw per-page JSON written by perf-timing.spec.ts into markdown tables.
 *
 *   node e2e/perf-report.cjs <results-dir> [<results-dir> ...] [--md out.md] [--json out.json] [--budget]
 *
 * One directory = one run (a table set). Several directories = several runs of
 * the same suite; each run gets its own tables plus a p50 stability table and a
 * pooled table (per page, harness version and production revision). Reads local
 * files only. Result files from before harness version 2 (no `meta.harness`) load
 * unchanged: their new columns read "not recorded", never zero, so an older
 * artifact stays a valid baseline.
 */

const fs = require("fs");
const path = require("path");
const stats = require("./perf-stats.cjs");

const ORDER = [
  "today", "log", "check-in", "analytics-hrv", "sleep", "nutrition", "supplements", "agents", "status", "caffeine", "caffeine-720",
  "financials", "financials-budgets", "financials-forecast",
];
// The observe-only phone scenario of harness 2 (PHONE_PAGES and the input test in e2e/perf-timing.spec.ts).
const OBSERVED_SLUGS = [
  { slug: "phone-today", label: "/ (Today), 390 px" },
  { slug: "phone-log", label: "/log, 390 px" },
  { slug: "phone-input", label: "Phone taps, 390 px" },
];
// In-app (clicked) navigations are written as nav-<slug>.json and listed after the full page loads, same order;
// the phone scenario's page loads (phone-<slug>.json) come last.
const rank = (slug) => {
  const s = String(slug);
  if (s.startsWith("nav-")) return ORDER.length + ORDER.indexOf(s.slice(4));
  if (s.startsWith("phone-")) return 2 * ORDER.length + ORDER.indexOf(s.slice(6));
  return ORDER.indexOf(s);
};

function loadRun(dir) {
  // First page start .. last page finish (older result files only have a finish time, mislabelled startedAt).
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "summary.json");
  const pages = [];
  const inputs = [];
  const window_ = { first: null, last: null };
  let meta = null;
  for (const f of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    if (!raw.meta || !Array.isArray(raw.samples)) continue;
    meta = meta || raw.meta;
    const t0 = raw.meta.startedAt, t1 = raw.meta.finishedAt || raw.meta.startedAt;
    window_.first = !window_.first || t0 < window_.first ? t0 : window_.first;
    window_.last = !window_.last || t1 > window_.last ? t1 : window_.last;
    const sc = stats.scenarioOf(raw.meta, raw.meta.slug);
    const common = {
      slug: raw.meta.slug,
      label: raw.meta.label,
      note: raw.meta.note,
      scenario: sc.name,
      enforced: sc.enforced,
      harness: sc.harness,
      detail: sc.detail,
      revision: stats.revisionOf(raw.meta),
      // The fixed window and the rule for which navigations got one (harness 2): part of the method, so pooling keeps
      // results measured with different windows apart.
      windowMs: Number.isFinite(raw.meta.fixedWindowMs) ? raw.meta.fixedWindowMs : null,
      windowRule: raw.meta.windowRule || null,
      // Observe-only: why the loop ended before every planned navigation / tap was tried (its time budget, a bounce to
      // the login page, an error); null when it ran to the end.
      stopped: typeof raw.meta.stopped === "string" && raw.meta.stopped ? raw.meta.stopped : null,
    };
    if (raw.meta.kind === "input") {
      // Phone taps: observe-only, summarised per action, never part of the enforced budget.
      inputs.push({ ...common, expected: raw.meta.planned ?? null, summary: stats.summarizeInput(raw.samples) });
      continue;
    }
    // `expected` = navigations planned for this page, so a run that stopped early is an incomplete page, not a pass.
    pages.push({ ...common, expected: raw.meta.navigations, summary: stats.summarizePage(raw.samples) });
  }
  pages.sort((a, b) => rank(a.slug) - rank(b.slug));
  const harness = Math.max(1, ...pages.map((p) => p.harness || 1), ...inputs.map((p) => p.harness || 1));
  // Observe-only result files a version 2 run always writes (the phone scenario). One that is absent (its test died
  // before writing, or never started) is reported as not measured, never silently left out. A manual deep run (more
  // than PHONE_MAX_RUN_NAVIGATIONS navigations per page) skips the phone scenario on purpose: said once, as not run.
  const present = new Set([...pages, ...inputs].map((p) => p.slug));
  const deep = pages.some((p) => p.enforced !== false && Number.isFinite(p.expected) && p.expected > stats.PHONE_MAX_RUN_NAVIGATIONS);
  const absent = harness >= 2 ? OBSERVED_SLUGS.filter((x) => !present.has(x.slug)) : [];
  const missing = deep ? [] : absent;
  const phoneSkipped = deep && absent.length > 0;
  return { dir, meta, pages, inputs, harness, missing, phoneSkipped, window: window_ };
}

/**
 * Lines for the observe-only result files a version 2 run did not write (or, on a deep run, did not try), and for the
 * ones that ended early (time budget, a bounce to the login page, an error): the rest of those is not measured, never a
 * pass. Printed by the budget step and the report; never part of the exit code.
 */
function missingObserved(run) {
  const lines = (run.missing || []).map((x) => `${x.label}: no result file written (not measured, not a pass)`);
  for (const p of [...(run.pages || []), ...(run.inputs || [])]) {
    if (p.enforced === false && p.stopped) lines.push(`${p.label}: stopped early, ${p.stopped}; the rest not measured, not a pass`);
  }
  if (run.phoneSkipped) {
    lines.push(`Phone scenario, 390 px: not run on a deep run (more than ${stats.PHONE_MAX_RUN_NAVIGATIONS} navigations per page); the hourly run measures it`);
  }
  return lines;
}

/**
 * "abc1234 (13 results), mixed (1 result)": the production builds a run measured. Only an exact SHA (both
 * /api/version reads agreed) binds a result to a build; "partial" = only one read succeeded, "unknown" = neither.
 */
function revisionLine(run) {
  const t = {};
  for (const p of [...run.pages, ...run.inputs]) {
    const k = stats.revisionTag(p.revision);
    t[k] = (t[k] || 0) + 1;
  }
  return Object.entries(t).map(([k, v]) => `${k} (${v} ${v === 1 ? "result" : "results"})`).join(", ");
}

function render(runs) {
  const out = [];
  out.push("# Production timing run\n");
  runs.forEach((run, idx) => {
    const m = run.meta || {};
    const g = m.github || {};
    const r = m.runner || {};
    out.push(`## Run ${idx + 1}${g.runId ? ` (GitHub run ${g.runId})` : ""}\n`);
    out.push(
      `Measured ${run.window.first || "?"} to ${run.window.last || "?"} (UTC), ${m.navigations || "?"} navigations per page (first = cold browser cache, the rest = warm), runner ${r.platform || "?"} ${r.cpus || "?"} vCPU / ${r.memGB || "?"} GB, Chromium ${r.chromium || "?"}, commit ${(g.sha || "?").slice(0, 7)}.\n`
    );
    out.push(
      `Harness version ${run.harness}. Production build measured (from /api/version at the start and end of each page): ${revisionLine(run)}. The workflow commit above is the harness code, not necessarily the build production served.\n`
    );
    out.push("### Timing, milliseconds (warm navigations: p50 / p95)\n");
    out.push(stats.timingTable(run.pages) + "\n");
    out.push("### Percentiles with sample size (warm data ready, ms)\n");
    out.push(stats.robustTable(run.pages) + "\n");
    out.push("### Scenario, cache state and production revision\n");
    out.push(stats.scenarioTable(run.pages) + "\n");
    out.push(`### Routed readiness and background work (fixed window from navigation start or the click, warm median)\n`);
    out.push(
      "Routed = started before data-ready, background = after it. The split is by start time only, so on a slow page routed also holds continuous-scroll neighbour and warm-up reads that started before data-ready. An in-app window starts at the click's observed input; a click whose input was not observed has an unknown window, listed in the count column and never in the medians.\n"
    );
    out.push(stats.windowTable(run.pages) + "\n");
    out.push("### Requests per page view (warm median)\n");
    out.push(stats.requestsTable(run.pages) + "\n");
    out.push("### Most expensive API and database calls per page view (warm median)\n");
    out.push(stats.endpointTable(run.pages) + "\n");
    if (run.inputs.length) {
      // A phone-tap scenario promoted to enforced (`enforced: true`) is in the budget's exit code; the heading says so.
      const enforcedTaps = run.inputs.some((p) => p.enforced !== false);
      out.push(`### Phone input responsiveness (${enforcedTaps ? "enforced" : "observed, not enforced yet"})\n`);
      out.push(stats.inputTable(run.inputs) + "\n");
    }
    const missing = missingObserved(run);
    if (missing.length) {
      out.push("### Observe-only results not recorded or cut short\n");
      out.push(missing.map((l) => `- ${l}`).join("\n") + "\n");
    }
    const notes = stats.runNotes(run.pages);
    if (notes) out.push("### Notes on this run\n\n" + notes + "\n");
  });
  if (runs.length > 1) {
    out.push("## Stability across runs\n");
    out.push(stats.stabilityTable(runs) + "\n");
    out.push("## Pooled across runs (per page, harness version, method, observation cadence and production revision)\n");
    out.push(stats.pooledTable(runs) + "\n");
  }
  return out.join("\n");
}

/**
 * What --budget prints and decides. `observed` = the observe-only scenarios' lines (today the phone: results not
 * recorded or cut short, and what they would break), printed on every run and never part of the exit code. `over` =
 * the enforced budget: every page that is not observe-only (budgetViolations) AND every phone-tap result that is not
 * observe-only (inputBudgetViolations), so promoting a phone scenario with `enforced: true` makes its breaches turn
 * the run red. Any `over` line = exit code 1.
 */
function budgetOutcome(runs) {
  const observed = (runs || []).flatMap((r) => [...missingObserved(r), ...stats.observedViolations(r.pages, r.inputs)]);
  const over = (runs || []).flatMap((r) => [...stats.budgetViolations(r.pages), ...stats.inputBudgetViolations(r.inputs)]);
  return { observed, over };
}

function main(argv) {
  const dirs = [];
  let mdOut = null;
  let jsonOut = null;
  let budget = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--budget") budget = true;
    else if (argv[i] === "--md") mdOut = argv[++i];
    else if (argv[i] === "--json") jsonOut = argv[++i];
    else dirs.push(argv[i]);
  }
  if (dirs.length === 0) {
    console.error("usage: perf-report.cjs <results-dir>... [--md out.md] [--json out.json] [--budget]");
    process.exit(2);
  }
  const runs = dirs.map(loadRun).filter((r) => r.pages.length > 0);
  if (runs.length === 0) {
    console.error("no result files found");
    process.exit(1);
  }
  const md = render(runs);
  if (mdOut) fs.writeFileSync(mdOut, md);
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(runs.map((r) => ({ meta: r.meta, harness: r.harness, pages: r.pages, inputs: r.inputs })), null, 1));
  if (!mdOut) process.stdout.write(md);
  if (budget) {
    for (const r of runs) console.log(`Production build measured: ${revisionLine(r)}`);
    const { observed, over } = budgetOutcome(runs);
    if (observed.length) console.log(`Observed only, not enforced yet (repeat across scheduled runs before enforcing):\n- ` + observed.join("\n- "));
    if (over.length) {
      console.error(`Speed budget broken (nothing may take ${stats.SPEED_BUDGET_MS} ms):\n- ` + over.join("\n- "));
      process.exit(1);
    }
    console.log(`Speed budget met: every page measured completely, its data under ${stats.SPEED_BUDGET_MS} ms warm and cold, no single call over it.`);
  }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { loadRun, render, revisionLine, missingObserved, budgetOutcome, OBSERVED_SLUGS };
