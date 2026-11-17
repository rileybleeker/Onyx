"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, LogOut, Search } from "lucide-react";
import { createSupabaseBrowser } from "@/lib/supabase-browser";
import { NAV_ITEMS, NAV_SECTIONS, type NavItem } from "@/lib/nav";
import { wipeClientData } from "@/lib/client-cache";
import { navIntentProps } from "@/lib/warmup";
import { goHint } from "@/lib/go-shortcuts";
import { OPEN_COMMAND_PALETTE } from "./CommandPalette";
import { InstallAppButton, ReloadAppButton, usePaletteShortcutLabel } from "./DesktopApp";
import { useActiveRoute, useRevealActiveNavItem } from "./FeedContext";
import PersonalizeButton from "./personalize/PersonalizeButton";
import type { EditorModule } from "./personalize/editor-loader";
import {
  areaId, arrangeNav, dropNavBootStyle, navBootScript, orderNav, savedAreaPrefs, subscribeAreaIds,
} from "@/lib/nav-areas";
import { currentEditingKey, editorRef, subscribeTargets } from "@/lib/personalize-registry";

const SIDEBAR_LIST_SELECTOR = 'nav[data-nav-list="sidebar"]';
// Paints Riley's saved order (Personalize, `layout.areas`) before React runs on a full page load.
const NAV_BOOT = navBootScript(NAV_SECTIONS);
const noPrefs = () => null;
const none = () => null;

