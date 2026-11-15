"use client";

import { useState, useEffect, useRef, useSyncExternalStore } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Plus, Menu, X, LogOut, Search, Pill, CircleCheck, Scale, ClipboardCheck, Camera, ChevronDown, ChevronRight } from "lucide-react";
import { createSupabaseBrowser } from "@/lib/supabase-browser";
import { NAV_SECTIONS } from "@/lib/nav";
import { CACHE_KEYS, clientCache, wipeClientData } from "@/lib/client-cache";
import { AGENTS_BADGE_EVENT, lastAgentsBadge } from "@/lib/agents-api";
import { DEFAULT_TAB_SLOTS, MORE_SLOT, badgeText, isTabActive, tabLabel, tabSlots } from "@/lib/mobile-tabs";
import { navIntentProps } from "@/lib/warmup";
import { OPEN_COMMAND_PALETTE } from "./CommandPalette";
import { useActiveRoute } from "./FeedContext";
import PersonalizeButton from "./personalize/PersonalizeButton";
import type { EditorModule } from "./personalize/editor-loader";
import { areaId, arrangeNav, dropTabsBootStyle, savedAreaPrefs, subscribeAreaIds, tabsBootScript } from "@/lib/nav-areas";
import { currentEditingKey, editorRef, subscribeTargets } from "@/lib/personalize-registry";

const noPrefs = () => null;
const none = () => null;
// Hides the bottom-bar slots Riley changed until React renders them (a full page load paints the default bar first).
const TABS_BOOT = tabsBootScript(DEFAULT_TAB_SLOTS.map((h) => (h === MORE_SLOT ? MORE_SLOT : areaId(h))));

const LOG_ACTIONS = [
  { label: "Check-in", href: "/check-in", icon: ClipboardCheck },
  { label: "Supplement", href: "/supplements", icon: Pill },
  { label: "Habit", href: "/habits", icon: CircleCheck },
  { label: "Weight", href: "/nutrition?log=weight", icon: Scale }, // opens the weight quick-log first, field focused
  { label: "Meal photo", href: "/nutrition?log=photo", icon: Camera }, // opens the plate-photo logger first
];

/**
 * The Agents unread count the app already has: the cached inbox (Today, the Agents inbox and the warm-up
 * keep it fresh) and every setBadge() call (marking read in a conversation). No polling of its own.
 */
function useAgentsBadge(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    const fromInbox = (v: unknown) => {
      const badge = (v as { badge?: unknown } | undefined)?.badge;
      if (typeof badge === "number") setN(badge);
    };
    const last = lastAgentsBadge();
    if (last !== null) setN(last);
    else fromInbox(clientCache.peek(CACHE_KEYS.agentsInbox));
    let alive = true;
    void clientCache.read(CACHE_KEYS.agentsInbox).then((v) => { if (alive && lastAgentsBadge() === null) fromInbox(v); });
    const off = clientCache.subscribe(CACHE_KEYS.agentsInbox, fromInbox);
    const onBadge = (e: Event) => { const d = (e as CustomEvent<number>).detail; if (typeof d === "number") setN(d); };
    window.addEventListener(AGENTS_BADGE_EVENT, onBadge);
    return () => { alive = false; off(); window.removeEventListener(AGENTS_BADGE_EVENT, onBadge); };
  }, []);
  return n;
}

