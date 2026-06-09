# Onyx UI Refresh — Design Proposal

**Status:** proposal · pre-implementation
**Author:** Claude Code (design exploration pass)
**Scope:** frontend-only refresh of shared chrome (`AppShell`, `Sidebar`, `MobileNav`, `ChartCard`, `StatCard`, page padding) and the flagship `/analytics/hrv` page. No DB / API / ETL changes. Dark-mode only across all directions.

---

## 1. Audit — what exists today

### 1.1 Shared chrome

| Component | Today | Works | Broken / dated |
|---|---|---|---|
| `AppShell.tsx` | Renders `Sidebar` (desktop) + `MobileNav` (mobile) + a `max-w-6xl mx-auto` content slot. Auth pages bypass. | Layout switch by viewport is clean. Safe-area inset handling on iOS PWA is correct after the recent `pt-[calc(env(safe-area-inset-top)+4rem)]` fix. | Content is gated to ~1152px on huge displays — wastes screen on a 27" monitor. No skip-to-content. No theming hook beyond the single accent token. |
| `Sidebar.tsx` | Fixed 220px column, plain SVG icons inline, kbd shortcut letters on right, single-character accent bar on active route, sign-out at bottom. | Icons + labels + shortcut hints are scannable. Active state via 2px left bar is subtle but clear. | Every icon is a hand-pasted SVG `path` string — visually inconsistent stroke widths, no grouping. No section dividers in nav array (Sleep / Activities / Nutrition / Analytics / HRV / Travel / Bland-Altman / Habits / Journal / Supps / Spotify / Chat / Status is one undifferentiated list of 13). No collapsed state. No search/command-K. |
| `MobileNav.tsx` | Fixed top bar (`h-12`) with hamburger + "Onyx" wordmark, drawer slides in from left with the same nav array. | Drawer open/close, body-scroll lock, route-change auto-close, safe-area-inset wired correctly. | Top bar is the only persistent mobile surface — no bottom tab bar, no swipe-to-open drawer gesture, no PWA "back" affordance. Every primary action (log supp, log meal, log weight, log habit) requires drilling into a page → tapping a button. **The drawer nav duplicates the sidebar's nav array** rather than importing it — the CLAUDE.md convention forces a manual two-file edit on every change. |
| `ChartCard.tsx` | `bg-surface-card` (`#111113`), `border-border-subtle`, `rounded-[6px]`, `p-5`, optional `source` pill, `info` paragraph, optional collapse-with-localStorage. | Collapse memory is great; `info` text is genuinely educational. | One card style for everything — KPI rows, hero forecast, dense forest plots, narrative explainers all use the same chrome. The `source` pill (top-right `XGBOOST · SHAP`) is a strong pattern but visually weak. No "loading" / "empty" / "stale" header variants. No actions slot in the header (export, expand, link-to-section). |
| `StatCard.tsx` | Label (uppercase 10px), 28px mono value, optional unit, trend arrow+delta, optional source tag top-right. | Tabular-nums + mono is correct for biometric numbers. Trend coloring obeys `favorable: up/down`. | Value sits in a flat box — no spark / no trend strip / no context band. No min/max range. No "vs your baseline" hint. The 28px size is undersized for hero metrics; the Tomorrow's-HRV hero on `/analytics/hrv` had to bypass `StatCard` and re-implement at 36px to stand out. |
| `globals.css` tokens | `--color-surface #0A0A0B`, `--color-surface-card #111113`, `--color-surface-raised #1A1A1D`; 3 text tones (`#F4F4F5 / #A1A1AA / #71717A`); cyan accent `#06B6D4`; source colors (Garmin blue / WHOOP amber / 8Slp violet). | Three-tone-text + 3-step surface ramp is a good base. Borders as alpha-white (`6%`/`10%`) is correct for dark. | Only one accent. No semantic palette (success/warning/critical/info beyond ad-hoc `#22c55e` / `#ef4444` / `#f59e0b` strings inline). No data-encoding scale (sequential, diverging, categorical 8-step). Recharts uses raw hex strings everywhere. |

### 1.2 `/analytics/hrv` full surface (load-bearing — cannot regress)

The page is 2853 lines, with the following sections in scroll order. **Every one must survive the redesign.** Annotated by current concerns.

