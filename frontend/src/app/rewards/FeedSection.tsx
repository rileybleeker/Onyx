"use client";

import PageSkeleton from "@/components/PageSkeleton";
import { useServerPageData } from "@/lib/server-page-data";
import type { RewardsData } from "@/lib/rewards";
import type { RewardsLoad } from "@/lib/rewards-server";
import RewardsClient from "./RewardsClient";

// /rewards inside the continuous scroll: the same screen as the routed page, with the data page.tsx renders on the
// server read from GET /api/rewards/page-data through the shared client cache. /api/rewards is a memory-only key
// there (isSensitiveKey): card-derived numbers never reach the device's disk. Read-only, like the page.

const URL = "/api/rewards/page-data";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A cached or fetched answer checked like the server's own shape; throws on anything else. */
function readRewards(raw: unknown): RewardsLoad {
  if (isObject(raw) && isObject(raw.load)) {
    const load = raw.load;
    if (load.kind === "ok" && isObject(load.data) && Array.isArray((load.data as Partial<RewardsData>).programs)) return load as unknown as RewardsLoad;
    if (load.kind === "error" && typeof load.message === "string") return load as unknown as RewardsLoad;
  }
  throw new Error("malformed rewards answer");
}
const complete = (load: RewardsLoad) => load.kind === "ok";

export default function RewardsFeedSection() {
  const { data, failed } = useServerPageData(URL, readRewards, complete);
  if (data) return <RewardsClient load={data} feed />;
  if (failed) return <RewardsClient load={{ kind: "error", message: "Couldn't load rewards.", hint: "The server did not answer. Try again in a moment." }} feed />;
  return <PageSkeleton title="Rewards" tiles={3} blocks={["h-56"]} list={4} />;
}
