"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { House, BarChart3, Plus, MessageSquare, Menu, X, LogOut, Search, Pill, Utensils, CircleCheck, Scale } from "lucide-react";
import { createSupabaseBrowser } from "@/lib/supabase-browser";
import { NAV_SECTIONS } from "@/lib/nav";
import { OPEN_COMMAND_PALETTE } from "./CommandPalette";

const LOG_ACTIONS = [
  { label: "Supplement", href: "/supplements", icon: Pill },
  { label: "Meal", href: "/nutrition", icon: Utensils },
  { label: "Habit", href: "/habits", icon: CircleCheck },
  { label: "Weight", href: "/nutrition", icon: Scale },
];

export default function MobileNav() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
  const pathname = usePathname();
  const router = useRouter();

  // Close every overlay on route change.
  useEffect(() => {
    setDrawerOpen(false);
    setLogOpen(false);
  }, [pathname]);

  // Lock body scroll while any overlay is open.
  useEffect(() => {
    const locked = drawerOpen || logOpen;
    document.body.style.overflow = locked ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [drawerOpen, logOpen]);

  async function handleSignOut() {
    const supabase = createSupabaseBrowser();
    await supabase.auth.signOut();
    router.push("/login");
  }

  const tabs = [
    { key: "today", label: "Today", icon: House, href: "/sleep", isActive: pathname === "/sleep" },
    { key: "trends", label: "Trends", icon: BarChart3, href: "/analytics/hrv", isActive: pathname.startsWith("/analytics") },
    { key: "log", label: "Log", icon: Plus, action: () => setLogOpen(true), isActive: logOpen },
    { key: "chat", label: "Chat", icon: MessageSquare, href: "/chat", isActive: pathname === "/chat" },
    { key: "more", label: "More", icon: Menu, action: () => setDrawerOpen(true), isActive: drawerOpen },
  ];

  return (
    <>
      {/* Slim top bar — wordmark + search. Fills the safe-area inset so scrolled
          content can't bleed under the iOS status bar. Mobile only. */}
      <header className="md:hidden fixed inset-x-0 top-0 z-40 bg-surface-card border-b border-border-subtle pt-[env(safe-area-inset-top)]">
        <div className="h-12 px-3 flex items-center justify-between">
          <span className="text-[15px] font-semibold text-text-primary tracking-tight">Onyx</span>
          <button
            onClick={() => window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE))}
            className="w-9 h-9 -mr-1 flex items-center justify-center rounded-[6px] text-text-secondary hover:text-text-primary transition-colors"
            aria-label="Search"
          >
            <Search className="w-[18px] h-[18px]" />
          </button>
        </div>
      </header>

      {/* Bottom tab bar — primary mobile navigation. */}
      <nav
        data-testid="mobile-tab-bar"
        className="md:hidden fixed inset-x-0 bottom-0 z-40 bg-surface-card border-t border-border-subtle pb-[env(safe-area-inset-bottom)]"
        aria-label="Primary"
      >
        <div className="grid grid-cols-5 h-14">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const cls = `flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium transition-colors ${
              tab.isActive ? "text-accent" : "text-text-tertiary hover:text-text-secondary"
            }`;
            const inner = (
              <>
                <Icon className="w-[20px] h-[20px]" strokeWidth={1.75} />
                <span>{tab.label}</span>
              </>
            );
            return tab.href ? (
              <Link key={tab.key} href={tab.href} className={cls} aria-current={tab.isActive ? "page" : undefined}>
                {inner}
              </Link>
            ) : (
              <button key={tab.key} type="button" onClick={tab.action} className={cls} aria-expanded={tab.isActive}>
                {inner}
              </button>
            );
          })}
        </div>
      </nav>

      {/* Log sheet — quick entry to the four logging surfaces. */}
      {logOpen && (
        <div className="md:hidden fixed inset-0 z-50 flex flex-col justify-end" role="dialog" aria-modal="true" aria-label="Quick log">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setLogOpen(false)} />
          <div className="relative bg-surface-raised border-t border-border-default rounded-t-[12px] p-4 pb-[max(1rem,env(safe-area-inset-bottom))] animate-fade-in-up">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-[13px] font-semibold uppercase tracking-[0.07em] text-text-secondary">Quick log</h2>
              <button onClick={() => setLogOpen(false)} className="w-7 h-7 flex items-center justify-center text-text-tertiary hover:text-text-primary" aria-label="Close">
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
                    className="flex items-center gap-2.5 px-3 py-3 rounded-[6px] bg-surface-card border border-border-subtle text-[14px] text-text-primary hover:border-border-hover transition-colors"
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
        className={`md:hidden fixed inset-y-0 left-0 z-50 w-[240px] bg-surface-card border-r border-border-subtle flex flex-col transition-transform duration-200 ease-in-out ${
          drawerOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="px-5 py-5 border-b border-border-subtle flex items-center justify-between pt-[max(1.25rem,env(safe-area-inset-top))]">
          <div>
            <h1 className="text-base font-semibold text-text-primary tracking-tight">Onyx</h1>
            <p className="text-[11px] text-text-tertiary mt-0.5 font-mono">Personal Data Scientist</p>
          </div>
          <button
            onClick={() => setDrawerOpen(false)}
            className="w-7 h-7 flex items-center justify-center text-text-tertiary hover:text-text-primary transition-colors"
            aria-label="Close navigation"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-2 pt-3">
          <button
            type="button"
            onClick={() => { setDrawerOpen(false); window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE)); }}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-[4px] text-[13px] text-text-tertiary bg-white/[0.02] border border-border-subtle hover:border-border-hover transition-colors"
          >
            <Search className="w-[15px] h-[15px] shrink-0" />
            <span className="flex-1 text-left">Search…</span>
          </button>
        </div>

        <nav className="flex-1 px-2 py-3 overflow-y-auto">
          {NAV_SECTIONS.map((section) => (
            <div key={section.title} className="mb-3 last:mb-0">
              <p className="px-3 pb-1 text-[10px] font-medium uppercase tracking-[0.12em] text-text-tertiary/70">
                {section.title}
              </p>
              <div className="space-y-0.5">
                {section.items.map((item) => {
                  const active = pathname === item.href;
                  const Icon = item.icon;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      className={`flex items-center gap-2.5 px-3 py-2 rounded-[4px] text-[13px] font-medium transition-colors relative ${
                        active
                          ? "bg-white/5 text-text-primary before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[2px] before:bg-accent before:rounded-full"
                          : "text-text-secondary hover:text-text-primary hover:bg-white/[0.03]"
                      }`}
                    >
                      <Icon className="w-[17px] h-[17px] shrink-0" strokeWidth={1.75} />
                      <span className="flex-1 truncate">{item.label}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="px-2 py-3 border-t border-border-subtle pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <button
            onClick={handleSignOut}
            className="flex items-center gap-2.5 px-3 py-2 rounded-[4px] text-[13px] font-medium text-text-secondary hover:text-text-primary hover:bg-white/[0.03] transition-colors w-full"
          >
            <LogOut className="w-[17px] h-[17px] shrink-0" strokeWidth={1.75} />
            Sign out
          </button>
        </div>
      </aside>
    </>
  );
}
