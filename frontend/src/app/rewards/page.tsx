import type { Metadata } from "next";
import { cookies } from "next/headers";
import { loadRewards } from "@/lib/rewards-server";
import { layoutCookieName, layoutFromCookie } from "@/lib/personalize-layout";
import RewardsClient from "./RewardsClient";

// Private financial data (card transactions and loyalty balances): rendered per request on the server, never ISR,
// never cached by the CDN, never read from the browser (pds.rewards_* and pds.finance_* are service-role only).
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Rewards - Onyx", robots: { index: false, follow: false } };

export default async function RewardsPage() {
  const [load, cookieStore] = await Promise.all([loadRewards(new Date()), cookies()]);
  const layout = layoutFromCookie(cookieStore.get(layoutCookieName("/rewards"))?.value);
  return <RewardsClient load={load} layout={layout} />;
}
