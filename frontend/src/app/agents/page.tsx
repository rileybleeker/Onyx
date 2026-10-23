import type { Metadata } from "next";
import { Suspense } from "react";
import AgentsApp from "./AgentsApp";

export const metadata: Metadata = { title: "Agents — Onyx" };

export default function AgentsPage() {
  return (
    <Suspense fallback={null}>
      <AgentsApp />
    </Suspense>
  );
}