1. **Page header** — `h2 "HRV Deep Analysis"`, narrative subtitle ("Predictive modeling · Statistical drivers · {range} · N days"), FDR-explainer paragraph, `FDR-significant only` toggle, `RangeFilter` (30/90/180/365/all), "no data" banner.
2. **Row 1 — 3 hero KPI cards** (custom, not `StatCard`): Tomorrow's Predicted HRV (36px mono, 80% CI, delta-from-today, narrative), Model Accuracy 30d (MAE / directional / vs naive), Top Driver Today (label + SHAP value).
3. **Row 2 — 2-col grid:** "30-Day HRV Forecast" (Prophet area + SARIMAX line overlay), "Prediction Drivers (Today)" (XGBoost SHAP bars + Journal SHAP sub-section + Habit SHAP sub-section).
4. **Row 3 — 2-col grid:** "Prediction vs Actual" (line chart, red dots for misses), "Accuracy by Forecast Horizon" (multi-line h=1..7 across 5 models).
5. **Row 4:** "HRV Trend" (LineChart with rolling 7d).
6. **Row 5:** "HRV Correlates (Historical)" Spearman bars.
7. **Row 6:** Journal Behavior Impact, Habit Impact (Welch's t-test bars, side-by-side).
8. **Row 7:** Supplement Impact, Supplement Dose-Response (Spearman on continuous doses).
9. **Row 8:** Nutrition Correlations.
10. **Row 9:** Workout-to-Bed Gap vs Next-Morning HRV (binned scatter with median bedtime gap).
11. **Causal Inference section** (its own narrative card + sub-cards): Supplement coverage status, Causal Effects Binary Treatments (AIPW forest), Naive vs Adjusted table, Continuous Treatments (median-split forest), Causal DAG & Assumptions.
12. **Environment Sweet Spot** (room-temp × HRV bucketed bar with peak marker).
13. **Models & Methods** explainer (long copy section).
14. **Model Evaluation Detail** (table-style breakdown).

**Page-level concerns Riley flagged.**
- "Hard to scan" — the page is one long vertical scroll. The hero row is gone after one swipe on mobile; no sticky context, no in-page TOC, no anchored sections. The user can't get "is tomorrow good or bad?" and "what's driving it?" without scrolling.
- "Charts are bland" — Recharts defaults: thin grid lines, hex strings, no animations, no annotations on the chart canvas (CI is text below, never drawn), tooltips use the unstyled Recharts default in many cards.
- "Mobile is weak" — 80% of the page is wide chart cards laid out 1-col on small screens. Forest plots with 20 rows + error bars are unreadable below ~500px. The FDR toggle + range filter wrap awkwardly. No tap-and-hold for chart detail.
- "Dated" — Tailwind 4 default font (Geist is in deps but actually wired through Recharts text where?). 6px radii + flat 1px borders read as 2022-era Vercel-template aesthetic.

### 1.3 Functional contract that cannot be lost

- Sidebar + MobileNav nav arrays stay in sync (CLAUDE.md convention).
- All `ChartCard` instances keep collapsibility + `storageKey` + `info` + `source`.
- All 14 sections above keep their data shape + interactions (FDR toggle controls 8 charts; range filter drives 4).
- PWA installability + safe-area-inset behavior.
- The `chat` route, `journal` semantic search, supplements quick-log, weight log, activity tagging — all touched by share components but not in scope for this redesign — must keep working.

---

## 2. Three design directions

Each is genuinely different. The choice between them is a choice about **what kind of tool Onyx is**: a recovery oracle (Direction A), a research instrument (Direction B), or a quiet daily companion (Direction C).

---

### 2A. Direction A — "Terminal" *(Bloomberg-meets-Linear)*

**Thesis.** Onyx is a personal research instrument. Riley uses it like a quant uses a Bloomberg — to make decisions about training, supplementation, sleep, alcohol. Lean into that. Tight monospace numerics, dense KPI rails, sparklines everywhere, an information-first aesthetic with the accent color rationed to a single semantic role. Borrow density from Bloomberg + Linear, restraint from Vercel, and the "every pixel earns its place" instinct from all three. The user is *competent* — give them more data per square inch, not less.

**Color palette (dark-only).**
- Surface 0 (page background): `#08090B` (deep slate, near-black, slight cool cast)
- Surface 1 (card body): `#0E1014`
- Surface 2 (raised: tooltip, popover, sticky header): `#15181E`
- Surface 3 (hover / row stripe): `#1A1E26`
- Border subtle: `rgba(255,255,255,0.05)`
- Border default: `rgba(255,255,255,0.08)`
- Border emphasis (active row, selected): `rgba(120,200,255,0.30)`
- Text primary `#E8EAED`, secondary `#9AA0A6`, tertiary `#5F6368`, disabled `#3C4043`
- Accent (the *only* accent): cyan `#7DD3FC` — used for active nav, focus rings, selected row, exactly one CTA per screen
- Semantic for **HRV-direction encoding** (used everywhere consistently): up/good `#34D399`, down/bad `#F87171`, neutral `#9AA0A6`, low-confidence/dimmed `rgba(*,*,*,0.45)`
- Source colors retained but desaturated 15%: Garmin `#5B8DF6`, WHOOP `#F5A623`, 8Slp `#9A7BFA`, Cronometer `#22D3A6`, Spotify `#1ED760`
- Categorical 8-step (for habit / journal / supplement category bars), low-chroma: `#7DD3FC #F5A623 #34D399 #C084FC #F472B6 #FBBF24 #60A5FA #94A3B8`

**Typography.**
- Display KPI: **JetBrains Mono** at 44px / 600 / `tabular-nums` / `font-feature-settings: "ss01"` — heroes like Tomorrow's HRV.
- Section headings (h2): Geist Sans 18px / 600 / tracking `-0.01em`
- Card titles (h3): Geist Sans 12px / 600 / uppercase / tracking `0.08em` — Bloomberg-style row headers.
- Body: Geist Sans 13px / 400, line-height 1.5
- Numeric inline (units, deltas, sparkline labels): JetBrains Mono 11px / 500 / tabular
- Annotations on chart canvas: JetBrains Mono 10px / `fill-opacity: 0.7`

**Card / section treatment.**
- Cards are nearly flat: 1px border at 5% white, no shadow, 4px corner radius (down from 6px). Background steps Surface 1 → Surface 0 (page) so cards bleed in rather than float. Density: `p-4` default, `p-3` on rows of small cards, `p-6` only on hero.
- Section dividers are 1px lines with a 12px-wide colored tick at the left edge keyed to section function (forecast = cyan tick; descriptive stats = neutral; causal = amber tick; calibration = green). Borrowed from Bloomberg's color-keyed row headers.
- Every card header has 4 slots in monospace metadata: **TITLE** · `data_age` · `source` · `confidence_badge`. Example: `PREDICTION DRIVERS · 2h ago · XGBOOST·SHAP · n=178`.
- Card actions move to a `…` overflow on the right of the header (export CSV, copy link to section, collapse, view raw SQL) — collapsing the current single-icon affordance into a uniform menu.

**Chart styling rules.**
- Axis ticks: JetBrains Mono 10px, `#5F6368`. No axis-line stroke. Grid lines only horizontal, `rgba(255,255,255,0.04)`, dashed `2 4`. Y-axis label rotated 90° in tertiary tone.
- Tooltips: bordered Surface-2 card with monospace numerics, single 1px cyan top-edge accent, fixed position (right side, never overlapping the cursor). Tooltip rows: `KEY  →  value unit  ±ci`.
- Bar charts: rounded `2px` only on the leading edge, never both edges. Bar gap reduced from default 0.2 to 0.12 — denser packing.
- Lines: 1.5px stroke for primary, 1px dashed for projections. **No area fills under lines except where it encodes a CI band** — the Prophet forecast keeps its gradient because the gradient *is* the CI band; nothing else gets a gradient.
- Sparklines (NEW pattern): 60×20px inline sparkline inside every StatCard, drawn with `recharts` `<LineChart>` at no axes / no grid / 1px stroke, color-keyed up/down by current vs 7d-mean. Used in: the 3 hero cards, all KPI rows on `/sleep`, `/nutrition`, `/status` source cards. Borrowed from Bloomberg + Athlytic's widget aesthetic.
- Forest plots (causal): error bars rendered as 1px crossbars; treatment label left-aligned in 11px mono; effect column right-aligned monospace `+2.4 ms`; CI column `[+0.8, +4.0]`; E-value column `E=1.8`. Looks like a regression-output table that also has a graphical column. Sign-flip and BB-divergent treatments get a single-character marker (`↻`, `△`) in the rightmost column instead of inline parenthetical text.
- Heatmap-style annotation NEW pattern: a 1px-tall colored strip *under* the X-axis of every multi-day chart, encoding "weekend / travel-day / alcohol-night / hard-workout-day" with 4 thin color stripes — the day-context is always visible.

**Mobile behavior.**
- **Bottom tab bar replaces the top hamburger as the primary nav** — 5 tabs: Today, Trends, Log, Chat, More. The "Log" tab opens a sheet with the 4 quick-log primary actions (supplement / weight / meal / habit) — these are what Riley actually uses on phone. "More" opens the existing drawer for the secondary routes.
- Long-list nav (HRV Analysis, Travel Analysis, Bland-Altman, Status, etc.) lives in a `cmd+K`-style searchable list under "More" — desktop also gets `cmd+K` open-anywhere.
- Touch targets: minimum 44×44 (iOS HIG), KPI hero cards 88px tall, swipe between hero cards on the HRV page (horizontal scroll-snap container). Forest plots become *vertical lists with inline mini-bars* on mobile instead of trying to compress the bar canvas — a row reads `+2.4 ms ████░░ alcohol`.
- All charts pinch-zoom and tap-to-show-tooltip; tooltips render bottom-anchored on mobile (above the bottom-tab bar).

**ASCII layout — `/analytics/hrv` top-fold, Direction A.**

```
┌─ ONYX ──────────────────────────────────────────────────────────────────────┐
│  HRV ANALYSIS    [FDR✓ ON]  [30d 90d 180d 1y ALL]    n=178 · updated 2h ago │
│  Predictive modeling · 178 days of data                                      │
├──────────────────────────────────────────────────────────────────────────────┤
│  ┃  TOMORROW         │  MODEL  ACCURACY      │  TOP  DRIVER  TODAY          │
│  ┃  ──────────────   │  ──────────────────   │  ─────────────────────────── │
│  ┃   62 ms           │   3.4 ms MAE          │   alcohol  (last night)      │
│  ┃   ▁▂▃▅▆▇▇▆▅       │   ▆▆▇▆▅▅▆▇▇          │   ▼ -4.2 ms  shap contribution│
│  ┃   80% CI 56–68    │   71% directional     │   green→bad red→good         │
│  ┃   ↑ +2.1 vs today │   vs naive 4.9  ✓     │   FDR✓  n=18                 │
│  ┃   XGBOOST   2h    │   XGBOOST     2h      │   XGBOOST·SHAP    2h         │
├──────────────────────────────────────────────────────────────────────────────┤
│ ┃ 30-DAY HRV FORECAST · PROPHET + SARIMAX · 2h ago · 80% CI                  │
│ ┃ 90┤                                          ╭─.─.─.── sarimax            │
│ ┃ 70┤        ●●●●●●  ●●●●                  ╭───╯ ╭─── prophet               │
│ ┃ 50┤    ●●●●     ●●    ●●●●●●●●─.─.─.─.─.─╯                                │
│ ┃ 30┤●●●●                          shaded uncertainty                       │
│ ┃    └────────────────────────────┬─────────────────────────────────        │
│ ┃    [contextual day strip]  ▌▌▌▌▌▌  ▌▌▌  ▌▌▌▌  weekend·alcohol·hard       │
│ ┃                                                                            │
│ ┃ PREDICTION DRIVERS (TODAY)  · XGBOOST·SHAP · 2h ago                        │
│ ┃   alcohol last night         ▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌ +4.2  FDR✓     │
│ ┃   workout strain (yesterday)            ▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌▌  −1.8  FDR✓     │
│ ┃   sleep duration                  ▌▌▌▌▌▌▌▌                  +1.2          │
│ ┃   ascot mineral 200mg          ▌▌▌▌▌                       +0.6          │
│ ┃   (8 more …)                                                              │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Cost to build.** **Medium.** Existing components mostly survive (`ChartCard`, `StatCard`) but gain new variants: `KpiTile` (the new 88px hero with sparkline), `MetadataRow` (the 4-slot card header), `Sparkline` (new reusable). Bottom tab bar is the largest mobile addition. Recharts theming layer (`chartTheme.ts`) becomes a new dep-free module that exports `gridStyle / axisTick / chartTooltip / chartColors` so every chart pulls from one place — also unlocks tightening up the per-chart 30+ ad-hoc style objects on the HRV page. New deps: `lucide-react` (~ replaces inline SVG paths in nav + adds a real icon set), optionally `tailwind-variants` for `ChartCard` variants.

---

### 2B. Direction B — "Athletic Editorial" *(Oura-meets-Athlytic)*

**Thesis.** Onyx is a daily companion that interprets Riley's body before showing the math. Lead with one big readable number, a one-sentence narrative, color-coded zones. Detail is reachable but folded behind progressive disclosure. Editorial typography (a serif for the narrative voice, a tight sans for UI, mono only for numeric receipts). The aesthetic is calm, premium, *health-product* — Oura's spaciousness and "one big thing" hierarchy is the spine; Athlytic's KPI strip with sparklines is the daily glance; WHOOP's color-coded recovery ring is the morning anchor.

**Color palette (dark, but warmer than A).**
- Surface 0: `#0F0E12` (deep aubergine-black, ~3% red bias)
- Surface 1: `#16151B`
- Surface 2: `#1F1D25`
- Borders: `rgba(245,240,255,0.06)` / `rgba(245,240,255,0.10)`
- Text primary `#F2EEE8` (warm white), secondary `#9D9AA6`, tertiary `#6A6772`
- **HRV "zone" scale (the visual centerpiece)** — a 5-stop perceptual gradient from cold-bad to warm-good, applied to ring fills, KPI numeric colors, and bar fills consistently:
  - `#E94B6A` (critical low)
  - `#F59E58` (caution)
  - `#F5D061` (moderate)
  - `#7BC97F` (good)
  - `#4CC4B0` (great)
- Accent: warm coral `#FF7A6B` — used only for primary CTAs and brand. Never for data.
- Source colors retained, slightly warmer: Garmin `#6B9DFF`, WHOOP `#FFB452`, 8Slp `#B89AFF`.

**Typography.**
- Display KPI (the readiness-score-equivalent — Tomorrow's HRV): **Tiempos / Source Serif Pro** 80px (desktop) / 64px (mobile) / 300 weight. Like Oura's readiness number. Single high-impact ligature feel.
- Section headings: Geist Sans 22px / 500 / `tracking-tight`
- Card titles: Geist Sans 14px / 600
- Narrative copy: serif 16px / 1.6 line height — "today your HRV is trending below your 28-day baseline. Heavy strain yesterday and 2 drinks Thursday are the largest negative contributors…"
- Body UI: Geist Sans 14px / 400
- Numeric mono: Geist Mono 12-13px — used only for receipts (n=, p=, CI bounds), never for hero values (those are serif).

**Card / section treatment.**
- **Generous padding** (`p-6`, `p-8` for hero), `12px` border radius, subtle inner highlight (`box-shadow: inset 0 1px 0 rgba(255,255,255,0.03)`) for soft top-edge sheen.
- Hero card (the daily snapshot) gets a `border-radius: 24px`, a soft radial gradient background keyed to today's HRV zone color (10% opacity), a serif readiness-style numeric, and a one-paragraph narrative below.
- Section anatomy: a section is a wide `h2` + a one-line italic serif kicker ("what's driving your forecast right now") + cards.
- Card density: **fewer charts per fold**. Each section's primary chart gets one card; secondary tables collapse behind a "see detail" disclosure. ChartCard's `collapsible` semantics are preserved — they become the *default* on the second-tier cards. Section TOC (sticky) appears as right-rail on desktop ≥1280px.
- Soft elevation: `0 4px 24px rgba(0,0,0,0.25)` on cards, much softer than current.

**Chart styling rules.**
- Axis ticks: Geist Sans 11px (not mono), low-emphasis tone. X-axis baseline visible at `rgba(255,255,255,0.06)`. No grid lines on small charts; a single `4 4` dashed horizontal at the *baseline or mean* on trend charts.
- Tooltips: large, rounded (16px), Surface-2, serif label + sans value + mono number — looks like a small card popping out. Always anchored top-center of cursor.
- Lines: 2px stroke for primary metric, gradient fill below (10% → 0% from value color), dots only at the most-recent point. Borrowed directly from the Oura app trend strips.
- Bars: rounded `4px` both ends, fill gradient bottom-up (90% → 100%), 60% opacity for non-significant rows when FDR-on, full opacity for survivors.
- **Recovery-ring KPI for the daily HRV hero** (NEW pattern): a circular progress arc using SVG `<circle>` 200×200 with stroke-dasharray driven by today's HRV percentile within the user's all-time range. Color from the 5-stop zone scale. Numeric centered inside. Borrowed from WHOOP/Oura.
- Forest plots (causal): rendered as **stacked rows with horizontal bars centered on zero**, value chip on the left in numeric mono (`+2.4 ms`), CI bar drawn graphically, sign-flip indicator as a small chip on the right (`↻ sign flip` rather than just `↻`). Per-row 28px tall — taller than A, more readable on phone.
- Annotations on chart canvas: small text labels in serif italic anchored to inflection points ("longest streak", "peak", "first run after illness") — Levels CGM does this for meal-time annotations.

**Mobile behavior.**
- **Card-first scrolling** with snap-to-card. Each major section is a "full-screen-ish" card you swipe past. The hero "Today" card is full-bleed and ~70% of the screen on first load.
- Top of mobile screen has a small persistent date header (`Sun · Jun 7` + zone color dot for today). No bottom tab bar in this direction — instead, drawer remains but the **hero card itself has primary action chips** ("log supplement", "log meal", "ask Claude") at the bottom of the card.
- Forest plots collapse to "top 5 + show all (12 more)" on mobile; tap to expand into a full-screen drawer.
- Touch targets ≥ 48px (Material). Pinch-zoom on charts.
- A floating "ask Claude" pill in the bottom-right (replacing the chat nav item's prominence) — feels like a recovery assistant.

**ASCII layout — `/analytics/hrv` top-fold, Direction B.**

```
                                                                              
   HRV Analysis                                       [30d 90d 1y ALL] [FDR✓]│
   Predictive modeling · 178 days                                            │
   ─────────────────────────────────────────────────                         │
                                                                              
   ╭───────────────────────────────────────────────────────────╮              
   │                                                           │              
   │             ╭─────────────╮       Tomorrow's HRV          │              
   │             │             │                               │              
   │             │     62      │       80% CI · 56–68 ms       │              
   │             │     ms      │       ↑ +2.1 vs today         │              
   │             │             │                               │              
   │             ╰── 62%ile ──╯                                │              
   │                                                           │              
   │   "Your HRV is trending below your 28-day baseline.       │              
   │    Heavy strain yesterday and last night's drinks are the │              
   │    largest negative contributors. Sleep duration is       │              
   │    pulling the forecast up by 1.2 ms."                    │              
   │                                                           │              
   │   [ log supp ]  [ log meal ]  [ ask Claude ]              │              
   │                                                           │              
   ╰───────────────────────────────────────────────────────────╯              
                                                                              
   Forecast    What's driving it    How accurate    Behaviour                
   ───────────────────────────────────────────────────────                   
                                                                              
   ╭── 30-day Forecast ──────────────────────────────╮                       
   │  Prophet + SARIMAX                              │                       
   │   90                                            │                       
   │   70 ●●●●●●●●●●●●●╲                             │                       
   │   50          ╲───╲───────────  (uncertainty)   │                       
   │   30                                            │                       
   ╰─────────────────────────────────────────────────╯                       
                                                                              
   ╭── Top Drivers Today ────────────────────────────╮                       
   │  alcohol last night            ━━━━━━━━━ +4.2   │                       
   │  workout strain                   ━━━━━━ −1.8   │                       
   │  sleep duration                ━━━━━━ +1.2      │                       
   │  ▾ show all 11 drivers                          │                       
   ╰─────────────────────────────────────────────────╯                       
```

**Cost to build.** **Medium-large.** Hero card is a real new component (`DailySnapshot.tsx`) with the recovery ring SVG. Serif font load is a new dep (Tiempos isn't free — `Source Serif Pro` from Google is the fallback). The narrative-paragraph data depends on existing fields the page already loads, so no API change. `ChartCard` gains a `tone: "primary" | "secondary"` variant; `StatCard` gets a `ring` variant. Mobile card-snap container is new. The biggest unknown is whether the readiness ring + narrative paragraph generation feels "magic" or "padded" — both need a careful first pass.

---

### 2C. Direction C — "Lab Notebook" *(Linear-meets-Stripe restraint, but quieter)*

**Thesis.** Onyx is Riley's lab notebook. Get out of the way. Reduce visual noise to nothing, treat the page as a precise document, use color *only* for data encoding (never decoration). The aesthetic is the *opposite* of "designed" — it's "edited". Borrow from Linear's restraint, Stripe's information hierarchy, Vercel's pure monochrome plus a single accent, and the discipline of academic / R-markdown / Jupyter notebook layout. The product feels like a tool you've owned for years and grown into — not a freshly designed product showing off.

**Color palette (the quietest of the three).**
- Surface 0: `#0A0A0A` (true grayscale, no color cast)
- Surface 1: `#121212` (cards barely lift)
- Surface 2: `#181818` (sticky header, tooltip)
- Borders: `rgba(255,255,255,0.06)` / `rgba(255,255,255,0.09)`
- Text primary `#EDEDED`, secondary `#A0A0A0`, tertiary `#6B6B6B`, disabled `#404040`
- **Accent: indigo `#6366F1`** — rationed to a single primary action per screen + active nav + focus rings. Not used for data encoding ever.
- **Data encoding palette** — kept deliberately small and reused consistently:
  - Up / favorable: `#16A34A` (more saturated than A's `#34D399` — pops harder against the very-quiet ground)
  - Down / unfavorable: `#DC2626`
  - Neutral: `#A0A0A0` (same as secondary text — data and labels share tone deliberately)
  - Categorical 5: `#6366F1 #06B6D4 #F59E0B #EC4899 #14B8A6` — used only when categories are unavoidable (model comparison)
- Source colors are *removed from the palette*. Instead, source is encoded as a single-character monospace prefix (`G·` Garmin / `W·` WHOOP / `8·` Eight Sleep / `C·` Cronometer / `S·` Spotify) in tertiary tone, in the metadata strip. This drops ~4 accent colors from the page.

**Typography.**
- Display KPI: Geist Sans 36px / 600 / `tabular-nums` — same sans family as body, just bigger and tighter. No mono family fork.
- Section headings: Geist Sans 16px / 600 / tracking `-0.01em`
- Card titles: Geist Sans 13px / 500 / tone tertiary (intentionally quieter than body)
- Body: Geist Sans 14px / 400 / line-height 1.55
- Numeric: Geist Sans `font-variant-numeric: tabular-nums` — *no separate mono family*. The discipline of one type family is the aesthetic.
- Captions / receipts (n=, p=): Geist Sans 11px / 400 / tertiary tone

**Card / section treatment.**
- Cards reduced to **near-invisible separators** rather than boxes — `border-top: 1px solid border-subtle`, padding only, no border-radius, no shadow. The page reads as one continuous scroll of sections divided by hairlines, like a long Stripe docs page or a Linear changelog.
- Card titles sit *outside* the card body to the left, in a 200px narrow column on desktop (`grid-template-columns: 200px 1fr`) — exactly like Stripe's API docs layout. Chart and content fill the right column. On mobile, title sits inline above content.
- Density: `py-8` between sections. Generous whitespace.
- The only "card-like" boxes that remain are: KPI tiles in the hero row (still bordered, 1px, 4px radius, but Surface 0 — i.e. they look like content blocks rather than floating cards) and modal/popover surfaces.
- Section anchors: each section has a slugged `<h2 id>` and a hairline-keyed table-of-contents in a sticky right rail on `≥xl` viewports.

**Chart styling rules.**
- Axis ticks: Geist Sans 10px tertiary. Y-axis labels rotated 90° at left edge of plot. **One label per axis (the axis title), no in-plot legend** — when there are multiple series, the legend is rendered as a 3-line caption *above* the chart in the same column as the chart title.
- Grid: none. The y-axis line carries small tick marks; the x-axis carries date ticks. The plot itself is empty white space. Borrowed from FT and Economist statistical graphics.
- Tooltips: minimal Surface-2 popover, hairline border, no shadow. Two-line content: top line is the date in tertiary tone, bottom line is the value in primary tone.
- Lines: 1.5px stroke, no dots, no gradient, no fill. Active point on hover gets a 4px filled dot. That's it.
- Bars: 0 radius (flat). One color per chart unless the chart's job is to compare categories. Bars below zero render in down-color, above-zero in up-color (HRV-impact charts) — color is data, not decoration.
- Forest plots: rendered as a typeset table with a graphical column — looks like a regression-output table. The graphical column is a 120px-wide canvas with the error bar drawn as a 1px line, dot at point estimate, vertical hairline at zero. *No* fill. Reads like an academic forest plot from a paper.
- Annotations: small subscript caret labels (`ᵃ`, `ᵇ`) with footnote-style notes below the chart. Sign-flips and BB-divergent treatments are footnoted, not iconographed.

**Mobile behavior.**
- Drawer nav retained but slimmer (48px wide collapsed strip with icon-only, expands to 220px on tap). No bottom tab bar — the philosophy here is "the page is the surface, not the chrome".
- The hero KPI row (3 tiles) becomes 3 *horizontally-scrolling rectangles* with snap-points — same as A but plainer (no sparklines, just numeric + delta).
- All cards / sections are full-width on mobile, single-column. No collapsing-by-default — full content visible — but a quick-jump TOC overlays as a floating button when scrolling past section 2.
- Forest plots on mobile: same typeset-table approach, just narrower graphical column (60px). Already mobile-friendly because the graphic isn't carrying weight — the numbers are.

**ASCII layout — `/analytics/hrv` top-fold, Direction C.**

```
                                                                              
HRV Analysis                                              [30d 90d 1y]  [FDR✓]
Predictive modeling · 178 days                                                
═══════════════════════════════════════════════════════════════════════════════
                                                                              
   62 ms              3.4 ms             alcohol                              
   tomorrow           model accuracy     top driver                           
   80% CI 56–68       MAE · 71% dir.     −4.2 ms · FDR✓                       
   ↑ +2.1 vs today    vs naive 4.9 ✓     XGBOOST · SHAP                       
                                                                              
───────────────────────────────────────────────────────────────────────────────
                                                                              
 Forecast              30-day forecast (Prophet + SARIMAX)                    
 Tomorrow's HRV with                                                          
 prophet trend &       90 ┤                                                   
 SARIMAX cross-check.  70 ┤  ●●●●●●●●●●●─.─.─.─.─.─.─.─.─.                    
                       50 ┤                ──────────────────                 
                       30 ┤                                                   
                          └──────────────────────────┬───────                 
                          Jan          Mar        May  Jun                    
                                                                              
                       Prophet (orange) · SARIMAX (purple) · actual (green)   
                                                                              
───────────────────────────────────────────────────────────────────────────────
                                                                              
 Drivers today         What's pushing tomorrow up or down                     
 XGBoost SHAP                                                                 
 attribution.          alcohol last night          ─────●─────  +4.2  FDR✓    
                       workout strain                  ──●──    −1.8  FDR✓    
                       sleep duration                    ●─────  +1.2         
                       mineral 200mg                     ●──     +0.6         
                       … 11 more                                              
                                                                              
                       ᵃ p_raw shown; FDR survivors marked. ↻ = sign flip.    
                                                                              
───────────────────────────────────────────────────────────────────────────────
```

**Cost to build.** **Small-medium.** Most of the work is *removal* — strip borders, strip shadows, strip the second type family, prune the color palette. `ChartCard` becomes much simpler (it loses the box; it becomes a `<Section title={} description={}>` wrapper that lays out the 200px+1fr grid). `StatCard` gets simplified — no source pill, no shadow, just the data. The recharts theme becomes the *quietest* of the three (no grid, no gradients, no dots). Sidebar tweaks are smaller — collapsible width + a single accent. New deps: just `lucide-react` for icons.

---

## 3. Recommendation — **Direction A (Terminal)**

I'm picking Direction A. The reasoning, in order:

1. **It fixes all four pain points simultaneously.** Density (KPI rails + sparklines + 4-slot metadata header) fixes "too much scrolling". Mono+sans split + a tightened palette fixes "dated / generic Tailwind". The day-context strip below charts + restyled tooltips fix "charts are bland". The bottom-tab-bar + log-sheet pattern is a real PWA improvement, not a cosmetic one.
2. **It's the most honest fit for how Riley uses this product.** This isn't a wellness app for casual users. It's a research instrument used daily by someone who builds the SQL behind it. Direction B's serif-and-narrative aesthetic risks feeling padded when the user is the analyst. Direction C is gorgeous but might be *too quiet* — Riley has flagged "important numbers are buried" as a problem, and C's "remove the boxes" instinct doubles down on quiet rather than hierarchy.
3. **It scales to the rest of the app.** The same KpiTile + sparkline + metadata-row vocabulary applies cleanly to `/status` (already KPI-heavy), `/spotify` (KPI + sparklines fit naturally), `/supplements` (compound rollup table). Direction B's hero-card pattern is harder to repeat across 13 pages; Direction C's no-card scheme works for HRV but reads thin on a logging page like `/supplements`.
4. **The mobile fix is meaningful.** Bottom tab bar + log-sheet is the single biggest experiential improvement on the table — Riley logs supplements and weight from phone daily. None of the directions can fix that without restructuring the mobile primary surface, and A is the only one that commits to it.
5. **Cost is moderate, not large.** The redesign reuses `ChartCard` / `StatCard` shells with new variants rather than ripping them out. The chart theming layer is genuinely useful refactor independent of aesthetic. Most "Terminal" work is small, additive components.

---

## 4. Rollout plan

Implementation order, one PR per stage. Each stage is independently shippable and verifiable.

### Stage 1 — Tokens + theme layer (shared chrome foundation)
- **Files touched:** `frontend/src/app/globals.css` (full token rewrite per Direction A palette), new `frontend/src/lib/chart-theme.ts` (exports `gridStyle`, `axisTick`, `chartTooltip`, `chartColors`, `seriesColor(metric)`, `directionalColor(value)`).
- Add `lucide-react` dep, install JetBrains Mono via `geist`-style next/font wrapper or `@next/font`.
- Add semantic color tokens: `--color-up`, `--color-down`, `--color-neutral`, `--color-low-conf`, `--color-source-*` (kept).
- Smoke tests: no copy/route changes; existing pages keep rendering. Visual diff allowed. Re-run `npx playwright test` — empty-state strings unchanged, FK still passes.
- **Commit:** `refresh(tokens): adopt Terminal palette + chart-theme module`.

### Stage 2 — Shared component refactor
- **Files touched:** `ChartCard.tsx`, `StatCard.tsx`, new `KpiTile.tsx` (88px hero with sparkline), new `Sparkline.tsx`, new `MetadataRow.tsx`, new `SectionHeader.tsx` (with the colored left-edge tick).
- `ChartCard` gains: `variant: "primary" | "secondary" | "compact"`, `freshness?: { lastUpdate: Date }`, `actions?: ReactNode` (overflow menu slot), `confidence?: { n: number, fdrPasses?: boolean }`.
- `StatCard` gains: `sparkline?: { values: number[], color?: string }`, `band?: { low: number, high: number }`.
- Backwards-compat: every old `ChartCard` prop still works; new props are additive.
- Smoke tests still pass — visual diff only on `/analytics/hrv` (because the props are added there in Stage 3).
- **Commit:** `refresh(chrome): ChartCard/StatCard variants + KpiTile + Sparkline`.

### Stage 3 — Shared chrome — `AppShell`, `Sidebar`, `MobileNav`
- Sidebar: replace inline SVG paths with `lucide-react` icons, add section dividers (Logging / Insights / Tools), wider clickable area, focus ring on `Tab`.
- **Extract nav into a single `lib/nav.ts` source-of-truth** consumed by both `Sidebar` and `MobileNav` — fixes the long-standing CLAUDE.md "two arrays drift" problem in passing. *(This is a free win — call it out in the commit.)*
- MobileNav: **add bottom tab bar** with 5 tabs (Today / Trends / Log / Chat / More). "Today" links to `/sleep` (current default after `/` redirect). "Log" opens a sheet with the 4 quick-log actions (`/supplements`, `/nutrition` log section, `/habits`, weight via a small inline form). "Trends" defaults to `/analytics/hrv`. "More" opens the existing drawer.
- Add `cmd+K` global command palette (existing routes only — no new data fetches) — leverages the same `lib/nav.ts`.
- Smoke tests: **must add a `bottom-tab-bar present on mobile viewport` assertion** in `frontend/e2e/smoke.spec.ts`. Update `PAGES` array if any nav text changes.
- **Commit:** `refresh(chrome): bottom tab bar + cmd-K + shared nav source`.

### Stage 4 — `/analytics/hrv` page restructure (the flagship)
- Replace 3-card hero with `KpiTile` × 3 (with sparklines).
- Apply `SectionHeader` with colored ticks: forecast-cyan / descriptive-neutral / causal-amber / calibration-green.
- Pipe every Recharts component through `chart-theme.ts` — remove every ad-hoc hex string and inline style object on this page.
- Add the day-context strip under multi-day charts (weekend / alcohol / hard-workout / travel — all already available in the loaded matrix).
- Rewrite the 7+ forest-plot-like sections (correlates, journal impact, habit impact, supp impact, nutrition, causal binary, causal continuous) to use the new "typeset-table-with-graphical-column" pattern from the Direction A spec.
- Add a sticky in-page TOC (right rail ≥xl) with section anchors.
- Mobile: forest plots become vertical lists with inline mini-bars; hero tiles scroll-snap horizontally.
- **No semantic / data-fetch / FDR-toggle / range-filter change.** Every existing function survives.
- Smoke tests: update `frontend/e2e/smoke.spec.ts` HRV-specific assertions — the empty-state strings ("not yet computed", "Run hrv_analysis.py to compute correlations") **must remain unchanged** and unasserted-as-present. Add an `KpiTile data-testid="hero-tomorrow-hrv"` assertion that the value renders.
- **Commit:** `refresh(hrv): apply Terminal direction — hero KPIs, section ticks, chart theme, sticky TOC`.

### Stage 5 — Roll Direction A through the other 12 routes
- One PR per page (or batch by similarity): `/status` (KPI heavy — natural fit) → `/spotify` (KPI + sparkline natural fit) → `/sleep` → `/nutrition` → `/activities` → `/supplements` → `/habits` → `/journal` → `/chat` → `/heart` → `/whoop` → `/eight-sleep` → `/bland-altman` → `/analytics/travel`.
- Each PR is small: swap chart-theme imports, replace hero with `KpiTile`, use `SectionHeader`. The semantic logic on each page is untouched.
- Smoke tests: update per-page empty-state strings if any copy moves.
- **Commits:** `refresh(<page>): apply Terminal direction`.

### Smoke-test integration
The current smoke spec (`frontend/e2e/smoke.spec.ts`) is the right tripwire to keep this honest. Per CLAUDE.md "empty-state fallback present where data should exist = test failure". Two updates needed up-front:
- After Stage 3, add `bottom-tab-bar visible on mobile viewport (chromium iPhone preset)` assertion.
- After Stage 4, swap any HRV-specific element selectors from class-based to `data-testid` based, because Direction A introduces new wrapper components and the brittle "this card exists" checks need to be redirected. The *string-absence* tests stay verbatim.

The CI smoke job (`.github/workflows/smoke-test.yml`, runs every 6h) will surface any regression within 6 hours of merge — that's our safety net for "did Direction A accidentally hide the HRV Correlates chart's bars?"

---

## Appendix — references

Direction-by-direction inspiration trace:

**Direction A (Terminal)**
- Density + colored row-keys + monospace numerics: Bloomberg terminal ([Bloomberg LP on UX](https://www.bloomberg.com/company/stories/how-bloomberg-terminal-ux-designers-conceal-complexity/), SAS terminal clone)
- Mono-sans hybrid + restraint + accent rationing: [Linear / Vercel / Stripe](https://www.pixeldarts.com/en/post/four-design-principles-behind-stripe-linear-and-vercel)
- Sparklines-in-KPI-tiles: Athlytic widgets
- Day-context strip under charts (weekend/travel markers): Strava effort comparison overlay, Levels CGM meal-annotation strip

**Direction B (Athletic Editorial)**
- Big serif daily number + one-sentence narrative: [Oura new app design](https://ouraring.com/blog/new-app-design/) ("one big thing")
- Recovery ring KPI: WHOOP recovery score (compress dozens of signals to one 0–100 number) + Oura readiness
- Color-coded zones + tooltip-as-card: Levels CGM glucose-curve annotation patterns
- Premium dark-mode warmth + soft elevation: Eight Sleep Pod app aesthetic

**Direction C (Lab Notebook)**
- Title-in-left-column + content-right + hairline dividers: Stripe API docs
- Restraint, one-family typography, rationed accent: Linear + Vercel
- Statistical-graphics minimalism: FT / Economist data graphics
- Forest-plot-as-typeset-table: academic regression output

**HRV-specific UX studied** (none directly cloned; each informed how Onyx surfaces its own analytics)
- [WHOOP design breakdown](https://www.925studios.co/blog/whoop-design-breakdown) — compression of dozens of signals to one number
- [Welltory HRV interpretation](https://help.welltory.com/en/articles/4380824-how-we-interpret-your-heart-rate-variability-metrics) — color-coded green/yellow/red zones
- HRV4Training Pro — 7-day moving average + normal range band
- Athlytic — clean glanceable widgets, 24/7 multi-metric monitoring

---

## Implementation — Stage moves log

Tracking every file/route/component **moved, renamed, consolidated, split, added, or removed** per stage, plus the no-data-loss accounting required by the rollout brief. Branch: `ui-refresh` (headless build; do not merge).

### Stage 1 moves — tokens + chart-theme + fonts

**Files modified (no moves/renames):**
- `frontend/src/app/globals.css` — full `@theme` token rewrite to the Direction A ("Terminal") palette: Surface 0–3 (`#08090B`→`#1A1E26`), rationed cyan accent `#7DD3FC`, semantic HRV-direction tokens (`--color-up/down/neutral/low-conf`), desaturated source colors + new `--color-source-cronometer/spotify`, section-tick tokens (`--color-tick-forecast/descriptive/causal/calibration`), flattened card shadow (`--shadow-card: none`), and a mono-led `--font-mono` (JetBrains Mono → Geist Mono fallback) + new `--font-display`. Added a `.font-display` utility (ss01 + tabular-nums). All prior token *names* retained, so no consumer breaks.
- `frontend/src/lib/chart-theme.ts` — extended (not replaced). Repointed existing exports (`chartTooltip`, `axisTick`, `gridStyle`, `sourceColors`, `accentColor`, `axisLabel`) to the Direction A values + `--font-mono`. **Added** `chartColors` (semantic + categorical-8 + source + section-tick), `seriesColor(metric)` (deterministic source/metric→color), `directionalColor(value, {favorable})` (signed→up/down/neutral). Every prior import path still resolves.
- `frontend/src/app/layout.tsx` — load JetBrains Mono via `next/font/google` (`--font-jetbrains-mono`), add its variable to `<html>`, update PWA `themeColor` `#0A0A0B`→`#08090B`.
- `frontend/src/lib/queries.ts` — one-line `let prior`→`const prior` (`prefer-const`). See deviation note below.

**Files added:**
- `frontend/.eslintrc.json` — **the repo had no ESLint config**, so `npm run lint` (`next lint`) went interactive and the required per-stage lint gate could not run. Reconstructed the intended config (`next/core-web-vitals` + `next/typescript` — the latter proven necessary by pre-existing `@typescript-eslint/no-explicit-any` disable directives across the codebase), with `e2e/` + `playwright.config.ts` ignored (they're already excluded from `tsconfig.json`).

**Dependencies added:**
- `lucide-react@1.17.0` — per proposal Stage 1; replaces hand-pasted inline SVG nav icon `path` strings in Stage 3. (No other dep; JetBrains Mono needs no package — `next/font` self-hosts it at build time.)

**Deviation from brief (surfaced, not silently absorbed):** wiring the lint gate exposed exactly one pre-existing **error** (`queries.ts:902` `prefer-const`) — fixed (the variable is `.add()`-mutated, never reassigned, so `const` is correct). It is outside the Stage-1 file set but is a prerequisite for "lint must pass". The remaining ~9 pre-existing `no-unused-vars` **warnings** are non-failing and left untouched (not introduced by this refresh).

**No-data-loss:** zero — Stage 1 is tokens/theme/fonts only. No route, component, chart, KPI, table, modal, button, chat tool, or PWA capability added, moved, consolidated, or removed. Visual diff only.

### Stage 2 moves — shared component layer

**Components added (`frontend/src/components/`):**
- `Sparkline.tsx` — 60×20 inline Recharts sparkline (no axes/grid, 1px stroke, hidden domain pinned to dataMin/dataMax). Auto-colors via `directionalColor()` (last-vs-mean) unless an explicit color is passed. Adopts `chart-theme.ts`.
- `MetadataRow.tsx` — Bloomberg-style monospace `·`-joined metadata strip (the 4-slot card header vocabulary: title · age · source · confidence). Tone-aware segments; falsy entries dropped.
- `SectionHeader.tsx` — 1px divider + 12px colored left-edge tick keyed to section function (forecast/descriptive/causal/calibration or raw color) + 18px Geist title + kicker + right-aligned actions slot + anchor `id` for the Stage-4 TOC.
- `KpiTile.tsx` — Direction A hero KPI (min-h-88px): cyan left tick, uppercase label, 34→40px JetBrains-Mono display value, inline sparkline, CI/sub line, signed delta (color via `directionalColor`), mono metadata footer, `testId` passthrough (for the Stage-4 `data-testid="hero-tomorrow-hrv"` assertion).

**Components modified (backwards-compatible — every existing prop/behavior preserved):**
- `ChartCard.tsx` — added `variant` (`primary`/`secondary`/`compact` → p-5/p-4/p-3), `freshness` (client-computed "Xh ago", hydration-safe via effect), `actions` (right header slot, rendered outside the collapse `<button>` to avoid nested-button HTML), `confidence` (`n=` + `FDR✓` badge), `tick` (colored left edge), `id` (anchor). Header now composes a `MetadataRow` (age · source · confidence) under an uppercased 12px `h3` **whose text content is unchanged** (CSS-only uppercase ⇒ accessible name preserved ⇒ smoke `getByRole("heading", …)` selectors still match). Root keeps `bg-surface-card` (smoke `div.bg-surface-card` filter), 6px→4px radius, flat (no shadow). Collapse + `storageKey` + `info` + `subtitle` + `source` all intact.
- `StatCard.tsx` — added `sparkline` (`{values,color?,favorable?}`) and `band` (`{low,high,unit?}`); value face → `font-display` (JetBrains ss01 tabular); trend colors → `text-up`/`text-down` tokens; source map extended with `CRONOMETER` + `SPOTIFY`; 6px→4px radius, flat. All prior props (`label/value/unit/sublabel/trend/source`) unchanged.

**No-data-loss:** zero — Stage 2 adds reusable components and extends two shells with optional props. No page consumes the new components yet (Stages 4–5 do), so no route/chart/KPI/table/modal/button/chat-tool/PWA surface moved or removed. Pages already using `ChartCard`/`StatCard` inherit the Direction A restyle (visual diff only); all their headings, data marks, and empty-state strings are unchanged.

### Stage 3 moves — shared chrome (AppShell / Sidebar / MobileNav + nav.ts)

**Added:**
- `frontend/src/lib/nav.ts` — **the single source of truth for primary navigation** (the "free win"). `NAV_SECTIONS` (Logging / Insights / Tools) + flat `NAV_ITEMS`, each entry carrying `href`, `label`, `shortcut`, a `lucide-react` `icon`, and palette `keywords`. **Retires the two hand-maintained `nav` arrays** that the CLAUDE.md "Sidebar + MobileNav must stay in sync" convention previously policed by manual two-file edits — they now import from here, so the drift class of bug is gone for Stage 5.
- `frontend/src/components/CommandPalette.tsx` — global ⌘K / Ctrl+K palette. Navigation-only (existing routes, no new fetches); fuzzy-matches `NAV_ITEMS` label/href/keywords; arrow + Enter + Esc; also opens on the `OPEN_COMMAND_PALETTE` window event (used by the sidebar + mobile search triggers).

**Rewritten (same 12 routes, now grouped — no nav entries added/removed):**
- `Sidebar.tsx` — renders from `NAV_SECTIONS` with section labels, `lucide-react` icons (replacing the hand-pasted inline SVG `path` strings), wider hit areas, `focus-visible` accent rings, and a ⌘K "Search…" trigger button. Active-route 2px cyan tick preserved; shortcut hints preserved.
- `MobileNav.tsx` — **adds the bottom tab bar** (`data-testid="mobile-tab-bar"`, `md:hidden`, safe-area-inset-bottom): five tabs **Today→/sleep · Trends→/analytics/hrv · Log→sheet · Chat→/chat · More→drawer**. The **Log sheet** is a bottom sheet of one-tap entries to the four logging surfaces (Supplement→/supplements, Meal→/nutrition, Habit→/habits, Weight→/nutrition). The full-nav **drawer** now renders from `NAV_SECTIONS` and is opened by the **More** tab. The top bar is slimmed to wordmark + a search (⌘K) button; the safe-area-inset-top fill is retained.
- `AppShell.tsx` — mounts `<CommandPalette/>` globally; adds mobile bottom padding (`pb-[calc(env(safe-area-inset-bottom)+5rem)]`) so page content clears the new tab bar (desktop unchanged).

**Smoke test:**
- `frontend/e2e/smoke.spec.ts` — added the required **"Mobile chrome — bottom tab bar"** test: at a 390×844 phone viewport the `data-testid="mobile-tab-bar"` element is visible and exposes all five tab labels; at 1280×900 it's hidden (`md:hidden`). Targets `data-testid`, not classes/colors. Spec compiles (`npx playwright test --list` → 16 tests).

**Deviations (surfaced):**
- The Log sheet uses **navigation links** to the four logging surfaces rather than an **embedded inline weight form** (proposal wording). Rationale: an embedded form would duplicate the `/nutrition` `/api/weight` POST UI and risk divergence; the brief forbids changing request shapes. All four logging surfaces remain one tap from anywhere. (If an inline weight form is wanted later it's a small, isolated add.)
- "Today" points to `/sleep` per the proposal's tab mapping (the root `/` itself still redirects to `/status`, unchanged).

**No-data-loss:** the navigation **set** is unchanged — the same 12 routes, now grouped into Logging/Insights/Tools and reachable from the sidebar, the mobile drawer (via More), the bottom tab bar (Today/Trends/Chat), the Log sheet, and the new ⌘K palette. Nothing removed; several new ways to reach the same routes added. The old top hamburger's only function (open drawer) is preserved via the More tab.

### Stage 4 moves — `/analytics/hrv` flagship rework

**Files modified:** `frontend/src/app/analytics/hrv/page.tsx` (the 2853-line flagship), `frontend/src/lib/chart-theme.ts` (added `paleUp`/`paleDown`/`zeroLine`/`whisker`/`cardBg` to `chartColors` + a `legendStyle` export), `frontend/e2e/smoke.spec.ts` (hero assertion).

**Implemented in full:**
- **Hero → `KpiTile` × 3.** Tomorrow's-HRV / Model-Accuracy / Top-Driver-Today now render through `KpiTile` with the zone-keyed value color, 80%-CI sub line, signed delta (`vs today` / `vs naive`), a **sparkline** of recent HRV on the forecast tile, a mono metadata footer, and **`data-testid="hero-tomorrow-hrv"`**. The hero row is a **horizontal scroll-snap** carousel on mobile, a 3-col grid on `sm+`.
- **Every raw hex routed through `chart-theme`.** All 59 ad-hoc hex literals on the page → `chartColors` tokens / `directionalColor()` (`grep -c '"#......"'` → **0**). Covered: the shared `hrvColor`/`HrvDot`/`HORIZON_MODELS`/`WrappedYAxisTick` helpers, every `<Line>`/`<Area>`/`<Bar>`/`<Cell>` series, gradient `stopColor`s, `<ErrorBar>` whiskers, `<ReferenceLine>` zero-lines, the CI-band mask, the env axis-selector Tailwind `bg-[#hex]` classes, and inline legend `text-[#hex]` spans. The local `legendStyle` const + `var(--font-geist-mono)` references now use the centralized theme + `--font-mono`.
- **`SectionHeader` with colored ticks + anchors** before all 10 section groups (forecast=cyan, accuracy/methods=green-calibration, causal=amber, the descriptive blocks=neutral), each carrying an anchor `id`.
- **Sticky in-page TOC** — a right-rail `<aside>` (the page return is now an `xl:flex` with a `flex-1 min-w-0` content column + a `w-[170px]` aside) that `sticky`-tracks scroll and links the 10 section anchors. Shown at `xl+`; reserves its own column so it never overlaps the centered content.
- **Weekend day-context strip** under the HRV Trend chart — a thin per-day strip tinting weekend days (`bg-accent/20`), aligned to the plot via the `55px` Y-axis offset, with an inline legend.
- **Smoke:** added the `data-testid="hero-tomorrow-hrv"` visibility assertion; the three HRV empty-state strings are kept **verbatim and asserted-absent**; HRV Correlates remains a Recharts bar chart so its existing data-marks assertion is unchanged. Spec compiles → 16 tests.

**Partial / deliberately deferred (surfaced per the brief's honesty rule — these are the morning spot-checks):**
- **Forest-plot → typeset-table-with-graphical-column + mobile vertical-list: re-themed in place, NOT structurally rewritten.** The 7+ forest/impact charts (HRV Correlates, Journal/Habit correlation + impact, Supplement impact + dose-response, Causal Binary + Continuous) received the Direction A color/density treatment via the hex routing, but were **kept as Recharts charts** rather than rebuilt as bespoke typeset tables. Rationale: each carries intricate, easy-to-silently-break per-row logic — FDR filtering with custom empty-states, block-bootstrap-divergence pale-color rules, `⚠/⊕/✓/↻` markers, `low_n` opacity, mobile-aware wrapped Y-axis ticks — and the `HRV Correlates` chart is the production smoke tripwire (asserts Recharts data marks). Rewriting all of that into a new graphical-table component on a load-bearing page reviewed only async carried real regression risk for limited additional Direction-A signal. **This is the #1 recommended follow-up** and is cleanly isolable (build a `ForestTable` component, migrate chart-by-chart with the smoke assertion updated to `data-testid` per chart).
- **Day-context strip is weekend-only.** The alcohol / hard-workout / travel stripes from the proposal need those flags loaded into the HRV queries — a **data-fetch change explicitly out of scope** for this frontend-only refresh. Documented inline in the code.
- **Hero explanatory paragraphs condensed.** The three verbose per-card captions ("An AI model trained on…") were dropped from the tiles (KpiTile is a tight glance component); the same information remains reachable in **Models & Methods** and each chart's `info` tooltip. Not in the no-data-loss enumerated set (metric/chart/table/modal/button/chat-tool/PWA).

**No-data-loss:** every one of the 14 sections, all KPIs, charts, tables, the Naive-vs-Adjusted + Model-Comparison + coverage tables, the DAG card, the FDR toggle, the RangeFilter, the env axis selectors, and every empty-state string survive unchanged. Verified against the Stage-0 inventory catalog.

### Stage 5 moves — roll Direction A across the remaining routes (one commit per route)

Stages 1–3 already propagated the Direction A design system globally (tokens, JetBrains Mono, restyled `ChartCard`/`StatCard`, new `Sidebar`/`MobileNav`/`nav.ts`, bottom tab bar, ⌘K). Stage 5 finishes each route by **routing every remaining raw chart-color hex literal through `chart-theme` tokens** so series colors are on-palette and semantically consistent. A parallel analysis workflow (11 agents, one per page) produced semantically-aware per-page edit plans (hex→token, `replaceAll` flags, imports, headings/empty-states to preserve); I applied them with 3 corrections (spotify `[#1DB954]`→`source-spotify` not `spotify`; nutrition collapsed to one `[#1DB954]`→`accent` replaceAll; habits' dead `#71717a` CSS-var fallback dropped rather than template-literal-interpolated).

**Per route (color-only; every heading, chart, table, modal, button, and empty-state string preserved; `chartColors as C` added to the existing `@/lib/chart-theme` import where charts use it):**
- **`/sleep`** — 26 edits: `recoveryColor`/`latencyColor` + all Sleep-Debt/Hours/Consistency cell ternaries → up/down/whoop/neutral; every gradient/area/line (strain, sleep-scores, RHR/HRV, biometrics, bed/room temp, stages, snoring, latency) → source/semantic tokens; stage-bar fills (`#1e40af`/`#60a5fa`/`#a78bfa`/`#f87171`) → garmin/categorical[6]/eightsleep/down.
- **`/spotify`** — `GENRE_PALETTE` + `spotifyGreen` + the 8 sound-evolution lines → tokens; all `bg/border/text-[#1DB954]/*` arbitrary classes → `*-source-spotify/*`. (Two `stroke="#ffffff"` radar grid-hairlines intentionally kept — they're grid lines using the same white-with-opacity convention as the theme's own `gridStyle.stroke`.)
- **`/nutrition`** — calorie/macro/detail series → up/down/whoop/garmin/eightsleep/accent; net-balance cell ternary → whoop/up; weight-trend line+dot → eightsleep; weight-log `[#1DB954]` focus/CTA classes → `accent`.
- **`/whoop`** — `recoveryColor` + recovery bar + HRV/RHR lines + strain gradient/area + 4 sleep-stage bars + performance/efficiency/SpO2/skin-temp lines → tokens.
- **`/heart`** — HR gradient stops + max/min/RHR/HRV/stress series → down/up/garmin/eightsleep/whoop.
- **`/activities`** — HR/stress gradient stops + strokes → down/up/whoop.
- **`/habits`** — `CATEGORY_COLORS` (8) → up/garmin/eightsleep/whoop/accent/categorical/neutral; completion-rate accent area → accent; dead `#71717a` CSS-var fallback removed.
- **`/bland-altman`** — `PAIRS` series colors → garmin/eightsleep/up; bias line/label → whoop; LoA lines/labels → down; zero line → `zeroLine`.
- **`/analytics/travel`** (`TravelCharts.tsx`) — tooltip card fill → `cardBg`; HRV-trajectory line+dot → garmin; destination bar → eightsleep.
- **`/status`** — Spotify-family source-badge classes (`spotify`/`reccobeats`/`musicbrainz`) → `text-source-spotify[/70]`.
- **`/supplements`** — every `[#1DB954]` accent-affordance arbitrary class (buttons, focus rings, log/toast) → `accent` (it's a generic accent on a non-Spotify page, not brand or success).
- **`/account`** — error/success text → `text-down`/`text-up`.
- **`/journal`** — mood badges (low/neutral/good/great) → down/secondary/source-garmin/up; error → down.
- **`/chat`** — already fully on-palette (no charts, no raw hex, no off-palette classes); inherits Direction A from the shared components — **no change needed, no commit**.

**No-data-loss:** Stage 5 is color-routing only. No route, chart, KPI, table, modal, button, chat tool, or PWA capability was moved, consolidated, renamed, or removed on any page. All page/section headings and empty-state strings are byte-for-byte unchanged (the smoke `PAGES` list + heading assertions still match). `/eight-sleep` is a pure server redirect to `/sleep` (untouched).

---

## WHOOP re-theme (follow-up direction — "Full WHOOP")

Per Riley's request after reviewing the Terminal build: pivot the aesthetic toward **WHOOP** — green recovery accent, strain blue, a green→yellow→red 3-zone status system everywhere, and **ring-led heroes**. Built on the same `ui-refresh` branch.

**Why it's cheap:** Stages 4–5 routed *every* chart color through `chart-theme` tokens, so re-pointing the token values re-themes all charts app-wide automatically — the only hand-work is the ring component + the page heroes.

**Palette pivot (`globals.css` + `chart-theme.ts`):**
- `--color-accent` cyan `#7DD3FC` → **WHOOP green `#16E07A`** (active nav, focus rings, primary CTAs, section ticks, every chart series that resolved to `accent`).
- `--color-up` → `#16E07A`, `--color-down` → WHOOP red `#FF4159`, **new `--color-mid` `#FFD23F`** (zone yellow), **new `--color-strain`/`--color-strain-bright`** (`#0093E7`/`#33B5F5`). `border-emphasis` + `tick-forecast`/`tick-calibration` re-pointed. `chartColors` gains `mid`/`strain`/`strainBright`; **new `zoneColor(value, max)` helper** is the single source of the ≥67 green / ≥34 yellow / red logic.

**`MetricRing.tsx` (new):** the WHOOP signature — an SVG gauge (subtle track + arc from 12 o'clock, clockwise, 600ms fill), colored by recovery `zone`, `strain` blue, or an explicit color, with the centered value adopting the zone color. Props: `value/max/size/thickness/color/zone/strain/label/centerValue/centerUnit/sublabel/testId`.

**Ring-led heroes (data preserved — demoted metrics stay as stats in the same row):**
- **`/whoop`** — Recovery (zone) + Day Strain (blue, 0–21) + Sleep Performance (zone) rings; HRV kept as a stat.
- **`/sleep`** — Recovery + Day Strain rings lead the WHOOP·Recovery row; HRV + Resting HR kept as stats.
- **`/analytics/hrv`** — "Tomorrow's HRV" KpiTile → a recovery ring filled by the prediction's **percentile within the observed range** (zone-colored), value = ms, with CI + vs-today below; keeps `data-testid="hero-tomorrow-hrv"`. (Dead `hrvColor` helper removed.)
- **`/status`** — Sources-Online ring (online / total, zone). **`/habits`** — Today + 7-Day-Rate rings (zone).

**Not ring-led (no bounded recovery-style score):** the logging/feed pages (`/nutrition`, `/supplements`, `/activities`, `/spotify`, `/journal`, `/chat`, `/heart`, `/analytics/travel`, `/account`, `/bland-altman`) keep their KPI tiles + charts — but all inherit the WHOOP palette (green accent, zone colors, strain blue) automatically via the token pivot. `/heart` is a candidate for a stress ring if wanted.

**No-data-loss:** every metric demoted from a KpiTile/StatCard into a ring is still shown (ring center value + sublabel, or retained alongside as a stat). Build + lint pass; smoke spec unchanged (the HRV hero still carries `data-testid="hero-tomorrow-hrv"`).

**Ambient gradient backdrop (Eight Sleep Pod aesthetic):** `globals.css` adds a fixed, non-scrolling `body::before` cool aura (indigo top glow + faint cyan + violet bottom, all low-alpha radial gradients) painted behind the app on the deep base surface. Opaque cards sit on top, so the gradient reads through the page background, gaps, and margins; `pointer-events:none` keeps it purely decorative. Validated via dev-server hot-reload (CSS-only change — deliberately **not** re-running `next build` against the live dev server, which previously corrupted its `.next` cache).
