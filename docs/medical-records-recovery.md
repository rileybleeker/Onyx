# Medical records: backup and recovery (SEC-06, 2026-11-16)

Plan and check only. Nothing in this document is scheduled, paid for or restored. Every step that
costs money, copies a real record out of Supabase or restores anything waits for Riley's decision
(the list is at the end). The read-only check `tools/medical_recovery/recovery_check.py` exists now.

`/health/records` stores two kinds of things (see `docs/medical-records.md`): rows in
`pds.medical_documents` and `pds.lab_results`, and the original files in the private storage bucket
`medical-records` at `documents/<document id>`. They are backed up in different ways, so they have
different recovery points.

## 1. What has to come back

| Piece | Where it lives | In Supabase's database backup? | How it comes back |
|---|---|---|---|
| Document details (`pds.medical_documents`) | Postgres | Yes | Database backup, or the off-site table snapshot (section 4) |
| Lab results (`pds.lab_results`, `document_id` links to a document) | Postgres | Yes | Same, restored after the documents (the link is a foreign key) |
| Original files (`medical-records` bucket) | Supabase Storage | **No** | Only from an off-site copy (section 4) |
| The bucket's list of files (`storage.objects` rows) | Postgres | Yes, but only the list: the bytes are not in it | Comes back with the database, so a restore can list files whose bytes are gone. A HEAD request is answered from the same row, so only downloading a file tells the two apart (section 6 step 6) |
| Bucket settings (private, 25 MB cap, six file types), RLS, grants | `storage.buckets` and the catalog; also `sql/medical_records_schema.sql` in git | Yes (an in-place restore brings them back); "Restore to a new project" does not copy storage settings | In place: nothing to do. On a new project: re-apply `sql/medical_records_schema.sql` |
| Service-role key | Supabase project settings | Not needed | Re-issued in the dashboard after a project is rebuilt; update Vercel and the PC's key file |
| Backup encryption key (section 4) | Offline, with Riley | Never stored online | Riley's password manager entry or the printed copy |

Supabase's own docs say it plainly: database backups "do not include objects you store via the
Storage API", restoring an old backup "does not restore objects you deleted after that backup",
"Restore to a new project" does not copy Storage files or bucket settings, and deleting a project
removes its backups too. So restoring the database alone can bring back document rows that point at
files that no longer exist. That gap is what this plan closes.

What already protects the files inside the app: there is no delete path (Remove is a soft
`removed_at`, the file stays for Undo), and an upload goes through a one-time signed URL for a new
path, so a file is never overwritten.

## 2. What was checked (2026-11-16, read-only)

Through the Supabase MCP, catalog queries only (no object names, paths or contents were read):

- The organisation is on the **Pro** plan, and the database is Postgres 17, so the project gets
  daily physical backups kept for **7 days** (Supabase docs for Pro).
- WAL archiving is on (`archive_mode` on, `archive_timeout` 120 s) and had archived within minutes of
  the check. That shows changes are being shipped to Supabase's backup storage; it does not show
  which restore points exist, and it does not show whether Point-in-Time Recovery (a paid add-on) is on.
- **The backup list itself could not be read**: the Supabase MCP has no backup tool. This is
  unknown, not assumed good. **Access ask** (either one):
  1. Riley opens the Supabase dashboard, project Onyx, **Database > Backups**, and notes the dates
     of the listed backups (the "Point in Time" tab instead shows the earliest and latest recovery
     point if PITR is on); or
  2. a Supabase personal access token (dashboard > Account > Access Tokens) for one run of
     `recovery_check.py`, which reads `GET /v1/projects/<ref>/database/backups` and prints dates
     and counts only. **The token is account-wide admin**: it can pause, restore or delete any
     project in the account and change its settings, and the Supabase CLI reads
     `SUPABASE_ACCESS_TOKEN` by itself, so a saved variable would hand that power to every
     `npx supabase` call and every agent session on the PC (AGENTS.md requires asking before any
     project lifecycle operation). If this route is used: create it with the shortest expiry the
     dashboard offers; set it only in the one PowerShell window that runs the check
     (`$env:SUPABASE_ACCESS_TOKEN = "<token>"`), never as a user or system environment variable,
     never in chat, a file under OneDrive or the repo; never have it set while running a
     `npx supabase` drill command; close that window and revoke the token on Account > Access
     Tokens right after the run. **Route 1 is the default.**
