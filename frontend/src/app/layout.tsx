import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import "./globals.css";
import AppShell from "@/components/AppShell";

// Direction D ("Instrument") faces: Archivo for text, DM Mono for numerics and
// small labels. Self-hosted by next/font from vendored Google Fonts files (see
// app/fonts/SOURCE.txt); exposed as --font-archivo / --font-dm-mono.
const archivo = localFont({
  src: "./fonts/Archivo-Latin.woff2",
  weight: "100 900",
  variable: "--font-archivo",
  display: "swap",
});

const dmMono = localFont({
  src: [
    { path: "./fonts/DMMono-Regular-Latin.woff2", weight: "400", style: "normal" },
    { path: "./fonts/DMMono-Medium-Latin.woff2", weight: "500", style: "normal" },
  ],
  variable: "--font-dm-mono",
  display: "swap",
});

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  title: "Onyx — Personal Data Scientist",
  description: "Your health and fitness data, visualized.",
  manifest: "/manifest.json",
  themeColor: "#1A1A18",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Onyx",
  },
  icons: {
    icon: [
      { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/favicon-16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180" }],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`dark ${archivo.variable} ${dmMono.variable}`}>
      <body className="bg-surface text-text-primary antialiased font-sans">
        {/* Browser-side Supabase queries hit this origin right after hydration;
            preconnecting overlaps DNS+TCP+TLS with shell load instead of paying
            it serially in front of the first data fetch. React hoists these
            into <head>. */}
        <link
          rel="preconnect"
          href={process.env.NEXT_PUBLIC_SUPABASE_URL}
          crossOrigin="anonymous"
        />
        <link rel="dns-prefetch" href={process.env.NEXT_PUBLIC_SUPABASE_URL} />
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
