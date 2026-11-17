"use client";

import { useState } from "react";
import type { DetectedStream, NetWorthMonth } from "@/lib/cash-forecast";
import type { DriverRow } from "@/lib/cash-forecast-store";
import type { ForecastAccountView } from "@/lib/cash-forecast-server";
import type { MovePlan } from "@/lib/finance-plan";
import InfoHint from "@/components/InfoHint";
import { AutosaveStatus } from "@/components/AutosaveStatus";
import { useFinanceAutosave } from "@/lib/use-finance-autosave";

const card = "rounded-card shadow-card border border-border-subtle bg-surface-card p-4";
const input = "rounded-control border border-border-subtle bg-transparent px-2 py-1 text-[13px]";
const button = "rounded-control border border-border-subtle px-3 py-1 text-[13px] hover:bg-white/5 disabled:opacity-50";
type Run = (fn: () => Promise<string | null>) => void;

async function put(key: string, value: unknown): Promise<string | null> {
  try {
    const res = await fetch("/api/finance/forecast/drivers", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key, value }) });
    if (res.ok) return null;
    return ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `failed (${res.status})`;
  } catch {
    return "network error";
  }
}
const toCents = (s: string) => Math.round((Number(s.replace(/[$,\s]/g, "")) || 0) * 100);
const toDollars = (c: number | null | undefined) => (c ? String(Math.round(c / 100)) : "");

/**
 * Everything the forecast assumes that is not in the bank data, in one place: the move, account growth, inflation.
 * The editors autosave (lib/use-finance-autosave.ts): a value is sent after a pause or when its field is left, then
 * the forecast is re-read. Add (a new planned account, whose key comes from its name) stays a button.
 */
export function PlanConfig({ move, drivers, accounts, netWorth, busy, run }: { move: MovePlan | null; drivers: DriverRow[]; accounts: ForecastAccountView[]; netWorth: NetWorthMonth[]; busy: boolean; run: Run }) {
  return (
    <section className={card} aria-labelledby="fc-plan">
      <div className="flex items-center gap-2">
        <h2 id="fc-plan" className="font-semibold">Plan &amp; assumptions</h2>
        <InfoHint label="Plan and assumptions">
          <p>What the forecast cannot see in your bank data. Every value here is editable and saves on its own; saved values replace the defaults.</p>
        </InfoHint>
      </div>
      <MoveEditor move={move} busy={busy} run={run} />
      <GrowthEditor drivers={drivers} accounts={accounts} netWorth={netWorth} busy={busy} run={run} />
    </section>
  );
}

type MoveForm = { date: string; currentRent: string; newRent: string; moving: string; deposit: string; refund: string; col: string };
const moveValue = (f: MoveForm) => ({
  date: f.date,
  currentRentCents: toCents(f.currentRent),
  newRentCents: toCents(f.newRent),
  movingCostsCents: toCents(f.moving),
  depositCents: toCents(f.deposit),
  depositRefundCents: toCents(f.refund),
  livingCostChangeCents: Math.round((Number(f.col.replace(/[$,\s]/g, "")) || 0) * 100),
  months: 24,
});

