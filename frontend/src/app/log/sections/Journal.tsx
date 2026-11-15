"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Check } from "lucide-react";
import InfoHint from "@/components/InfoHint";
import { cachedJson, clientCache } from "@/lib/client-cache";
import { sameJson } from "@/lib/format";
import { easternDate, JOURNAL_MAX_BODY_CHARS, JOURNAL_SOURCES, type JournalSource } from "@/lib/journal-entry";
import { journalTodayUrl } from "@/lib/journal-file";
import { useLogDrafts, type JournalLogDraft } from "@/lib/log-drafts";
import { DraftMark, LogCard, LogSaveButton } from "./ui";

/** This section holds /log's journal drafts, so the embedded check-in leaves out its own journal draft card (./CheckIn.tsx). */
export const REPLACES_CHECKIN_JOURNAL_DRAFT = true;

// /log Journal: write a journal entry from the same screen as every other entry (AGENTS.md "Log screen").
//   - The entry is typed, or dictated with the device's own dictation (keyboard microphone, Win+H). "Captured by"
//     follows that (voice when a whole phrase arrives in one go, typed otherwise) until Riley picks it himself.
//   - Save files it: POST /api/journal/file writes ONE page in the Notion journal with the words VERBATIM, today's
//     date (America/New_York), the source, and a title, mood, confidence and topics from one model call (or the
//     Say it box's labels while the words are unchanged). The page shows the Notion link at once; Onyx's Journal
//     gets the entry on the next hourly sync (journal_etl.py at :35).
//   - Today's entries already in Onyx: GET /api/journal/list for today (journalTodayUrl), through the shared client
//     cache (memory only: journal text never goes to disk, see isSensitiveKey) and the /log warm-up.
//   - A draft (useLogDrafts("journal"): the Say it box, or the embedded check-in's own Say it once) fills an empty
//     box; over words Riley already typed it is offered, never forced. Nothing is written until Save.

type TodayEntry = { notion_page_id: string; title: string | null; mood: string | null; topics: string[] | null };
type ListAnswer = { entries: TodayEntry[] };
type Saved = { title: string; url: string | null; existing: boolean };

const checkList = (data: unknown) => {
  if (!data || typeof data !== "object" || !Array.isArray((data as ListAnswer).entries)) throw new Error("bad journal list");
};

const MOOD_BADGE: Record<string, string> = {
  low: "bg-down/10 text-down border-down/30",
  neutral: "bg-white/5 text-text-secondary border-border-default",
  good: "bg-source-garmin/10 text-source-garmin border-source-garmin/30",
  great: "bg-up/10 text-up border-up/30",
};

const notionLink = (pageId: string) => `https://www.notion.so/${pageId.replace(/-/g, "")}`;

/**
 * Did this input put a whole dictated phrase in at once? Typing adds a character (or one predicted / swiped word);
 * dictation adds several words in one event. Paste does not count.
 */
export function looksDictated(ev: Event): boolean {
  const ie = ev as InputEvent;
  if (typeof ie.inputType !== "string") return false;
  if (ie.inputType === "insertFromDictation") return true;
  if (ie.inputType !== "insertText" && ie.inputType !== "insertReplacementText" && ie.inputType !== "insertCompositionText") return false;
  const data = (ie.data ?? ie.dataTransfer?.getData("text/plain") ?? "").trim();
  return /\S+\s+\S+\s+\S/.test(data);
}

