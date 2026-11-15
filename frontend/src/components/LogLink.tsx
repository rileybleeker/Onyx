"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { logHref, type LogPartId } from "@/app/log/jump";
import { navIntentProps } from "@/lib/warmup";

/**
 * One line pointing to the Log screen section where an entry is made (AGENTS.md "One place to enter data"): the
 * daily entries live on /log only, and a page that used to carry its own copy of the form shows this instead.
 */
export default function LogLink({ part, children }: { part: LogPartId; children: ReactNode }) {
  return (
    <Link
      href={logHref(part)}
      {...navIntentProps("/log")}
      className="min-h-11 inline-flex items-center gap-1.5 px-3 rounded-control border border-border-subtle text-[13px] text-text-secondary hover:text-text-primary hover:border-border-hover transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
    >
      <span>{children}</span>
      <ArrowUpRight aria-hidden="true" className="w-4 h-4 text-accent shrink-0" strokeWidth={1.75} />
    </Link>
  );
}
