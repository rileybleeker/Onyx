import clsx from "clsx";
import type { ReactNode } from "react";

type Tone = "primary" | "secondary" | "tertiary" | "accent" | "up" | "down";

export type MetaItem =
  | string
  | { text: ReactNode; tone?: Tone; title?: boolean };

interface MetadataRowProps {
  /** Ordered segments. Falsy entries are dropped, so you can inline conditionals. */
  items: Array<MetaItem | null | undefined | false>;
  className?: string;
}

const TONE_CLASS: Record<Tone, string> = {
  primary: "text-text-primary",
  secondary: "text-text-secondary",
  tertiary: "text-text-tertiary",
  accent: "text-accent",
  up: "text-up",
  down: "text-down",
};

/**
 * Bloomberg-style monospace metadata strip — `TITLE · 2h ago · XGBOOST·SHAP · n=178`.
 * The 4-slot card header vocabulary for Direction A. Segments are joined by a
 * dot separator; each segment can carry a tone and a `title` flag (brighter +
 * non-uppercased) for the leading label.
 */
export default function MetadataRow({ items, className }: MetadataRowProps) {
  const segments = items.filter(Boolean) as MetaItem[];
  if (segments.length === 0) return null;

  return (
    <div
      className={clsx(
        "flex flex-wrap items-center gap-x-1.5 gap-y-0.5 font-mono text-[10px] uppercase tracking-[0.06em] leading-tight",
        className,
      )}
    >
      {segments.map((seg, i) => {
        const isObj = typeof seg === "object";
        const tone: Tone = isObj ? seg.tone ?? "tertiary" : "tertiary";
        const isTitle = isObj && seg.title;
        return (
          <span key={i} className="flex items-center gap-x-1.5">
            {i > 0 && <span className="text-text-tertiary/50" aria-hidden>·</span>}
            <span className={clsx(TONE_CLASS[tone], isTitle && "font-semibold normal-case tracking-[0.02em] text-text-secondary")}>
              {isObj ? seg.text : seg}
            </span>
          </span>
        );
      })}
    </div>
  );
}
