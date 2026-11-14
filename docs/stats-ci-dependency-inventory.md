# Stats CI frontend dependency inventory

Review baseline: `68c2fb7` (PR #171 adds scope logic only). This is a source-read inventory, not a claim that static inspection proves all possible dynamic Python behavior. Independent review is required before enabling the optimization.

## Frontend consumers in the Python offline tests

| Consumer | Frontend dependency | Retained coverage |
|---|---|---|
| `tests/test_tdee_source_guard.py` | All `.ts`/`.tsx` under `frontend/src`; required aliases in `lib/queries.ts` and `app/api/chat/route.ts` | Unchanged guard runs on EVERY stats job, before any conditional install. |
| `tests/test_ci_token_spotify_guard.py` | `frontend/src/lib/spotify-reconnect.ts`, `needsSpotifyReconnect` regex and `buildTokenBlob` schema/order | Any change, deletion or rename of this source retains the FULL stats suite. |

`ci_token_helper.py` and `spotify_etl.py` describe mirrored Spotify frontend behavior; the token guard above is the checked coupling. `causal_inference.py` documents frontend plausibility rules; its Python tests use synthetic inputs rather than executing TypeScript. `hrv_predict.py`, `delivery_email_etl.py`, and `garmin_etl.py` reference frontend counterparts in comments, not frontend file reads.

## Other test file reads checked

- `test_air_quality`, `test_google_calendar`, `test_weather`, `test_whoop_steps`: Python ETL/helper source, workflow YAML and weather SQL.
- `test_causal_adjustment_sets`, `test_hrv_baseline_dates`, `test_hrv_clock_boundaries`, `test_prophet_holdout_dates`: Python analysis/alignment source.
- `test_hrv_matrix_column_classes`, `test_cronometer_atomic_replace`: SQL plus Python import source.
- `test_experiment_framework`: experiment protocol Markdown, schema SQL, experiment Python source and temporary synthetic repositories.
- `test_watchdog_cloud`: workflow YAML and mocked GitHub responses; file paths in fixtures are not reads of app source.
- `test_integration_plan`: isolated temporary Git fixtures and `tools/integration_plan.py`.
- `test_focus_signing_check`, `test_spotify_fail_loud`, token persistence tests: temporary fixture/token files, not real credentials.
- `test_autonomous_merge`, `test_merge_train`: frontend paths are synthetic policy inputs, not app-file reads.
- Live-only tests remain excluded by the existing runner and untouched by this PR.

## Reproduction and conservative boundaries

Inspect all `tests/*.py` for frontend references, source reads (`read_text`, `read_bytes`, `open`), globbing, subprocesses and imported local helpers; inspect relevant imported module read paths too. The inventory should be rechecked when tests or helpers change, including dynamic/indirect reads. No new secret access is introduced.

`tools/stats_ci_dependencies.sha256` hashes all Git-tracked `*.py` paths and contents (sorted paths, NUL delimiters, normalized CRLF), excluding only the fingerprint helper itself to avoid self-reference. It pins this reviewed Python dependency snapshot. Added, removed, modified or unreadable Python sources, malformed/missing fingerprints, Git errors and decoding errors all select the full suite. Changes to the helper or fingerprint trigger full checks for that PR, and require review before merge. Do not automatically regenerate the fingerprint to recover speed after unrelated changes: leave the full suite enabled until re-audited.

Any mixed/non-frontend diff selects the full suite. Workflow dispatch, missing/invalid SHA metadata and unavailable history also select the full suite. `git diff --no-renames` keeps both sides of moved files. The job name stays stable; its workflow trigger is not narrowed. None of this changes the independent frontend checks or security tests.

## Regression evidence

`tests/test_stats_ci_scope.py` has real temporary-Git-index tests for source edit/add/delete, CRLF normalization, missing/malformed manifest, unreadable source/manifest, invalid UTF-8 Git output, Git failure and timeout. Permission/decoding/process faults are injected at the boundary for portability; successful and mutation cases use real Git and files. The seven scope-selection tests cover conservative classification separately.

No timing savings have been measured. A cheaper parallel stats job may reduce runner consumption without reducing the slower frontend job's critical path.
