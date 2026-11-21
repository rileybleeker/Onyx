"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import InfoHint from "@/components/InfoHint";
import { AutosaveStatus } from "@/components/AutosaveStatus";
import { Part, PartGrid, PartGroup } from "@/components/personalize/PartGrid";
import { AutosaveRefused, saveRequest } from "@/lib/autosave";
import { useAutosave } from "@/lib/use-autosave";
import { axisTick, chartColors as C, chartTooltip, gridStyle } from "@/lib/chart-theme";
import type { PageLayout } from "@/lib/personalize-layout";
import {
  bestCardTable,
  cardDef,
  dayLabel,
  progressBars,
  validCpp,
  type CreditStatus,
  type ProgramId,
  type ProgramView,
  type RewardsData,
  type SettingsPatch,
} from "@/lib/rewards";
import type { RewardsLoad } from "@/lib/rewards-server";

const card = "rounded-card shadow-card border border-border-subtle bg-surface-card p-4";
const input = "rounded-control border border-border-subtle bg-transparent px-2 py-1 text-[13px]";

const usd = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en-US")}`;
const usd2 = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (n: number) => Math.round(n).toLocaleString("en-US");
const monthName = (m: string) => new Date(`${m}-01T12:00:00Z`).toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });

/** One autosaving settings field. `toPatch` turns the typed text into the PUT body, or a reason string when it is not valid yet. */
function useSettingSave(name: string, toPatch: (text: string) => SettingsPatch | string, onSaved: () => void) {
  return useAutosave<string>(name, {
    delayMs: 1000,
    ready: (t) => {
      const p = toPatch(t);
      return typeof p === "string" ? p : null;
    },
    save: async (t) => {
      const p = toPatch(t);
      if (typeof p === "string") throw new AutosaveRefused(p);
      await saveRequest("/api/rewards/settings", { method: "PUT", body: p });
      onSaved();
    },
  });
}

function ValuationField({ program, cpp, isDefault, onSaved }: { program: ProgramView; cpp: number; isDefault: boolean; onSaved: () => void }) {
  const [text, setText] = useState(String(cpp));
  const save = useSettingSave(
    `rewards:cpp:${program.id}`,
    (t) => {
      const n = Number(t.trim());
      return validCpp(n) ? { key: "valuations", value: { [program.id]: n } } : "Enter cents per point, 0.01 to 1000.";
    },
    onSaved,
  );
  if (program.unit === "usd") return null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px] text-text-secondary">
      <label className="flex items-center gap-1">
        Worth
        <input
          className={`${input} w-16`}
          inputMode="decimal"
          value={text}
          aria-label={`${program.name} cents per point`}
          onChange={(e) => {
            setText(e.target.value);
            save.change(e.target.value);
          }}
          onBlur={() => void save.flush()}
        />
        ¢ each
      </label>
      {isDefault && <span className="text-text-tertiary">estimate</span>}
      <AutosaveStatus state={save.state} onRetry={() => void save.retry()} />
    </div>
  );
}

