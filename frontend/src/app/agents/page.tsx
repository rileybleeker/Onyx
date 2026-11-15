import type { Metadata } from "next";
import { Suspense } from "react";
import AgentsApp from "./AgentsApp";
import EarlyInbox from "./EarlyInbox";

export const metadata: Metadata = { title: "Agents — Onyx" };

export default function AgentsPage() {
  return (
    <>
      <EarlyInbox />
      <Suspense fallback={null}>
        <AgentsApp />
      </Suspense>
    </>
  );
}