- The bucket `medical-records` is private, with the 26,214,400-byte cap and the six file types, and
  `storage.objects` has no policy. Both tables have RLS on and no policy. The anon role has no
  access to the `pds` schema; the signed-in (authenticated) role has no SELECT on either table;
  only the service role can read them.
- A second catalog read found no policy on any `storage` table, with RLS on for both
  `storage.objects` and `storage.buckets`: no role but the service role can list, download or
  sign a file (listing and download are separate permissions in Storage, and both are refused).
- Row and file counts and total bytes were read and are kept in the private audit record, not here
  (this repo is public).

## 3. Recovery point (RPO) and recovery time (RTO)

RPO = how much recent work can be lost. RTO = how long until it is back and checked.

### Database rows (document details, lab results)

| Situation | RPO | RTO | Notes |
|---|---|---|---|
| Today, from Supabase's daily backups (unverified until section 2's ask is done) | up to 24 h; restore points go back 7 days | under 1 h for a whole-project restore at this database size | A whole-project restore rolls **every** Onyx table back to that day, not just these two, and the project is offline while it runs |
| Today, medical tables only, via "Restore to a new project" | up to 24 h | 2 to 4 h | A temporary second project (billed while it exists) is restored from the backup, the two tables are copied back by id, then the temporary project is removed |
| With the off-site plan (section 4) | up to 24 h; snapshots kept 30 days plus 12 monthly | about 1 h | Decrypt the newest snapshot and upsert by id (idempotent): documents first, then lab results |
| With the PITR add-on | 2 minutes (Supabase docs) | under 1 h | About $100 per month for 7 days of recovery, plus at least the Small compute add-on. Not recommended: entries are typed by hand, rarely, so a day is easy to re-enter |

### Original files

| Situation | RPO | RTO | Notes |
|---|---|---|---|
| Today | **no recovery point**: nothing outside the bucket holds a copy | not recoverable | A deleted or corrupted file is gone unless the device it was uploaded from still has it |
| With the off-site plan | up to 24 h | 1 to 2 h at the expected size | Decrypt and upload each missing file to its same `documents/<id>` path, then run the check |

**Proposed targets:** rows RPO 24 h / RTO 4 h; files RPO 24 h / RTO 4 h. A lost day of typing can be
redone; a lost original usually cannot, which is why the files are the priority.

## 4. Off-site copy: encrypted, with retention (needs approval before it is built)

### The same for every option

- **Encryption before anything leaves the machine** with [`age`](https://age-encryption.org)
  (X25519 public-key encryption, open source, no service). Riley creates one key pair once. The
  backup job is given only the public key, so it can encrypt but can never decrypt: a leaked
  off-site storage credential (OneDrive, R2 or B2) cannot read the copies. The job's Supabase
  service-role key stays exactly as sensitive as it is today, since it reads every original in
  production directly. The private key lives in Riley's password manager and on one printed copy;
  never in the repo, never under OneDrive, never on a CI runner.
- **What each run copies**, in this order: (1) a snapshot of every column of both tables, as one
  encrypted JSON file; (2) every file whose `documents/<id>` is not in the copy yet, encrypted one
  file per object and named only by the id (`<id>.age`); (3) an encrypted manifest (the format
  `recovery_check.py --manifest` reads): each file's path, size and SHA-256, each document's path,
  size, type, status and removed flag, each lab result's document link and removed flag, and the row
  counts. It holds ids but no text column. Taking the snapshot first means that, in a finished run,
  every confirmed row in the snapshot has its file in the copy.
- **A run is a restore point only once its manifest exists.** The manifest is written last, so a
  run that stopped part way (say, while copying files) leaves a snapshot whose files may not all be
  in the copy; a restore uses the newest snapshot that has a manifest. The job holds plaintext in
  memory only and encrypts it before anything is written: never a temporary file, never anything
  under OneDrive.
- **Retention**: files are kept indefinitely (the app never deletes a file, and Undo needs it; a
  permanent purge of a record would be a separate, manual decision). Table snapshots: one per day
  for 30 days, plus the first of each month for 12 months.
- **Deletion protection** on the storage side (per option below), so a mistake or a leaked credential
  cannot erase the recent copies.
- **Output**: counts only, never names or content. The medical-records rule today is "no heartbeat,
  no `/status` card"; whether the backup job may write a heartbeat that carries no counts (only
  success / failure and time), so a stale backup shows on `/status`, is one of Riley's decisions.

