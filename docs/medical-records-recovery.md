# Medical records: backup and recovery (SEC-06, 2026-11-16)

The decisions are recorded in section 8 (2026-11-16): off-site option A, PITR off, and a count-free
heartbeat for the backup job. The read-only check `tools/medical_recovery/recovery_check.py` and the
backup job with its restore drill, `tools/medical_recovery/offsite_backup.py` (section 9, built
2026-11-16), both exist. Creating the key, registering the weekly task, the first real backup and the
first drill are run after review; until then nothing copies a real record out of Supabase.

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
| Backup encryption key (sections 4, 9) | `~/.onyx_backup_age_key` on the PC (signed-in user only), the password manager, one printed copy | Never stored online, never under OneDrive | Riley's password manager entry or the printed copy |

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
| With the PITR add-on | 2 minutes (Supabase docs) | under 1 h | About $100 per month for 7 days of recovery, plus at least the Small compute add-on. **Stays off** (decision 6): entries are typed by hand, rarely, so a day is easy to re-enter |

### Original files

| Situation | RPO | RTO | Notes |
|---|---|---|---|
| Today | **no recovery point**: nothing outside the bucket holds a copy | not recoverable | A deleted or corrupted file is gone unless the device it was uploaded from still has it |
| With the off-site plan | up to 24 h | 1 to 2 h at the expected size | Decrypt and upload each missing file to its same `documents/<id>` path, then run the check |

**Proposed targets:** rows RPO 24 h / RTO 4 h; files RPO 24 h / RTO 4 h. A lost day of typing can be
redone; a lost original usually cannot, which is why the files are the priority.

## 4. Off-site copy: encrypted, with retention (option A chosen; built: section 9)

As built (section 9), each weekly run writes ONE self-contained encrypted pack (both tables, every
file, the recovery manifest and the manifest), kept as the newest 8 packs plus the first pack of each
of the 3 most recent months. That replaces the per-file copies and the 30-daily / 12-monthly snapshot
schedule sketched below: every pack restores on its own, and the drill checks exactly that.

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
- **Output**: counts only, never names or content. **Monitoring (decision 5):** the backup job may
  write a heartbeat that carries no counts (only success / failure, a short error code and the
  time) and gets a `/status` card, so a stale backup shows there. This is the one exception to the
  medical-records "no heartbeat" rule, and it applies to the backup job only. The check below stays
  manual and writes nothing.

### Options (prices as published at the time of writing; confirm on the pricing page before approving)

| Option | Monthly cost | Deletion protection | New credential | New provider | Trade-off |
|---|---|---|---|---|---|
| **A. PC job to OneDrive**: a Task Scheduler job on Riley's PC (like the Kindle harvester) writes the encrypted copies into a OneDrive folder | $0 extra (inside the existing Microsoft 365 storage) | OneDrive recycle bin (30 days), version history and "Restore your OneDrive" | None (uses the PC's existing key file) | No | Runs only while the PC is on (missed runs catch up when it wakes); Microsoft holds the ciphertext |
| **B. GitHub Actions to Cloudflare R2**: a nightly workflow writes to a private R2 bucket with a bucket lock rule (for example 30 days) | $0 within R2's free 10 GB-month, then $0.015 per GB-month (about $0.60 at the 50 GB worst case: 2,000 documents at the 25 MB cap) | R2 bucket lock | One R2 API token limited to that bucket, as a GitHub secret | No (Cloudflare already runs the reminders Worker) | Independent of the PC; the plaintext passes through a GitHub-hosted runner's memory, and the repo's logs are public (counts-only output is mandatory) |
| **C. Backblaze B2 with Object Lock** | first 10 GB free, then about $6 to $7 per TB-month (well under $1 at 50 GB) | Object Lock | One B2 application key | **Yes** (needs approval) | Same as B, on a provider Onyx does not use yet |
| **D. Encrypted USB drive** (BitLocker), swapped off-site by hand | $0 (about $60 once for a drive) | Physical | None | No | Not automatic: a recurring chore, which Riley prefers to avoid |

