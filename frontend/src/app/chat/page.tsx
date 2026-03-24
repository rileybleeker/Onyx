"use client";

import { useState, useRef, useEffect } from "react";

interface Message {
  role: "user" | "assistant";
  content: string;
}

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function send() {
    const text = input.trim();
    if (!text || loading) return;

    const userMsg: Message = { role: "user", content: text };
    const updated = [...messages, userMsg];
    setMessages(updated);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: updated.map((m) => ({
            role: m.role,
            content: m.content,
          })),
        }),
      });

      const data = await res.json();
      if (data.error) {
        setMessages([...updated, { role: "assistant", content: `Error: ${data.error}` }]);
      } else {
        setMessages([...updated, { role: "assistant", content: data.response }]);
      }
    } catch {
      setMessages([...updated, { role: "assistant", content: "Failed to connect to the API." }]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)] max-md:h-[calc(100vh-8rem)]">
      <div className="flex items-baseline justify-between mb-8">
        <div>
          <h2 className="text-[28px] font-medium text-text-primary">Chat with Onyx</h2>
          <p className="text-sm text-text-tertiary mt-0.5">Ask questions about your health data</p>
        </div>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto space-y-4 mb-4">
        {messages.length === 0 && (
          <div className="text-center mt-20">
            <p className="text-lg font-medium text-text-tertiary">Ask about your health data</p>
            <div className="mt-4 space-y-2 text-sm">
              <p className="text-text-tertiary/60">&quot;How did I sleep this week?&quot;</p>
              <p className="text-text-tertiary/60">&quot;What&apos;s my HRV trend looking like?&quot;</p>
              <p className="text-text-tertiary/60">&quot;Summarize my training load this month&quot;</p>
              <p className="text-text-tertiary/60">&quot;Am I overtraining?&quot;</p>
            </div>
          </div>
        )}

        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
                msg.role === "user"
                  ? "bg-accent text-white"
                  : "bg-surface-raised text-text-secondary border border-border-subtle"
              }`}
            >
              {msg.content}
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex justify-start">
            <div className="bg-surface-raised border border-border-subtle rounded-[6px] px-4 py-3 text-sm text-text-tertiary">
              <span className="animate-pulse">Thinking...</span>
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="flex gap-2">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && send()}
          placeholder="Ask about your health data..."
          className="flex-1 bg-surface-card border border-border-subtle rounded-[4px] px-4 py-3 text-sm text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent"
          disabled={loading}
        />
        <button
          onClick={send}
          disabled={loading || !input.trim()}
          className="bg-accent hover:bg-accent/90 disabled:opacity-40 disabled:hover:bg-accent text-white px-5 py-3 rounded-[4px] text-sm font-medium transition-colors"
        >
          Send
        </button>
      </div>
    </div>
  );
}
