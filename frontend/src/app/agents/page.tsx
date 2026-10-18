import type { Metadata } from "next";
import AgentsChat from "./AgentsChat";

export const metadata: Metadata = { title: "Agents — Onyx" };

export default function AgentsPage() {
  return <AgentsChat />;
}
