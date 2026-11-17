import type { InvestmentsLoad } from "@/lib/finance-holdings-server";
import { formatCents } from "@/lib/format";
import InfoHint from "@/components/InfoHint";

function gainLine(value: number | null, basis: number | null, currency: string) {
  if (value == null || basis == null || basis <= 0) return null;
  const diff = value - basis;
  const pct = (diff / basis) * 100;
  return `${formatCents(diff, { currency, signed: true })} (${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%)`;
}

export default function InvestmentsPanel({ load }: { load: InvestmentsLoad }) {
  if (load.status === "empty") return null;
  if (load.status === "unavailable") {
    return (
      <section className="rounded-card shadow-card border border-border-subtle bg-surface-card p-4">
        <h2 className="text-lg font-semibold">Investments</h2>
        <p className="mt-1 text-[13px] text-text-secondary">Positions could not be read right now.</p>
      </section>
    );
  }
  return (
    <section data-testid="investments-panel" className="rounded-card shadow-card border border-border-subtle bg-surface-card p-4">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold">Investments</h2>
        <InfoHint label="Investments">
          <p>
            Positions and recent deposits, withdrawals and trades of your investment accounts, read from SimpleFIN
            Bridge with the balances. Trades and dividends are not spending, so none of this is in the ledger totals.
            A bank feed may carry only some positions.
          </p>
        </InfoHint>
      </div>
      <div className="mt-3 space-y-5">
        {load.accounts.map((acct) => {
          const total = acct.holdings.reduce((s, h) => s + (h.marketValueCents ?? 0), 0);
          return (
            <div key={acct.accountKey}>
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-[14px] font-medium">{acct.label}</h3>
                {acct.holdings.length > 0 && <span className="font-mono text-[13px]">{formatCents(total)}</span>}
              </div>
              {acct.holdings.length > 0 ? (
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full text-left text-[13px]">
                    <thead className="text-[11px] uppercase text-text-tertiary">
                      <tr>
                        <th className="py-1 pr-3 font-medium">Position</th>
                        <th className="py-1 pr-3 text-right font-medium">Shares</th>
                        <th className="py-1 pr-3 text-right font-medium">Value</th>
                        <th className="py-1 text-right font-medium">vs cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {acct.holdings.map((h) => (
                        <tr key={h.holdingId} className="border-t border-border-subtle">
                          <td className="py-1 pr-3">
                            <span className="font-mono">{h.symbol || "-"}</span>
                            {h.description && <span className="ml-2 text-text-secondary">{h.description}</span>}
                          </td>
                          <td className="py-1 pr-3 text-right font-mono">
                            {h.shares == null ? "-" : h.shares.toLocaleString("en-US", { maximumFractionDigits: 4 })}
                          </td>
                          <td className="py-1 pr-3 text-right font-mono">{formatCents(h.marketValueCents, { currency: h.currency })}</td>
                          <td className="py-1 text-right font-mono text-text-secondary">
                            {gainLine(h.marketValueCents, h.costBasisCents, h.currency) ?? "-"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="mt-1 text-[12px] text-text-tertiary">No positions reported.</p>
              )}
              {acct.activity.length > 0 && (
                <ul className="mt-2 space-y-0.5 text-[12px] text-text-secondary">
                  {acct.activity.map((t) => (
                    <li key={t.txnKey} className="flex justify-between gap-3">
                      <span className="truncate">
                        <span className="font-mono text-text-tertiary">{t.date}</span> {t.name || "Activity"}
                      </span>
                      <span className="font-mono">{formatCents(t.amountCents, { currency: t.currency, signed: true })}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
