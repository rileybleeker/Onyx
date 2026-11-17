import type { ReactNode } from "react";
import Link from "next/link";
import ChartCard from "@/components/ChartCard";
import StatCard from "@/components/StatCard";
import { formatCents } from "@/lib/format";
import {
  STALE_BALANCE_HOURS,
  ageLabel,
  ledgerHref,
  monthLabel,
  rankCategories,
  type BalanceLine,
} from "@/lib/finance-ledger";
import type { LedgerData } from "@/lib/finance-ledger-server";
import type { FinanceCard } from "@/lib/finance-status";
import FilterBar from "./FilterBar";
import SpendingTrendChart from "./SpendingTrendChart";
import CategoryEditor from "./CategoryEditor";
import KindOverride from "./KindOverride";
import { PartGrid, type PartSpec } from "@/components/personalize/PartGrid";
import PersonalTable, { type TableColumn } from "@/components/personalize/PersonalTable";
import type { PageLayout } from "@/lib/personalize-layout";

/** Transaction columns: Personalize -> Columns shows / hides and reorders them (Merchant and Currency start hidden). */
const TXN_COLUMNS: TableColumn[] = [
  { id: "date", label: "Date", locked: true, th: "p-2 font-medium", td: "whitespace-nowrap p-2 font-mono text-[12px]" },
  { id: "description", label: "Description", th: "p-2 font-medium", td: "p-2" },
  { id: "account", label: "Account", th: "p-2 font-medium", td: "p-2 text-text-secondary" },
  { id: "category", label: "Category", th: "p-2 font-medium", td: "p-2 text-text-secondary" },
  { id: "amount", label: "In / out", th: "p-2 text-right font-medium", td: "whitespace-nowrap p-2 text-right font-mono tabular-nums" },
  { id: "merchant", label: "Merchant", hidden: true, th: "p-2 font-medium", td: "p-2 text-text-secondary" },
  { id: "currency", label: "Currency", hidden: true, th: "p-2 font-medium", td: "p-2 font-mono text-[12px] text-text-tertiary" },
];

/** Server-rendered ledger: every number below is computed per request and sent as HTML. */

const box = "rounded-card shadow-card border border-border-subtle bg-surface-card p-4";
const STATUS_TEXT: Record<FinanceCard["status"], string> = {
  success: "text-green-400",
  partial: "text-yellow-400",
  failed: "text-red-400",
  unknown: "text-text-tertiary",
};
const STATUS_WORD: Record<FinanceCard["status"], string> = {
  success: "Healthy",
  partial: "Degraded",
  failed: "Error",
  unknown: "Unknown",
};

function etStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "unknown time";
  return `${new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(d)} ET`;
}

export function FreshnessLine({ freshness, now }: { freshness: FinanceCard | null; now: Date }) {
  if (!freshness) {
    return (
      <p className="text-[12px] text-text-tertiary">
        Bank sync (SimpleFIN): no heartbeat recorded yet. <Link className="underline" href="/status" prefetch={false}>Status</Link>
      </p>
    );
  }
  return (
    <div className="text-[12px] text-text-secondary">
      <p>
        Bank sync (SimpleFIN):{" "}
        <span className={STATUS_TEXT[freshness.status]}>{STATUS_WORD[freshness.status]}</span>
        {freshness.lastSync && <> · last report {ageLabel(freshness.lastSync, now)}</>} ·{" "}
        <Link className="underline" href="/status" prefetch={false}>
          Status
        </Link>
      </p>
      {freshness.errorMessage && freshness.status !== "success" && (
        <p className="mt-1 break-words font-mono text-[11px] text-red-400">{freshness.errorMessage}</p>
      )}
    </div>
  );
}

