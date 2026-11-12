#!/usr/bin/env node
"use strict";

/**
 * Turn the raw per-page JSON written by perf-timing.spec.ts into markdown tables.
 *
 *   node e2e/perf-report.cjs <results-dir> [<results-dir> ...] [--md out.md] [--json out.json]
 *
 * One directory = one run (a table set). Several directories = several runs of
 * the same suite; each run gets its own tables plus a p50 stability table.
 * Reads local files only.
 */

const fs = require("fs");
const path = require("path");
const stats = require("./perf-stats.cjs");

const ORDER = ["today", "analytics-hrv", "sleep", "nutrition", "supplements", "agents", "status", "caffeine", "caffeine-720"];

function loadRun(dir) {
  // First page start .. last page finish (older result files only have a finish time, mislabelled startedAt).
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "summary.json");
  const pages = [];
  const window_ = { first: null, last: null };
  let meta = null;
  for (const f of files) {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
    if (!raw.meta || !Array.isArray(raw.samples)) continue;
    meta = meta || raw.meta;
    const t0 = raw.meta.startedAt, t1 = raw.meta.finishedAt || raw.meta.startedAt;
    window_.first = !window_.first || t0 < window_.first ? t0 : window_.first;
    window_.last = !window_.last || t1 > window_.last ? t1 : window_.last;
    pages.push({ slug: raw.meta.slug, label: raw.meta.label, note: raw.meta.note, summary: stats.summarizePage(raw.samples) });
  }
  pages.sort((a, b) => ORDER.indexOf(a.slug) - ORDER.indexOf(b.slug));
  return { dir, meta, pages, window: window_ };
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
    out.push("### Timing, milliseconds (warm navigations: p50 / p95)\n");
    out.push(stats.timingTable(run.pages) + "\n");
    out.push("### Requests per page view (warm median)\n");
    out.push(stats.requestsTable(run.pages) + "\n");
    out.push("### Most expensive API and database calls per page view (warm median)\n");
    out.push(stats.endpointTable(run.pages) + "\n");
    const notes = stats.runNotes(run.pages);
    if (notes) out.push("### Notes on this run\n\n" + notes + "\n");
  });
  if (runs.length > 1) {
    out.push("## Stability across runs\n");
    out.push(stats.stabilityTable(runs) + "\n");
  }
  return out.join("\n");
}

function main(argv) {
  const dirs = [];
  let mdOut = null;
  let jsonOut = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--md") mdOut = argv[++i];
    else if (argv[i] === "--json") jsonOut = argv[++i];
    else dirs.push(argv[i]);
  }
  if (dirs.length === 0) {
    console.error("usage: perf-report.cjs <results-dir>... [--md out.md] [--json out.json]");
    process.exit(2);
  }
  const runs = dirs.map(loadRun).filter((r) => r.pages.length > 0);
  if (runs.length === 0) {
    console.error("no result files found");
    process.exit(1);
  }
  const md = render(runs);
  if (mdOut) fs.writeFileSync(mdOut, md);
  if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(runs.map((r) => ({ meta: r.meta, pages: r.pages })), null, 1));
  if (!mdOut) process.stdout.write(md);
}

if (require.main === module) main(process.argv.slice(2));

module.exports = { loadRun, render };
