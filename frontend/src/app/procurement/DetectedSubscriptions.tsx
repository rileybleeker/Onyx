"use client";
import { formatDate, money } from '@/lib/procurement';
import type { DetectedLoad, DetectedSubscription, IrregularCharge } from '@/lib/procurement-recurring';
import { RENEWAL_LIST_DAYS, estimateNote, renewalPhrase, renewalRows, type RenewalRow } from '@/lib/procurement-renewals';

// Subscriptions detected in the Rocket Money ledger, with renewal estimates. Read-only: every
// number comes from the server-rendered `detected` prop; nothing here fetches, pays or cancels.
const card = 'rounded-xl border border-border-subtle bg-surface-card p-5 space-y-4';
const cadenceWord = { weekly: 'week', monthly: 'month', quarterly: 'quarter', annual: 'year' } as const;
const dayNum = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86400000);
const subKey = (s: { id: string; cadence?: string }) => `${s.id}|${s.cadence ?? ''}`;

function DetectedRow({ sub, today }: { sub: DetectedSubscription; today: string }) {
  const days = dayNum(sub.nextExpected) - dayNum(today);
  return <li className="border-t border-border-subtle pt-3 flex flex-wrap gap-3 justify-between" data-testid="procurement-detected-row">
    <div className="min-w-0">
      <h3 className="break-words">{sub.merchant}</h3>
      <p className="text-sm">{money(sub.typicalCents)} / {cadenceWord[sub.cadence]} · last charged {formatDate(sub.lastCharge)} · {sub.status === 'active'
        ? <>next expected {formatDate(sub.nextExpected)} ({renewalPhrase(days)})</>
        : <>no charge since; the next one was expected {formatDate(sub.nextExpected)}</>}</p>
      {sub.status === 'active' && <p className="text-xs text-text-secondary">{estimateNote(sub)}</p>}
    </div>
    <p className="text-sm text-text-secondary">about {money(sub.monthlyCents)} / month</p>
  </li>;
}

function SoonRow({ row }: { row: RenewalRow }) {
  return <li className="text-sm">
    <span className="font-medium">{row.merchant}</span> {renewalPhrase(row.days)}{row.days >= 0 ? `, ${formatDate(row.date)}` : ''} · {money(row.typicalCents)}
    {!row.alertable && <span className="text-text-secondary"> · rough date (low confidence)</span>}
  </li>;
}

function IrregularRow({ item }: { item: IrregularCharge }) {
  return <li className="border-t border-border-subtle pt-3 text-sm">
    <h3 className="break-words text-base">{item.merchant}</h3>
    <p>About {money(item.typicalCents)} each · {item.chargeCount} charges, typically about {item.medianGapDays} days apart · last charged {formatDate(item.lastCharge)}</p>
    <p className="text-xs text-text-secondary">No next date: the spacing is too uneven to estimate one.</p>
  </li>;
}

export default function DetectedSubscriptions({ detected }: { detected: DetectedLoad }) {
  const ok = detected.state === 'ok' ? detected : null;
  const active = ok ? ok.subs.filter(s => s.status === 'active') : [];
  const lapsed = ok ? ok.subs.filter(s => s.status === 'lapsed') : [];
  const irregular = ok ? ok.irregular : [];
  const today = ok ? ok.today : '';
  // Soonest first; a charge expected up to a week ago that has not posted yet is still listed.
  const soon = ok ? renewalRows(ok.subs, today).filter(r => r.days >= -7 && r.days <= RENEWAL_LIST_DAYS) : [];
  return <section className={card} aria-label="Detected subscriptions" data-testid="procurement-detected" data-state={detected.state}>
    <h2 className="text-xl font-semibold">Detected subscriptions</h2>
    <p className="text-sm text-text-secondary">Recurring charges found in your Rocket Money ledger over the last 400 days, with an estimate of when each one renews. Read-only: Onyx never cancels or pays anything.</p>
    {detected.state === 'error' && <p role="alert" className="text-red-400">Couldn&apos;t read the ledger (code {detected.code}), so no subscriptions are shown. This is a failed query, not an empty ledger.</p>}
    {detected.state === 'empty' && <p>No ledger data yet. Subscriptions appear here after the daily Rocket Money import; nothing is invented in the meantime.</p>}
    {ok && (ok.subs.length === 0 && irregular.length === 0
      ? <p>The ledger was read but no recurring charges were found in it.</p>
      : <div className="space-y-4">
        <p>About {money(ok.total)} / month across {active.length} active subscription{active.length === 1 ? '' : 's'}.</p>
        <div data-testid="procurement-renewals">
          <h3 className="font-semibold">Renewing soon</h3>
          {soon.length === 0
            ? <p className="text-sm text-text-secondary">Nothing is expected to renew in the next {RENEWAL_LIST_DAYS} days.</p>
            : <ul className="mt-1 space-y-1">{soon.map(r => <SoonRow key={subKey(r)} row={r} />)}</ul>}
          <p className="mt-1 text-xs text-text-secondary">Dates are estimates from past charge dates; a charge can post a day or two either side. Today shows a renewal 3 days ahead when the estimate is high or medium confidence.</p>
        </div>
        {active.length > 0 && <ul className="space-y-3">{active.map(s => <DetectedRow key={subKey(s)} sub={s} today={today} />)}</ul>}
        {lapsed.length > 0 && <details><summary className="cursor-pointer text-sm">{lapsed.length} lapsed (no recent charge)</summary><ul className="space-y-3 mt-3">{lapsed.map(s => <DetectedRow key={subKey(s)} sub={s} today={today} />)}</ul></details>}
        {irregular.length > 0 && <details data-testid="procurement-irregular"><summary className="cursor-pointer text-sm">{irregular.length} repeating charge{irregular.length === 1 ? '' : 's'} without a regular schedule (no date estimated)</summary><ul className="space-y-3 mt-3">{irregular.map(i => <IrregularRow key={i.id} item={i} />)}</ul></details>}
      </div>)}
  </section>;
}