export default function JournalSection() {
  const [url, setUrl] = useState(() => journalTodayUrl(new Date()));
  const urlRef = useRef(url);
  urlRef.current = url;
  const [list, setList] = useState<ListAnswer | null>(() => clientCache.peek<ListAnswer>(url) ?? null);
  const [listFailed, setListFailed] = useState(false);

  const [body, setBody] = useState("");
  const [source, setSource] = useState<JournalSource>("typed");
  const sourcePinned = useRef(false); // Riley picked "Captured by" himself: dictation detection stops
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<Saved | null>(null);

  // The Say it box's draft: applied once per id. `applied` = the draft in the box now (its labels count only while
  // the words are exactly the draft's); `offered` = a draft held back because Riley had already typed something.
  const { draft, clear } = useLogDrafts("journal");
  const [applied, setApplied] = useState<{ id: number; value: JournalLogDraft } | null>(null);
  const [offered, setOffered] = useState<{ id: number; value: JournalLogDraft } | null>(null);
  const seenDraft = useRef(0);
  const bodyRef = useRef(body);
  bodyRef.current = body;

  // The day rolls over while the screen is open: the list (and the entry's date) follow the New York calendar.
  useEffect(() => {
    const check = () => setUrl(journalTodayUrl(new Date()));
    const onVisible = () => document.visibilityState === "visible" && check();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", check);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", check);
    };
  }, []);

  const loadList = useCallback(async (u: string) => {
    try {
      const data = await cachedJson<ListAnswer>(u, { check: checkList });
      if (u !== urlRef.current) return; // the day rolled over meanwhile
      setList((prev) => (sameJson(prev, data) ? prev : data));
      setListFailed(false);
    } catch {
      if (u === urlRef.current) setListFailed(true);
    }
  }, []);

  // Show the cached copy at once (memory, then the persisted store), then revalidate. GET only.
  useEffect(() => {
    let live = true;
    const hit = clientCache.peek<ListAnswer>(url);
    setList(hit ?? null);
    if (!hit) {
      void clientCache.read<ListAnswer>(url).then((v) => {
        if (!live || !v) return;
        try {
          checkList(v);
          setList((cur) => cur ?? v);
        } catch {
          /* a bad cached copy is ignored; the fetch below replaces it */
        }
      });
    }
    void loadList(url);
    return () => {
      live = false;
    };
  }, [url, loadList]);

  useEffect(() => {
    if (!draft || draft.id === seenDraft.current) return;
    seenDraft.current = draft.id;
    const value = draft.value;
    if (!value.body.trim()) return;
    if (bodyRef.current.trim() && bodyRef.current.trim() !== value.body.trim()) {
      setOffered({ id: draft.id, value }); // never over words Riley typed
      return;
    }
    setBody(value.body);
    if (!sourcePinned.current) setSource(value.source);
    setApplied({ id: draft.id, value });
    setOffered(null);
    setSaved(null);
    setError(null);
  }, [draft]);

  const takeOffered = (mode: "replace" | "add") => {
    if (!offered) return;
    const words = offered.value.body;
    if (mode === "replace") {
      setBody(words);
      setApplied({ id: offered.id, value: offered.value });
    } else {
      setBody((cur) => `${cur.trimEnd()}\n\n${words}`);
      setApplied(null); // mixed words: the draft's labels no longer describe them
    }
    if (!sourcePinned.current) setSource(offered.value.source);
    setOffered(null);
  };

  const dismissOffered = () => {
    if (!offered) return;
    clear(offered.id);
    setOffered(null);
  };

  const onInput = (e: FormEvent<HTMLTextAreaElement>) => {
    if (!sourcePinned.current && looksDictated(e.nativeEvent)) setSource("voice");
  };

  const onChange = (text: string) => {
    setBody(text);
    setError(null);
    if (saved) setSaved(null);
    if (!text.trim() && !sourcePinned.current) setSource("typed");
  };

  const pickSource = (s: JournalSource) => {
    sourcePinned.current = true;
    setSource(s);
  };

  // Labels from the Say it box count only while the words are exactly the ones they were made for.
  const draftLabels = applied && applied.value.body.trim() === body.trim() ? applied.value : null;

  const save = async () => {
    const words = body.trim();
    if (!words || saving) return;
    setSaving(true);
    setError(null);
    const labels = draftLabels
      ? {
          title: draftLabels.title || undefined,
          mood: draftLabels.mood ?? undefined,
          confidence: draftLabels.confidence ?? undefined,
          topics: draftLabels.topics.length ? draftLabels.topics : undefined,
        }
      : {};
    try {
      const res = await fetch("/api/journal/file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: words, source, date: easternDate(new Date()), ...labels }),
      });
      const json = (await res.json().catch(() => null)) as { url?: unknown; title?: unknown; existing?: unknown; error?: unknown } | null;
      if (!res.ok || !json) {
        setError(typeof json?.error === "string" ? json.error : `Couldn't save the entry (${res.status}). It is still here.`);
        return;
      }
      setSaved({ title: typeof json.title === "string" ? json.title : "", url: typeof json.url === "string" ? json.url : null, existing: !!json.existing });
      if (applied) clear(applied.id);
      setApplied(null);
      setBody("");
      sourcePinned.current = false;
      setSource("typed");
      void loadList(urlRef.current); // unchanged until the hourly sync; refreshed so a sync that just ran shows it
    } catch {
      setError("Couldn't reach Onyx. The entry is still here.");
    } finally {
      setSaving(false);
    }
  };

  const discardDraft = () => {
    if (!applied) return;
    clear(applied.id);
    if (body.trim() === applied.value.body.trim()) setBody("");
    setApplied(null);
  };

  const entries = list?.entries ?? [];
  const label = "block text-[11px] font-mono uppercase tracking-wider text-text-tertiary";

  return (
    <LogCard title="Journal">
      <div className="space-y-4">
        <div>
          <div className="flex items-center gap-1.5">
            <span className={label}>Today</span>
            <InfoHint label="today's journal entries">
              Entries in Onyx for today (New York date). A new entry shows here, and on Journal, after the hourly sync.
            </InfoHint>
          </div>
          {list ? (
            entries.length ? (
              <ul className="mt-1 divide-y divide-border-subtle rounded-control border border-border-subtle">
                {entries.map((e) => (
                  <li key={e.notion_page_id} className="flex items-center gap-2 px-3 py-2">
                    <a href={notionLink(e.notion_page_id)} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate text-[14px] text-text-primary hover:text-accent">
                      {e.title?.trim() || "Untitled"}
                    </a>
                    {e.mood && <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded border ${MOOD_BADGE[e.mood] || ""}`}>{e.mood}</span>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-[13px] text-text-tertiary">No journal entries today yet.</p>
            )
          ) : listFailed ? (
            <p role="alert" className="mt-1 text-[13px] text-down">Couldn&apos;t load today&apos;s entries.</p>
          ) : (
            <div aria-hidden="true" className="mt-1 skeleton h-11 rounded-control" />
          )}
          {list && listFailed && <p className="mt-1 text-[12px] text-text-tertiary">Couldn&apos;t refresh; showing the last list.</p>}
        </div>

        {saved && (
          <p role="status" className="text-[13px] text-text-secondary inline-flex flex-wrap items-center gap-1.5">
            <Check className="w-4 h-4 text-up" />
            {saved.existing ? "Already in your journal" : "Saved to your journal"}
            {saved.title ? <>: <span className="text-text-primary">{saved.title}</span>.</> : "."} It shows on Journal after the hourly sync.
            {saved.url && (
              <a href={saved.url} target="_blank" rel="noreferrer" className="text-accent underline underline-offset-2">
                Open in Notion
              </a>
            )}
          </p>
        )}

        {offered && (
          <div className="rounded-control border border-dashed border-accent/60 p-3">
            <DraftMark />
            <p className="mt-1 whitespace-pre-wrap text-[13px] text-text-secondary line-clamp-4">{offered.value.body}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" onClick={() => takeOffered("add")} className="min-h-11 px-3 rounded-control border border-border-subtle text-[13px] text-text-primary">
                Add to entry
              </button>
              <button type="button" onClick={() => takeOffered("replace")} className="min-h-11 px-3 rounded-control border border-border-subtle text-[13px] text-text-primary">
                Use instead
              </button>
              <button type="button" onClick={dismissOffered} className="min-h-11 px-3 rounded-control text-[13px] text-text-secondary">
                Dismiss
              </button>
            </div>
          </div>
        )}

        <div>
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="log-journal-body" className={label}>
              New entry
            </label>
            {draftLabels && <DraftMark />}
          </div>
          <textarea
            id="log-journal-body"
            value={body}
            rows={5}
            maxLength={JOURNAL_MAX_BODY_CHARS}
            disabled={saving}
            onInput={onInput}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Type, or use the keyboard microphone."
            className="mt-1 w-full rounded-control border border-border-subtle bg-transparent p-2 text-[14px] text-text-primary disabled:opacity-60"
          />
          {draftLabels?.title && (
            <p className="mt-1 text-[12px] text-text-tertiary">
              Title: <span className="text-text-secondary">{draftLabels.title}</span>
              {draftLabels.mood ? ` · ${draftLabels.mood}` : ""}
              {draftLabels.topics.length ? ` · ${draftLabels.topics.join(", ")}` : ""}
            </p>
          )}
        </div>

        <div role="group" aria-label="Captured by">
          <div className={label}>Captured by</div>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {JOURNAL_SOURCES.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={source === s}
                disabled={saving}
                onClick={() => pickSource(s)}
                className={`min-h-11 px-3 rounded-control border text-[13px] font-medium transition-colors ${
                  source === s ? "bg-accent/20 border-accent/70 text-accent" : "border-border-subtle text-text-secondary"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        {error && <p role="alert" className="text-[12px] text-down">{error}</p>}
        <div className="flex flex-wrap items-center gap-3">
          <LogSaveButton onClick={() => void save()} disabled={!body.trim()} saving={saving} />
          {applied && (
            <button type="button" onClick={discardDraft} disabled={saving} className="min-h-11 px-3 rounded-control text-[13px] text-text-secondary disabled:opacity-50">
              Discard
            </button>
          )}
          <InfoHint label="how a journal entry is saved">
            Save files the entry in your Notion journal with your words as written and today&apos;s date. The title, mood,
            confidence and topics are filled in for you; change them in Notion if needed.
          </InfoHint>
        </div>
      </div>
    </LogCard>
  );
}
