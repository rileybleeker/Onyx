import type { Metadata } from "next";
import { getWins } from "@/lib/wins-server";
import WinsBoard from "./WinsBoard";
export const metadata: Metadata = { title: "Wins - Onyx" };
export const revalidate = 300;
export default async function WinsPage() { return <WinsBoard board={await getWins()} />; }