function BalanceRow({ line, now, liability, extra }: { line: BalanceLine; now: Date; liability?: boolean; extra?: ReactNode }) {
  const { account, balance, stale } = line;
  const shown = liability ? Math.abs(balance.balance_cents) : balance.balance_cents;
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-t border-border-subtle py-2 first:border-t-0">
      <div className="min-w-0">
        <p className="truncate text-[13px] text-text-primary">
          {account.institution} · {account.account_name}
          {account.mask ? <span className="text-text-tertiary"> ••{account.mask}</span> : null}
        </p>
        <p className="text-[11px] text-text-tertiary">
          {account.account_type || "Account"}
          {line.excluded === "non-usd" && ` · ${balance.currency}, not converted, left out of totals`}
        </p>
      </div>
      <div className="text-right">
        <p className={`font-mono text-[13px] tabular-nums ${liability ? "text-down" : "text-text-primary"}`}>
          {formatCents(shown, { currency: balance.currency })}
        </p>
        <p className="text-[11px] text-text-tertiary">
          <time dateTime={balance.captured_at} title={etStamp(balance.captured_at)}>
            captured {ageLabel(balance.captured_at, now)}
          </time>
          {stale && (
            <span className="ml-2 rounded-[3px] border border-yellow-500/40 px-1 py-px text-[10px] uppercase tracking-wide text-yellow-300">
              stale
            </span>
          )}
        </p>
      </div>
      {extra ? <div className="basis-full">{extra}</div> : null}
    </li>
  );
}

function Group({ title, note, lines, now, liability, extra }: { title: string; note?: string; lines: BalanceLine[]; now: Date; liability?: boolean; extra?: (l: BalanceLine) => ReactNode }) {
  if (lines.length === 0) return null;
  return (
    <div>
      <h3 className="text-[12px] font-semibold uppercase tracking-[0.07em] text-text-secondary">{title}</h3>
      {note && <p className="mt-0.5 text-[11px] text-text-tertiary">{note}</p>}
      <ul className="mt-1">
        {lines.map((l) => (
          <BalanceRow key={l.account.account_key} line={l} now={now} liability={liability} extra={extra?.(l)} />
        ))}
      </ul>
    </div>
  );
}

function Notice({ children, tone = "warn" }: { children: ReactNode; tone?: "warn" | "info" }) {
  return (
    <p
      role="note"
      className={`rounded-control border px-3 py-2 text-[12px] ${
        tone === "warn" ? "border-yellow-500/30 bg-yellow-500/5 text-yellow-200" : "border-border-subtle text-text-secondary"
      }`}
    >
      {children}
    </p>
  );
}

