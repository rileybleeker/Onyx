"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { UpdateStatus } from "@/lib/iphone-update";
import {
  FLOW_KEY, flowView, parseFlow, recordHidden, recordPrompt, settle, shouldPoll, startFlow,
  type FlowState, type FlowView,
} from "@/lib/update-flow";

interface Inputs {
  status: UpdateStatus | null;
  webChecked: boolean;
  webBehind: boolean;
  retryHref: string;
}

function load(): FlowState | null {
  try { return parseFlow(window.localStorage.getItem(FLOW_KEY)); } catch { return null; }
}
function save(s: FlowState | null) {
  try {
    if (s) window.localStorage.setItem(FLOW_KEY, JSON.stringify(s));
    else window.localStorage.removeItem(FLOW_KEY);
  } catch { /* storage blocked: the flow still works for this page view */ }
}

/**
 * The guided update flow's runtime: keeps the state on the device (it survives the trip to Safari and back), polls the
 * read-only update status every 5 s while a phone install waits for its report and the page is visible, and turns it
 * all into a FlowView (pure rules in lib/update-flow.ts).
 */
export function useUpdateFlow(inp: Inputs) {
  const [flow, setFlow] = useState<FlowState | null>(null);
  const [live, setLive] = useState<UpdateStatus | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const flowRef = useRef<FlowState | null>(null);

  const commit = useCallback((next: FlowState | null) => {
    flowRef.current = next;
    setFlow(next);
    save(next);
  }, []);

  useEffect(() => { commit(load()); }, [commit]);

  const begin = useCallback((phone: boolean, web: boolean, target: string | null) => {
    commit(startFlow(target, phone, web, Date.now()));
  }, [commit]);

  /** "Tap Install again": a fresh attempt for the same build. */
  const restart = useCallback(() => {
    const s = flowRef.current;
    if (s) commit(startFlow(s.target, s.phone, s.web && !s.webDoneAt, Date.now()));
  }, [commit]);

  const markPrompt = useCallback(() => {
    if (flowRef.current) commit(recordPrompt(flowRef.current, Date.now()));
  }, [commit]);

  // A clock tick for the time-based steps, only while a flow exists.
  useEffect(() => {
    if (!flow) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [flow]);

  // Going to the background after the tap = iOS took over (Safari / install prompt).
  useEffect(() => {
    const onVis = () => {
      const s = flowRef.current;
      if (document.visibilityState === "hidden" && s && !s.doneAt) commit(recordHidden(s, Date.now()));
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [commit]);

  // Read-only poll of the reported version, only while visible and a phone install is waiting.
  const polling = shouldPoll(flow, now);
  useEffect(() => {
    if (!polling) return;
    let stop = false;
    const poll = () => {
      if (document.visibilityState !== "visible") return;
      fetch("/api/iphone/update-status", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((j) => { if (!stop && j?.status) setLive(j.status as UpdateStatus); })
        .catch(() => {});
    };
    poll();
    const t = window.setInterval(poll, 5000);
    document.addEventListener("visibilitychange", poll);
    return () => { stop = true; window.clearInterval(t); document.removeEventListener("visibilitychange", poll); };
  }, [polling]);

  const status = live ?? inp.status;
  const ctx = {
    now,
    installed: status?.installed ?? null,
    available: status?.available ?? null,
    needsTrust: !!status?.needsTrust,
    webChecked: inp.webChecked,
    webBehind: inp.webBehind,
    retryHref: inp.retryHref,
  };

  // Persist what finished (the phone reported the build, the web is current).
  useEffect(() => {
    if (!flow) return;
    const next = settle(flow, ctx);
    if (next !== flow) commit(next);
  });

  const view: FlowView = flowView(flow, ctx);
  // Forget an expired or fully shown flow.
  useEffect(() => { if (flow && !view.active) commit(null); }, [flow, view.active, commit]);

  return { view, flow, begin, restart, markPrompt, status };
}
