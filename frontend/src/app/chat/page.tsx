"use client";

import Link from "next/link";
import { useState, useRef, useEffect } from "react";
import { CHAT_EXAMPLES, MAX_CHAT_CHARACTERS, MAX_CHAT_MESSAGES, type ChatMessage } from "@/lib/chat-contract";

export default function ChatPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sending = useRef(false);
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

  async function send() {
    const text = input.trim();
    if (!text || sending.current) return;
    const updated: ChatMessage[] = [...messages, { role: "user", content: text }];
    if (updated.length > MAX_CHAT_MESSAGES || updated.reduce((n, m) => n + m.content.length, 0) > MAX_CHAT_CHARACTERS) {
      setError("This conversation is full. Start a new chat to continue.");
      return;
    }
    sending.current = true;
    setPending(text);
    setInput("");
    setError(null);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: updated }),
      });
      const data = await res.json().catch(() => null);
      if (res.redirected || res.status === 401) throw new Error("Your session may have expired. Sign in again.");
      if (!res.ok || typeof data?.response !== "string" || !data?.response.trim()) {
        throw new Error(typeof data?.error === "string" ? data.error : "Onyx could not finish this response.");
      }
      setMessages([...updated, { role: "assistant", content: data.response }]);
    } catch (err) {
      setInput(text);
      setError(`${err instanceof Error ? err.message : "Unable to connect to Onyx."} Your message is back in the composer. If it requested an action, check the relevant page before sending again.`);
    } finally {
      sending.current = false;
      setPending(null);
    }
  }

  function newChat() {
    if (sending.current) return;
    setMessages([]);
    setInput("");
    setError(null);
    inputRef.current?.focus();
  }

  const displayed: ChatMessage[] = pending === null ? messages : [...messages, { role: "user", content: pending }];

  return (
    <div className="flex flex-col h-[calc(100dvh-4rem)] max-md:h-[calc(100dvh-8rem)] min-h-0">
      <div className="flex items-start justify-between gap-3 mb-5 shrink-0">
        <div>
          <h2 className="text-[28px] font-medium text-text-primary">Chat with Onyx</h2>
          <p className="text-sm text-text-tertiary mt-0.5">Think, plan, write, or explore your connected data.</p>
          <p className="text-xs text-text-tertiary mt-2">Conversation stays on this page only. Reloading or leaving clears it. Tool actions are saved separately.</p>
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
            <p className="text-xs leading-relaxed text-text-tertiary mt-4">Connected tools cover health, habits, supplements, nutrition, journal, reading and Spotify. General help does not require a personal-data lookup.</p>
            <p className="text-xs leading-relaxed text-text-tertiary mt-2">This chat cannot browse the web, read email or texts, manage your calendar or tasks, or contact agents. For agent messages, open the <Link href="/agents" className="text-accent underline">Agents inbox</Link>.</p>
          </div>
        )}
        {displayed.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div className={`max-w-[90%] sm:max-w-[80%] break-words rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${msg.role === "user" ? "bg-accent text-white" : "bg-surface-raised text-text-secondary border border-border-subtle"}`}>
              <span className="sr-only">{msg.role === "user" ? "You: " : "Onyx: "}</span>{msg.content}
            </div>
          </div>
        ))}


        <div ref={bottomRef} />
      </div>

      {loading && <p role="status" className="text-sm text-text-tertiary mb-3 animate-pulse">Thinking...</p>}
      {error && <p role="alert" className="text-sm text-text-secondary bg-surface-raised border border-border-subtle rounded-lg p-3 mb-3">{error}</p>}
      <form onSubmit={(event) => { event.preventDefault(); void send(); }} className="flex gap-2 shrink-0">
        <label htmlFor="onyx-message" className="sr-only">Message Onyx</label>
        <textarea id="onyx-message" ref={inputRef} rows={2} value={input} onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia("(pointer: fine)").matches) { e.preventDefault(); void send(); } }}
          placeholder="Ask Onyx anything..." disabled={loading} maxLength={MAX_CHAT_CHARACTERS}
          className="flex-1 min-w-0 resize-none bg-surface-card border border-border-subtle rounded px-4 py-3 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent" />
        <button type="submit" disabled={loading || !input.trim()} className="bg-accent hover:bg-accent/90 disabled:opacity-40 text-white px-4 py-3 rounded text-sm font-medium">Send</button>
      </form>
      <p className="text-xs text-text-tertiary mt-2 shrink-0">Use Send to submit. On a keyboard: Enter sends, Shift+Enter adds a line.</p>
    </div>
  );
}
