/**
 * The two GET URLs of the /reading Practice part (READ-QUIZ-01 S4) and the active book's slug in the cached
 * /api/reading answer. Import-free on purpose: components/AppData.tsx (the shared shell) warms these reads, so it
 * must not pull the practice client library into every page's bundle. lib/reading-practice-client.ts re-exports
 * them, so the part, the runner and the warm-up build the same URLs.
 */

export const PRACTICE_TODAY_URL = "/api/reading/practice/today";
export const BANK_URL = "/api/reading/bank";

/**
 * The round of a book: the daily round, or "One more round" number n (1, 2, ...). The book is always named, so a
 * cached round can never belong to another book (components/AppData.tsx warms the same URL for the active book).
 */
export function practiceUrl(slug: string | null, kind: "daily" | "extra" = "daily", n = 1): string {
  const p = new URLSearchParams();
  if (slug) p.set("book", slug);
  if (kind === "extra") {
    p.set("kind", "extra");
    p.set("n", String(Math.max(1, Math.min(50, Math.trunc(n) || 1))));
  }
  const q = p.toString();
  return q ? `${PRACTICE_TODAY_URL}?${q}` : PRACTICE_TODAY_URL;
}

export const bankUrl = (slug: string | null) => (slug ? `${BANK_URL}?book=${encodeURIComponent(slug)}` : BANK_URL);

/** The slug of the active book in the cached /api/reading answer (what the warm-up asks the round for). */
export function readingSlugOf(raw: unknown): string | null {
  const slug = (raw as { overview?: { book?: { slug?: unknown } } | null } | null | undefined)?.overview?.book?.slug;
  return typeof slug === "string" && /^[a-z0-9-]{1,80}$/.test(slug) ? slug : null;
}
