"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LogOut, Search } from "lucide-react";
import { createSupabaseBrowser } from "@/lib/supabase-browser";
import { NAV_SECTIONS } from "@/lib/nav";
import { OPEN_COMMAND_PALETTE } from "./CommandPalette";

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();

  async function handleSignOut() {
    const supabase = createSupabaseBrowser();
    await supabase.auth.signOut();
    router.push("/login");
  }

  return (
    <aside className="fixed inset-y-0 left-0 z-50 w-[220px] bg-surface-card border-r border-border-subtle flex flex-col max-md:hidden">
      <div className="px-5 py-5 border-b border-border-subtle">
        <h1 className="text-base font-semibold text-text-primary tracking-tight">Onyx</h1>
        <p className="text-[11px] text-text-tertiary mt-0.5 font-mono">Personal Data Scientist</p>
      </div>

      {/* Command palette trigger */}
      <div className="px-2 pt-3">
        <button
          type="button"
          onClick={() => window.dispatchEvent(new Event(OPEN_COMMAND_PALETTE))}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-[4px] text-[13px] text-text-tertiary bg-white/[0.02] border border-border-subtle hover:border-border-hover hover:text-text-secondary transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          <Search className="w-[15px] h-[15px] shrink-0" />
          <span className="flex-1 text-left">Search…</span>
          <kbd className="text-[10px] font-mono text-text-tertiary/70">⌘K</kbd>
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
                    className={`flex items-center gap-2.5 px-3 py-2 rounded-[4px] text-[13px] font-medium transition-colors relative focus:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
                      active
                        ? "bg-white/5 text-text-primary before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[2px] before:bg-accent before:rounded-full"
                        : "text-text-secondary hover:text-text-primary hover:bg-white/[0.03]"
                    }`}
                  >
                    <Icon className="w-[17px] h-[17px] shrink-0" strokeWidth={1.75} />
                    <span className="flex-1 truncate">{item.label}</span>
                    <kbd className="text-[10px] font-mono text-text-tertiary/60 ml-auto hidden lg:inline">
                      {item.shortcut}
                    </kbd>
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="px-2 py-3 border-t border-border-subtle">
        <button
          onClick={handleSignOut}
          className="flex items-center gap-2.5 px-3 py-2 rounded-[4px] text-[13px] font-medium text-text-secondary hover:text-text-primary hover:bg-white/[0.03] transition-colors w-full focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
        >
          <LogOut className="w-[17px] h-[17px] shrink-0" strokeWidth={1.75} />
          Sign out
        </button>
      </div>
    </aside>
  );
}
