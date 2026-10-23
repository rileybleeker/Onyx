"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUp, Bell, ChevronLeft, RotateCw } from "lucide-react";
import {
  agentsApi,
  AuthError,
  enablePush,
  pushState,
  setBadge,
  type AgentCard,
  type AgentMessage,
  type CardState,
  type PushState,
} from "@/lib/agents-api";
import { agentInfo, Avatar, CardBody, CardButtons, dayLabel, Linkified, parseUtc, settledLabel, timeLabel } from "./agent-ui";

// One conversation in the Agents inbox: an agent (its cards, its notes, Riley's replies), the morning briefing, or
// Onyx, the general assistant. Behaves like a Messages thread: optimistic sends, typing indicator, pinned composer
// that rides the iOS keyboard. Free text typed here reaches the assistant with this conversation as context.

type Pending = { key: string; text: string; failed: boolean };

const POLL_IDLE_MS = 4000;
const POLL_ACTIVE_MS = 1000;
const ACTIVE_WINDOW_MS = 90_000;

/** Riley's latest reply per card code ("A12 yes" → A12), with the message id it was sent in (pending = Infinity). */
function repliesByCode(messages: AgentMessage[], pending: Pending[]): Map<string, { text: string; id: number }> {
  const map = new Map<string, { text: string; id: number }>();
  const sent = [
    ...messages.filter((m) => m.role === "user").map((m) => ({ t: m.body, id: m.id })),
    ...pending.filter((p) => !p.failed).map((p) => ({ t: p.text, id: Infinity })),
  ];
  for (const { t, id } of sent) {
    const m = t.trim().match(/^(A\d+)\b[\s:,.-]*([\s\S]*)$/i);
    if (m) map.set(m[1].toUpperCase(), { text: m[2].trim(), id });
  }
  return map;
}

function CardBubble({ card, settled, onSend, onReply }: { card: AgentCard; settled: string | null; onSend: (t: string) => void; onReply: (code: string) => void }) {
  return (
    <div className="w-full max-w-[85%] md:max-w-[460px] rounded-[18px] rounded-bl-[6px] bg-surface-raised border border-border-default overflow-hidden">
      <div className="px-4 pt-3 pb-3">
        <div className="mb-1.5 flex items-center gap-2 text-[11px] uppercase tracking-wide text-text-tertiary">
          <span className="font-mono text-text-secondary">{card.code}</span>
          <span>·</span>
          <span>{card.type}</span>
          {card.updated && <span className="ml-auto text-mid normal-case tracking-normal">updated</span>}
        </div>
        <CardBody card={card} />
      </div>
      <CardButtons card={card} settled={settled} onSend={onSend} onReply={onReply} />
    </div>
  );
}

function TypingBubble() {
  return (
    <div className="flex justify-start px-3">
      <div className="rounded-[18px] rounded-bl-[6px] bg-surface-raised border border-border-subtle px-4 py-3 flex gap-1" aria-label="Typing">
        {[0, 1, 2].map((i) => (
          <span key={i} className="w-2 h-2 rounded-full bg-text-tertiary animate-bounce" style={{ animationDelay: `${i * 150}ms`, animationDuration: "1s" }} />
        ))}
      </div>
    </div>
  );
}

