"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell, BellOff, CheckCheck, ChevronLeft, ChevronRight, Share, SquarePen } from "lucide-react";
import {
  agentsApi,
  AuthError,
  enablePush,
  pushState,
  refreshPushSubscription,
  registerServiceWorker,
  setBadge,
  type InboxItem,
  type InboxResponse,
  type PushState,
  type ThreadSummary,
} from "@/lib/agents-api";
import { agentInfo, Avatar, CardBody, CardButtons, listTime, parseUtc, settledLabel } from "./agent-ui";

// The Agents inbox, like the iPhone Messages list. "Unread" is everything that needs Riley: open cards (with their
// buttons, so most can be answered right here) and agent messages not read yet, filterable by agent. "All" is one
// conversation per agent.

export type InboxView = "unread" | "all";

const POLL_IDLE_MS = 5000;
const POLL_ACTIVE_MS = 1000;

function PushBanner({ state, onEnable, busy }: { state: PushState; onEnable: () => void; busy: boolean }) {
  if (state === "granted" || state === "unsupported") return null;
  if (state === "needs-install")
    return (
      <div className="mx-4 mt-2 rounded-[12px] bg-surface-raised border border-border-default px-3.5 py-2.5 text-[13px] text-text-secondary">
        To get notifications on iPhone, add Onyx to your Home Screen: tap <Share className="inline w-3.5 h-3.5 -mt-0.5" /> Share, then
        <span className="text-text-primary"> Add to Home Screen</span>, and open Onyx from there.
      </div>
    );
  if (state === "denied")
    return (
      <div className="mx-4 mt-2 rounded-[12px] bg-surface-raised border border-border-default px-3.5 py-2.5 text-[13px] text-text-secondary flex items-center gap-2">
        <BellOff className="w-4 h-4 shrink-0" /> Notifications are off. Turn them on in Settings → Notifications → Onyx.
      </div>
    );
  return (
    <button
      type="button"
      onClick={onEnable}
      disabled={busy}
      className="mx-4 mt-2 rounded-[12px] bg-accent-muted border border-border-emphasis px-3.5 py-2.5 text-[14px] text-accent font-medium flex items-center gap-2 disabled:opacity-60"
    >
      <Bell className="w-4 h-4" /> {busy ? "Turning on…" : "Turn on notifications so agents can reach you"}
    </button>
  );
}

function threadHref(thread: string, opts: { messageId?: number; reply?: string } = {}): string {
  const p = new URLSearchParams({ t: thread });
  if (opts.reply) p.set("reply", opts.reply);
  return `/agents?${p}${opts.messageId ? `#m${opts.messageId}` : ""}`;
}

function UnreadCard({ item, sent, onSend }: { item: Extract<InboxItem, { kind: "card" }>; sent: string | undefined; onSend: (text: string) => void }) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const { card } = item;
  return (
    <div className="mx-3 rounded-[16px] bg-surface-card border border-border-default overflow-hidden">
      <button type="button" onClick={() => router.push(threadHref(item.thread, { messageId: item.messageId }))} className="w-full flex items-center gap-2.5 px-4 pt-3 text-left">
        <Avatar thread={item.thread} size={26} />
        <span className="text-[13px] font-semibold text-text-primary">{agentInfo(item.thread).name}</span>
        <span className="text-[12px] text-text-tertiary">
          {card.type}
          {card.updated ? " · updated" : ""}
        </span>
        <span className="ml-auto text-[12px] text-text-tertiary">{listTime(parseUtc(item.created_at))}</span>
      </button>
      <div className="px-4 pt-2 pb-3" onClick={() => setExpanded((e) => !e)}>
        <CardBody card={card} clamp={!expanded} />
      </div>
      <CardButtons
        card={card}
        settled={settledLabel(sent, undefined)}
        onSend={onSend}
        onReply={(code) => router.push(threadHref(item.thread, { messageId: item.messageId, reply: code }))}
      />
    </div>
  );
}

function UnreadMessage({ item, typing }: { item: Extract<InboxItem, { kind: "message" }>; typing: boolean }) {
  return (
    <Link href={threadHref(item.thread, { messageId: item.messageId })} className="mx-3 block rounded-[16px] bg-surface-card border border-border-default px-4 py-3 active:bg-surface-hover">
      <div className="flex items-center gap-2.5">
        <Avatar thread={item.thread} size={26} />
        <span className="text-[13px] font-semibold text-text-primary">{agentInfo(item.thread).name}</span>
        <span className="w-2 h-2 rounded-full bg-accent" aria-label="Unread" />
        <span className="ml-auto text-[12px] text-text-tertiary">{listTime(parseUtc(item.created_at))}</span>
      </div>
      <p className="mt-2 text-[14px] text-text-secondary leading-relaxed line-clamp-4 whitespace-pre-line">{typing ? "typing…" : item.body}</p>
    </Link>
  );
}

