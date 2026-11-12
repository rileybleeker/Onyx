import "server-only";
import { highlights, makeBoard, type Board, type Production } from "./wins";

const repo = "https://api.github.com/repos/rileybleeker/Onyx";
const base = `${repo}/pulls`;
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

/**
 * The latest production deployment that GitHub records as successful (Vercel posts it), plus
 * the time of the commit it built. A merged website change counts as live only if it was merged
 * at or before that commit. Any failure or odd shape returns null, never an optimistic guess.
 * Costs about three requests per quarter hour.
 */
async function readProduction(): Promise<{ production: Production; date: string | null }> {
  const none = { production: null, date: null };
  try {
    const list = await read(`${repo}/deployments?environment=Production&per_page=3`, 900);
    if (!Array.isArray(list.body)) return none;
    for (const item of list.body as unknown[]) {
      if (!item || typeof item !== "object") continue;
      const { id, sha } = item as { id?: unknown; sha?: unknown };
      if (typeof id !== "number" || typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) continue;
      const statuses = await read(`${repo}/deployments/${id}/statuses?per_page=1`, 900);
      const latest: unknown = Array.isArray(statuses.body) ? statuses.body[0] : null;
      if (!latest || typeof latest !== "object" || (latest as { state?: unknown }).state !== "success") continue;
      const commit = await read(`${repo}/commits/${sha}`, 900);
      const committer = (commit.body as { commit?: { committer?: { date?: unknown } } } | null)?.commit?.committer;
      if (typeof committer?.date !== "string" || !Number.isFinite(Date.parse(committer.date))) return none;
      const dates = [list.date, statuses.date, commit.date];
      return { production: { sha, committedAt: new Date(committer.date).toISOString() }, date: dates.every((d): d is string => d !== null) ? dates.sort()[0] : null };
    }
    return none;
  } catch { return none; }
}

// No credentials/user data. One list request per five minutes, about three deployment requests
// per quarter hour, plus at most one hourly fallback per older highlight.
// Old wins never disappear at PR #101.
export async function getWins(): Promise<Board> {
  try {
    const [result, shipped] = await Promise.all([
      read(`${base}?state=all&sort=updated&direction=desc&per_page=100`, 300),
      readProduction(),
    ]);
    if (!Array.isArray(result.body)) throw new Error("Invalid response");
    const rows: unknown[] = [...result.body];
    const dates: (string | null)[] = [result.date];
    if (shipped.production) dates.push(shipped.date);
    await Promise.all(highlights.filter((item) => !rows.some((row) => row && typeof row === "object" && "number" in row && row.number === item.pr)).map(async (item) => {
      try {
        const fallback = await read(`${base}/${item.pr}`, 3600);
        rows.push(fallback.body); dates.push(fallback.date);
      } catch { /* Missing evidence stays unavailable, never inferred. */ }
    }));
    // Show the oldest participating snapshot, not the current render time.
    const checkedAt = dates.every((date): date is string => date !== null) ? dates.sort()[0] : null;
    return makeBoard(rows, checkedAt, shipped.production);
  } catch { return makeBoard(null, null); }
}
