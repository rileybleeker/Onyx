import type { LucideIcon } from "lucide-react";
import {
  Moon,
  Activity,
  Utensils,
  BarChart3,
  Plane,
  Scale,
  CircleCheck,
  BookOpen,
  Pill,
  Coffee,
  Music,
  MessageSquare,
  ShieldCheck,
} from "lucide-react";

/**
 * Single source of truth for primary navigation.
 *
 * Consumed by both `Sidebar` (desktop) and `MobileNav` (drawer) and the
 * `CommandPalette` — this replaces the two hand-maintained `nav` arrays that
 * the CLAUDE.md convention previously forced to be edited in lockstep. Add or
 * reorder routes HERE and every surface updates together.
 */
export interface NavItem {
  href: string;
  label: string;
  /** Single-letter desktop shortcut hint (display only). */
  shortcut: string;
  icon: LucideIcon;
  /** Extra search terms for the command palette. */
  keywords?: string[];
}

export interface NavSection {
  title: string;
  items: NavItem[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    title: "Logging",
    items: [
      { href: "/activities", label: "Activities", shortcut: "A", icon: Activity, keywords: ["workout", "run", "strength", "lifting", "training", "sauna"] },
      { href: "/nutrition", label: "Nutrition", shortcut: "N", icon: Utensils, keywords: ["food", "macros", "calories", "cronometer", "vitamins", "weight", "meal"] },
      { href: "/supplements", label: "Supplements", shortcut: "P", icon: Pill, keywords: ["stack", "pills", "compound", "dose", "intake", "log"] },
      { href: "/caffeine", label: "Caffeine", shortcut: "F", icon: Coffee, keywords: ["coffee", "espresso", "energy drink", "stimulant", "mg", "half-life", "bedtime", "window"] },
      { href: "/habits", label: "Habits", shortcut: "T", icon: CircleCheck, keywords: ["routine", "streak", "complete", "notion"] },
    ],
  },
  {
    title: "Insights",
    items: [
      { href: "/sleep", label: "Sleep & Recovery", shortcut: "S", icon: Moon, keywords: ["whoop", "eight sleep", "garmin", "recovery", "hrv", "rhr"] },
      { href: "/analytics/hrv", label: "HRV Analysis", shortcut: "V", icon: BarChart3, keywords: ["heart rate variability", "forecast", "prediction", "shap", "causal", "model"] },
      { href: "/analytics/travel", label: "Travel Analysis", shortcut: "R", icon: Plane, keywords: ["timezone", "trip", "jet lag", "tz"] },
      { href: "/bland-altman", label: "Bland-Altman", shortcut: "B", icon: Scale, keywords: ["agreement", "device", "comparison", "rmssd"] },
      { href: "/spotify", label: "Spotify", shortcut: "M", icon: Music, keywords: ["music", "listening", "playlist", "tracks", "artists"] },
      { href: "/journal", label: "Journal", shortcut: "J", icon: BookOpen, keywords: ["notion", "entries", "reflection", "mood"] },
    ],
  },
  {
    title: "Tools",
    items: [
      { href: "/chat", label: "Chat", shortcut: "C", icon: MessageSquare, keywords: ["ask", "claude", "assistant", "query"] },
      { href: "/status", label: "Status", shortcut: "U", icon: ShieldCheck, keywords: ["system", "sync", "etl", "health", "freshness"] },
    ],
  },
];

/** Flat list (palette search, lookups, drawer). */
export const NAV_ITEMS: NavItem[] = NAV_SECTIONS.flatMap((s) => s.items);
