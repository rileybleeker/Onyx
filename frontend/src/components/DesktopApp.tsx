"use client";

/**
 * Desktop app glue (2026-11-14): the "Install desktop app" button and the launch handler for the
 * installed window. Nothing here reads or writes data. See lib/desktop-app.ts.
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { MonitorDown } from "lucide-react";
import { launchTarget, paletteShortcutLabel } from "@/lib/desktop-app";

type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

type LaunchParams = { targetURL?: string };
type LaunchQueue = { setConsumer: (consumer: (params: LaunchParams) => void) => void };

// The browser can offer the install before React has mounted, so the offer is caught at module load.
let installPrompt: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); // keep the offer for the sidebar button instead of the browser's mini bar
    installPrompt = e as InstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    notify();
  });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Shown only when the browser offers to install Onyx (never inside the installed window). */
export function InstallAppButton() {
  const prompt = useSyncExternalStore(subscribe, () => installPrompt, () => null);
  if (!prompt) return null;

  async function install() {
    const offer = installPrompt;
    if (!offer) return;
    await offer.prompt();
    await offer.userChoice.catch(() => null);
    installPrompt = null; // an offer can be used once
    notify();
  }

  return (
    <button
      type="button"
      onClick={install}
      className="flex items-center gap-2.5 px-3 py-2 rounded-control text-[13px] font-medium text-text-secondary hover:text-text-primary hover:bg-white/[0.03] transition-colors w-full focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
    >
      <MonitorDown className="w-[17px] h-[17px] shrink-0" strokeWidth={1.75} />
      Install desktop app
    </button>
  );
}

/** ⌘K on a Mac, Ctrl K on Windows (decided after mount so the server render matches). */
export function usePaletteShortcutLabel(): string {
  const [label, setLabel] = useState("⌘K");
  useEffect(() => {
    setLabel(paletteShortcutLabel(navigator.platform, navigator.userAgent));
  }, []);
  return label;
}

/** In the installed window: a jump-list shortcut opens its page in the window that is already open. */
export function DesktopLaunchHandler() {
  const router = useRouter();
  useEffect(() => {
    const queue = (window as unknown as { launchQueue?: LaunchQueue }).launchQueue;
    if (!queue) return;
    queue.setConsumer((params) => {
      const current = location.pathname + location.search + location.hash;
      const path = launchTarget(params.targetURL, location.origin, current);
      if (path) router.push(path);
    });
  }, [router]);
  return null;
}
