import { useWindDown } from "@/lib/use-winddown";
import { windDownAttention, windDownProgress, type WindDownAttention } from "@/lib/sleep-winddown";
import type { SourceProbe } from "@/lib/today-attention";

/** What Today needs: show the panel?, and the quiet view's source (only once the goal is known to be set up). */
export function useWindDownToday(): { show: boolean; source: { probe: SourceProbe; attention: WindDownAttention | null } | null } {
  const s = useWindDown();
  if (!s.payload || s.payload.status !== "ready" || s.payload.hidden) return { show: false, source: null };
  const p = windDownProgress(s.payload);
  const probe: SourceProbe = { load: "ready", refreshFailed: s.refreshFailed, checking: !s.fresh && !s.refreshFailed, asOf: s.at ? new Date(s.at).toISOString() : null };
  return { show: true, source: { probe, attention: windDownAttention(p) } };
}
