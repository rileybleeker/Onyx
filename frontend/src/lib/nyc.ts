// NYC apartment search — data layer for /nyc (2026-11-07).
//
// Source of truth is the Notion "NYC Leads" database under Personal Agents.
// The nyc-scout agent upserts one row per lead on every run (keyed on
// Number); Riley's decision (Riley + Riley's note) is written from /nyc via
// PATCH /api/nyc/leads/[id] and read back by the scout, which never
// overwrites it. This module is SERVER-ONLY at runtime (it reads
// NOTION_API_KEY); client components import its types with `import type`.

const NOTION_API_KEY = process.env.NOTION_API_KEY;
export const NOTION_NYC_LEADS_DB =
  process.env.NOTION_NYC_LEADS_DB || "967fdf52d6ee4aab9a5854298e564b43";
const NOTION_VERSION = "2022-06-28";

/** Cache tag shared by the ISR page fetch and the PATCH route's revalidateTag. */
export const NYC_LEADS_TAG = "nyc-leads";

export type LeadStatus = "Live" | "Unverified" | "Pending" | "Gone";
export type RileyDecision = "New" | "Interested" | "Toured" | "Passed";
export type LeadFit = "Full fit" | "Meets numbers" | "Partial";

export const RILEY_DECISIONS: RileyDecision[] = ["New", "Interested", "Toured", "Passed"];

export interface NycLead {
  id: string;               // Notion page id
  notionUrl: string;
  number: number | null;
  lead: string;
  address: string;
  neighborhood: string | null;
  layout: string | null;
  price: number | null;
  noFee: boolean;
  sqft: number | null;
  walkMin: number | null;
  parkEntrance: string;
  lat: number | null;
  lng: number | null;
  source: string | null;
  url: string | null;
  agent: string;
  features: string;
  fit: LeadFit | null;
  status: LeadStatus | null;
  riley: RileyDecision;     // blank in Notion reads as "New"
  rileyNote: string;
  verdict: string;
  firstSeen: string | null; // YYYY-MM-DD
  lastVerified: string | null;
  priceHistory: string;
}

// ── Notion property readers ────────────────────────────────────────────────
type Prop = Record<string, unknown> & { type?: string };

function text(p: Prop | undefined): string {
  if (!p) return "";
  const parts = (p.type === "title" ? p.title : p.rich_text) as Array<{ plain_text?: string }> | undefined;
  return (parts ?? []).map((t) => t.plain_text ?? "").join("").trim();
}
const num = (p: Prop | undefined): number | null => (typeof p?.number === "number" ? (p.number as number) : null);
const sel = (p: Prop | undefined): string | null =>
  ((p?.select as { name?: string } | null | undefined)?.name ?? null);
const date = (p: Prop | undefined): string | null =>
  ((p?.date as { start?: string } | null | undefined)?.start?.slice(0, 10) ?? null);

function toLead(page: { id: string; url: string; properties: Record<string, Prop> }): NycLead {
  const p = page.properties;
  const riley = sel(p["Riley"]);
  return {
    id: page.id,
    notionUrl: page.url,
    number: num(p["Number"]),
    lead: text(p["Lead"]),
    address: text(p["Address"]),
    neighborhood: sel(p["Neighborhood"]),
    layout: sel(p["Layout"]),
    price: num(p["Price"]),
    noFee: p["No fee"]?.checkbox === true,
    sqft: num(p["Sq ft"]),
    walkMin: num(p["Walk min"]),
    parkEntrance: text(p["Park entrance"]),
    lat: num(p["Lat"]),
    lng: num(p["Lng"]),
    source: sel(p["Source"]),
    url: (p["Listing URL"]?.url as string | null | undefined) ?? null,
    agent: text(p["Agent"]),
    features: text(p["Features"]),
    fit: sel(p["Fit"]) as LeadFit | null,
    status: sel(p["Status"]) as LeadStatus | null,
    riley: (RILEY_DECISIONS as string[]).includes(riley ?? "") ? (riley as RileyDecision) : "New",
    rileyNote: text(p["Riley's note"]),
    verdict: text(p["Verdict"]),
    firstSeen: date(p["First seen"]),
    lastVerified: date(p["Last verified"]),
    priceHistory: text(p["Price history"]),
  };
}

