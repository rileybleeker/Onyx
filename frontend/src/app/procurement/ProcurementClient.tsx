"use client";
import { useEffect, useState } from 'react';
import {
  CAPABILITIES, MAX_DRAFTS, MAX_SUBSCRIPTIONS, REMINDER_LEAD_DAYS,
  createDraft, createSubscription, draftTotals, duplicateWarnings, executionReadiness, formatDate, isoFromLocalDate,
  money, preparedListText, renewalReminderIcs, reviewPrompts, summarizeSubscriptions, syntheticSubscriptions,
  EXAMPLES, type Draft, type Subscription,
} from '@/lib/procurement';
import type { DetectedLoad, DetectedSubscription } from '@/lib/procurement-recurring';
const card = 'rounded-xl border border-border-subtle bg-surface-card p-5 space-y-4';
const field = 'block w-full rounded border border-border-subtle bg-transparent p-2 mt-1';
const button = 'rounded border border-border-subtle px-3 py-2 text-sm hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed';
const SUBSCRIPTIONS_API = '/api/procurement/subscriptions';
const persistenceNote = {
  checking: 'Checking for saved subscriptions...',
  saved: 'Saved to your Onyx account: subscriptions you add here are kept between visits. Synthetic demo rows are never saved.',
  pending: 'Not saved yet - setup pending. The subscription table has not been created in Supabase, so this tracker works for this visit only and clears on reload.',
  unavailable: 'Saved subscriptions could not be loaded right now. This tracker works for this visit only and clears on reload.',
} as const;
const cycleLabel = { monthly: 'month', quarterly: 'quarter', annual: 'year' } as const;
function relative(daysAway: number) { return daysAway === 0 ? 'today' : daysAway === 1 ? 'tomorrow' : `in ${daysAway} days`; }
const detectedCadence = { weekly: 'week', monthly: 'month', quarterly: 'quarter', annual: 'year' } as const;
function dayNum(iso: string) { return Math.round(Date.parse(`${iso}T00:00:00Z`) / 86400000); }
function relativeFrom(today: string, iso: string) {
  const d = dayNum(iso) - dayNum(today);
  if (d === 0) return 'today'; if (d === 1) return 'tomorrow'; if (d === -1) return 'yesterday';
  return d > 0 ? `in ${d} days` : `${-d} days ago`;
}
function DetectedRow({ sub, today }: { sub: DetectedSubscription; today: string }) {
  return <li className="border-t border-border-subtle pt-3 flex flex-wrap gap-3 justify-between"><div><h3>{sub.merchant}</h3><p className="text-sm">{money(sub.typicalCents)} / {detectedCadence[sub.cadence]} · last charged {formatDate(sub.lastCharge)} · next expected {formatDate(sub.nextExpected)} ({relativeFrom(today, sub.nextExpected)})</p></div><p className="text-sm text-text-secondary">about {money(sub.monthlyCents)} / month</p></li>;
}
function DetectedCard({ detected }: { detected: DetectedLoad }) {
  const active = detected.state === 'ok' ? detected.subs.filter(s => s.status === 'active') : [];
  const lapsed = detected.state === 'ok' ? detected.subs.filter(s => s.status === 'lapsed') : [];
  const today = detected.state === 'ok' ? detected.today : '';
  return <section className={card} aria-label="Detected subscriptions" data-testid="procurement-detected" data-state={detected.state}>
    <h2 className="text-xl font-semibold">Detected subscriptions</h2>
    <p className="text-sm text-text-secondary">Recurring charges found in your Rocket Money ledger over the last 400 days. Read-only: Onyx never cancels or pays anything.</p>
    {detected.state === 'error' && <p role="alert" className="text-red-400">Couldn&apos;t read the ledger (code {detected.code}), so no subscriptions are shown. This is a failed query, not an empty ledger.</p>}
    {detected.state === 'empty' && <p>No ledger data yet. Subscriptions appear here after the daily Rocket Money import; nothing is invented in the meantime.</p>}
    {detected.state === 'ok' && (detected.subs.length === 0
      ? <p>The ledger was read but no recurring charges were found in it.</p>
      : <div className="space-y-4">
        <p>About {money(detected.total)} / month across {active.length} active subscription{active.length === 1 ? '' : 's'}.</p>
        {active.length > 0 && <ul className="space-y-3">{active.map(s => <DetectedRow key={`${s.merchant}|${s.cadence}`} sub={s} today={today} />)}</ul>}
        {lapsed.length > 0 && <details><summary className="cursor-pointer text-sm">{lapsed.length} lapsed (no recent charge)</summary><ul className="space-y-3 mt-3">{lapsed.map(s => <DetectedRow key={`${s.merchant}|${s.cadence}`} sub={s} today={today} />)}</ul></details>}
      </div>)}
  </section>;
}
export default function ProcurementClient({ detected }: { detected: DetectedLoad }) {
  const [examples, setExamples] = useState(false);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [commitment, setCommitment] = useState<Draft['commitment']>('one-time');
  const [showList, setShowList] = useState(false);
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [subError, setSubError] = useState('');
  const [subNotice, setSubNotice] = useState('');
  const [leadDays, setLeadDays] = useState(3);
  // 'checking' until the first load answers; 'saved' = table exists and rows persist; 'pending' = SQL not applied yet; 'unavailable' = the save API could not be reached.
  const [store, setStore] = useState<'checking' | 'saved' | 'pending' | 'unavailable'>('checking');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(SUBSCRIPTIONS_API, { cache: 'no-store' });
        const body = await res.json().catch(() => null);
        if (cancelled) return;
        if (res.ok && body && body.persisted === true && Array.isArray(body.subscriptions)) {
          setStore('saved');
          // Keep anything typed before the load finished (it has no id); replace only the previously loaded rows.
          setSubs(previous => [...(body.subscriptions as Subscription[]), ...previous.filter(sub => sub.id === undefined)]);
        } else setStore(body && body.setupPending === true ? 'pending' : 'unavailable');
      } catch { if (!cancelled) setStore('unavailable'); }
    })();
    return () => { cancelled = true; };
  }, []);
  // Only read the clock once there is something to show, so the server-rendered page (no subscriptions) never depends on the date.
  const today = subs.length ? isoFromLocalDate(new Date()) : '';
  const summary = subs.length ? summarizeSubscriptions(subs, today) : null;
  const prompts = subs.length ? reviewPrompts(subs, today) : [];
  const totals = draftTotals(drafts);
  const warnings = duplicateWarnings(drafts, subs);
  const listText = drafts.length ? preparedListText(drafts, subs) : '';
  function add(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
    try {
      if (drafts.length >= MAX_DRAFTS) throw new Error('This preview supports up to 20 drafts. Clear drafts to start again.');
      const draft = createDraft(String(data.get('item') ?? ''), String(data.get('merchant') ?? ''), String(data.get('amount') ?? ''), commitment);
      setDrafts(previous => [...previous, draft]); setError(''); setNotice('Draft added for this visit only. No order was placed.'); form.reset(); setCommitment('one-time');
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to add draft.'); setNotice(''); }
  }
  async function addSubscription(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
    try {
      if (subs.length >= MAX_SUBSCRIPTIONS) throw new Error('This preview tracks up to 30 subscriptions. Clear the list to start again.');
      const sub = createSubscription(String(data.get('subName') ?? ''), String(data.get('subAmount') ?? ''), String(data.get('subCycle') ?? ''), String(data.get('subRenews') ?? ''));
      setSubError('');
      if (store === 'saved') {
        setBusy(true);
        let failure = 'it could not be saved';
        try {
          const res = await fetch(SUBSCRIPTIONS_API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: sub.name, amount: (sub.cents / 100).toFixed(2), cycle: sub.cycle, renewsOn: sub.renewsOn }) });
          const body = await res.json().catch(() => null);
          if (res.ok && body && body.subscription) {
            setSubs(previous => [...previous, body.subscription as Subscription]); setSubNotice('Subscription saved. Nothing was contacted.'); form.reset(); setBusy(false); return;
          }
          if (body && body.setupPending === true) { setStore('pending'); failure = 'setup is pending'; }
          else if (body && typeof body.error === 'string') failure = body.error;
        } catch { /* network failure: fall through to the in-memory add */ }
        setBusy(false);
        setSubs(previous => [...previous, sub]); setSubNotice(`Subscription added for this visit only (${failure}). Nothing was contacted.`); form.reset(); return;
      }
      setSubs(previous => [...previous, sub]); setSubNotice('Subscription added for this visit only. Nothing was contacted.'); form.reset();
    } catch (e) { setSubError(e instanceof Error ? e.message : 'Unable to add subscription.'); setSubNotice(''); }
  }
  async function removeSubscription(sub: Subscription) {
    if (sub.id !== undefined && store === 'saved') {
      setBusy(true);
      try {
        const res = await fetch(`${SUBSCRIPTIONS_API}/${sub.id}`, { method: 'DELETE' });
        if (!res.ok && res.status !== 404) throw new Error('archive failed');
      } catch { setBusy(false); setSubError('Could not remove that subscription from your saved list. It is still saved.'); setSubNotice(''); return; }
      setBusy(false);
    }
    setSubs(previous => previous.filter(item => item !== sub)); setSubError(''); setSubNotice('Subscription removed from this list. Nothing was cancelled.');
  }
  async function clearSubscriptions() {
    if (store === 'saved' && subs.some(sub => sub.id !== undefined)) {
      setBusy(true);
      try {
        const res = await fetch(SUBSCRIPTIONS_API, { method: 'DELETE' });
        if (!res.ok) throw new Error('archive failed');
      } catch { setBusy(false); setSubError('Could not clear your saved list. Nothing was changed.'); setSubNotice(''); return; }
      setBusy(false);
    }
    setSubs([]); setSubNotice('All tracked subscriptions cleared.'); setSubError('');
  }
  function loadSynthetic() {
    const room = MAX_SUBSCRIPTIONS - subs.length;
    if (room < 4) { setSubError('Not enough room for the four synthetic examples. Clear the list first.'); return; }
    setSubs(previous => [...previous, ...syntheticSubscriptions(isoFromLocalDate(new Date()))]); setSubError(''); setSubNotice('Added four synthetic demo subscriptions. They are not yours and are never saved.');
  }
  function downloadReminders() {
    const url = URL.createObjectURL(new Blob([renewalReminderIcs(subs, today, leadDays)], { type: 'text/calendar;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'onyx-renewal-reminders.ics';
    document.body.appendChild(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    setSubNotice('Reminder file downloaded. Import it into your calendar yourself; nothing was sent anywhere.');
  }
  async function copyList() {
    try { await navigator.clipboard.writeText(listText); setNotice('Prepared list copied. No order was placed.'); }
    catch { setNotice('Copy is not available here. Select the list text and copy it by hand.'); }
  }
  return <main className="max-w-5xl mx-auto p-4 md:p-8 space-y-6">
    <header><p className="text-xs uppercase tracking-widest text-text-tertiary">Planning workspace</p><h1 data-testid="page-heading" className="text-3xl font-semibold mt-2">Procurement</h1><p className="text-text-secondary mt-2">Review subscriptions, plan orders, and evaluate purchases.</p></header>
    <DetectedCard detected={detected} />
    <section className={card} aria-label="Connection status"><h2 className="text-lg font-semibold">Disconnected preview</h2><p>No merchant accounts are connected. Onyx never buys, checks out or submits anything on a merchant site: it prepares lists and reminders for you to act on yourself. Order drafts stay in memory for this visit and disappear on reload; tracked subscriptions are saved to your Onyx account once the one-time Supabase setup has been applied (the note under Track subscriptions says which). Do not enter payment details, credentials, addresses, or sensitive information.</p><ul className="text-sm text-text-secondary"><li>Subscription providers: {CAPABILITIES.providers}</li><li>Orders: {CAPABILITIES.orders}</li><li>Recommendations: {CAPABILITIES.recommendations}</li><li>Tracking: {CAPABILITIES.tracking}</li><li>Reminders: {CAPABILITIES.reminders}</li></ul></section>
    <div className="grid md:grid-cols-2 gap-6">
      <section className={card}><h2 className="text-xl font-semibold">Subscriptions</h2><p className="text-text-secondary">No merchant or provider is connected, so nothing is managed from here. Subscriptions are detected from your ledger at the top of the page; you can also track them by hand in the next section.</p><button className={button} onClick={() => setExamples(value => !value)}>{examples ? 'Hide synthetic examples' : 'Show synthetic examples'}</button>{examples && <div className="space-y-3"><p className="text-xs uppercase">Synthetic examples, not your subscriptions</p>{EXAMPLES.map(example => <article className="border-t border-border-subtle pt-3" key={example.name}><h3>{example.name}</h3><p>{money(example.monthlyCents)} / month, illustrative</p><p className="text-sm text-text-secondary">{example.note}</p></article>)}</div>}<button className={button} disabled>Manage with provider (unavailable)</button></section>
      <section className={card}><h2 className="text-xl font-semibold">Purchase recommendations</h2><p>No personalized recommendations yet. Product search, current prices, availability, and account history are not connected.</p><ul className="list-disc pl-5 text-sm text-text-secondary space-y-2"><li>Start with the need and total budget.</li><li>Compare the full delivered price, recurring costs, and return terms.</li><li>Check existing subscriptions before adding a duplicate.</li></ul><p className="text-xs text-text-tertiary">These are planning tips, not researched product offers. The review prompts under Track subscriptions come only from what you type in.</p></section>
    </div>
    <section className={card}><h2 className="text-xl font-semibold">Track subscriptions</h2><p className="text-sm text-text-secondary">Type in what you pay for, see the monthly and yearly cost, and get a calendar reminder file before each renewal. This does not cancel, change or pay for anything.</p><p className="text-sm text-text-secondary" data-testid="procurement-persistence" data-state={store}>{persistenceNote[store]}</p>
      <form onSubmit={addSubscription} className="grid md:grid-cols-2 gap-4"><label>Subscription name<input className={field} name="subName" required maxLength={80}/></label><label>Price per cycle (USD)<input className={field} name="subAmount" inputMode="decimal" required placeholder="0.00"/></label><label>Billing cycle<select className={field} name="subCycle" defaultValue="monthly"><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="annual">Annual</option></select></label><label>Next renewal date<input className={field} name="subRenews" type="date" required/></label><button className={button} type="submit" disabled={busy}>Add subscription</button></form>
      {subError && <p role="alert" className="text-red-400">{subError}</p>}<p role="status">{subNotice}</p>
      <div className="flex flex-wrap gap-3"><button className={button} onClick={loadSynthetic}>Load synthetic demo subscriptions</button><button className={button} disabled={!subs.length || busy} onClick={clearSubscriptions}>Clear subscriptions</button></div>
      {summary ? <div className="space-y-4">
        <p>About {money(summary.monthlyCents)} / month, {money(summary.annualCents)} / year across {summary.count} tracked subscription{summary.count === 1 ? '' : 's'}. Entered by you; not synced from any provider.</p>
        <ul className="space-y-3">{summary.renewals.map((r, position) => <li className="border-t border-border-subtle pt-3 flex flex-wrap gap-3 justify-between" key={r.index}><div><h3>{r.sub.name}</h3><p className="text-sm">{money(r.sub.cents)} / {cycleLabel[r.sub.cycle]} · renews {formatDate(r.nextOn)} ({relative(r.daysAway)})</p></div><button className={button} disabled={busy} onClick={() => removeSubscription(r.sub)}>Remove subscription {position + 1}</button></li>)}</ul>
        {prompts.length > 0 && <div><h3 className="font-semibold">Worth a look</h3><ul className="list-disc pl-5 text-sm text-text-secondary space-y-1">{prompts.map((p, i) => <li key={i}>{p}</li>)}</ul></div>}
        <div className="flex flex-wrap items-end gap-3"><label className="text-sm">Remind me<select className={field} value={leadDays} onChange={e => setLeadDays(Number(e.target.value))}>{REMINDER_LEAD_DAYS.map(d => <option key={d} value={d}>{d} day{d === 1 ? '' : 's'} before</option>)}</select></label><button className={button} onClick={downloadReminders}>Download renewal reminders (.ics)</button></div>
      </div> : <p>No subscriptions tracked yet.</p>}
    </section>
    <section className={card}><h2 className="text-xl font-semibold">Plan an order</h2><p className="text-sm text-text-secondary">Create a draft, not a cart or a purchase. USD only in this preview. Include estimated taxes, shipping and required fees.</p><form onSubmit={add} className="grid md:grid-cols-2 gap-4"><label>Item or service<input className={field} name="item" required maxLength={120}/></label><label>Merchant<input className={field} name="merchant" required maxLength={120}/></label><label>Estimated total (USD)<input className={field} name="amount" inputMode="decimal" required placeholder="0.00"/></label><label htmlFor="commitment">Commitment<select aria-label="Commitment" id="commitment" className={field} value={commitment} onChange={e => setCommitment(e.target.value as Draft['commitment'])}><option value="one-time">One-time</option><option value="monthly">Monthly subscription</option></select></label><button className={button} type="submit">Add planning draft</button></form>{error && <p role="alert" className="text-red-400">{error}</p>}<p role="status">{notice}</p>
      {drafts.length === 0 ? <p>No planning drafts.</p> : <ul className="space-y-3">{drafts.map((draft, index) => <li className="border-t border-border-subtle pt-3 flex flex-wrap gap-3 justify-between" key={index}><div><h3>{draft.item}</h3><p className="text-sm">{draft.merchant} · {money(draft.totalCents)}{draft.commitment === 'monthly' ? ' / month' : ' one-time'} · Draft only</p></div><button className={button} onClick={() => { setDrafts(previous => previous.filter((_, i) => i !== index)); setNotice('Draft removed. No merchant was contacted.'); }}>Remove draft {index + 1}</button></li>)}</ul>}
      {drafts.length > 0 && <p className="text-sm">Estimated one-time: {money(totals.oneTimeCents)} · Recurring: {money(totals.monthlyCents)} / month</p>}
      {warnings.length > 0 && <ul className="list-disc pl-5 text-sm text-amber-300 space-y-1">{warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>}
      {drafts.length > 0 && showList && <pre aria-label="Prepared list" className="whitespace-pre-wrap rounded border border-border-subtle p-3 text-sm select-all">{listText}</pre>}
      <div className="flex flex-wrap gap-3"><button className={button} disabled>Place order (unavailable)</button><button className={button} disabled={!drafts.length} onClick={() => setShowList(value => !value)}>{showList ? 'Hide prepared list' : 'Show prepared list'}</button><button className={button} disabled={!drafts.length || !showList} onClick={copyList}>Copy prepared list</button><button className={button} disabled={!drafts.length} onClick={() => { setDrafts([]); setShowList(false); setNotice('All planning drafts cleared.'); setError(''); }}>Clear drafts</button></div>
    </section>
    <section className={card}><h2 className="text-lg font-semibold">Why execution is disabled</h2><ul className="list-disc pl-5 text-sm text-text-secondary">{executionReadiness().reasons.map(reason => <li key={reason}>{reason}</li>)}</ul><p className="text-sm">Planning never authorizes spending. Future execution must verify the exact merchant, total, currency, recurring commitment, delivery, payment method and terms on the server, and reject changed or expired approvals.</p></section>
  </main>;
}
