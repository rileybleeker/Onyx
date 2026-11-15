"use client";
import PageSkeleton from "@/components/PageSkeleton";
import { NOT_CONNECTED, type CalendarStatus } from "@/lib/care-google";
import { parseCareItem } from "@/lib/care-items";
import type { CareItem } from "@/lib/care-planner";
import type { CareLoad } from "@/lib/care-items-server";
import HealthClient from "./HealthClient";
import { useFeedPageData } from "./useFeedPageData";

// /health as a section of the continuous scroll: the same view the routed page renders
// (HealthClient), seeded from GET /api/care/page-data, which returns exactly what page.tsx passes.
// Care items stay in memory only (persist: false in useFeedPageData), as everywhere else.

const PAGE_DATA_URL = "/api/care/page-data";

type HealthPageData = { initial: CareLoad; calendar: CalendarStatus };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function readCalendar(raw: unknown): CalendarStatus {
  if (!isObject(raw)) throw new Error("shape");
  const { configured, connected, calendarName, connectedAt, lastSync } = raw;
  if (typeof configured !== "boolean" || typeof connected !== "boolean" || typeof calendarName !== "string") throw new Error("shape");
  if (connectedAt !== null && typeof connectedAt !== "string") throw new Error("shape");
  if (lastSync !== null && !(isObject(lastSync) && typeof lastSync.at === "string" && typeof lastSync.ok === "boolean")) throw new Error("shape");
  return raw as CalendarStatus;
}

/** Checks a cached or fresh answer; throws on a malformed one (never cached, never shown). */
function readHealth(raw: unknown): HealthPageData {
  if (!isObject(raw) || !isObject(raw.initial)) throw new Error("shape");
  const calendar = readCalendar(raw.calendar);
  if (raw.initial.state === "error") return { initial: { state: "error" }, calendar };
  if (raw.initial.state !== "ready" || !Array.isArray(raw.initial.items)) throw new Error("shape");
  const items: CareItem[] = [];
  for (const item of raw.initial.items) {
    const parsed = parseCareItem(item);
    if (parsed.ok) items.push(parsed.item);
  }
  return { initial: { state: "ready", items }, calendar };
}

const complete = (data: HealthPageData) => data.initial.state === "ready";

export default function HealthFeedSection() {
  const { data, version, failed } = useFeedPageData(PAGE_DATA_URL, readHealth, complete);
  if (data) return <HealthClient key={version} initial={data.initial} calendar={data.calendar} headingTestId="feed-page-heading" />;
  // Nothing cached and the read failed: the view's own "Couldn't load" state with its Try again, the
  // same fallbacks page.tsx uses.
  if (failed) return <HealthClient initial={{ state: "error" }} calendar={NOT_CONNECTED} headingTestId="feed-page-heading" />;
  return <PageSkeleton title="Health & appointments" width="max-w-4xl" tiles={0} blocks={["h-40", "h-80"]} />;
}