export default function LedgerView({
  data,
  now,
  onChanged,
  layout,
}: {
  data: LedgerData;
  now: Date;
  /** Called after a category change is saved; without it the page reloads (the server page). */
  onChanged?: () => void;
  /** The saved Personalize layout read from the page's cookie (the routed page only). */
  layout?: PageLayout;
}) {
  const { netWorth: nw, flows, query } = data;
  const monthName = monthLabel(query.month);
  const scopeNote = query.account ? `${data.accountLabels[query.account] ?? "this account"}, ${monthName}` : monthName;
  const ranked = rankCategories(flows.categories);
  const nothingThisMonth = flows.counted + flows.transfers + flows.ignored + flows.foreign === 0;
  const { list } = data;
  const shownFrom = list.total === 0 ? 0 : (list.page - 1) * list.pageSize + 1;
  const shownTo = (list.page - 1) * list.pageSize + list.rows.length;
  const excludedTotal = flows.transfers + flows.ignored;

  // Personalize (components/personalize): every tile, notice, balance list, chart and card is its own part. Parts
  // move within and between the sections (groups) below, and hide / resize / collapse. The routed page renders
  // the saved layout from its cookie on the server, so nothing moves after hydration.
  const heading = "mb-3 text-[15px] font-semibold";
  const hasNotes = nw.unclassified.length + nw.nonUsdCount + nw.staleCount + nw.noBalance.length > 0;
  const noBalances = nw.assets.length + nw.liabilities.length + nw.unclassified.length === 0;

  const netWorthParts: PartSpec[] = [
    {
      id: "nw-total",
      title: "Net worth",
      width: "quarter",
      node: (
        <StatCard
          label="Net worth"
          value={nw.includedCount > 0 ? formatCents(nw.netWorthCents) : null}
          sublabel={
            nw.includedCount > 0
              ? `${nw.includedCount} account${nw.includedCount === 1 ? "" : "s"} counted · oldest balance ${ageLabel(nw.oldestCapturedAt, now)}`
              : "No classified USD balances yet"
          }
        />
      ),
    },
    {
      id: "nw-assets",
      title: "Assets",
      width: "quarter",
      node: <StatCard label="Assets" value={nw.includedCount > 0 ? formatCents(nw.assetsCents) : null} />,
    },
    {
      id: "nw-liabilities",
      title: "Liabilities (owed)",
      width: "quarter",
      node: <StatCard label="Liabilities (owed)" value={nw.includedCount > 0 ? formatCents(nw.liabilitiesCents) : null} />,
    },
  ];
  if (hasNotes) {
    netWorthParts.push({
      id: "nw-notes",
      title: "Net worth notes",
      node: (
        <div className="space-y-2">
          {nw.unclassified.length > 0 && (
            <Notice>
              {nw.unclassified.length} account{nw.unclassified.length === 1 ? " has" : "s have"} no asset or liability label
              from the source (listed under Unclassified).
            </Notice>
          )}
          {nw.nonUsdCount > 0 && (
            <Notice>
              {nw.nonUsdCount} balance{nw.nonUsdCount === 1 ? " is" : "s are"} not in USD and not converted; left out of the totals.
            </Notice>
          )}
          {nw.staleCount > 0 && (
            <Notice>
              {nw.staleCount} balance{nw.staleCount === 1 ? " is" : "s are"} older than {STALE_BALANCE_HOURS} hours. Check the bank sync
              on Status.
            </Notice>
          )}
          {nw.noBalance.length > 0 && (
            <Notice tone="info">
              {nw.noBalance.length} account{nw.noBalance.length === 1 ? " has" : "s have"} no balance snapshot yet
              (transactions only), so {nw.noBalance.length === 1 ? "it is" : "they are"} not in net worth.
            </Notice>
          )}
        </div>
      ),
    });
  }
  if (nw.assets.length > 0) {
    netWorthParts.push({
      id: "bal-assets",
      title: "Asset accounts",
      width: "half",
      node: (
        <div className={box}>
          <Group title="Assets" lines={nw.assets} now={now} />
        </div>
      ),
    });
  }
  if (nw.liabilities.length > 0) {
    netWorthParts.push({
      id: "bal-liabilities",
      title: "Liability accounts",
      width: "half",
      node: (
        <div className={box}>
          <Group title="Liabilities" lines={nw.liabilities} now={now} liability />
        </div>
      ),
    });
  }
  if (nw.unclassified.length > 0) {
    netWorthParts.push({
      id: "bal-unclassified",
      title: "Unclassified accounts",
      node: (
        <div className={box}>
          <Group
            title="Unclassified"
            note="Not counted in net worth until the source labels them."
            lines={nw.unclassified}
            now={now}
            extra={(l) => <KindOverride accountId={l.account.account_key} onSaved={onChanged} />}
          />
        </div>
      ),
    });
  }
  if (noBalances) {
    netWorthParts.push({
      id: "bal-none",
      title: "Balances",
      node: (
        <div className={box}>
          <p className="text-[13px] text-text-secondary">No balances captured yet. Transactions below are still shown.</p>
        </div>
      ),
    });
  }

  const cashflowParts: PartSpec[] = [
    {
      id: "filters",
      title: "Filters",
      node: (
        <section aria-label="Filters" className={box}>
          <FilterBar
            month={query.month}
            months={data.months.map((m) => ({ value: m, label: monthLabel(m) }))}
            account={query.account ?? ""}
            accounts={data.accounts.map((a) => ({ value: a.account_key, label: data.accountLabels[a.account_key] }))}
            q={query.q}
            allMonths={query.allMonths}
          />
        </section>
      ),
    },
    {
      id: "cf-in",
      title: "Money in",
      width: "quarter",
      node: <StatCard label="Money in" value={formatCents(flows.moneyInCents)} sublabel="Includes refunds" />,
    },
    {
      id: "cf-out",
      title: "Money out",
      width: "quarter",
      node: <StatCard label="Money out" value={formatCents(flows.moneyOutCents)} />,
    },
    {
      id: "cf-net",
      title: "Net cashflow",
      width: "quarter",
      node: <StatCard label="Net cashflow" value={formatCents(flows.netCents, { signed: true })} />,
    },
    {
      id: "cf-counted",
      title: "What is counted",
      node: (
        <p className="text-[12px] text-text-tertiary">
          {nothingThisMonth
            ? "No transactions for this month and account."
            : `${flows.counted} transaction${flows.counted === 1 ? "" : "s"} counted. Left out: ${excludedTotal} transfer, card-payment or ignored row${excludedTotal === 1 ? "" : "s"}${
                flows.foreign > 0 ? `, and ${flows.foreign} non-USD row${flows.foreign === 1 ? "" : "s"} (not converted)` : ""
              }.`}
        </p>
      ),
    },
    {
      id: "spending-trend",
      title: "Spending, last 12 months",
      node: (
        <ChartCard
          title="Spending, last 12 months"
          subtitle={`Money out per month, ending ${monthName}${query.account ? " · selected account only" : ""}`}
          hint="Transfers between your own accounts, card payments and rows marked ignored are left out, so paying a card does not count twice."
        >
          <SpendingTrendChart
            data={data.trend.map((t) => ({ month: t.month, label: t.label, outCents: t.outCents }))}
            selectedMonth={query.month}
          />
        </ChartCard>
      ),
    },
    {
      id: "categories",
      title: "Money out by category",
      node: (
        <section aria-labelledby="cats-h" className={box}>
          <h2 id="cats-h" className="text-[15px] font-semibold">
            Money out by category · {scopeNote}
          </h2>
          {ranked.top.length === 0 ? (
            <p className="mt-2 text-[13px] text-text-secondary">No money-out transactions in this selection.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {ranked.top.map((c) => (
                <li key={c.category}>
                  <div className="flex items-baseline justify-between gap-4 text-[13px]">
                    <span className="truncate">{c.category}</span>
                    <span className="shrink-0 font-mono tabular-nums">
                      {formatCents(c.outCents)}
                      <span className="ml-2 text-[11px] text-text-tertiary">
                        {flows.moneyOutCents > 0 ? `${Math.round((c.outCents / flows.moneyOutCents) * 100)}%` : ""}
                      </span>
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 rounded-full bg-white/5" aria-hidden>
                    <div
                      className="h-1.5 rounded-full bg-[var(--color-tick-forecast)]"
                      style={{ width: `${ranked.maxCents > 0 ? Math.max(2, (c.outCents / ranked.maxCents) * 100) : 0}%` }}
                    />
                  </div>
                </li>
              ))}
              {ranked.otherCount > 0 && (
                <li className="flex justify-between gap-4 text-[13px] text-text-secondary">
                  <span>
                    {ranked.otherCount} other categor{ranked.otherCount === 1 ? "y" : "ies"}
                  </span>
                  <span className="font-mono tabular-nums">{formatCents(ranked.otherCents)}</span>
                </li>
              )}
            </ul>
          )}
        </section>
      ),
    },
  ];

  const transactionParts: PartSpec[] = [
    {
      id: "transactions",
      title: "Transactions",
      node: (
        <section aria-labelledby="txns-h" className={box}>
          <h2 id="txns-h" className="text-[15px] font-semibold">
            Transactions · {query.allMonths ? "all months" : monthName}
            {query.q && <span className="font-normal text-text-secondary"> · matching “{query.q}”</span>}
          </h2>
          <p className="mt-1 text-[12px] text-text-tertiary" aria-live="polite">
            {list.total === 0
              ? "No matching transactions."
              : `Showing ${shownFrom}–${shownTo} of ${list.total.toLocaleString("en-US")}.`}
            {data.pageClamped && " That page is past the end, so page 1 is shown."}
          </p>
          {list.rows.length > 0 && (
            <div className="mt-3 overflow-x-auto">
              <PersonalTable
                id="transactions"
                className="w-full min-w-[34rem] text-left text-[13px]"
                headRowClassName="text-[11px] uppercase tracking-[0.08em] text-text-tertiary"
                columns={TXN_COLUMNS}
                rows={list.rows.map((r) => ({
                  key: r.txn_key,
                  className: `border-t border-border-subtle ${r.excluded ? "opacity-60" : ""}`,
                  cells: {
                    date: r.txn_date,
                    description: r.title,
                    account: data.accountLabels[r.account_key] ?? "Unknown account",
                    category: (
                      <>
                        <CategoryEditor txnKey={r.txn_key} merchantKey={r.merchant_key} category={r.category} onSaved={onChanged} />
                        {r.excluded && (
                          <span className="ml-2 rounded-[3px] border border-border-subtle px-1 py-px text-[10px] uppercase tracking-wide text-text-tertiary">
                            {r.excluded === "transfer" ? "not spending" : "ignored"}
                          </span>
                        )}
                      </>
                    ),
                    amount: (
                      <span className={r.amount_cents < 0 ? "text-up" : undefined}>
                        {formatCents(-r.amount_cents, { signed: true, currency: r.currency })}
                      </span>
                    ),
                    merchant: r.merchant_key,
                    currency: r.currency,
                  },
                }))}
              />
            </div>
          )}
          {list.pageCount > 1 && (
            <nav className="mt-3 flex items-center justify-between text-[13px]" aria-label="Transaction pages">
              {list.page > 1 ? (
                <Link className="underline" prefetch={false} href={ledgerHref(query, { page: list.page - 1 })}>
                  Newer
                </Link>
              ) : (
                <span className="text-text-tertiary">Newer</span>
              )}
              <span className="text-text-tertiary">
                Page {list.page} of {list.pageCount}
              </span>
              {list.page < list.pageCount ? (
                <Link className="underline" prefetch={false} href={ledgerHref(query, { page: list.page + 1 })}>
                  Older
                </Link>
              ) : (
                <span className="text-text-tertiary">Older</span>
              )}
            </nav>
          )}
        </section>
      ),
    },
  ];

  // Sections (groups): the heading is the group's header; a part dragged into another section moves there.
  const parts: PartSpec[] = [
    {
      id: "section-net-worth",
      title: "Net worth",
      node: (
        <h2 id="networth-h" className={heading}>
          Net worth
        </h2>
      ),
      members: netWorthParts,
    },
    {
      id: "section-cashflow",
      title: "Cashflow",
      node: (
        <h2 id="cashflow-h" className={heading}>
          Cashflow · {scopeNote}
        </h2>
      ),
      members: cashflowParts,
    },
    { id: "section-transactions", title: "Transactions", node: null, members: transactionParts },
  ];

  return (
    <div className="space-y-6">
      <FreshnessLine freshness={data.freshness} now={now} />

      {(data.windowTruncated || data.skippedRows > 0) && (
        <Notice>
          {data.windowTruncated && "More than 40,000 rows in 12 months, so the oldest months may be incomplete. "}
          {data.skippedRows > 0 && `${data.skippedRows} stored row(s) could not be read and were skipped.`}
        </Notice>
      )}

      {/* `layout` comes only from the routed page (its cookie); the continuous-scroll section shows the saved
          layout too but leaves the Personalize entry to the page on screen. */}
      <PartGrid page="/financials" title="Financials" initial={layout} target={layout !== undefined} parts={parts} />
    </div>
  );
}
