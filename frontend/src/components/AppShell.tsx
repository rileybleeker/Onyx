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
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 pt-[max(2rem,env(safe-area-inset-top))] animate-fade-in">
          {children}
        </div>
      </main>
      <MobileNav />
    </>
  );
}
