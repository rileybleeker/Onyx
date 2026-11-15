"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Clock, Package, Truck } from "lucide-react";
import {
  applyMark,
  groupOrders,
  itemsLabel,
  trackingUrl,
  type ClassifiedOrder,
  type MarkAction,
  type OrderMark,
} from "@/lib/online-orders";
import type { OrdersLoad } from "@/lib/online-orders-server";
import InfoHint from "@/components/InfoHint";
import { Part, PartGroup, PartGrid } from "@/components/personalize/PartGrid";
import type { PageLayout } from "@/lib/personalize-layout";

const panel = "rounded-2xl border border-border-default bg-surface-card p-5 sm:p-6";
const link = "text-xs text-accent underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-accent";
const button = "rounded-lg border border-border-default px-3 py-1.5 text-xs text-text-primary hover:bg-surface-elevated " +
  "disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-accent";
const SYNC_STALE_MS = 6 * 3_600_000;

function ago(iso: string, now: Date): string {
  const mins = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

/**
 * The /orders screen. `feed`: drawn as this page's section of the continuous scroll (app/orders/FeedSection.tsx):
 * the heading carries the feed's test id and the section ids get a prefix, so they never clash with the routed page.
 *
 * Personalize: each list panel is its own part, in two sections (Open orders, Delivered); a panel moves within its
 * section or into the other one. `layout` (routed page only) is the saved layout from the page's cookie, so the
 * server renders the saved arrangement and nothing moves after hydration.
 */
export default function OrdersClient({
  data,
  nowIso,
  feed = false,
  layout,
}: {
  data: OrdersLoad;
  nowIso: string;
  feed?: boolean;
  layout?: PageLayout;
}) {
  const idPrefix = feed ? "feed-orders-" : "";
  const [now, setNow] = useState(() => new Date(nowIso));
  const [marks, setMarks] = useState<OrderMark[]>(data.state === "ready" ? data.marks : []);
  const [saving, setSaving] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState<{ text: string; undoKey?: string; error?: boolean } | null>(null);

  useEffect(() => {
    setNow(new Date());
    const t = setInterval(() => setNow(new Date()), 5 * 60_000);
    return () => clearInterval(t);
  }, []);

  const orders = useMemo(() => (data.state === "ready" ? data.orders : []), [data]);
  const groups = useMemo(() => groupOrders(orders, marks, now), [orders, marks, now]);
  const byKey = useMemo(() => new Map(orders.map((o) => [o.key, o])), [orders]);

  // The latest marks, kept outside render so overlapping saves on different orders never undo each
  // other: a failed save restores only that order's marks.
  const marksRef = useRef(marks);
  const inFlight = useRef(new Set<string>());
  const commit = (fn: (cur: OrderMark[]) => OrderMark[]) => {
    marksRef.current = fn(marksRef.current);
    setMarks(marksRef.current);
  };

  async function act(key: string, action: MarkAction, message: string) {
    const order = byKey.get(key);
    if (!order || inFlight.current.has(key)) return;
    inFlight.current.add(key);
    const mine = (m: OrderMark) => order.aliases.includes(m.aliasKey);
    const prior = marksRef.current.filter(mine);
    commit((cur) => applyMark(cur, order, action, new Date().toISOString()));
    setSaving((s) => new Set(s).add(key));
    try {
      const res = await fetch(`/api/orders/${encodeURIComponent(key)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setNotice(action === "undo" ? { text: "Undone." } : { text: message, undoKey: key });
    } catch {
      commit((cur) => [...cur.filter((m) => !mine(m)), ...prior]);
      setNotice({ text: "Couldn't save that. Try again.", error: true });
    } finally {
      inFlight.current.delete(key);
      setSaving((s) => {
        const next = new Set(s);
        next.delete(key);
        return next;
      });
    }
  }

  const sync = data.state === "error" ? null : data.lastSync;
  const syncStale = !!sync && (now.getTime() - new Date(sync.at).getTime() > SYNC_STALE_MS || sync.status !== "success");

  function row(c: ClassifiedOrder, actions: "open" | "undo" | "none") {
    const o = c.order;
    const busy = saving.has(o.key);
    const links = o.tracking.map((t) => ({ t, href: trackingUrl(t) })).filter((x) => x.href);
    return (
      <li key={o.key} className="py-4">
        <p className="text-xs text-text-secondary">{o.merchant}{o.orderNumber ? ` · Order ${o.orderNumber}` : ""}</p>
        <p className="mt-1 break-words text-sm font-medium text-text-primary">{itemsLabel(o)}</p>
        <p className={`mt-1 text-xs ${c.state === "attention" ? "text-amber-300" : "text-text-secondary"}`}>{c.reason}</p>
        {(links.length > 0 || actions !== "none") && (
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
            {links.map(({ t, href }) => (
              <a key={t.number} href={href!} target="_blank" rel="noopener noreferrer" className={link}
                aria-label={`Track ${t.carrier ?? "package"} ${t.number}`}>
                Track{t.carrier ? ` (${t.carrier})` : ""}{t.delivered ? " · delivered" : ""}
              </a>
            ))}
            {actions === "open" && <>
              <button type="button" className={button} disabled={busy}
                onClick={() => act(o.key, "received", `Marked ${o.merchant} as arrived.`)}>Got it</button>
              <button type="button" className={button} disabled={busy}
                onClick={() => act(o.key, "hide", `Hid ${o.merchant}.`)}>Hide</button>
            </>}
            {actions === "undo" && (
              <button type="button" className={button} disabled={busy} onClick={() => act(o.key, "undo", "")}>Undo</button>
            )}
          </div>
        )}
      </li>
    );
  }

  function section(id: string, title: string, icon: ReactNode, list: ClassifiedOrder[], hint?: string) {
    if (!list.length) return null;
    return (
      <section className={panel} aria-labelledby={idPrefix + id}>
        <div className="flex items-center gap-2">{icon}
          <h2 id={idPrefix + id} className="text-lg font-medium text-text-primary">{title} <span className="text-text-secondary">({list.length})</span></h2>
        </div>
        {hint && <p className="mt-1 text-xs text-text-secondary">{hint}</p>}
        <ul className="mt-2 divide-y divide-border-subtle">
          {list.map((c) => row(c, "open"))}
        </ul>
      </section>
    );
  }

  const active = groups.attention.length + groups.arriving.length + groups.processing.length + groups.unconfirmed.length;
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <header>
        <div className="flex items-center gap-2">
          <h1 data-testid={feed ? "feed-page-heading" : "page-heading"} className="text-[30px] font-medium text-text-primary">Orders</h1>
          <InfoHint label="Orders">
            <p>Online orders from shipping and delivery emails (both Gmail accounts) and your Amazon order history, checked every 3 hours.</p>
            <p>Got it and Hide only change this page. Onyx never replies to, labels or marks these emails.</p>
          </InfoHint>
        </div>
        {sync && (
          <p className={`mt-2 text-xs ${syncStale ? "text-amber-300" : "text-text-secondary"}`}>
            Emails last checked {ago(sync.at, now)}{sync.status !== "success" ? ` (that run: ${sync.status})` : ""}
            {syncStale ? "; newer updates may be missing." : "."}
          </p>
        )}
      </header>
      <p role="status" aria-live="polite" className={notice?.error ? "text-sm text-red-400" : "text-sm text-text-secondary"}>
        {notice?.text}
        {notice?.undoKey && byKey.has(notice.undoKey) && (
          <button type="button" className={`${link} ml-3`} onClick={() => act(notice.undoKey!, "undo", "")}>Undo</button>
        )}
      </p>

      {data.state === "error" && <section className={panel}><p className="text-sm text-text-secondary">Couldn&apos;t load orders. Try again in a minute.</p></section>}
      {data.state === "not_connected" && (
        <section className={panel}><p className="text-sm text-text-primary">The order email sync hasn&apos;t run yet.</p>
          <p className="mt-1 text-xs text-text-secondary">Its first run reads the last 400 days of shipping emails.</p></section>
      )}
      {data.state === "ready" && orders.length === 0 && (
        <section className={panel}><p className="text-sm text-text-secondary">No orders in the last 120 days.</p></section>
      )}
      {data.state === "ready" && orders.length > 0 && active === 0 && (
        <section className={panel}><p className="text-sm text-text-secondary">Nothing on the way right now.</p></section>
      )}

      <PartGrid page="/orders" title="Orders" initial={layout} gap={20}>
        <PartGroup id="open" title="Open orders" gap={20}>
          {groups.attention.length > 0 && (
            <Part id="attention" title="Needs attention">
              {section("attention-heading", "Needs attention", <AlertTriangle aria-hidden="true" className="h-5 w-5 text-amber-300" />, groups.attention,
                "Late, a delivery problem, or not shipped after a week. If it arrived, tap Got it.")}
            </Part>
          )}
          {groups.arriving.length > 0 && (
            <Part id="arriving" title="On the way">
              {section("arriving-heading", "On the way", <Truck aria-hidden="true" className="h-5 w-5 text-accent" />, groups.arriving)}
            </Part>
          )}
          {groups.processing.length > 0 && (
            <Part id="processing" title="Ordered, not shipped yet">
              {section("processing-heading", "Ordered, not shipped yet", <Clock aria-hidden="true" className="h-5 w-5 text-accent" />, groups.processing)}
            </Part>
          )}
          {groups.unconfirmed.length > 0 && (
            <Part id="unconfirmed" title="No delivery email">
              {section("unconfirmed-heading", "No delivery email", <Package aria-hidden="true" className="h-5 w-5 text-text-secondary" />, groups.unconfirmed,
                "These stores don't email on delivery. Tap Got it once it's here.")}
            </Part>
          )}
        </PartGroup>

        <PartGroup id="delivered" title="Delivered" gap={20}>
          {groups.recent.length > 0 && (
            <Part id="recent" title="Delivered, last 30 days">
              <section className={panel} aria-labelledby={`${idPrefix}recent-heading`}>
                <div className="flex items-center gap-2"><CheckCircle2 aria-hidden="true" className="h-5 w-5 text-emerald-400" />
                  <h2 id={`${idPrefix}recent-heading`} className="text-lg font-medium text-text-primary">Delivered, last 30 days <span className="text-text-secondary">({groups.recent.length})</span></h2>
                </div>
                <ul className="mt-2 divide-y divide-border-subtle">
                  {groups.recent.map((c) => row(c, c.markedReceived ? "undo" : "none"))}
                </ul>
              </section>
            </Part>
          )}
        </PartGroup>
      </PartGrid>
    </div>
  );
}