function ProgramCard({ p, cpp, onSaved }: { p: ProgramView; cpp: number; onSaved: () => void }) {
  const b = p.balance;
  const value = b ? (p.unit === "usd" ? Math.round(b.balance * 100) : Math.round(b.balance * cpp)) : null;
  const bars = progressBars(b?.status_progress ?? null);
  const ex = p.expiry;
  return (
    <div className={card}>
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-[14px] font-semibold">{p.name}</h3>
        {b?.status_tier && <span className="rounded-control border border-border-subtle px-2 py-0.5 font-mono text-[11px]">{b.status_tier}</span>}
      </div>
      {b ? (
        <>
          {p.id === "uber_one" ? (
            // The reader stores membership as a flag (1 = member, 0 = not a member), never as points.
            <p className="mt-2 text-xl font-semibold">{b.balance > 0 ? "Member" : "Not a member"}</p>
          ) : (
            <p className="mt-2 font-mono text-3xl">
              {p.unit === "usd" ? usd2(Math.round(b.balance * 100)) : num(b.balance)}
              {p.unit !== "usd" && <span className="ml-1 text-[12px] text-text-tertiary">{b.unit}</span>}
            </p>
          )}
          {value !== null && p.unit !== "usd" && <p className="text-[13px] text-text-secondary">about {usd(value)}</p>}
          {bars.map((x) => (
            <div key={x.label} className="mt-2">
              <div className="flex justify-between text-[11px] text-text-tertiary">
                <span>{x.label}</span>
                <span className="font-mono">
                  {num(x.value)} / {num(x.goal)}
                </span>
              </div>
              <div className="mt-1 h-1.5 rounded-full bg-surface-sunken" role="img" aria-label={`${x.label} ${Math.round(x.pct)} percent`}>
                <div className="h-1.5 rounded-full bg-accent" style={{ width: `${x.pct}%` }} />
              </div>
            </div>
          ))}
          <p className={`mt-2 text-[12px] ${p.stale ? "text-mid" : "text-text-tertiary"}`}>
            {p.stale ? "Stale: " : ""}read {p.ageDays === 0 ? "today" : `${p.ageDays} days ago`} ({b.source})
          </p>
        </>
      ) : (
        <p className="mt-2 text-[13px] text-text-secondary">Not connected yet: sign in once on the PC.</p>
      )}
      <p className={`mt-2 text-[12px] ${ex.atRisk ? "text-down" : "text-text-secondary"}`}>
        {ex.date ? `${ex.atRisk ? "At risk: expires" : "Expires"} ${dayLabel(ex.date)} (${ex.basis})` : ex.note}
      </p>
      <ValuationField program={p} cpp={cpp} isDefault={p.cppDefault} onSaved={onSaved} />
    </div>
  );
}

function Expiring({ data }: { data: RewardsData }) {
  const rows = data.programs.filter((p) => p.expiry.basis === "harvested" || p.expiry.basis === "estimated" || p.expiry.basis === "unknown");
  return (
    <div className={card}>
      <h3 className="text-[14px] font-semibold">Expiring soon</h3>
      <ul className="mt-2 space-y-2 text-[13px]">
        {rows.map((p) => (
          <li key={p.id} className="flex flex-wrap justify-between gap-2">
            <span>{p.name}</span>
            <span className={p.expiry.atRisk ? "text-down" : "text-text-secondary"}>
              {p.expiry.date ? `${dayLabel(p.expiry.date)} · ${p.expiry.daysLeft} days (${p.expiry.basis})` : p.expiry.note}
            </span>
          </li>
        ))}
        {rows.length === 0 && <li className="text-text-secondary">Nothing here has an expiry date.</li>}
      </ul>
      {data.flights && (
        <p className="mt-3 border-t border-border-subtle pt-2 text-[12px] text-text-secondary">
          Delta: {data.flights.thisYear} flight{data.flights.thisYear === 1 ? "" : "s"} flown this year
          {data.flights.next ? `, next ${data.flights.next.route} on ${dayLabel(data.flights.next.date)}` : ", none booked"}.
        </p>
      )}
    </div>
  );
}

function CreditRow({ c, onSaved }: { c: CreditStatus; onSaved: () => void }) {
  const [text, setText] = useState(String(Math.round(c.amountCents / 100)));
  const save = useSettingSave(
    `rewards:credit:${c.id}`,
    (t) => {
      const n = Number(t.replace(/[$,\s]/g, ""));
      return Number.isFinite(n) && n >= 0 && n <= 100_000 ? { key: "credits", value: { [c.id]: Math.round(n * 100) } } : "Enter dollars, 0 to 100000.";
    },
    onSaved,
  );
  const status =
    c.state === "untracked"
      ? "Not tracked from the card"
      : c.state === "unknown"
        ? c.unknownReason === "foreign_credit"
          ? "Unknown: credit in another currency"
          : "Unknown: card not read"
        : c.state === "used"
        ? "Used"
        : c.state === "partly"
          ? `${usd2(c.usedCents)} used, ${usd2(c.leftCents)} left`
          : "Not used yet";
  const tone = c.state === "used" ? "text-up" : c.state === "unused" && c.daysLeft <= 7 ? "text-down" : c.state === "unused" ? "text-mid" : "text-text-secondary";
  return (
    <tr className="border-t border-border-subtle align-top">
      <td className="py-2 pr-2">
        {c.name}
        <div className="text-[11px] text-text-tertiary">
          {c.period}, {c.periodLabel}
          {c.note ? ` · ${c.note}` : ""}
        </div>
      </td>
      <td className="py-2 pr-2 whitespace-nowrap">
        $
        <input
          className={`${input} w-16`}
          inputMode="decimal"
          value={text}
          aria-label={`${c.name} amount per period`}
          onChange={(e) => {
            setText(e.target.value);
            save.change(e.target.value);
          }}
          onBlur={() => void save.flush()}
        />
        {c.estimate && <span className="ml-1 text-[11px] text-text-tertiary">estimate</span>}
        <AutosaveStatus state={save.state} onRetry={() => void save.retry()} />
      </td>
      <td className={`py-2 pr-2 ${tone}`}>{status}</td>
      <td className="py-2 text-right font-mono text-[12px] text-text-secondary">{c.state === "untracked" ? "" : `${c.daysLeft} d left`}</td>
    </tr>
  );
}

