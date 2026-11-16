# Model routing pilot (OPS-MODEL-01)

Three app routes make single-purpose model calls whose model or effort may be higher than the
task needs. They now take their model and effort from `frontend/src/lib/model-routing.ts`:

| Task id | Route | Baseline (production) | Candidate (pilot only) |
|---|---|---|---|
| `delivery_estimate` | `POST /api/delivery/items/import` (estimate) | `claude-opus-5-5`, effort low | `claude-sonnet-5-5`, effort low |
| `playlist` | `POST /api/spotify/generate-playlist` (every call of the tool loop) | `claude-sonnet-5-5`, API default effort | `claude-sonnet-5-5`, effort low |
| `supplement_photo` | `POST /api/supplements/extract-from-photo` | `claude-sonnet-5-5`, API default effort | `claude-sonnet-5-5`, effort low |

The baseline is exactly the configuration that ran before this change. Onyx Chat is not routed
here. The four structured-output routes that already ran Sonnet at effort low (check-in voice,
Log voice, journal labels, activity tag suggestions) are unchanged and pinned by
`frontend/tests/model-routing.test.cjs`.

## Switching the pilot on

Set in Vercel (Production), then redeploy:

| Variable | Value |
|---|---|
| `ONYX_MODEL_PILOT` | comma list of task ids, e.g. `delivery_estimate,playlist,supplement_photo` |
| `ONYX_MODEL_PILOT_UNTIL` | last day of the pilot, `YYYY-MM-DD` (UTC); at most 21 days ahead |
| `ONYX_MODEL_PILOT_SHARE` | share of calls sent to the candidate, default `0.5`, capped at `0.5` |

Anything missing or out of bounds (no task, no or bad date, a date already past or more than
21 days ahead, a share of 0) leaves the pilot off. The pilot stops by itself after its last
day even if the variables stay set.

Arms are fixed per unit: each dish by its own `est_key`, a playlist or label request by a random
id. One estimate call uses one model, so a dish batch holds only the dishes in the first dish's
arm (the rest stay queued for the next call); a dish gets the same model in a batch and in the
harvester's one-dish retry.

**Rollback:** delete `ONYX_MODEL_PILOT` (or let the end date pass) and redeploy. Every call goes
back to the baseline. Estimates already stored keep the model they were made with
(`pds.delivery_item_nutrition.model`); nothing is re-estimated.

## What is recorded

While a task is in the pilot, each request logs one JSON line `{"event":"model_pilot", ...}` to
the Vercel function log for BOTH arms: task, arm, model, effort, ok, calls, units, accepted,
latency in ms and the input / output / cache read / cache write token counts. `calls` is the
number of model calls attempted (counted before each call, so one that threw still counts) and
`answered` the number that returned usage. The line is written once per request, after the
outcome is known: a dish batch only after its estimates are stored (a failed save is logged with
0 accepted). Never prompt,
reply, dish, product or track text. Outside a pilot nothing is logged.

Accepted results per task: a dish batch whose every dish got an estimate (and the count of
estimated dishes); a playlist created; a label parsed into the product shape. The harvester's
one-dish retries after a failed batch appear as their own lines, each in its dish's own arm,
which is the arm of the batch that failed, so failures and retries count against the arm that
caused them. Dish estimates and saved custom products also store the model
(`delivery_item_nutrition.model`, `supplement_products.raw_json.model`).

## Criteria (set before the pilot runs)

`PILOT_CRITERIA` in `lib/model-routing.ts`, per task, against the baseline arm of the same
window:

| Task | Calls per arm | Success rate | p90 latency | Cost per accepted result vs baseline | Fixture check |
|---|---|---|---|---|---|
| `delivery_estimate` | 20 | 98% | 45 s | at most 0.8x | 90% of fixture dishes inside their kcal band, every kind right |
| `playlist` | 10 | 90% | 40 s | at most 0.9x | every fixture prompt creates a playlist within the iteration limit, source pool honoured |
| `supplement_photo` | 10 | 95% | 30 s | at most 0.9x | every fixture label's ingredients, amounts and units exact |

Cost = the logged token counts at the Anthropic price list current on the evaluation day
(cache reads and writes priced separately), divided by accepted results. A candidate that misses
any threshold stays a candidate.

## Fixtures

`frontend/tests/fixtures/model-routing-pilot.json`: synthetic cases for each task (generic
dish names with kcal bands, label panels drawn as images at evaluation time, playlist prompts run
against a stub catalog). No personal data. Both arms run every case; the pass rule is in the file.

## Widening

Only after a pilot window meets every criterion: change that task's entry in `BASELINE` to the
candidate in a PR that links the observations (counts only) and the fixture results, then end the
pilot. The broad OPS-MODEL-01 task (provider and local-model comparison) stays open separately.
