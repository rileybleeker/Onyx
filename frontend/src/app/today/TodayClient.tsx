"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, BookOpen, ClipboardCheck, FlaskConical, Mail, Package, RefreshCw } from "lucide-react";
import { agentsApi, type InboxResponse, type InboxItem } from "@/lib/agents-api";
import type { ReadingOverview } from "@/lib/reading";
import type { UrgentEmailResponse } from "@/lib/urgent-email-query";
import { ageLabel, isEmailCard, isGmailHref, mergeUrgent } from "@/lib/urgent-email";
import { dayLabel, isExperimentToday, type ExperimentToday } from "@/lib/experiments";

type Load<T> = { state: "loading" } | { state: "error" } | { state: "ready"; value: T; stale?: boolean };
type RequestCard = Extract<InboxItem, { kind: "card" }>;
// GET /api/orders/summary (online orders read from shipping emails; see /orders).
type OrdersSummary = { status: "not_connected" } | { status: "ready"; attention: number; arrivingToday: number; onTheWay: number;
  top: { merchant: string; label: string; reason: string }[] };
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
// The email label sync runs hourly; older than this and Today says newer labels may be missing.
const LABEL_SYNC_STALE_MS = 3 * 3_600_000;
const URGENT_SHOWN = 5;
function requestHref(item: RequestCard): string {
  return `/agents?${new URLSearchParams({ t: item.thread })}#m${item.messageId}`;
}