**Chosen: A** (decision 2). It costs nothing, adds no credential and no provider, keeps the plaintext
on machines Onyx already trusts, and at this data size a daily run on a PC that is used most days
meets the 24 h target. Revisit B only if the PC turns out to be off for days at a time (the job's
heartbeat will show that).

## 5. Recovering for real (outline, used only with Riley's go-ahead)

Never restore over production without Riley's explicit approval: a whole-project restore rolls back
every Onyx table.

1. **Files lost or damaged, rows fine.** Run the check: `ready_documents_have_file`,
   `file_sizes_match` or `file_types_match` names how many. Decrypt the copies, upload each to its
   same `documents/<id>` path with its file type (service role), run the check against the newest
   manifest.
2. **Rows lost, files fine.** Restore to a new project from the daily backup (or decrypt the newest
   off-site snapshot), upsert `medical_documents` then `lab_results` by id, run the check against
   production. The temporary project holds real records: never run the check against it, and never
   name it with `--drill-project` (that would treat it as a drill target, where the check downloads
   every file).
3. **Project gone.** Supabase removes a deleted project's backups, so only the off-site copy helps:
   new project, apply the schema files, upsert the rows from the snapshot, upload the files, point
   Vercel and the PC's key file at the new project. The check only accepts the production project
   it was built for (section 7), so before it can check the restored records it has to be pointed at
   the new project in a reviewed commit: set `PRODUCTION_REF` in `tools/medical_recovery/recovery_check.py`
   to the new project's ref (the default URL and the only origin that receives the production keys
   follow from it) and update the production ref in `tests/test_medical_recovery_check.py`. There is
   deliberately no flag or environment variable for this. Until that commit is in, the new project
   is refused like any other host. Never use `--drill-project` with it instead: the new project holds
   real records, and a drill target is where the check downloads files. Then run the check.

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
5. **A made-up signed-in user, then the baseline.** Set `$env:RECOVERY_DRILL_SERVICE_KEY` and
   `$env:RECOVERY_DRILL_ANON_KEY` to the local `SERVICE_ROLE_KEY` and `ANON_KEY`, in this window only.
   A drill target gets only these drill variables or a `--key-file` you name: never
   `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_USER_ACCESS_TOKEN` or the production key file, which may
   hold production credentials in this shell. Give the check a made-up user's token for the
   signed-in-user probe (the local stack confirms sign-ups by itself; the token lasts an hour):
   ```powershell
   $anon = $env:RECOVERY_DRILL_ANON_KEY
   $s = Invoke-RestMethod -Method Post "$api/auth/v1/signup" -Headers @{ apikey = $anon } -ContentType "application/json" `
        -Body (ConvertTo-Json @{ email = "drill-user@example.com"; password = [guid]::NewGuid().ToString() })
   $env:RECOVERY_DRILL_USER_TOKEN = $s.access_token
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
7. **Back up** with the off-site job (section 9), pointed at the local stack, a drill-only
   destination and a drill-only key pair, never the real key:
   ```powershell
   $job = (Resolve-Path tools\medical_recovery\offsite_backup.py).Path   # set in the repo root, with $check
   age-keygen -o "$d\drill-key.txt"; age-keygen -y "$d\drill-key.txt" > "$d\drill-recipient.txt"
   python $job backup --url http://127.0.0.1:54321 --recipient-file "$d\drill-recipient.txt" --dest "$d\offsite"
   python $job drill --dest "$d\offsite" --identity "$d\drill-key.txt"   # must print PASS
   ```
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
    made-up user's token each reach neither table, list no file and cannot download a file directly
    (a real GET of a made-up file, because Storage checks a download and a HEAD separately; a refusal
    counts only after the key itself was accepted); and the public URL refuses a download too. The
    file check is a structural parse, so the report lists `file_opened_in_viewer` under "not
    checked". That is covered by the next step: **open one restored file by hand**:
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

