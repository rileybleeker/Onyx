import type { Metadata } from "next";
import Link from "next/link";
import clsx from "clsx";
import { loadScreenTime, type ScreenSync } from "@/lib/screen-time-server";
import {
  WINDOW_CHOICES,
  chartPoints,
  formatMinutes,
  parseWindowDays,
  summarize,
  topEntries,
  type TopEntry,
} from "@/lib/screen-time";
import ScreenTimeCharts from "./ScreenTimeCharts";

// Private data (every app used, by day): rendered per request on the server, never ISR, never
// cached by the CDN, and never fetched from the browser. pds.phone_usage_* is service-role only and
// the middleware lets only the owner reach this route. Same pattern as /financials - this
// deliberately does NOT follow the hourly-ISR pattern of the other dashboards.
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Screen Time - Onyx",
  robots: { index: false, follow: false },
};

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
    <div className="rounded-[4px] border border-border-subtle bg-surface-card p-3">
      <p className="text-[10px] font-medium uppercase tracking-[0.1em] text-text-tertiary">{label}</p>
      <p className="mt-1 font-display text-[28px] leading-none tabular-nums text-text-primary">{value}</p>
      <p className="mt-1.5 text-[11px] text-text-tertiary">{sub}</p>
    </div>
  );
}

function TopList({ title, entries, empty }: { title: string; entries: TopEntry[]; empty: string }) {
  const max = entries[0]?.minutes ?? 0;
  return (
    <section className="rounded-[4px] border border-border-subtle bg-surface-card p-4">
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

export default async function ScreenTimePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const windowDays = parseWindowDays((await searchParams).days);
  const load = await loadScreenTime(windowDays);

  return (
    <main className="mx-auto max-w-6xl space-y-6 p-4 md:p-8">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-widest text-text-tertiary">iPhone, by day</p>
          <h1 data-testid="page-heading" className="text-2xl font-semibold">Screen Time</h1>
          <p className="mt-2 text-text-secondary">
            What the Onyx Screen Time app sends from the iPhone each morning. Days run bedtime to bedtime.
          </p>
        </div>
        <nav aria-label="Window" className="flex gap-1 text-[12px]">
          {WINDOW_CHOICES.map((d) => (
            <Link
              key={d}
              href={`/screen-time?days=${d}`}
              aria-current={d === windowDays ? "page" : undefined}
              className={clsx(
                "rounded-[4px] border px-2.5 py-1 font-mono",
                d === windowDays
                  ? "border-accent/50 text-accent"
                  : "border-border-subtle text-text-secondary hover:border-border-hover",
              )}
            >
              {d}d
            </Link>
          ))}
        </nav>
      </header>

      {load.kind === "error" && (
        <section role="alert" className="rounded-[4px] border border-red-500/30 bg-red-500/5 p-4">
          <h2 className="font-semibold text-red-300">Couldn&apos;t load Screen Time.</h2>
          <p className="mt-1 text-[13px] text-text-secondary">{load.hint}</p>
          <p className="mt-1 text-[12px] text-text-tertiary">This is a failed query, not a day without phone use.</p>
        </section>
      )}

      {load.kind === "empty" && (
        <section className="rounded-[4px] border border-border-subtle bg-surface-card p-4">
          <p className="font-semibold">No Screen Time days in this window.</p>
          <p className="mt-2 text-[13px] text-text-secondary">
            Nothing was reported for the last {load.windowDays} days. Days appear here after the iPhone app&apos;s daily
            sync. No sample or invented numbers are shown.
          </p>
          <div className="mt-3">
            <SyncLine sync={load.sync} />
          </div>
        </section>
      )}

      {load.kind === "ok" &&
        (() => {
          const s = summarize(load.days);
          const points = chartPoints(load.days);
          const basis = s.completeDays === 1 ? "1 complete day" : `${s.completeDays} complete days`;
          return (
            <>
              <div className="space-y-1">
                <SyncLine sync={load.sync} />
                <p className="text-[12px] text-text-tertiary">
                  Averages use {basis} in the last {load.windowDays} days
                  {s.partialDays > 0
                    ? `; ${s.partialDays === 1 ? "1 day is" : `${s.partialDays} days are`} still syncing and left out.`
                    : "."}
                  {load.skippedRows > 0 ? ` ${load.skippedRows} unreadable row(s) skipped.` : ""}
                </p>
              </div>

              <section aria-label="Averages" className="grid grid-cols-2 gap-3 md:grid-cols-5">
                <Tile label="Daily total" value={formatMinutes(s.avgTotalMin)} sub="average per day" />
                <Tile label="Late night" value={formatMinutes(s.avgLateNightMin)} sub="10 PM to 6 AM, per day" />
                <Tile label="After midnight" value={formatMinutes(s.avgAfterMidnightMin)} sub="midnight to 6 AM, per day" />
                <Tile
                  label="Pickups"
                  value={s.avgPickups === null ? "-" : String(Math.round(s.avgPickups))}
                  sub={
                    s.avgNotifications === null
                      ? "per day"
                      : `per day, ${Math.round(s.avgNotifications)} notifications`
                  }
                />
                <Tile
                  label="Hour before sleep"
                  value={formatMinutes(s.avgLastHourBeforeSleepMin)}
                  sub={s.bedtimeDays > 0 ? `estimate, ${s.bedtimeDays} nights` : "needs a scored sleep"}
                />
              </section>

              <ScreenTimeCharts points={points} />

              <div className="grid gap-4 md:grid-cols-2">
                <TopList
                  title="Top apps"
                  entries={topEntries(load.days, "byApp")}
                  empty="No complete day in this window yet."
                />
                <TopList
                  title="Top categories"
                  entries={topEntries(load.days, "byCategory")}
                  empty="No complete day in this window yet."
                />
              </div>
              <p className="text-[12px] text-text-tertiary">
                Apple reports use in one-hour blocks, so the minutes before and after sleep onset are estimates: an hour
                that straddles sleep onset is split in proportion to the overlap. Sleep onset is WHOOP&apos;s.
              </p>
            </>
          );
        })()}
    </main>
  );
}
