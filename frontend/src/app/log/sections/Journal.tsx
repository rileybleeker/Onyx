"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { AutosaveStatus } from "@/components/AutosaveStatus";
import { useInFeed } from "@/components/FeedContext";
import InfoHint from "@/components/InfoHint";
import { AutosaveRefused } from "@/lib/autosave";
import { cachedJson, clientCache } from "@/lib/client-cache";
import { sameJson } from "@/lib/format";
import { easternDate, JOURNAL_CONFIDENCES, JOURNAL_MAX_BODY_CHARS, JOURNAL_MOODS, JOURNAL_SOURCES, type JournalSource } from "@/lib/journal-entry";
import {
  JOURNAL_MAX_KNOWN_PARAS,
  JOURNAL_MAX_KNOWN_SHA,
  JOURNAL_UNSAVED_KEY,
  journalParaHashes,
  journalTodayUrl,
  journalVersionSha,
  journalWordCount,
  mergeHashes,
  normalizePageId,
  parseUnsavedJournal,
  SHA_RE,
  shouldRelabel,
  type FiledJournalEntry,
  type JournalLabels,
  type UnsavedJournal,
} from "@/lib/journal-file";
import { useLogDrafts, type JournalLogDraft } from "@/lib/log-drafts";
import { logEarlyGet } from "@/lib/log-early";
import { useAutosave } from "@/lib/use-autosave";
import { useUnsavedWork } from "@/lib/use-unsaved-work";
import { DraftMark, LogCard } from "./ui";

/** This section holds /log's journal drafts, so the embedded check-in leaves out its own journal draft card (./CheckIn.tsx). */
export const REPLACES_CHECKIN_JOURNAL_DRAFT = true;

// /log Journal: write a journal entry from the same screen as every other entry (AGENTS.md "Log screen").
//   - The entry is typed, or dictated with the device's own dictation (keyboard microphone, Win+H). "Captured by"
//     follows that (voice when a whole phrase arrives in one go, typed otherwise) until Riley picks it himself.
//   - Autosave (2026-11-15), no Save button. A few seconds after Riley stops typing, or when he leaves the box or
//     the page, the entry is filed by itself: POST /api/journal/file writes ONE page in the Notion journal with the
//     words VERBATIM, today's date (America/New_York), the source, and a title, mood, confidence and topics from one
//     model call (or the Say it box's labels while the words are unchanged). Writing on in the same box updates THAT
//     page (PATCH /api/journal/file/[pageId], only the paragraphs that changed; labels re-inferred only when the
//     entry changed a lot, never over a label changed in Notion), never a second one; "New entry" starts the next.
//     A page edited in Notion meanwhile is not overwritten: Riley chooses Replace or File as a new entry.
//   - Until the words are saved they are also kept on this device (localStorage JOURNAL_UNSAVED_KEY, an "onyx"
//     key wiped on sign-out; removed as soon as they are saved), so a reload or a closed tab never loses them. Before
//     EVERY send the copy also records that version's hash, its paragraph hashes and the entry's day (synchronously:
//     a send started by a closing tab cannot wait), so a save whose answer never came is found again: a restored
//     entry is filed on its own day and the server finds the page by hash (no duplicate entry, no false "changed in
//     Notion"). Words restored that way, and a Say it draft the model picked out, are filed only after Keep or an
//     edit (nothing is written on open or on scroll); they are never dropped except by Discard / Dismiss. A
//     "journal:" note from the Say it box (draft.asked) is filed by itself.
//   - Today's entries already in Onyx: GET /api/journal/list for today (journalTodayUrl), through the shared client
//     cache (memory only: journal text never goes to disk there, see isSensitiveKey) and the /log warm-up; entries
//     filed from this box are listed at once, before the hourly sync (journal_etl.py at :35) brings them in.

type TodayEntry = { notion_page_id: string; title: string | null; mood: string | null; topics: string[] | null };
type ListAnswer = { entries: TodayEntry[] };
/** What autosave sends. `rev` changes only to send the same words again on purpose (Replace / File as new). */
type Words = { body: string; source: JournalSource; rev: number };
/** Words in the box that are not filed until Keep or an edit. */
type Held = "draft" | "restored" | null;
type Conflict = "changed" | "gone" | null;

