import type { Metadata } from "next";
import { cookies } from "next/headers";
import { loadScreenTime } from "@/lib/screen-time-server";
import { parseWindowDays } from "@/lib/screen-time";
import { screenTimeViewData } from "@/lib/screen-time-view";
import { layoutCookieName, layoutFromCookie } from "@/lib/personalize-layout";
import ScreenTimeView from "./ScreenTimeView";

// Private data (every app used, by day): rendered per request on the server, never ISR, never
// cached by the CDN, and never fetched from the browser. pds.phone_usage_* is service-role only and
// the middleware lets only the owner reach this route. Same pattern as /financials - this
// deliberately does NOT follow the hourly-ISR pattern of the other dashboards.
// The markup lives in ScreenTimeView.tsx, shared with this page's section of the continuous scroll.
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Screen Time - Onyx",
  robots: { index: false, follow: false },
};

export default async function ScreenTimePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const windowDays = parseWindowDays((await searchParams).days);
  const load = await loadScreenTime(windowDays);
  // Personalize: the saved layout rides in a cookie scoped to this page, so the server renders it as is.
  const layout = layoutFromCookie((await cookies()).get(layoutCookieName("/screen-time"))?.value);
  return <ScreenTimeView data={screenTimeViewData(load)} windowDays={windowDays} layout={layout} />;
}
