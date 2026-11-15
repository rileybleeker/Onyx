"use client";
import PageSkeleton from "@/components/PageSkeleton";
import type { Section } from "@/lib/medical-records-server";
import type { LabResult, MedicalDocument } from "@/lib/medical-records";
import RecordsClient, { rowFromApiDoc, rowFromApiLab } from "./RecordsClient";
import { useFeedPageData } from "../useFeedPageData";

// /health/records as a section of the continuous scroll: the same view the routed page renders
// (RecordsClient), seeded from GET /api/medical/page-data, which returns exactly what page.tsx
// passes. /api/medical is a sensitive key in the client cache: memory only, never on disk.

const PAGE_DATA_URL = "/api/medical/page-data";

type RecordsPageData = { documents: Section<MedicalDocument>; labs: Section<LabResult> };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function readSection<T>(raw: unknown, row: (r: unknown) => T | null): Section<T> {
  if (!isObject(raw)) throw new Error("shape");
  if (raw.state === "error") return { state: "error" };
  if (raw.state !== "ready" || !Array.isArray(raw.items)) throw new Error("shape");
  // Same per-row checks the view applies to /api/medical answers; a row that fails them is left out.
  return { state: "ready", items: raw.items.map(row).filter((r): r is T => r !== null) };
}

/** Checks a cached or fresh answer; throws on a malformed one (never cached, never shown). */
function readRecords(raw: unknown): RecordsPageData {
  if (!isObject(raw)) throw new Error("shape");
  return { documents: readSection(raw.documents, rowFromApiDoc), labs: readSection(raw.labs, rowFromApiLab) };
}

const complete = (data: RecordsPageData) => data.documents.state === "ready" && data.labs.state === "ready";

export default function RecordsFeedSection() {
  const { data, version, failed } = useFeedPageData(PAGE_DATA_URL, readRecords, complete);
  if (data) return <RecordsClient key={version} documents={data.documents} labs={data.labs} headingTestId="feed-page-heading" />;
  // Nothing cached and the read failed: each part shows the view's own "Couldn't load" state with Try again.
  if (failed) return <RecordsClient documents={{ state: "error" }} labs={{ state: "error" }} headingTestId="feed-page-heading" />;
  return <PageSkeleton title="Medical records" width="max-w-4xl" tiles={0} blocks={["h-40"]} list={5} />;
}
