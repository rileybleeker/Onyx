"use client";

import dynamic from "next/dynamic";
import LogSkeleton from "./LogSkeleton";

// Client-only (ssr:false), like the other personalizable client pages: the saved layout is read from localStorage in
// the first render, so nothing moves after paint. The server HTML is the skeleton, painted at once.
const LogClient = dynamic(() => import("./LogClient"), { ssr: false, loading: () => <LogSkeleton /> });

// Start loading the screen's code with the page's first scripts, not after hydration.
if (typeof window !== "undefined") void import("./LogClient").catch(() => {});

export default function LogLoader({ headingTestId }: { headingTestId?: string } = {}) {
  return <LogClient headingTestId={headingTestId} />;
}
