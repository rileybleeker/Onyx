"use client";

import { usePathname } from "next/navigation";
import Sidebar from "./Sidebar";
import MobileNav from "./MobileNav";

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isAuth = pathname.startsWith("/login") || pathname.startsWith("/auth");

  if (isAuth) {
    return <>{children}</>;
  }

  return (
    <>
      <Sidebar />
      <main className="md:ml-[220px] min-h-screen">
        {/* Top padding clears the fixed mobile header (safe-area inset + 3rem
            bar + gap); desktop has no top bar so it reverts to 2rem. */}
        <div className="max-w-6xl mx-auto px-4 sm:px-6 pb-8 pt-[calc(env(safe-area-inset-top)+4rem)] md:pt-8 animate-fade-in">
          {children}
        </div>
      </main>
      <MobileNav />
    </>
  );
}
