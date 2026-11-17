"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

/**
 * "Try again" under the Screen Time error alert. The scroll section passes `onRetry` (it remounts its reader so
 * the same window is requested again); the routed page passes nothing and the button re-renders the server
 * page with router.refresh(). Disabled while that refresh is in flight.
 */
export default function RetryButton({ onRetry }: { onRetry?: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        if (onRetry) onRetry();
        else start(() => router.refresh());
      }}
      className="min-h-11 rounded-control border border-border-subtle px-4 text-[13px] text-accent hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40"
    >
      Try again
    </button>
  );
}
