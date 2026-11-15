import type { Metadata } from "next";
import TodayClient from "./TodayClient";
import EarlyReads from "./EarlyReads";

export const metadata: Metadata = { title: "Today - Onyx" };
export default function TodayPage() { return <><EarlyReads /><TodayClient /></>; }
