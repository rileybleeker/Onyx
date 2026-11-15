"use client";

import PageSkeleton from "@/components/PageSkeleton";
import type { DetectedLoad } from "@/lib/procurement-recurring";
import type { AdviceLoad } from "@/lib/procurement-flags";
import type { ReorderLoad } from "@/lib/procurement-reorder";
import { useServerPageData } from "@/lib/server-page-data";
import ProcurementClient from "./ProcurementClient";

// /procurement inside the continuous scroll: the same screen as the routed page (ProcurementClient), with
// the data page.tsx renders on the server read from GET /api/procurement/page-data through the shared
// client cache. /api/procurement is a memory-only key there (isSensitiveKey): the ledger-derived answer
// never reaches the device's disk. Read-only advice, exactly as on the page: nothing here buys or pays.

const URL = "/api/procurement/page-data";

interface ProcurementPageData {
  detected: DetectedLoad;
  advice: AdviceLoad | null;
  reorder: ReorderLoad;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const hasState = (v: unknown) => isObject(v) && typeof v.state === "string";

/** A cached or fetched answer checked like the server's own shape; throws on anything else. */
function readProcurement(raw: unknown): ProcurementPageData {
  if (
    isObject(raw) &&
    hasState(raw.detected) &&
    hasState(raw.reorder) &&
    (raw.advice === null || (isObject(raw.advice) && Array.isArray(raw.advice.advice)))
  ) {
    return raw as unknown as ProcurementPageData;
  }
  throw new Error("malformed procurement answer");
}

/** An answer in which the ledger or the order history failed is shown when nothing else is, never cached. */
const complete = (data: ProcurementPageData) => data.detected.state !== "error" && data.reorder.state !== "error";

const UNAVAILABLE = "unavailable";

export default function ProcurementFeedSection() {
  const { data, failed } = useServerPageData(URL, readProcurement, complete);
  // No remount on a newer answer: ProcurementClient keeps its typed drafts and reads these as plain props.
  if (data) return <ProcurementClient detected={data.detected} advice={data.advice} reorder={data.reorder} feed />;
  if (failed) {
    return (
      <ProcurementClient
        detected={{ state: "error", code: UNAVAILABLE }}
        advice={null}
        reorder={{ state: "error", code: UNAVAILABLE }}
        feed
      />
    );
  }
  return <PageSkeleton title="Procurement" tiles={3} blocks={["h-56"]} list={4} />;
}
