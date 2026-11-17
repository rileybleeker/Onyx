"use client";

import Link from "next/link";

// Route-level error boundary. Next.js passes the thrown error, which can carry
// server or database text, so it is never rendered: the copy below is fixed.
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-4 px-4 py-12 text-center">
      <h1 className="text-xl font-medium text-text-primary">This page hit a problem.</h1>
      <p className="text-sm text-text-secondary">Try again, or go to Today.</p>
      <div className="flex flex-col gap-3 sm:flex-row">
        <button
          type="button"
          onClick={() => reset()}
          className="min-h-11 rounded-full bg-accent px-5 text-sm font-medium text-on-accent hover:bg-accent/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Try again
        </button>
        <Link
          href="/today"
          className="inline-flex min-h-11 items-center justify-center rounded-full border border-border-subtle px-5 text-sm font-medium text-text-primary hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          Go to Today
        </Link>
      </div>
    </main>
  );
}
