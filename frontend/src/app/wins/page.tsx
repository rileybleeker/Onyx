import type { Metadata } from "next";
import { getWins } from "@/lib/wins-server";
import WinsBoard from "./WinsBoard";
export const metadata: Metadata = { title: "Wins - Onyx" };
export const dynamic = "force-dynamic";
export default async function WinsPage() { return <WinsBoard board={await getWins()} />; }
