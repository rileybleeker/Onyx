"use client";

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Search, CornerDownLeft, Settings2 } from "lucide-react";
import { NAV_ITEMS, type NavItem } from "@/lib/nav";
import { warmRoute } from "@/lib/warmup";
import { createGoShortcuts, goHint } from "@/lib/go-shortcuts";
import { useActiveRoute } from "./FeedContext";
import { personalizeNow } from "./personalize/start";

/** Fire this to open the palette from a button: window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE)) */
export const OPEN_COMMAND_PALETTE = "onyx:open-command-palette";

/** The palette's one action: Personalize the page on screen (listed when the page has personalizable parts). */
const PERSONALIZE_HREF = "#personalize";
const PERSONALIZE_ITEM: NavItem = {
  href: PERSONALIZE_HREF,
  label: "Personalize this page",
  shortcut: "",
  icon: Settings2,
  keywords: ["customize", "layout", "arrange", "move", "hide", "columns", "parts", "edit"],
};

function matches(item: NavItem, q: string): boolean {
  if (!q) return true;
  const hay = (item.label + " " + item.href + " " + (item.keywords ?? []).join(" ")).toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .every((tok) => hay.includes(tok));
}

/**
 * Global ⌘K / Ctrl+K command palette. Navigation-only (existing routes, no data
 * fetches) — searches the shared `nav.ts` source of truth. Also opens on the
 * custom `OPEN_COMMAND_PALETTE` window event (mobile top-bar search button).
 */
export default function CommandPalette() {
  const router = useRouter();
  // The page in view (follows the continuous scroll): marked in the list.
  const current = useActiveRoute();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const pointerSelect = useRef(false);
  // Ignore hover refreshes caused by rows scrolling under a stationary mouse.
  const lastPointer = useRef<string | null>(null);

  const results = useMemo(() => {
    const pages = NAV_ITEMS.filter((i) => matches(i, query));
    if (!matches(PERSONALIZE_ITEM, query)) return pages;
    // Typed for: first. Otherwise last, so Enter on an empty palette still opens the first page.
    return query.trim() ? [PERSONALIZE_ITEM, ...pages] : [...pages, PERSONALIZE_ITEM];
  }, [query]);

  const close = useCallback(() => {
    pointerSelect.current = false;
    setOpen(false);
    setQuery("");
    setActive(0);
  }, []);

  const go = useCallback(
    (item: NavItem | undefined) => {
      if (!item) return;
      close();
      if (item.href === PERSONALIZE_HREF) {
        personalizeNow();
        return;
      }
      router.push(item.href);
    },
    [close, router],
  );

  // Global open shortcut (⌘K / Ctrl+K) + custom event trigger.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    }
    function onOpen() {
      setOpen(true);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_COMMAND_PALETTE, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_COMMAND_PALETTE, onOpen);
    };
  }, []);

  // "Go to" shortcuts: G, then a page's key (lib/nav.ts), within 1.5 s. Client-side navigation onto the
  // warmed page. Ignored while typing or with a modifier held, so Ctrl/Cmd + K stays the palette's.
  useEffect(() => {
    const keys = createGoShortcuts(NAV_ITEMS);
    function onKey(e: KeyboardEvent) {
      const href = keys.onKey(e);
      if (!href) return;
      e.preventDefault();
      warmRoute(href);
      router.push(href);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);

  // Focus input + reset selection on open.
  useEffect(() => {
    if (open) {
      pointerSelect.current = false;
      lastPointer.current = null;
      setActive(0);
      const t = setTimeout(() => inputRef.current?.focus(), 10);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Warm the highlighted page so Enter lands on loaded data (the warm-up usually has it already).
  const highlighted = open ? results[active]?.href : undefined;
  useEffect(() => {
    if (!highlighted || highlighted.startsWith("#")) return;
    const t = setTimeout(() => warmRoute(highlighted), 120);
    return () => clearTimeout(t);
  }, [highlighted]);

  // Keep the active index within the (changing) result set.
  useEffect(() => {
    setActive((a) => Math.max(0, Math.min(a, results.length - 1)));
  }, [results.length]);

  // Reveal keyboard/filter selection without moving rows under the pointer.
  useEffect(() => {
    if (!open) return;
    if (pointerSelect.current) {
      pointerSelect.current = false;
      return;
    }
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [active, open, results]);

  if (!open) return null;

  function onListKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      pointerSelect.current = false;
      setActive((a) => Math.max(0, Math.min(a + 1, results.length - 1)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      pointerSelect.current = false;
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(results[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[18vh] px-4 bg-black/60 backdrop-blur-sm"
      onClick={close}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div
        className="w-full max-w-lg bg-surface-raised border border-border-default rounded-control shadow-floating overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 px-3.5 border-b border-border-subtle">
          <Search className="w-4 h-4 text-text-tertiary shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              pointerSelect.current = false;
              setQuery(e.target.value);
            }}
            onKeyDown={onListKey}
            placeholder="Jump to…"
            className="flex-1 bg-transparent py-3 text-[14px] text-text-primary placeholder:text-text-tertiary outline-none"
            aria-label="Search pages"
          />
          <kbd className="text-[10px] font-mono text-text-tertiary border border-border-subtle rounded px-1.5 py-0.5">ESC</kbd>
        </div>

        <ul ref={listRef} className="max-h-[52vh] overflow-y-auto py-1.5" role="listbox" aria-label="Pages">
          {results.length === 0 && (
            <li className="px-3.5 py-6 text-center text-[13px] text-text-tertiary">No matches</li>
          )}
          {results.map((item, i) => {
            const Icon = item.icon;
            const isActive = i === active;
            const isCurrent = item.href === current;
            return (
              <li key={item.href} role="option" aria-selected={isActive} aria-current={isCurrent ? "page" : undefined}>
                <button
                  type="button"
                  onMouseMove={(e) => {
                    const pos = `${e.clientX},${e.clientY}`;
                    const prev = lastPointer.current;
                    lastPointer.current = pos;
                    // First sample establishes position; only movement selects.
                    if (prev === null || prev === pos || i === active) return;
                    pointerSelect.current = true;
                    setActive(i);
                  }}
                  onClick={() => go(item)}
                  className={`w-full flex items-center gap-2.5 px-3.5 py-2 text-left text-[13px] transition-colors ${
                    isActive ? "bg-white/[0.06] text-text-primary" : "text-text-secondary"
                  }`}
                >
                  <Icon className={`w-4 h-4 shrink-0 ${isCurrent ? "text-accent" : "text-text-tertiary"}`} />
                  <span className="flex-1 truncate">{item.label}</span>
                  {isCurrent && <span className="text-[10px] font-mono uppercase tracking-[0.08em] text-accent">Here</span>}
                  {item.shortcut && <kbd className="hidden lg:inline text-[10px] font-mono text-text-tertiary border border-border-subtle rounded px-1.5 py-0.5" aria-label={`Shortcut G then ${item.shortcut}`}>{goHint(item.shortcut)}</kbd>}
                  <span className="text-[10px] font-mono text-text-tertiary/70">{item.href === PERSONALIZE_HREF ? "action" : item.href}</span>
                  {isActive && <CornerDownLeft className="w-3.5 h-3.5 text-text-tertiary" />}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