export default function MobileNav() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Riley's side panel (Personalize, `layout.areas`): the drawer lists Quick access, then sections and pages in the
  // saved order without pinned or hidden pages, like the sidebar; the bottom bar's four slots come from it too.
  const prefs = useSyncExternalStore(subscribeAreaIds, savedAreaPrefs, noPrefs);
  const arranged = arrangeNav(NAV_SECTIONS, prefs);
  const arranging = useSyncExternalStore(subscribeTargets, currentEditingKey, none) !== null;
  const editor = useSyncExternalStore(subscribeTargets, editorRef, none) as EditorModule | null;
  const [logOpen, setLogOpen] = useState(false);
  const drawerRef = useRef<HTMLElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const pathname = usePathname();
  // The page in view (follows the continuous scroll); `pathname` stays the routed page for closing overlays.
  const current = useActiveRoute();
  const agentsUnread = useAgentsBadge();
  const [showHidden, setShowHidden] = useState(false);
  useEffect(() => {
    if (prefs !== null) dropTabsBootStyle();
  }, [prefs]);

  // Close every overlay on route change.
  useEffect(() => {
    setDrawerOpen(false);
    setLogOpen(false);
  }, [pathname]);

  // Treat each overlay as a modal: contain keyboard focus and return it to
  // the opener. Preserve any scroll lock owned by another surface.
  useEffect(() => {
    if (!drawerOpen && !logOpen) return;
    const overlay = drawerOpen ? drawerRef.current : logRef.current;
    if (!overlay) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusable = () => Array.from(overlay.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), [tabindex="0"]',
    )).filter((element) => element.getClientRects().length > 0);
    focusable()[0]?.focus();
    function closeOverlays() {
      setDrawerOpen(false);
      setLogOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      // Yield focus ownership when the global command palette opens.
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        closeOverlays();
      } else if (event.key === "Escape") {
        event.preventDefault();
        setDrawerOpen(false);
        setLogOpen(false);
      } else if (event.key === "Tab") {
        const elements = focusable();
        const first = elements[0];
        const last = elements[elements.length - 1];
        if (!first) { event.preventDefault(); return; }
        if (event.shiftKey && (document.activeElement === first || !overlay!.contains(document.activeElement))) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || !overlay!.contains(document.activeElement))) {
          event.preventDefault();
          first.focus();
        }
      }
    }
    // A hidden mobile overlay must not leave desktop scrolling locked.
    const desktop = window.matchMedia("(min-width: 768px)");
    function onViewportChange() {
      if (desktop.matches) { setDrawerOpen(false); setLogOpen(false); }
    }
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener(OPEN_COMMAND_PALETTE, closeOverlays);
    desktop.addEventListener("change", onViewportChange);
    onViewportChange();
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(OPEN_COMMAND_PALETTE, closeOverlays);
      desktop.removeEventListener("change", onViewportChange);
      if (opener?.isConnected && (overlay.contains(document.activeElement) || document.activeElement === document.body)) {
        opener.focus();
      }
    };
  }, [drawerOpen, logOpen]);

  async function handleSignOut() {
    const supabase = createSupabaseBrowser();
    await supabase.auth.signOut();
    // Nothing of this session stays on the device: cached data, its IndexedDB store, drafts.
    await wipeClientData();
    // A full load, not router.push: it also drops the router's in-memory page cache (prefetched pages).
    window.location.assign("/login");
  }

  // [slot, slot, Log, slot, slot]: Log (the quick-log sheet) in the centre; the four slots are pages or More (the
  // drawer), by default Today, Agents | Log | Chat, More, chosen in Personalize (lib/mobile-tabs.ts). Each page
  // tab's label is the page it opens; Trends lives in More and on Today.
  const navItems = new Map(NAV_SECTIONS.flatMap((section) => section.items).map((item) => [item.href, item] as const));
  const hrefOfId = new Map(Array.from(navItems.keys()).map((href) => [areaId(href), href] as const));
  const savedSlots = prefs?.tabs ? prefs.tabs.map((id) => (id === MORE_SLOT ? MORE_SLOT : hrefOfId.get(id) ?? null)) : null;
  const slots = tabSlots(savedSlots, (href) => navItems.has(href));
  type Tab = { kind: "page"; href: string; slot: number } | { kind: "log" } | { kind: "more"; slot: number };
  const slotTab = (value: string, slot: number): Tab => (value === MORE_SLOT ? { kind: "more", slot } : { kind: "page", href: value, slot });
  const tabs: Tab[] = [
    ...slots.slice(0, 2).map((value, i) => slotTab(value, i)),
    { kind: "log" },
    ...slots.slice(2).map((value, i) => slotTab(value, i + 2)),
  ];
  // With More off the bar the drawer (every page, Personalize, Sign out) opens from the top bar instead.
  const moreOnBar = slots.includes(MORE_SLOT);

  function drawerLink(item: (typeof NAV_SECTIONS)[number]["items"][number]) {
    const active = current === item.href;
    const Icon = item.icon;
    return (
      <Link
        key={item.href}
        href={item.href}
        {...navIntentProps(item.href)}
        onClick={() => setDrawerOpen(false)}
        aria-current={active ? "page" : undefined}
        className={`min-h-11 flex items-center gap-2.5 px-3 py-2 rounded-control text-[13px] font-medium transition-colors relative ${
          active
            ? "bg-surface-raised text-text-primary"
            : "text-text-secondary hover:text-text-primary hover:bg-white/[0.03]"
        }`}
      >
        <Icon className={`w-[17px] h-[17px] shrink-0 ${active ? "text-accent" : "text-text-tertiary"}`} strokeWidth={1.75} />
        <span className="flex-1 truncate">{item.label}</span>
      </Link>
    );
  }

  return (
    <>
      {/* Slim top bar — wordmark + search. Fills the safe-area inset so scrolled
          content can't bleed under the iOS status bar. Mobile only. */}
      <header className="md:hidden fixed inset-x-0 top-0 z-40 bg-surface-sunken border-b border-border-subtle pt-[env(safe-area-inset-top)]">
        <div className="h-12 px-3 flex items-center justify-between">
          <span className="flex items-center gap-2 text-[17px] font-bold lowercase tracking-[0.01em] text-text-primary"><img src="/icons/logo-mark-64.png?v=4" width={26} height={26} alt="" aria-hidden="true" className="shrink-0" />Onyx</span>
          <div className="flex items-center">
            {!moreOnBar && (
              <button
                type="button"
                onClick={() => setDrawerOpen(true)}
                className="w-11 h-11 flex items-center justify-center rounded-control text-text-secondary hover:text-text-primary transition-colors"
                aria-label="More"
                aria-expanded={drawerOpen}
                aria-haspopup="dialog"
                aria-controls={drawerOpen ? "mobile-navigation" : undefined}
              >
                <Menu className="w-[18px] h-[18px]" />
              </button>
            )}
            <button
              onClick={() => window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE))}
              className="w-11 h-11 -mr-1 flex items-center justify-center rounded-control text-text-secondary hover:text-text-primary transition-colors"
              aria-label="Search"
            >
              <Search className="w-[18px] h-[18px]" />
            </button>
          </div>
        </div>
      </header>

      {/* Bottom tab bar — primary mobile navigation. */}
      <script dangerouslySetInnerHTML={{ __html: TABS_BOOT }} />
      <nav
        data-testid="mobile-tab-bar"
        className="md:hidden fixed inset-x-0 bottom-0 z-40 bg-surface-sunken border-t border-border-subtle pb-[env(safe-area-inset-bottom)]"
        aria-label="Primary"
      >
        <div className="grid grid-cols-5 h-14">
          {tabs.map((tab) => {
            const cell = "flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors";
            if (tab.kind === "page") {
              const item = navItems.get(tab.href)!;
              const Icon = item.icon;
              const active = isTabActive(item.href, current);
              const count = item.href === "/agents" ? badgeText(agentsUnread) : "";
              return (
                <Link key={item.href} href={item.href} data-tab-slot={tab.slot} className={`${cell} ${active ? "text-accent" : "text-text-tertiary hover:text-text-secondary"}`} aria-current={active ? "page" : undefined} {...navIntentProps(item.href)}>
                  <span className="relative">
                    <Icon className="w-[20px] h-[20px]" strokeWidth={1.75} />
                    {count && (
                      <span aria-hidden="true" className="absolute -top-1.5 -right-2.5 min-w-[16px] h-4 px-1 rounded-full bg-accent text-on-accent text-[10px] font-mono leading-4 text-center">{count}</span>
                    )}
                  </span>
                  <span>{tabLabel(item)}</span>
                  {count && <span className="sr-only">, {agentsUnread} unread</span>}
                </Link>
              );
            }
            const isLog = tab.kind === "log";
            const open = isLog ? logOpen : drawerOpen;
            return (
              <button key={tab.kind} type="button" data-tab-slot={tab.kind === "more" ? tab.slot : undefined} onClick={() => (isLog ? setLogOpen(true) : setDrawerOpen(true))}
                className={`${cell} ${!isLog && open ? "text-accent" : isLog ? "text-text-primary" : "text-text-tertiary hover:text-text-secondary"}`}
                aria-expanded={open} aria-haspopup="dialog" aria-controls={open ? (isLog ? "mobile-quick-log" : "mobile-navigation") : undefined}>
                {isLog ? (
                  // The primary action: an accent disc (the only filled control on the bar).
                  <span className="w-9 h-9 -mt-1 rounded-full bg-accent text-on-accent flex items-center justify-center shadow-card">
                    <Plus className="w-[20px] h-[20px]" strokeWidth={2.25} />
                  </span>
                ) : (
                  <Menu className="w-[20px] h-[20px]" strokeWidth={1.75} />
                )}
                <span>{isLog ? "Log" : "More"}</span>
              </button>
            );
          })}
        </div>
      </nav>

      {/* Log sheet — quick entry to all logging surfaces. */}
      {logOpen && (
        <div id="mobile-quick-log" ref={logRef} className="md:hidden fixed inset-0 z-50 flex flex-col justify-end" role="dialog" aria-modal="true" aria-label="Quick log">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setLogOpen(false)} />
          <div className="relative bg-surface-raised border-t border-border-default rounded-t-[12px] p-4 pb-[max(1rem,env(safe-area-inset-bottom))] animate-fade-in-up">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-[13px] font-semibold uppercase tracking-[0.07em] text-text-secondary">Quick log</h2>
              <button onClick={() => setLogOpen(false)} className="w-11 h-11 shrink-0 flex items-center justify-center text-text-tertiary hover:text-text-primary" aria-label="Close quick log">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {LOG_ACTIONS.map((a) => {
                const Icon = a.icon;
                return (
                  <Link
                    key={a.label}
                    href={a.href}
                    {...navIntentProps(a.href)}
                    onClick={() => setLogOpen(false)}
                    className={`${a.href === "/check-in" ? "col-span-2 " : ""}flex items-center gap-2.5 px-3 py-3 rounded-control bg-surface-card border border-border-subtle text-[14px] text-text-primary hover:border-border-hover transition-colors`}
                  >
                    <Icon className="w-[18px] h-[18px] text-accent shrink-0" strokeWidth={1.75} />
                    {a.label}
                  </Link>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Drawer (full nav) — opened by the "More" tab. */}
      {drawerOpen && (
        <div
          className="md:hidden fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
          onClick={() => setDrawerOpen(false)}
        />
      )}
      <aside
        id="mobile-navigation"
        ref={drawerRef}
        role={drawerOpen ? "dialog" : undefined}
        aria-modal={drawerOpen ? true : undefined}
        aria-label="Navigation"
        inert={!drawerOpen}
        className={`md:hidden fixed inset-y-0 left-0 z-50 ${arranging && editor ? "w-[min(340px,94vw)]" : "w-[240px]"} bg-surface-sunken border-r border-border-subtle flex flex-col transition-transform duration-200 ease-in-out ${
          drawerOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="px-5 py-5 border-b border-border-subtle flex items-center justify-between pt-[max(1.25rem,env(safe-area-inset-top))]">
          <div>
            <h1 className="flex items-center gap-2 text-base font-semibold text-text-primary tracking-tight"><img src="/icons/logo-mark-64.png?v=4" width={26} height={26} alt="" aria-hidden="true" className="shrink-0" />Onyx</h1>
            <p className="text-[11px] text-text-tertiary mt-0.5 font-mono">Personal Data Scientist</p>
          </div>
          <button
            onClick={() => setDrawerOpen(false)}
            className="w-11 h-11 shrink-0 flex items-center justify-center text-text-tertiary hover:text-text-primary transition-colors"
            aria-label="Close navigation"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-2 pt-3">
          <button
            type="button"
            onClick={() => { setDrawerOpen(false); window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE)); }}
            className="w-full min-h-11 flex items-center gap-2.5 px-3 py-2 rounded-control text-[13px] text-text-tertiary bg-white/[0.02] border border-border-subtle hover:border-border-hover transition-colors"
          >
            <Search className="w-[15px] h-[15px] shrink-0" />
            <span className="flex-1 text-left">Search…</span>
          </button>
        </div>

        {arranging && editor ? (
          // Personalize mode: up / down buttons for pages and sections (components/personalize/NavArranger.tsx).
          <editor.DrawerArranger />
        ) : (
        <nav className="flex-1 px-2 py-3 overflow-y-auto">
          {arranged.pinned.length > 0 && (
            <div className="mb-3">
              <p className="px-3 pb-1 text-[10px] font-medium uppercase tracking-[0.12em] text-text-tertiary/70">Quick access</p>
              <div className="space-y-0.5">{arranged.pinned.map(drawerLink)}</div>
            </div>
          )}
          {arranged.sections.map((section) => (
            <div key={section.title} className="mb-3 last:mb-0">
              <p className="px-3 pb-1 text-[10px] font-medium uppercase tracking-[0.12em] text-text-tertiary/70">
                {section.title}
              </p>
              <div className="space-y-0.5">{section.items.map(drawerLink)}</div>
            </div>
          ))}
          {arranged.hidden.length > 0 && (
            <div className="mt-3">
              <button
                type="button"
                onClick={() => setShowHidden((v) => !v)}
                aria-expanded={showHidden}
                className="min-h-11 w-full flex items-center gap-1.5 px-3 rounded-control text-[10px] font-medium uppercase tracking-[0.12em] text-text-tertiary hover:text-text-secondary"
              >
                {showHidden ? <ChevronDown className="w-3 h-3" aria-hidden /> : <ChevronRight className="w-3 h-3" aria-hidden />}
                Show hidden ({arranged.hidden.length})
              </button>
              {showHidden && <div className="space-y-0.5 opacity-80">{arranged.hidden.map(drawerLink)}</div>}
            </div>
          )}
        </nav>
        )}

        <div className="px-2 py-3 border-t border-border-subtle pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <PersonalizeButton
            onStart={(kind) => { if (kind === "page") setDrawerOpen(false); }}
            className="min-h-11 flex items-center gap-2.5 px-3 py-2 rounded-control text-[13px] font-medium text-text-secondary hover:text-text-primary hover:bg-white/[0.03] transition-colors w-full disabled:text-accent"
          />
          <button
            onClick={handleSignOut}
            className="min-h-11 flex items-center gap-2.5 px-3 py-2 rounded-control text-[13px] font-medium text-text-secondary hover:text-text-primary hover:bg-white/[0.03] transition-colors w-full"
          >
            <LogOut className="w-[17px] h-[17px] shrink-0" strokeWidth={1.75} />
            Sign out
          </button>
        </div>
      </aside>
    </>
  );
}
