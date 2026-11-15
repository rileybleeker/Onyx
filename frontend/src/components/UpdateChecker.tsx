"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CHECK_EVERY_MS, MIN_GAP_MS, isBusy, updateAction } from "@/lib/app-update";
import { trackUnsavedWork, unsavedWork } from "@/lib/unsaved-work";

const RUNNING = process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA;
const KEY = "onyx.reloadedFor";

/** Keeps the installed app on the newest release without a reinstall or a manual restart. */
export default function UpdateChecker() {
  const [ready, setReady] = useState(false);
  const last = useRef(0);

  const check = useCallback(async () => {
    if (!RUNNING || document.visibilityState !== "visible") return;
    const now = Date.now();
    if (now - last.current < MIN_GAP_MS) return;
    last.current = now;
    try {
      const res = await fetch("/api/version", { cache: "no-store" });
      if (!res.ok) return;
      const live = ((await res.json()) as { version?: string | null }).version ?? null;
      const action = updateAction({
        running: RUNNING,
        live,
        // Focus is not enough (Onyx#326): unsaved edits and in-flight saves survive a blur.
        busy: isBusy(document) || unsavedWork.has(),
        reloadedFor: sessionStorage.getItem(KEY),
      });
      if (action === "reload" && live) {
        sessionStorage.setItem(KEY, live);
        window.location.reload();
      } else if (action === "prompt") {
        setReady(true);
      }
    } catch {
      // offline or signed out: the next check tries again
    }
  }, []);

  useEffect(() => {
    trackUnsavedWork(window as unknown as Parameters<typeof trackUnsavedWork>[0]);
  }, []);

  useEffect(() => {
    const onShow = () => {
      void check();
    };
    document.addEventListener("visibilitychange", onShow);
    window.addEventListener("focus", onShow);
    window.addEventListener("pageshow", onShow);
    const timer = window.setInterval(onShow, CHECK_EVERY_MS);
    return () => {
      document.removeEventListener("visibilitychange", onShow);
      window.removeEventListener("focus", onShow);
      window.removeEventListener("pageshow", onShow);
      window.clearInterval(timer);
    };
  }, [check]);

  if (!ready) return null;
  return (
    <button
      type="button"
      onClick={() => window.location.reload()}
      className="fixed left-1/2 -translate-x-1/2 bottom-[calc(env(safe-area-inset-bottom)+4.5rem)] md:bottom-6 z-50 rounded-full bg-accent text-on-accent px-4 min-h-[44px] text-sm font-medium shadow-card"
    >
      Update ready · tap to refresh
    </button>
  );
}