export default function AgentsChat({ thread, reply }: { thread: string; reply?: string | null }) {
  const info = agentInfo(thread);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [cardStates, setCardStates] = useState<Record<string, CardState>>({});
  const [pending, setPending] = useState<Pending[]>([]);
  const [typing, setTyping] = useState(false);
  const [input, setInput] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authExpired, setAuthExpired] = useState(false);
  const [push, setPush] = useState<PushState>("unsupported");
  const [hasOlder, setHasOlder] = useState(true);
  const [viewport, setViewport] = useState<{ top: number; height: number } | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const lastIdRef = useRef(0);
  const activeUntilRef = useRef(0);
  const stickToBottomRef = useRef(true);
  const lastReadSentRef = useRef(0);
  const jumpedRef = useRef(false);

  // ---- viewport: keep the composer above the iOS keyboard ----
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setViewport({ top: vv.offsetTop, height: vv.height });
    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  // Lock the page behind the chat so iOS does not rubber-band the whole app.
  useEffect(() => {
    const html = document.documentElement;
    const prev = [html.style.overflow, document.body.style.overflow];
    html.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    return () => {
      html.style.overflow = prev[0];
      document.body.style.overflow = prev[1];
    };
  }, []);

  const scrollToBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: smooth ? "smooth" : "auto" });
  }, []);

  const merge = useCallback((incoming: AgentMessage[]) => {
    if (!incoming.length) return;
    setMessages((prev) => {
      const seen = new Set(prev.map((m) => m.id));
      const add = incoming.filter((m) => !seen.has(m.id));
      if (!add.length) return prev;
      const next = [...prev, ...add].sort((a, b) => a.id - b.id);
      lastIdRef.current = next[next.length - 1].id;
      return next;
    });
  }, []);

  const markRead = useCallback(() => {
    const id = lastIdRef.current;
    if (document.visibilityState !== "visible" || !id || id <= lastReadSentRef.current) return;
    lastReadSentRef.current = id;
    agentsApi
      .read(id, { thread })
      .then(({ badge }) => setBadge(badge))
      .catch(() => {});
  }, [thread]);

  const handleError = useCallback((e: unknown) => {
    if (e instanceof AuthError) setAuthExpired(true);
    else setError("Can't reach the agents right now. Retrying…");
  }, []);

  const poll = useCallback(async () => {
    try {
      const res = await agentsApi.messages({ thread, after: lastIdRef.current || undefined, limit: lastIdRef.current ? 100 : 60 });
      if (!lastIdRef.current && res.messages.length < 60) setHasOlder(false);
      merge(res.messages);
      if (res.cardStates) setCardStates(res.cardStates);
      setTyping(res.typing);
      if (res.typing) activeUntilRef.current = Math.max(activeUntilRef.current, Date.now() + 15_000);
      setError(null);
      setLoaded(true);
    } catch (e) {
      handleError(e);
      setLoaded(true);
    }
  }, [merge, handleError, thread]);

  // ---- polling loop: fast right after a send, slow when idle, paused in the background ----
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === "visible") await poll();
      const fast = Date.now() < activeUntilRef.current;
      timer = setTimeout(tick, fast ? POLL_ACTIVE_MS : POLL_IDLE_MS);
    };
    tick();
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        clearTimeout(timer);
        tick();
      }
    };
    const onSwMessage = (e: MessageEvent) => {
      if (e.data?.type === "onyx-push") {
        clearTimeout(timer);
        tick();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    navigator.serviceWorker?.addEventListener("message", onSwMessage);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
      navigator.serviceWorker?.removeEventListener("message", onSwMessage);
    };
  }, [poll]);

  useEffect(() => {
    setPush(pushState());
  }, []);

  // Opened from a card's Reply button: start the answer for that card.
  useEffect(() => {
    if (reply && /^A\d+$/i.test(reply)) replyTo(reply.toUpperCase());
  }, [reply]);

  // ---- scroll behaviour ----
  useLayoutEffect(() => {
    // Opened from a notification or the Unread list (#m123): show that message once, then behave normally.
    if (!jumpedRef.current && loaded && messages.length) {
      jumpedRef.current = true;
      const target = window.location.hash.startsWith("#m") ? document.getElementById(window.location.hash.slice(1)) : null;
      if (target) {
        target.scrollIntoView({ block: "center" });
        target.classList.add("animate-pulse");
        setTimeout(() => target.classList.remove("animate-pulse"), 1600);
        const el = scrollRef.current;
        stickToBottomRef.current = !!el && el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        markRead();
        return;
      }
    }
    if (stickToBottomRef.current) scrollToBottom(loaded && messages.length > 0);
    markRead();
  }, [messages, pending, typing, loaded, scrollToBottom, markRead]);

  useEffect(() => {
    if (stickToBottomRef.current) scrollToBottom();
  }, [viewport?.height, scrollToBottom]);

  async function loadOlder() {
    const first = messages[0];
    if (!first || !hasOlder) return;
    const el = scrollRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    try {
      const res = await agentsApi.messages({ thread, before: first.id, limit: 60 });
      if (res.messages.length < 60) setHasOlder(false);
      setMessages((prev) => {
        const seen = new Set(prev.map((m) => m.id));
        return [...res.messages.filter((m) => !seen.has(m.id)), ...prev];
      });
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - prevHeight;
      });
    } catch (e) {
      handleError(e);
    }
  }

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 40 && hasOlder && loaded) loadOlder();
  }

  async function send(text: string, retryKey?: string) {
    const body = text.trim();
    if (!body) return;
    const key = retryKey ?? `p${Date.now()}${Math.random()}`;
    setPending((p) => (retryKey ? p.map((x) => (x.key === key ? { ...x, failed: false } : x)) : [...p, { key, text: body, failed: false }]));
    stickToBottomRef.current = true;
    activeUntilRef.current = Date.now() + ACTIVE_WINDOW_MS;
    setTyping(true);
    try {
      const { message } = await agentsApi.send(body, thread);
      merge([message]);
      setPending((p) => p.filter((x) => x.key !== key));
    } catch (e) {
      setTyping(false);
      setPending((p) => p.map((x) => (x.key === key ? { ...x, failed: true } : x)));
      if (e instanceof AuthError) setAuthExpired(true);
    }
  }

  function submit() {
    const text = input;
    if (!text.trim()) return;
    setInput("");
    send(text);
    inputRef.current?.focus();
  }

  function replyTo(code: string) {
    setInput(`${code} `);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    });
  }

  async function turnOnPush() {
    try {
      setPush(await enablePush());
    } catch {
      setError("Couldn't turn on notifications. Try again in a moment.");
    }
  }

  // Auto-grow the composer up to ~5 lines.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 132)}px`;
  }, [input]);

  const replies = useMemo(() => repliesByCode(messages, pending), [messages, pending]);
  // A card shown again later (UPDATED, or re-sent) is answered on its newest copy; older copies just point down.
  const newestCopy = useMemo(() => {
    const m = new Map<string, number>();
    for (const msg of messages) for (const c of msg.cards ?? []) m.set(c.code.toUpperCase(), msg.id);
    return m;
  }, [messages]);
  const cardsHere = (m: AgentMessage): AgentCard[] => {
    const mine = (m.cards ?? []).filter((c) => c.agent === thread);
    return mine.length ? mine : m.cards ?? [];
  };
  const keyboardOpen = viewport ? viewport.height < window.innerHeight - 120 : false;

  // Group into day sections and runs of the same sender.
  const rows = useMemo(() => {
    type Row = { kind: "day"; label: string; key: string } | { kind: "msg"; m: AgentMessage; first: boolean; last: boolean; key: string };
    const list: Row[] = [];
    let lastDay = "";
    messages.forEach((m, i) => {
      const d = parseUtc(m.created_at);
      const label = dayLabel(d);
      if (label !== lastDay) {
        list.push({ kind: "day", label, key: `d${m.id}` });
        lastDay = label;
      }
      const prev = messages[i - 1];
      const next = messages[i + 1];
      const gap = (a?: AgentMessage, b?: AgentMessage) => !a || !b || a.role !== b.role || Math.abs(parseUtc(a.created_at).getTime() - parseUtc(b.created_at).getTime()) > 5 * 60_000 || dayLabel(parseUtc(a.created_at)) !== dayLabel(parseUtc(b.created_at));
      list.push({ kind: "msg", m, first: gap(prev, m), last: gap(m, next), key: `m${m.id}` });
    });
    return list;
  }, [messages]);

  return (
    <div
      className="fixed inset-x-0 z-30 md:left-[220px] flex flex-col bg-surface"
      style={viewport ? { top: viewport.top, height: viewport.height } : { top: 0, bottom: 0 }}
    >
      {/* Header */}
      <header className="shrink-0 bg-surface-card/95 backdrop-blur border-b border-border-subtle pt-[env(safe-area-inset-top)] md:pt-0">
        <div className="h-14 px-2 flex items-center gap-2">
          <Link href="/agents" className="w-10 h-10 flex items-center justify-center text-accent" aria-label="Back to Agents">
            <ChevronLeft className="w-6 h-6" />
          </Link>
          <Avatar thread={thread} size={36} />
          <div className="min-w-0">
            <p className="text-[15px] font-semibold text-text-primary leading-tight truncate">{info.name}</p>
            <p className="text-[12px] text-text-tertiary leading-tight truncate">{typing ? "typing…" : info.about}</p>
          </div>
          {push === "default" && (
            <button type="button" onClick={turnOnPush} className="ml-auto w-10 h-10 flex items-center justify-center text-text-secondary" aria-label="Turn on notifications">
              <Bell className="w-5 h-5" />
            </button>
          )}
        </div>
      </header>

      {/* Thread */}
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 overflow-y-auto overscroll-contain py-3" role="log" aria-live="polite">
        <div className="max-w-3xl mx-auto flex flex-col gap-[3px]">
          {!loaded && <p className="text-center text-[13px] text-text-tertiary mt-10">Loading…</p>}
          {loaded && messages.length === 0 && pending.length === 0 && (
            <div className="text-center mt-16 px-8">
              <p className="text-[15px] text-text-secondary">{thread === "onyx" ? "Ask anything." : `${info.name} will write here.`}</p>
              <p className="mt-1 text-[13px] text-text-tertiary">
                {thread === "onyx" ? "e.g. \u201cwhat\u2019s on today?\u201d or \u201chave the agents find a dentist near me\u201d" : "Anything you type here goes to it, with its open items as context."}
              </p>
            </div>
          )}
          {rows.map((r) =>
            r.kind === "day" ? (
              <div key={r.key} className="text-center text-[11px] font-medium text-text-tertiary my-3">
                {r.label}
              </div>
            ) : (
              <div key={r.key} id={`m${r.m.id}`} className={`px-3 flex flex-col ${r.m.role === "user" ? "items-end" : "items-start"} ${r.first ? "mt-2" : ""} gap-[3px]`}>
                {(!r.m.cards || r.m.role === "user") && (
                  <div
                    className={`max-w-[80%] md:max-w-[560px] px-3.5 py-2 text-[15px] leading-[1.35] whitespace-pre-wrap break-words ${
                      r.m.role === "user"
                        ? `bg-accent text-surface rounded-[18px] ${r.last ? "rounded-br-[6px]" : ""}`
                        : `bg-surface-raised text-text-primary border border-border-subtle rounded-[18px] ${r.last ? "rounded-bl-[6px]" : ""}`
                    }`}
                  >
                    <Linkified text={r.m.body} />
                  </div>
                )}
                {r.m.role === "assistant" && r.m.cards && (
                  <>
                    {cardsHere(r.m).map((c) => {
                      const code = c.code.toUpperCase();
                      if ((newestCopy.get(code) ?? r.m.id) > r.m.id)
                        return (
                          <div key={c.code} className="max-w-[80%] px-3.5 py-2 text-[13px] text-text-tertiary bg-surface-card border border-border-subtle rounded-[18px]">
                            <span className="font-mono">{c.code}</span> {c.name} · newer version below
                          </div>
                        );
                      // A reply counts only if sent after this copy of the card (an UPDATED card needs a fresh answer).
                      const mine = replies.get(code);
                      const replied = mine && mine.id > r.m.id ? mine.text : undefined;
                      const state = cardStates[code];
                      const settled = settledLabel(replied, state && state !== "open" ? state : undefined);
                      return <CardBubble key={c.code} card={c} settled={settled} onSend={(t) => send(t)} onReply={replyTo} />;
                    })}
                  </>
                )}
                {r.last && <span className="text-[11px] text-text-tertiary px-1">{timeLabel(parseUtc(r.m.created_at))}</span>}
              </div>
            )
          )}
          {pending.map((p) => (
            <div key={p.key} className="px-3 flex flex-col items-end mt-2 gap-[3px]">
              <div className={`max-w-[80%] md:max-w-[560px] px-3.5 py-2 text-[15px] leading-[1.35] whitespace-pre-wrap break-words rounded-[18px] rounded-br-[6px] bg-accent text-surface ${p.failed ? "opacity-50" : "opacity-80"}`}>
                {p.text}
              </div>
              {p.failed ? (
                <button type="button" onClick={() => send(p.text, p.key)} className="text-[12px] text-down inline-flex items-center gap-1 px-1">
                  <RotateCw className="w-3 h-3" /> Not delivered. Tap to retry
                </button>
              ) : (
                <span className="text-[11px] text-text-tertiary px-1">Sending…</span>
              )}
            </div>
          ))}
          {typing && (
            <div className="mt-2">
              <TypingBubble />
            </div>
          )}
        </div>
      </div>

      {(error || authExpired) && (
        <div className="shrink-0 px-3 pb-1 text-center text-[12px] text-text-tertiary">
          {authExpired ? (
            <>
              Your session expired.{" "}
              <Link href="/login" className="text-accent">
                Sign in again
              </Link>
            </>
          ) : (
            error
          )}
        </div>
      )}

      {/* Composer */}
      <div
        className="shrink-0 border-t border-border-subtle bg-surface-card/95 backdrop-blur px-2 pt-2"
        style={{ paddingBottom: keyboardOpen ? 8 : "max(8px, env(safe-area-inset-bottom))" }}
      >
        <form
          className="max-w-3xl mx-auto flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // Desktop: Enter sends, Shift+Enter is a newline. Touch keyboards keep Return as a newline.
              if (e.key === "Enter" && !e.shiftKey && !window.matchMedia("(pointer: coarse)").matches) {
                e.preventDefault();
                submit();
              }
            }}
            rows={1}
            placeholder={`Message ${info.name}`}
            enterKeyHint="send"
            autoComplete="off"
            className="flex-1 resize-none bg-surface-raised border border-border-default rounded-[20px] px-4 py-2 text-[16px] leading-[1.35] text-text-primary placeholder:text-text-tertiary focus:outline-none focus:border-border-emphasis"
          />
          <button
            type="submit"
            disabled={!input.trim()}
            className="w-9 h-9 mb-[2px] shrink-0 rounded-full bg-accent text-surface flex items-center justify-center disabled:opacity-30 transition-opacity"
            aria-label="Send"
          >
            <ArrowUp className="w-5 h-5" strokeWidth={2.5} />
          </button>
        </form>
      </div>
    </div>
  );
}
