import { preconnect } from "react-dom";
import { AGENTS_API } from "@/lib/agents-api";
import { agentsEarlyScript } from "@/lib/today-early";

// The inbox read starts with the HTML, not after the JavaScript and hydration (lib/today-early.ts; speed budget,
// 2026-11-15: the cold first visit took 1015 ms in perf-timing run 43679809614). GET only, read-only; AgentsInbox
// takes the answer on its first load. Only a full page load runs the script (React never runs one it inserts).
const SCRIPT = agentsEarlyScript(process.env.NEXT_PUBLIC_SUPABASE_URL, AGENTS_API);

export default function EarlyInbox() {
  // Another origin: open its connection while the HTML is still parsing (anonymous, like the inbox fetch).
  preconnect(AGENTS_API, { crossOrigin: "anonymous" });
  return SCRIPT ? <script dangerouslySetInnerHTML={{ __html: SCRIPT }} /> : null;
}