function MoveEditor({ move, busy, run }: { move: MovePlan | null; busy: boolean; run: Run }) {
  const [initial] = useState<MoveForm>(() => ({
    date: move?.date ?? "",
    currentRent: toDollars(move?.currentRentCents),
    newRent: toDollars(move?.newRentCents),
    moving: toDollars(move?.movingCostsCents),
    deposit: toDollars(move?.depositCents),
    refund: toDollars(move?.depositRefundCents),
    col: move?.livingCostChangeCents ? String(Math.round(move.livingCostChangeCents / 100)) : "",
  }));
  const [f, setF] = useState<MoveForm>(initial);
  const autosave = useFinanceAutosave<MoveForm>("forecast-move", run, (v) => put("move", moveValue(v)), {
    ready: (v) => (v.date ? null : "Pick a move date to save the move."),
    baseline: initial,
  });
  const set = (k: keyof MoveForm) => (e: { target: { value: string } }) => {
    const next = { ...f, [k]: e.target.value };
    setF(next);
    autosave.change(next);
  };
  const field = (label: string, k: keyof MoveForm, type = "text", w = "w-24") => (
    <label className="flex flex-col gap-1 text-[12px] text-text-secondary">
      {label}
      <input className={`${input} ${w}`} type={type} value={f[k]} onChange={set(k)} onBlur={() => void autosave.flush()} inputMode={type === "text" ? "decimal" : undefined} />
    </label>
  );
  const change = toCents(f.newRent) - toCents(f.currentRent);
  return (
    <div className="mt-4">
      <h3 className="text-[13px] font-semibold">NYC move</h3>
      {move?.note && <p className="text-[12px] text-mid">{move.note}</p>}
      <div className="mt-2 flex flex-wrap gap-3">
        {field("Move date", "date", "date", "w-36")}
        {field("Rent now ($/mo)", "currentRent")}
        {field("NYC rent ($/mo)", "newRent")}
        {field("Moving costs ($)", "moving")}
        {field("NYC deposit ($)", "deposit")}
        {field("Old deposit back ($)", "refund")}
        {field("Living costs change ($/mo)", "col")}
      </div>
      <p className="mt-1 text-[12px] text-text-secondary">
        {f.date ? `Adds ${change >= 0 ? "+" : "-"}$${Math.abs(Math.round(change / 100)).toLocaleString("en-US")}/mo rent from the first rent after ${f.date}, the one-off costs, and New York tax residency from that date.` : "No move planned."}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <AutosaveStatus state={autosave.state} onRetry={() => void autosave.retry()} showIncomplete={Object.values(f).some((x) => x.trim())} />
        {move && (
          <button
            className={button}
            disabled={busy}
            onClick={() => {
              autosave.reset();
              run(() => put("move", null));
            }}
          >
            No move
          </button>
        )}
      </div>
    </div>
  );
}

function GrowthEditor({ drivers, accounts, netWorth, busy, run }: { drivers: DriverRow[]; accounts: ForecastAccountView[]; netWorth: NetWorthMonth[]; busy: boolean; run: Run }) {
  const growth = new Map(drivers.filter((d) => d.key.startsWith("growth:")).map((d) => [d.key.slice(7), d.value as Record<string, unknown>]));
  const rows = [
    ...accounts.filter((a) => a.type === "investment").map((a) => ({ key: a.account_key, label: a.label, virtual: false })),
    ...[...growth.entries()].filter(([k]) => k.startsWith("virtual-")).map(([k, v]) => ({ key: k, label: String(v.label ?? "Planned account"), virtual: true })),
  ];
  const [newName, setNewName] = useState("");
  const last = netWorth[netWorth.length - 1]?.byAccount ?? {};
  return (
    <div className="mt-5">
      <div className="flex items-center gap-2">
        <h3 className="text-[13px] font-semibold">Investment accounts: return and contributions</h3>
        <InfoHint label="Investment accounts">
          <p>Counts toward net worth, not cash. Contributions here are money that goes in without passing through checking (employer SEP, payroll 401(k) or HSA).</p>
        </InfoHint>
      </div>
      <table className="mt-2 w-full text-[13px]">
        <thead className="text-[12px] text-text-tertiary">
          <tr>
            <th className="text-left font-normal">Account</th>
            <th className="text-left font-normal">Return %/yr</th>
            <th className="text-left font-normal">Adds $/mo</th>
            <th className="text-left font-normal">From</th>
            <th className="text-right font-normal">In {netWorth.length} months</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <GrowthRow key={r.key} row={r} value={growth.get(r.key)} projected={last[r.label]} busy={busy} run={run} />
          ))}
        </tbody>
      </table>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input className={input} aria-label="Planned account name" placeholder="Add a planned account (e.g. Roth IRA)" value={newName} onChange={(e) => setNewName(e.target.value)} maxLength={80} />
        <button
          className={button}
          disabled={busy || !newName.trim()}
          onClick={() => {
            const slug = newName.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "account";
            run(() => put(`growth:virtual-${slug}`, { label: newName.trim(), returnPct: 5 }).then((e) => (e ? e : (setNewName(""), null))));
          }}
        >
          Add
        </button>
      </div>
    </div>
  );
}

