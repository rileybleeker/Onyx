"use client";

import { useEffect } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { Camera } from "lucide-react";
import { useInFeed } from "@/components/FeedContext";
import { Part, PartGrid } from "@/components/personalize/PartGrid";
import { navIntentProps } from "@/lib/warmup";
import { jumpToLogPart, logAnchorId, partFromHash, type LogPartId } from "./jump";
import { SectionSkeleton } from "./sections/ui";

/**
 * The Log screen (AGENTS.md "Log screen"): every daily entry on one page. Each section is a Personalize part with
 * its own chunk and data (client cache first); the frame paints at once with each section's skeleton. Every section
 * saves Riley's input on its own (autosave, lib/autosave.ts). Nothing is written on open or on scroll.
 *
 * Section files (app/log/sections/*.tsx, one per section): SayIt, CheckIn, WindDown, Journal, Supplements, Drinks, UberEats,
 * Weight, Reading.
 * The Say it box writes suggestions to lib/log-drafts.ts; each section reads its own with useLogDrafts(section).
 */

// Every section's code ships with this module, and so (LogLoader imports it too) with /log's first scripts, in
// parallel with the framework: no chunk round trips after hydration (speed budget, 2026-11-15: the frame's chunk
// and then the section chunks were each fetched one round trip after the code that asked for them, and a second
// set of import sites downloaded the sections twice). The dynamic() wrappers below keep each section's skeleton for
// the one frame before its lazy module resolves; a hidden part is still never mounted, so it reads and writes nothing.
import "./sections/SayIt";
import "./sections/CheckIn";
import "./sections/WindDown";
import "./sections/Journal";
import "./sections/Supplements";
import "./sections/Drinks";
import "./sections/UberEats";
import "./sections/Weight";
import "./sections/Reading";

const SayIt = dynamic(() => import("./sections/SayIt"), { ssr: false, loading: () => <SectionSkeleton section="sayit" /> });
const CheckIn = dynamic(() => import("./sections/CheckIn"), { ssr: false, loading: () => <SectionSkeleton section="checkin" /> });
const WindDown = dynamic(() => import("./sections/WindDown"), { ssr: false, loading: () => <SectionSkeleton section="winddown" /> });
const Journal = dynamic(() => import("./sections/Journal"), { ssr: false, loading: () => <SectionSkeleton section="journal" /> });
const Supplements = dynamic(() => import("./sections/Supplements"), { ssr: false, loading: () => <SectionSkeleton section="supplements" /> });
const Drinks = dynamic(() => import("./sections/Drinks"), { ssr: false, loading: () => <SectionSkeleton section="drinks" /> });
const UberEats = dynamic(() => import("./sections/UberEats"), { ssr: false, loading: () => <SectionSkeleton section="ubereats" /> });
const Weight = dynamic(() => import("./sections/Weight"), { ssr: false, loading: () => <SectionSkeleton section="weight" /> });
const Reading = dynamic(() => import("./sections/Reading"), { ssr: false, loading: () => <SectionSkeleton section="reading" /> });

/**
 * The top of a part: `/log#log-part-<id>` (Today's quick links) and the Say it box's "go to" buttons land here. On a
 * phone the page's scroll padding (globals.css: safe area + 3.5rem) already clears the fixed header; the 0.75rem
 * margin keeps the landing spot where it was (safe area + 4.25rem below the top).
 */
function Anchor({ part }: { part: LogPartId }) {
  return <span id={logAnchorId(part)} aria-hidden="true" className="block h-0 scroll-mt-3 md:scroll-mt-6" />;
}

export default function LogClient({ headingTestId = "page-heading" }: { headingTestId?: string }) {
  const inFeed = useInFeed();
  // Opened at a section (/log#log-part-supplements): go there and stay while the sections above finish loading.
  // Only the routed page reads the address (a copy drawn in the scroll belongs to another page's address).
  useEffect(() => {
    if (inFeed) return;
    const part = partFromHash(window.location.hash);
    if (!part) return;
    // After this commit's layout (the parts exist now; their contents load in their own chunks).
    const raf = requestAnimationFrame(() => jumpToLogPart(part, { settle: true }));
    return () => cancelAnimationFrame(raf);
  }, [inFeed]);

  return (
    <div className="log-screen max-w-3xl" data-log-root="">
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
        <Part id="say-it" title="Say it"><Anchor part="say-it" /><SayIt /></Part>
        <Part id="check-in" title="Check-in" nested><Anchor part="check-in" /><CheckIn /></Part>
        <Part id="wind-down" title="Wind-down"><Anchor part="wind-down" /><WindDown /></Part>
        <Part id="journal" title="Journal"><Anchor part="journal" /><Journal /></Part>
        <Part id="supplements" title="Supplements"><Anchor part="supplements" /><Supplements /></Part>
        <Part id="drinks" title="Drinks"><Anchor part="drinks" /><Drinks /></Part>
        <Part id="uber-eats" title="Uber Eats"><Anchor part="uber-eats" /><UberEats /></Part>
        <Part id="weight" title="Weight" width="half"><Anchor part="weight" /><Weight /></Part>
        <Part id="reading" title="Reading" width="half"><Anchor part="reading" /><Reading /></Part>
      </PartGrid>
    </div>
  );
}