function headers(): HeadersInit {
  if (!NOTION_API_KEY) throw new Error("NOTION_API_KEY is not set");
  return {
    Authorization: `Bearer ${NOTION_API_KEY}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

/** Spells out the one failure that is fixed in Notion, not code: the integration lacks access. */
function notionError(status: number, body: string): Error {
  if (status === 404 || status === 403) {
    return new Error(
      `Notion ${status}: the "NYC Leads" database isn't shared with Onyx's Notion integration (open it in Notion → ••• → Connections → add the integration).`
    );
  }
  return new Error(`Notion ${status}: ${body.slice(0, 200)}`);
}

/**
 * Every lead, newest number first (deterministic order — the client's
 * sameJson revalidation bail-out depends on it). Throws on any Notion error
 * so page.tsx's fail-open try/catch actually fails open.
 *
 * `fresh` = bypass the data cache (API route / client revalidation). The ISR
 * page passes fresh=false so its fetch shares the page's hourly revalidate
 * window — a no-store fetch would silently make the page dynamic.
 */
export async function getNycLeads({ fresh = false }: { fresh?: boolean } = {}): Promise<NycLead[]> {
  const leads: NycLead[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 10; i++) {
    const res = await fetch(`https://api.notion.com/v1/databases/${NOTION_NYC_LEADS_DB}/query`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        page_size: 100,
        start_cursor: cursor,
        sorts: [{ property: "Number", direction: "descending" }],
      }),
      ...(fresh ? { cache: "no-store" as const } : { next: { revalidate: 3600, tags: [NYC_LEADS_TAG] } }),
    });
    if (!res.ok) throw notionError(res.status, await res.text());
    const data = await res.json();
    for (const page of data.results ?? []) leads.push(toLead(page));
    if (!data.has_more) break;
    cursor = data.next_cursor;
  }
  return leads;
}

/**
 * Freshness signal for /status: the most recent "Last verified" date the
 * scout stamped on any lead (it re-verifies live leads every run), plus the
 * live-lead count. One small query so /api/status stays fast.
 */
export async function getNycScoutFreshness(): Promise<{ lastVerified: string | null; liveCount: number }> {
  const res = await fetch(`https://api.notion.com/v1/databases/${NOTION_NYC_LEADS_DB}/query`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      page_size: 100,
      filter: { property: "Status", select: { equals: "Live" } },
      sorts: [{ property: "Last verified", direction: "descending" }],
    }),
    cache: "no-store",
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw notionError(res.status, await res.text());
  const data = await res.json();
  const results = (data.results ?? []) as Array<{ properties: Record<string, Prop> }>;
  return {
    lastVerified: results.length ? date(results[0].properties["Last verified"]) : null,
    liveCount: results.length,
  };
}

/** Riley's decision / note from /nyc. Only these two properties are ever written. */
export async function updateNycLead(
  pageId: string,
  patch: { riley?: RileyDecision; rileyNote?: string }
): Promise<NycLead> {
  // Refuse any page outside the leads database BEFORE writing: the id comes
  // from the client, and the integration can reach other Notion pages.
  const check = await fetch(`https://api.notion.com/v1/pages/${pageId}`, { headers: headers(), cache: "no-store" });
  if (!check.ok) throw notionError(check.status, await check.text());
  const parentDb = ((await check.json()).parent?.database_id as string | undefined)?.replace(/-/g, "");
  if (parentDb !== NOTION_NYC_LEADS_DB.replace(/-/g, "")) {
    throw new Error("Page is not in the NYC Leads database");
  }

  const properties: Record<string, unknown> = {};
  if (patch.riley !== undefined) properties["Riley"] = { select: { name: patch.riley } };
  if (patch.rileyNote !== undefined) {
    properties["Riley's note"] = {
      rich_text: patch.rileyNote ? [{ type: "text", text: { content: patch.rileyNote } }] : [],
    };
  }
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify({ properties }),
    cache: "no-store",
  });
  if (!res.ok) throw notionError(res.status, await res.text());
  return toLead(await res.json());
}