function GrowthRow({ row, value, projected, busy, run }: { row: { key: string; label: string; virtual: boolean }; value: Record<string, unknown> | undefined; projected: number | undefined; busy: boolean; run: Run }) {
  const [ret, setRet] = useState(typeof value?.returnPct === "number" ? String(value.returnPct) : "");
  const [contrib, setContrib] = useState(toDollars(typeof value?.monthlyContributionCents === "number" ? value.monthlyContributionCents : null));
  const [from, setFrom] = useState(typeof value?.contributionStarts === "string" ? value.contributionStarts : "");
  const [start, setStart] = useState(toDollars(typeof value?.startCents === "number" ? value.startCents : null));
  type GrowthForm = { ret: string; contrib: string; from: string; start: string };
  const toValue = (g: GrowthForm) => {
    const v: Record<string, unknown> = {};
    if (g.ret.trim()) v.returnPct = Number(g.ret);
    if (g.contrib.trim()) v.monthlyContributionCents = toCents(g.contrib);
    if (g.from) v.contributionStarts = g.from;
    if (row.virtual) {
      v.label = row.label;
      v.startCents = toCents(g.start);
    }
    return Object.keys(v).length ? v : null;
  };
  const autosave = useFinanceAutosave<GrowthForm>(`forecast-growth:${row.key}`, run, (g) => put(`growth:${row.key}`, toValue(g)), {
    ready: (g) => (g.ret.trim() && !Number.isFinite(Number(g.ret)) ? "Return must be a number." : null),
    baseline: { ret, contrib, from, start },
  });
  const edit = (patch: Partial<GrowthForm>) => {
    const next = { ret, contrib, from, start, ...patch };
    setRet(next.ret);
    setContrib(next.contrib);
    setFrom(next.from);
    setStart(next.start);
    autosave.change(next);
  };
  const flush = () => void autosave.flush();
  return (
    <tr className="border-t border-border-subtle">
      <td className="py-1 pr-2">
        {row.label}
        {row.virtual && (
          <label className="ml-2 text-[11px] text-text-tertiary">
            starts with $<input className={`${input} w-20`} value={start} onChange={(e) => edit({ start: e.target.value })} onBlur={flush} inputMode="decimal" />
          </label>
        )}
      </td>
      <td className="py-1 pr-2">
        <input className={`${input} w-16`} value={ret} placeholder="5" onChange={(e) => edit({ ret: e.target.value })} onBlur={flush} inputMode="decimal" aria-label={`Return for ${row.label}`} />
      </td>
      <td className="py-1 pr-2">
        <input className={`${input} w-20`} value={contrib} placeholder="0" onChange={(e) => edit({ contrib: e.target.value })} onBlur={flush} inputMode="decimal" aria-label={`Monthly contribution to ${row.label}`} />
      </td>
      <td className="py-1 pr-2">
        <input className={input} type="date" value={from} onChange={(e) => edit({ from: e.target.value })} onBlur={flush} aria-label={`Contributions start for ${row.label}`} />
      </td>
      <td className="py-1 pr-2 text-right text-text-secondary">{projected !== undefined ? `$${Math.round(projected / 100).toLocaleString("en-US")}` : "-"}</td>
      <td className="py-1 text-right">
        <AutosaveStatus state={autosave.state} onRetry={() => void autosave.retry()} showIncomplete />
        {row.virtual && (
          <button
            className="ml-1 text-[12px] text-text-tertiary hover:text-down"
            disabled={busy}
            onClick={() => {
              autosave.reset();
              run(() => put(`growth:${row.key}`, null));
            }}
          >
            remove
          </button>
        )}
      </td>
    </tr>
  );
}

