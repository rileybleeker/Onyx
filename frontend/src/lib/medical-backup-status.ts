// The /status card for the encrypted off-site backup of /health/records (tools/medical_recovery/
// offsite_backup.py on Riley's PC, weekly, docs/medical-records-recovery.md section 9). Pure: no I/O,
// no imports, so /api/status and the tests use it as is.
//
// What it reads: the newest pds.sync_log row with source "backup", data_type "medical_records". The job
// writes no counts there (decision 5 of the recovery doc: success / partial / failed, a short error code
// and the time), so the card shows the age of the last run and what to do, never a number of records.
// Weekly job on a PC that may be off: more than 8 days without a run = degraded, more than 15 days (two
// missed weeks) or a failed run = red.

export type BackupHeartbeat = {
  status?: unknown;
  sync_start?: unknown;
  error_message?: unknown;
  duration_seconds?: unknown;
};

export type MedicalBackupCard = {
  label: string;
  lastSync: string | null;
  status: "success" | "partial" | "failed" | "unknown";
  latestDataDate: string | null;
  daysLag: number;
  recordsSynced: number;
  durationSeconds: number | null;
  errorMessage: string | null;
};

export const MEDICAL_BACKUP_SOURCE = "backup";
export const MEDICAL_BACKUP_DATA_TYPE = "medical_records";
export const MEDICAL_BACKUP_DEGRADED_DAYS = 8;
export const MEDICAL_BACKUP_FAILED_DAYS = 15;

const LABEL = "Medical Backup";
const TOOL = "tools/medical_recovery/offsite_backup.py";

/** A stored code is shown only when it looks like one (files_missing, crash_OSError); anything else
 * (a stray sentence) is never echoed. */
export function backupCode(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_]{1,60}$/.test(value) ? value : null;
}

/** What to do for a stored code. Generic per family, so a new code still reads sensibly. */
export function backupCodeMessage(code: string): string {
  if (code === "age_missing") return "The age tool is not installed on the PC (age_missing): winget install FiloSottile.age.";
  if (code === "recipient_missing" || code === "recipient_invalid")
    return `No usable backup key is set up on the PC (${code}). Finish the backup key setup on the PC, then check again.`;
  if (code === "key_missing") return "No service-role key on the PC (key_missing): restore ~/.onyx_supabase_secret.";
  if (code === "read_denied") return "Supabase refused the read (read_denied): check the service-role key in ~/.onyx_supabase_secret.";
  if (code.startsWith("read_failed")) return `Supabase could not be read (${code}); the next run retries.`;
  if (code === "medical_table_missing") return "A medical table is missing (medical_table_missing): run the recovery check.";
  if (code === "medical_table_too_large")
    return "A medical table is larger than one backup member allows (medical_table_too_large): the backup job needs chunking before it can copy it.";
  if (code === "encrypt_failed" || code === "dest_unwritable" || code === "tmp_unwritable")
    return `The encrypted copy could not be written (${code}): check the OneDrive backup folder and free disk space.`;
  if (code === "files_missing" || code === "files_unread" || code === "size_mismatch" || code === "recovery_manifest_refused"
      || code === "unexpected_paths" || code === "files_too_large")
    return `Some medical files were not copied as expected (${code}): run tools/medical_recovery/recovery_check.py.`;
  if (code === "rebuild_table_unreadable" || code === "schema_unread" || code === "table_too_large"
      || code === "schema_too_large")
    return `Part of the wider table copy was skipped (${code}); the medical records were copied.`;
  if (code === "rebuild_table_unkeyed")
    return "A wider table has no primary key the backup can page by (rebuild_table_unkeyed): run the dry run to see which, then give it a key or drop it from REBUILD_TABLES.";
  if (code === "listing_changed")
    return "Medical files were being added or removed while the backup listed them (listing_changed); the next run retries.";
  if (code === "tables_inconsistent")
    return "Tables kept changing while they were copied, so a row's parent row was missing from the copy (tables_inconsistent); the next run retries.";
  if (code === "parent_not_recoverable")
    return "A copied row points into a table no backup holds (parent_not_recoverable): see UNCOVERED_TABLES in the backup job.";
  if (code === "marker_unwritable")
    return "The backup was written but its completeness marker could not be saved (marker_unwritable): check write access to the OneDrive backup folder; nothing was pruned.";
  if (code === "pending_upload")
    return "The encrypted backup was written but OneDrive has not confirmed it in the cloud (pending_upload): check the OneDrive sync icon on the PC; nothing was pruned.";
  if (code === "locked") return "A backup run was already in progress (locked).";
  if (code.startsWith("crash_")) return `The backup job stopped with an error (${code}): see %LOCALAPPDATA%\\Onyx\\medical-backup\\backup.log.`;
  return `The last backup reported ${code}.`;
}

/** The card from the newest heartbeat (null = no run yet). `nowMs` is passed in so the tests pin time. */
export function medicalBackupCard({ entry, nowMs }: { entry: BackupHeartbeat | null; nowMs: number }): MedicalBackupCard {
  const start = typeof entry?.sync_start === "string" ? entry.sync_start : null;
  const startMs = start ? new Date(start).getTime() : NaN;
  const ageDays = Number.isFinite(startMs) ? Math.max(0, (nowMs - startMs) / 86400000) : Infinity;
  const raw = entry?.status;
  const code = backupCode(entry?.error_message);
  const duration = typeof entry?.duration_seconds === "number" && Number.isFinite(entry.duration_seconds)
    ? entry.duration_seconds : null;
  const base = {
    label: LABEL,
    lastSync: start,
    latestDataDate: start ? start.slice(0, 10) : null,
    daysLag: Number.isFinite(ageDays) ? Math.floor(ageDays) : 999,
    // The job keeps counts out of sync_log (decision 5): never show a records number.
    recordsSynced: 0,
    durationSeconds: duration,
  };
  if (!entry || !start || !Number.isFinite(startMs)) {
    return { ...base, status: "unknown",
      errorMessage: "No backup yet. Finish the backup setup on the PC, then check again." };
  }
  if (raw === "failed") {
    return { ...base, status: "failed", errorMessage: code ? backupCodeMessage(code) : "The last backup failed." };
  }
  if (ageDays > MEDICAL_BACKUP_FAILED_DAYS) {
    return { ...base, status: "failed",
      errorMessage: `No backup for ${Math.floor(ageDays)} days - is the PC on? Check the "Onyx Medical Backup" scheduled task.` };
  }
  if (raw === "partial") {
    return { ...base, status: "partial", errorMessage: code ? backupCodeMessage(code) : "The last backup was incomplete." };
  }
  if (ageDays > MEDICAL_BACKUP_DEGRADED_DAYS) {
    return { ...base, status: "partial",
      errorMessage: `No backup for ${Math.floor(ageDays)} days - the weekly run is late.` };
  }
  if (raw === "success") return { ...base, status: "success", errorMessage: null };
  return { ...base, status: "unknown", errorMessage: "The last backup reported an unknown state." };
}
