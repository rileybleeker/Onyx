"use client";

import Link from "next/link";
import { useState, useRef, useEffect } from "react";
import { CHAT_EXAMPLES, MAX_CHAT_CHARACTERS, MAX_CHAT_MESSAGES, PENDING_SEND_KEY, conversationKey, newRequestId, parsePendingSend, type ChatMessage, type PendingSend } from "@/lib/chat-contract";
import { parseReceipts, type WriteReceipt } from "@/lib/chat-receipts";
import ChatMarkdown from "@/components/ChatMarkdown";
import ChatReceipts from "@/components/ChatReceipts";

/** A message as shown on the page. Receipts are display-only: the API gets role + text. */
type ShownMessage = ChatMessage & { receipts?: WriteReceipt[] };

/**
 * The send that failed: its text, its request id and where in the conversation it was sent. Sending the same text
 * again from the same point reuses the id, so the server recognises the retry and shows what the first try already
 * saved instead of saving it twice (SEC-04, lib/chat-operations.ts). An edited message is a new request. A send whose
 * answer never arrived is also remembered on this device for a while (hash + id only, PENDING_SEND_KEY), so the same
 * conversation sent again after a reload or a closed tab is still recognised.
 */
interface FailedSend { text: string; requestId: string; at: number }

function readPendingSend(): PendingSend | null {
  try {
    const raw = window.localStorage.getItem(PENDING_SEND_KEY);
    const pending = parsePendingSend(raw, Date.now());
    if (raw && !pending) window.localStorage.removeItem(PENDING_SEND_KEY);
    return pending;
  } catch {
    return null;
  }
}

function writePendingSend(pending: PendingSend | null) {
  try {
    if (pending) window.localStorage.setItem(PENDING_SEND_KEY, JSON.stringify(pending));
    else window.localStorage.removeItem(PENDING_SEND_KEY);
  } catch {
    /* storage full or blocked: the in-memory retry still works */
  }
}

/** An answer (or a definite refusal) arrived for this request: forget it, unless a newer send replaced it. */
function settlePendingSend(requestId: string) {
  if (readPendingSend()?.id === requestId) writePendingSend(null);
}

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

  async function send(again?: string) {
    const text = (again ?? input).trim();
    if (!text || sending.current) return;
    const updated: ShownMessage[] = [...messages, { role: "user", content: text }];
    if (updated.length > MAX_CHAT_MESSAGES || updated.reduce((n, m) => n + m.content.length, 0) > MAX_CHAT_CHARACTERS) {
      setError("This conversation is full. Start a new chat to continue.");
      return;
    }
    const previous = failedSend.current;
    let requestId: string | null = previous && previous.text === text && previous.at === messages.length ? previous.requestId : null;
    failedSend.current = null;
    setResendText(null);
    sending.current = true;
    setPending(text);
    setInput("");
    setError(null);
    setErrorReceipts([]);
    let written: WriteReceipt[] = [];
    let safe = replaySafe;
    let staleId = false;
    try {
      // The same conversation as a send whose answer never arrived (before a reload or a closed tab): the same request.
      const conv = await conversationKey(updated);
      if (!requestId && conv) {
        const stored = readPendingSend();
        if (stored?.conv === conv) requestId = stored.id;
      }
      if (!requestId) requestId = newRequestId();
      if (conv) writePendingSend({ conv, id: requestId, at: Date.now() });
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ request_id: requestId, messages: updated.map(({ role, content }) => ({ role, content })) }),
      });
      const data = await res.json().catch(() => null);
      written = parseReceipts(data?.receipts);
      if (data?.replay_safe === true) safe = true;
      else if (res.ok) safe = false;
      setReplaySafe(safe);
      if (res.redirected || res.status === 401) throw new Error("Your session may have expired. Sign in again.");
      // The server no longer accepts this id for this message: the next send starts a new request.
      if (res.status === 409 && data?.code === "request_conflict") {
        staleId = true;
        settlePendingSend(requestId);
      }
      if (!res.ok || typeof data?.response !== "string" || !data?.response.trim()) {
        throw new Error(typeof data?.error === "string" ? data.error : "Onyx could not finish this response.");
      }
      settlePendingSend(requestId);
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
          {resendText !== null && (
            <button type="button" onClick={() => void send(resendText)} disabled={loading} className="mt-2 text-sm text-accent border border-border-subtle rounded-control px-3 py-1.5 disabled:opacity-40">
              Send the same message again
            </button>
          )}
          <ChatReceipts receipts={errorReceipts} heading="Before it stopped, this request had already done the following" />
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
