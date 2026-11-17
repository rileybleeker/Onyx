// The HRV forecast's model-artifact heartbeat (hrv_predict|model_artifact, audit PIPE-08).
// hrv_predict.py writes one row per run (deduped: a repeat of the last status writes nothing),
// so the card is driven by the row's own status, never by its age — a success row may sit there
// for days while forecasts keep using the same artifact. Pure: no I/O, no imports, so /api/status
// and the tests use it as is.

export type HrvArtifactHeartbeat = {
  status?: unknown;
  error_message?: unknown;
};

export type HrvArtifactState = {
  status: "success" | "partial" | "failed" | "unknown";
  errorMessage: string | null;
};

/** Map the newest hrv_predict|model_artifact sync_log row to a card state.
 *  failed → red with the heartbeat's own message; partial → degraded with its
 *  message; success → healthy; no row → unknown (never an age threshold: the
 *  heartbeat is deduped, so an old success row is normal). */
export function hrvArtifactState(entry: HrvArtifactHeartbeat | null): HrvArtifactState {
  const message = typeof entry?.error_message === "string" && entry.error_message.trim() !== ""
    ? entry.error_message
    : null;
  const raw = typeof entry?.status === "string" ? entry.status : "";
  if (raw === "failed" || raw === "error") return { status: "failed", errorMessage: message };
  if (raw === "partial") return { status: "partial", errorMessage: message };
  if (raw === "success") return { status: "success", errorMessage: null };
  return { status: "unknown", errorMessage: null };
}
