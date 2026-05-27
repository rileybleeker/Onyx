-- WHOOP cycle hub FKs (GPT-5 + Claude variants, ).
-- whoop_recovery.cycle_id and whoop_sleep.cycle_id both pointed at
-- pds.whoop_cycles.cycle_id with no FK, so a cycle delete would leave orphans
-- and an Onyx-side ETL bug rewriting a cycle_id would silently corrupt joins.
--
-- ON DELETE CASCADE: recovery and sleep are derivative metrics computed off
-- the cycle; they have no independent meaning. If a cycle is purged, the
-- corresponding recovery/sleep rows should go with it.
--
-- pds.whoop_workouts (Claude-variant proposed scope) has NO cycle_id column,
-- so it cannot be FK'd to whoop_cycles. Out of scope for this migration.
--
-- Orphan check on 2026-05-26: 0 orphans across 573 recovery + 827 sleep rows,
-- so the FK can be created and validated immediately. No NOT VALID + VALIDATE
-- two-step needed.

ALTER TABLE pds.whoop_recovery
  ADD CONSTRAINT whoop_recovery_cycle_id_fkey
  FOREIGN KEY (cycle_id)
  REFERENCES pds.whoop_cycles(cycle_id)
  ON UPDATE CASCADE
  ON DELETE CASCADE;

ALTER TABLE pds.whoop_sleep
  ADD CONSTRAINT whoop_sleep_cycle_id_fkey
  FOREIGN KEY (cycle_id)
  REFERENCES pds.whoop_cycles(cycle_id)
  ON UPDATE CASCADE
  ON DELETE CASCADE;
