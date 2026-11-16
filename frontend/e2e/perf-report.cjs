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
  return { dir, meta, pages, inputs, harness, window: window_ };
}

/** "abc1234 (13 pages), mixed (1 page)": the production builds a run measured. */
function revisionLine(run) {
  const t = {};
  for (const p of [...run.pages, ...run.inputs]) {
    const k = p.revision ? (p.revision === "mixed" || p.revision === "unknown" ? p.revision : String(p.revision).slice(0, 7)) : "not recorded";
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
    out.push(`### Routed readiness and background work (fixed window from navigation start, warm median)\n`);
    out.push(stats.windowTable(run.pages) + "\n");
    out.push("### Requests per page view (warm median)\n");
    out.push(stats.requestsTable(run.pages) + "\n");
    out.push("### Most expensive API and database calls per page view (warm median)\n");
    out.push(stats.endpointTable(run.pages) + "\n");
    if (run.inputs.length) {
      out.push("### Phone input responsiveness (observed, not enforced yet)\n");
      out.push(stats.inputTable(run.inputs) + "\n");
    }
    const notes = stats.runNotes(run.pages);
    if (notes) out.push("### Notes on this run\n\n" + notes + "\n");
  });
  if (runs.length > 1) {
    out.push("## Stability across runs\n");
    out.push(stats.stabilityTable(runs) + "\n");
    out.push("## Pooled across runs (per page, harness version and production revision)\n");
    out.push(stats.pooledTable(runs) + "\n");
  }
  return out.join("\n");
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
    // Observe-only scenarios (the phone): printed on every run, never part of the exit code.
    const observed = runs.flatMap((r) => stats.observedViolations(r.pages, r.inputs));
    if (observed.length) console.log(`Observed only, not enforced yet (repeat across scheduled runs before enforcing):\n- ` + observed.join("\n- "));
    const over = runs.flatMap((r) => stats.budgetViolations(r.pages));
    if (over.length) {
      console.error(`Speed budget broken (nothing may take ${stats.SPEED_BUDGET_MS} ms):\n- ` + over.join("\n- "));
      process.exit(1);
    }
    console.log(`Speed budget met: every page measured completely, its data under ${stats.SPEED_BUDGET_MS} ms warm and cold, no single call over it.`);
  }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { loadRun, render, revisionLine };
