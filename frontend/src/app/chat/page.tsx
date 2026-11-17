"use client";

import Link from "next/link";
import { useState, useRef, useEffect } from "react";
import { CHAT_EXAMPLES, MAX_CHAT_CHARACTERS, MAX_CHAT_MESSAGES, conversationKey, earlierOutcomeUnknown, forgetPendingSend, newRequestId, readPendingSendStore, requestIdForSend, storePendingSend, unresolvedPendingSend, type ChatMessage, type FailedSendRef, type PendingSend, type SendChoice } from "@/lib/chat-contract";
import { parseReceipts, type WriteReceipt } from "@/lib/chat-receipts";
import ChatMarkdown from "@/components/ChatMarkdown";
import ChatReceipts from "@/components/ChatReceipts";

/** A message as shown on the page. Receipts are display-only: the API gets role + text. */
type ShownMessage = ChatMessage & { receipts?: WriteReceipt[] };

/**
 * The send that failed: its text, its request id and where in the conversation it was sent. Sending the same text
 * again from the same point reuses the id, so the server recognises the retry and shows what the first try already
 * saved instead of saving it twice (SEC-04, lib/chat-operations.ts). An edited message is a new request. A send whose
 * answer never arrived is also remembered on this device until it is resolved (hash + id only, one key per send so
 * tabs never overwrite each other's, no expiry: lib/chat-contract.ts pendingSendKey). When the same conversation is
 * sent again after a reload or a closed tab, Riley chooses: retry that send (its id, so nothing is saved twice) or send
 * it as a new message (a new id; the earlier one is abandoned, then forgotten). A remembered send whose account Riley
 * has already seen and dismissed is resolved and never matches again. Which id a send uses: requestIdForSend.
 */
type FailedSend = FailedSendRef;

/** A new send that is the same conversation as a remembered send whose answer never arrived: Riley picks. */
interface MatchedSend { text: string; requestId: string; at: number }

function readPendingSends(): PendingSend[] {
  try {
    return readPendingSendStore(window.localStorage);
  } catch {
    return [];
  }
}

/** Remember a send before it goes out (its own key only: another tab's sends are never touched). */
function rememberSend(send: PendingSend) {
  try {
    storePendingSend(window.localStorage, send);
  } catch {
    /* storage full or blocked: the in-memory retry still works */
  }
}

/** An answer (or a definite refusal) arrived for this request: it is resolved, forget it (its own key only). */
function settlePendingSend(requestId: string) {
  try {
    forgetPendingSend(window.localStorage, requestId);
  } catch {
    /* storage blocked: nothing was stored either */
  }
}

/**
 * Statuses that prove this request never reached the replay ledger, so it wrote nothing and its id never runs:
 * refused as invalid (400), too large (413), signed out (401) or forbidden (403) before the route ran. 409 (in
 * progress / conflict), 422 / 499 (stopped after tools ran), 429 and 5xx are not definite. For a first send only.
 */
const NEVER_RAN = new Set([400, 401, 403, 413]);

/**
 * A send whose answer never arrived, found after a reload: the conversation is gone, so the same message sent again
 * would be a new request. The page asks the server what that request saved, by its id alone (GET
 * /api/chat/operations), and shows it, so nothing is logged twice by mistake. Read-only.
 */
type Recovery = { state: "running" | "settled" | "none" | "unknown"; receipts: WriteReceipt[] };

const RECOVERY_TEXT: Record<Recovery["state"], string> = {
  running: "A message you sent before the reload is still running.",
  settled: "A message you sent before the reload got this far:",
  none: "A message you sent before the reload has not reached Onyx, so nothing was saved. Dismissing it also cancels it, in case it is still on its way.",
  unknown: "Onyx could not check a message you sent before the reload. If it asked to log something, check the relevant page before sending it again.",
};

