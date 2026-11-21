# Build pipeline: overflow providers and budgets

Written 2026-11-17. This covers how the headless build pipeline on Riley's PC chooses a model provider, how it caps
spend, and how spend is counted. The scripts live outside the repo, in the local coordination folder
(`analysis_output/audit-2026-11-15-73cb58c6/coordination/`, gitignored). State and the ledger live in
`%LOCALAPPDATA%\Onyx\pipeline\`.

## Why this exists

On 2026-11-16/17 the pipeline spent $70 of OpenRouter credit in about a day, $50 of it in about 20 minutes, mostly
on `z-ai/glm-5.3` with 10 to 14 builders in parallel. Causes:

- the OpenRouter key had no credit limit, and nothing was piloted before scaling up;
- prompt caching was weak through OpenRouter, so the large context Claude Code re-sends every turn was paid at full
  price each turn (`z-ai/glm-5.3` charges almost the same for a cached token as for a new one);
- spend was measured as the key's total usage before and after each run, which double counts when runs overlap, so
  no cost could be tied to a run;
- nothing measured cost per merged PR;
- old dispatcher and planner loops from earlier sessions kept running next to the supervisor's own. That evening four
  dispatchers, five planners and three merge sweepers were running at once.

The switch to Claude Haiku 5.5 on the Anthropic API fixed the per-build cost, but the planner passes were not counted
against the daily cap. They cost about $35 of the Ultra API credit in one day, about two thirds of all Anthropic spend.

## What the pipeline does now

```
supervisor.sh (Task Scheduler "Onyx Build Pipeline")
  ├─ merge_sweeper.sh     merges green claude/* PRs (unchanged)
  ├─ or_dispatch4.sh      starts or_task4.sh per queued task, at most max_parallel_tasks
  ├─ or_planner3.sh       writes new tasks; at most every 2 h, only when fewer than 8 are queued
  └─ overflow.py orphans --kill   every pass: stops pipeline loops that no pid file owns
or_task4.sh: worktree -> triage (cheap, read-only) -> builder -> tsc / py_compile -> push -> PR -> outcome
overflow.py run: pick a rung -> reserve budget -> claude -p under a live $ watchdog -> one ledger record
```

### The provider ladder

One file, `%LOCALAPPDATA%\Onyx\pipeline\overflow-config.json`, is read on every run, so an edit takes effect at
once. Rungs are tried in order, and a run goes to the first rung that has budget left and is not failing.

| | anthropic (rung 1) | openrouter (rung 2) |
|---|---|---|
| State | on | **off** until the guardrails below are met |
| Models | plan, triage and build: `claude-haiku-5-5`; hard: `claude-sonnet-5-5` | none until a pilot passes |
| Max running at once | 6 | 3 |
| Max turns | plan 50, triage 12, build 60, hard 80 | same, hard 60 |
| Max $ per run | plan $0.25, triage $0.03, build $0.25, hard $1.50 | plan $0.15, triage $0.02, build $0.15, hard $0.40 |
| Daily cap | $3.00 (planner at most $0.75 of it) | $2.00 |
| Period cap | $130 of the $200 Ultra credit, 2026-11-16 to 2026-12-13 | the key's own credit limit |

How these values were chosen:

- **Period cap $130 of $200.** The Ultra API credit also pays for Onyx's own API calls (chat, photo meals, voice fill,
  dish estimates) and the SMS and personal-agents keys. $70 is kept for those. When the credit runs out, the Console
  bills the purchased balance (auto-reload), so this cap is what keeps the pipeline from spending real money.
- **Daily cap $3.** About $51 of the period was already spent by 2026-11-18. $79 left over 26 days is about
  $3 a day. At yesterday's measured $0.05 per Haiku build that is around 50 builds a day after the planner's share.
- **Planner $0.75 a day.** A planner pass costs about $0.21 on Haiku. Three passes a day write up to 30 tasks.
- **Per-run caps** are about 5 times the median measured cost (Haiku builds: median under $0.05), so a normal run
  never hits them and a runaway run stops early.
- **Days are UTC days** (they roll over at 7 PM Eastern in winter), the same as OpenRouter's daily limit reset.

A task file may set `"tier": "hard"` to use Sonnet. The triage step reports when it thinks a task is hard, but it does
not raise the tier by itself.

### Hard stops

- **Per run:** Claude Code's `--max-budget-usd` (Anthropic) plus a watchdog in `overflow.py` that prices every API
  response as it streams in and kills the run when the total passes the cap. `--max-turns` stops the run at the turn
  limit. Wall clock limit 30 minutes.
- **Per rung per day and per period:** a run starts only if `cap - spent - max $ of every run already running` is at
  least this run's max $. Reserving each running run's maximum means parallel runs cannot overshoot the cap.
- **Circuit breaker:** two provider errors in a row (5xx, 429, credit errors) take a rung out for 30 minutes, and
  the run moves to the next rung.
- **Kill files** in `%LOCALAPPDATA%\Onyx\pipeline\`: `STOP` means no new runs, the loops exit, and running builds
  finish. `KILL` does the same and also aborts every running build within 5 seconds. Delete the file to resume (the
  supervisor task restarts the loops within 15 minutes, or run the task by hand).
- **Triage first:** a read-only Haiku call (max 12 turns, $0.03) checks whether the change is already there or out
  of scope. If it is, the task is marked `skipped_triage` and the build is not paid for. Yesterday 82 of 335 Haiku
  builds ended with no commit at about $0.036 each.
- A task that finds no rung with budget exits with code 75 and goes back in the queue.
- Every worktree is removed on exit. Uncommitted builder edits are saved first as `or-runs/<slug>.abandoned.patch`.

### Spend accounting

`%LOCALAPPDATA%\Onyx\pipeline\ledger.jsonl` has one `run` record per model run: time, task, repo, tier, rung,
provider, model, tokens in / out / cache read / cache write, $, where the $ came from, turns, outcome. The task
script appends an `outcome` record later (`pr_opened` with the PR number, `no_commit`, `tsc_failed`, `error`,
`skipped_triage`; aborts are `aborted_budget`, `aborted_turns`, `aborted_killed`, `aborted_timeout`).

- **Anthropic:** `total_cost_usd` from the run's own result event. It matched a hand calculation from the token
  counts to the fourth decimal.
- **OpenRouter:** each API response id is looked up with `GET /api/v1/generation?id=…`, which gives the exact cost
  and the cached token count for that request. If any lookup fails the record says `estimate_price_table`. Whole-key
  usage deltas are never used.
- Runs from before the ledger existed were backfilled from the old run files (`backfill: true`). OpenRouter runs from
  that time have no attributable cost (`unknown_openrouter_not_attributable`).

`overflow.py summary --write` (run by the dispatcher once a day) writes `logs/daily-summary-<day>.md`: runs, $, PRs
opened and merged, **$ per merged PR** and cache-read share, by model.

**2026-11-17, from the backfill:** Haiku: 497 runs (335 builds, 160 planner passes), $48.95, 249 merged PRs, so
**$0.20 per merged PR** including the planner (about $0.05 for the builds alone), 96% of input tokens read from cache.
OpenRouter (`glm-5.3`, `deepseek-v4-flash`): 68 merged PRs for about $70, roughly $1 per merged PR.

**Dry run against that day** (`overflow.py simulate --day 2026-11-17`) with the config above: 122 of 602 runs would
have been allowed, $2.88 instead of $48.95, and 91 PRs opened instead of 322. The cap binds from 06:00 UTC; the rest
of the day's runs would have waited for the next day.

### One-glance status

```
pwsh -File <coordination>\pipeline-status.ps1 [-ByModel] [-Summary]
```

It prints, per rung, today's spend against the cap, runs, PRs opened and merged, $ per merged PR, cache share and the
reason a rung is not ready, the credit-period share used, and the OpenRouter key's balance and limit. The Anthropic
credit balance is not available to a normal API key (the usage and cost reports need an Admin key, which this setup
does not have). Check it at **platform.claude.com → Settings → Billing**.

## OpenRouter: guardrails before turning it on

1. **A credit limit on the key, with a daily reset.** This is an account setting and needs Riley's yes. Until the
   key has a limit, `overflow.py` refuses every OpenRouter run, pilots included ("key has no credit limit").
2. **A 5-task pilot per candidate model** (`pilot.sh <model> 5`). It re-runs the 5 newest Haiku tasks whose PRs merged,
   each on a worktree at the commit just before that merge, so every candidate gets the same tasks and Haiku's real
   cost and result is the baseline. Nothing is pushed. `overflow.py pilot-report` prints pass rate, $ per passing
   build and cached-token share. The pilot runs under the openrouter rung's caps.
3. **Enable a model only if its cost per passing build beats Haiku's at equal or better success,** and only if its
   cached-token share is above zero in the generation stats (caching actually applied).

Candidates and list prices (USD per million tokens, OpenRouter, 2026-11-17):

| model | input | cached input | output | note |
|---|---|---|---|---|
| claude-haiku-5-5 (baseline, Anthropic) | 0.10 | 0.01 | 0.50 | 5x price above 100K-token prompts |
| deepseek/deepseek-v4-flash-0731 | 0.06 | 0.015 | 0.18 | |
| z-ai/glm-5.3-flash | 0.15 | 0.03 | 0.50 | |
| qwen/qwen3-coder-next | 0.12 | 0.07 | 0.80 | weak cache discount |
| openai/gpt-oss-120b | 0.15 | 0.075 | 0.60 | weak cache discount, 131K context |
| z-ai/glm-5.3 (what burned the $70) | 0.07 | 0.069 | 1.40 | no real cache discount |

A typical build reads about 850K cached tokens, 40K new and 7K output. That costs about $0.02 on Haiku. The best case
on DeepSeek V4 Flash, with caching applied, is about $0.017; without caching it is about $0.05. The saving is small
even in the best case, so the expected outcome is that OpenRouter stays off.

## Other overflow options

| option | recommendation | why |
|---|---|---|
| DeepSeek API direct (native context caching) | **Not now.** | Current list prices for V4.1 Flash are about $0.30 input, $0.006 cached and $1.20 output per million at peak, half that off-peak, and they were raised sharply in 2026. A build would cost about the same as on Haiku. It would need a new account, key and prepaid credit, with an unknown success rate. Revisit only if Haiku's cost per merged PR rises. |
| Codex CLI builds on Riley's ChatGPT plan | **Yes, as the next rung after Anthropic, with a small daily run cap.** | No per-token charge. The catch is that it uses the same plan limits as the post-merge Codex reviews, so cap it (e.g. 15 builds a day) and use it only when the Anthropic rung is capped. It needs its own runner (`codex exec` in the worktree with a write sandbox); its "cost" is counted in runs, not dollars. Not built yet. |
| Anthropic Message Batches API (50% off) for the planner | **Yes, the biggest saving left.** | Batches cannot run Claude Code's tool loop, so the planner would become one call: a script gathers the inputs (tail of the Codex findings, failed CI logs, merged PR bodies, existing task titles) and sends one Haiku request through Batches that returns task JSON. Estimated $0.003 a pass instead of $0.21. The triage step already checks whether a task is done, which the agentic planner did with git greps. Not built yet. |

## Operating notes

- Change config values in the JSON file; no restart is needed. A new credit grant: move `period.start` / `end`.
- Change scripts safely: create `STOP`, wait until the supervisor has stopped (its log says "loops stopped"),
  swap the files, delete `STOP`, then run the "Onyx Build Pipeline" task and check `logs/supervisor.log`.
- `overflow.py simulate [--day YYYY-MM-DD] [--config other.json]` replays a past day against a config before you
  apply it.
- Secrets: the Anthropic key is read from Windows Credential Manager (`onyx-builders/anthropic`) and the OpenRouter
  key from the user environment, into the child process only. Neither is printed, logged or written to disk.
