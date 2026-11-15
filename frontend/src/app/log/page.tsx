import type { Metadata } from "next";
import EarlyReads from "./EarlyReads";
import LogLoader from "./LogLoader";

// The Log screen (AGENTS.md "Log screen"): every daily entry on one page. A static shell; the sections render in the
// browser (Personalize reads the saved layout before the first paint) and read their data from the client cache.
// Their first reads start with the HTML (./EarlyReads.tsx, lib/log-early.ts).
export const metadata: Metadata = { title: "Log - Onyx" };

export default function LogPage() {
  return (
    <>
      <EarlyReads />
      <LogLoader />
    </>
  );
}
