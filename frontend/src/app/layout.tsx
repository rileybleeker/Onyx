import type { Metadata, Viewport } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { JetBrains_Mono } from "next/font/google";
import "./globals.css";
import AppShell from "@/components/AppShell";

// Direction A ("Terminal") display + numeric face. Self-hosted by next/font at
// build time; exposed as --font-jetbrains-mono and led in the --font-mono stack.
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-jetbrains-mono",
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
  themeColor: "#08090B",
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
    <html lang="en" className={`dark ${GeistSans.variable} ${GeistMono.variable} ${jetbrainsMono.variable}`}>
      <body className="bg-surface text-text-primary antialiased font-sans">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
