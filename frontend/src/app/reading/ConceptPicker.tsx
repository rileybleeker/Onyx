"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { clientCache } from "@/lib/client-cache";
import { conceptOptions, parseIdeaTitles } from "@/lib/reading";
import { getJson, getJsonShared } from "@/lib/reading-practice-client";
import { sameJson } from "@/lib/format";

/**
 * The concept tags of the highlight form (READ-QUIZ-01 S7): the book's own (pds.books.theme, none by default) plus the
 * titles of the question-bank ideas the book's highlights are linked to (GET /api/reading/idea-titles).
 *
 * The titles are a cached read like any other: one key (the URL), memory only (never written to the device, gone with
 * the rest of the client cache on sign-out), shown at once from the cache and read again on every mount. The database
 * applies the spoiler gate, so a title the gate no longer allows has to leave the screen the moment the gate moves,
 * not when the next answer arrives. What the picker shows therefore belongs to ONE stamp (the key, the overview's
 * numbers, and how many writes dropped the entry) and is hidden the instant the stamp changes:
 * - any write to the reading area (a "Not read yet" hold, a flag, a rebuild) drops the cache entry (writeInvalidates);
 *   the listener counts it synchronously, so the picker empties on the next render and reads again, and the answer to
 *   a read that started earlier is thrown away even when it comes back before React has rendered;
 * - the overview's own numbers moving (`signature`: the gate, the stage counts, the chapter states) do the same;
 * - a read that fails or answers anything but 200 is stored as no titles, so it never keeps a title that is gone.
 */
const IDEA_TITLES_MAX_AGE_MS = 300_000;
const NO_TITLES: string[] = [];
const CUSTOM = "__custom";

export const ideaTitlesUrl = (slug: string) => `/api/reading/idea-titles?book=${encodeURIComponent(slug)}`;
const titlesOf = (raw: unknown): string[] => (raw && typeof raw === "object" ? parseIdeaTitles((raw as { titles?: unknown }).titles) : NO_TITLES);
const stampOf = (url: string, signature: string, writes: number) => `${url}\n${signature}\n${writes}`;

/**
 * The linked idea titles for the picker. A plain GET with no side effect, made only while the book's questions are on
 * (nothing to read otherwise).
 */
export function useLinkedIdeaTitles(slug: string, on: boolean, signature: string): string[] {
  const url = ideaTitlesUrl(slug);
  // What an answer has to match to be kept. `writes` is bumped by the cache listener itself, before React renders.
  const now = useRef({ url, signature, writes: 0 });
  now.current.url = url;
  now.current.signature = signature;
  const [seen, setSeen] = useState(0);
  const stamp = stampOf(url, signature, seen);
  const [got, setGot] = useState<{ stamp: string; titles: string[] }>(() => ({ stamp, titles: on ? titlesOf(clientCache.peek(url)) : NO_TITLES }));
  const firstRead = useRef(true);
  useEffect(() => {
    if (!on) return;
    return clientCache.subscribe(url, (v) => {
      if (v !== undefined) return;
      now.current.writes += 1;
      setSeen(now.current.writes);
    });
  }, [url, on]);
  useEffect(() => {
    const mine = stampOf(url, signature, seen);
    if (!on) {
      setGot((prev) => (prev.stamp === mine && prev.titles.length === 0 ? prev : { stamp: mine, titles: NO_TITLES }));
      return;
    }
    let live = true;
    // An entry has to exist for a write to remove it (and so tell this read to drop its answer): hold the place.
    if (clientCache.peek(url) === undefined) clientCache.put(url, { titles: [] }, { persist: false, maxAgeMs: IDEA_TITLES_MAX_AGE_MS });
    // The read at mount may join the same read another part started a moment ago; a read after a write never does.
    const first = firstRead.current;
    firstRead.current = false;
    void (first ? getJsonShared(url) : getJson(url)).then((r) => {
      const c = now.current;
      // Out of date: this read was replaced, or a write or a new signature came in since it started.
      if (!live || c.url !== url || c.signature !== signature || c.writes !== seen) return;
      const next = r.status === 200 && r.body && typeof r.body === "object" ? titlesOf(r.body) : NO_TITLES;
      // Memory only; an answer with no titles is stored as such, so a failed read never keeps a title that is gone.
      clientCache.put(url, { titles: next }, { persist: false, maxAgeMs: IDEA_TITLES_MAX_AGE_MS });
      setGot((prev) => (prev.stamp === mine && sameJson(prev.titles, next) ? prev : { stamp: mine, titles: next }));
    });
    return () => {
      live = false;
    };
  }, [url, on, signature, seen]);
  return on && got.stamp === stamp ? got.titles : NO_TITLES;
}

/**
 * The concept select. `value` is "" (none), a tag, or "__custom" (the form then shows its own text box). A tag that is
 * chosen but not offered right now (its title left the list, or the list is being read again) stays in the list, so
 * the select keeps showing what is stored.
 */
export default function ConceptPicker({
  slug,
  on,
  signature,
  themeConcepts,
  value,
  onChange,
}: {
  slug: string;
  on: boolean;
  signature: string;
  themeConcepts: readonly string[] | null | undefined;
  value: string;
  onChange: (value: string) => void;
}) {
  const ideaTitles = useLinkedIdeaTitles(slug, on, signature);
  const concepts = useMemo(() => conceptOptions(themeConcepts, ideaTitles), [themeConcepts, ideaTitles]);
  const kept = value !== "" && value !== CUSTOM && !concepts.includes(value);
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="bg-white/[0.03] border border-border-subtle rounded-control px-2 py-2 text-[13px] text-text-primary"
      aria-label="Concept"
    >
      <option value="">Concept (optional)</option>
      {kept && <option value={value}>{value}</option>}
      {concepts.map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
      <option value={CUSTOM}>Other…</option>
    </select>
  );
}
