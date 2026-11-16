import "server-only";
import {
  readCaffeineHrvPairs,
  readHealthMatrix,
  readNutritionMatrix,
  readRunningRecoveryContext,
  readSpotifyAudioFeatureDrift,
  readSpotifyDailyVolume,
} from "@/lib/queries";
import { readEnvDoseResponseData, readHistoricalHrv } from "@/lib/queries-hrv";
import type { DerivedRead } from "@/lib/derived-reads";

// The server side of the owner-only matview facade (lib/derived-reads.ts): one fixed query per name, run
// with the service role (lib/supabase on the server). `since` was checked by checkSince in the route, so a
// "required" read always gets a date here and a "none" read gets null.
export const DERIVED_READERS: Record<DerivedRead, (since: string | null) => Promise<unknown[]>> = {
  nutrition: (since) => readNutritionMatrix(since as string),
  "caffeine-hrv": (since) => readCaffeineHrvPairs(since as string),
  "running-recovery": (since) => readRunningRecoveryContext(since as string),
  "health-matrix": (since) => readHealthMatrix(since as string),
  "historical-hrv": (since) => readHistoricalHrv(since as string),
  "spotify-volume": (since) => readSpotifyDailyVolume(since),
  "spotify-drift": (since) => readSpotifyAudioFeatureDrift(since),
  "sweet-spot": () => readEnvDoseResponseData(),
};

/** What a failed read logs: a database code or the error's type, never a message (it can quote a row). */
export function readFailureCode(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Za-z0-9_]{1,16}$/.test(code)) return code;
  const name = (e as { name?: unknown } | null)?.name;
  return typeof name === "string" && /^[A-Za-z]{1,40}$/.test(name) ? name : "error";
}
