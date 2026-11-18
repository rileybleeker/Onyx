import Link from "next/link";
import clsx from "clsx";
import type { ScreenSync } from "@/lib/screen-time-server";
import { WINDOW_CHOICES, formatMinutes, type TopEntry } from "@/lib/screen-time";
import type { ScreenTimeViewData } from "@/lib/screen-time-view";
import type { AiSection, AiSync } from "@/lib/ai-usage";
import { DailyTotalChart, LateNightChart, PickupsChart, SleepOnsetChart } from "./ScreenTimeCharts";
import InfoHint from "@/components/InfoHint";
import RetryButton from "./RetryButton";
import { PartGrid, type PartSpec } from "@/components/personalize/PartGrid";
import type { PageLayout } from "@/lib/personalize-layout";

/**
 * The /screen-time screen. No "use client": the server page renders it during its own render (the window
 * choices are links to /screen-time?days=N), and the page's section of the continuous scroll
 * (FeedSection.tsx) renders the same markup in the browser with `feed` (a section instead of the page's
 * main landmark, the feed's heading test id) and `onWindow` (the window choices become buttons, so picking
 * one stays in the scroll). Data arrives as props (lib/screen-time-view.ts); nothing here fetches.
 *
 * Personalize: every tile, chart, list and note is its own part (plain `parts` data, since the server renders
 * this); parts move within their section and into any other section. The routed page passes the layout from its
 * cookie (`layout`), so the server already renders the saved arrangement and nothing moves after hydration.
 */

const SYNC_TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

function SyncLine({ sync }: { sync: ScreenSync | null }) {
  if (!sync?.at) {
    return <p className="text-[12px] text-text-tertiary">The iPhone app has not reported a sync yet.</p>;
  }
  const failed = sync.status === "failed";
  return (
    <p className={clsx("text-[12px]", failed ? "text-red-300" : "text-text-tertiary")}>
      Last sync from the iPhone app: {SYNC_TIME.format(new Date(sync.at))} ET
      {failed ? " - it failed; see the Screen Time app card on Status." : ""}
    </p>
  );
}

function Tile({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="rounded-card shadow-card border border-border-subtle bg-surface-card p-3">
      <p className="text-[10px] font-medium uppercase tracking-[0.1em] text-text-tertiary">{label}</p>
      <p className="mt-1 font-display text-[28px] leading-none tabular-nums text-text-primary">{value}</p>
      <p className="mt-1.5 text-[11px] text-text-tertiary">{sub}</p>
    </div>
  );
}

