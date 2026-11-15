import type { Metadata } from "next";
import TodayClient from "./today/TodayClient";

// The start page (manifest start_url "/") renders Today directly instead of redirecting to /today, which cost
// a 75-110 ms round trip on every app launch. /today stays the canonical nav link; both are the same static page.
export const metadata: Metadata = { title: "Today - Onyx" };
export default function Home() { return <TodayClient />; }
