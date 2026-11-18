/**
 * Guided "Update everything" flow (pure, import-free, so a test can compile it by name).
 *
 * The button used to fire and forget. Now a small state, kept on the device, records what happened (tapped, the install
 * prompt was opened, the page went to the background) and the live update status says whether the phone reported the
 * new build. flowView() turns both into ONE current step with plain words and, when something is stuck, one next action.
 */

export const FLOW_KEY = "onyx.update.flow";
export const APP_SCHEME_URL = "onyxscreentime://";
export const TRUST_URL = "App-Prefs:General&path=ManagedConfigurationList";
/** No install popup this long after it was opened = offer to tap Install again. */
export const NO_PROMPT_MS = 20_000;
/** After the page went to the background on the prompt, the install is assumed to run this long before "open the app". */
export const INSTALL_MS = 60_000;
/** Still not reported this long after the tap = "not confirmed". */
export const UNCONFIRMED_MS = 5 * 60_000;
/** The green state stays this long, then the banner goes away. */
export const DONE_SHOW_MS = 10_000;
/** A flow older than this is forgotten. */
export const EXPIRE_MS = 30 * 60_000;

export interface FlowState {
  /** The build being installed ("0.1.0 (12)"), "" for a web-only update. */
  target: string;
  phone: boolean;
  web: boolean;
  tappedAt: number;
  /** The install link was opened (itms-services navigation). */
  promptAt?: number;
  /** The page went to the background after the prompt (the user tapped Install, iOS took over). */
  hiddenAt?: number;
  /** The phone reported the target build (or, for a web-only flow, the web is on the newest deployment). */
  doneAt?: number;
  webDoneAt?: number;
}

export interface FlowCtx {
  now: number;
  /** What the phone last reported, from /api/iphone/update-status. */
  installed: string | null;
  /** Newest build; may change while the flow runs. */
  available: string | null;
  needsTrust: boolean;
  /** Web status was read at least once; webBehind = the live deployment is newer than this page. */
  webChecked: boolean;
  webBehind: boolean;
  /** Where "Install again" goes ("" = none). */
  retryHref: string;
}

export type FlowStep =
  | "handed_off" | "install_prompt" | "installing" | "open_app" | "done"
  | "no_prompt" | "unconfirmed" | "needs_trust";

export interface FlowAction { label: string; href: string }
export interface FlowItem { id: string; label: string; state: "done" | "current" | "todo" }
export interface FlowView {
  active: boolean;
  step: FlowStep | null;
  failure: boolean;
  title: string;
  items: FlowItem[];
  action: FlowAction | null;
  webLine: string | null;
}

export function startFlow(target: string | null, phone: boolean, web: boolean, now: number): FlowState {
  return { target: phone ? (target ?? "") : "", phone, web, tappedAt: now };
}

/** Only ever returns a state this module could have written. */
export function parseFlow(text: string | null): FlowState | null {
  if (!text) return null;
  try {
    const j = JSON.parse(text) as Record<string, unknown>;
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
    if (typeof j.target !== "string" || j.target.length > 64 || typeof j.phone !== "boolean" || typeof j.web !== "boolean") return null;
    const tappedAt = num(j.tappedAt);
    if (tappedAt === undefined) return null;
    return {
      target: j.target, phone: j.phone, web: j.web, tappedAt,
      promptAt: num(j.promptAt), hiddenAt: num(j.hiddenAt), doneAt: num(j.doneAt), webDoneAt: num(j.webDoneAt),
    };
  } catch { return null; }
}

export function recordPrompt(s: FlowState, now: number): FlowState {
  return s.promptAt ? s : { ...s, promptAt: now };
}

/** The page went to the background (the hand-off or the install prompt took over). Only the first time counts. */
export function recordHidden(s: FlowState, now: number): FlowState {
  return s.hiddenAt ? s : { ...s, hiddenAt: now };
}

/** Marks what finished. Pure: returns the same object when nothing changed. */
export function settle(s: FlowState, c: FlowCtx): FlowState {
  let next = s;
  if (s.phone && !s.doneAt && c.installed && c.installed === s.target) next = { ...next, doneAt: c.now };
  if (s.web && !s.webDoneAt && c.webChecked && !c.webBehind) next = { ...next, webDoneAt: c.now };
  // A web-only flow has no phone part: its doneAt follows the web.
  if (!s.phone && next.webDoneAt && !next.doneAt) next = { ...next, doneAt: next.webDoneAt };
  return next;
}

