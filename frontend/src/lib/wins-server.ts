import "server-only";
import { makeBoard, type Board } from "./wins";

// One public request, no credentials or user data. Caching bounds GitHub quota use.
export async function getWins(): Promise<Board> {
  try {
    const response = await fetch("https://api.github.com/repos/rileybleeker/Onyx/pulls?state=all&sort=updated&direction=desc&per_page=100", {
      headers: { Accept: "application/vnd.github+json" },
      next: { revalidate: 300 },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error("GitHub unavailable");
    const body: unknown = await response.json();
    if (!Array.isArray(body)) throw new Error("Invalid response");
    // Origin Date survives Next's fetch cache; don't label cached data as checked now.
    const date = response.headers.get("date");
    return makeBoard(body, date && Number.isFinite(Date.parse(date)) ? new Date(date).toISOString() : null);
  } catch { return makeBoard(null, null); }
}
