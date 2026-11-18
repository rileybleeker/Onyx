"use client";

import { useEffect, useState } from "react";
import type { UpdateStatus } from "@/lib/iphone-update";
import { webBehind } from "@/lib/app-update";

const RUNNING = process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA;

export interface EverythingUpdate {
  status: UpdateStatus | null;
  /** The live Onyx deployment is newer than the one this page runs. */
  webBehind: boolean;
}

/** Today's update read: two GETs on mount (read-only). status is null while loading or when it could not be read. */
export function useIphoneUpdate(): EverythingUpdate {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [behind, setBehind] = useState(false);
  useEffect(() => {
    let live = true;
    fetch("/api/iphone/update-status", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live && j?.status) setStatus(j.status as UpdateStatus); })
      .catch(() => {});
    fetch("/api/version", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live && j) setBehind(webBehind(RUNNING, (j as { version?: string | null }).version)); })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  return { status, webBehind: behind };
}

/** True inside the installed home-screen app. Read after mount so server and first client render agree. */
export function useStandaloneApp(): boolean {
  const [standalone, setStandalone] = useState(false);
  useEffect(() => {
    const nav = navigator as Navigator & { standalone?: boolean };
    setStandalone(nav.standalone === true || window.matchMedia("(display-mode: standalone)").matches);
  }, []);
  return standalone;
}