export default function ChatPage() {
  const [messages, setMessages] = useState<ShownMessage[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // What a failed request had already written before it stopped.
  const [errorReceipts, setErrorReceipts] = useState<WriteReceipt[]>([]);
  const sending = useRef(false);
  const failedSend = useRef<FailedSend | null>(null);
  // The text of the failed send, for the "Send the same message again" button.
  const [resendText, setResendText] = useState<string | null>(null);
  // The server said it keeps a replay ledger for this chat (replay_safe), so a retry cannot log anything twice.
  const [replaySafe, setReplaySafe] = useState(false);
  // What the send that was pending at the last reload saved (null = nothing to show).
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  // A new send that matched a remembered send whose answer never arrived, waiting for Riley's choice.
  const [matched, setMatched] = useState<MatchedSend | null>(null);
  // A retry's answer said what an earlier try saved could not be read back (unknown, not "nothing").
  const [earlierUnconfirmed, setEarlierUnconfirmed] = useState(false);
  // Dismissing "has not reached Onyx" is waiting for the server to record the id as abandoned.
  const [dismissing, setDismissing] = useState(false);
  const recoveryId = useRef<string | null>(null);
  // The remembered sends found when this page loaded and not shown yet, newest first (their accounts, one at a time).
  const recoveryQueue = useRef<string[]>([]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const loading = pending !== null;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, pending, error]);

  useEffect(() => {
    if (!loading && messages.length > 0 && window.matchMedia("(pointer: fine)").matches) {
      inputRef.current?.focus();
    }
  }, [loading, messages.length]);

  async function checkPendingSend(id: string) {
    let next: Recovery = { state: "unknown", receipts: [] };
    try {
      const res = await fetch(`/api/chat/operations?request_id=${encodeURIComponent(id)}`, { cache: "no-store" });
      const data = res.redirected ? null : await res.json().catch(() => null);
      const status = data?.status;
      if (status === "running" || status === "settled" || status === "none") next = { state: status, receipts: parseReceipts(data?.receipts) };
    } catch {
      /* offline: "could not check" */
    }
    // Dismissed, or a new message was sent meanwhile.
    if (recoveryId.current === id) setRecovery(next);
  }

  /**
   * Record a send that "has not reached Onyx" as abandoned on the server (POST /api/chat/operations), so that if it is
   * still on its way it runs nothing when it arrives. "abandoned" = recorded; otherwise its account (it reached Onyx
   * first) or "could not check".
   */
  async function abandonPendingSend(id: string): Promise<"abandoned" | Recovery> {
    try {
      const res = await fetch("/api/chat/operations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request_id: id, action: "abandon" }),
        cache: "no-store",
      });
      const data = res.redirected ? null : await res.json().catch(() => null);
      const status = data?.status;
      if (res.ok && status === "abandoned") return "abandoned";
      if (res.ok && (status === "running" || status === "settled")) return { state: status, receipts: parseReceipts(data?.receipts) };
    } catch {
      /* offline: "could not check" */
    }
    return { state: "unknown", receipts: [] };
  }

  async function dismissRecovery() {
    // Once the server gave a definite account of what the send saved (settled) and Riley saw and dismissed it, the
    // remembered send is resolved: it is forgotten, so the same message sent later is a new message, never a replay
    // of this one. "Has not reached Onyx" (none) is not definite on its own (it may still be on its way): it is
    // forgotten only once the server recorded the id as abandoned, which also refuses it if it arrives late; when it
    // arrived first, its account is shown instead. "Still running" or "could not check" is not an account: that send
    // stays remembered (shown again after a reload, and a new send of the same conversation asks whether it is that
    // send again).
    const id = recoveryId.current;
    if (id && recovery?.state === "settled") {
      settlePendingSend(id);
      showNextRecovery();
      return;
    }
    if (id && recovery?.state === "none") {
      setDismissing(true);
      const outcome = await abandonPendingSend(id);
      setDismissing(false);
      // A new message was sent meanwhile.
      if (recoveryId.current !== id) return;
      if (outcome === "abandoned") {
        settlePendingSend(id);
        showNextRecovery();
      } else setRecovery(outcome);
      return;
    }
    showNextRecovery();
  }

  /**
   * Show the account of the next remembered send found when this page loaded (newest first) that is still unresolved,
   * so every one of them can be checked and dismissed in one visit, however many there are (none is ever dropped).
   */
  function showNextRecovery() {
    const unresolved = new Set(readPendingSends().filter((p) => !p.seen).map((p) => p.id));
    let next = recoveryQueue.current.shift();
    while (next !== undefined && !unresolved.has(next)) next = recoveryQueue.current.shift();
    recoveryId.current = next ?? null;
    setRecovery(null);
    if (next) void checkPendingSend(next);
  }

  // Sends were still waiting for their answers when this page was last left: show what each saved, newest first.
  useEffect(() => {
    recoveryQueue.current = readPendingSends().filter((p) => !p.seen).map((p) => p.id).reverse();
    showNextRecovery();
  }, []);

  async function send(again?: string, choice?: SendChoice) {
    const text = (again ?? input).trim();
    if (!text || sending.current) return;
    const updated: ShownMessage[] = [...messages, { role: "user", content: text }];
    if (updated.length > MAX_CHAT_MESSAGES || updated.reduce((n, m) => n + m.content.length, 0) > MAX_CHAT_CHARACTERS) {
      setError("This conversation is full. Start a new chat to continue.");
      return;
    }
    sending.current = true;
    let requestId: string | null = requestIdForSend(choice, failedSend.current, text, messages.length);
    // A retry of a send that did not finish (its id again): an earlier try of it may have written.
    const reusedId = requestId !== null;
    // The same conversation as a send whose answer never arrived (before a reload or a closed tab): never reused
    // silently, Riley chooses (retry that send, or send this as a new message). Seen and dismissed ones are gone.
    const conv = await conversationKey(updated);
    if (!requestId && !choice && conv) {
      const stored = unresolvedPendingSend(readPendingSends(), conv);
      if (stored) {
        sending.current = false;
        setMatched({ text, requestId: stored.id, at: messages.length });
        return;
      }
    }
    setMatched(null);
    setEarlierUnconfirmed(false);
    failedSend.current = null;
    setResendText(null);
    // A new message ends the accounts shown for this load; the remaining ones are shown again after the next reload.
    recoveryId.current = null;
    recoveryQueue.current = [];
    setRecovery(null);
    setPending(text);
    setInput("");
    setError(null);
    setErrorReceipts([]);
    let written: WriteReceipt[] = [];
    let safe = replaySafe;
    let staleId = false;
    try {
      if (!requestId) requestId = newRequestId();
      if (conv) rememberSend({ conv, id: requestId, at: Date.now() });
      // "Send as a new message" over a remembered send: abandon that one on the server, so a late arrival of it runs
      // nothing, and forget it only once that is recorded. Arrived first (running / settled) or not checkable: it
      // stays remembered next to this one, so its account is still shown after a reload.
      const replaced = choice && "fresh" in choice ? choice.replaces : undefined;
      if (replaced && replaced !== requestId) {
        void abandonPendingSend(replaced).then((outcome) => {
          if (outcome === "abandoned") settlePendingSend(replaced);
        });
      }
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request_id: requestId, messages: updated.map(({ role, content }) => ({ role, content })) }),
      });
      const data = await res.json().catch(() => null);
      written = parseReceipts(data?.receipts);
      // What an earlier try of this message saved could not be read back (the server says so, or a retry's answer did
      // not come through the ledger): unknown, so it is said, and the send stays remembered (not settled below), so
      // its account can still be read back after a reload.
      const earlierUnknown = earlierOutcomeUnknown(reusedId, data);
      setEarlierUnconfirmed(earlierUnknown);
      // A busy answer comes from the ledger itself (another try of this message is still running).
      if (data?.replay_safe === true || (res.status === 409 && data?.code === "request_in_progress")) safe = true;
      else if (res.ok) safe = false;
      setReplaySafe(safe);
      // A first send refused before the route ran (or before its ledger) cannot have saved anything: not remembered.
      // A retry's refusal says nothing about what its earlier try saved, so a reused id stays remembered.
      if (!reusedId && (res.redirected || NEVER_RAN.has(res.status))) settlePendingSend(requestId);
      if (res.redirected || res.status === 401) throw new Error("Your session may have expired. Sign in again.");
      // The server no longer accepts this id for this message: the next send starts a new request.
      if (res.status === 409 && data?.code === "request_conflict") {
        staleId = true;
        settlePendingSend(requestId);
      }
      if (!res.ok || typeof data?.response !== "string" || !data?.response.trim()) {
        throw new Error(typeof data?.error === "string" ? data.error : "Onyx could not finish this response.");
      }
      if (!earlierUnknown) settlePendingSend(requestId);
      setMessages([...updated, { role: "assistant", content: data.response, ...(written.length > 0 ? { receipts: written } : {}) }]);
    } catch (err) {
      setInput(text);
      setErrorReceipts(written);
      if (!staleId && requestId) {
        failedSend.current = { text, requestId, at: messages.length };
        setResendText(text);
      }
      const next = staleId
        ? "Your message is back in the composer."
        : safe
          ? "Your message is back in the composer. Sending it again unchanged is safe: anything this try already saved is shown, not saved twice. An edited message counts as a new request."
          : "Your message is back in the composer. If it requested an action, check the relevant page before sending again.";
      setError(`${err instanceof Error ? err.message : "Unable to connect to Onyx."} ${next}`);
    } finally {
      sending.current = false;
      setPending(null);
    }
  }

  function newChat() {
    if (sending.current) return;
    failedSend.current = null;
    setResendText(null);
    setMatched(null);
    setEarlierUnconfirmed(false);
    setMessages([]);
    setInput("");
    setError(null);
    setErrorReceipts([]);
    inputRef.current?.focus();
  }

  const displayed: ShownMessage[] = pending === null ? messages : [...messages, { role: "user", content: pending }];

  return (
    <div className="flex flex-col h-[calc(100dvh-4rem)] max-md:h-[calc(100dvh-8rem)] min-h-0">
      <div className="flex items-start justify-between gap-3 mb-5 shrink-0">
        <div>
          <h2 className="text-[28px] font-medium text-text-primary">Chat with Onyx</h2>
          <p className="text-xs text-text-tertiary mt-1">Reloading or leaving clears this conversation. Anything Onyx logs is saved right away.</p>
        </div>
        <button onClick={newChat} disabled={loading || (!messages.length && !error)} className="shrink-0 text-sm text-text-secondary border border-border-subtle rounded px-3 py-2 disabled:opacity-40">New chat</button>
      </div>

      <div role="log" aria-label="Conversation" aria-live="polite" aria-busy={loading} className="flex-1 overflow-y-auto space-y-4 mb-4 min-h-0">
        {displayed.length === 0 && (
          <div className="max-w-2xl mx-auto mt-6">
            <p className="text-lg font-medium text-text-secondary">What would you like to work on?</p>
            <div className="grid sm:grid-cols-2 gap-2 mt-4">
              {CHAT_EXAMPLES.map((example) => (
                <button key={example} onClick={() => { setInput(example); inputRef.current?.focus(); }} className="text-left text-sm text-text-secondary bg-surface-raised border border-border-subtle rounded-lg p-3 hover:border-accent">{example}</button>
              ))}
            </div>
            <p className="text-xs leading-relaxed text-text-tertiary mt-4">No web, email, calendar or agents here: for agent messages, open the <Link href="/agents" className="text-accent underline">Agents inbox</Link>.</p>
          </div>
        )}
        {displayed.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            {msg.role === "user" ? (
              <div className="max-w-[90%] sm:max-w-[80%] break-words rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap bg-accent text-on-accent">
                <span className="sr-only">You: </span>{msg.content}
              </div>
            ) : (
              <div className="min-w-0 max-w-[90%] sm:max-w-[80%]">
                <div className="break-words rounded-2xl px-4 py-3 text-sm leading-relaxed bg-surface-raised text-text-secondary border border-border-subtle">
                  <span className="sr-only">Onyx: </span>
                  <ChatMarkdown text={msg.content} />
                </div>
                {msg.receipts && <ChatReceipts receipts={msg.receipts} />}
              </div>
            )}
          </div>
        ))}


        <div ref={bottomRef} />
      </div>

      {loading && <p role="status" className="text-sm text-text-tertiary mb-3 animate-pulse">Thinking...</p>}
      {error && (
        <div role="alert" className="text-sm text-text-secondary bg-surface-raised border border-border-subtle rounded-lg p-3 mb-3 max-h-[40dvh] overflow-y-auto">
          <p>{error}</p>
          {/* Only while the composer still holds that exact message: an edited message is a new request. */}
          {resendText !== null && input.trim() === resendText && (
            <button type="button" onClick={() => void send(resendText)} disabled={loading} className="mt-2 text-sm text-accent border border-border-subtle rounded-control px-3 py-1.5 disabled:opacity-40">
              Send the same message again
            </button>
          )}
          <ChatReceipts receipts={errorReceipts} heading="Before it stopped, this request had already done the following" />
        </div>
      )}
      {earlierUnconfirmed && (
        <p role="status" className="text-sm text-text-secondary bg-surface-raised border border-border-subtle rounded-lg p-3 mb-3">
          Onyx could not read back what this message may already have saved, so it may not all be listed. Check the relevant page before logging any of it again.
        </p>
      )}
      {matched && input.trim() === matched.text && messages.length === matched.at && (
        <div role="alert" className="text-sm text-text-secondary bg-surface-raised border border-border-subtle rounded-lg p-3 mb-3">
          <p>You sent this same message before and it did not finish, so it may already have saved something.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" onClick={() => void send(matched.text, { retryOf: matched.requestId })} disabled={loading} className="text-sm text-accent border border-border-subtle rounded-control px-3 py-1.5 disabled:opacity-40">
              Retry that message
            </button>
            <button type="button" onClick={() => void send(matched.text, { fresh: true, replaces: matched.requestId })} disabled={loading} className="text-sm text-text-secondary border border-border-subtle rounded-control px-3 py-1.5 disabled:opacity-40">
              Send as a new message
            </button>
          </div>
          <p className="text-xs text-text-tertiary mt-2">Retry shows what it saved and saves nothing twice. A new message does it all again.</p>
        </div>
      )}
      {recovery && (
        <div role="status" className="text-sm text-text-secondary bg-surface-raised border border-border-subtle rounded-lg p-3 mb-3 max-h-[40dvh] overflow-y-auto">
          <p>{recovery.state === "settled" && recovery.receipts.length === 0 ? "A message you sent before the reload saved nothing." : RECOVERY_TEXT[recovery.state]}</p>
          <ChatReceipts receipts={recovery.receipts} heading="That message" />
          <div className="mt-2 flex gap-2">
            {recovery.state === "running" && (
              <button type="button" onClick={() => { if (recoveryId.current) void checkPendingSend(recoveryId.current); }} className="text-sm text-accent border border-border-subtle rounded-control px-3 py-1.5">
                Check again
              </button>
            )}
            <button type="button" onClick={() => void dismissRecovery()} disabled={dismissing} className="text-sm text-text-secondary border border-border-subtle rounded-control px-3 py-1.5 disabled:opacity-40">
              Dismiss
            </button>
          </div>
        </div>
      )}
      <form onSubmit={(event) => { event.preventDefault(); void send(); }} className="flex gap-2 shrink-0">
        <label htmlFor="onyx-message" className="sr-only">Message Onyx</label>
        <textarea id="onyx-message" ref={inputRef} rows={2} value={input} onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia("(pointer: fine)").matches) { e.preventDefault(); void send(); } }}
          placeholder="Ask Onyx anything..." disabled={loading} maxLength={MAX_CHAT_CHARACTERS}
          className="flex-1 min-w-0 resize-none bg-surface-card border border-border-subtle rounded px-4 py-3 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent" />
        <button type="submit" disabled={loading || !input.trim()} className="bg-accent hover:bg-accent/90 disabled:opacity-40 text-white px-4 py-3 rounded text-sm font-medium">Send</button>
      </form>
      <p className="text-xs text-text-tertiary mt-2 shrink-0">On a keyboard: Enter sends, Shift+Enter adds a line.</p>
    </div>
  );
}
