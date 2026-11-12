"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, BookOpen, ClipboardCheck, Mail, RefreshCw } from "lucide-react";
import { agentsApi, type InboxResponse, type InboxItem } from "@/lib/agents-api";
import type { ReadingOverview } from "@/lib/reading";
import type { UrgentEmailResponse } from "@/lib/urgent-email-query";

type Load<T> = { state: "loading" } | { state: "error" } | { state: "ready"; value: T; stale?: boolean };
type RequestCard = Extract<InboxItem, { kind: "card" }>;
const linkStyle = "text-sm text-accent underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-accent";
const panelStyle = "rounded-2xl border border-border-default bg-surface-card p-5 sm:p-6";

// Bound a slow upstream without treating a timeout as an empty inbox.
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Timed out")), 12000);
    })]);
  } finally { clearTimeout(timer!); }
}
function receivedLabel(iso: string): string {
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? "" : at.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
// Only ever link out to the Gmail message the API built; anything else renders as plain text.
function gmailLink(href: string | null): string | null {
  return href && href.startsWith("https://mail.google.com/mail/") ? href : null;
}
function requestHref(item: RequestCard): string {
  return `/agents?${new URLSearchParams({ t: item.thread })}#m${item.messageId}`;
}

export default function TodayClient() {
  const [inbox, setInbox] = useState<Load<InboxResponse>>({ state: "loading" });
  const [reading, setReading] = useState<Load<ReadingOverview | null>>({ state: "loading" });
  const [urgent, setUrgent] = useState<Load<UrgentEmailResponse>>({ state: "loading" });
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const sequence = useRef(0);
  const inFlight = useRef(false);
  const lastStarted = useRef(0);
  const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(() => {
    if (inFlight.current) return;
    inFlight.current = true;
    lastStarted.current = Date.now();
    setRefreshing(true);
    const current = ++sequence.current;
    setInbox((previous) => previous.state === "ready" ? previous : { state: "loading" });
    setReading((previous) => previous.state === "ready" ? previous : { state: "loading" });
    setUrgent((previous) => previous.state === "ready" ? previous : { state: "loading" });
    const inboxRequest = bounded(Promise.resolve().then(() => agentsApi.inbox())).then((value) => {
      if (!Array.isArray(value.items) || !Array.isArray(value.threads)) throw new Error("Invalid inbox");
      if (sequence.current !== current) return;
      setInbox({ state: "ready", value });
      setCheckedAt(new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
    }).catch(() => { if (sequence.current === current) setInbox((previous) => previous.state === "ready" ? { ...previous, stale: true } : { state: "error" }); });
    const readingRequest = bounded(fetch("/api/reading", { cache: "no-store" }).then(async (res) => {
      if (!res.ok) throw new Error("Reading unavailable");
      const data = await res.json();
      if (!("overview" in data) || (data.overview !== null && !data.overview?.book?.title)) throw new Error("Invalid reading");
      return data.overview as ReadingOverview | null;
    })).then((value) => {
      if (sequence.current === current) setReading({ state: "ready", value });
    }).catch(() => { if (sequence.current === current) setReading((previous) => previous.state === "ready" ? { ...previous, stale: true } : { state: "error" }); });
    const urgentRequest = bounded(fetch("/api/urgent-email", { cache: "no-store" }).then(async (res) => {
      if (!res.ok) throw new Error("Urgent email unavailable");
      const data = await res.json() as UrgentEmailResponse;
      if (data.status !== "not_connected" && !(data.status === "ready" && Array.isArray(data.items))) throw new Error("Invalid urgent email");
      return data;
    })).then((value) => {
      if (sequence.current === current) setUrgent({ state: "ready", value });
    }).catch(() => { if (sequence.current === current) setUrgent((previous) => previous.state === "ready" ? { ...previous, stale: true } : { state: "error" }); });
    void Promise.allSettled([inboxRequest, readingRequest, urgentRequest]).then(() => {
      if (sequence.current === current) { inFlight.current = false; setRefreshing(false); }
    });
  }, []);
  useEffect(() => {
    load();
    const visible = () => { if (document.visibilityState === "visible" && Date.now() - lastStarted.current > 60000) load(); };
    document.addEventListener("visibilitychange", visible);
    return () => {
      // Invalidate asynchronous work, not a DOM ref. Also supports Strict Mode remount.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      sequence.current++;
      inFlight.current = false;
      document.removeEventListener("visibilitychange", visible);
    };
  }, [load]);

  const requests = inbox.state === "ready" ? inbox.value.items.filter((item): item is RequestCard => item.kind === "card") : [];
  const pending = refreshing || inbox.state === "loading" || reading.state === "loading" || urgent.state === "loading";
  const unavailable = inbox.state === "error" || reading.state === "error" || urgent.state === "error" || (inbox.state === "ready" && inbox.stale) || (reading.state === "ready" && reading.stale) || (urgent.state === "ready" && urgent.stale);
  const email = urgent.state === "ready" && urgent.value.status === "ready" ? urgent.value : null;
  const book = reading.state === "ready" ? reading.value : null;
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <header className="flex items-start justify-between gap-4">
        <div><h1 className="text-[30px] font-medium text-text-primary">Today</h1>
          <p className="mt-1 text-sm text-text-secondary">A few useful places to pick up.</p></div>
        <button type="button" onClick={() => { if (!pending) load(); }} aria-disabled={pending} aria-label="Refresh Today"
          className="rounded-xl border border-border-default p-3 text-text-secondary aria-disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-accent">
          <RefreshCw aria-hidden="true" className={`h-4 w-4 ${pending ? "animate-spin motion-reduce:animate-none" : ""}`} />
        </button>
      </header>
      <p role="status" aria-live="polite" className="sr-only">{pending ? "Refreshing Today" : unavailable ? "Some information could not be refreshed. Check the section messages." : "Today refresh finished"}</p>
      <section className={panelStyle} aria-labelledby="requests-heading" aria-busy={inbox.state === "loading"}>
        <div className="flex items-center justify-between gap-4">
          <h2 id="requests-heading" className="text-lg font-medium text-text-primary">Needs your input</h2>
          <Link href="/agents?view=unread" className={linkStyle}>Open inbox</Link>
        </div>
        {inbox.state === "loading" && <p className="mt-4 text-sm text-text-secondary">Checking agent requests...</p>}
        {inbox.state === "error" && <p className="mt-4 text-sm text-text-secondary">Couldn&apos;t check requests. Open your inbox or try refreshing.</p>}
        {inbox.state === "ready" && <>
          {inbox.stale && <p className="mt-3 text-sm text-amber-300">Couldn&apos;t refresh requests. Showing the last check from {checkedAt}; these requests may have changed.</p>}
          {requests.length === 0 ? <p className="mt-4 text-sm text-text-secondary">The last check returned no open requests. Messages and updates are in your inbox.</p> : <>
            <p className="mt-2 text-xs text-text-secondary">Showing {Math.min(requests.length, 3)} of {requests.length} requests returned, in inbox order.</p>
            <ul className="mt-4 divide-y divide-border-subtle">
              {requests.slice(0, 3).map((item) => <li key={`${item.thread}:${item.messageId}:${item.card.code}`}>
                <Link href={requestHref(item)} className="group flex items-center justify-between gap-3 rounded-lg py-4 focus-visible:outline-2 focus-visible:outline-accent">
                  <span className="min-w-0"><span className="block text-xs text-text-secondary">{item.card.agent || "Agent"}</span>
                    <span className="mt-1 block break-words text-sm font-medium text-text-primary">{item.card.name}</span>
                    <span className="mt-1 block text-xs text-accent">Review request</span></span>
                  <ArrowUpRight aria-hidden="true" className="h-4 w-4 shrink-0 text-text-secondary" />
                </Link>
              </li>)}
            </ul>
            {requests.length > 3 && <Link href="/agents?view=unread" className={linkStyle}>See the rest in your inbox</Link>}
          </>}
          <p className="mt-4 text-xs text-text-secondary">Inbox checked at {checkedAt}. Opening Today does not mark anything read.</p>
        </>}
      </section>
      <section className={panelStyle} aria-labelledby="urgent-email-heading" aria-busy={urgent.state === "loading"}>
        <div className="flex items-center gap-2"><Mail aria-hidden="true" className="h-5 w-5 text-accent" />
          <h2 id="urgent-email-heading" className="text-lg font-medium text-text-primary">Urgent email</h2></div>
        {urgent.state === "loading" && <p className="mt-3 text-sm text-text-secondary">Checking email...</p>}
        {urgent.state === "error" && <p className="mt-3 text-sm text-text-secondary">Couldn&apos;t check urgent email. Try refreshing.</p>}
        {urgent.state === "ready" && urgent.stale && <p className="mt-3 text-sm text-amber-300">Couldn&apos;t refresh email. Showing the last check; it may have changed.</p>}
        {urgent.state === "ready" && urgent.value.status === "not_connected" && <>
          <p className="mt-3 text-sm text-text-primary">No urgent email source connected yet.</p>
          <p className="mt-1 text-xs text-text-secondary">Onyx is not reading any email, so nothing is checked here.</p>
        </>}
        {email && (email.items.length === 0 ? <>
          <p className="mt-3 text-sm text-text-secondary">{email.scanned === 0 ? `No unread email from the last ${email.windowDays} days to check.` : `Checked ${email.scanned} unread email${email.scanned === 1 ? "" : "s"} from the last ${email.windowDays} days; none look urgent.`}</p>
          {email.truncated && <p className="mt-1 text-xs text-amber-300">Only the newest unread emails were checked, so older ones in this window may be missing.</p>}
          {email.newestReceivedAt && <p className="mt-1 text-xs text-text-secondary">Newest synced message: {receivedLabel(email.newestReceivedAt)}.</p>}
        </> : <>
          <p className="mt-2 text-xs text-text-secondary">Showing {email.items.length} of {email.total} urgent email{email.total === 1 ? "" : "s"}, strongest first.</p>
          {email.truncated && <p className="mt-1 text-xs text-amber-300">Only the newest unread emails were checked, so older ones in this window may be missing.</p>}
          <ul className="mt-3 divide-y divide-border-subtle">
            {email.items.map((item) => {
              const href = gmailLink(item.href);
              const body = <>
                <span className="min-w-0"><span className="block break-words text-xs text-text-secondary">{item.from}{receivedLabel(item.receivedAt) ? ` - ${receivedLabel(item.receivedAt)}` : ""}</span>
                  <span className="mt-1 block break-words text-sm font-medium text-text-primary">{item.subject}</span>
                  {item.reasons.length > 0 && <span className="mt-1 block text-xs text-text-secondary">Why: {item.reasons.join(", ")}</span>}
                  <span className={`mt-1 block text-xs ${href ? "text-accent" : "text-text-secondary"}`}>{href ? "Open in Gmail" : "No link available"}</span></span>
                {href && <ArrowUpRight aria-hidden="true" className="h-4 w-4 shrink-0 text-text-secondary" />}
              </>;
              return <li key={item.id}>{href
                ? <a href={href} target="_blank" rel="noopener noreferrer" className="group flex items-center justify-between gap-3 rounded-lg py-4 focus-visible:outline-2 focus-visible:outline-accent">{body}</a>
                : <div className="flex items-center justify-between gap-3 py-4">{body}</div>}</li>;
            })}
          </ul>
        </>)}
        {urgent.state === "ready" && urgent.value.status === "ready" && <p className="mt-3 text-xs text-text-secondary">Picked by simple rules on sender, subject and dates, so it can miss things. Opening Today does not mark email read.</p>}
      </section>
      <section className={panelStyle} aria-labelledby="reading-heading" aria-busy={reading.state === "loading"}>
        <div className="flex items-center gap-2"><BookOpen aria-hidden="true" className="h-5 w-5 text-accent" />
          <h2 id="reading-heading" className="text-lg font-medium text-text-primary">Keep reading</h2></div>
        {reading.state === "loading" && <p className="mt-3 text-sm text-text-secondary">Loading reading progress...</p>}
        {reading.state === "error" && <p className="mt-3 text-sm text-text-secondary">Reading progress is unavailable right now.</p>}
        {reading.state === "ready" && reading.stale && <p className="mt-3 text-sm text-amber-300">Couldn&apos;t refresh reading. Showing previously loaded progress.</p>}
        {reading.state === "ready" && (book ? <>
          <p className="mt-3 text-base font-medium text-text-primary">{book.book.title}</p>
          <p className="mt-1 text-sm text-text-secondary">{Number.isFinite(book.chaptersDone) && Number.isFinite(book.totalChapters) && book.totalChapters > 0 && book.chaptersDone >= 0 && book.chaptersDone <= book.totalChapters ? `${book.chaptersDone} of ${book.totalChapters} chapters recorded.` : "Chapter progress is not available."}</p>
          <p className="mt-1 text-xs text-text-secondary">Recorded progress may lag your latest reading.</p>
        </> : <p className="mt-3 text-sm text-text-secondary">No book is currently in progress.</p>)}
        <Link href="/reading" className={`${linkStyle} mt-4 inline-block`}>{book ? "Continue reading" : "Open reading"}</Link>
      </section>
      <section className={panelStyle} aria-labelledby="checkin-heading">
        <div className="flex items-center gap-2"><ClipboardCheck aria-hidden="true" className="h-5 w-5 text-accent" />
          <h2 id="checkin-heading" className="text-lg font-medium text-text-primary">A moment to check in</h2></div>
        <p className="mt-3 text-sm text-text-secondary">Start or continue your check-in. Answer what you know; leave the rest blank.</p>
        <Link href="/check-in" className={`${linkStyle} mt-4 inline-block`}>Open check-in</Link>
      </section>
      <nav aria-label="More places" className="flex flex-wrap gap-x-5 gap-y-3 pb-4">
        <Link href="/status" className={linkStyle}>System status</Link>
        <Link href="/nyc" className={linkStyle}>NYC search</Link>
        <Link href="/sleep" className={linkStyle}>Sleep &amp; recovery</Link>
      </nav>
    </div>
  );
}