function Credits({ data, onSaved }: { data: RewardsData; onSaved: () => void }) {
  return (
    <div className={`${card} overflow-x-auto`}>
      <div className="flex items-center gap-2">
        <h3 className="text-[14px] font-semibold">Amex Platinum credits</h3>
        <InfoHint label="Amex Platinum credits">
          <p>
            A credit counts as used only when a matching credit row (a negative amount on the Platinum card naming the credit) is
            dated inside the period. No row means &quot;not used yet&quot;. Amounts are estimates of the current benefits; edit
            them when Amex changes one. Credits applied inside another app (Uber Cash) leave no row on the card.
          </p>
        </InfoHint>
      </div>
      <table className="mt-2 w-full text-left text-[13px]">
        <thead className="text-[11px] uppercase text-text-tertiary">
          <tr>
            <th className="font-normal">Credit</th>
            <th className="font-normal">Per period</th>
            <th className="font-normal">This period</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data.credits.map((c) => (
            <CreditRow key={c.id} c={c} onSaved={onSaved} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Earned({ data }: { data: RewardsData }) {
  return (
    <div className="space-y-3">
      {data.nonUsdCount > 0 && (
        <p className="text-[13px] text-text-secondary" data-testid="rewards-non-usd">
          {num(data.nonUsdCount)} non-USD {data.nonUsdCount === 1 ? "transaction" : "transactions"} left out of earn and credits
        </p>
      )}
      {data.earn.map((e) => {
        const def = cardDef(e.card);
        const cash = def.earns === "cash";
        const rows = e.months.map((m) => ({ label: monthName(m.month), value: cash ? m.earned / 100 : m.earned }));
        return (
          <div key={e.card} className={card}>
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-[14px] font-semibold">{def.name}</h3>
              <span className="font-mono text-[13px]">
                {cash ? usd2(e.total) : `${num(e.total)} pts`} <span className="text-text-tertiary">in 12 months</span>
              </span>
            </div>
            {e.txnCount === 0 ? (
              <p className="mt-2 text-[13px] text-text-secondary">No purchases on this card in the last 12 months.</p>
            ) : (
              <>
                <p className="sr-only">
                  Earned per month: {rows.map((r) => `${r.label} ${cash ? `$${r.value.toFixed(2)}` : num(r.value)}`).join(", ")}.
                </p>
                <ResponsiveContainer width="100%" height={160}>
                  <BarChart data={rows} margin={{ top: 8, right: 8, left: 4, bottom: 0 }}>
                    <CartesianGrid {...gridStyle} vertical={false} />
                    <XAxis dataKey="label" tick={axisTick} interval={0} />
                    <YAxis tick={axisTick} width={44} />
                    <Tooltip {...chartTooltip} cursor={{ fill: "rgba(255,255,255,0.03)" }} formatter={(v) => [cash ? `$${Number(v).toFixed(2)}` : num(Number(v)), "Earned"]} />
                    <Bar dataKey="value" fill={C.categorical[0]} radius={[2, 2, 0, 0]} isAnimationActive={false} />
                  </BarChart>
                </ResponsiveContainer>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function Best({ rows }: { rows: ReturnType<typeof bestCardTable> }) {
  return (
    <div className={`${card} overflow-x-auto`}>
      <div className="flex items-center gap-2">
        <h3 className="text-[14px] font-semibold">Best card for this purchase</h3>
        <InfoHint label="Best card">
          <p>
            Value is the card&apos;s earn rate times your valuation of its points. Apple Card is assumed at 2% (the 1% for a
            purchase not made with Apple Pay cannot be seen). Citi Simplicity and Diamond Preferred earn nothing.
          </p>
        </InfoHint>
      </div>
      <table className="mt-2 w-full text-left text-[13px]">
        <thead className="text-[11px] uppercase text-text-tertiary">
          <tr>
            <th className="font-normal">Purchase</th>
            <th className="font-normal">Use</th>
            <th className="font-normal">Value per $1</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.category} className="border-t border-border-subtle align-top">
              <td className="py-2 pr-2">{r.category}</td>
              <td className="py-2 pr-2 font-medium">{r.best ? cardDef(r.best).name : "Any"}</td>
              <td className="py-2 text-[12px] text-text-secondary">
                {r.values.map((v) => `${cardDef(v.card).name.split(" ")[0]} ${v.centsPerDollar.toFixed(1)}¢ (${v.rate})`).join(" · ")}
                {r.note && <div className="text-text-tertiary">{r.note}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DiscoverQuarter({ data, onSaved }: { data: RewardsData; onSaved: () => void }) {
  const dq = data.settings.discoverQuarter;
  const [quarter, setQuarter] = useState(dq.quarter ?? "");
  const [words, setWords] = useState(dq.keywords.join(", "));
  const save = useSettingSave(
    "rewards:discover-quarter",
    (t) => {
      const [q, w] = t.split("\u0000");
      const keywords = (w ?? "").split(",").map((x) => x.trim()).filter(Boolean);
      if (q && !/^\d{4}-Q[1-4]$/.test(q.trim())) return "Quarter looks like 2026-Q4.";
      if (keywords.length > 12) return "At most 12 categories.";
      return { key: "discover_quarter", value: { quarter: q.trim() || null, keywords } };
    },
    onSaved,
  );
  const change = (q: string, w: string) => save.change(`${q}\u0000${w}`);
  return (
    <div className={card}>
      <div className="flex items-center gap-2">
        <h3 className="text-[14px] font-semibold">Discover quarter</h3>
        <InfoHint label="Discover quarter">
          <p>
            Discover it pays 5% on rotating categories (up to $1,500 a quarter) and 1% on the rest. Enter this quarter and its
            categories as words that appear in the merchant or category, for example GROCERY, RESTAURANT. Empty means 1% only.
          </p>
        </InfoHint>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-text-secondary">
        <label>
          Quarter{" "}
          <input className={`${input} w-24`} placeholder="2026-Q4" value={quarter} aria-label="Discover quarter" onChange={(e) => { setQuarter(e.target.value); change(e.target.value, words); }} onBlur={() => void save.flush()} />
        </label>
        <label className="flex-1">
          Categories{" "}
          <input className={`${input} w-full min-w-48`} placeholder="GROCERY, RESTAURANT" value={words} aria-label="Discover categories" onChange={(e) => { setWords(e.target.value); change(quarter, e.target.value); }} onBlur={() => void save.flush()} />
        </label>
        <AutosaveStatus state={save.state} onRetry={() => void save.retry()} />
      </div>
    </div>
  );
}

function AppleMerchants({ data, onSaved }: { data: RewardsData; onSaved: () => void }) {
  const [words, setWords] = useState(data.settings.appleBoosted.join(", "));
  const save = useSettingSave(
    "rewards:apple-boosted",
    (t) => {
      const list = t.split(",").map((x) => x.trim()).filter(Boolean);
      return list.length > 30 ? "At most 30 merchants." : { key: "apple_boosted", value: list };
    },
    onSaved,
  );
  return (
    <div className={card}>
      <div className="flex items-center gap-2">
        <h3 className="text-[14px] font-semibold">Apple Card 3% merchants</h3>
        <InfoHint label="Apple Card merchants">
          <p>Apple Card pays 3% at Apple and at partner merchants, 2% on other Apple Pay purchases. The partner list changes; edit it here. Estimates assume 2% for everything not listed.</p>
        </InfoHint>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input className={`${input} w-full`} value={words} aria-label="Apple Card 3% merchants" onChange={(e) => { setWords(e.target.value); save.change(e.target.value); }} onBlur={() => void save.flush()} />
        <AutosaveStatus state={save.state} onRetry={() => void save.retry()} />
      </div>
    </div>
  );
}

export default function RewardsClient({ load, feed = false, layout }: { load: RewardsLoad; feed?: boolean; layout?: PageLayout }) {
  const router = useRouter();
  const Root = feed ? "section" : "main";
  const H = feed ? "h2" : "h1";
  // A saved edit changes the estimates (credits, earn): the routed page re-reads on the server; the scroll's copy is
  // refetched by the shared client cache after any successful write under /api/rewards.
  const onSaved = () => {
    if (!feed) router.refresh();
  };
  const header = (
    <header>
      <div className="flex items-center gap-2">
        <H data-testid={feed ? "feed-page-heading" : "page-heading"} className="text-2xl font-semibold">
          Rewards
        </H>
        <InfoHint label="Rewards">
          <p>
            Points, miles and cash back across your cards and travel programs. Balances come from a daily read on your PC; a
            program with no read yet says so instead of showing 0. Earn and expiry figures are estimates from your card
            transactions. Shown only to you; nothing here moves points or places an order.
          </p>
        </InfoHint>
      </div>
    </header>
  );

  if (load.kind === "error") {
    return (
      <Root className="mx-auto max-w-6xl space-y-6 p-4 md:p-8">
        {header}
        <section role="alert" className="rounded-control border border-red-500/30 bg-red-500/5 p-4">
          <h3 className="font-semibold text-red-300">{load.message}</h3>
          {load.hint && <p className="mt-1 text-[13px] text-text-secondary">{load.hint}</p>}
          <p className="mt-1 text-[12px] text-text-tertiary">This is a failed query, not an empty account.</p>
        </section>
      </Root>
    );
  }

  const data = load.data;
  const connected = data.programs.some((p) => p.balance);
  const best = bestCardTable(data.settings);
  return (
    <Root className="mx-auto max-w-6xl space-y-6 p-4 md:p-8" aria-label={feed ? "Rewards" : undefined}>
      {header}
      {!connected && (
        <section className={card}>
          <p className="font-semibold">No balances read yet.</p>
          <p className="mt-1 text-[13px] text-text-secondary">
            Card earn estimates and credits below come from your transactions. Balances appear after the PC reader signs in to each program once.
          </p>
        </section>
      )}
      <PartGrid page="/rewards" title="Rewards" initial={layout} target={!feed}>
        <PartGroup id="balances" title="Balances" gap={16}>
          {data.programs.map((p) => (
            <Part key={p.id} id={`program-${p.id}`} title={p.name} width="half">
              <ProgramCard p={p} cpp={data.settings.cpp[p.id as ProgramId] ?? p.cpp} onSaved={onSaved} />
            </Part>
          ))}
        </PartGroup>
        <PartGroup id="watch" title="Expiry and credits" gap={16}>
          <Part id="expiring" title="Expiring soon">
            <Expiring data={data} />
          </Part>
          <Part id="credits" title="Card credits">
            <Credits data={data} onSaved={onSaved} />
          </Part>
        </PartGroup>
        <PartGroup id="cards" title="Cards" gap={16}>
          <Part id="earned" title="Points earned (12 months)">
            <Earned data={data} />
          </Part>
          <Part id="best" title="Best card">
            <Best rows={best} />
          </Part>
          <Part id="discover" title="Discover quarter" width="half">
            <DiscoverQuarter data={data} onSaved={onSaved} />
          </Part>
          <Part id="apple" title="Apple Card merchants" width="half">
            <AppleMerchants data={data} onSaved={onSaved} />
          </Part>
        </PartGroup>
      </PartGrid>
    </Root>
  );
}
