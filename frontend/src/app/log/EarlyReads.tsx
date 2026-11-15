import { logEarlyScript } from "@/lib/log-early";

// The Log screen's first reads start with the HTML, not after the JavaScript, the section chunks and their mount
// (lib/log-early.ts; speed budget, 2026-11-15: the cold first visit took about 1.4 s). Read-only GETs only. Only a
// full page load runs the script: React never runs a script it inserts during an in-app navigation, where the client
// cache already shows the last copy at once.
const SCRIPT = logEarlyScript();

export default function EarlyReads() {
  return <script dangerouslySetInnerHTML={{ __html: SCRIPT }} />;
}