function ConversationRow({ t, typing }: { t: ThreadSummary; typing: boolean }) {
  const waiting = t.open + t.unread;
  return (
    <Link href={threadHref(t.id)} className="flex items-center gap-3 pl-2 pr-4 active:bg-surface-hover">
      <span className={`w-2 h-2 rounded-full shrink-0 ${waiting ? "bg-accent" : "bg-transparent"}`} aria-label={waiting ? "Unread" : undefined} />
      <Avatar thread={t.id} size={48} />
      <div className="min-w-0 flex-1 py-3 border-b border-border-subtle">
        <div className="flex items-center gap-2">
          <span className={`text-[16px] truncate ${waiting ? "font-semibold text-text-primary" : "font-medium text-text-primary"}`}>{agentInfo(t.id).name}</span>
          <span className="ml-auto text-[13px] text-text-tertiary shrink-0">{t.last.id ? listTime(parseUtc(t.last.created_at)) : ""}</span>
          <ChevronRight className="w-4 h-4 text-text-tertiary shrink-0" />
        </div>
        <p className="mt-0.5 text-[14px] text-text-secondary leading-snug line-clamp-2">{typing ? "typing…" : t.last.preview}</p>
        {t.open > 0 && <p className="mt-1 text-[12px] text-accent font-medium">{t.open === 1 ? "1 needs you" : `${t.open} need you`}</p>}
      </div>
    </Link>
  );
}

