"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createSupabaseBrowser } from "@/lib/supabase-browser";

const nav = [
  { href: "/sleep", label: "Sleep & Recovery", icon: "M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" },
  { href: "/activities", label: "Activities", icon: "M13 10V3L4 14h7v7l9-11h-7z" },
  { href: "/nutrition", label: "Nutrition", icon: "M3 3h2l.4 2M7 13h10l4-8H5.4M7 13L5.4 5M7 13l-2.293 2.293c-.63.63-.184 1.707.707 1.707H17m0 0a2 2 0 100 4 2 2 0 000-4zm-8 2a2 2 0 11-4 0 2 2 0 014 0z" },
  { href: "/analytics/hrv", label: "HRV Analysis", icon: "M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" },
  { href: "/analytics/travel", label: "Travel Analysis", icon: "M3 21l3-3m0 0l3-3m-3 3h12a6 6 0 000-12h-3m-9 9v-6a6 6 0 016-6h3" },
  { href: "/bland-altman", label: "Bland-Altman", icon: "M3 3v18h18M9 15l3-6 3 4 3-7" },
  { href: "/habits", label: "Habits", icon: "M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" },
  { href: "/journal", label: "Journal", icon: "M12 6.042A8.967 8.967 0 006 3.75c-1.052 0-2.062.18-3 .512v14.25A8.987 8.987 0 016 18c2.305 0 4.408.867 6 2.292m0-14.25a8.966 8.966 0 016-2.292c1.052 0 2.062.18 3 .512v14.25A8.987 8.987 0 0018 18a8.967 8.967 0 00-6 2.292m0-14.25v14.25" },
  { href: "/supplements", label: "Supplements", icon: "M10.5 20.5l10-10a4.95 4.95 0 1 0-7-7l-10 10a4.95 4.95 0 1 0 7 7zM8.5 8.5l7 7" },
  { href: "/spotify", label: "Spotify", icon: "M9 19V6l12-3v13M9 19c0 1.657-1.343 3-3 3s-3-1.343-3-3 1.343-3 3-3 3 1.343 3 3zm12-3c0 1.657-1.343 3-3 3s-3-1.343-3-3 1.343-3 3-3 3 1.343 3 3z" },
  { href: "/chat", label: "Chat", icon: "M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" },
  { href: "/status", label: "Status", icon: "M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" },
];

export default function MobileNav() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const router = useRouter();

  // Close drawer on route change
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Prevent body scroll when drawer is open
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [open]);

  async function handleSignOut() {
    const supabase = createSupabaseBrowser();
    await supabase.auth.signOut();
    router.push("/login");
  }

  return (
    <>
      {/* Hamburger button — fixed top-left, mobile only */}
      <button
        onClick={() => setOpen(true)}
        className="md:hidden fixed top-[max(1rem,env(safe-area-inset-top))] left-4 z-40 w-9 h-9 flex items-center justify-center rounded-[6px] bg-surface-card border border-border-subtle text-text-secondary hover:text-text-primary transition-colors shadow-card"
        aria-label="Open navigation"
      >
        <svg className="w-[18px] h-[18px]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>

      {/* Backdrop */}
      {open && (
        <div
          className="md:hidden fixed inset-0 z-50 bg-black/60 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        />
      )}

      {/* Drawer */}
      <aside
        className={`md:hidden fixed inset-y-0 left-0 z-50 w-[220px] bg-surface-card border-r border-border-subtle flex flex-col transition-transform duration-200 ease-in-out ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {/* Header */}
        <div className="px-5 py-5 border-b border-border-subtle flex items-center justify-between pt-[max(1.25rem,env(safe-area-inset-top))]">
          <div>
            <h1 className="text-base font-semibold text-text-primary tracking-tight">Onyx</h1>
            <p className="text-[11px] text-text-tertiary mt-0.5 font-mono">Personal Data Scientist</p>
          </div>
          <button
            onClick={() => setOpen(false)}
            className="w-7 h-7 flex items-center justify-center text-text-tertiary hover:text-text-primary transition-colors"
            aria-label="Close navigation"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Nav items */}
        <nav className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
          {nav.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium transition-colors relative ${
                  active
                    ? "bg-white/5 text-text-primary before:absolute before:left-0 before:top-1 before:bottom-1 before:w-[2px] before:bg-accent before:rounded-full"
                    : "text-text-secondary hover:text-text-primary hover:bg-white/[0.03]"
                }`}
              >
                <svg className="w-[18px] h-[18px] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d={item.icon} />
                </svg>
                <span className="flex-1 truncate">{item.label}</span>
              </Link>
            );
          })}
        </nav>

        {/* Sign out */}
        <div className="px-2 py-3 border-t border-border-subtle pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <button
            onClick={handleSignOut}
            className="flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium text-text-secondary hover:text-text-primary hover:bg-white/[0.03] transition-colors w-full"
          >
            <svg className="w-[18px] h-[18px] shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 9V5.25A2.25 2.25 0 0013.5 3h-6a2.25 2.25 0 00-2.25 2.25v13.5A2.25 2.25 0 007.5 21h6a2.25 2.25 0 002.25-2.25V15m3-3h-9m9 0l-3-3m3 3l-3 3" />
            </svg>
            Sign out
          </button>
        </div>
      </aside>
    </>
  );
}
