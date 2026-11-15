"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { Camera } from "lucide-react";
import { Part, PartGrid } from "@/components/personalize/PartGrid";
import { navIntentProps } from "@/lib/warmup";
import { SectionSkeleton } from "./sections/ui";

/**
 * The Log screen (AGENTS.md "Log screen"): every daily entry on one page. Each section is a Personalize part with
 * its own chunk, data (client cache first) and Save; the frame paints at once with each section's skeleton.
 * Nothing is written on open; a section writes only when Riley taps its own Save.
 *
 * Section files (app/log/sections/*.tsx, one per section): SayIt, CheckIn, Journal, Supplements, UberEats, Weight, Reading.
 * The Say it box writes suggestions to lib/log-drafts.ts; each section reads its own with useLogDrafts(section).
 */

// Every section's code starts loading with this module, in parallel (a hidden part's code is fetched but the part
// is never mounted, so it reads and writes nothing).
if (typeof window !== "undefined") {
  void import("./sections/SayIt").catch(() => {});
  void import("./sections/CheckIn").catch(() => {});
  void import("./sections/Journal").catch(() => {});
  void import("./sections/Supplements").catch(() => {});
  void import("./sections/UberEats").catch(() => {});
  void import("./sections/Weight").catch(() => {});
  void import("./sections/Reading").catch(() => {});
}

const SayIt = dynamic(() => import("./sections/SayIt"), { ssr: false, loading: () => <SectionSkeleton section="sayit" /> });
const CheckIn = dynamic(() => import("./sections/CheckIn"), { ssr: false, loading: () => <SectionSkeleton section="checkin" /> });
const Journal = dynamic(() => import("./sections/Journal"), { ssr: false, loading: () => <SectionSkeleton section="journal" /> });
const Supplements = dynamic(() => import("./sections/Supplements"), { ssr: false, loading: () => <SectionSkeleton section="supplements" /> });
const UberEats = dynamic(() => import("./sections/UberEats"), { ssr: false, loading: () => <SectionSkeleton section="ubereats" /> });
const Weight = dynamic(() => import("./sections/Weight"), { ssr: false, loading: () => <SectionSkeleton section="weight" /> });
const Reading = dynamic(() => import("./sections/Reading"), { ssr: false, loading: () => <SectionSkeleton section="reading" /> });

export default function LogClient({ headingTestId = "page-heading" }: { headingTestId?: string }) {
  return (
    <div className="max-w-3xl">
      <header className="mb-5 flex min-h-11 items-end justify-between gap-3">
        <h1 data-testid={headingTestId} className="text-[20px] font-medium text-text-primary tracking-tight">Log</h1>
        <Link
          href="/nutrition?log=photo"
          {...navIntentProps("/nutrition")}
          className="min-h-11 inline-flex items-center gap-1.5 px-3 rounded-control border border-border-subtle text-[13px] text-text-secondary hover:text-text-primary hover:border-border-hover transition-colors"
        >
          <Camera className="w-4 h-4 text-accent" strokeWidth={1.75} aria-hidden />
          Meal photo
        </Link>
      </header>
      <PartGrid page="/log" title="Log">
        <Part id="say-it" title="Say it"><SayIt /></Part>
        <Part id="check-in" title="Check-in" nested><CheckIn /></Part>
        <Part id="journal" title="Journal"><Journal /></Part>
        <Part id="supplements" title="Supplements"><Supplements /></Part>
        <Part id="uber-eats" title="Uber Eats"><UberEats /></Part>
        <Part id="weight" title="Weight" width="half"><Weight /></Part>
        <Part id="reading" title="Reading" width="half"><Reading /></Part>
      </PartGrid>
    </div>
  );
}
