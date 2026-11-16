// Run listener for the Kindle harvester's "Run now" button (2026-11-16).
//
// Event driven, nothing polls: this process holds ONE websocket to Supabase Realtime, subscribed
// to INSERTs on pds.pc_run_requests. Pressing Run now on the /status Kindle card inserts a row;
// Realtime pushes it here within about a second, and this process starts the "Onyx Kindle Harvest"
// scheduled task (so MultipleInstances=IgnoreNew still keeps a pressed run and a scheduled run from
// colliding on the Chrome profile), then writes the answer back on the same row:
//   picked_up_at + outcome  (started | already_running | failed)   as soon as it starts
//   finished_at + exit_code (harvest.mjs: 0 ok, 1 error, 2 Amazon signed out, 3 no Onyx token)
// While a pressed run is going it reads the task's state every 10 s; otherwise it only answers the
// websocket's keep-alive (Realtime closes a silent socket), which is how it notices sleep / wake.
//
// Started at sign-in from the Startup folder and right away by register-listener.ps1, hidden
// (wscript run-hidden.js). One instance at a time (a named pipe is the lock). Never exits on its own:
// every error reconnects with a backoff (1 s … 60 s).
//
// Secret: the service key in ~/.onyx_supabase_secret (same file as the PC activity logger). It is
// never logged; the log (listener.log, gitignored) holds times, events and request ids only.

import { readFileSync, appendFileSync, statSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { createServer } from "node:net";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOG_FILE = join(HERE, "listener.log");
const LOG_MAX_BYTES = 512 * 1024;
const BASE = process.env.ONYX_SUPABASE_URL || "https://fewweioupmsnbccqtxdl.supabase.co";
const KEY_FILE = join(homedir(), ".onyx_supabase_secret");
const LOCK_PIPE = "\\\\.\\pipe\\onyx-kindle-run-listener";
export const TASK_NAME = "Onyx Kindle Harvest";

export const HEARTBEAT_MS = 25_000;
export const SLEPT_GAP_MS = 60_000; // a keep-alive tick this late means the PC slept: reconnect at once
export const CATCH_UP_MS = 2 * 60_000; // presses this recent are answered after a reconnect
export const RUN_LIMIT_MS = 25 * 60_000; // the task is stopped by Windows at 20 min
export const RUN_CHECK_MS = 10_000;
const BACKOFF_S = [1, 2, 5, 10, 30, 60];

// ---------- pure helpers (tested in run-listener.test.mjs) ----------

export const backoffMs = (attempt) => BACKOFF_S[Math.min(Math.max(attempt, 0), BACKOFF_S.length - 1)] * 1000;

export function joinMessage(ref) {
  return {
    topic: "realtime:onyx-pc-run",
    event: "phx_join",
    ref: String(ref),
    join_ref: String(ref),
    payload: {
      config: {
        broadcast: { ack: false, self: false },
        presence: { key: "" },
        private: false,
        postgres_changes: [{ event: "INSERT", schema: "pds", table: "pc_run_requests" }],
      },
    },
  };
}

export const heartbeatMessage = (ref) => ({ topic: "phoenix", event: "heartbeat", payload: {}, ref: String(ref) });

/** One Realtime frame → what this process cares about. */
export function parseFrame(raw, joinRef) {
  let m;
  try {
    m = JSON.parse(raw);
  } catch {
    return { kind: "other" };
  }
  if (m.topic === "phoenix" && m.event === "phx_reply") return { kind: "heartbeat_ack", ref: m.ref };
  if (m.event === "phx_reply" && m.ref === joinRef) return m.payload?.status === "ok" ? { kind: "joined" } : { kind: "error", why: "join_refused" };
  if (m.event === "system") {
    if (m.payload?.extension !== "postgres_changes") return { kind: "other" };
    return m.payload?.status === "ok" ? { kind: "subscribed" } : { kind: "error", why: "subscribe_failed" };
  }
  if (m.event === "postgres_changes") {
    const data = m.payload?.data;
    const record = data?.record;
    if (data?.type === "INSERT" && record && typeof record.id === "string") return { kind: "insert", record };
    return { kind: "other" };
  }
  if (m.event === "phx_error" || m.event === "phx_close") return { kind: "error", why: m.event };
  return { kind: "other" };
}

/**
 * Task state after a pressed run → done or not, and what to store. `startedAt` = ms when this
 * process asked Windows to start it; `outcome` = started | already_running.
 * Task Scheduler stores LastRunTime to the second, hence the 2 s slack.
 */
export function runResult(info, startedAt, outcome, checks) {
  if (info.state === "Running" || info.state === "Queued") return { done: false };
  const lastRun = info.lastRun ? Date.parse(info.lastRun) : NaN;
  const ranSince = Number.isFinite(lastRun) && lastRun >= startedAt - 2000;
  if (outcome === "started" && !ranSince) {
    // Not running and no run since the press: give Windows one more check, then report it.
    return checks < 2 ? { done: false } : { done: true, exit_code: null, detail: "did_not_start" };
  }
  const code = Number(info.last);
  if (Number.isInteger(code) && code >= 0 && code <= 255) return { done: true, exit_code: code, detail: null };
  const hex = Number.isFinite(code) ? (code >>> 0).toString(16) : "unknown";
  return { done: true, exit_code: null, detail: `task_result_${hex}` };
}

// ---------- side effects ----------

function log(msg) {
  try {
    try {
      if (statSync(LOG_FILE).size > LOG_MAX_BYTES) renameSync(LOG_FILE, LOG_FILE + ".1");
    } catch {}
    appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
  } catch {}
}

const TASK_INFO = `
$ErrorActionPreference = 'Stop'
try {
  $t = Get-ScheduledTask -TaskName '${TASK_NAME}'
  if ($env:ONYX_START -eq '1' -and [string]$t.State -ne 'Running') { $before = [string]$t.State; Start-ScheduledTask -TaskName '${TASK_NAME}'; Start-Sleep -Milliseconds 800; $t = Get-ScheduledTask -TaskName '${TASK_NAME}' } else { $before = [string]$t.State }
  $i = $t | Get-ScheduledTaskInfo
  $lr = $null; if ($i.LastRunTime) { $lr = $i.LastRunTime.ToUniversalTime().ToString('o') }
  [pscustomobject]@{ ok = $true; before = $before; state = [string]$t.State; last = [int64]$i.LastTaskResult; lastRun = $lr } | ConvertTo-Json -Compress
} catch {
  [pscustomobject]@{ ok = $false; missing = ($_.CategoryInfo.Category -eq 'ObjectNotFound') } | ConvertTo-Json -Compress
}`;

function taskInfo(start = false) {
  return new Promise((done) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", TASK_INFO],
      { windowsHide: true, timeout: 60_000, env: { ...process.env, ONYX_START: start ? "1" : "0" } },
      (err, stdout) => {
        if (err) return done({ ok: false, missing: false });
        try {
          done(JSON.parse(String(stdout).trim().split(/\r?\n/).pop()));
        } catch {
          done({ ok: false, missing: false });
        }
      },
    );
  });
}