### Options (prices as published at the time of writing; confirm on the pricing page before approving)

| Option | Monthly cost | Deletion protection | New credential | New provider | Trade-off |
|---|---|---|---|---|---|
| **A. PC job to OneDrive**: a Task Scheduler job on Riley's PC (like the Kindle harvester) writes the encrypted copies into a OneDrive folder | $0 extra (inside the existing Microsoft 365 storage) | OneDrive recycle bin (30 days), version history and "Restore your OneDrive" | None (uses the PC's existing key file) | No | Runs only while the PC is on (missed runs catch up when it wakes); Microsoft holds the ciphertext |
| **B. GitHub Actions to Cloudflare R2**: a nightly workflow writes to a private R2 bucket with a bucket lock rule (for example 30 days) | $0 within R2's free 10 GB-month, then $0.015 per GB-month (about $0.60 at the 50 GB worst case: 2,000 documents at the 25 MB cap) | R2 bucket lock | One R2 API token limited to that bucket, as a GitHub secret | No (Cloudflare already runs the reminders Worker) | Independent of the PC; the plaintext passes through a GitHub-hosted runner's memory, and the repo's logs are public (counts-only output is mandatory) |
| **C. Backblaze B2 with Object Lock** | first 10 GB free, then about $6 to $7 per TB-month (well under $1 at 50 GB) | Object Lock | One B2 application key | **Yes** (needs approval) | Same as B, on a provider Onyx does not use yet |
| **D. Encrypted USB drive** (BitLocker), swapped off-site by hand | $0 (about $60 once for a drive) | Physical | None | No | Not automatic: a recurring chore, which Riley prefers to avoid |

**Recommendation: A.** It costs nothing, adds no credential and no provider, keeps the plaintext on
machines Onyx already trusts, and at this data size a daily run on a PC that is used most days meets
the 24 h target. Choose B instead if the PC is often off for days at a time.

## 5. Recovering for real (outline, used only with Riley's go-ahead)

Never restore over production without Riley's explicit approval: a whole-project restore rolls back
every Onyx table.

1. **Files lost or damaged, rows fine.** Run the check: `ready_documents_have_file`,
   `file_sizes_match` or `file_types_match` names how many. Decrypt the copies, upload each to its
   same `documents/<id>` path with its file type (service role), run the check against the newest
   manifest.
2. **Rows lost, files fine.** Restore to a new project from the daily backup (or decrypt the newest
   off-site snapshot), upsert `medical_documents` then `lab_results` by id, run the check.
3. **Project gone.** Supabase removes a deleted project's backups, so only the off-site copy helps:
   new project, apply the schema files, upsert the rows from the snapshot, upload the files, point
   Vercel and the PC's key file at the new project, run the check.

## 6. Recovery drill with made-up files (runs only after Riley authorizes it)

Purpose: prove the whole loop once, timed, on an isolated target that never holds a real record.
**Target: a local Supabase stack on the PC** (Docker Desktop plus `npx supabase`; $0). Alternative:
a throwaway hosted project, billed by the hour while it exists and removed afterwards, named to the
check with `--drill-project <ref>`. The check refuses to open files on the production project.

The commands below follow the Supabase CLI and Storage API docs; they have not been run yet. Use
a PowerShell window in which `SUPABASE_ACCESS_TOKEN` is NOT set (section 2), and start it in the
repo root, because step 1 changes folder:
```powershell
$check = (Resolve-Path tools\medical_recovery\recovery_check.py).Path
$schema = (Resolve-Path sql\medical_records_schema.sql).Path
```