/** Settings for the forecast model itself; every save merges into the one "settings" driver. */
export function ModelSettings({ drivers, run }: { drivers: DriverRow[]; busy?: boolean; run: Run }) {
  const settings = (drivers.find((d) => d.key === "settings")?.value ?? {}) as Record<string, unknown>;
  const str = (k: string, scale = 1) => (typeof settings[k] === "number" ? String((settings[k] as number) / scale) : "");
  type SettingsForm = { buffer: string; inflation: string; lookback: string; cardMonths: string; low: string };
  const [initial] = useState<SettingsForm>(() => ({ buffer: str("bufferCents", 100), inflation: str("inflationPct"), lookback: str("lookbackWeeks"), cardMonths: str("cardMonths"), low: str("lowPercentile") }));
  const [f, setF] = useState<SettingsForm>(initial);
  const toValue = (g: SettingsForm) => {
    const num = (v: string) => (v.trim() === "" ? undefined : Number(v.replace(/[$,\s]/g, "")));
    const next: Record<string, unknown> = {};
    const buffer = num(g.buffer);
    if (buffer && buffer > 0) next.bufferCents = Math.round(buffer * 100);
    for (const [k, v] of [["inflationPct", num(g.inflation)], ["lookbackWeeks", num(g.lookback)], ["cardMonths", num(g.cardMonths)], ["lowPercentile", num(g.low)]] as const) if (v !== undefined && Number.isFinite(v)) next[k] = v;
    return Object.keys(next).length ? next : null;
  };
  const autosave = useFinanceAutosave<SettingsForm>("forecast-settings", run, (g) => put("settings", toValue(g)), { baseline: initial });
  const set = (k: keyof SettingsForm) => (e: { target: { value: string } }) => {
    const next = { ...f, [k]: e.target.value };
    setF(next);
    autosave.change(next);
  };
  const field = (label: string, k: keyof SettingsForm, ph: string, hint: string) => (
    <label className="flex flex-col gap-1 text-[12px] text-text-secondary" title={hint}>
      {label}
      <input className={`${input} w-24`} value={f[k]} placeholder={ph} onChange={set(k)} onBlur={() => void autosave.flush()} inputMode="decimal" />
    </label>
  );
  return (
    <section className={card} aria-labelledby="fc-settings">
      <h2 id="fc-settings" className="font-semibold">Forecast settings</h2>
      <p className="text-[12px] text-text-tertiary">Blank = the default. Saves on its own.</p>
      <div className="mt-2 flex flex-wrap gap-3">
        {field("Low-balance line ($)", "buffer", "0", "Alerts and safe-to-move keep the cautious path above this")}
        {field("Inflation (%/yr)", "inflation", "0", "Grows everyday spending")}
        {field("Spending history (weeks)", "lookback", "26", "Weeks of history the everyday-spending average uses (4 to 104)")}
        {field("Card average (months)", "cardMonths", "6", "Months of payments averaged for each card (1 to 12)")}
        {field("Cautious band (percentile)", "low", "10", "Lower = more cautious (5 to 25)")}
      </div>
      <div className="mt-2">
        <AutosaveStatus state={autosave.state} onRetry={() => void autosave.retry()} />
      </div>
    </section>
  );
}

/** Detected streams with an editor: change the amount from a date, stop it, or reset to what the history shows. */
export function StreamEditorList({ streams, drivers, today, busy, run }: { streams: DetectedStream[]; drivers: DriverRow[]; today: string; busy: boolean; run: Run }) {
  return (
    <ul className="mt-2 space-y-2 text-[13px]">
      {streams.map((s) => (
        <StreamRow key={s.id} s={s} adj={drivers.find((d) => d.key === `adjust:${s.id}`)?.value as Record<string, unknown> | undefined} today={today} busy={busy} run={run} />
      ))}
    </ul>
  );
}

function StreamRow({ s, adj, today, busy, run }: { s: DetectedStream; adj: Record<string, unknown> | undefined; today: string; busy: boolean; run: Run }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState(String(Math.abs(Math.round(s.typicalCents / 100))));
  const [from, setFrom] = useState(typeof adj?.from === "string" ? adj.from : today);
  const sign = s.typicalCents < 0 ? -1 : 1;
  const money = (c: number) => `${c < 0 ? "-" : "+"}$${Math.abs(Math.round(c / 100)).toLocaleString("en-US")}`;
  return (
    <li>
      <span className="font-semibold">{s.label}</span> {money(s.typicalCents)} <span className="text-text-tertiary">({s.cadence}; {s.method}; {s.certainty})</span>
      {adj && (
        <span className="ml-2 text-[12px] text-mid">
          {adj.stop ? `stopped from ${String(adj.from)}` : `set to ${money(Number(adj.amountCents))} from ${String(adj.from)}`}
        </span>
      )}{" "}
      <button className="text-[12px] text-accent hover:underline" onClick={() => setOpen((o) => !o)}>
        {open ? "close" : "edit"}
      </button>
      {open && (
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-text-secondary">
          from <input className={input} type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label={`Adjustment start date for ${s.label}`} />
          amount $<input className={`${input} w-24`} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" aria-label={`Adjustment amount for ${s.label}`} />
          <button className={button} disabled={busy || !from} onClick={() => run(() => put(`adjust:${s.id}`, { from, amountCents: sign * Math.round((Number(amount.replace(/[$,\s]/g, "")) || 0) * 100) }))}>
            Set amount
          </button>
          <button className={button} disabled={busy || !from} onClick={() => run(() => put(`adjust:${s.id}`, { from, stop: true }))}>
            Stop from then
          </button>
          {adj && (
            <button className={button} disabled={busy} onClick={() => run(() => put(`adjust:${s.id}`, null))}>
              Reset
            </button>
          )}
        </div>
      )}
    </li>
  );
}
