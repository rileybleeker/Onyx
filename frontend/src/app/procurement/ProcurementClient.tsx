"use client";
import { useState } from 'react';
import { CAPABILITIES, createDraft, executionReadiness, EXAMPLES, money, type Draft } from '@/lib/procurement';
const card = 'rounded-xl border border-border-subtle bg-surface-card p-5 space-y-4';
const field = 'block w-full rounded border border-border-subtle bg-transparent p-2 mt-1';
const button = 'rounded border border-border-subtle px-3 py-2 text-sm hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed';
export default function ProcurementClient() {
  const [examples, setExamples] = useState(false);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [commitment, setCommitment] = useState<Draft['commitment']>('one-time');
  function add(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
    try {
      if (drafts.length >= 20) throw new Error('This preview supports up to 20 drafts. Clear drafts to start again.');
      const draft = createDraft(String(data.get('item') ?? ''), String(data.get('merchant') ?? ''), String(data.get('amount') ?? ''), commitment);
      setDrafts(previous => [...previous, draft]); setError(''); setNotice('Draft added for this visit only. No order was placed.'); form.reset(); setCommitment('one-time');
    } catch (e) { setError(e instanceof Error ? e.message : 'Unable to add draft.'); setNotice(''); }
  }
  return <main className="max-w-5xl mx-auto p-4 md:p-8 space-y-6">
    <header><p className="text-xs uppercase tracking-widest text-text-tertiary">Planning workspace</p><h1 className="text-3xl font-semibold mt-2">Procurement</h1><p className="text-text-secondary mt-2">Review subscriptions, plan orders, and evaluate purchases.</p></header>
    <section className={card} aria-label="Connection status"><h2 className="text-lg font-semibold">Disconnected preview</h2><p>No accounts are connected. Orders and subscription changes are disabled. Drafts stay in memory for this visit and disappear on reload. Do not enter payment details, credentials, addresses, or sensitive information.</p><ul className="text-sm text-text-secondary"><li>Subscriptions: {CAPABILITIES.subscriptions}</li><li>Orders: {CAPABILITIES.orders}</li><li>Recommendations: {CAPABILITIES.recommendations}</li></ul></section>
    <div className="grid md:grid-cols-2 gap-6">
      <section className={card}><h2 className="text-xl font-semibold">Subscriptions</h2><p className="text-text-secondary">Renewals and monthly spending are unknown until a provider is connected. Nothing is synced from Financials.</p><button className={button} onClick={() => setExamples(value => !value)}>{examples ? 'Hide synthetic examples' : 'Show synthetic examples'}</button>{examples && <div className="space-y-3"><p className="text-xs uppercase">Synthetic examples, not your subscriptions</p>{EXAMPLES.map(example => <article className="border-t border-border-subtle pt-3" key={example.name}><h3>{example.name}</h3><p>{money(example.monthlyCents)} / month, illustrative</p><p className="text-sm text-text-secondary">{example.note}</p></article>)}</div>}<button className={button} disabled>Manage with provider (unavailable)</button></section>
      <section className={card}><h2 className="text-xl font-semibold">Purchase recommendations</h2><p>No personalized recommendations yet. Product search, current prices, availability, and account history are not connected.</p><ul className="list-disc pl-5 text-sm text-text-secondary space-y-2"><li>Start with the need and total budget.</li><li>Compare the full delivered price, recurring costs, and return terms.</li><li>Check existing subscriptions before adding a duplicate.</li></ul><p className="text-xs text-text-tertiary">These are planning tips, not researched product offers.</p></section>
    </div>
    <section className={card}><h2 className="text-xl font-semibold">Plan an order</h2><p className="text-sm text-text-secondary">Create a draft, not a cart or a purchase. USD only in this preview. Include estimated taxes, shipping and required fees.</p><form onSubmit={add} className="grid md:grid-cols-2 gap-4"><label>Item or service<input className={field} name="item" required maxLength={120}/></label><label>Merchant<input className={field} name="merchant" required maxLength={120}/></label><label>Estimated total (USD)<input className={field} name="amount" inputMode="decimal" required placeholder="0.00"/></label><label htmlFor="commitment">Commitment<select aria-label="Commitment" id="commitment" className={field} value={commitment} onChange={e => setCommitment(e.target.value as Draft['commitment'])}><option value="one-time">One-time</option><option value="monthly">Monthly subscription</option></select></label><button className={button} type="submit">Add planning draft</button></form>{error && <p role="alert" className="text-red-400">{error}</p>}<p role="status">{notice}</p>
      {drafts.length === 0 ? <p>No planning drafts.</p> : <ul className="space-y-3">{drafts.map((draft, index) => <li className="border-t border-border-subtle pt-3 flex flex-wrap gap-3 justify-between" key={index}><div><h3>{draft.item}</h3><p className="text-sm">{draft.merchant} · {money(draft.totalCents)}{draft.commitment === 'monthly' ? ' / month' : ' one-time'} · Draft only</p></div><button className={button} onClick={() => { setDrafts(previous => previous.filter((_, i) => i !== index)); setNotice('Draft removed. No merchant was contacted.'); }}>Remove draft {index + 1}</button></li>)}</ul>}
      <div className="flex flex-wrap gap-3"><button className={button} disabled>Place order (unavailable)</button><button className={button} disabled={!drafts.length} onClick={() => { setDrafts([]); setNotice('All planning drafts cleared.'); setError(''); }}>Clear drafts</button></div>
    </section>
    <section className={card}><h2 className="text-lg font-semibold">Why execution is disabled</h2><ul className="list-disc pl-5 text-sm text-text-secondary">{executionReadiness().reasons.map(reason => <li key={reason}>{reason}</li>)}</ul><p className="text-sm">Planning never authorizes spending. Future execution must verify the exact merchant, total, currency, recurring commitment, delivery, payment method and terms on the server, and reject changed or expired approvals.</p></section>
  </main>;
}