1. **Isolated stack.** In the same window:
   ```powershell
   winget install FiloSottile.age   # age and age-keygen (step 7), once
   $d = "$env:LOCALAPPDATA\Onyx\medical-drill"; New-Item -ItemType Directory -Force $d | Out-Null
   Set-Location $d; npx supabase init   # answer N to the Deno editor-settings questions
   # supabase\config.toml, section [api]: schemas = ["public", "graphql_public", "pds"]
   npx supabase start
   npx supabase status -o env   # API_URL (http://127.0.0.1:54321), ANON_KEY, SERVICE_ROLE_KEY: local demo keys, not secrets
   ```
   Use the JWT-style `ANON_KEY` and `SERVICE_ROLE_KEY` values. Newer CLIs also print
   `sb_publishable_...` / `sb_secret_...` keys; the check sends its key as a bearer token, which those
   are not (with them it reads INCOMPLETE, never PASS).
2. **Schema, exactly as production.** Run in the local database (Studio at http://127.0.0.1:54323,
   SQL editor): `CREATE SCHEMA pds; GRANT USAGE ON SCHEMA pds TO service_role, authenticated;` then
   the whole of `$schema` (the repo's `sql/medical_records_schema.sql`).
3. **Made-up files.** `python $check --write-synthetic "$d\files"`
   writes a one-page PDF and a 1x1 PNG whose only text is "SYNTHETIC RECOVERY DRILL DOCUMENT".
4. **Seed two documents and one linked lab result** (all text made up):
   ```powershell
   $api = "http://127.0.0.1:54321"; $svc = "<SERVICE_ROLE_KEY from step 1>"
   $h = @{ apikey = $svc; Authorization = "Bearer $svc" }
   $files = @(@{ f = "synthetic-drill-document.pdf"; t = "application/pdf" }, @{ f = "synthetic-drill-image.png"; t = "image/png" })
   $rows = foreach ($x in $files) {
     $id = [guid]::NewGuid().ToString(); $p = Join-Path "$d\files" $x.f
     Invoke-RestMethod -Method Post "$api/storage/v1/object/medical-records/documents/$id" -Headers $h -ContentType $x.t -InFile $p | Out-Null
     @{ id = $id; title = "Synthetic drill $($x.f)"; kind = "other"; doc_date = "2026-01-01"; mime_type = $x.t;
        size_bytes = (Get-Item $p).Length; storage_path = "documents/$id"; status = "ready";
        uploaded_at = (Get-Date).ToUniversalTime().ToString("o") }
   }
   $pdb = $h + @{ "Content-Profile" = "pds"; Prefer = "resolution=merge-duplicates" }
   Invoke-RestMethod -Method Post "$api/rest/v1/medical_documents" -Headers $pdb -ContentType "application/json" -Body (ConvertTo-Json @($rows))
   $lab = @{ id = [guid]::NewGuid().ToString(); test_name = "Synthetic drill test"; value_num = 1.5; collected_on = "2026-01-01"; document_id = $rows[0].id }
   Invoke-RestMethod -Method Post "$api/rest/v1/lab_results" -Headers $pdb -ContentType "application/json" -Body (ConvertTo-Json @($lab))
   ```
5. **A made-up signed-in user, then the baseline.** Set `$env:SUPABASE_SERVICE_ROLE_KEY` and
   `$env:SUPABASE_ANON_KEY` to the local `SERVICE_ROLE_KEY` and `ANON_KEY`, in this window only (for
   a drill target the check reads only these variables or a `--key-file` you name, never the
   production key file), and give the check a made-up user's token for the signed-in-user probe
   (the local stack confirms sign-ups by itself; the token lasts an hour):
   ```powershell
   $anon = $env:SUPABASE_ANON_KEY
   $s = Invoke-RestMethod -Method Post "$api/auth/v1/signup" -Headers @{ apikey = $anon } -ContentType "application/json" `
        -Body (ConvertTo-Json @{ email = "drill-user@example.com"; password = [guid]::NewGuid().ToString() })
   $env:SUPABASE_USER_ACCESS_TOKEN = $s.access_token
   ```
   Then `python $check --url http://127.0.0.1:54321 --skip-backups --write-manifest "$d\manifest.json"`
   must print PASS (it opens every file; the manifest is written only from a PASS, so a broken seed
   can never become the reference).
6. **Bytes-only loss.** This is what a database-only restore leaves: the file's row and list entry
   are there, its bytes are not. A HEAD request would still answer 200 (Storage answers it from the
   row), so this confirms on a real Storage server that the check's download notices the loss.
   Delete one file's bytes inside the local storage container:
   ```powershell
   $c = docker ps --format "{{.Names}}" | Where-Object { $_ -like "supabase_storage_*" }
   docker exec $c sh -c "find /mnt /var/lib/storage -path '*$($rows[0].id)*' -type f -delete 2>/dev/null"
   ```
   The check (`python $check --url http://127.0.0.1:54321 --skip-backups --open-files --manifest "$d\manifest.json"`)
   must FAIL on `files_stored` while `ready_documents_have_file` still passes. (The local file
   backend answers 500 for the missing file, which the check retries twice and then counts as not
   served; a hosted project answers not-found.) If it reads INCOMPLETE instead, write down the
   `download` reason it prints (the HTTP status) and treat it as a finding to fix in the check
   before going on. Put the file back
   (`Invoke-RestMethod -Method Post "$api/storage/v1/object/medical-records/documents/$($rows[0].id)" -Headers ($h + @{ "x-upsert" = "true" }) -ContentType "application/pdf" -InFile "$d\files\synthetic-drill-document.pdf"`)
   and the check must PASS again.
7. **Back up** with the off-site job chosen in section 4, pointed at the local stack and a drill-only
   destination and a drill-only key pair (`age-keygen -o "$d\drill-key.txt"`, never the real key).
   Until that job exists, the same by hand: download both files and both tables
   (`GET $api/rest/v1/medical_documents?select=*` with `Accept-Profile: pds`) and encrypt each with
   `age -r <drill public key>` into `$d\offsite`.
8. **Disaster.** `npx supabase stop --no-backup` (this removes the local stack's data, and only the
   local stack), `npx supabase start`, repeat step 2. Step 6's check command must now FAIL (files
   and rows missing): this proves the check notices a loss.