export default function Sidebar() {
  // The page in view: the routed page, or the page the continuous scroll has reached ("/" counts as Today).
  const current = useActiveRoute();
  const paletteKey = usePaletteShortcutLabel();
  // Keep the active item visible in the scrolling list as the continuous scroll moves through the pages.
  useRevealActiveNavItem(SIDEBAR_LIST_SELECTOR, current);

  // Riley's side panel (Personalize, `layout.areas`: order, Quick access pins, hidden pages; the continuous scroll
  // follows the same order). Server render and hydration use the default; the inline script below has already
  // painted the saved panel, which React then renders.
  const prefs = useSyncExternalStore(subscribeAreaIds, savedAreaPrefs, noPrefs);
  useEffect(() => {
    if (prefs !== null) dropNavBootStyle();
  }, [prefs]);
  const editing = useSyncExternalStore(subscribeTargets, currentEditingKey, none) !== null;
  const editor = useSyncExternalStore(subscribeTargets, editorRef, none) as EditorModule | null;
  const [showHidden, setShowHidden] = useState(false);

  // Every destination is rendered in Quick access AND in its section and shown where Riley put it, so the pre-paint
  // script can show a saved panel before React runs without moving anything. Off copies carry data-off and
  // display:none; no destination is removed (hidden pages are listed under "Show hidden").
  const arranged = arrangeNav(NAV_SECTIONS, prefs);
  const pinnedHrefs = new Set(arranged.pinned.map((item) => item.href));
  const hiddenHrefs = new Set(arranged.hidden.map((item) => item.href));
  const quickItems = [...arranged.pinned, ...NAV_ITEMS.filter((item) => !pinnedHrefs.has(item.href))];
  const librarySections = orderNav(NAV_SECTIONS, prefs?.order ?? null);
  const offInSection = (href: string) => pinnedHrefs.has(href) || hiddenHrefs.has(href);

  function renderLink(item: NavItem, where: "quick" | "section" | "hidden", off = false) {
    const active = current === item.href && !off;
    const Icon = item.icon;
    const id = areaId(item.href);
    // No viewport prefetch: the scheduled warm-up (components/AppData.tsx) loads every page in idle time,
    // and hover / focus / pointer-down warm this one at once.
    return (
      <Link
        key={item.href}
        href={item.href}
        data-nav-quick={where === "quick" ? id : undefined}
        data-nav-area={where === "section" ? id : undefined}
        data-off={off ? "true" : undefined}
        aria-current={active ? "page" : undefined}
        {...navIntentProps(item.href)}
        className={`${off ? "hidden" : "flex"} items-center gap-2.5 px-3 py-2 rounded-control text-[13px] font-medium transition-colors relative focus:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
          active
            ? "bg-surface-raised text-text-primary"
            : "text-text-secondary hover:text-text-primary hover:bg-white/[0.03]"
        }`}
      >
        <Icon className={`w-[17px] h-[17px] shrink-0 ${active ? "text-accent" : "text-text-tertiary"}`} strokeWidth={1.75} />
        <span className="flex-1 truncate">{item.label}</span>
        <kbd className="text-[10px] font-mono text-text-tertiary/60 ml-auto hidden lg:inline" title={`Press G, then ${item.shortcut}`}>
          {goHint(item.shortcut)}
        </kbd>
      </Link>
    );
  }

  async function handleSignOut() {
    const supabase = createSupabaseBrowser();
    await supabase.auth.signOut();
    // Nothing of this session stays on the device: cached data, its IndexedDB store, drafts.
    await wipeClientData();
    // A full load, not router.push: it also drops the router's in-memory page cache (prefetched pages).
    window.location.assign("/login");
  }

  return (
    <aside data-side-panel="" className="fixed inset-y-0 left-0 z-50 w-[220px] bg-surface-sunken border-r border-border-subtle flex flex-col max-md:hidden">
      <script dangerouslySetInnerHTML={{ __html: NAV_BOOT }} />
      <div className="shrink-0 px-5 py-5 border-b border-border-subtle">
        {/* The wordmark, not a heading: each page's own title is its one h1. */}
        <p className="flex items-center gap-2 text-[20px] font-bold lowercase leading-none tracking-[0.01em] text-text-primary"><img src="/icons/logo-mark-64.png?v=4" width={30} height={30} alt="" aria-hidden="true" className="shrink-0" />Onyx</p>
        <p className="text-[11px] text-text-tertiary mt-1.5 font-mono">Personal OS</p>
      </div>

      {/* Command palette trigger */}
      <div className="shrink-0 px-2 pt-3">
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE))}
          data-palette-trigger=""
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-control text-[13px] text-text-tertiary bg-white/[0.02] border border-border-subtle hover:border-border-hover hover:text-text-secondary transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          <Search className="w-[15px] h-[15px] shrink-0" />
          <span className="flex-1 text-left">Search…</span>
          <kbd className="text-[10px] font-mono text-text-tertiary/70">{paletteKey}</kbd>
        </button>
      </div>

      {editing && editor ? (
        // Personalize mode: drag pages within a section, or sections, to rearrange (components/personalize/NavArranger.tsx).
        <editor.SidebarArranger current={current} />
      ) : (
        <>
          <nav aria-label="Quick access" className="shrink-0 px-2 py-3 border-b border-border-subtle flex flex-col gap-0.5">
            {quickItems.map((item) => renderLink(item, "quick", !pinnedHrefs.has(item.href)))}
          </nav>

          <nav aria-label="All sections" className="flex-1 min-h-0 px-2 py-3 overflow-y-auto flex flex-col" data-nav-list="sidebar">
            {librarySections.map((section) => {
              const empty = section.items.every((item) => offInSection(item.href));
              return (
                <div key={section.title} data-nav-section={section.index} className={`${empty ? "hidden" : "block"} shrink-0 mb-3 last:mb-0`}>
                  <p className="px-3 pb-1 text-[10px] font-mono uppercase tracking-[0.14em] text-text-tertiary">
                    {section.title}
                  </p>
                  <div className="flex flex-col gap-0.5">
                    {section.items.map((item) => renderLink(item, "section", offInSection(item.href)))}
                  </div>
                </div>
              );
            })}
            {arranged.hidden.length > 0 && (
              // Pages hidden in Personalize stay one click away. Always last (its order beats the pre-paint rules).
              <div className="shrink-0" style={{ order: 9999 }}>
                <button
                  type="button"
                  onClick={() => setShowHidden((v) => !v)}
                  aria-expanded={showHidden}
                  className="w-full flex items-center gap-1.5 px-3 py-1.5 rounded-control text-[10px] font-mono uppercase tracking-[0.14em] text-text-tertiary hover:text-text-secondary focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
                >
                  {showHidden ? <ChevronDown className="w-3 h-3" aria-hidden /> : <ChevronRight className="w-3 h-3" aria-hidden />}
                  Show hidden ({arranged.hidden.length})
                </button>
                {showHidden && <div className="flex flex-col gap-0.5 opacity-80">{arranged.hidden.map((item) => renderLink(item, "hidden"))}</div>}
              </div>
            )}
          </nav>
        </>
      )}

      <div className="shrink-0 px-2 py-3 border-t border-border-subtle">
        <InstallAppButton />
        <ReloadAppButton />
        <PersonalizeButton className="flex items-center gap-2.5 px-3 py-2 rounded-control text-[13px] font-medium text-text-secondary hover:text-text-primary hover:bg-white/[0.03] transition-colors w-full focus:outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:text-accent disabled:hover:bg-transparent" />
        <button
          onClick={handleSignOut}
          className="flex items-center gap-2.5 px-3 py-2 rounded-control text-[13px] font-medium text-text-secondary hover:text-text-primary hover:bg-white/[0.03] transition-colors w-full focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          <LogOut className="w-[17px] h-[17px] shrink-0" strokeWidth={1.75} />
          Sign out
        </button>
      </div>
    </aside>
  );
}