let KEY = "";
const rest = (path, init = {}) =>
  fetch(`${BASE}/rest/v1/${path}`, {
    ...init,
    headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json", "Accept-Profile": "pds", "Content-Profile": "pds", ...(init.headers || {}) },
  });

async function patch(ids, fields) {
  const filter = `id=in.(${ids.join(",")})`;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await rest(`pc_run_requests?${filter}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify(fields) });
      if (r.ok) return true;
      log(`patch http ${r.status}`);
    } catch {
      log("patch network error");
    }
    await new Promise((d) => setTimeout(d, backoffMs(attempt + 1)));
  }
  return false;
}

// ---------- the run ----------

const seen = new Set();
let current = null; // { ids: [], startedAt, outcome }

async function handle(record) {
  if (record.task !== "kindle" || seen.has(record.id)) return;
  seen.add(record.id);
  if (seen.size > 500) seen.delete(seen.values().next().value);
  const short = record.id.slice(0, 8);
  const now = new Date().toISOString();

  if (current) {
    current.ids.push(record.id);
    log(`request ${short}: joins the run already going`);
    await patch([record.id], { picked_up_at: now, outcome: "already_running" });
    return;
  }

  const run = { ids: [record.id], startedAt: Date.now(), outcome: "started" };
  current = run;
  try {
    const info = await taskInfo(true);
    if (!info.ok) {
      const detail = info.missing ? "task_missing" : "task_query_failed";
      log(`request ${short}: ${detail}`);
      await patch(run.ids, { picked_up_at: now, outcome: "failed", detail, finished_at: new Date().toISOString() });
      return;
    }
    run.outcome = info.before === "Running" ? "already_running" : "started";
    log(`request ${short}: ${run.outcome}`);
    await patch(run.ids, { picked_up_at: now, outcome: run.outcome });

    let result = { done: false };
    for (let checks = 1; !result.done; checks++) {
      if (Date.now() - run.startedAt > RUN_LIMIT_MS) {
        result = { done: true, exit_code: null, detail: "timeout" };
        break;
      }
      const state = checks === 1 ? info : await taskInfo(false);
      result = state.ok ? runResult(state, run.startedAt, run.outcome, checks) : { done: false };
      if (!result.done) await new Promise((d) => setTimeout(d, RUN_CHECK_MS));
    }
    log(`run for ${run.ids.length} request(s): finished, exit ${result.exit_code ?? "-"} ${result.detail ?? ""}`.trim());
    await patch(run.ids, { finished_at: new Date().toISOString(), exit_code: result.exit_code, detail: result.detail });
  } catch (e) {
    log(`run error ${e?.name || "Error"}`);
    await patch(run.ids, { finished_at: new Date().toISOString(), detail: "task_query_failed" });
  } finally {
    current = null;
  }
}

async function catchUp() {
  const since = new Date(Date.now() - CATCH_UP_MS).toISOString();
  try {
    const r = await rest(`pc_run_requests?select=id,task,requested_at&task=eq.kindle&picked_up_at=is.null&requested_at=gte.${encodeURIComponent(since)}&order=requested_at.asc`);
    if (!r.ok) return log(`catch-up http ${r.status}`);
    const rows = await r.json();
    if (rows.length) log(`catch-up: ${rows.length} unanswered request(s)`);
    for (const row of rows) void handle(row);
  } catch {
    log("catch-up network error");
  }
}

// ---------- the websocket ----------

let ws = null;
let ref = 0;
let joinRef = null;
let awaitingAck = null;
let attempt = 0;
let lastTick = Date.now();
let reconnectTimer = null;
let connectingSince = 0;

function connect() {
  reconnectTimer = null;
  const url = `${BASE.replace(/^http/, "ws")}/realtime/v1/websocket?apikey=${encodeURIComponent(KEY)}&vsn=1.0.0`;
  const sock = new WebSocket(url);
  ws = sock;
  awaitingAck = null;
  connectingSince = Date.now();
  sock.onopen = () => {
    connectingSince = 0;
    joinRef = String(++ref);
    sock.send(JSON.stringify(joinMessage(joinRef)));
  };
  sock.onmessage = (ev) => {
    const f = parseFrame(String(ev.data), joinRef);
    if (f.kind === "heartbeat_ack") {
      if (f.ref === awaitingAck) awaitingAck = null;
    } else if (f.kind === "subscribed") {
      attempt = 0;
      log("listening");
      void catchUp();
    } else if (f.kind === "insert") {
      void handle(f.record);
    } else if (f.kind === "error") {
      log(`realtime ${f.why}`);
      reconnect();
    }
  };
  sock.onerror = () => log("websocket error");
  sock.onclose = () => {
    if (ws === sock) reconnect();
  };
}

function reconnect() {
  if (reconnectTimer) return;
  const old = ws;
  ws = null;
  if (old) {
    old.onopen = old.onmessage = old.onerror = old.onclose = null;
    try {
      old.close();
    } catch {}
  }
  const wait = backoffMs(attempt++);
  reconnectTimer = setTimeout(connect, wait);
}

function keepAlive() {
  const now = Date.now();
  const slept = now - lastTick > SLEPT_GAP_MS;
  lastTick = now;
  if (!ws || reconnectTimer) return;
  if (slept || awaitingAck) {
    log(slept ? "woke up: reconnecting" : "no keep-alive answer: reconnecting");
    attempt = 0;
    return reconnect();
  }
  if (ws.readyState !== WebSocket.OPEN) {
    // A connection attempt that neither opens nor fails (half-dead network after wake): start over.
    if (connectingSince && now - connectingSince > SLEPT_GAP_MS) {
      log("connect stalled: reconnecting");
      reconnect();
    }
    return;
  }
  awaitingAck = String(++ref);
  ws.send(JSON.stringify(heartbeatMessage(awaitingAck)));
}

function main() {
  try {
    KEY = readFileSync(KEY_FILE, "utf8").trim();
  } catch {}
  if (!KEY) {
    log("no key in ~/.onyx_supabase_secret: exiting");
    process.exit(3);
  }
  // One listener at a time: the second one finds the pipe taken and leaves.
  const lock = createServer();
  lock.once("error", () => {
    log("another listener is running: exiting");
    process.exit(0);
  });
  lock.listen(LOCK_PIPE, () => {
    log(`started (pid ${process.pid})`);
    process.on("uncaughtException", (e) => {
      log(`uncaught ${e?.name || "Error"}: reconnecting`);
      reconnect();
    });
    process.on("unhandledRejection", () => log("unhandled rejection"));
    setInterval(keepAlive, HEARTBEAT_MS);
    connect();
  });
}

if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) main();