**SEC-06 closes only when** the production backup dates have been read (section 2), the option A
job is running, a drill has passed against its copy (including a person opening a restored file),
a production run of the check has no unknowns but the two byte checks and the three
download-refusal checks (section 7), a fresh catalog read on production stands in for those
download refusals (no policy on any `storage` table, RLS on for `storage.objects` and
`storage.buckets`, the bucket private: the queries of section 2 and step 10; this check cannot
prove them on production because it never downloads a real record), and the receipt holding all of
it is saved. A merge of this document does not close it.

## 7. The check: `tools/medical_recovery/recovery_check.py`

Read-only, standard-library Python, run by hand on the PC. It has no schedule, no heartbeat and no
`/status` card: the medical-records rule keeps counts out of `sync_log`, and the heartbeat allowed
in decision 5 belongs to the backup job, not to this check. It is a standalone command-line tool, a
scope accepted in decision 8.

```powershell
python tools\medical_recovery\recovery_check.py              # production: relationships, privacy, backup dates (INCOMPLETE at best: see Files)
python tools\medical_recovery\recovery_check.py --json       # the same as JSON (keep it private)
```

- Where it may send anything: the target is decided from the exact origin **before any key is
  read**. Production is exactly `https://<production ref>.supabase.co`. A drill target is a local
  stack (`localhost`, `127.0.0.1`, `::1`) or the hosted project named with `--drill-project`, and is
  never production. Any other `--url` or `SUPABASE_URL` is refused, and nothing is read or sent: no
  other host, no `http`, no other port, no path, no user name in the URL, and no hosted project that
  was not named. Every request is checked against that one origin before it is sent; the personal
  access token is checked against the Management API's origin. Redirects are never followed (a 3xx
  is reported as unreadable), no proxy from the environment is used, and a signed download link is
  fetched only when it is the target's own signed route for that very file. The production project
  is one constant in the check (`PRODUCTION_REF`), with no flag or variable to change it; if
  production ever moves to a new project, it is changed in a reviewed commit first (section 5,
  case 3).
