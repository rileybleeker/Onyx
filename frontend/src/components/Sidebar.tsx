"use client";

import Link from "next/link";
import { LogOut, Search } from "lucide-react";
import { createSupabaseBrowser } from "@/lib/supabase-browser";
import { NAV_SECTIONS, type NavItem } from "@/lib/nav";
import { wipeClientData } from "@/lib/client-cache";
import { navIntentProps } from "@/lib/warmup";
import { goHint } from "@/lib/go-shortcuts";
import { OPEN_COMMAND_PALETTE } from "./CommandPalette";
import { InstallAppButton, ReloadAppButton, usePaletteShortcutLabel } from "./DesktopApp";
import { useActiveRoute, useRevealActiveNavItem } from "./FeedContext";
import PersonalizeButton from "./personalize/PersonalizeButton";

const SIDEBAR_LIST_SELECTOR = 'nav[data-nav-list="sidebar"]';

export default function Sidebar() {
  // The page in view: the routed page, or the page the continuous scroll has reached ("/" counts as Today).
  const current = useActiveRoute();
  const paletteKey = usePaletteShortcutLabel();
  // Keep the active item visible in the scrolling list as the continuous scroll moves through the pages.
  useRevealActiveNavItem(SIDEBAR_LIST_SELECTOR, current);

  // Derive both groups from the shared route catalog; no destination is removed.
  const pinnedHrefs = new Set(["/today", "/check-in"]);
  const pinnedItems = NAV_SECTIONS.flatMap((section) => section.items).filter((item) => pinnedHrefs.has(item.href));
  const librarySections = NAV_SECTIONS.map((section) => ({
    ...section,
    items: section.items.filter((item) => !pinnedHrefs.has(item.href)),
  })).filter((section) => section.items.length > 0);

  function renderLink(item: NavItem) {
    const active = current === item.href;
    const Icon = item.icon;
    // No viewport prefetch: the scheduled warm-up (components/AppData.tsx) loads every page in idle time,
    // and hover / focus / pointer-down warm this one at once.
    return (
      <Link
        key={item.href}
        href={item.href}
        aria-current={active ? "page" : undefined}
        {...navIntentProps(item.href)}
        className={`flex items-center gap-2.5 px-3 py-2 rounded-control text-[13px] font-medium transition-colors relative focus:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
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
    <aside className="fixed inset-y-0 left-0 z-50 w-[220px] bg-surface-sunken border-r border-border-subtle flex flex-col max-md:hidden">
      <div className="shrink-0 px-5 py-5 border-b border-border-subtle">
        <h1 className="flex items-center gap-2 text-[20px] font-bold lowercase leading-none tracking-[0.01em] text-text-primary"><img src="/icons/logo-mark-64.png?v=3" width={22} height={22} alt="" aria-hidden="true" className="shrink-0" />Onyx</h1>
        <p className="text-[11px] text-text-tertiary mt-1.5 font-mono">Personal Data Scientist</p>
      </div>

      {/* Command palette trigger */}
      <div className="shrink-0 px-2 pt-3">
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE))}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-control text-[13px] text-text-tertiary bg-white/[0.02] border border-border-subtle hover:border-border-hover hover:text-text-secondary transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          <Search className="w-[15px] h-[15px] shrink-0" />
          <span className="flex-1 text-left">Search…</span>
          <kbd className="text-[10px] font-mono text-text-tertiary/70">{paletteKey}</kbd>
        </button>
      </div>

      <nav aria-label="Quick access" className="shrink-0 px-2 py-3 border-b border-border-subtle space-y-0.5">
        {pinnedItems.map(renderLink)}
      </nav>

      <nav aria-label="All sections" className="flex-1 min-h-0 px-2 py-3 overflow-y-auto" data-nav-list="sidebar">
        {librarySections.map((section) => (
          <div key={section.title} className="mb-3 last:mb-0">
            <p className="px-3 pb-1 text-[10px] font-mono uppercase tracking-[0.14em] text-text-tertiary">
              {section.title}
            </p>
            <div className="space-y-0.5">
              {section.items.map(renderLink)}
            </div>
          </div>
        ))}
      </nav>

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
