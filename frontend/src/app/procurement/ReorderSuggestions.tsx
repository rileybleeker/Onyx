import type { ReorderLoad, ReorderSuggestion } from '@/lib/procurement-reorder';

// Purchase suggestions: items bought repeatedly and when they are usually reordered. Read-only:
// everything comes from the server-rendered `reorder` prop; this component makes no request and
// has no link, button or form: there is nowhere to buy anything from here.
const card = 'rounded-xl border border-border-subtle bg-surface-card p-5 space-y-4';
const statusWord = { due: 'Likely due', soon: 'Due soon', later: 'Not yet' } as const;
const statusStyle = { due: 'text-amber-300', soon: 'text-text-primary', later: 'text-text-secondary' } as const;

function Row({ s }: { s: ReorderSuggestion }) {
  return <li className="border-t border-border-subtle pt-3" data-testid="procurement-reorder-row" data-status={s.status}>
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h3 className="min-w-0 break-words">{s.item}</h3>
      <p className={`text-sm font-medium ${statusStyle[s.status]}`}>{statusWord[s.status]}</p>
    </div>
    <p className="text-sm text-text-secondary break-words">{s.reason}</p>
  </li>;
}

export default function ReorderSuggestions({ reorder }: { reorder: ReorderLoad }) {
  const ok = reorder.state === 'ok' ? reorder : null;
  const now = ok ? ok.suggestions.filter(s => s.status !== 'later') : [];
  const later = ok ? ok.suggestions.filter(s => s.status === 'later') : [];
  return <section className={card} aria-label="Purchase suggestions" data-testid="procurement-reorder" data-state={reorder.state}>
    <h2 className="text-xl font-semibold">Purchase suggestions</h2>
    <p className="text-sm text-text-secondary">Things you have ordered at least three times, with how often you usually reorder them, from the order history behind the Orders page (shipping emails and your Amazon order list; restaurant delivery is not included). Advice only: Onyx never orders anything and links to no cart.</p>
    {reorder.state === 'error' && <p role="alert" className="text-red-400">Couldn&apos;t read your order history (code {reorder.code}), so no suggestions are shown. This is a failed query, not an empty history.</p>}
    {reorder.state === 'not_connected' && <p>Order history is not set up yet, so there is nothing to suggest from.</p>}
    {reorder.state === 'empty' && <p>No orders with item names yet. Suggestions appear once the same item has been ordered three times.</p>}
    {ok && (ok.suggestions.length === 0
      ? <p>Your order history was read ({ok.orders} order{ok.orders === 1 ? '' : 's'} with item names) but nothing in it has been ordered three times yet.</p>
      : <div className="space-y-4">
        {now.length > 0
          ? <ul className="space-y-3" aria-label="Likely due or due soon">{now.map(s => <Row key={s.key} s={s} />)}</ul>
          : <p>Nothing you reorder is due yet.</p>}
        {later.length > 0 && <details><summary className="cursor-pointer text-sm">{later.length} repeat item{later.length === 1 ? '' : 's'} not due yet</summary><ul className="space-y-3 mt-3">{later.map(s => <Row key={s.key} s={s} />)}</ul></details>}
      </div>)}
    {ok && (ok.boughtTwice > 0 || ok.stopped > 0) && <p className="text-xs text-text-secondary">Left out: {[
      ok.boughtTwice > 0 ? `${ok.boughtTwice} item${ok.boughtTwice === 1 ? '' : 's'} ordered only twice (too few to estimate an interval)` : null,
      ok.stopped > 0 ? `${ok.stopped} not ordered for more than three times the usual interval (treated as stopped)` : null,
    ].filter(Boolean).join('; ')}.</p>}
    {ok && <p className="text-xs text-text-secondary">The interval is the median gap between orders of the same item; orders within 3 days of each other count once. &quot;Likely due&quot; starts at 90% of the interval, &quot;due soon&quot; at 70%. Item names come from order emails, which list at most five items per order, so an item can be missing from a large order.</p>}
  </section>;
}