export default function AgentsInbox({ initialView }: { initialView: InboxView | null }) {
  const router = useRouter();
  const [data, setData] = useState<InboxResponse | null>(null);
  const [view, setView] = useState<InboxView>(initialView ?? "unread");
  const [filter, setFilter] = useState<string | null>(null);
  const [sent, setSent] = useState<Record<string, string>>({}); // card code -> what Riley tapped, until the server agrees
  const [error, setError] = useState<string | null>(null);
  const [authExpired, setAuthExpired] = useState(false);
  const [push, setPush] = useState<PushState>("unsupported");
  const [pushBusy, setPushBusy] = useState(false);
  const activeUntilRef = useRef(0);
  const viewChosenRef = useRef(initialView !== null);

  const load = useCallback(async () => {
    try {
      const res = await agentsApi.inbox();
      setData(res);
      setBadge(res.badge);
      setError(null);
      // First open with nothing waiting: show the conversations instead of an empty list.
      if (!viewChosenRef.current) {
        viewChosenRef.current = true;
        if (res.items.length === 0) setView("all");
      }
    } catch (e) {
      if (e instanceof AuthError) setAuthExpired(true);
      else setError("Can't reach the agents right now. Retrying…");
    }
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === "visible") await load();
      timer = setTimeout(tick, Date.now() < activeUntilRef.current ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    };
    tick();
    const wake = () => {
      if (document.visibilityState !== "visible") return;
      clearTimeout(timer);
      tick();
    };
    const onSwMessage = (e: MessageEvent) => e.data?.type === "onyx-push" && wake();
    document.addEventListener("visibilitychange", wake);
    navigator.serviceWorker?.addEventListener("message", onSwMessage);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
      navigator.serviceWorker?.removeEventListener("message", onSwMessage);
    };
  }, [load]);

  useEffect(() => {
    setPush(pushState());
    registerServiceWorker().then(() => refreshPushSubscription());
  }, []);

  function choose(v: InboxView) {
    viewChosenRef.current = true;
    setView(v);
    router.replace(`/agents?view=${v}`, { scroll: false });
  }

  async function sendFromCard(text: string, thread: string) {
    const code = text.split(/\s+/)[0].toUpperCase();
    const reply = text.slice(code.length).trim();
    setSent((s) => ({ ...s, [code]: reply }));
    activeUntilRef.current = Date.now() + 10_000;
    try {
      await agentsApi.send(text, thread);
      setTimeout(load, 1200);
    } catch (e) {
      setSent((s) => {
        const next = { ...s };
        delete next[code];
        return next;
      });
      if (e instanceof AuthError) setAuthExpired(true);
      else setError("That didn't go through. Try again.");
    }
  }

  async function markAllRead() {
    const top = Math.max(0, ...(data?.threads.map((t) => t.last.id) ?? []));
    if (!top) return;
    try {
      const { badge } = await agentsApi.read(top, { all: true });
      setBadge(badge);
      load();
    } catch (e) {
      if (e instanceof AuthError) setAuthExpired(true);
    }
  }

  async function turnOnPush() {
    setPushBusy(true);
    try {
      setPush(await enablePush());
    } catch {
      setError("Couldn't turn on notifications. Try again in a moment.");
    } finally {
      setPushBusy(false);
    }
  }

  const items = useMemo(() => data?.items ?? [], [data]);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of items) m.set(i.thread, (m.get(i.thread) || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [items]);
  const activeFilter = filter && counts.some(([t]) => t === filter) ? filter : null;
  const shown = activeFilter ? items.filter((i) => i.thread === activeFilter) : items;
  const unreadMessages = items.filter((i) => i.kind === "message").length;

  const threads = useMemo(() => {
    const list = data?.threads ?? [];
    // Onyx (the general assistant) is always there to start a conversation with.
    if (!list.some((t) => t.id === "onyx")) return [...list, { id: "onyx", last: { id: 0, role: "assistant" as const, preview: "Ask anything: reminders, what the agents are doing, new tasks.", created_at: "" }, unread: 0, open: 0 }];
    return list;
  }, [data]);

  return (
    <div className="fixed inset-0 z-30 md:left-[220px] flex flex-col bg-surface">
      <header className="shrink-0 bg-surface/95 backdrop-blur pt-[env(safe-area-inset-top)]">
        <div className="h-11 px-2 flex items-center">
          <Link href="/sleep" className="md:hidden w-10 h-10 flex items-center justify-center text-accent" aria-label="Back to Onyx">
            <ChevronLeft className="w-6 h-6" />
          </Link>
          <div className="ml-auto flex items-center">
            {view === "unread" && unreadMessages > 0 && (
              <button type="button" onClick={markAllRead} className="h-10 px-2 text-[15px] text-accent">
                Mark all read
              </button>
            )}
            {push === "default" && (
              <button type="button" onClick={turnOnPush} className="w-10 h-10 flex items-center justify-center text-text-secondary" aria-label="Turn on notifications">
                <Bell className="w-5 h-5" />
              </button>
            )}
            <Link href={threadHref("onyx")} className="w-10 h-10 flex items-center justify-center text-accent" aria-label="New message">
              <SquarePen className="w-5 h-5" />
            </Link>
          </div>
        </div>
        <div className="max-w-3xl mx-auto w-full px-4">
          <h1 className="text-[30px] font-bold text-text-primary leading-tight">Agents</h1>
          <div className="mt-2 grid grid-cols-2 p-0.5 rounded-[9px] bg-surface-raised border border-border-subtle text-[14px] font-medium" role="tablist">
            {(["unread", "all"] as const).map((v) => (
              <button
                key={v}
                type="button"
                role="tab"
                aria-selected={view === v}
                onClick={() => choose(v)}
                className={`h-8 rounded-[7px] transition-colors ${view === v ? "bg-surface-hover text-text-primary shadow-elevated" : "text-text-secondary"}`}
              >
                {v === "unread" ? `Unread${items.length ? ` (${items.length})` : ""}` : "All"}
              </button>
            ))}
          </div>
        </div>
        {view === "unread" && counts.length > 1 && (
          <div className="max-w-3xl mx-auto w-full flex gap-2 overflow-x-auto px-4 py-2.5 [scrollbar-width:none]">
            {[["", items.length] as [string, number], ...counts].map(([t, n]) => {
              const on = (t || null) === activeFilter;
              return (
                <button
                  key={t || "all"}
                  type="button"
                  onClick={() => setFilter(t || null)}
                  className={`shrink-0 h-8 px-3 rounded-full border text-[13px] font-medium whitespace-nowrap transition-colors ${
                    on ? "bg-accent text-surface border-accent" : "bg-surface-card text-text-secondary border-border-default"
                  }`}
                >
                  {t ? agentInfo(t).name : "All"} <span className={on ? "opacity-70" : "text-text-tertiary"}>{n}</span>
                </button>
              );
            })}
          </div>
        )}
        <div className="h-px bg-border-subtle" />
      </header>

      <PushBanner state={push} onEnable={turnOnPush} busy={pushBusy} />

      <div className="flex-1 overflow-y-auto overscroll-contain pb-[max(16px,env(safe-area-inset-bottom))]">
        <div className="max-w-3xl mx-auto">
          {!data && !authExpired && <p className="text-center text-[13px] text-text-tertiary mt-10">Loading…</p>}

          {data && view === "unread" && shown.length === 0 && (
            <div className="text-center mt-20 px-8">
              <CheckCheck className="w-10 h-10 text-accent mx-auto" />
              <p className="mt-3 text-[17px] font-semibold text-text-primary">You&apos;re all caught up</p>
              <p className="mt-1 text-[14px] text-text-tertiary">Nothing from your agents needs you right now.</p>
              <button type="button" onClick={() => choose("all")} className="mt-5 text-[15px] text-accent font-medium">
                See all conversations
              </button>
            </div>
          )}

          {data && view === "unread" && shown.length > 0 && (
            <div className="flex flex-col gap-2.5 pt-3">
              {shown.map((i) =>
                i.kind === "card" ? (
                  <UnreadCard key={`c${i.card.code}`} item={i} sent={sent[i.card.code.toUpperCase()]} onSend={(text) => sendFromCard(text, i.thread)} />
                ) : (
                  <UnreadMessage key={`m${i.messageId}`} item={i} typing={data.typing === i.thread} />
                )
              )}
            </div>
          )}

          {data && view === "all" && (
            <div className="pt-1">
              {threads.map((t) => (
                <ConversationRow key={t.id} t={t} typing={data.typing === t.id} />
              ))}
            </div>
          )}

          {(error || authExpired) && (
            <p className="text-center text-[12px] text-text-tertiary mt-6 px-4">
              {authExpired ? (
                <>
                  Your session expired.{" "}
                  <Link href="/login?next=/agents" className="text-accent">
                    Sign in again
                  </Link>
                </>
              ) : (
                error
              )}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
