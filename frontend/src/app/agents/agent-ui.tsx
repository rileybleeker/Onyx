"use client";

import { Check, ExternalLink } from "lucide-react";
import type { AgentCard, CardState } from "@/lib/agents-api";

// Shared pieces of the Agents inbox and conversations: who each agent is, avatars, time labels, cards.

const AGENTS: Record<string, { name: string; about: string; color: string }> = {
  onyx: { name: "Onyx", about: "reminders, questions, anything", color: "#16E07A" },
  briefing: { name: "Morning briefing", about: "your day at 8:30", color: "#FFD23F" },
  coordinator: { name: "Coordinator", about: "goals and tasks", color: "#9A7BFA" },
  "nyc-scout": { name: "NYC scout", about: "apartment leads", color: "#5B8DF6" },
  devops: { name: "DevOps", about: "apps, deploys, fixes", color: "#F5A623" },
  "inbox-triage": { name: "Inbox triage", about: "email that needs you", color: "#22D3A6" },
  "weekly-review": { name: "Weekly review", about: "how the agents did", color: "#33B5F5" },
  finance: { name: "Finance", about: "money", color: "#1ED760" },
  household: { name: "Household", about: "supplies and orders", color: "#FF8A65" },
  "morning-brief": { name: "Morning brief", about: "daily summary", color: "#FFD23F" },
  "dst-shift": { name: "DST shift", about: "clock change", color: "#9AA0A6" },
};

export function agentInfo(id: string): { name: string; about: string; color: string } {
  const known = AGENTS[id];
  if (known) return known;
  const name = id.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  return { name, about: "agent", color: "#9AA0A6" };
}

export function Avatar({ thread, size = 40 }: { thread: string; size?: number }) {
  const { name, color } = agentInfo(thread);
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
  return (
    <div
      className="shrink-0 rounded-full flex items-center justify-center font-semibold"
      style={{ width: size, height: size, background: `${color}26`, color, fontSize: size * 0.36, border: `1px solid ${color}40` }}
      aria-hidden
    >
      {initials}
    </div>
  );
}

export function parseUtc(s: string): Date {
  return new Date(s.replace(" ", "T") + "Z");
}

export function dayLabel(d: Date): string {
  const today = new Date();
  const y = new Date();
  y.setDate(today.getDate() - 1);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return "Today";
  if (same(d, y)) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

export function timeLabel(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** Messages-app style: time today, "Yesterday", weekday this week, else a date. */
export function listTime(d: Date): string {
  const label = dayLabel(d);
  if (label === "Today") return timeLabel(d);
  if (label === "Yesterday") return label;
  if (Date.now() - d.getTime() < 6 * 86400_000) return d.toLocaleDateString(undefined, { weekday: "long" });
  return d.toLocaleDateString(undefined, { month: "numeric", day: "numeric", year: "2-digit" });
}

const URL_RE = /(https?:\/\/[^\s<>"')\]]+)/g;

export function Linkified({ text }: { text: string }) {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <a key={i} href={p} target="_blank" rel="noreferrer" className="underline underline-offset-2 break-all">
            {p}
          </a>
        ) : (
          <span key={i}>{p}</span>
        )
      )}
    </>
  );
}

export type CardAction = { label: string; text?: string; reply?: boolean; primary?: boolean };

export function cardActions(card: AgentCard): CardAction[] {
  const t = card.type.toLowerCase();
  if (t === "approval") return [{ label: "Approve", text: `${card.code} yes`, primary: true }, { label: "Decline", text: `${card.code} no` }, { label: "Reply", reply: true }];
  if (t === "lead") return [{ label: "Interested", text: `${card.code} interested`, primary: true }, { label: "Pass", text: `${card.code} no` }, { label: "Reply", reply: true }];
  if (t === "question") return [{ label: "Reply", reply: true, primary: true }, { label: "Done", text: `${card.code} done` }];
  return [{ label: "Reply", reply: true, primary: true }];
}

/** What Riley sees on a card that no longer needs them: from their own reply when known, else the server state. */
export function settledLabel(reply: string | undefined, state: CardState | undefined): string | null {
  if (reply !== undefined) {
    if (/^(yes|y|ok|okay|approve)/i.test(reply)) return "Approved";
    if (/^(no|n|nope|decline|skip|pass)/i.test(reply)) return "Declined";
    if (/^done/i.test(reply)) return "Marked done";
    if (/^interested/i.test(reply)) return "Interested";
    return `You replied: ${reply.length > 60 ? reply.slice(0, 60) + "…" : reply}`;
  }
  switch (state) {
    case "approve":
      return "Approved";
    case "decline":
      return "Declined";
    case "answer":
      return "Answered";
    case "complete":
      return "Marked done";
    case "closed":
      return "Closed by the agent";
    case "expired":
      return "Expired";
    default:
      return null;
  }
}

export function CardBody({ card, clamp = false }: { card: AgentCard; clamp?: boolean }) {
  const exp = card.expires ? new Date(card.expires) : null;
  return (
    <>
      <p className="text-[15px] font-medium text-text-primary leading-snug">{card.name}</p>
      {card.details && (
        <p className={`mt-1 text-[14px] text-text-secondary leading-relaxed whitespace-pre-wrap break-words ${clamp ? "line-clamp-3" : ""}`}>
          <Linkified text={card.details} />
        </p>
      )}
      {(card.link || (exp && !Number.isNaN(exp.getTime()))) && (
        <div className="mt-2 flex items-center gap-3 text-[12px] text-text-tertiary">
          {card.link && (
            <a href={card.link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent" onClick={(e) => e.stopPropagation()}>
              Open <ExternalLink className="w-3 h-3" />
            </a>
          )}
          {exp && !Number.isNaN(exp.getTime()) && <span>Expires {exp.toLocaleDateString(undefined, { month: "short", day: "numeric" })}</span>}
        </div>
      )}
    </>
  );
}

export function CardButtons({ card, settled, onSend, onReply }: { card: AgentCard; settled: string | null; onSend: (t: string) => void; onReply: (code: string) => void }) {
  if (settled)
    return (
      <div className="px-4 py-2.5 border-t border-border-subtle text-[13px] text-text-secondary flex items-center gap-1.5">
        <Check className="w-3.5 h-3.5 text-accent" /> {settled}
      </div>
    );
  return (
    <div className="flex border-t border-border-subtle divide-x divide-border-subtle">
      {cardActions(card).map((a) => (
        <button
          key={a.label}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (a.reply) onReply(card.code);
            else if (a.text) onSend(a.text);
          }}
          className={`flex-1 py-3 text-[14px] font-medium active:bg-surface-hover transition-colors ${a.primary ? "text-accent" : "text-text-secondary"}`}
        >
          {a.label}
        </button>
      ))}
    </div>
  );
}