- Keys on production: `SUPABASE_SERVICE_ROLE_KEY` or `~/.onyx_supabase_secret`;
  `SUPABASE_ANON_KEY` (the public key the site ships); `SUPABASE_USER_ACCESS_TOKEN` (a signed-in
  user's access token, which expires within an hour, for the signed-in-user probe). Keys on a drill
  target come only from their own variables (`RECOVERY_DRILL_SERVICE_KEY` or a `--key-file` named
  explicitly that is not the production key file, `RECOVERY_DRILL_ANON_KEY`,
  `RECOVERY_DRILL_USER_TOKEN`), so production credentials sitting in the shell are never sent to a
  drill target. A drill key or token whose JWT names the production project is refused.
  `SUPABASE_ACCESS_TOKEN` is used for the backup list (account-wide admin: the rules in section 2,
  one shell only, revoked after the run). Keys are never printed.
- It reads only id, path, size, type and state columns, never a title, note, test name or value, and
  prints counts and pass / fail / warn per check, never an id or path.
- Files: each confirmed document must be in the bucket listing with its declared size and type
  (the type compared the way the app's complete route does: no parameters, lower case). The
  listing, like a HEAD request, is read from the `storage.objects` row, which a database restore
  brings back even when the bytes are gone (Storage answers HEAD from that row and never asks the
  file store). So the bytes are proven only by downloading them: `files_stored` and
  `stored_sizes_match` pass only with `--open-files` on a drill target, and on production they are
  reported as unknown. Byte evidence comes from the drill and, once it runs, from the off-site job,
  which reads every file when it copies it.
- `files_parse_as_declared_type` (drill only) is a **structural parse**: the PDF cross-reference
  table, PNG chunks and pixel data, JPEG segments, WebP chunks and HEIF boxes. It catches a
  truncated, swapped or look-alike file, but no decoder renders a page, and a JPEG's scan data is
  not decoded. So every report lists `file_opened_in_viewer` under "not checked", and a PASS of
  this tool is not recovery acceptance on its own. A person opening a restored file (section 6
  step 10) covers that.
- Privacy: the anon key and a signed-in user's token must each be accepted by a harmless read first
  (`/auth/v1/settings`, `/auth/v1/user`). After that, a table counts as refused only on PostgREST's
  permission answer (`42501` or `PGRST106`). A listing counts as refused only when it answers a
  list of well-formed entries (with no policy Storage answers an empty one) or "bucket not found";
  any entry at all, file or folder, means the role sees the bucket. Listing and download are
  separate permissions in Storage, and so are a HEAD (object info) and a download (GET). So each
  role also probes one file's download route, and the public URL is probed too:
  - on a drill target with a **real GET** of a made-up file, so a refusal there proves a download
    is refused;
  - on production with a **HEAD**, so no byte of a real record is ever sent. A HEAD that succeeds
    is a FAIL. A refused HEAD proves nothing about a download, so `anon_file_refused`,
    `authenticated_file_refused` and `public_url_refused` are reported as unknown. For production
    the evidence that downloads are refused is the catalog read in section 2 (no policy on any
    storage table, private bucket).

  A stale or rotated key, any other answer (for example "Invalid Compact JWS"), a malformed listing
  and a listing with a malformed entry (`[null]`, `["x"]`, an entry without a name) are incomplete,
  never a privacy pass. Each probe stands on its own: a reach one probe saw (a table that answered,
  a listed entry, a served file) is a FAIL even when a later probe could not be read, while a
  refusal still counts only after the key was accepted (and, for a file, after the role's own
  listing answered). On a drill target the same holds for the downloads: a file found missing, the
  wrong size or not parsing stays a FAIL when a later download fails, and the files not tried by
  then stay unknown. Without a user token the signed-in-user checks are incomplete. On
  production that token is Riley's own sign-in (decision 7); the catalog query in section 6 step 10
  is the manual alternative.
- **A production run therefore ends INCOMPLETE at best.** Its only unknowns are then the two byte
  checks and the three download-refusal checks; every other line is read normally, and any FAIL is
  a finding.
- On production it never downloads a file: `--open-files`, `--write-manifest` and `--skip-backups`
  run only on a drill target and are refused before any request otherwise (so a production report
  never reads PASS without backup evidence). A manifest is written only from a PASS.
- A manifest is used only when it is a real reference. The comparisons walk the manifest's own
  entries, so a manifest whose lists were emptied or cut short would let an empty restore PASS.
  `--manifest` therefore refuses, before anything is sent (incomplete, exit 2), a manifest that has
  other fields than the check writes, an entry of another shape or with a value the database does
  not allow, counts that do not match the rows it lists, a ready document without its file (or at
  another size), a lab result linked to a document it does not list, two documents with one path,
  or nothing in it at all. The same rule applies when one is written: a baseline that would make such
  a manifest (an empty store, say) writes none. The refusal names the rule, never an id or a path.
- Network errors, 429 and 5xx are retried twice (1 s, 2 s). A read that keeps failing, a refused
  read (401 / 403, with the exact access to ask for), a missing key or token is **incomplete**
  (exit 2), never a pass. A refused target also exits 2. A failed check exits 1; a pass exits 0.
- Tests: `tests/test_medical_recovery_check.py` (synthetic rows and files, a fake Supabase, no network).

## 8. Decisions (2026-11-16)

Recorded 2026-11-16, under Riley's delegation that day of the remaining SEC-06 product and ops
decisions; Riley's merge of this change confirms them.

1. **Backup dates**: still to be read, in the follow-up work. Route 1 (Dashboard > Database >
   Backups) is the default. A personal access token for one run of the check is the alternative,
   under section 2's rules: shortest expiry, one shell only, never a saved variable, revoked right
   after the run.
2. **Off-site option: A**, the PC job to OneDrive ($0, no new credential, no new provider). It is
   built in the follow-up work, not in this document's change.
3. **Encryption key**: an age key pair, with the private key in Riley's password manager plus one
   printed copy, created with the backup job in the follow-up work.
4. **Drill**: section 6 on an isolated target with made-up files only, run in the follow-up work
   once the job exists.
5. **Monitoring: yes.** The backup job may write a heartbeat with no counts (success / failure, a
   short error code and the time) and gets a `/status` card. Only the backup job; the check stays
   silent.
6. **PITR: stays off** (about $100 per month plus compute) for hand-typed, infrequent entries.
7. **Signed-in-user probe on production: included.** Every request it makes is read-only (the token
   check, a one-row table read, a one-entry listing and a HEAD on one file, so no byte of a record
   is sent). It needs a short-lived access token from Riley's own sign-in in
   `SUPABASE_USER_ACCESS_TOKEN` for that run (never saved). Without it, those checks stay incomplete
   and the catalog query is the evidence instead.
8. **Scope: accepted.** The check is a standalone, manual, read-only command-line tool rather than a
   small inline check, because criterion 3 needs the evidence it reports. The audit's two-week
   benefit check still applies: if it adds burden without a safety benefit, simplify it while
   keeping the privacy and integrity rules.

## 9. The backup job: `tools/medical_recovery/offsite_backup.py` (built 2026-11-16)

Option A as built. Standard-library Python plus the `age` command-line tool (`winget install
FiloSottile.age`; the job finds it on PATH or in winget's folders). Chosen over the Python `pyrage`
or `cryptography` packages: `age` streams (no file is ever written in the clear), is the reference
implementation of the format, and needs no pip install on the PC.

```powershell
python tools\medical_recovery\offsite_backup.py keygen          # once: the key pair (below)
python tools\medical_recovery\offsite_backup.py backup --dry-run  # read + pack in memory, print counts, write nothing
python tools\medical_recovery\offsite_backup.py backup            # what the weekly task runs
python tools\medical_recovery\offsite_backup.py drill --hold      # restore drill; --hold pauses so a person opens a file
pwsh -File tools\medical_recovery\register-task.ps1               # the weekly task "Onyx Medical Backup"
```

- **Key.** `keygen` runs `age-keygen` once: the private key goes to `~/.onyx_backup_age_key` (access
  limited to the signed-in user with `icacls`), the public recipient to `~/.onyx_backup_age_recipient`.
  It refuses to overwrite either file (a new key could not read the old backups) and refuses any path
  under OneDrive or in the repo. **Right after, copy the private key file's contents into the password
  manager and print one copy**: without it no backup can be decrypted. The backup reads only the
  recipient file and refuses one that holds a private key; only `drill` (through `age`) reads the key.
- **What a run reads** (read-only, service role from `~/.onyx_supabase_secret`, the same target rules
  as the check: production is the exact production origin, anything else is refused before a key is
  read): every column of `pds.medical_documents` and `pds.lab_results`, the bucket listing, every file
  under `documents/`, PostgREST's schema description of `pds` (the schema-only part; the repo's `sql/`
  files are the full schema), and a fixed list of hand-entered `pds` tables Onyx cannot fetch again from
  a source (`REBUILD_TABLES` in the job: habits, supplements, weight, reading, care items, layouts, the
  time-zone log, Uber Eats portions, the finance ledger and plan, procurement, the experiment protocols;
  the finance tables are included on purpose: they are encrypted with the rest and the private key never
  leaves the PC and the password manager). **Not covered, on purpose (`UNCOVERED_TABLES`):**
  `pds.experiment_days` (trial adherence). Its required foreign key points into the trial schedule, which
  is never copied (concealment), so a copy could not be restored into the declared schema; it stays out
  until the schedule has a recovery path of its own, and every manifest lists it under
  `uncovered_tables`. Tables are paged by primary key with a keyset cursor (each page asks for
  the rows after the last key read, never an OFFSET, so a row removed or added between two pages cannot
  push an unread row out of the read), and after the last page the table's keys are read again: the copy
  is used only when they match exactly; otherwise the table is read once more, then counts as unreadable.
  A table with no primary key (or one of a type the cursor cannot compare) is not copied and the run is
  partial (`rebuild_table_unkeyed`). Storage pages its listing by offset, so the listing is read twice
  and must agree (`listing_changed` otherwise, partial). Tables are read one after another, so after the
  last one every foreign key between two copied tables (from the schema description, plus a lab result's
  document) is checked: a row whose parent row the copy does not hold (a stack and its items created or
  removed between the two reads) makes the job read both tables again, up to 3 times; still broken is
  partial (`tables_inconsistent`). A copied row that points into a table no backup holds is partial
  (`parent_not_recoverable`). Known limit: a row changed (not added or removed) during its table's read
  may be copied as it was a moment earlier. Credentials (`ci_tokens`) and the N-of-1
  trial seed and schedule are never read. A listed table the schema does not know is noted as missing
  in the manifest, not a failure. The tables and the listing are read before encryption starts, so a
  failed core read leaves no file anywhere.
- **What a run writes.** One tar stream piped straight into `age -r <recipient>`: the plaintext exists
  only in the job's memory and the pipe, one file at a time, never on disk. Members: `schema/openapi.json`,
  `tables/pds/<table>.json`, `objects/documents/<id>`, `recovery-manifest.json` (the check's
  `--manifest` format, included only when the copy is complete) and `manifest.json` last (each table's
  rows, bytes and SHA-256, each file's size, type and SHA-256). The ciphertext is written to
  `%LOCALAPPDATA%\Onyx\backup-tmp`, copied into `~/OneDrive/Backups/onyx` under a hidden `.partial`
  name, then renamed `onyx-backup-<UTC time>.tar.age`; the temporary copy is removed. Plaintext never
  touches OneDrive or the repo. A run counts as off-site only when the ciphertext itself is confirmed in
  the OneDrive cloud. First the folder must be under an existing OneDrive folder with the client running
  (else `offsite_unsynced`, nothing pruned; a cheap negative pre-check only); then the job polls the new
  file's own cloud-files state for up to `--sync-wait` seconds (default 300). The state is read with
  `GetFileAttributesW` — the cfapi placeholder bits `attrib` prints: `FILE_ATTRIBUTE_OFFLINE` (0x1000),
  `FILE_ATTRIBUTE_RECALL_ON_OPEN` (0x40000), `FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS` (0x400000),
  `FILE_ATTRIBUTE_PINNED` (0x80000), `FILE_ATTRIBUTE_UNPINNED` (0x100000) and
  `FILE_ATTRIBUTE_REPARSE_POINT` (0x400). OneDrive takes a local file into the cloud by converting it into
  a cloud-files placeholder, so one of those bits is the cloud's receipt for the upload; a plain local
  file, an unreadable one, a path outside OneDrive or a non-Windows host reads `pending_upload` (a
  **partial** run, nothing pruned). Only then does the one writer of the remote record
  (`record_remote_confirmation`: backup name, size and time in
  `%LOCALAPPDATA%\Onyxackup-stateemote-confirmations.json`, never under OneDrive or in the repo)
  store the confirmation. Elapsed time is not evidence of upload. `keygen` refuses one path for both key
  files.
- **Retention**, applied after every run whose ciphertext is confirmed in the cloud (an unconfirmed run
  prunes nothing): the newest 8 backups, plus the first backup of each of the 3 most recent months, plus
  the newest backup whose completeness marker verifies, plus the newest backup the remote record
  confirms, wherever they fall. When no backup is confirmed off-site at all, nothing is pruned
  (`offsite_unconfirmed`); a confirmation whose file changed size no longer counts. A fully successful run commits `onyx-backup-<UTC time>.ok` next to its backup (the backup's name
  and size, nothing else; written under a hidden name, renamed, read back); a backup counts as complete
  only when that marker reads back and matches the file. If the marker cannot be committed the run is
  **failed** (`marker_unwritable`, failed heartbeat, exit 1) and nothing is pruned. Every marker is
  checked before anything is removed, by an explicit file status call (not `Path.is_file()`, which on
  Python 3.14 calls an unreadable file absent), and every removal is decided before the first is made: an
  error reading or checking any of this job's files stops the prune with nothing removed. Only names this job
  writes are removed (OneDrive keeps them 30 days in its recycle bin); a failed run removes nothing.
  Ciphertext a killed run left in `backup-tmp` is removed after a day.
- **Partial and failed runs.** A confirmed document whose file is not listed or not served
  (`files_missing`), a file whose size differs from its row or listing (`size_mismatch`), a file that
  keeps failing after two retries (`files_unread`), entries outside `documents/<id>`, a wider table that
  cannot be read, a wider table or file larger than one member may be (64 MiB, the drill's own limit:
  `table_too_large`, `files_too_large`): the pack is still written, without the recovery manifest, and the
  run is `partial`. A medical table over that limit fails the run (`medical_table_too_large`).
  A refused read, a failed read of a medical table or the listing, no recipient, no `age`, a failed
  encryption or write, a crash: `failed`, nothing in the backup folder.
- **Heartbeat** (decision 5): one `pds.sync_log` row per production run, source `backup`, data type
  `medical_records`, status `success` / `partial` / `failed`, `records_synced` always 0, `error_message`
  only a short code (`files_missing`, `crash_OSError`). It is sent through the backup's own request path
  to exactly the production origin with the service-role key the backup resolved (never
  `ONYX_SUPABASE_URL` / `ONYX_SUPABASE_SECRET_FILE`), and a heartbeat that cannot be written never changes
  the run's outcome. A dry run, a drill-target run and a drill write none. `/status` card **Medical Backup**: more than 8 days without a run degraded, more than 15 days or
  a failed run red, with what to do per code (`lib/medical-backup-status.ts`). Printed output and the
  log (`%LOCALAPPDATA%\Onyx\medical-backup\backup.log`) hold counts and codes only.
- **Restore drill** (`drill`): decrypts the newest backup into a new folder under
  `%LOCALAPPDATA%\Onyx\backup-drill` (never into Supabase; refused under OneDrive, in the repo or in the
  backup folder), refuses and never extracts any member outside the pack's names, then checks every
  table's SHA-256, bytes and row count, every file's size and SHA-256, that nothing is missing or extra,
  that every lab result's document link and every ready document's file are in the pack, that every
  foreign key the pack's own schema declares between its tables holds and none points into a table no
  backup holds (`references_hold`), that the backup
  recorded no problem (`backup_complete`: a partial backup never passes, even when what it holds
  verifies), and that the recovery manifest is valid and agrees with the files. It prints counts, booleans, the restore time and
  the backup's age, and removes the decrypted folder, also when a check or the decryption fails.
  `--hold` writes `open-me.<ext>` (a copy of one restored document) and waits for Enter, so a person
  opens it before the folder is removed: that is the `file_opened_in_viewer` evidence.
- **Weekly task** (`register-task.ps1`): Sunday 11:10, signed-in user only, `pythonw.exe` (no window),
  runs on battery, catches up after sleep, one hour limit, never wakes the PC.
- Tests: `tests/test_medical_offsite_backup.py` (synthetic rows and files, a fake Supabase, a fake
  cipher), `frontend/tests/medical-backup-status.test.cjs` (the card).
