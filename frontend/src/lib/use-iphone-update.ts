"use client";

import { useEffect, useState } from "react";
import type { UpdateStatus } from "@/lib/iphone-update";

/** Today's iPhone-update read: one GET on mount (read-only), null while loading or when it could not be read. */
export function useIphoneUpdate(): UpdateStatus | null {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  useEffect(() => {
    let live = true;
    fetch("/api/iphone/update-status", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (live && j?.status) setStatus(j.status as UpdateStatus); })
      .catch(() => {});
    return () => { live = false; };
  }, []);
  return status;
}
