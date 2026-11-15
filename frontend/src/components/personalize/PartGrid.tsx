"use client";

import {
  Children,
  createContext,
  isValidElement,
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { ChevronRight } from "lucide-react";
import {
  EMPTY_LAYOUT,
  MAIN_ZONE,
  layoutKey,
  resolveGrid,
  visibleOrder,
  type PageLayout,
  type PartDef,
  type PartWidth,
  type ResolvedPart,
} from "@/lib/personalize-layout";
import {
  adoptPending,
  beginEdit,
  editorSnapshot,
  endEdit,
  isEditing,
  layoutSnapshot,
  scheduleSync,
  subscribe,
} from "@/lib/personalize-store";
import { registerTarget } from "@/lib/personalize-registry";
import { loadEditor, preloadEditor, type EditorModule } from "./editor-loader";
import { logFailure } from "./start";
import { useInFeed } from "../FeedContext";

/**
 * Personalize (Business Central-style): a page's personalizable parts.
 *
 *   <PartGrid page="/sleep" title="Sleep & Recovery">
 *     <Part id="recovery" title="Recovery Score" width="half">…</Part>
 *     …
 *   </PartGrid>
 *
 * Parts must be direct children (a {cond && <Part/>} is fine). A server-rendered page passes `parts` (an array
 * of {id, title, width, node}) plus `initial` = the layout read from its cookie (lib/personalize-layout.ts).
 *
 * Normal mode costs almost nothing: the saved layout is read from localStorage in the first render (no request,
 * nothing moves after paint), parts render in their personalized order as plain grid items, and a hidden part
 * is not rendered at all, so it mounts nothing and fetches nothing. Everything for editing (banner, frames,
 * drag and drop, menus) is a separate chunk loaded only when Personalize mode starts.
 */

export interface PartProps {
  id: string;
  title: string;
  /** Desktop width: full row, half (two side by side from 1024 px) or a third (three from 1024 px, two from 768 px). */
  width?: PartWidth;
  /** Hidden by default: listed under "+ Add part". */
  hidden?: boolean;
  /** Collapsed by default: only its title bar shows until opened. */
  collapsed?: boolean;
  /** The part holds a <PartGrid zone> of its own (tiles that move one by one): dragged by its handle only. */
  nested?: boolean;
  className?: string;
  children?: ReactNode;
}

/** Declares one part of a <PartGrid>; the grid renders its children. */
export function Part({ children }: PartProps) {
  return <>{children}</>;
}

export interface PartSpec extends Omit<PartProps, "children"> {
  node: ReactNode;
}

/** What the editor gets for one grid. */
export interface GridApi {
  key: string;
  page: string;
  zone: string;
  title: string;
  defs: PartDef[];
  parts: ResolvedPart[];
  container: RefObject<HTMLDivElement | null>;
}

interface GridContextValue {
  key: string;
  page: string;
  initial: PageLayout | undefined;
}

const GridContext = createContext<GridContextValue | null>(null);

export function useGridContext(): GridContextValue | null {
  return useContext(GridContext);
}

const noEditor = () => null;
const notEditing = () => false;

function collect(children: ReactNode, parts: PartSpec[] | undefined): { specs: PartSpec[]; extras: ReactNode[] } {
  const specs: PartSpec[] = parts ? parts.slice() : [];
  const extras: ReactNode[] = [];
  Children.forEach(children, (child) => {
    if (child === null || child === undefined || typeof child === "boolean") return;
    if (isValidElement(child)) {
      const props = child.props as Partial<PartProps>;
      if (typeof props.id === "string" && typeof props.title === "string") {
        specs.push({
          id: props.id,
          title: props.title,
          width: props.width,
          hidden: props.hidden,
          collapsed: props.collapsed,
          nested: props.nested,
          className: props.className,
          node: props.children,
        });
        return;
      }
    }
    // Not a part: shown first, full width, not personalizable.
    extras.push(child);
  });
  return { specs, extras };
}

export interface PartGridProps {
  /** The page's route, e.g. "/analytics/hrv"; the layout is stored under layoutKey(page). */
  page: string;
  /** Shown in the "Personalizing …" banner. */
  title?: string;
  /** A page with several grids names them; parts move within their own grid. */
  zone?: string;
  /** Server-rendered pages: the layout the server rendered with (from the page's cookie). */
  initial?: PageLayout;
  className?: string;
  /** Space between parts in px. */
  gap?: number;
  /**
   * false: show the saved layout but do not claim the Personalize entry (the page rendered as a section of another
   * page, e.g. the continuous scroll). Default true.
   */
  target?: boolean;
  parts?: PartSpec[];
  children?: ReactNode;
}

export function PartGrid({ page, title, zone = MAIN_ZONE, initial, className, gap = 24, target = true, parts, children }: PartGridProps) {
  const key = layoutKey(page);
  // A newer copy from another device, fetched while this page was last open, applies now (before first paint).
  useState(() => {
    adoptPending(key, page);
    return 0;
  });
  const layout = useSyncExternalStore(subscribe, () => layoutSnapshot(key), () => initial ?? EMPTY_LAYOUT);
  const editing = useSyncExternalStore(subscribe, () => isEditing(key), notEditing);
  const editor = useSyncExternalStore(subscribe, editorSnapshot, noEditor) as EditorModule | null;
  const container = useRef<HTMLDivElement>(null);
  // A page drawn inside the continuous scroll shows its saved layout; the routed page owns the Personalize entry.
  const inFeed = useInFeed();
  const main = zone === MAIN_ZONE && target && !inFeed;
  const label = title ?? page;

  const { specs, extras } = collect(children, parts);
  const defs: PartDef[] = specs.map((s) => ({
    id: s.id,
    title: s.title,
    width: s.width ?? "full",
    hidden: s.hidden === true,
    collapsed: s.collapsed === true,
  }));
  const resolved = resolveGrid(defs, layout.grids?.[zone]);
  const byId = new Map<string, PartSpec>();
  for (const s of specs) if (!byId.has(s.id)) byId.set(s.id, s);

  // The "Personalize" entries (sidebar, drawer, command palette) act on the page on screen.
  useEffect(() => {
    if (!main) return undefined;
    return registerTarget({
      key,
      page,
      title: label,
      start: () => {
        beginEdit(key, page, label);
        void loadEditor().catch((e: unknown) => logFailure("editor load", e));
      },
      preload: preloadEditor,
    });
  }, [main, key, page, label]);

  // Leaving the page while personalizing keeps what was changed (like Done).
  useEffect(() => () => {
    if (main && isEditing(key)) endEdit(true);
  }, [main, key]);

  // Background sync with the server copy, in an idle slot after load.
  useEffect(() => (main ? scheduleSync(key) : undefined), [main, key]);

  useEffect(() => {
    if (editing && !editor) void loadEditor().catch((e: unknown) => logFailure("editor load", e));
  }, [editing, editor]);

  const ctx = useMemo<GridContextValue>(() => ({ key, page, initial }), [key, page, initial]);
  const live = editing && editor ? editor : null;
  const api: GridApi | null = live ? { key, page, zone, title: label, defs, parts: resolved, container } : null;
  const style = { "--pz-gap": `${gap}px` } as CSSProperties;

  return (
    <GridContext.Provider value={ctx}>
      <div
        ref={container}
        className={className ? `pz-grid ${className}` : "pz-grid"}
        style={style}
        data-pz-zone={zone}
        data-pz-editing={live ? "" : undefined}
      >
        {extras}
        {resolved.map((p) => {
          const spec = byId.get(p.id);
          if (!spec) return null;
          if (p.hidden) return live && api ? <live.HiddenPart key={p.id} api={api} part={p} /> : null;
          return (
            <PartItem
              key={p.id}
              id={p.id}
              title={p.title}
              width={p.width}
              collapsed={p.collapsed}
              nested={spec.nested === true}
              className={spec.className}
              node={spec.node}
              editor={live}
              api={api}
            />
          );
        })}
        {live && api ? <live.GridEditor api={api} /> : null}
      </div>
    </GridContext.Provider>
  );
}

interface PartItemProps {
  id: string;
  title: string;
  width: PartWidth;
  collapsed: boolean;
  nested: boolean;
  className?: string;
  node: ReactNode;
  editor: EditorModule | null;
  api: GridApi | null;
}

const PartItem = memo(function PartItem({ id, title, width, collapsed, nested, className, node, editor, api }: PartItemProps) {
  const [open, setOpen] = useState(false);
  const shut = collapsed && !open;
  return (
    <div data-part={id} data-w={width} data-nested={nested ? "" : undefined} className={className ? `pz-part ${className}` : "pz-part"}>
      <div className="pz-body">
        {shut ? (
          <button
            type="button"
            aria-expanded={false}
            disabled={editor !== null}
            onClick={() => setOpen(true)}
            className="flex w-full min-h-11 items-center gap-2 rounded-card border border-border-subtle bg-surface-card px-4 py-3 text-left text-[13px] font-medium text-text-secondary shadow-card transition-colors hover:border-border-hover hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent"
          >
            <ChevronRight className="h-4 w-4 shrink-0 text-text-tertiary" strokeWidth={1.75} aria-hidden />
            <span className="truncate">{title}</span>
          </button>
        ) : (
          node
        )}
      </div>
      {editor && api ? <editor.PartChrome api={api} id={id} title={title} cover={!nested} /> : null}
    </div>
  );
});

/** Ids in the page's personalized order, without hidden ones: for a table of contents that follows the layout. */
export function usePartOrder(page: string, ids: readonly string[], zone: string = MAIN_ZONE): string[] {
  const key = layoutKey(page);
  const layout = useSyncExternalStore(subscribe, () => layoutSnapshot(key), () => EMPTY_LAYOUT);
  return visibleOrder(ids, layout, zone);
}
