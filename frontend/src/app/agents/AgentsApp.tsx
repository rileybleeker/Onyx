"use client";

import { useSearchParams } from "next/navigation";
import AgentsChat from "./AgentsChat";
import AgentsInbox, { type InboxView } from "./AgentsInbox";

// /agents            → inbox (Unread / All)
// /agents?view=all   → inbox on the conversations list
// /agents?t=devops   → that conversation (#m123 jumps to a message, &reply=A12 starts an answer to a card)
export default function AgentsApp() {
  const params = useSearchParams();
  const thread = params.get("t");
  if (thread && /^[\w][\w.-]{0,39}$/.test(thread)) return <AgentsChat key={thread} thread={thread} reply={params.get("reply")} />;
  const v = params.get("view");
  return <AgentsInbox initialView={v === "all" || v === "unread" ? (v as InboxView) : null} />;
}