9. **Restore and time it.** Decrypt with `age -d -i "$d\drill-key.txt"`, upsert the documents and
   then the lab results as in step 4, upload each file to its same path. Note the minutes taken: that
   is the measured RTO.
10. **Verify.** The wipe removed the made-up user as well, so repeat step 5's sign-up for a fresh
    token. Then step 6's check command must print PASS, which covers: every confirmed document's
    file is in the listing and downloads at its declared size; every file parses as its declared
    type (the PDF's cross-reference table, the PNG's chunks and pixel data: structure, not a
    rendering); every hash
    and size matches the manifest; every document's path, size, type, status and removed flag and
    every lab result's document link and removed flag match the manifest (a link that was cleared or
    now points at another document fails); a 60-second signed link (the app's own viewing path)
    serves the same bytes; the bucket is private with the right cap and types; the anon key and the
    made-up user's token each reach neither table, list no file and cannot reach a file directly (a
    refusal counts only after the key itself was accepted); and the public URL is refused. Then
    **open one restored file by hand**:
    ```powershell
    $l = Invoke-RestMethod -Method Post "$api/storage/v1/object/sign/medical-records/documents/$($rows[0].id)" -Headers $h -ContentType "application/json" -Body '{"expiresIn":60}'
    Start-Process "$api/storage/v1$($l.signedURL)"
    ```
    and note that Edge shows the blank synthetic page: this is the opening evidence for the receipt.
    Also run in the local SQL editor:
    `SELECT r.rolname, has_table_privilege(r.rolname, 'pds.medical_documents', 'SELECT') FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated', 'service_role');`
    (only `service_role` may say true) and `SELECT count(*) FROM pg_policies WHERE schemaname = 'storage';`
    (must be 0, as on production).
11. **Evidence and clean-up.** Save, privately (the audit folder, never the repo): date, the git SHA
    of the check, every JSON report (`--json`), the measured restore time, the note that the restored
    file opened, and the production backup dates from section 2. Then `npx supabase stop --no-backup`
    and move `$d` to the Recycle Bin.

**SEC-06 closes only when** the production backup dates have been read (section 2), an off-site
option is chosen and running, a drill has passed against its copy, and the receipt is saved. A merge
of this document does not close it.

## 7. The check: `tools/medical_recovery/recovery_check.py`

Read-only, standard-library Python, run by hand on the PC (no schedule, no heartbeat, no `/status`
card: the medical-records rule keeps counts out of `sync_log`, and a card is a decision in section 8).

```powershell
python tools\medical_recovery\recovery_check.py              # production: relationships, privacy, backup dates (INCOMPLETE at best: see Files)
python tools\medical_recovery\recovery_check.py --json       # the same as JSON (keep it private)
```

