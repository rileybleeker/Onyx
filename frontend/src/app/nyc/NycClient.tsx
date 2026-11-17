"use client";

import { writeFeedSeed } from "@/lib/feed-seed";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { ExternalLink } from "lucide-react";
import type { NycLead, RileyDecision } from "@/lib/nyc";
import { sameJson } from "@/lib/format";
import StatCard from "@/components/StatCard";
import ChartCard from "@/components/ChartCard";
import { Part, PartGroup, PartGrid } from "@/components/personalize/PartGrid";
import NycMap, { markerColor } from "./NycMap";
import { usePageHeadingTestId } from "@/components/FeedContext";
import { AutosaveStatus } from "@/components/AutosaveStatus";
import { AutosaveRefused } from "@/lib/autosave";
import { useAutosave } from "@/lib/use-autosave";

const NOTION_DB_URL = "https://www.notion.so/967fdf52d6ee4aab9a5854298e564b43";
const BRIEF =
  "Manhattan south of 110th · studio or 1BR · $2,900–$4,000 (target $3,500) · 500+ sq ft · under ~10 min walk to Central Park";

type View = "active" | "interested" | "new" | "all";
type SortKey = "rank" | "number" | "price" | "sqft" | "walk" | "verified";

const VIEWS: Array<{ key: View; label: string }> = [
  { key: "active", label: "Active" },
  { key: "interested", label: "Interested" },
  { key: "new", label: "New this week" },
  { key: "all", label: "All incl. gone" },
];
const PRICE_CAPS = [null, 3000, 3500, 4000] as const;
const DECISIONS: Array<{ key: RileyDecision; label: string; on: string }> = [
  { key: "Interested", label: "Interested", on: "bg-accent-muted text-accent border-accent/40" },
  { key: "Toured", label: "Toured", on: "bg-[#9085E9]/15 text-[#B3ACF2] border-[#9085E9]/40" },
  { key: "Passed", label: "Pass", on: "bg-down/10 text-down border-down/40" },
];

const etToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
function daysBefore(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10);
}
const money = (n: number | null) => (n == null ? "—" : `$${n.toLocaleString("en-US")}`);
const shortDate = (ymd: string | null) => {
  if (!ymd) return "—";
  const [, m, d] = ymd.split("-").map(Number);
  return `${m}/${d}`;
};
const isActive = (l: NycLead) => l.status !== "Gone" && l.riley !== "Passed";
const FIT_RANK: Record<string, number> = { "Full fit": 0, "Meets numbers": 1, Partial: 2 };
const RILEY_RANK: Record<RileyDecision, number> = { Toured: 0, Interested: 1, New: 2, Passed: 3 };

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

