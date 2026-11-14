"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LogOut, Search } from "lucide-react";
import { createSupabaseBrowser } from "@/lib/supabase-browser";
import { NAV_SECTIONS } from "@/lib/nav";
import { OPEN_COMMAND_PALETTE } from "./CommandPalette";
import { InstallAppButton, usePaletteShortcutLabel } from "./DesktopApp";

export default function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const paletteKey = usePaletteShortcutLabel();

  async function handleSignOut() {
    const supabase = createSupabaseBrowser();
    await supabase.auth.signOut();
    router.push("/login");
  }

  return (
    <aside className="fixed inset-y-0 left-0 z-50 w-[220px] bg-surface-sunken border-r border-border-subtle flex flex-col max-md:hidden">
      <div className="px-5 py-5 border-b border-border-subtle">
        <h1 className="text-[20px] font-bold lowercase leading-none tracking-[0.01em] text-text-primary">Onyx</h1>
        <p className="text-[11px] text-text-tertiary mt-1.5 font-mono">Personal Data Scientist</p>
      </div>

      {/* Command palette trigger */}
      <div className="px-2 pt-3">
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

      <nav className="flex-1 px-2 py-3 overflow-y-auto">
        {NAV_SECTIONS.map((section) => (
          <div key={section.title} className="mb-3 last:mb-0">
            <p className="px-3 pb-1 text-[10px] font-mono uppercase tracking-[0.14em] text-text-tertiary">
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
                    className={`flex items-center gap-2.5 px-3 py-2 rounded-control text-[13px] font-medium transition-colors relative focus:outline-none focus-visible:ring-1 focus-visible:ring-accent ${
                      active
                        ? "bg-surface-raised text-text-primary"
                        : "text-text-secondary hover:text-text-primary hover:bg-white/[0.03]"
                    }`}
                  >
                    <Icon className={`w-[17px] h-[17px] shrink-0 ${active ? "text-accent" : "text-text-tertiary"}`} strokeWidth={1.75} />
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
        <InstallAppButton />
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