- Keys: `SUPABASE_SERVICE_ROLE_KEY` or `~/.onyx_supabase_secret` (that file holds the production
  key, so it is read for production only: a drill target gets the variable or a `--key-file` named
  explicitly, never that file); `SUPABASE_ANON_KEY` (the public key the site ships);
  `SUPABASE_USER_ACCESS_TOKEN` (a signed-in user's access token, which expires within an hour, for
  the signed-in-user probe); `SUPABASE_ACCESS_TOKEN` for the backup list (account-wide admin: the
  rules in section 2, one shell only, revoked after the run). Keys are never printed.
- It reads only id, path, size, type and state columns, never a title, note, test name or value, and
  prints counts and pass / fail / warn per check, never an id or path.
- Files: each confirmed document must be in the bucket listing with its declared size and type
  (the type compared the way the app's complete route does: no parameters, lower case). The
  listing, like a HEAD request, is read from the `storage.objects` row, which a database restore
  brings back even when the bytes are gone (Storage answers HEAD from that row and never asks the
  file store). So the bytes are proven only by downloading them: `files_stored` and
  `stored_sizes_match` pass only with `--open-files` on a drill target, and on production they are
  reported as unknown. **A production run therefore ends INCOMPLETE at best**, with those two checks
  the only unknowns; every other line is read normally, and any FAIL is a finding. Byte evidence
  comes from the drill and, once it runs, from the off-site job, which reads every file when it
  copies it.
- Privacy: the anon key and a signed-in user's token must each be accepted by a harmless read first
  (`/auth/v1/settings`, `/auth/v1/user`). After that, a table counts as refused only on PostgREST's
  permission answer (`42501` or `PGRST106`), and a listing only when it answers a list (with no
  policy Storage answers an empty one) or "bucket not found". Listing and download are separate
  permissions in Storage, so each role also gets a HEAD request on one file's download route (the
  same row-level check a download makes, no bytes sent), and the public URL is probed with HEAD as
  well. A stale or rotated key, any other answer (for example "Invalid Compact JWS") and a
  malformed listing are incomplete, never a privacy pass. Without a user token the signed-in-user
  checks are incomplete: on production that token is Riley's own sign-in (decision 7 below); the
  catalog query in section 6 step 10 is the manual alternative.
- On production it never downloads a file: `--open-files`, `--write-manifest` and `--skip-backups`
  run only on a local stack or a project named with `--drill-project` that is not production, and
  are refused before any request otherwise (so a production report never reads PASS without backup
  evidence). A manifest is written only from a PASS.
- Network errors, 429 and 5xx are retried twice (1 s, 2 s). A read that keeps failing, a refused
  read (401 / 403, with the exact access to ask for), a missing key or token is **incomplete**
  (exit 2), never a pass. A failed check exits 1; a pass exits 0.
- Tests: `tests/test_medical_recovery_check.py` (synthetic rows and files, a fake Supabase, no network).

## 8. Decisions for Riley

1. **Backup dates**: read them on Dashboard > Database > Backups (recommended), or create a
   personal access token for one run of the check. That token is account-wide admin (it can pause,
   restore or delete projects), so section 2's rules apply: shortest expiry, one shell only, never a
   saved variable, revoked right after the run.
2. **Off-site option**: A (recommended, $0), B (about $0 to $0.60 per month, one R2 token), C (new
   provider) or D (manual). Nothing is built until one is chosen.
3. **Encryption key**: approve creating the age key pair and where the private key is kept
   (password manager plus one printed copy).
4. **Drill**: authorize the drill in section 6 on a local stack (Docker Desktop if it is not
   installed) or on a throwaway hosted project (billed by the hour).
5. **Monitoring**: whether the backup job may write a count-free heartbeat and get a `/status` card
   (today's rule: no heartbeat for medical records).
6. **PITR**: not recommended (about $100 per month plus compute) for hand-typed, infrequent entries.
7. **Signed-in-user probe on production**: whether a production run should include it, which needs
   a short-lived access token from Riley's own sign-in set in `SUPABASE_USER_ACCESS_TOKEN` for that
   run (never saved). Without it, those two checks stay incomplete and the catalog query is the
   evidence instead.
