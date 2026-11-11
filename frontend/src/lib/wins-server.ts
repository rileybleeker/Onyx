import "server-only";
import { highlights, makeBoard, type Board } from "./wins";

const base = "https://api.github.com/repos/rileybleeker/Onyx/pulls";
async function read(url: string, seconds: number) {
  const response = await fetch(url, {
    headers: { Accept: "application/vnd.github+json" },
    next: { revalidate: seconds }, signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error("GitHub unavailable");
  const body: unknown = await response.json();
  const date = response.headers.get("date");
  return { body, date: date && Number.isFinite(Date.parse(date)) ? new Date(date).toISOString() : null };
}

// No credentials/user data. One list request per five minutes, plus at most one
// hourly fallback per older highlight. Old wins never disappear at PR #101.
export async function getWins(): Promise<Board> {
  try {
    const result = await read(`${base}?state=all&sort=updated&direction=desc&per_page=100`, 300);
    if (!Array.isArray(result.body)) throw new Error("Invalid response");
    const rows: unknown[] = [...result.body];
    const dates: (string | null)[] = [result.date];
    await Promise.all(highlights.filter((item) => !rows.some((row) => row && typeof row === "object" && "number" in row && row.number === item.pr)).map(async (item) => {
      try {
        const fallback = await read(`${base}/${item.pr}`, 3600);
        rows.push(fallback.body); dates.push(fallback.date);
      } catch { /* Missing evidence stays unavailable, never inferred. */ }
    }));
    // Show the oldest participating snapshot, not the current render time.
    const checkedAt = dates.every((date): date is string => date !== null) ? dates.sort()[0] : null;
    return makeBoard(rows, checkedAt);
  } catch { return makeBoard(null, null); }
}