export default function TodayClient() {
  const [inbox, setInbox] = useState<Load<InboxResponse>>({ state: "loading" });
  const [reading, setReading] = useState<Load<ReadingOverview | null>>({ state: "loading" });
  const [urgent, setUrgent] = useState<Load<UrgentEmailResponse>>({ state: "loading" });
  // Packages are shown only when something needs attention or arrives today, and a failed check
  // just hides the panel: /orders is where package status lives.
  const [orders, setOrders] = useState<OrdersSummary | null>(null);
  // Today's arm of the running N-of-1 trial (GET /api/experiments/today). Usually "none": no card.
  const [experiment, setExperiment] = useState<Load<ExperimentToday>>({ state: "loading" });
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
    setExperiment((previous) => previous.state === "ready" ? previous : { state: "loading" });
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
    const ordersRequest = bounded(fetch("/api/orders/summary", { cache: "no-store" }).then(async (res) => {
      if (!res.ok) throw new Error("Orders unavailable");
      const data = await res.json() as OrdersSummary;
      if (data.status !== "not_connected" && !(data.status === "ready" && Array.isArray(data.top))) throw new Error("Invalid orders");
      return data;
    })).then((value) => {
      if (sequence.current === current) setOrders(value);
    }).catch(() => { /* keep the last summary; /orders has the details */ });
    const experimentRequest = bounded(fetch("/api/experiments/today", { cache: "no-store" }).then(async (res) => {
      if (!res.ok) throw new Error("Experiment arm unavailable");
      const data: unknown = await res.json();
      if (!isExperimentToday(data)) throw new Error("Invalid experiment arm");
      return data;
    })).then((value) => {
      if (sequence.current === current) setExperiment({ state: "ready", value });
    }).catch(() => { if (sequence.current === current) setExperiment((previous) => previous.state === "ready" ? { ...previous, stale: true } : { state: "error" }); });
    void Promise.allSettled([inboxRequest, readingRequest, urgentRequest, ordersRequest, experimentRequest]).then(() => {
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

  const cards = inbox.state === "ready" ? inbox.value.items.filter((item): item is RequestCard => item.kind === "card") : [];
  // inbox-triage's "Urgent: ..." email questions are shown once, under Urgent email.
  const emailCards = cards.filter((item) => isEmailCard(item.card));
  const requests = cards.filter((item) => !isEmailCard(item.card));
  const pending = refreshing || inbox.state === "loading" || reading.state === "loading" || urgent.state === "loading";
  const unavailable = inbox.state === "error" || reading.state === "error" || urgent.state === "error" || (inbox.state === "ready" && inbox.stale) || (reading.state === "ready" && reading.stale) || (urgent.state === "ready" && urgent.stale) || experiment.state === "error" || (experiment.state === "ready" && experiment.stale);
  // "none" (no trial registered, the usual case) and "not_connected" render nothing at all.
  const trial = experiment.state === "ready" && experiment.value.status !== "none" && experiment.value.status !== "not_connected" ? experiment.value : null;
  const email = urgent.state === "ready" && urgent.value.status === "ready" ? urgent.value : null;
  const merged = mergeUrgent(email?.items ?? [], emailCards, URGENT_SHOWN);
  const now = new Date();
  const lastSync = email?.lastSync ?? null;
  const syncStale = !!lastSync && (now.getTime() - new Date(lastSync.at).getTime() > LABEL_SYNC_STALE_MS || lastSync.status !== "success");
  const book = reading.state === "ready" ? reading.value : null;
  const packages = orders?.status === "ready" && (orders.attention > 0 || orders.arrivingToday > 0) ? orders : null;
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <header className="flex items-start justify-between gap-4">
        <div><h1 data-testid="page-heading" className="text-[30px] font-medium text-text-primary">Today</h1>
          <p className="mt-1 text-sm text-text-secondary">A few useful places to pick up.</p></div>
        <button type="button" onClick={() => { if (!pending) load(); }} aria-disabled={pending} aria-label="Refresh Today"
          className="rounded-xl border border-border-default p-3 text-text-secondary aria-disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-accent">
          <RefreshCw aria-hidden="true" className={`h-4 w-4 ${pending ? "animate-spin motion-reduce:animate-none" : ""}`} />
        </button>
      </header>
      <p role="status" aria-live="polite" className="sr-only">{pending ? "Refreshing Today" : unavailable ? "Some information could not be refreshed. Check the section messages." : "Today refresh finished"}</p>
      {experiment.state === "error" && <div role="region" aria-label="Experiment arm" className={panelStyle}>
        <p className="text-sm text-text-secondary">Couldn&apos;t check today&apos;s experiment arm. Try refreshing.</p>
      </div>}
      {trial && <div role="region" aria-labelledby="experiment-heading" className={panelStyle}>
        <div className="flex items-center gap-2"><FlaskConical aria-hidden="true" className="h-5 w-5 text-accent" />
          <h2 id="experiment-heading" className="text-lg font-medium text-text-primary">{trial.status === "active" ? "Today's experiment arm" : "Experiment"}</h2></div>
        {trial.status === "active" && <>
          <p className="mt-1 break-words text-xs text-text-secondary">{trial.experimentId}: {trial.title}. Day {trial.dayNumber} of {trial.nDays} ({dayLabel(trial.behavioralDate)}).</p>
          <p className="mt-3 text-base font-medium text-text-primary">Arm {trial.arm}</p>
          <p className="mt-1 break-words text-sm text-text-primary">{trial.instruction}</p>
          <p className="mt-3 text-xs text-text-secondary">It applies until you go to sleep, also after midnight. Tomorrow&apos;s arm is not shown until tomorrow. Opening Today does not record whether you followed it.</p>
        </>}
        {trial.status === "upcoming" && <p className="mt-3 break-words text-sm text-text-primary">{trial.experimentId}: {trial.title} starts {dayLabel(trial.startDate)} and runs {trial.nDays} days. No arm today.</p>}
        {trial.status === "paused" && <p className="mt-3 break-words text-sm text-text-primary">{trial.experimentId}: {trial.title} is paused. No arm today.</p>}
        {experiment.state === "ready" && experiment.stale && <p className="mt-3 text-sm text-amber-300">Couldn&apos;t refresh the experiment arm. Showing the last check.</p>}
      </div>}
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
          {emailCards.length > 0 && <p className="mt-3 text-xs text-text-secondary">{emailCards.length === 1 ? "1 email request is" : `${emailCards.length} email requests are`} listed under Urgent email instead.</p>}
          <p className="mt-4 text-xs text-text-secondary">Inbox checked at {checkedAt}. Opening Today does not mark anything read.</p>
        </>}
      </section>
      <section className={panelStyle} aria-labelledby="urgent-email-heading" aria-busy={urgent.state === "loading"}>
        <div className="flex items-center gap-2"><Mail aria-hidden="true" className="h-5 w-5 text-accent" />
          <h2 id="urgent-email-heading" className="text-lg font-medium text-text-primary">Urgent email</h2></div>
        <p className="mt-1 text-xs text-text-secondary">From inbox-triage: threads it labelled Agent/Action or Agent/Deadline, and its urgent questions in your agent inbox.</p>
        {urgent.state === "loading" && <p className="mt-3 text-sm text-text-secondary">Checking email...</p>}
        {urgent.state === "error" && <p className="mt-3 text-sm text-text-secondary">{emailCards.length > 0 ? "Couldn't check the email labels. Showing inbox-triage's requests only." : "Couldn't check urgent email. Try refreshing."}</p>}
        {urgent.state === "ready" && urgent.stale && <p className="mt-3 text-sm text-amber-300">Couldn&apos;t refresh the email labels. Showing the last check; it may have changed.</p>}
        {urgent.state === "ready" && urgent.value.status === "not_connected" && <p className="mt-3 text-sm text-text-primary">The email label sync isn&apos;t connected yet{emailCards.length > 0 ? ", so only inbox-triage's requests are shown." : "."}</p>}
        {inbox.state === "error" && urgent.state !== "loading" && <p className="mt-3 text-xs text-text-secondary">Agent requests couldn&apos;t be checked, so inbox-triage&apos;s urgent questions may be missing here.</p>}
        {urgent.state !== "loading" && (merged.items.length > 0 ? <>
          <p className="mt-2 text-xs text-text-secondary">Showing {merged.items.length} of {merged.total}, most pressing first.</p>
          <ul className="mt-2 divide-y divide-border-subtle" aria-label="Urgent email">
            {merged.items.map((item) => <li key={item.key} className="py-4">
              <p className="break-words text-xs text-text-secondary">{item.sourceDetail}. {item.atVerb} {ageLabel(item.at, now)}.</p>
              <p className="mt-1 break-words text-sm font-medium text-text-primary">{item.title}</p>
              {item.from && <p className="mt-0.5 break-words text-xs text-text-secondary">From {item.from}</p>}
              {item.reasons.length > 0 && <p className="mt-1 break-words text-xs text-text-secondary">Why: {item.reasons.join("; ")}</p>}
              <p className="mt-1 break-words text-xs text-text-primary">Next: {item.nextStep}</p>
              {(item.gmailHref || item.requestHref) && <p className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                {item.gmailHref && isGmailHref(item.gmailHref) && <a href={item.gmailHref} target="_blank" rel="noopener noreferrer" aria-label={`Open in Gmail: ${item.title}`} className={linkStyle}>Open in Gmail</a>}
                {item.requestHref && <Link href={item.requestHref} aria-label={`Open request: ${item.title}`} className={linkStyle}>Open request</Link>}
              </p>}
            </li>)}
          </ul>
        </> : email && <>
          <p className="mt-3 text-sm text-text-secondary">Nothing urgent right now.</p>
          <p className="mt-1 text-xs text-text-secondary">{email.scanned === 0 ? `No labelled threads in the last ${email.windowDays} days.` : `${email.scanned} labelled thread${email.scanned === 1 ? "" : "s"} in the last ${email.windowDays} days; ${email.hidden} left out (archived, older, or past their date).`}</p>
        </>)}
        {email && <p className={`mt-3 text-xs ${syncStale ? "text-amber-300" : "text-text-secondary"}`}>{lastSync
          ? `Email labels last synced ${ageLabel(lastSync.at, now)}${lastSync.status !== "success" ? ` (that run: ${lastSync.status})` : ""}${syncStale ? "; newer labels may be missing." : "."}`
          : "The email label sync has not run yet."}</p>}
        {urgent.state !== "loading" && <p className="mt-1 text-xs text-text-secondary">Opening Today does not mark email read or change any label.</p>}
      </section>
      {packages && <section className={panelStyle} aria-labelledby="packages-heading">
        <div className="flex items-center gap-2"><Package aria-hidden="true" className="h-5 w-5 text-accent" />
          <h2 id="packages-heading" className="text-lg font-medium text-text-primary">Packages</h2></div>
        <p className="mt-3 text-sm text-text-primary">{[
          packages.attention > 0 ? `${packages.attention} need${packages.attention === 1 ? "s" : ""} attention` : null,
          packages.arrivingToday > 0 ? `${packages.arrivingToday} arriving today` : null,
        ].filter(Boolean).join(" · ")}</p>
        {packages.top.length > 0 && <ul className="mt-2 space-y-2" aria-label="Packages that need attention">
          {packages.top.map((t, i) => <li key={i} className="text-xs text-text-secondary"><span className="text-text-primary">{t.merchant}: {t.label}.</span> {t.reason}</li>)}
        </ul>}
        <Link href="/orders" className={`${linkStyle} mt-4 inline-block`}>Open orders</Link>
      </section>}
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
