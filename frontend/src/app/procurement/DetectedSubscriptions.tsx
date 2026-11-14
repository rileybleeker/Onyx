"use client";
import { useState } from 'react';
import { formatDate, money } from '@/lib/procurement';
import type { DetectedLoad, DetectedSubscription, IrregularCharge } from '@/lib/procurement-recurring';
import { RENEWAL_LIST_DAYS, estimateNote, renewalPhrase, renewalRows, type RenewalRow } from '@/lib/procurement-renewals';
import { dismissalKey, usageLine, type AdviceLoad, type SubscriptionAdvice, type WasteFlag } from '@/lib/procurement-flags';

// Subscriptions detected in the Rocket Money ledger, with renewal estimates and waste flags.
// Read-only advice: every number comes from the server-rendered props. The only request this
// component makes is the PATCH that remembers a dismissed flag; nothing here pays or cancels.
const FLAGS_API = '/api/procurement/flags';
const card = 'rounded-xl border border-border-subtle bg-surface-card p-5 space-y-4';
const smallButton = 'rounded border border-border-subtle px-2 py-1 text-xs hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed';
const cadenceWord = { weekly: 'week', monthly: 'month', quarterly: 'quarter', annual: 'year' } as const;
const dayNum = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00Z`) / 86400000);
const subKey = (s: { id: string; cadence?: string }) => `${s.id}|${s.cadence ?? ''}`;

interface FlagActions { canDismiss: boolean; busy: string | null; isDismissed: (subId: string, flag: WasteFlag) => boolean; mark: (subId: string, flag: WasteFlag, dismissed: boolean) => void }

function DetectedRow({ sub, today, advice, actions }: { sub: DetectedSubscription; today: string; advice?: SubscriptionAdvice; actions: FlagActions }) {
  const days = dayNum(sub.nextExpected) - dayNum(today);
  const open = advice ? advice.flags.filter(f => !actions.isDismissed(sub.id, f)) : [];
  return <li className="border-t border-border-subtle pt-3 space-y-2" data-testid="procurement-detected-row">
    <div className="flex flex-wrap gap-3 justify-between">
      <div className="min-w-0">
        <h3 className="break-words">{sub.merchant}</h3>
        <p className="text-sm">{money(sub.typicalCents)} / {cadenceWord[sub.cadence]} · last charged {formatDate(sub.lastCharge)} · {sub.status === 'active'
          ? <>next expected {formatDate(sub.nextExpected)} ({renewalPhrase(days)})</>
          : <>no charge since; the next one was expected {formatDate(sub.nextExpected)}</>}</p>
        {sub.status === 'active' && <p className="text-xs text-text-secondary">{estimateNote(sub)}</p>}
        {advice && <p className="text-xs text-text-secondary break-words" data-testid="procurement-usage">{usageLine(advice.usage)}</p>}
      </div>
      <p className="text-sm text-text-secondary">about {money(sub.monthlyCents)} / month</p>
    </div>
    {open.length > 0 && <ul className="space-y-2" aria-label={`Flags for ${sub.merchant}`}>{open.map(f => <li key={f.key} data-testid="procurement-flag" data-kind={f.kind} className="rounded border border-amber-300/40 bg-amber-300/5 p-2 text-sm flex flex-wrap items-start justify-between gap-2">
      <p className="min-w-0 break-words"><span className="font-medium text-amber-300">{f.title}.</span> {f.reason}</p>
      {actions.canDismiss && <button type="button" className={smallButton} disabled={actions.busy !== null} aria-label={`Dismiss "${f.title}" for ${sub.merchant}`} onClick={() => actions.mark(sub.id, f, true)}>Dismiss</button>}
    </li>)}</ul>}
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

export default function DetectedSubscriptions({ detected, advice }: { detected: DetectedLoad; advice: AdviceLoad | null }) {
  // Dismissals made on this visit, on top of what the server rendered: key -> dismissed.
  const [marks, setMarks] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [flagError, setFlagError] = useState('');
  const ok = detected.state === 'ok' ? detected : null;
  const active = ok ? ok.subs.filter(s => s.status === 'active') : [];
  const lapsed = ok ? ok.subs.filter(s => s.status === 'lapsed') : [];
  const irregular = ok ? ok.irregular : [];
  const today = ok ? ok.today : '';
  // Soonest first; a charge expected up to a week ago that has not posted yet is still listed.
  const soon = ok ? renewalRows(ok.subs, today).filter(r => r.days >= -7 && r.days <= RENEWAL_LIST_DAYS) : [];
  const adviceBySub = new Map((advice?.advice ?? []).map(a => [a.subId, a]));
  const isDismissed = (subId: string, flag: WasteFlag) => marks[dismissalKey(subId, flag.key)] ?? flag.dismissed;
  async function mark(subId: string, flag: WasteFlag, dismissed: boolean) {
    const key = dismissalKey(subId, flag.key);
    const before = isDismissed(subId, flag);
    setBusy(key); setFlagError('');
    setMarks(previous => ({ ...previous, [key]: dismissed }));
    try {
      const res = await fetch(FLAGS_API, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sub: subId, flag: flag.key, dismissed }) });
      if (!res.ok) throw new Error('not saved');
    } catch {
      setMarks(previous => ({ ...previous, [key]: before }));
      setFlagError(dismissed ? 'Could not save that dismissal, so the flag is still shown.' : 'Could not restore that flag.');
    }
    setBusy(null);
  }
  const actions: FlagActions = { canDismiss: advice?.canDismiss === true, busy, isDismissed, mark };
  const flagged = active.flatMap(s => (adviceBySub.get(s.id)?.flags ?? []).map(f => ({ sub: s, flag: f })));
  const openCount = flagged.filter(x => !isDismissed(x.sub.id, x.flag)).length;
  const dismissedFlags = flagged.filter(x => isDismissed(x.sub.id, x.flag));
  return <section className={card} aria-label="Detected subscriptions" data-testid="procurement-detected" data-state={detected.state}>
    <h2 className="text-xl font-semibold">Detected subscriptions</h2>
    <p className="text-sm text-text-secondary">Recurring charges found in your Rocket Money ledger over the last 400 days, with an estimate of when each one renews and rule-based flags worth a look. Read-only: Onyx never cancels or pays anything.</p>
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
        {advice && <div data-testid="procurement-flags" data-open={openCount}>
          <h3 className="font-semibold">Worth a look</h3>
          <p className="text-sm text-text-secondary">{openCount === 0
            ? 'No open flags on your active subscriptions.'
            : `${openCount} open flag${openCount === 1 ? '' : 's'}, shown under the subscription ${openCount === 1 ? 'it belongs' : 'they belong'} to.`} Flags: a price increase (last charge 5% and $0.50 or more above the usual amount), a possible duplicate (two active subscriptions in one service category), and no recent use on your iPhone (under 10 minutes in 30 days of Screen Time, only where an app or site could be matched; otherwise usage is unknown).</p>
          {!advice.usageAvailable && <p className="text-sm text-text-secondary">Screen Time data could not be read, so usage is unknown for every subscription and no &quot;no recent use&quot; flag is raised.</p>}
          {!advice.canDismiss && <p className="text-sm text-text-secondary">Dismissing flags is not available right now (the dismissals table could not be read), so every flag is shown.</p>}
          {flagError && <p role="alert" className="text-sm text-red-400">{flagError}</p>}
        </div>}
        {active.length > 0 && <ul className="space-y-3">{active.map(s => <DetectedRow key={subKey(s)} sub={s} today={today} advice={adviceBySub.get(s.id)} actions={actions} />)}</ul>}
        {dismissedFlags.length > 0 && <details data-testid="procurement-dismissed"><summary className="cursor-pointer text-sm">{dismissedFlags.length} dismissed flag{dismissedFlags.length === 1 ? '' : 's'}</summary><ul className="space-y-2 mt-3">{dismissedFlags.map(x => <li key={dismissalKey(x.sub.id, x.flag.key)} className="text-sm flex flex-wrap items-start justify-between gap-2">
          <p className="min-w-0 break-words"><span className="font-medium">{x.sub.merchant}: {x.flag.title}.</span> <span className="text-text-secondary">{x.flag.reason}</span></p>
          {actions.canDismiss && <button type="button" className={smallButton} disabled={busy !== null} aria-label={`Restore "${x.flag.title}" for ${x.sub.merchant}`} onClick={() => mark(x.sub.id, x.flag, false)}>Restore</button>}
        </li>)}</ul></details>}
        {lapsed.length > 0 && <details><summary className="cursor-pointer text-sm">{lapsed.length} lapsed (no recent charge)</summary><ul className="space-y-3 mt-3">{lapsed.map(s => <DetectedRow key={subKey(s)} sub={s} today={today} actions={actions} />)}</ul></details>}
        {irregular.length > 0 && <details data-testid="procurement-irregular"><summary className="cursor-pointer text-sm">{irregular.length} repeating charge{irregular.length === 1 ? '' : 's'} without a regular schedule (no date estimated)</summary><ul className="space-y-3 mt-3">{irregular.map(i => <IrregularRow key={i.id} item={i} />)}</ul></details>}
      </div>)}
  </section>;
}
