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
| The bucket's list of files (`storage.objects` rows) | Postgres | Yes, but only the list: the bytes are not in it | Comes back with the database, so a restore can list files whose bytes are gone |
| Bucket settings (private, 25 MB cap, six file types), RLS, grants | `sql/medical_records_schema.sql` in git | Not needed | Re-apply the SQL file |
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
  2. a Supabase personal access token (dashboard > Account > Access Tokens) is put in the
     environment variable `SUPABASE_ACCESS_TOKEN` on the PC (never in chat, a file under OneDrive
     or the repo), and `recovery_check.py` reads `GET /v1/projects/<ref>/database/backups`. It
     prints dates and counts only.
- The bucket `medical-records` is private, with the 26,214,400-byte cap and the six file types, and
  `storage.objects` has no policy. Both tables have RLS on and no policy. The anon role has no
  access to the `pds` schema; the signed-in (authenticated) role has no SELECT on either table;
  only the service role can read them.
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
  backup job is given only the public key, so it can encrypt but can never decrypt: a leaked job
  credential cannot read the copies. The private key lives in Riley's password manager and on one
  printed copy; never in the repo, never under OneDrive, never on a CI runner.
- **What each run copies**, in this order: (1) a snapshot of every column of both tables, as one
  encrypted JSON file; (2) every file whose `documents/<id>` is not in the copy yet, encrypted one
  file per object and named only by the id (`<id>.age`); (3) an encrypted manifest of path, size,
  SHA-256 and row counts (the format `recovery_check.py --manifest` reads). Taking the snapshot first
  means every confirmed row in a snapshot has its file in the copy.
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

The commands below follow the Supabase CLI and Storage API docs; they have not been run yet.

1. **Isolated stack.** In PowerShell:
   ```powershell
   $d = "$env:LOCALAPPDATA\Onyx\medical-drill"; New-Item -ItemType Directory -Force $d | Out-Null
   Set-Location $d; npx supabase init
   # supabase\config.toml, section [api]: schemas = ["public", "graphql_public", "pds"]
   npx supabase start
   npx supabase status   # API URL (http://127.0.0.1:54321), anon key, service_role key: local demo keys, not secrets
   ```
2. **Schema, exactly as production.** Run in the local database (Studio at http://127.0.0.1:54323,
   SQL editor): `CREATE SCHEMA pds; GRANT USAGE ON SCHEMA pds TO service_role, authenticated;` then
   the whole of the repo's `sql/medical_records_schema.sql`.
3. **Made-up files.** `python tools\medical_recovery\recovery_check.py --write-synthetic "$d\files"`
   writes a one-page PDF and a 1x1 PNG whose only text is "SYNTHETIC RECOVERY DRILL DOCUMENT".
4. **Seed two documents and one linked lab result** (all text made up):
   ```powershell
   $api = "http://127.0.0.1:54321"; $svc = "<service_role key from step 1>"
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
5. **Baseline.** With `$env:SUPABASE_SERVICE_ROLE_KEY` and `$env:SUPABASE_ANON_KEY` set to the local
   keys: `python tools\medical_recovery\recovery_check.py --url http://127.0.0.1:54321 --skip-backups --write-manifest "$d\manifest.json"`
   must print PASS.
6. **Back up** with the off-site job chosen in section 4, pointed at the local stack and a drill-only
   destination and a drill-only key pair (`age-keygen -o "$d\drill-key.txt"`, never the real key).
   Until that job exists, the same by hand: download both files and both tables
   (`GET $api/rest/v1/medical_documents?select=*` with `Accept-Profile: pds`) and encrypt each with
   `age -r <drill public key>` into `$d\offsite`.
7. **Disaster.** `npx supabase stop --no-backup` (this removes the local stack's data, and only the
   local stack), `npx supabase start`, repeat step 2. The check with `--manifest "$d\manifest.json"`
   must now FAIL (files and rows missing): this proves the check notices a loss.
8. **Restore and time it.** Decrypt with `age -d -i "$d\drill-key.txt"`, upsert the documents and
   then the lab results as in step 4, upload each file to its same path. Note the minutes taken: that
   is the measured RTO.
9. **Verify.** `python tools\medical_recovery\recovery_check.py --url http://127.0.0.1:54321 --skip-backups --open-files --manifest "$d\manifest.json"`
   must print PASS, which covers: every file opens as its declared type, every hash and size matches
   the manifest, a 60-second signed link (the app's own viewing path) serves the same bytes, the
   bucket is private with the right cap and types, the anon key reaches neither table and lists no
   file, the public URL is refused, and every lab result's document link resolves. Also run in the
   local SQL editor: `SELECT r.rolname, has_table_privilege(r.rolname, 'pds.medical_documents', 'SELECT') FROM pg_roles r WHERE r.rolname IN ('anon', 'authenticated', 'service_role');`
   (only `service_role` may say true).
10. **Evidence and clean-up.** Save, privately (the audit folder, never the repo): date, the git SHA
    of the check, both JSON reports (`--json`), the measured restore time and the production backup
    dates from section 2. Then `npx supabase stop --no-backup` and move `$d` to the Recycle Bin.

**SEC-06 closes only when** the production backup dates have been read (section 2), an off-site
option is chosen and running, a drill has passed against its copy, and the receipt is saved. A merge
of this document does not close it.

## 7. The check: `tools/medical_recovery/recovery_check.py`

Read-only, standard-library Python, run by hand on the PC (no schedule, no heartbeat, no `/status`
card: the medical-records rule keeps counts out of `sync_log`, and a card is a decision in section 8).

```powershell
python tools\medical_recovery\recovery_check.py              # production: relationships, privacy, backup dates
python tools\medical_recovery\recovery_check.py --json       # the same as JSON (keep it private)
```

- Keys: `SUPABASE_SERVICE_ROLE_KEY` or `~/.onyx_supabase_secret`; `SUPABASE_ANON_KEY` (the public
  key the site ships); `SUPABASE_ACCESS_TOKEN` for the backup list. Keys are never printed.
- It reads only id, path, size, type and state columns, never a title, note, test name or value, and
  prints counts and pass / fail / warn per check, never an id or path.
- On production it never downloads a file: `--open-files` and `--write-manifest` run only on a local
  stack or a project named with `--drill-project` that is not production, and are refused before any
  request otherwise.
- Network errors, 429 and 5xx are retried twice (1 s, 2 s). A read that keeps failing, a refused
  read (401 / 403, with the exact access to ask for), a missing key or token is **incomplete**
  (exit 2), never a pass. A failed check exits 1; a pass exits 0.
- Tests: `tests/test_medical_recovery_check.py` (synthetic rows and files, a fake Supabase, no network).

## 8. Decisions for Riley

1. **Backup dates**: read them on Dashboard > Database > Backups, or create a personal access token
   for the check (section 2).
2. **Off-site option**: A (recommended, $0), B (about $0 to $0.60 per month, one R2 token), C (new
   provider) or D (manual). Nothing is built until one is chosen.
3. **Encryption key**: approve creating the age key pair and where the private key is kept
   (password manager plus one printed copy).
4. **Drill**: authorize the drill in section 6 on a local stack (Docker Desktop if it is not
   installed) or on a throwaway hosted project (billed by the hour).
5. **Monitoring**: whether the backup job may write a count-free heartbeat and get a `/status` card
   (today's rule: no heartbeat for medical records).
6. **PITR**: not recommended (about $100 per month plus compute) for hand-typed, infrequent entries.
