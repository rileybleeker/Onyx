# Urgent email retention preview (`--preview-db`)

An opt-in, one-time diagnostic for `urgent_email_etl.py`. It exercises the
production reconciliation against real stored `pds.inbox_emails` metadata and a
real Gmail read, and writes nothing.

## Modes

| Mode | Gmail | Database | Writes | Heartbeat |
|---|---|---|---|---|
| normal (schedule) | read-only | read + upsert/update | yes | yes |
| `--dry-run` | read-only | none (would-clear = unknown) | no | no |
| `--preview-db [--refresh-limit N]` | read-only | GET-only, guarded client | no | no |

`--dry-run` and `--preview-db` are mutually exclusive. `--refresh-limit` (an
integer 1..300, default 300) is accepted only with `--preview-db`; it is rejected
in normal and dry-run mode. All arguments are validated before any credential is
read or any client is created.

Intended use after release:

```
gh workflow run urgent-email.yml -f preview=true -f preview_refresh_limit=1
# runs: python urgent_email_etl.py --preview-db --refresh-limit 1
```

## What the refresh limit changes

Only the refresh slice: the newest N window messages are read and classified as
refresh candidates, and the rest count as `over_cap`. The all-age label
membership (two undated `X-GM-LABELS` searches, the `X-GM-MSGID` mapping, its
completeness checks and the 20,000 cap) is unchanged. The scheduled run keeps
the 300 cap; no global constant is changed.

## What it reports (counts and fixed codes only)

Per account, labelled by position (`acct1`, `acct2`): mailbox and reconcile
codes, `window_candidates`, `dropped_by_cap`, `would_refresh`, `labeled_rows`,
`seen`, `retained`, `would_clear`, `unknown`, `unidentified`,
`identity_ambiguous`, and the actual mutation counters `upserted` and `cleared`
(always 0). Run-wide: `db_reads`, `blocked_requests`, `blocked_redirects`,
`sent_writes` and `heartbeat_gate=closed`. No address, fingerprint, subject,
body, Gmail id, mailbox name, URL or exception text is printed.

`would_refresh` and `would_clear` are candidates from the dry-run branch of
`store_account`; they are not database writes.

Exit status is 1 (with a fixed code) if the client cannot be built, any account
fails to read or classify, all-age membership is incomplete, or the guard refused any request. A preview never
retries in write mode.

## The zero-write boundary

`email_preview_readonly.py` builds the only database client the preview uses:

- an HTTPX transport checks every request **before** it is delegated to the
  network: only `GET`, `https`, the exact configured project origin, the exact
  path `/rest/v1/inbox_emails`, `Accept-Profile: pds`, no body. Everything else
  (other methods, tables, RPC, auth/storage paths, origins, profiles) is refused
  and never sent; a 3xx answer is refused and not followed;
- the httpx client has redirects off and `trust_env=False` (no environment
  proxies); session persistence and token refresh are off;
- the guarded client is passed to the SDK via `ClientOptions.httpx_client`, and
  construction verifies that the `inbox_emails` query builder actually uses it.
  An SDK that rejects or ignores the option fails the preview; there is no
  fallback to an unguarded client.

Limits, stated plainly: the service-role key is still a privileged credential.
This is not a read-only database role or privilege revocation. It enforces zero
writes for the reviewed preview code path (reinforced by the dry-run control
flow, which returns before any upsert/update) and does not defend against code
that replaces it.

## Reading the result

- A positive `retained` with `--refresh-limit 1` and `reconcile=complete` shows
  that stored rows outside the refresh slice are preserved by the all-age
  membership. It is cap-based evidence, **not specifically age-based retention**.
  Age-based proof would need a separate private aggregate over stored dates.
- `retained=0`, or no refresh candidates, means the branch was **not exercised**;
  it is not a pass. Do not change real labels or create fixtures to force it.
- `would_clear` > 0 means the next normal run would clear those rows; the
  preview itself changes nothing.
- The workflow's `urgent-email` concurrency group keeps a preview from
  overlapping a scheduled run. Compare before/after aggregate state independently
  if needed, allowing for unrelated concurrent activity.

## Rollback

Stop invoking the preview, or revert its change. Normal hourly ingestion is
unaffected; the preview sends no mutations, so no data rollback applies.

Tests: `tests/test_email_preview_readonly.py`, `tests/test_urgent_email_etl.py`
(`PreviewTests`, `CliTests`).
