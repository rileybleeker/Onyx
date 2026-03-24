# Visual Redesign — CHANGES.md

Complete dark/professional redesign of the Onyx frontend. Linear-meets-Bloomberg terminal aesthetic.

## Foundation

### `src/app/globals.css`
- Added `@theme` block with full design token system: surface colors, borders, accent, text hierarchy, source colors, shadows, font families, and animation keyframes
- Font references use CSS variables from next/font (`--font-geist-sans`, `--font-geist-mono`)
- Custom scrollbar styling (thin, dark)
- Recharts tooltip outline reset
- Keyframes: `fade-in`, `fade-in-up` with stagger variants (50ms increments)

### `src/app/layout.tsx`
- Installed and loaded Geist Sans + Geist Mono via `geist` package
- Applied font CSS variables to `<html>` element
- Body uses `bg-surface text-text-primary font-sans` instead of raw zinc values

### `package.json`
- Added `geist` (Vercel's font package for Next.js)
- Added `clsx` (conditional class utility)

### `src/lib/chart-theme.ts` *(new file)*
- Shared Recharts configuration: `chartTooltip`, `axisTick`, `gridStyle`, `sourceColors`, `accentColor`
- Dark tooltip: `#1A1A1D` bg, `rgba(255,255,255,0.10)` border, `shadow-floating`
- Axis ticks: Geist Mono, 11px, `#71717A`
- Grid lines: `stroke="#ffffff" strokeOpacity={0.05}`

## Layout & Navigation

### `src/components/AppShell.tsx`
- Sidebar width: `md:ml-[220px]` (was `md:ml-64` / 256px)
- Page content wrapper: `animate-fade-in` for page transitions

### `src/components/Sidebar.tsx`
- Width: 220px fixed (was 256px)
- Background: `bg-surface-card` with `border-border-subtle`
- Active nav item: 2px left cyan accent border (`before:` pseudo-element) + `bg-white/5`
- Inactive items: `text-text-secondary`, hover `bg-white/[0.03]`
- Keyboard shortcut hints: right-aligned `<kbd>` elements in mono, `text-text-tertiary/60`
- Onyx subtitle in `font-mono` for data-science feel
- Icons reduced to 18px, labels 13px, tighter spacing

### `src/components/MobileNav.tsx`
- Background: `bg-surface-card border-border-subtle`
- Active state: `text-accent` (cyan) instead of white
- Compact labels: 10px

## Components

### `src/components/StatCard.tsx`
- Background: `bg-surface-card`, border: `border-border-subtle`, hover: `border-border-hover`
- Border radius: `rounded-[6px]` (was `rounded-xl`)
- Value: 28px `font-mono tabular-nums` (was 24px `font-bold`)
- Label: 10px uppercase `tracking-[0.1em]` (was 12px)
- Added `trend` prop: directional arrow + delta with context-aware coloring (green/red)
- Added `source` prop: corner badge (`GARMIN` / `WHOOP` / `8SLP`) in source-specific color
- Added `shadow-card` and hover border transition
- Uses `clsx` for conditional classes

### `src/components/ChartCard.tsx`
- Same surface/border/radius treatment as StatCard
- Added `source` prop: pill badge top-right in mono with `bg-white/5` background
- Title: 13px `font-medium` (was 14px `font-semibold`)
- Added `shadow-card` and hover border transition
- Uses `clsx`

## Pages

### `src/app/page.tsx` (Dashboard)
- Page header: 28px `font-medium` with subtitle line
- KPI cards: staggered fade-in animation (50ms per card)
- Skeleton loading state matching exact content layout
- Charts: gradient area fills, `CartesianGrid` with subtle grid lines
- Source badges on stat cards (GARMIN, WHOOP)
- Source badges on chart cards

### `src/app/sleep/page.tsx`
- Skeleton loading state
- All charts: `chartTooltip`, `axisTick`, `gridStyle` from shared theme
- Area gradient fills replacing flat color fills
- Legend font: Geist Mono 11px
- Source badges on cards

### `src/app/heart/page.tsx`
- Same shared theme integration
- Skeleton loading state
- Gradient fills on area charts
- Updated legend styling

### `src/app/activities/page.tsx`
- Activity cards: `bg-surface-card rounded-[6px]` with hover border
- Type badges: `bg-white/5 text-[10px] font-mono uppercase tracking-wider rounded-[2px]`
- Numeric values: `font-mono`
- Empty state: styled message instead of plain text
- Skeleton loading

### `src/app/whoop/page.tsx`
- All 6 charts restyled with shared theme
- Recovery color bar chart preserved
- Journal heatmap table: surface-appropriate backgrounds, `hover:bg-white/[0.02]`
- Source badge and legend updates

### `src/app/eight-sleep/page.tsx`
- All 4 charts restyled
- Source badges: `8SLP`
- Gradient area fills

### `src/app/recovery/page.tsx`
- ScatterTooltip: `bg-surface-raised border-border-hover rounded-[6px] shadow-floating`
- Performance table: updated header/row styling with design tokens
- Color pill legends: `text-text-tertiary text-[11px] font-mono`
- All charts: shared theme integration

### `src/app/matrix/page.tsx`
- Multi-source charts use consistent source colors (Garmin blue, WHOOP amber, Eight Sleep violet)
- ICC subtitle styling
- Updated legend font

### `src/app/bland-altman/page.tsx`
- BAPlot component: restyled with design tokens
- Explanation card: `bg-surface-card border-border-subtle rounded-[6px]`
- Interpretation guide table: design-system table styling
- Empty/insufficient data states

### `src/app/insights/page.tsx`
- Section nav pills: `bg-surface-raised text-[11px] font-mono rounded-[2px]`
- All 5 sections: updated headers, descriptions, charts
- Q11 heatmap: design-token backgrounds
- Q12 hit/miss table: updated borders and text colors
- All chart tooltips/axes/grids: shared theme
- Warning card: updated border opacity

### `src/app/chat/page.tsx`
- User bubbles: `bg-accent` (cyan)
- Assistant bubbles: `bg-surface-raised border-border-subtle`
- Input: `bg-surface-card rounded-[4px] focus:ring-accent`
- Send button: `bg-accent rounded-[4px]`
- Empty state: updated text hierarchy

### `src/app/login/page.tsx`
- Background: `bg-surface`
- Card: `bg-surface-card rounded-[6px]`
- Input: `bg-surface-raised rounded-[4px] focus:ring-accent`
- Button: `bg-accent rounded-[4px]`

## Design Decisions

- **No tailwind.config.ts**: Project uses Tailwind CSS v4 which configures via `@theme` in CSS
- **Geist font**: Loaded via `geist` npm package + `next/font` integration
- **Area gradient fills**: `stopOpacity={0.15}` at top, `0` at bottom for subtle depth
- **6px card radius**: Sharp enough to feel professional, soft enough to not feel harsh
- **Source badges**: 9px mono text with source-specific colors for instant data provenance
- **Keyboard shortcuts**: Single-letter hints visible on `lg:` screens only
