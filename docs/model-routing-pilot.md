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
arm, at most the requested limit (25) however many dishes are queued (the rest stay queued for
the next call); a dish gets the same model in a batch and in the
harvester's one-dish retry. A failed batch's error names its arm and where that arm's dishes
start; the harvester then retries one dish at a time inside that arm only (`arm` + an offset
within the arm), so a failure never causes calls for the other arm's dishes. When that arm has
no dish left at the offset the route answers `arm_exhausted`, and the harvester goes back to full
batches without counting a skipped dish (only a dish that failed or came back without an estimate
is stepped past).

**Rollback:** delete `ONYX_MODEL_PILOT` (or let the end date pass) and redeploy. Every call goes
back to the baseline. Estimates already stored keep the model they were made with
(`pds.delivery_item_nutrition.model`); nothing is re-estimated.

## What is recorded

While a task is in the pilot, each request logs one JSON line `{"event":"model_pilot", ...}` to
the Vercel function log for BOTH arms: task, arm, model, effort, ok, calls, units, accepted,
latency in ms and the input / output / cache read / cache write token counts. `calls` is the
number of provider attempts (counted before each attempt, so one that threw still counts),
`answered` the number that returned usage and `unpriced` the difference. Every routed call runs
with the SDK's own retries off (`maxRetries: 0`), so no attempt happens out of sight of the
count. Instead every route retries the errors the SDK would retry (connection errors and
timeouts, 408, 409, 429, 5xx, or whatever the provider's `x-should-retry` header says) itself, at
most twice per call, waiting as long as the provider's `retry-after-ms` / `retry-after` asks
(else a short exponential wait), and counting each attempt (`callWithCountedRetries`). This holds
with or without a pilot, so turning retries over to the route keeps the retries production had.
A retry starts only when its wait plus one second still ends before the request's deadline;
otherwise the last error ends the request. The harvester's own retries after a failed batch are
separate, observed requests. The line is written once per request, after the outcome is known: a
dish batch only after its estimates are stored (a failed save is logged with 0 accepted).
Deadlines: the dish and label routes count their 60 s function limit from the handler's entry
(`routeDeadline`): the model call, every attempt, retry wait and the response body read, ends by
50 s (the SDK's `timeout` stops only at the response headers, so the call also gets an abort
signal), and the database reads and writes end by 54 s. The playlist route has 60 s per attempt
and 280 s for the whole tool loop (a client that disconnects does not stop it). A slow call
therefore ends as a failed, observed attempt rather than a killed request with no line. Never prompt,
reply, dish, product or track text. Outside a pilot nothing is logged.

Accepted results per task: a dish batch whose every dish got an estimate (and the count of
estimated dishes); a playlist created; a label with a product name and at least one named ingredient (a read with no product name or
an empty ingredient list counts as not accepted, though the review form still gets it). The harvester's
one-dish retries after a failed batch appear as their own lines, each in the arm of the batch
that failed (retries never leave that arm), so failures and retries count against the arm that
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
(cache reads and writes priced separately), divided by accepted results. An attempt that ended
without usage (timeout, connection error, error status) may still have been billed, so its cost
is unknown, never zero: the logged tokens give the cost only when `pilotCostEvidence(lines)`
is `complete` for both arms of the window. Otherwise the cost criterion stays unmet until the
window's cost per arm is reconciled with Anthropic's own usage report for the same models and
dates (Console usage, or the Usage and Cost API), and the reconciled figure is linked in the
promotion PR. A line with `unresolved: true` (a playlist creation still running at the hard
end, or one that failed after its Spotify write started without Spotify confirming a playlist)
also keeps `complete` false: its outcome and cost are unknown, so it is reconciled by hand
(check Spotify for the playlist and the provider's usage report for the attempt) before the
window counts. A candidate that misses
any threshold stays a candidate.

## Fixtures

`frontend/tests/fixtures/model-routing-pilot.json`: synthetic cases for each task (generic
dish names with kcal bands, label panels drawn as images at evaluation time, playlist prompts run
against a stub catalog). No personal data. Both arms run every case; the pass rule is in the file.
`playlist_measurement` holds scripted attempt sequences (answers, timeouts, overloaded and
non-retryable errors) that `frontend/tests/model-routing.test.cjs` runs through the real
playlist route with a stub SDK, checking the attempt count, `answered`, `unpriced` and whether
the line's cost is computable.

## Widening

Only after a pilot window meets every criterion: change that task's entry in `BASELINE` to the
candidate in a PR that links the observations (counts only) and the fixture results, then end the
pilot. The broad OPS-MODEL-01 task (provider and local-model comparison) stays open separately.
