"use client";

import { useEffect, useState, useMemo } from "react";

interface JournalEntryListItem {
  notion_page_id: string;
  entry_date: string;
  title: string | null;
  mood: string | null;
  source: string | null;
  confidence: string | null;
  topics: string[] | null;
  word_count: number | null;
  notion_edited_at: string | null;
  snippet: string;
  truncated: boolean;
}

interface JournalEntryFull extends JournalEntryListItem {
  content_md: string;
}

const MOODS = ["low", "neutral", "good", "great"] as const;
type Mood = (typeof MOODS)[number];

const MOOD_BADGE: Record<string, string> = {
  low: "bg-red-500/10 text-red-300 border-red-500/30",
  neutral: "bg-zinc-500/10 text-zinc-300 border-zinc-500/30",
  good: "bg-blue-500/10 text-blue-300 border-blue-500/30",
  great: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
};

function formatDate(iso: string): string {
  const d = new Date(iso + "T00:00:00");
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function JournalPage() {
  const [entries, setEntries] = useState<JournalEntryListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [moodFilter, setMoodFilter] = useState<Mood | null>(null);
  const [topicFilter, setTopicFilter] = useState<string | null>(null);
  const [from, setFrom] = useState<string>("");
  const [to, setTo] = useState<string>("");

  const [expanded, setExpanded] = useState<string | null>(null);
  const [fullEntry, setFullEntry] = useState<JournalEntryFull | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams();
    if (moodFilter) params.set("mood", moodFilter);
    if (topicFilter) params.set("topic", topicFilter);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    params.set("limit", "200");

    setLoading(true);
    setError(null);
    fetch(`/api/journal/list?${params}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.error) {
          setError(data.error);
          setEntries([]);
        } else {
          setEntries(data.entries || []);
        }
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [moodFilter, topicFilter, from, to]);

  // Unique topics from currently loaded entries (chip palette).
  const allTopics = useMemo(() => {
    const s = new Set<string>();
    entries.forEach((e) => (e.topics || []).forEach((t) => s.add(t)));
    return Array.from(s).sort();
  }, [entries]);

  async function toggleExpand(id: string) {
    if (expanded === id) {
      setExpanded(null);
      setFullEntry(null);
      return;
    }
    setExpanded(id);
    setLoadingFull(true);
    setFullEntry(null);
    try {
      const r = await fetch(`/api/journal/${id}`);
      const data = await r.json();
      setFullEntry(data.entry);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoadingFull(false);
    }
  }

  return (
    <div className="px-4 md:px-6 py-4 md:py-6 max-w-4xl mx-auto pt-[max(1rem,env(safe-area-inset-top))] md:pt-6">
      <header className="mb-6 ml-12 md:ml-0">
        <h1 className="text-xl md:text-2xl font-semibold text-text-primary tracking-tight">
          Journal
        </h1>
        <p className="text-xs md:text-sm text-text-tertiary mt-1">
          Personal entries synced from Notion. {entries.length} {entries.length === 1 ? "entry" : "entries"}.
        </p>
      </header>

      {/* Filter bar */}
      <div className="bg-surface-card border border-border-subtle rounded-[6px] p-3 md:p-4 mb-4 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-text-tertiary uppercase tracking-wider">Mood</span>
          <button
            onClick={() => setMoodFilter(null)}
            className={`text-[12px] px-2 py-1 rounded border transition-colors ${
              moodFilter === null
                ? "bg-white/10 text-text-primary border-border-subtle"
                : "text-text-secondary border-transparent hover:bg-white/[0.03]"
            }`}
          >
            all
          </button>
          {MOODS.map((m) => (
            <button
              key={m}
              onClick={() => setMoodFilter(moodFilter === m ? null : m)}
              className={`text-[12px] px-2 py-1 rounded border transition-colors ${
                moodFilter === m
                  ? MOOD_BADGE[m]
                  : "text-text-secondary border-transparent hover:bg-white/[0.03]"
              }`}
            >
              {m}
            </button>
          ))}
        </div>

        {allTopics.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-text-tertiary uppercase tracking-wider">Topic</span>
            <button
              onClick={() => setTopicFilter(null)}
              className={`text-[12px] px-2 py-1 rounded border transition-colors ${
                topicFilter === null
                  ? "bg-white/10 text-text-primary border-border-subtle"
                  : "text-text-secondary border-transparent hover:bg-white/[0.03]"
              }`}
            >
              all
            </button>
            {allTopics.map((t) => (
              <button
                key={t}
                onClick={() => setTopicFilter(topicFilter === t ? null : t)}
                className={`text-[12px] px-2 py-1 rounded border transition-colors ${
                  topicFilter === t
                    ? "bg-accent/10 text-accent border-accent/30"
                    : "text-text-secondary border-transparent hover:bg-white/[0.03]"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-text-tertiary uppercase tracking-wider">Date</span>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="text-[12px] bg-surface-base border border-border-subtle rounded px-2 py-1 text-text-primary"
            aria-label="from"
          />
          <span className="text-[12px] text-text-tertiary">→</span>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="text-[12px] bg-surface-base border border-border-subtle rounded px-2 py-1 text-text-primary"
            aria-label="to"
          />
          {(from || to) && (
            <button
              onClick={() => { setFrom(""); setTo(""); }}
              className="text-[12px] text-text-tertiary hover:text-text-primary px-2 py-1"
            >
              clear
            </button>
          )}
        </div>
      </div>

      {/* Entry list */}
      {loading ? (
        <div className="text-text-tertiary text-sm">Loading…</div>
      ) : error ? (
        <div className="text-red-300 text-sm">Error: {error}</div>
      ) : entries.length === 0 ? (
        <div className="text-text-tertiary text-sm">No entries match these filters.</div>
      ) : (
        <ul className="space-y-2">
          {entries.map((e) => {
            const isOpen = expanded === e.notion_page_id;
            return (
              <li
                key={e.notion_page_id}
                className="bg-surface-card border border-border-subtle rounded-[6px] overflow-hidden"
              >
                <button
                  onClick={() => toggleExpand(e.notion_page_id)}
                  className="w-full text-left px-4 py-3 hover:bg-white/[0.02] transition-colors"
                >
                  <div className="flex items-baseline gap-3 flex-wrap">
                    <span className="text-[12px] font-mono text-text-tertiary shrink-0">
                      {formatDate(e.entry_date)}
                    </span>
                    {e.mood && (
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded border ${MOOD_BADGE[e.mood] || ""}`}
                      >
                        {e.mood}
                      </span>
                    )}
                    {e.source && (
                      <span className="text-[10px] font-mono text-text-tertiary">
                        {e.source}
                      </span>
                    )}
                    <span className="text-[11px] text-text-tertiary ml-auto">
                      {e.word_count ?? 0} words
                    </span>
                  </div>
                  {e.title && (
                    <div className="mt-1 text-[14px] font-medium text-text-primary">
                      {e.title}
                    </div>
                  )}
                  {(e.topics || []).length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {(e.topics || []).map((t) => (
                        <span
                          key={t}
                          className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.04] text-text-secondary"
                        >
                          {t}
                        </span>
                      ))}
                    </div>
                  )}
                  {!isOpen && e.snippet && (
                    <p className="mt-2 text-[13px] text-text-secondary leading-relaxed line-clamp-2">
                      {e.snippet}
                      {e.truncated && "…"}
                    </p>
                  )}
                </button>

                {isOpen && (
                  <div className="px-4 pb-4 border-t border-border-subtle pt-3 bg-black/10">
                    {loadingFull ? (
                      <div className="text-text-tertiary text-sm">Loading full entry…</div>
                    ) : fullEntry ? (
                      <div className="prose prose-invert max-w-none text-[14px] text-text-secondary leading-relaxed whitespace-pre-wrap">
                        {fullEntry.content_md}
                      </div>
                    ) : (
                      <div className="text-text-tertiary text-sm">No content.</div>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