const FIRST_FILE_DELAY_MS = 5000;
const UPDATE_DELAY_MS = 3000;
const TAP_DELAY_MS = 800;

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
const dayOfUrl = (url: string) => /from=(\d{4}-\d{2}-\d{2})/.exec(url)?.[1] ?? "";

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

function labelsFrom(json: Record<string, unknown>, fallback?: JournalLabels): JournalLabels {
  const mood = (JOURNAL_MOODS as readonly unknown[]).includes(json.mood) ? (json.mood as JournalLabels["mood"]) : (fallback?.mood ?? null);
  const confidence = (JOURNAL_CONFIDENCES as readonly unknown[]).includes(json.confidence) ? (json.confidence as JournalLabels["confidence"]) : (fallback?.confidence ?? null);
  return {
    title: typeof json.title === "string" ? json.title : (fallback?.title ?? ""),
    mood,
    confidence,
    topics: Array.isArray(json.topics) ? json.topics.filter((t): t is string => typeof t === "string") : (fallback?.topics ?? []),
  };
}

const readLocal = (): UnsavedJournal | null => {
  try {
    const raw = localStorage.getItem(JOURNAL_UNSAVED_KEY);
    if (raw === null) return null;
    const rec = parseUnsavedJournal(raw, Date.now());
    if (!rec) localStorage.removeItem(JOURNAL_UNSAVED_KEY);
    return rec;
  } catch {
    return null;
  }
};
const writeLocal = (rec: UnsavedJournal | null) => {
  try {
    if (rec) localStorage.setItem(JOURNAL_UNSAVED_KEY, JSON.stringify(rec));
    else localStorage.removeItem(JOURNAL_UNSAVED_KEY);
  } catch {
    /* storage full or blocked: the words are still on screen and the autosave still runs */
  }
};

