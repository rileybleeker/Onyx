"use client";

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Search, CornerDownLeft } from "lucide-react";
import { NAV_ITEMS, type NavItem } from "@/lib/nav";

/** Fire this to open the palette from a button: window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE)) */
export const OPEN_COMMAND_PALETTE = "onyx:open-command-palette";

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
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const results = useMemo(() => NAV_ITEMS.filter((i) => matches(i, query)), [query]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setActive(0);
  }, []);

  const go = useCallback(
    (item: NavItem | undefined) => {
      if (!item) return;
      close();
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

  // Focus input + reset selection on open.
  useEffect(() => {
    if (open) {
      setActive(0);
      const t = setTimeout(() => inputRef.current?.focus(), 10);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Keep the active index within the (changing) result set.
  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, results.length - 1)));
  }, [results.length]);

  if (!open) return null;

  function onListKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
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
        className="w-full max-w-lg bg-surface-raised border border-border-default rounded-[6px] shadow-floating overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 px-3.5 border-b border-border-subtle">
          <Search className="w-4 h-4 text-text-tertiary shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onListKey}
            placeholder="Jump to…"
            className="flex-1 bg-transparent py-3 text-[14px] text-text-primary placeholder:text-text-tertiary outline-none"
            aria-label="Search pages"
          />
          <kbd className="text-[10px] font-mono text-text-tertiary border border-border-subtle rounded px-1.5 py-0.5">ESC</kbd>
        </div>

        <ul className="max-h-[52vh] overflow-y-auto py-1.5" role="listbox" aria-label="Pages">
          {results.length === 0 && (
            <li className="px-3.5 py-6 text-center text-[13px] text-text-tertiary">No matches</li>
          )}
          {results.map((item, i) => {
            const Icon = item.icon;
            const isActive = i === active;
            return (
              <li key={item.href} role="option" aria-selected={isActive}>
                <button
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => go(item)}
                  className={`w-full flex items-center gap-2.5 px-3.5 py-2 text-left text-[13px] transition-colors ${
                    isActive ? "bg-white/[0.06] text-text-primary" : "text-text-secondary"
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0 text-text-tertiary" />
                  <span className="flex-1 truncate">{item.label}</span>
                  <span className="text-[10px] font-mono text-text-tertiary/70">{item.href}</span>
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