function TopList({ title, entries, empty }: { title: string; entries: TopEntry[]; empty: string }) {
  const max = entries[0]?.minutes ?? 0;
  return (
    <section className="rounded-card shadow-card border border-border-subtle bg-surface-card p-4">
      <h2 className="text-[12px] font-semibold uppercase tracking-[0.07em] text-text-secondary">{title}</h2>
      {entries.length === 0 ? (
        <p className="mt-3 text-[13px] text-text-tertiary">{empty}</p>
      ) : (
        <ol className="mt-3 space-y-2">
          {entries.map((e) => (
            <li key={e.key}>
              <div className="flex items-baseline justify-between gap-3 text-[13px]">
                <span className="min-w-0 truncate">
                  {e.label}
                  {e.label !== e.key && e.key !== "(none)" && (
                    <span className="ml-2 font-mono text-[11px] text-text-tertiary">{e.key}</span>
                  )}
                </span>
                <span className="shrink-0 font-mono tabular-nums text-text-secondary">
                  {formatMinutes(e.perDay)}/day
                  <span className="ml-2 text-text-tertiary">{Math.round(e.share * 100)}%</span>
                </span>
              </div>
              <div className="mt-1 h-1.5 rounded-full bg-white/5" aria-hidden>
                <div
                  className="h-1.5 rounded-full bg-accent/70"
                  style={{ width: `${max > 0 ? Math.max(2, (e.minutes / max) * 100) : 0}%` }}
                />
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function AiSyncLine({ sync, skippedRows = 0 }: { sync: AiSync | null; skippedRows?: number }) {
  const skipped = skippedRows > 0 ? ` ${skippedRows} unreadable row(s) skipped.` : "";
  if (!sync?.at) {
    return <p className="text-[12px] text-text-tertiary">The PC has not reported an upload yet.{skipped}</p>;
  }
  const failed = sync.status === "failed";
  return (
    <p className={clsx("text-[12px]", failed ? "text-red-300" : "text-text-tertiary")}>
      Last upload from the PC: {SYNC_TIME.format(new Date(sync.at))} ET
      {failed ? " - it failed; see the AI Tool Usage card on Status." : ""}
      {skipped}
    </p>
  );
}

const perDayCount = (n: number) => String(Math.round(n * 10) / 10);

/** The "AI tools" section (pds.ai_tool_usage_daily): its own empty and error lines, whatever the phone data shows. */
function aiToolsPart(ai: AiSection): PartSpec {
  const header = <h2 className="text-[12px] font-semibold uppercase tracking-[0.07em] text-text-secondary">AI tools</h2>;
  const base = { id: "ai-tools", title: "AI tools", node: header, gap: 12 };
  if (ai.kind === "error") {
    return {
      ...base,
      members: [{ id: "ai-status", title: "AI tools status", node: <p className="text-[13px] text-red-300">{ai.hint}</p> }],
    };
  }
  const syncPart: PartSpec = { id: "ai-sync", title: "AI tools last upload", node: <AiSyncLine sync={ai.sync} skippedRows={ai.kind === "ok" ? ai.skippedRows : 0} /> };
  if (ai.kind === "empty") {
    return {
      ...base,
      members: [
        { id: "ai-status", title: "AI tools status", node: <p className="text-[13px] text-text-tertiary">No AI tool sessions recorded in this window.</p> },
        syncPart,
      ],
    };
  }
  const days = ai.spanDays === 1 ? "1 day" : `${ai.spanDays} days`;
  const claude = ai.byTool.find((t) => t.tool === "claude_code");
  const codex = ai.byTool.find((t) => t.tool === "codex");
  const pct = (share: number | undefined) => `${Math.round((share ?? 0) * 100)}%`;
  return {
    ...base,
    members: [
      { id: "ai-active", title: "AI active minutes", width: "quarter", node: <Tile label="Active" value={formatMinutes(ai.activePerDay)} sub={`per day, over ${days}`} /> },
      { id: "ai-late", title: "AI late minutes", width: "quarter", node: <Tile label="Late" value={formatMinutes(ai.latePerDay)} sub="9 PM to 6 AM, per day" /> },
      { id: "ai-sessions", title: "AI sessions", width: "quarter", node: <Tile label="Sessions" value={perDayCount(ai.sessionsPerDay)} sub="per day" /> },
      {
        id: "ai-tools-split",
        title: "Claude Code vs Codex",
        width: "quarter",
        node: (
          <Tile
            label="Claude Code vs Codex"
            value={`${pct(claude?.share)} / ${pct(codex?.share)}`}
            sub={ai.byTool.map((t) => `${t.label} ${formatMinutes(t.perDay)}`).join(", ") + " per day"}
          />
        ),
      },
      {
        id: "ai-top-projects",
        title: "Top projects",
        width: "half",
        node: <TopList title="Top projects" entries={ai.topProjects} empty="No active minutes in this window." />,
      },
      syncPart,
    ],
  };
}

/** The AI section without Personalize, under the phone's empty screen. */
function AiToolsPlain({ ai }: { ai: AiSection }) {
  const part = aiToolsPart(ai);
  return (
    <section aria-label="AI tools" className="space-y-3">
      {part.node}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {(part.members ?? []).map((m) => (
          <div key={m.id} className={m.width === "quarter" ? "col-span-1" : m.width === "half" ? "col-span-2" : "col-span-2 lg:col-span-4"}>
            {m.node}
          </div>
        ))}
      </div>
    </section>
  );
}

type OkData = Extract<ScreenTimeViewData, { kind: "ok" }>;

/** The page's parts in default order: sections (groups) of tiles, charts and lists. */
function screenTimeParts(data: OkData, s: OkData["summary"]): PartSpec[] {
  const noDay = "No complete day in this window yet.";
  return [
    {
      id: "averages",
      title: "Averages",
      node: null,
      gap: 12,
      members: [
        { id: "avg-total", title: "Daily total", width: "quarter", node: <Tile label="Daily total" value={formatMinutes(s.avgTotalMin)} sub="average per day" /> },
        { id: "avg-late-night", title: "Late night", width: "quarter", node: <Tile label="Late night" value={formatMinutes(s.avgLateNightMin)} sub="10 PM to 6 AM, per day" /> },
        { id: "avg-after-midnight", title: "After midnight", width: "quarter", node: <Tile label="After midnight" value={formatMinutes(s.avgAfterMidnightMin)} sub="midnight to 6 AM, per day" /> },
        {
          id: "avg-pickups",
          title: "Pickups",
          width: "quarter",
          node: (
            <Tile
              label="Pickups"
              value={s.avgPickups === null ? "-" : String(Math.round(s.avgPickups))}
              sub={s.avgNotifications === null ? "per day" : `per day, ${Math.round(s.avgNotifications)} notifications`}
            />
          ),
        },
        {
          id: "avg-hour-before-sleep",
          title: "Hour before sleep",
          width: "quarter",
          node: (
            <Tile
              label="Hour before sleep"
              value={formatMinutes(s.avgLastHourBeforeSleepMin)}
              sub={s.bedtimeDays > 0 ? `estimate, ${s.bedtimeDays} nights` : "needs a scored sleep"}
            />
          ),
        },
      ],
    },
    {
      id: "charts",
      title: "Charts",
      node: null,
      members: [
        { id: "chart-total", title: "Daily total chart", width: "half", node: <DailyTotalChart points={data.points} /> },
        { id: "chart-late-night", title: "Late night chart", width: "half", node: <LateNightChart points={data.points} /> },
        { id: "chart-pickups", title: "Pickups and notifications", width: "half", node: <PickupsChart points={data.points} /> },
        { id: "chart-sleep-onset", title: "Around sleep onset", width: "half", node: <SleepOnsetChart points={data.points} /> },
      ],
    },
    {
      id: "top",
      title: "Top apps and categories",
      node: null,
      members: [
        { id: "top-apps", title: "Top apps", width: "half", node: <TopList title="Top apps" entries={data.topApps} empty={noDay} /> },
        { id: "top-categories", title: "Top categories", width: "half", node: <TopList title="Top categories" entries={data.topCategories} empty={noDay} /> },
      ],
    },
    {
      id: "notes",
      title: "Notes",
      node: null,
      members: [
        {
          id: "sleep-estimates",
          title: "About the sleep estimates",
          node: (
            <InfoHint variant="disclosure" label="Sleep estimates" summary="About the sleep estimates">
              <p>
                Apple reports use in one-hour blocks, so the minutes before and after sleep onset are estimates: an
                hour that straddles sleep onset is split in proportion to the overlap. Sleep onset is WHOOP&apos;s.
              </p>
            </InfoHint>
          ),
        },
      ],
    },
    // An answer cached before the field existed has no ai: the phone parts still draw.
    ...(data.ai ? [aiToolsPart(data.ai)] : []),
  ];
}

const windowClass = (on: boolean) =>
  clsx(
    "rounded-control border px-2.5 py-1 font-mono",
    on ? "border-accent/50 text-accent" : "border-border-subtle text-text-secondary hover:border-border-hover",
  );

export default function ScreenTimeView({
  data,
  windowDays,
  feed = false,
  onWindow,
  busy = false,
  onRetry,
  refreshOnRetry = false,
  layout,
}: {
  /** null: the scroll's section is still waiting for its first answer (the loading line shows). */
  data: ScreenTimeViewData | null;
  /** The window picked (days); the data may still be for the previous one while `busy`. */
  windowDays: number;
  feed?: boolean;
  /** Scroll section only: picking a window calls this instead of navigating. */
  onWindow?: (days: number) => void;
  /** Scroll section only: the answer for the picked window has not arrived yet. */
  busy?: boolean;
  /** Scroll section only: the error alert's "Try again" calls this (the section starts a new read). */
  onRetry?: () => void;
  /** Routed page only: the error alert's "Try again" re-renders the server page (router.refresh). */
  refreshOnRetry?: boolean;
  /** Routed page only: the saved Personalize layout read from the page's cookie. */
  layout?: PageLayout;
}) {
  const Root = feed ? "section" : "main";
  return (
    <Root
      className="mx-auto max-w-6xl space-y-6 p-4 md:p-8"
      aria-label={feed ? "Screen Time" : undefined}
      aria-busy={busy || data === null ? true : undefined}
    >
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-widest text-text-tertiary">iPhone, by day</p>
          <div className="flex items-center gap-2">
            <h1 data-testid={feed ? "feed-page-heading" : "page-heading"} className="text-2xl font-semibold">Screen Time</h1>
            <InfoHint label="Screen Time">
              <p>What the Onyx Screen Time app sends from the iPhone each morning. Days run bedtime to bedtime.</p>
            </InfoHint>
          </div>
        </div>
        <nav aria-label="Window" className="flex gap-1 text-[12px]">
          {WINDOW_CHOICES.map((d) =>
            onWindow ? (
              <button
                key={d}
                type="button"
                aria-pressed={d === windowDays}
                onClick={() => onWindow(d)}
                className={windowClass(d === windowDays)}
              >
                {d}d
              </button>
            ) : (
              <Link
                key={d}
                href={`/screen-time?days=${d}`}
                aria-current={d === windowDays ? "page" : undefined}
                className={windowClass(d === windowDays)}
              >
                {d}d
              </Link>
            ),
          )}
        </nav>
      </header>

      {data === null && (
        <p role="status" className="text-[13px] text-text-tertiary">
          Loading Screen Time
        </p>
      )}

      {data?.kind === "error" && (
        <section role="alert" className="rounded-control border border-red-500/30 bg-red-500/5 p-4">
          <h2 className="font-semibold text-red-300">Couldn&apos;t load Screen Time.</h2>
          <p className="mt-1 text-[13px] text-text-secondary">{data.hint}</p>
          <p className="mt-1 text-[12px] text-text-tertiary">This is a failed query, not a day without phone use.</p>
          {(onRetry || refreshOnRetry) && (
            <div className="mt-3">
              <RetryButton onRetry={onRetry} />
            </div>
          )}
        </section>
      )}

      {data?.kind === "empty" && (
        <section className="rounded-card shadow-card border border-border-subtle bg-surface-card p-4">
          <p className="font-semibold">No Screen Time days in this window.</p>
          <p className="mt-2 text-[13px] text-text-secondary">
            Nothing was reported for the last {data.windowDays} days. Days appear here after the iPhone app&apos;s daily
            sync. No sample or invented numbers are shown.
          </p>
          <div className="mt-3">
            <SyncLine sync={data.sync} />
          </div>
        </section>
      )}

      {data?.kind === "empty" && data.ai && (
        <div className={clsx(busy && "opacity-60")}>
          <AiToolsPlain ai={data.ai} />
        </div>
      )}

      {data?.kind === "ok" &&
        (() => {
          const s = data.summary;
          const basis = s.completeDays === 1 ? "1 complete day" : `${s.completeDays} complete days`;
          const unverified = s.unverifiedDays ?? 0; // an answer cached before the field existed has none
          const leftOut = [
            s.partialDays > 0 ? `${s.partialDays === 1 ? "1 day is" : `${s.partialDays} days are`} still syncing` : null,
            unverified > 0 ? `${unverified === 1 ? "1 day has" : `${unverified} days have`} no completeness check` : null,
          ].filter((x): x is string => x !== null);
          return (
            <div className={clsx("space-y-6", busy && "opacity-60")}>
              <div className="space-y-1">
                <SyncLine sync={data.sync} />
                <p className="text-[12px] text-text-tertiary">
                  Averages use {basis} in the last {data.windowDays} days
                  {leftOut.length > 0 ? `; ${leftOut.join(", ")} and left out.` : "."}
                  {data.skippedRows > 0 ? ` ${data.skippedRows} unreadable row(s) skipped.` : ""}
                </p>
              </div>

              <PartGrid page="/screen-time" title="Screen Time" initial={layout} parts={screenTimeParts(data, s)} />
            </div>
          );
        })()}
    </Root>
  );
}
