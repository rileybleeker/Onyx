/**
 * Instant placeholder for a route whose server render takes a moment (force-dynamic pages): Next shows it the
 * moment a link is clicked, so the screen is never blank. Roughly the real layout, theme tokens only, no
 * animation (a pulsing skeleton costs a repaint every frame for nothing).
 */
export default function PageSkeleton({
  title,
  width = "max-w-6xl",
  tiles = 3,
  blocks = ["h-64", "h-48"],
  list = 0,
}: {
  /** The page's real heading, shown at once. */
  title: string;
  /** The page's own max width, so nothing jumps when the content arrives. */
  width?: string;
  /** KPI tiles in the first row (0 = none). */
  tiles?: number;
  /** Card heights after the tiles. */
  blocks?: string[];
  /** List rows inside the last card (0 = none). */
  list?: number;
}) {
  return (
    <div className={`mx-auto w-full ${width} space-y-5`}>
      <h1 className="text-2xl font-semibold text-text-primary">{title}</h1>
      <p role="status" className="sr-only">Loading {title}</p>
      <div aria-hidden="true" className="space-y-5">
        <div className="skeleton h-4 w-2/3 max-w-sm" />
        {tiles > 0 && (
          <div className={`grid gap-3 ${tiles >= 4 ? "grid-cols-2 lg:grid-cols-4" : "grid-cols-3"}`}>
            {Array.from({ length: tiles }, (_, i) => (
              <div key={i} className="rounded-card border border-border-subtle bg-surface-card p-4">
                <div className="skeleton h-3 w-1/2" />
                <div className="skeleton mt-3 h-7 w-2/3" />
              </div>
            ))}
          </div>
        )}
        {blocks.map((h, i) => (
          <div key={i} className={`rounded-card border border-border-subtle bg-surface-card p-5 ${i === blocks.length - 1 && list > 0 ? "" : h}`}>
            <div className="skeleton h-4 w-40" />
            {i === blocks.length - 1 && list > 0 && (
              <div className="mt-5 space-y-3">
                {Array.from({ length: list }, (_, j) => <div key={j} className="skeleton h-9" />)}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
