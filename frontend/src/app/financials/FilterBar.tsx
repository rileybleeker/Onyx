"use client";

import { useRef } from "react";

export interface FilterOption {
  value: string;
  label: string;
}
interface Props {
  month: string;
  months: FilterOption[];
  account: string;
  accounts: FilterOption[];
  q: string;
  allMonths: boolean;
}

const field =
  "rounded-[4px] border border-border-subtle bg-surface-card px-2 py-1.5 text-[13px] text-text-primary";

/**
 * Month / account / search controls for /financials. A plain GET form: the server page reads the
 * query string, so nothing is stored in the browser and every state is a shareable link. The
 * selects submit on change; the Apply button keeps it usable without that.
 */
export default function FilterBar({ month, months, account, accounts, q, allMonths }: Props) {
  const form = useRef<HTMLFormElement>(null);
  const submit = () => form.current?.requestSubmit();
  return (
    <form ref={form} method="get" action="/financials" role="search" aria-label="Filter the ledger" className="flex flex-wrap items-end gap-3">
      <label className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary">
        Month
        <select name="month" defaultValue={month} onChange={submit} className={`${field} mt-1 block min-w-[9rem]`}>
          {months.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </label>
      <label className="text-[11px] uppercase tracking-[0.08em] text-text-tertiary">
        Account
        <select name="account" defaultValue={account} onChange={submit} className={`${field} mt-1 block min-w-[12rem] max-w-[18rem]`}>
          <option value="">All accounts</option>
          {accounts.map((a) => (
            <option key={a.value} value={a.value}>
              {a.label}
            </option>
          ))}
        </select>
      </label>
      <label className="min-w-[12rem] flex-1 text-[11px] uppercase tracking-[0.08em] text-text-tertiary">
        Search transactions
        <input
          type="search"
          name="q"
          defaultValue={q}
          maxLength={60}
          placeholder="Name, category or amount"
          className={`${field} mt-1 block w-full normal-case tracking-normal`}
        />
      </label>
      <label className="flex items-center gap-2 pb-2 text-[12px] text-text-secondary">
        <input type="checkbox" name="scope" value="all" defaultChecked={allMonths} />
        Search all months
      </label>
      <button type="submit" className={`${field} cursor-pointer hover:border-border-hover`}>
        Apply
      </button>
    </form>
  );
}
