import Link from "next/link";

// Shown for unknown URLs. Server component: no client code needed.
export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-4 px-4 py-12 text-center">
      <h1 className="text-xl font-medium text-text-primary">Page not found.</h1>
      <Link
        href="/today"
        className="inline-flex min-h-11 items-center justify-center rounded-full bg-accent px-5 text-sm font-medium text-on-accent hover:bg-accent/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        Go to Today
      </Link>
    </main>
  );
}