function finished(s: FlowState): boolean {
  return (!s.phone || !!s.doneAt) && (!s.web || !!s.webDoneAt);
}

/** True while the banner should show the flow (including the 10 s of green after it finished). */
export function flowActive(s: FlowState | null, now: number): boolean {
  if (!s) return false;
  if (!finished(s)) return now - s.tappedAt <= EXPIRE_MS;
  const at = Math.max(s.doneAt ?? 0, s.webDoneAt ?? 0);
  return now - at <= DONE_SHOW_MS;
}

/** Only poll while a phone install is waiting for the report. */
export function shouldPoll(s: FlowState | null, now: number): boolean {
  return !!s && s.phone && !s.doneAt && now - s.tappedAt <= EXPIRE_MS;
}

const LABELS: Array<[string, string]> = [
  ["handed", "Safari opens"],
  ["prompt", "Tap Install on the popup"],
  ["installing", "Installing on the home screen"],
  ["open", "Open Onyx Screen Time once"],
  ["done", "Updated"],
];

function phoneStep(s: FlowState, c: FlowCtx): FlowStep {
  if (s.doneAt) return "done";
  const since = c.now - s.tappedAt;
  if (c.needsTrust && (s.hiddenAt || since > INSTALL_MS)) return "needs_trust";
  if (since > UNCONFIRMED_MS) return "unconfirmed";
  if (s.promptAt && !s.hiddenAt) return c.now - s.promptAt > NO_PROMPT_MS ? "no_prompt" : "install_prompt";
  // Hidden after the tap, with or without a recorded prompt (from the home-screen app Safari does the prompt): installing.
  if (s.hiddenAt) return c.now - s.hiddenAt > INSTALL_MS ? "open_app" : "installing";
  return since > NO_PROMPT_MS ? "no_prompt" : "handed_off";
}

const INDEX: Record<FlowStep, number> = {
  handed_off: 0, install_prompt: 1, no_prompt: 1, installing: 2, open_app: 3, unconfirmed: 3, needs_trust: 3, done: 4,
};

export function flowView(s: FlowState | null, c: FlowCtx): FlowView {
  const idle: FlowView = { active: false, step: null, failure: false, title: "", items: [], action: null, webLine: null };
  if (!s || !flowActive(s, c.now)) return idle;
  const webLine = s.phone && s.web ? (s.webDoneAt ? "Onyx updated ✓" : "Updating Onyx…") : null;
  if (!s.phone) {
    return { ...idle, active: true, step: s.webDoneAt ? "done" : "handed_off", title: s.webDoneAt ? "Onyx updated ✓" : "Updating Onyx…" };
  }
  const step = phoneStep(s, c);
  const current = INDEX[step];
  const items: FlowItem[] = LABELS.map(([id, label], i) => ({
    id,
    label: i === 4 && step === "done" ? `Updated to ${c.installed ?? s.target} ✓` : label,
    state: step === "done" || i < current ? "done" : i === current ? "current" : "todo",
  }));
  const retry = c.retryHref ? { label: "Tap Install again", href: c.retryHref } : null;
  let title = "";
  let action: FlowAction | null = null;
  switch (step) {
    case "handed_off": title = "Opening Safari…"; break;
    case "install_prompt": title = "Tap Install on the popup"; break;
    case "installing": title = "Installing. The Onyx Screen Time icon on your home screen shows progress"; break;
    case "open_app": title = "Open Onyx Screen Time once to finish"; action = { label: "Open Onyx Screen Time", href: APP_SCHEME_URL }; break;
    case "done": title = `Updated to ${c.installed ?? s.target} ✓`; break;
    case "no_prompt": title = "The install popup didn't appear"; action = retry; break;
    case "unconfirmed": title = "Not confirmed yet: open Onyx Screen Time"; action = { label: "Open Onyx Screen Time", href: APP_SCHEME_URL }; break;
    case "needs_trust": title = "iOS needs one approval: open Settings"; action = { label: "Open Settings", href: TRUST_URL }; break;
  }
  return {
    active: true, step, title, items, action, webLine,
    failure: step === "no_prompt" || step === "unconfirmed" || step === "needs_trust",
  };
}
