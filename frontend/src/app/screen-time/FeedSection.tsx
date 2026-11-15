"use client";

import { useState } from "react";
import { DEFAULT_WINDOW_DAYS } from "@/lib/screen-time";
import { readScreenTimeViewData, type ScreenTimeViewData } from "@/lib/screen-time-view";
import { useServerPageData } from "@/lib/server-page-data";
import ScreenTimeView from "./ScreenTimeView";

// /screen-time inside the continuous scroll: the same screen as the routed page (ScreenTimeView), with the
// data page.tsx works out on the server read from GET /api/screen-time/page-data?days=N through the shared
// client cache. /api/screen-time is a memory-only key there (isSensitiveKey): nothing reaches the device's
// disk. The window choices are buttons here, so picking one stays in the scroll.

const url = (days: number) => `/api/screen-time/page-data?days=${days}`;

/** A failed read is shown when nothing else is, never cached. */
const complete = (data: ScreenTimeViewData) => data.kind !== "error";

const UNREACHABLE: ScreenTimeViewData = { kind: "error", hint: "Onyx could not be reached. Try again in a moment." };

export default function ScreenTimeFeedSection() {
  const [days, setDays] = useState<number>(DEFAULT_WINDOW_DAYS);
  const { data, failed } = useServerPageData(url(days), readScreenTimeViewData, complete);
  // The previous window's numbers stay up, dimmed, until the picked window's answer arrives.
  const busy = data !== null && data.kind !== "error" && data.windowDays !== days;
  return <ScreenTimeView data={data ?? (failed ? UNREACHABLE : null)} windowDays={days} feed onWindow={setDays} busy={busy} />;
}
