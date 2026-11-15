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
  PART_WIDTHS,
  layoutKey,
  resolvePage,
  storageKey,
  visibleOrder,
  type PageLayout,
  type PageModel,
  type PartDef,
  type PartWidth,
  type ResolvedPage,
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
 *     <PartGroup id="whoop" title="WHOOP" header={<p>WHOOP</p>}>   (a section: its parts move within it and
 *       <Part id="recovery" title="Recovery Score" width="half">…</Part>   into any other group of the page)
 *     </PartGroup>
 *     <Part id="notes" title="Notes">…</Part>                      (a lone part at the top level)
 *   </PartGrid>
 *
 * Parts and groups must be direct children ({cond && <Part/>} is fine). A server-rendered page passes `parts`
 * (plain data) plus `initial` = the layout read from its cookie, or uses `mode="css"` (see below).
 *
 * Normal mode costs almost nothing: the saved layout is read from localStorage in the first render (no request,
 * nothing moves after paint), parts render in their personalized order and group, and a hidden part is not
 * rendered at all, so it mounts nothing and fetches nothing. Everything for editing (banner, frames, drag and
 * drop, menus) is a separate chunk loaded only when Personalize starts.
 *
 * `mode="css"` is for a container that the server renders (a static page that hydrates, e.g. Today): the DOM
 * keeps the default order and the layout is applied with CSS `order` (painted before React runs by an inline
 * script that reads this device's copy), so hydration changes nothing on screen. Parts move within that
 * container only; hidden parts are unmounted after hydration.
 */

export interface PartProps {
  id: string;
  title: string;
  /** Width: full row, half (two side by side from 1024 px), third (three from 1024 px, two from 768 px) or
   * quarter (four from 1024 px, two below). */
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

/** Declares one part of a <PartGrid> or a <PartGroup>; the grid renders its children. */
export function Part({ children }: PartProps) {
  return <>{children}</>;
}

export interface PartGroupProps extends PartProps {
  /** Shown above the group's parts (its section heading). */
  header?: ReactNode;
  /** Classes of the group's own grid (default: the 12-column part grid). */
  gridClassName?: string;
  /** Space between the group's parts in px. */
  gap?: number;
}

/** A group of parts (a page section): moves, hides and collapses as one; its parts move within and between groups. */
export function PartGroup({ children }: PartGroupProps) {
  return <>{children}</>;
}

export interface PartSpec extends Omit<PartProps, "children"> {
  node: ReactNode;
  /** A group: its parts (in default order). `node` is then the group's header. */
  members?: PartSpec[];
  gridClassName?: string;
  gap?: number;
}

/** What the editor gets for one grid. */
export interface GridApi {
  key: string;
  page: string;
  zone: string;
  title: string;
  /** Top-level parts and groups (default order). */
  defs: PartDef[];
  /** Every part and group (defaults of the flags). */
  allDefs: PartDef[];
  /** Where hide / width / collapse are written: the zone for a plain grid, "main" for a page with groups. */
  flagZone: string;
  /** Top-level items in display order. */
  parts: ResolvedPart[];
  /** Pages with groups. */
  model: PageModel | null;
  resolved: ResolvedPage | null;
  groupTitles: Record<string, string>;
  container: RefObject<HTMLDivElement | null>;
  /** Widths offered in the part menu (none: the grid has its own fixed layout). */
  widths: PartWidth[];
  /** Label of the hide action (e.g. "Hide from the scroll" for the area cards). */
  hideLabel: string;
  /** CSS mode: the DOM keeps its default order. */
  css: boolean;
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

function specOf(props: Partial<PartGroupProps>, node: ReactNode): PartSpec | null {
  if (typeof props.id !== "string" || typeof props.title !== "string") return null;
  return {
    id: props.id,
    title: props.title,
    width: props.width,
    hidden: props.hidden,
    collapsed: props.collapsed,
    nested: props.nested,
    className: props.className,
    node,
  };
}

function collect(children: ReactNode, parts: PartSpec[] | undefined): { specs: PartSpec[]; extras: ReactNode[] } {
  const specs: PartSpec[] = parts ? parts.slice() : [];
  const extras: ReactNode[] = [];
  Children.forEach(children, (child) => {
    if (child === null || child === undefined || typeof child === "boolean") return;
    if (isValidElement(child)) {
      const props = child.props as Partial<PartGroupProps>;
      if (child.type === PartGroup) {
        const spec = specOf(props, props.header ?? null);
        if (spec) {
          const members: PartSpec[] = [];
          Children.forEach(props.children, (m) => {
            if (!isValidElement(m)) return;
            const mp = m.props as Partial<PartProps>;
            const ms = specOf(mp, mp.children);
            if (ms) members.push(ms);
          });
          specs.push({ ...spec, members, gridClassName: props.gridClassName, gap: props.gap });
          return;
        }
      }
      const spec = specOf(props, props.children);
      if (spec) {
        specs.push(spec);
        return;
      }
    }
    // Not a part: shown first, full width, not personalizable.
    extras.push(child);
  });
  return { specs, extras };
}

function defOf(s: PartSpec): PartDef {
  return { id: s.id, title: s.title, width: s.width ?? "full", hidden: s.hidden === true, collapsed: s.collapsed === true };
}

/** CSS mode: paint the saved order / hidden parts of one container before React runs (plain ES5). */
function cssBootScript(key: string, zone: string, ids: string[]): string {
  const sel = `[data-pz-key="${key}"][data-pz-zone="${zone}"]`;
  return (
    "(function(){try{" +
    `var raw=localStorage.getItem(${JSON.stringify(storageKey(key))});if(!raw)return;` +
    "var o=JSON.parse(raw);if(o&&o.l)o=o.l;var g=o&&o.grids;if(!g)return;" +
    `var z=g[${JSON.stringify(zone)}]||{},m=g.main||{},saved=z.order||[],hide=Object.assign({},z.hide||{},m.hide||{});` +
    `var def=${JSON.stringify(ids)},out=[],i,k;` +
    "for(i=0;i<saved.length;i++){if(def.indexOf(saved[i])!==-1&&out.indexOf(saved[i])===-1)out.push(saved[i]);}" +
    "for(i=0;i<def.length;i++){var d=def[i];if(out.indexOf(d)!==-1)continue;var at=0;" +
    "for(k=i-1;k>=0;k--){var p=out.indexOf(def[k]);if(p!==-1){at=p+1;break;}}out.splice(at,0,d);}" +
    'var css="";for(i=0;i<out.length;i++){' +
    `css+='${sel} > [data-part="'+out[i]+'"]{order:'+(i+1)+'!important}';` +
    `if(hide[out[i]]===true)css+='${sel} > [data-part="'+out[i]+'"]{display:none!important}';}` +
    `var st=document.createElement("style");st.id=${JSON.stringify(`pz-boot-${key}-${zone}`)};st.textContent=css;document.head.appendChild(st);` +
    "}catch(e){}})();"
  );
}

export interface PartGridProps {
  /** The page's route, e.g. "/analytics/hrv"; the layout is stored under layoutKey(page). */
  page: string;
  /** Shown in the "Personalizing …" banner. */
  title?: string;
  /** A page with several separate grids names them; parts move within their own grid. */
  zone?: string;
  /** Store the layout under this key instead of layoutKey(page) (e.g. the app's area order). */
  storeKey?: string;
  /** Server-rendered pages: the layout the server rendered with (from the page's cookie). */
  initial?: PageLayout;
  /** See the component comment: CSS order for a container the server renders. */
  mode?: "dom" | "css";
  className?: string;
  /** Only `className` on the container (the grid keeps its own layout); no width choice is offered. */
  bare?: boolean;
  /** Space between parts in px. */
  gap?: number;
  /**
   * false: show the saved layout but do not claim the Personalize entry (the page rendered as a section of another
   * page, or a second grid of a page). Default: true for the main zone.
   */
  target?: boolean;
  /** Widths offered in the part menu (default: all; none for a bare grid). */
  widths?: PartWidth[];
  /** Label of the hide action in the part menu. */
  hideLabel?: string;
  parts?: PartSpec[];
  children?: ReactNode;
}

export function PartGrid({
  page,
  title,
  zone = MAIN_ZONE,
  storeKey,
  initial,
  mode = "dom",
  className,
  bare = false,
  gap = 24,
  target,
  widths,
  hideLabel = "Hide",
  parts,
  children,
}: PartGridProps) {
  const key = storeKey ?? layoutKey(page);
  // A newer copy from another device, fetched while this page was last open, applies now (before first paint).
  useState(() => {
    adoptPending(key, page);
    return 0;
  });
  const layout = useSyncExternalStore(subscribe, () => layoutSnapshot(key), () => initial ?? EMPTY_LAYOUT);
  const editing = useSyncExternalStore(subscribe, () => isEditing(key), notEditing);
  const editor = useSyncExternalStore(subscribe, editorSnapshot, noEditor) as EditorModule | null;
  const container = useRef<HTMLDivElement>(null);
  const inFeed = useInFeed();
  const css = mode === "css";
  // A page drawn inside the continuous scroll shows its saved layout; the routed page owns the Personalize entry.
  const owner = !inFeed && (target ?? zone === MAIN_ZONE);
  const label = title ?? page;

  const { specs, extras } = collect(children, parts);
  const grouped = specs.some((s) => s.members);
  const model: PageModel = {
    top: specs.map(defOf),
    groups: Object.fromEntries(specs.filter((s) => s.members).map((s) => [s.id, (s.members ?? []).map(defOf)])),
  };
  const resolved = resolvePage(model, layout, zone);
  const byId = new Map<string, PartSpec>();
  for (const s of specs) {
    if (!byId.has(s.id)) byId.set(s.id, s);
    for (const m of s.members ?? []) if (!byId.has(m.id)) byId.set(m.id, m);
  }

  // The "Personalize" entries (sidebar, drawer, command palette) act on the page on screen.
  useEffect(() => {
    if (!owner) return undefined;
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
  }, [owner, key, page, label]);

  // Leaving the page while personalizing keeps what was changed (like Done).
  useEffect(() => () => {
    if (owner && isEditing(key)) endEdit(true);
  }, [owner, key]);

  // Background sync with the server copy, in an idle slot after load.
  useEffect(() => (zone === MAIN_ZONE && !inFeed ? scheduleSync(key) : undefined), [zone, inFeed, key]);

  useEffect(() => {
    if (editing && !editor) void loadEditor().catch((e: unknown) => logFailure("editor load", e));
  }, [editing, editor]);

  // CSS mode: React now renders the saved order itself, so the pre-paint rules can go.
  useEffect(() => {
    if (css && layout !== (initial ?? EMPTY_LAYOUT)) {
      try { document.getElementById(`pz-boot-${key}-${zone}`)?.remove(); } catch { /* ignore */ }
    }
  }, [css, layout, initial, key, zone]);

  const ctx = useMemo<GridContextValue>(() => ({ key, page, initial }), [key, page, initial]);
  const live = editing && editor ? editor : null;
  const allDefs = [...model.top, ...Object.values(model.groups).flat()];
  const api: GridApi | null = live
    ? {
        key,
        page,
        zone,
        title: label,
        defs: model.top,
        allDefs,
        flagZone: grouped ? MAIN_ZONE : zone,
        parts: resolved.top,
        model: grouped ? model : null,
        resolved: grouped ? resolved : null,
        groupTitles: Object.fromEntries(specs.filter((s) => s.members).map((s) => [s.id, s.title])),
        container,
        widths: widths ?? (bare || css ? [] : PART_WIDTHS.slice()),
        hideLabel,
        css,
      }
    : null;
  const style = { "--pz-gap": `${gap}px` } as CSSProperties;
  const containerClass = bare ? className ?? "" : className ? `pz-grid ${className}` : "pz-grid";

  // CSS mode keeps the default DOM order; everything else renders in display order.
  const items: ResolvedPart[] = css
    ? model.top.map((d) => resolved.top.find((p) => p.id === d.id) as ResolvedPart)
    : resolved.top;

  return (
    <GridContext.Provider value={ctx}>
      {css ? <script dangerouslySetInnerHTML={{ __html: cssBootScript(key, zone, model.top.map((d) => d.id)) }} /> : null}
      <div
        ref={container}
        className={containerClass}
        style={style}
        data-pz-key={key}
        data-pz-zone={zone}
        data-pz-editing={live ? "" : undefined}
      >
        {extras}
        {items.map((p) => {
          const spec = byId.get(p.id);
          if (!spec) return null;
          const order = css ? p.pos + 1 : undefined;
          if (p.hidden) return live && api ? <live.HiddenPart key={p.id} api={api} part={p} order={order} /> : null;
          if (spec.members) {
            return (
              <GroupItem
                key={p.id}
                group={p}
                spec={spec}
                members={resolved.members[p.id] ?? []}
                byId={byId}
                editor={live}
                api={api}
              />
            );
          }
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
              order={order}
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

function CollapsedBar({ title, disabled, onOpen }: { title: string; disabled: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      aria-expanded={false}
      disabled={disabled}
      onClick={onOpen}
      className="flex w-full min-h-11 items-center gap-2 rounded-card border border-border-subtle bg-surface-card px-4 py-3 text-left text-[13px] font-medium text-text-secondary shadow-card transition-colors hover:border-border-hover hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent"
    >
      <ChevronRight className="h-4 w-4 shrink-0 text-text-tertiary" strokeWidth={1.75} aria-hidden />
      <span className="truncate">{title}</span>
    </button>
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
  /** CSS mode: the CSS order of the part. */
  order?: number;
  /** The group the part is shown in (parts inside a PartGroup). */
  group?: string;
  editor: EditorModule | null;
  api: GridApi | null;
}

const PartItem = memo(function PartItem({ id, title, width, collapsed, nested, className, node, order, group, editor, api }: PartItemProps) {
  const [open, setOpen] = useState(false);
  const shut = collapsed && !open;
  return (
    <div
      data-part={id}
      data-w={width}
      data-nested={nested ? "" : undefined}
      className={className ? `pz-part ${className}` : "pz-part"}
      style={order !== undefined ? { order } : undefined}
    >
      <div className="pz-body">{shut ? <CollapsedBar title={title} disabled={editor !== null} onOpen={() => setOpen(true)} /> : node}</div>
      {editor && api ? <editor.PartChrome api={api} id={id} title={title} cover={!nested} group={group} /> : null}
    </div>
  );
});

function GroupItem({
  group,
  spec,
  members,
  byId,
  editor,
  api,
}: {
  group: ResolvedPart;
  spec: PartSpec;
  members: ResolvedPart[];
  byId: Map<string, PartSpec>;
  editor: EditorModule | null;
  api: GridApi | null;
}) {
  const [open, setOpen] = useState(false);
  const shut = group.collapsed && !open;
  const shown = members.filter((m) => !m.hidden);
  const gridClass = spec.gridClassName ?? "pz-grid";
  const style = { "--pz-gap": `${spec.gap ?? 16}px` } as CSSProperties;
  return (
    <div data-part={group.id} data-w={group.width} data-group="" data-nested="" className={spec.className ? `pz-part ${spec.className}` : "pz-part"}>
      <div className="pz-body">
        {spec.node}
        {shut ? (
          <CollapsedBar title={group.title} disabled={editor !== null} onOpen={() => setOpen(true)} />
        ) : (
          <div className={gridClass} style={style} data-pz-group-grid={group.id} data-pz-editing={editor ? "" : undefined}>
            {members.map((m) => {
              const ms = byId.get(m.id);
              if (!ms) return null;
              if (m.hidden) return editor && api ? <editor.HiddenPart key={m.id} api={api} part={m} group={group.id} /> : null;
              return (
                <PartItem
                  key={m.id}
                  id={m.id}
                  title={m.title}
                  width={m.width}
                  collapsed={m.collapsed}
                  nested={ms.nested === true}
                  className={ms.className}
                  node={ms.node}
                  group={group.id}
                  editor={editor}
                  api={api}
                />
              );
            })}
            {editor && shown.length === 0 ? <div className="pz-empty-group">Drop parts here</div> : null}
          </div>
        )}
      </div>
      {editor && api ? <editor.PartChrome api={api} id={group.id} title={group.title} cover={false} /> : null}
    </div>
  );
}

/** Ids in the page's personalized order, without hidden ones: for a table of contents that follows the layout. */
export function usePartOrder(page: string, ids: readonly string[], zone: string = MAIN_ZONE, storeKey?: string): string[] {
  const key = storeKey ?? layoutKey(page);
  const layout = useSyncExternalStore(subscribe, () => layoutSnapshot(key), () => EMPTY_LAYOUT);
  return visibleOrder(ids, layout, zone);
}