export default function NycClient({ initial }: { initial: NycLead[] | null }) {
  // "page-heading" on /nyc itself, "feed-page-heading" inside the continuous scroll.
  const headingTestId = usePageHeadingTestId();
  const [leads, setLeads] = useState<NycLead[]>(initial ?? []);
  const [loading, setLoading] = useState(!initial);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>("active");
  const [hood, setHood] = useState<string>("All");
  const [priceCap, setPriceCap] = useState<number | null>(null);
  const [fitsOnly, setFitsOnly] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: "rank", asc: true });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const seq = useRef<Record<string, number>>({});
  const rowRefs = useRef<Record<string, HTMLTableRowElement | null>>({});
  const leadsRef = useRef(leads);
  leadsRef.current = leads;

  // Silent revalidation on mount (skeleton only when there was no seed).
  useEffect(() => {
    let cancelled = false;
    fetch("/api/nyc/leads")
      .then(async (r) => {
        // A failed request can answer with an HTML page, so the body is read defensively.
        const body = await r.json().catch(() => null);
        if (!r.ok || !Array.isArray(body?.leads)) throw new Error(`Leads request failed: HTTP ${r.status}`);
        return body.leads as NycLead[];
      })
      .then((next) => {
        if (cancelled) return;
        // Also seeds this page in the continuous scroll (lib/feed-seed.ts).
        writeFeedSeed("/nyc", next);
        setError(null);
        setLeads((prev) => (sameJson(prev, next) ? prev : next));
      })
      .catch((e) => {
        console.error("NYC leads load failed:", e);
        if (!cancelled) setError("Couldn't load NYC leads right now. Try again in a moment.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const today = etToday();
  const weekAgo = daysBefore(today, 7);

  const neighborhoods = useMemo(
    () => ["All", ...Array.from(new Set(leads.map((l) => l.neighborhood).filter(Boolean) as string[])).sort()],
    [leads]
  );

  const visible = useMemo(() => {
    const rows = leads.filter((l) => {
      if (view === "active" && !isActive(l)) return false;
      if (view === "interested" && l.riley !== "Interested" && l.riley !== "Toured") return false;
      if (view === "new" && !(l.firstSeen && l.firstSeen >= weekAgo)) return false;
      if (hood !== "All" && l.neighborhood !== hood) return false;
      if (priceCap != null && (l.price == null || l.price > priceCap)) return false;
      if (fitsOnly && l.fit !== "Full fit" && l.fit !== "Meets numbers") return false;
      return true;
    });
    const dir = sort.asc ? 1 : -1;
    const nullLast = (a: number | null, b: number | null) =>
      a == null && b == null ? 0 : a == null ? 1 : b == null ? -1 : (a - b) * dir;
    rows.sort((a, b) => {
      switch (sort.key) {
        case "number": return nullLast(a.number, b.number);
        case "price": return nullLast(a.price, b.price);
        case "sqft": return nullLast(a.sqft, b.sqft);
        case "walk": return nullLast(a.walkMin, b.walkMin);
        case "verified": return (a.lastVerified ?? "").localeCompare(b.lastVerified ?? "") * dir;
        default:
          return (
            RILEY_RANK[a.riley] - RILEY_RANK[b.riley] ||
            (FIT_RANK[a.fit ?? "Partial"] ?? 2) - (FIT_RANK[b.fit ?? "Partial"] ?? 2) ||
            nullLast(a.walkMin, b.walkMin) ||
            (b.number ?? 0) - (a.number ?? 0)
          );
      }
    });
    return rows;
  }, [leads, view, hood, priceCap, fitsOnly, sort, weekAgo]);

  // KPIs over the whole set, independent of filters.
  const active = leads.filter(isActive);
  const fits = active.filter((l) => l.fit === "Full fit" || l.fit === "Meets numbers");
  const interested = leads.filter((l) => l.riley === "Interested" || l.riley === "Toured");
  const newThisWeek = leads.filter((l) => l.firstSeen && l.firstSeen >= weekAgo);
  const medianAsk = median(active.map((l) => l.price).filter((p): p is number => p != null));
  const lastChecked = leads.reduce<string | null>(
    (max, l) => (l.lastVerified && (!max || l.lastVerified > max) ? l.lastVerified : max),
    null
  );
  const unmapped = visible.filter((l) => l.lat == null || l.lng == null).length;

  function select(id: string, fromMap = false) {
    setSelectedId(id);
    if (fromMap) rowRefs.current[id]?.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  // Riley's note autosaves (lib/autosave.ts): sent after a pause and when the box is left, through the same PATCH.
  const noteSave = useAutosave<{ id: string; note: string }>("nyc-note", {
    delayMs: 1200,
    same: (a, b) => a.id === b.id && a.note.trim() === b.note.trim(),
    save: async (v) => {
      const lead = leadsRef.current.find((l) => l.id === v.id);
      if (!lead) return; // the lead left the list: nothing to write to
      const err = await save(lead, { rileyNote: v.note }, true);
      if (err === "network") throw new Error("Couldn't reach Onyx.");
      if (err) throw new AutosaveRefused(err);
    },
  });

  async function toggleExpand(lead: NycLead) {
    setSelectedId(lead.id);
    setSaveError(null);
    // A note still waiting for the lead being closed is sent first, then the box follows the new lead. A note that
    // could not be saved keeps its lead open (its status line has Retry) instead of being dropped.
    if (!(await noteSave.flush())) {
      const open = leadsRef.current.find((l) => l.id === expandedId);
      setSelectedId(expandedId);
      setSaveError(`Your note${open ? ` for lead ${open.number}` : ""} is not saved yet. Retry it (under the note) before opening another lead.`);
      return;
    }
    if (expandedId === lead.id) {
      setExpandedId(null);
    } else {
      setExpandedId(lead.id);
      setNoteDraft(lead.rileyNote);
      noteSave.reset({ id: lead.id, note: lead.rileyNote });
    }
  }

  // Optimistic write: apply locally, revert on failure. The per-lead sequence
  // number stops a slow earlier response from undoing a newer tap. Answers null, or why it failed ("network" when
  // Onyx could not be reached). `quiet`: the caller shows the failure itself (the note's status line).
  async function save(lead: NycLead, patch: { riley?: RileyDecision; rileyNote?: string }, quiet = false): Promise<string | null> {
    const my = (seq.current[lead.id] = (seq.current[lead.id] ?? 0) + 1);
    const before = lead;
    setSaveError(null);
    setLeads((prev) => prev.map((l) => (l.id === lead.id ? { ...l, ...patch } : l)));
    try {
      const res = await fetch(`/api/nyc/leads/${lead.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`Lead save failed: HTTP ${res.status}`);
      if (seq.current[lead.id] === my) setLeads((prev) => prev.map((l) => (l.id === lead.id ? body.lead : l)));
      return null;
    } catch (e) {
      if (seq.current[lead.id] === my) {
        setLeads((prev) => prev.map((l) => (l.id === lead.id ? before : l)));
        console.error("NYC lead save failed:", e);
        if (!quiet) setSaveError(`Couldn't save lead ${lead.number}. Try again.`);
      }
      return e instanceof TypeError ? "network" : "Couldn't save this. Try again.";
    }
  }

  function header(key: SortKey, label: string, className = "") {
    const on = sort.key === key;
    return (
      <th className={clsx("px-3 py-2 font-medium", className)}>
        <button
          className={clsx("uppercase tracking-[0.08em] hover:text-text-primary", on && "text-text-primary")}
          onClick={() => setSort((s) => ({ key, asc: s.key === key ? !s.asc : key !== "verified" }))}
        >
          {label}
          {on && key !== "rank" ? (sort.asc ? " ↑" : " ↓") : ""}
        </button>
      </th>
    );
  }

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 data-testid={headingTestId} className="text-[22px] font-display text-text-primary">NYC Apartment Search</h1>
        <p className="text-[12px] text-text-secondary">{BRIEF}</p>
        <p className="text-[11px] font-mono text-text-tertiary">
          Last checked {lastChecked ? shortDate(lastChecked) : "—"} ·{" "}
          <a href={NOTION_DB_URL} target="_blank" rel="noreferrer" className="underline hover:text-text-secondary">
            open in Notion
          </a>
        </p>
      </header>

      {error && (
        <div className="border border-down/40 bg-down/10 rounded-control px-4 py-3 text-[12px] text-down">
          {error}
        </div>
      )}

      {/* Personalize: each KPI tile is its own part (Overview); the map and the leads table are parts of "Map & leads",
          whose header keeps the view / neighborhood / price filters. A part moves within its section or into the other. */}
      <PartGrid page="/nyc" title="NYC Apartment Search">
      <PartGroup id="overview" title="Overview">
        <Part id="active-leads" title="Active leads" width="quarter">
          <StatCard label="Active leads" value={active.length} sublabel="not gone, not passed" />
        </Part>
        <Part id="fit-brief" title="Fit the brief" width="quarter">
          <StatCard label="Fit the brief" value={fits.length} sublabel="full fit or meets numbers" />
        </Part>
        <Part id="interested" title="Interested" width="quarter">
          <StatCard label="Interested" value={interested.length} sublabel="incl. toured" />
        </Part>
        <Part id="new-this-week" title="New this week" width="quarter">
          <StatCard label="New this week" value={newThisWeek.length} />
        </Part>
        <Part id="median-ask" title="Median ask" width="quarter">
          <StatCard label="Median ask" value={medianAsk == null ? null : money(medianAsk)} sublabel="active leads" />
        </Part>
      </PartGroup>

      <PartGroup
        id="leads"
        title="Map & leads"
        gap={24}
        header={
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            onClick={() => setView(v.key)}
            className={clsx(
              "px-3 py-1 rounded-full border text-[12px]",
              view === v.key
                ? "border-accent/50 bg-accent-muted text-accent"
                : "border-border-default text-text-secondary hover:text-text-primary"
            )}
          >
            {v.label}
          </button>
        ))}
        <span className="mx-1 h-4 w-px bg-border-default" />
        <select
          value={hood}
          onChange={(e) => setHood(e.target.value)}
          className="bg-surface-card border border-border-default rounded-control px-2 py-1 text-[12px] text-text-secondary"
          aria-label="Neighborhood"
        >
          {neighborhoods.map((n) => (
            <option key={n} value={n}>{n === "All" ? "All neighborhoods" : n}</option>
          ))}
        </select>
        <select
          value={priceCap ?? ""}
          onChange={(e) => setPriceCap(e.target.value ? Number(e.target.value) : null)}
          className="bg-surface-card border border-border-default rounded-control px-2 py-1 text-[12px] text-text-secondary"
          aria-label="Maximum price"
        >
          {PRICE_CAPS.map((p) => (
            <option key={p ?? "any"} value={p ?? ""}>{p == null ? "Any price" : `≤ ${money(p)}`}</option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-[12px] text-text-secondary">
          <input type="checkbox" checked={fitsOnly} onChange={(e) => setFitsOnly(e.target.checked)} />
          Fits the brief only
        </label>
      </div>
        }
      >

      <Part id="map" title="Map">
      <ChartCard
        title="Map"
        subtitle={`${visible.length - unmapped} of ${visible.length} shown${unmapped ? ` · ${unmapped} without a location` : ""}`}
        variant="secondary"
      >
        <NycMap leads={visible} selectedId={selectedId} onSelect={(id) => select(id, true)} />
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-text-tertiary">
          {[
            ["Interested", "#5BC46E"],
            ["Toured", "#9085E9"],
            ["Full fit, not judged", "#FF6A1A"],
            ["Meets numbers", "#F4C84E"],
            ["Partial", "#B0AEA6"],
            ["Passed", "#706E67"],
          ].map(([label, color]) => (
            <span key={label} className="flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-full" style={{ background: color }} />
              {label}
            </span>
          ))}
        </div>
      </ChartCard>
      </Part>

      <Part id="leads-table" title="Leads">
      <ChartCard title="Leads" subtitle="Tap a row for details and notes" variant="secondary">
        {saveError && <p className="mb-3 text-[12px] text-down">{saveError}</p>}
        {loading ? (
          <p className="py-8 text-center text-[12px] font-mono text-text-tertiary">Loading leads…</p>
        ) : visible.length === 0 ? (
          // A failed read sets `error` and the banner above says so; no empty-state copy then.
          error ? null : (
            <p className="py-8 text-center text-[13px] text-text-secondary">
              {leads.length === 0 ? "No leads yet. New leads are added every morning." : "No leads match these filters."}
            </p>
          )
        ) : (
          <div className="overflow-x-auto -mx-4 px-4">
            <table className="w-full min-w-[860px] text-[12px]" data-testid="nyc-leads-table">
              <thead>
                <tr className="text-left text-[10px] text-text-tertiary border-b border-border-subtle">
                  {header("number", "#", "w-12")}
                  {header("rank", "Lead")}
                  {header("price", "Price")}
                  {header("sqft", "Sq ft")}
                  {header("walk", "Walk")}
                  <th className="px-3 py-2 font-medium uppercase tracking-[0.08em]">Source</th>
                  {header("verified", "Status")}
                  <th className="px-3 py-2 font-medium uppercase tracking-[0.08em]">You</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((l) => {
                  const expanded = expandedId === l.id;
                  return (
                    <Fragment key={l.id}>
                      <tr
                        ref={(r) => { rowRefs.current[l.id] = r; }}
                        onClick={() => toggleExpand(l)}
                        className={clsx(
                          "border-b border-border-subtle cursor-pointer hover:bg-surface-hover",
                          selectedId === l.id && "bg-surface-hover",
                          (l.status === "Gone" || l.riley === "Passed") && "opacity-50"
                        )}
                      >
                        <td className="px-3 py-2 font-mono text-text-tertiary">
                          <span className="inline-block h-2 w-2 rounded-full mr-1.5 align-middle" style={{ background: markerColor(l) }} />
                          {l.number}
                        </td>
                        <td className="px-3 py-2">
                          <div className="text-text-primary">{l.address || l.lead}</div>
                          <div className="text-[11px] text-text-tertiary">
                            {[l.neighborhood, l.layout, l.fit].filter(Boolean).join(" · ")}
                          </div>
                        </td>
                        <td className="px-3 py-2 tabular-nums text-text-primary">
                          {money(l.price)}
                          {l.noFee && <span className="ml-1.5 text-[10px] text-accent">no fee</span>}
                        </td>
                        <td className={clsx("px-3 py-2 tabular-nums", l.sqft != null && l.sqft < 500 ? "text-down" : "text-text-primary")}>
                          {l.sqft ?? <span className="text-text-tertiary">?</span>}
                        </td>
                        <td className={clsx("px-3 py-2 tabular-nums", l.walkMin != null && l.walkMin > 10 ? "text-mid" : "text-text-primary")}>
                          {l.walkMin != null ? `${l.walkMin} min` : <span className="text-text-tertiary">?</span>}
                        </td>
                        <td className="px-3 py-2">
                          {l.url ? (
                            <a
                              href={l.url}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="inline-flex items-center gap-1 text-text-secondary hover:text-text-primary"
                            >
                              {l.source ?? "Listing"} <ExternalLink className="h-3 w-3" />
                            </a>
                          ) : (
                            <span className="text-text-tertiary">{l.source ?? "—"}</span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={clsx(
                              l.status === "Live" && "text-up",
                              l.status === "Gone" && "text-down",
                              (l.status === "Unverified" || l.status === "Pending") && "text-mid"
                            )}
                          >
                            {l.status ?? "—"}
                          </span>
                          <span className="ml-1.5 text-[11px] text-text-tertiary">{shortDate(l.lastVerified)}</span>
                        </td>
                        <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                          <div className="flex gap-1">
                            {DECISIONS.map((d) => (
                              <button
                                key={d.key}
                                onClick={() => save(l, { riley: l.riley === d.key ? "New" : d.key })}
                                className={clsx(
                                  "px-2 py-0.5 rounded-full border text-[11px]",
                                  l.riley === d.key ? d.on : "border-border-default text-text-tertiary hover:text-text-primary"
                                )}
                                aria-pressed={l.riley === d.key}
                              >
                                {d.label}
                              </button>
                            ))}
                          </div>
                        </td>
                      </tr>
                      {expanded && (
                        <tr className="border-b border-border-subtle bg-surface-raised">
                          <td colSpan={8} className="px-4 py-3">
                            <div className="grid md:grid-cols-2 gap-4 text-[12px]">
                              <dl className="space-y-1.5">
                                {[
                                  ["Verdict", l.verdict],
                                  ["Features", l.features],
                                  ["Agent", l.agent],
                                  ["Walk measured to", l.parkEntrance],
                                  ["Price history", l.priceHistory],
                                  ["First seen", shortDate(l.firstSeen)],
                                ].map(([k, v]) =>
                                  v && v !== "—" ? (
                                    <div key={k} className="flex gap-2">
                                      <dt className="w-32 shrink-0 text-text-tertiary">{k}</dt>
                                      <dd className="text-text-secondary">{v}</dd>
                                    </div>
                                  ) : null
                                )}
                                <div className="flex gap-2">
                                  <dt className="w-32 shrink-0 text-text-tertiary">Notion</dt>
                                  <dd>
                                    <a href={l.notionUrl} target="_blank" rel="noreferrer" className="underline text-text-secondary">
                                      open row
                                    </a>
                                  </dd>
                                </div>
                              </dl>
                              <div className="space-y-2">
                                <label className="block text-text-tertiary" htmlFor={`note-${l.id}`}>
                                  Your note (the scout reads it next run)
                                </label>
                                <textarea
                                  id={`note-${l.id}`}
                                  value={noteDraft}
                                  onChange={(e) => {
                                    setNoteDraft(e.target.value);
                                    noteSave.change({ id: l.id, note: e.target.value });
                                  }}
                                  onBlur={() => void noteSave.flush()}
                                  rows={3}
                                  maxLength={2000}
                                  className="w-full bg-surface-card border border-border-default rounded-control px-2 py-1.5 text-text-primary"
                                  placeholder="e.g. ask about the second room; skip if no laundry"
                                />
                                <AutosaveStatus state={noteSave.state} onRetry={() => void noteSave.retry()} />
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </ChartCard>
      </Part>
      </PartGroup>
      </PartGrid>
    </div>
  );
}