export default function JournalSection() {
  const [url, setUrl] = useState(() => journalTodayUrl(new Date()));
  const urlRef = useRef(url);
  urlRef.current = url;
  const [list, setList] = useState<ListAnswer | null>(() => clientCache.peek<ListAnswer>(url) ?? null);
  const [listFailed, setListFailed] = useState(false);

  const [body, setBody] = useState("");
  const bodyRef = useRef(body);
  bodyRef.current = body;
  const [source, setSourceState] = useState<JournalSource>("typed");
  const sourceRef = useRef(source);
  const setSource = (s: JournalSource) => {
    sourceRef.current = s;
    setSourceState(s);
  };
  const sourcePinned = useRef(false); // Riley picked "Captured by" himself: dictation detection stops

  // The entry this box keeps up to date once filed (none of its words, only how to find and check the page).
  const [filed, setFiledState] = useState<FiledJournalEntry | null>(null);
  const filedRef = useRef<FiledJournalEntry | null>(null);
  const setFiled = (f: FiledJournalEntry | null) => {
    filedRef.current = f;
    setFiledState(f);
  };
  /** Versions sent and not confirmed yet (registered BEFORE each send): their hashes and paragraph hashes. */
  const knownRef = useRef<string[]>([]);
  const knownParasRef = useRef<string[]>([]);
  /** The entry's day, fixed by its first send (or by the restored copy): every later attempt files on it. */
  const entryDateRef = useRef<string | null>(null);
  const forceRef = useRef(false);
  const revRef = useRef(0);
  const [held, setHeldState] = useState<Held>(null);
  const heldRef = useRef<Held>(null);
  const setHeld = (h: Held) => {
    heldRef.current = h;
    setHeldState(h);
  };
  const [conflict, setConflict] = useState<Conflict>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // What the server holds now: the device copy goes once the box equals it.
  const saved = useRef<{ body: string; source: JournalSource } | null>(null);
  const [savedTick, setSavedTick] = useState(0);
  // Entries filed from this box, listed until the hourly sync brings them into Today's list.
  const [filedHere, setFiledHere] = useState<{ id: string; date: string; title: string; mood: string | null }[]>([]);

  // The Say it box's draft: applied once per id. `applied` = the draft in the box now (its labels count only while
  // the words are exactly the draft's); `offered` = a draft held back because the box already had words.
  const { draft, clear } = useLogDrafts("journal");
  const [applied, setAppliedState] = useState<{ id: number; value: JournalLogDraft } | null>(null);
  const appliedRef = useRef<typeof applied>(null);
  const setApplied = (a: typeof applied) => {
    appliedRef.current = a;
    setAppliedState(a);
  };
  const [offered, setOffered] = useState<{ id: number; value: JournalLogDraft } | null>(null);
  const seenDraft = useRef(0);

  /** The device copy as it stands now (refs only, so it can be written right before a send). */
  const persistNow = () => {
    const text = bodyRef.current;
    if (!text.trim() || heldRef.current === "draft") return;
    writeLocal({
      v: 1,
      at: Date.now(),
      body: text,
      source: sourceRef.current,
      pinned: sourcePinned.current,
      filed: filedRef.current,
      date: entryDateRef.current,
      known: knownRef.current,
      knownParas: knownParasRef.current,
    });
  };

  /**
   * Before a send: this version's hash and paragraph hashes join the unconfirmed ones and the device copy is written,
   * all synchronously (the hook's pagehide flush calls fetch in the same task). If the answer never comes, the next
   * attempt, in this tab or a restored one, recognises the page by them.
   */
  const registerSend = (words: string) => {
    knownRef.current = mergeHashes([knownRef.current, [journalVersionSha(words)]], JOURNAL_MAX_KNOWN_SHA - 1);
    knownParasRef.current = mergeHashes([knownParasRef.current, journalParaHashes(words)], JOURNAL_MAX_KNOWN_PARAS / 2);
    persistNow();
  };

  /** One request of the autosave. 4xx = refused (shown, not retried); offline / 5xx = retried. */
  const send = async (target: string, method: "POST" | "PATCH", payload: unknown, keepalive: boolean) => {
    const res = await fetch(target, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload), keepalive });
    const json = ((await res.json().catch(() => null)) ?? {}) as Record<string, unknown>;
    if (res.ok) return json;
    const msg = typeof json.error === "string" && json.error ? json.error : `Couldn't save the entry (${res.status}). It is still here.`;
    if (res.status === 409 && json.changed) {
      setConflict("changed");
      throw new AutosaveRefused(msg);
    }
    if (res.status === 410 && json.gone) {
      setConflict("gone");
      throw new AutosaveRefused(msg);
    }
    if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) throw new AutosaveRefused(msg);
    throw new Error(msg);
  };

  const update = async (f: FiledJournalEntry, w: Words, keepalive: boolean): Promise<FiledJournalEntry> => {
    const relabel = shouldRelabel(f.labeledWords, journalWordCount(w.body));
    registerSend(w.body);
    const payload = {
      body: w.body,
      source: w.source,
      known_sha: [f.sha, ...knownRef.current.filter((s) => s !== f.sha)].slice(0, JOURNAL_MAX_KNOWN_SHA),
      known_paras: mergeHashes([f.paras, knownParasRef.current], JOURNAL_MAX_KNOWN_PARAS),
      ...(forceRef.current ? { force: true } : {}),
      ...(relabel ? { relabel: true, last_labels: f.labels } : {}),
    };
    const json = await send(`/api/journal/file/${encodeURIComponent(f.id)}`, "PATCH", payload, keepalive);
    const sha = typeof json.sha === "string" && SHA_RE.test(json.sha) ? json.sha : f.sha;
    return {
      ...f,
      sha,
      paras: journalParaHashes(w.body),
      url: typeof json.url === "string" && json.url.startsWith("https://") ? json.url : f.url,
      labels: labelsFrom(json, f.labels),
      labeledWords: json.relabeled === true ? journalWordCount(w.body) : f.labeledWords,
    };
  };

  const autosave = useAutosave<Words>("journal", {
    delayMs: FIRST_FILE_DELAY_MS,
    ready: (w) => (w.body ? null : "An entry can't be empty. Type something, or start a new entry."),
    save: async (w, { keepalive }) => {
      let f = filedRef.current;
      if (!f) {
        const a = appliedRef.current;
        const labels = a && a.value.body.trim() === w.body
          ? {
              title: a.value.title || undefined,
              mood: a.value.mood ?? undefined,
              confidence: a.value.confidence ?? undefined,
              topics: a.value.topics.length ? a.value.topics : undefined,
            }
          : {};
        // Hashes of earlier sends of this entry whose answer never came (before this one is registered): a page of
        // the entry's day holding one of them is this entry (findRetriedEntry), so a lost answer never duplicates it.
        const known = knownRef.current.slice(0, JOURNAL_MAX_KNOWN_SHA);
        const date = entryDateRef.current ?? easternDate(new Date());
        entryDateRef.current = date;
        registerSend(w.body);
        const json = await send("/api/journal/file", "POST", { body: w.body, source: w.source, date, ...labels, ...(known.length ? { known_sha: known } : {}) }, keepalive);
        const id = normalizePageId(json.id);
        const sha = typeof json.sha === "string" && SHA_RE.test(json.sha) ? json.sha : null;
        if (!id || !sha) throw new AutosaveRefused("Notion didn't say which page it saved. Check Journal, then start a new entry.");
        f = {
          id,
          url: typeof json.url === "string" && json.url.startsWith("https://") ? json.url : null,
          date: typeof json.date === "string" ? json.date : date,
          sha,
          // A page found holding an earlier version: its paragraphs are unknown here (its hash is enough).
          paras: json.stale === true ? [] : journalParaHashes(w.body),
          labels: labelsFrom(json),
          // A page found holding an earlier version: its labels came from fewer words, so the update relabels.
          labeledWords: json.stale === true ? 0 : journalWordCount(w.body),
        };
        knownRef.current = [];
        knownParasRef.current = [];
        entryDateRef.current = f.date;
        setFiled(f);
        const entry = f;
        setFiledHere((cur) => (cur.some((e) => e.id === entry.id) ? cur : [...cur, { id: entry.id, date: entry.date, title: entry.labels.title, mood: entry.labels.mood }]));
        if (a) {
          clear(a.id);
          setApplied(null);
        }
        if (json.stale === true) {
          f = await update(f, w, keepalive); // that page holds an earlier version: bring it up to date
          setFiled(f);
        }
      } else {
        f = await update(f, w, keepalive);
        setFiled(f);
      }
      knownRef.current = [];
      knownParasRef.current = [];
      forceRef.current = false;
      setConflict(null);
      const entry = f;
      setFiledHere((cur) => cur.map((e) => (e.id === entry.id ? { ...e, title: entry.labels.title, mood: entry.labels.mood } : e)));
      saved.current = { body: w.body, source: w.source };
      setSavedTick((t) => t + 1);
    },
  });

  /** The box changed: autosave it (or nothing to save: an empty box that was never filed). */
  const push = (text: string, src: JournalSource, delayMs?: number) => {
    const words = text.trim();
    if (!words && !filedRef.current) {
      autosave.reset();
      if (!knownRef.current.length) entryDateRef.current = null; // nothing was sent: the next words start a new day
      return;
    }
    autosave.change({ body: words, source: src, rev: revRef.current }, { delayMs: delayMs ?? (filedRef.current ? UPDATE_DELAY_MS : FIRST_FILE_DELAY_MS) });
  };

  // Words not filed yet (held), or not saved yet, keep the automatic updater from reloading (Onyx#326). The autosave
  // registers its own waiting / saving / failed states.
  useUnsavedWork(held !== null && body.trim() !== "", "journal-held");

  // The device copy: written while the box holds words the server does not have, removed as soon as it does.
  // A Say it draft not kept yet stays memory-only, like every draft (lib/log-drafts.ts).
  const restoredOnce = useRef(false);
  useEffect(() => {
    if (!restoredOnce.current) return; // not before the restore below has looked
    const words = body.trim();
    const s = saved.current;
    if (!words || held === "draft" || (held === null && s && s.body === words && s.source === source && !knownRef.current.length)) {
      writeLocal(null);
      return;
    }
    persistNow();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, source, filed, held, savedTick]);

  // Words left unsaved by a reload or a closed tab come back, waiting for Keep (nothing is written on open).
  useEffect(() => {
    const rec = readLocal();
    restoredOnce.current = true;
    if (!rec || bodyRef.current.trim()) return;
    setBody(rec.body);
    setSource(rec.source);
    sourcePinned.current = rec.pinned;
    setFiled(rec.filed);
    knownRef.current = rec.known;
    knownParasRef.current = rec.knownParas;
    entryDateRef.current = rec.filed?.date ?? rec.date;
    setHeld("restored");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The day rolls over while the screen is open: the list follows the New York calendar (a filed entry keeps its day).
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

  // The routed page's first read takes the GET its HTML already started (lib/log-early.ts), once.
  const routed = !useInFeed();
  const loadList = useCallback(async (u: string) => {
    try {
      const data = await cachedJson<ListAnswer>(u, { check: checkList, get: logEarlyGet(u, routed) });
      if (u !== urlRef.current) return; // the day rolled over meanwhile
      setList((prev) => (sameJson(prev, data) ? prev : data));
      setListFailed(false);
    } catch {
      if (u === urlRef.current) setListFailed(true);
    }
  }, [routed]);

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
    const words = value.body.trim();
    if (!words) return;
    const cur = bodyRef.current.trim();
    if (cur === words) {
      if (!filedRef.current) setApplied({ id: draft.id, value }); // same words: its labels may still apply
      return;
    }
    if (cur || filedRef.current) {
      setOffered({ id: draft.id, value }); // never over words in the box, nor over an entry being kept up to date
      return;
    }
    setBody(value.body);
    const src = sourcePinned.current ? sourceRef.current : value.source;
    setSource(src);
    setApplied({ id: draft.id, value });
    setOffered(null);
    setNotice(null);
    if (value.asked) {
      setHeld(null); // "journal: ..." = Riley asked for an entry: filed by itself
      push(value.body, src, TAP_DELAY_MS);
    } else {
      setHeld("draft"); // a reflection the model picked out: offered, filed after Keep or an edit
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  /**
   * Start the next entry. What the box holds is saved first, restored words included (only Discard drops those);
   * if that save does not go through, nothing is cleared.
   */
  const startNew = async (): Promise<boolean> => {
    if (heldRef.current === "restored" && bodyRef.current.trim()) {
      setHeld(null);
      push(bodyRef.current, sourceRef.current, 0);
    }
    const allSaved = await autosave.flush();
    const words = bodyRef.current.trim();
    const s = saved.current;
    if (words && heldRef.current !== "draft" && (!allSaved || !s || s.body !== words || s.source !== sourceRef.current)) {
      setNotice("This entry isn't saved yet, so it stays here. Try again once it says Saved.");
      return false;
    }
    autosave.reset();
    setBody("");
    setFiled(null);
    knownRef.current = [];
    knownParasRef.current = [];
    entryDateRef.current = null;
    forceRef.current = false;
    saved.current = null;
    setHeld(null);
    setConflict(null);
    setNotice(null);
    setApplied(null);
    sourcePinned.current = false;
    setSource("typed");
    writeLocal(null);
    return true;
  };

  const takeOffered = async (mode: "replace" | "add") => {
    if (!offered) return;
    const { id, value } = offered;
    setOffered(null);
    if (mode === "replace") {
      if (heldRef.current === "draft") {
        // "Use instead": this suggestion replaces the one not kept yet (never sent, nothing of Riley's is lost).
        if (appliedRef.current) clear(appliedRef.current.id);
        autosave.reset();
      } else if ((filedRef.current || bodyRef.current.trim()) && !(await startNew())) {
        // "New entry with these words": what the box holds is saved first (restored words too) and stays its own
        // entry; if it cannot be saved, nothing changes.
        setOffered({ id, value });
        return;
      }
      setBody(value.body);
      setApplied({ id, value });
      const src = sourcePinned.current ? sourceRef.current : value.source;
      setSource(src);
      setHeld(null);
      push(value.body, src, TAP_DELAY_MS);
    } else {
      const next = `${bodyRef.current.trimEnd()}\n\n${value.body}`;
      setBody(next);
      setApplied(null); // mixed words: the draft's labels no longer describe them
      clear(id);
      setHeld(null);
      push(next, sourceRef.current, TAP_DELAY_MS);
    }
  };

  const dismissOffered = () => {
    if (!offered) return;
    clear(offered.id);
    setOffered(null);
  };

  /** Keep: the held words (a Say it draft, or words restored from this device) are filed like typed ones. */
  const keep = () => {
    setHeld(null);
    push(bodyRef.current, sourceRef.current, 0);
  };

  /** Dismiss the held words. A restored entry that was already filed keeps its last saved words in Notion. */
  const dropHeld = () => {
    if (held === "draft" && applied) clear(applied.id);
    setApplied(null);
    autosave.reset();
    setBody("");
    setFiled(null);
    knownRef.current = [];
    knownParasRef.current = [];
    entryDateRef.current = null;
    saved.current = null;
    setHeld(null);
    sourcePinned.current = false;
    setSource("typed");
    writeLocal(null);
  };

  const onInput = (e: FormEvent<HTMLTextAreaElement>) => {
    if (!sourcePinned.current && looksDictated(e.nativeEvent)) setSource("voice");
  };

  const onChange = (text: string) => {
    setBody(text);
    setNotice(null);
    if (!text.trim() && !sourcePinned.current && !filedRef.current) setSource("typed");
    if (held) setHeld(null); // an edit keeps the held words
    push(text, sourceRef.current);
  };

  const pickSource = (s: JournalSource) => {
    sourcePinned.current = true;
    setSource(s);
    if (!held && bodyRef.current.trim()) push(bodyRef.current, s, TAP_DELAY_MS);
  };

  /** After "changed": write over the Notion page with the words here. */
  const replaceInNotion = () => {
    forceRef.current = true;
    revRef.current += 1;
    setConflict(null);
    push(bodyRef.current, sourceRef.current, 0);
  };

  /** After "changed" or "gone": file the words here as a new entry (the other page stays as it is). */
  const fileAsNew = () => {
    setFiled(null);
    knownRef.current = [];
    knownParasRef.current = [];
    entryDateRef.current = null;
    forceRef.current = false;
    revRef.current += 1;
    setConflict(null);
    push(bodyRef.current, sourceRef.current, 0);
  };

  // Labels from the Say it box count only while the words are exactly the ones they were made for.
  const draftLabels = !filed && applied && applied.value.body.trim() === body.trim() ? applied.value : null;
  const day = dayOfUrl(url);
  const listed = new Set((list?.entries ?? []).map((e) => normalizePageId(e.notion_page_id)));
  const entries: TodayEntry[] = [
    ...(list?.entries ?? []),
    ...filedHere.filter((e) => e.date === day && !listed.has(e.id)).map((e) => ({ notion_page_id: e.id, title: e.title || null, mood: e.mood, topics: null })),
  ];
  const label = "block text-[11px] font-mono uppercase tracking-wider text-text-tertiary";
  const showStatus = !held && autosave.state.status !== "idle";

  return (
    <LogCard title="Journal">
      <div className="space-y-4">
        <div>
          <div className="flex items-center gap-1.5">
            <span className={label}>Today</span>
            <InfoHint label="today's journal entries">
              Entries for today (New York date). One filed here shows at once; on Journal it shows after the hourly sync.
            </InfoHint>
          </div>
          {list || entries.length ? (
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

        {offered && (
          <div className="rounded-control border border-dashed border-accent/60 p-3">
            <DraftMark />
            <p className="mt-1 whitespace-pre-wrap text-[13px] text-text-secondary line-clamp-4">{offered.value.body}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" onClick={() => void takeOffered("add")} className="min-h-11 px-3 rounded-control border border-border-subtle text-[13px] text-text-primary">
                Add to entry
              </button>
              <button type="button" onClick={() => void takeOffered("replace")} className="min-h-11 px-3 rounded-control border border-border-subtle text-[13px] text-text-primary">
                {held === "draft" ? "Use instead" : "New entry with these words"}
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
              {filed ? "Entry" : "New entry"}
            </label>
            {held === "draft" && <DraftMark />}
          </div>
          <textarea
            id="log-journal-body"
            value={body}
            rows={5}
            maxLength={JOURNAL_MAX_BODY_CHARS}
            onInput={onInput}
            onChange={(e) => onChange(e.target.value)}
            onBlur={() => {
              if (!held) void autosave.flush();
            }}
            placeholder="Type, or use the keyboard microphone. It saves by itself."
            className="mt-1 w-full rounded-control border border-border-subtle bg-transparent p-2 text-[14px] text-text-primary"
          />
          {draftLabels?.title && (
            <p className="mt-1 text-[12px] text-text-tertiary">
              Title: <span className="text-text-secondary">{draftLabels.title}</span>
              {draftLabels.mood ? ` · ${draftLabels.mood}` : ""}
              {draftLabels.topics.length ? ` · ${draftLabels.topics.join(", ")}` : ""}
            </p>
          )}
          {held && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <p className="text-[12px] text-text-secondary">
                {held === "draft"
                  ? "From what you said. Not in your journal until you keep it."
                  : "Words from your last visit that may not be saved yet. Keep saves them (never as a second entry); Discard leaves your journal as it is."}
              </p>
              <button type="button" onClick={keep} className="min-h-11 px-4 rounded-full text-[13px] font-semibold bg-accent text-on-accent">
                Keep
              </button>
              <button type="button" onClick={dropHeld} className="min-h-11 px-3 rounded-control text-[13px] text-text-secondary">
                {held === "draft" ? "Dismiss" : "Discard"}
              </button>
            </div>
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

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {showStatus && (
            <AutosaveStatus
              state={autosave.state}
              onRetry={conflict ? undefined : () => void autosave.retry()}
              showIncomplete={!!filed}
              savedText={filed?.labels.title ? `Saved to journal: ${filed.labels.title}` : "Saved to journal"}
            />
          )}
          {filed?.url && !held && autosave.state.status === "saved" && (
            <a href={filed.url} target="_blank" rel="noreferrer" className="min-h-11 inline-flex items-center text-[12px] text-accent underline underline-offset-2">
              Open in Notion
            </a>
          )}
          {conflict && autosave.state.status === "error" && (
            <span className="flex flex-wrap gap-2">
              {conflict === "changed" && (
                <button type="button" onClick={replaceInNotion} className="min-h-11 px-3 rounded-control border border-border-subtle text-[13px] text-text-primary">
                  Replace it with these words
                </button>
              )}
              <button type="button" onClick={fileAsNew} className="min-h-11 px-3 rounded-control border border-border-subtle text-[13px] text-text-primary">
                File as a new entry
              </button>
            </span>
          )}
          {filed && !held && (
            <button type="button" onClick={() => void startNew()} className="min-h-11 px-3 rounded-control border border-border-subtle text-[13px] text-text-primary">
              New entry
            </button>
          )}
          <InfoHint label="how a journal entry is saved">
            Your words are filed in your Notion journal by themselves, a few seconds after you stop typing or when you
            leave the box, with today&apos;s date and your words exactly as written. Writing on updates the same entry; New
            entry starts the next one. The title, mood, confidence and topics are filled in for you; a change you make to
            them in Notion is never overwritten.
          </InfoHint>
        </div>
        {notice && <p role="alert" className="text-[12px] text-down">{notice}</p>}
      </div>
    </LogCard>
  );
}
