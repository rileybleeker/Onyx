"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Columns3,
  Eye,
  EyeOff,
  GripVertical,
  Ellipsis,
  Plus,
  RotateCcw,
  Settings2,
} from "lucide-react";
import type { ColumnDef, PartWidth, ResolvedColumn, ResolvedPart } from "@/lib/personalize-layout";
import {
  dropTarget,
  keyboardTarget,
  moveColumnBy,
  movePart,
  movePartBy,
  movePartToTop,
  rowsOf,
  setColumnFreeze,
  setColumnHidden,
  setPartCollapsed,
  setPartHidden,
  setPartWidth,
  type DropItem,
  type DropTarget,
} from "@/lib/personalize-ops";
import { clearAndEnd, editingSession, endEdit, subscribe, updateDraft } from "@/lib/personalize-store";
import type { GridApi } from "./PartGrid";

/**
 * Personalize mode (loaded only when it starts). Emulates Business Central's personalization:
 * - the "Personalizing <page>" banner with Done, Clear personalization and Cancel, plus "+ Add part";
 * - every part framed, with a drag handle and a menu (Hide, Move up / down / to top, Width, Collapse by default);
 * - while dragging (pointer or keyboard), an accent insertion line shows exactly where the part will land and
 *   the parts on either side move apart to open the gap;
 * - hidden parts show in place as hatched slots with Show (they stay unmounted);
 * - tables: a column chooser and a menu per column (move, hide, freeze pane).
 * Phones get up / down buttons on every part (no drag-only interaction) and 44 px targets.
 */

const btn =
  "inline-flex min-h-8 items-center justify-center gap-1.5 rounded-control px-2.5 text-[12px] font-medium text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40 disabled:hover:bg-transparent max-md:min-h-11 max-md:min-w-11";
const iconBtn =
  "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-30 disabled:hover:bg-transparent max-md:h-11 max-md:w-11";

const WIDTH_LABEL: Record<PartWidth, string> = { full: "Full width", half: "Half", third: "Third" };
const GAP_SHIFT = 8;

// ---- shared bits ------------------------------------------------------------------------------------------

let say: (text: string) => void = () => {};

/** Screen-reader announcement (the banner owns the live region). */
function announce(text: string) {
  say(text);
}

function useMedia(query: string): boolean {
  const [match, setMatch] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return match;
}

/** Phones and touch screens: up / down buttons on every part, and no width choice under 768 px. */
function usePhone(): { touch: boolean; narrow: boolean } {
  const narrow = useMedia("(max-width: 767px)");
  const coarse = useMedia("(pointer: coarse)");
  return { touch: narrow || coarse, narrow };
}

function visibleIds(api: GridApi): string[] {
  return api.parts.filter((p) => !p.hidden).map((p) => p.id);
}

function titleOf(api: GridApi, id: string): string {
  return api.parts.find((p) => p.id === id)?.title ?? id;
}

function focusLater(selector: string) {
  requestAnimationFrame(() => {
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) return;
    el.focus({ preventScroll: true });
    el.scrollIntoView({ block: "nearest" });
  });
}

function cssId(id: string): string {
  return id.replace(/["\\]/g, "\\$&");
}

// ---- popover menu -----------------------------------------------------------------------------------------

interface MenuItem {
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  checked?: boolean;
  role?: "menuitem" | "menuitemradio" | "menuitemcheckbox";
  separatorBefore?: boolean;
  icon?: ReactNode;
}

function Menu({ anchor, items, label, onClose }: { anchor: HTMLElement; items: MenuItem[]; label: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    const menu = ref.current;
    const w = menu?.offsetWidth ?? 220;
    const h = menu?.offsetHeight ?? 240;
    let top = r.bottom + 4;
    if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 4);
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, r.right - w));
    setPos({ top, left });
    menu?.querySelector<HTMLElement>('[role^="menuitem"]:not([disabled])')?.focus();
  }, [anchor]);

  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (ref.current?.contains(e.target as Node) || anchor.contains(e.target as Node)) return;
      onClose();
    };
    const scroll = () => onClose();
    document.addEventListener("pointerdown", down, true);
    window.addEventListener("scroll", scroll, { passive: true });
    window.addEventListener("resize", scroll);
    return () => {
      document.removeEventListener("pointerdown", down, true);
      window.removeEventListener("scroll", scroll);
      window.removeEventListener("resize", scroll);
    };
  }, [anchor, onClose]);

  function onKey(e: ReactKeyboardEvent<HTMLDivElement>) {
    const list = Array.from(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([disabled])') ?? []);
    const i = list.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
      anchor.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      list[(i + 1) % list.length]?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      list[(i - 1 + list.length) % list.length]?.focus();
    } else if (e.key === "Home") {
      e.preventDefault();
      list[0]?.focus();
    } else if (e.key === "End") {
      e.preventDefault();
      list[list.length - 1]?.focus();
    } else if (e.key === "Tab") {
      onClose();
    }
  }

  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      onKeyDown={onKey}
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
      className="fixed z-[70] min-w-[220px] max-w-[calc(100vw-16px)] overflow-hidden rounded-control border border-border-default bg-surface-raised py-1 shadow-floating"
    >
      {items.map((it, i) => (
        <div key={`${it.label}-${i}`}>
          {it.separatorBefore && <div className="my-1 border-t border-border-subtle" role="separator" />}
          <button
            type="button"
            role={it.role ?? "menuitem"}
            aria-checked={it.role === "menuitemradio" || it.role === "menuitemcheckbox" ? it.checked === true : undefined}
            disabled={it.disabled}
            onClick={() => {
              onClose();
              it.onSelect();
            }}
            className="flex w-full min-h-9 items-center gap-2.5 px-3 py-1.5 text-left text-[13px] text-text-primary hover:bg-white/[0.06] focus:bg-white/[0.06] focus:outline-none disabled:text-text-disabled disabled:hover:bg-transparent max-md:min-h-11"
          >
            <span className="flex w-4 shrink-0 justify-center text-text-tertiary" aria-hidden>
              {it.role === "menuitemradio" || it.role === "menuitemcheckbox" ? (it.checked ? "✓" : "") : it.icon}
            </span>
            <span className="flex-1">{it.label}</span>
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}

function MenuButton({ label, items, className, children }: { label: string; items: () => MenuItem[]; className?: string; children: ReactNode }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        onClick={(e) => setAnchor(anchor ? null : e.currentTarget)}
        className={className ?? iconBtn}
      >
        {children}
      </button>
      {anchor && <Menu anchor={anchor} items={items()} label={label} onClose={() => setAnchor(null)} />}
    </>
  );
}

// ---- drag and drop + keyboard moves -----------------------------------------------------------------------

interface Measured extends DropItem {
  el: HTMLElement;
}

interface Drag {
  id: string;
  mode: "pointer" | "keyboard";
  items: Measured[];
  target: DropTarget | null;
  /** Keyboard: the final position among the visible parts. */
  pos: number;
  start: number;
  x: number;
  y: number;
  started: boolean;
  pointerId: number;
}

/** One per grid: measures the parts at the start of a move and paints the indicator straight into the DOM. */
class Controller {
  api: GridApi;
  indicator: HTMLDivElement | null = null;
  label: HTMLSpanElement | null = null;
  ghost: HTMLDivElement | null = null;
  drag: Drag | null = null;
  private frame = 0;
  private scrollFrame = 0;

  constructor(api: GridApi) {
    this.api = api;
  }

  private measure(): Measured[] {
    const c = this.api.container.current;
    if (!c) return [];
    const base = c.getBoundingClientRect();
    const out: Measured[] = [];
    c.querySelectorAll<HTMLElement>(":scope > .pz-part").forEach((el) => {
      const id = el.dataset.part;
      if (!id) return;
      const r = el.getBoundingClientRect();
      out.push({ id, el, left: r.left - base.left, top: r.top - base.top, right: r.right - base.left, bottom: r.bottom - base.top });
    });
    return out;
  }

  private gap(): number {
    const c = this.api.container.current;
    if (!c) return 24;
    const v = parseFloat(getComputedStyle(c).rowGap || "24");
    return Number.isFinite(v) ? v : 24;
  }

  private paint() {
    const d = this.drag;
    const ind = this.indicator;
    if (!d || !ind) return;
    const t = d.target;
    for (const it of d.items) {
      it.el.style.transform = "";
      it.el.classList.toggle("pz-here", d.mode === "keyboard" && it.id === d.id && (!t || t.noop));
    }
    if (!t || t.noop) {
      ind.style.display = "none";
      return;
    }
    const { line } = t;
    ind.style.display = "block";
    ind.dataset.axis = line.axis;
    ind.style.left = `${line.x}px`;
    ind.style.top = `${line.y}px`;
    ind.style.width = `${line.w}px`;
    ind.style.height = `${line.h}px`;
    if (this.label) this.label.textContent = titleOf(this.api, d.id);
    // Open the gap: the neighbours on either side of the insertion point move apart.
    const prev = t.index > 0 ? d.items[t.index - 1] : null;
    const next = t.index < d.items.length ? d.items[t.index] : null;
    if (line.axis === "v") {
      if (prev && prev.id !== d.id) prev.el.style.transform = `translateX(-${GAP_SHIFT}px)`;
      if (next && next.id !== d.id) next.el.style.transform = `translateX(${GAP_SHIFT}px)`;
    } else {
      const rows = rowsOf(d.items);
      const rowOf = (it: Measured | null) => (it ? rows.find((r) => r.some((x) => x.id === it.id)) ?? [] : []);
      for (const x of rowOf(prev)) if (x.id !== d.id) (x as Measured).el.style.transform = `translateY(-${GAP_SHIFT}px)`;
      for (const x of rowOf(next)) if (x.id !== d.id) (x as Measured).el.style.transform = `translateY(${GAP_SHIFT}px)`;
    }
  }

  private begin(mode: "pointer" | "keyboard", id: string, pointerId = -1, x = 0, y = 0): Drag | null {
    const items = this.measure();
    if (!items.some((it) => it.id === id)) return null;
    const visible = items.map((it) => it.id);
    this.drag = { id, mode, items, target: null, pos: visible.indexOf(id), start: Date.now(), x, y, started: mode === "keyboard", pointerId };
    return this.drag;
  }

  private started() {
    const d = this.drag;
    const c = this.api.container.current;
    if (!d || !c) return;
    c.dataset.pzDragging = "";
    d.items.find((it) => it.id === d.id)?.el.classList.add("pz-lifted");
    if (d.mode === "pointer" && this.ghost) {
      this.ghost.textContent = titleOf(this.api, d.id);
      this.ghost.style.display = "block";
    }
  }

  private cleanup() {
    const d = this.drag;
    const c = this.api.container.current;
    if (c) delete c.dataset.pzDragging;
    if (d) {
      for (const it of d.items) {
        it.el.style.transform = "";
        it.el.classList.remove("pz-lifted", "pz-here");
      }
    }
    if (this.indicator) this.indicator.style.display = "none";
    if (this.ghost) this.ghost.style.display = "none";
    cancelAnimationFrame(this.frame);
    cancelAnimationFrame(this.scrollFrame);
    this.drag = null;
    window.removeEventListener("pointermove", this.onMove);
    window.removeEventListener("pointerup", this.onUp);
    window.removeEventListener("pointercancel", this.onCancel);
    window.removeEventListener("keydown", this.onKey, true);
  }

  private commit(t: DropTarget | null, id: string) {
    if (!t || t.noop) return false;
    const { zone, defs } = this.api;
    updateDraft((l) => movePart(l, zone, defs, id, t.beforeId));
    const beforeTitle = t.beforeId ? titleOf(this.api, t.beforeId) : null;
    announce(`${titleOf(this.api, id)} moved ${beforeTitle ? `before ${beforeTitle}` : "to the end"}.`);
    return true;
  }

  // pointer --------------------------------------------------------------------------------------------------

  pointerDown(e: ReactPointerEvent<HTMLElement>, id: string, fromHandle: boolean) {
    if (e.button !== 0 || this.drag) return;
    if (!fromHandle && e.pointerType !== "mouse") return; // touch: drag only from the handle, so the page still scrolls
    if (!this.begin("pointer", id, e.pointerId, e.clientX, e.clientY)) return;
    if (e.pointerType === "mouse") e.preventDefault(); // no text selection while dragging
    window.addEventListener("pointermove", this.onMove);
    window.addEventListener("pointerup", this.onUp);
    window.addEventListener("pointercancel", this.onCancel);
    window.addEventListener("keydown", this.onKey, true);
  }

  private onMove = (e: PointerEvent) => {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    if (!d.started) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 4) return;
      d.started = true;
      this.started();
      this.autoScroll();
    }
    d.x = e.clientX;
    d.y = e.clientY;
    if (this.ghost) this.ghost.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 10}px)`;
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.track());
  };

  private track() {
    const d = this.drag;
    const c = this.api.container.current;
    if (!d || !c || d.mode !== "pointer") return;
    const base = c.getBoundingClientRect();
    d.target = dropTarget(d.items, { x: d.x - base.left, y: d.y - base.top }, d.id, this.gap());
    this.paint();
  }

  /** Scroll the page while the pointer is near the top or bottom edge. */
  private autoScroll() {
    const step = () => {
      const d = this.drag;
      if (!d || d.mode !== "pointer" || !d.started) return;
      const edge = 72;
      let dy = 0;
      if (d.y < edge) dy = -Math.ceil((edge - d.y) / 4);
      else if (d.y > window.innerHeight - edge) dy = Math.ceil((d.y - (window.innerHeight - edge)) / 4);
      if (dy !== 0) {
        window.scrollBy(0, dy);
        this.track();
      }
      this.scrollFrame = requestAnimationFrame(step);
    };
    this.scrollFrame = requestAnimationFrame(step);
  }

  private onUp = (e: PointerEvent) => {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    if (d.started) {
      this.track();
      const t = this.drag?.target ?? null;
      const id = d.id;
      this.cleanup();
      this.commit(t, id);
    } else {
      this.cleanup();
    }
  };

  private onCancel = () => {
    this.cleanup();
  };

  private onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && this.drag) {
      e.preventDefault();
      e.stopPropagation();
      const title = titleOf(this.api, this.drag.id);
      this.cleanup();
      announce(`Move of ${title} cancelled.`);
    }
  };

  // keyboard -------------------------------------------------------------------------------------------------

  /** Keys on a part's drag handle. Returns true when the key was used. */
  handleKey(e: ReactKeyboardEvent<HTMLElement>, id: string): boolean {
    const d = this.drag;
    if (!d || d.mode !== "keyboard" || d.id !== id) {
      if (e.key === " " || e.key === "Enter") {
        if (!this.begin("keyboard", id)) return false;
        this.started();
        this.kbdPaint();
        const n = this.drag?.items.length ?? 0;
        announce(`Picked up ${titleOf(this.api, id)}, position ${(this.drag?.pos ?? 0) + 1} of ${n}. Arrow keys move it, Space drops it, Escape cancels.`);
        return true;
      }
      return false;
    }
    const last = d.items.length - 1;
    let pos = d.pos;
    if (e.key === "ArrowUp" || e.key === "ArrowLeft") pos = Math.max(0, pos - 1);
    else if (e.key === "ArrowDown" || e.key === "ArrowRight") pos = Math.min(last, pos + 1);
    else if (e.key === "Home") pos = 0;
    else if (e.key === "End") pos = last;
    else if (e.key === " " || e.key === "Enter") {
      const t = d.target;
      this.cleanup();
      if (!this.commit(t, id)) announce(`${titleOf(this.api, id)} left where it was.`);
      focusLater(`[data-part="${cssId(id)}"] [data-pz-handle]`);
      return true;
    } else if (e.key === "Escape" || e.key === "Tab") {
      this.cleanup();
      announce(`Move of ${titleOf(this.api, id)} cancelled.`);
      return e.key === "Escape";
    } else return false;
    if (pos !== d.pos) {
      d.pos = pos;
      this.kbdPaint();
      const others = d.items.filter((it) => it.id !== id);
      const before = others[pos] ? titleOf(this.api, others[pos].id) : null;
      announce(`Position ${pos + 1} of ${d.items.length}${before ? `, before ${before}` : ", at the end"}.`);
    }
    return true;
  }

  private kbdPaint() {
    const d = this.drag;
    if (!d) return;
    d.target = keyboardTarget(d.items, d.id, d.pos, this.gap());
    this.paint();
    const ind = this.indicator;
    if (ind && ind.style.display === "block") ind.scrollIntoView({ block: "nearest" });
  }

  cancelKeyboard(id: string) {
    if (this.drag?.mode === "keyboard" && this.drag.id === id) this.cleanup();
  }

  dispose() {
    this.cleanup();
  }
}

const controllers = new Map<string, Controller>();

function controllerKey(api: GridApi): string {
  return `${api.key}|${api.zone}`;
}

/** Mounted inside each grid in Personalize mode: owns the drop indicator and the drag ghost. */
export function GridEditor({ api }: { api: GridApi }) {
  const ind = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  const ghost = useRef<HTMLDivElement>(null);
  const k = controllerKey(api);
  let ctl = controllers.get(k);
  if (!ctl) {
    ctl = new Controller(api);
    controllers.set(k, ctl);
  }
  ctl.api = api;

  const latest = useRef(api);
  latest.current = api;

  useEffect(() => {
    let c = controllers.get(k);
    if (!c) {
      c = new Controller(latest.current);
      controllers.set(k, c);
    }
    c.indicator = ind.current;
    c.label = label.current;
    c.ghost = ghost.current;
    const mine = c;
    return () => {
      mine.dispose();
      if (controllers.get(k) === mine) controllers.delete(k);
    };
  }, [k]);

  return (
    <>
      <div ref={ind} className="pz-indicator" aria-hidden style={{ display: "none" }}>
        <span ref={label} className="pz-indicator-label" />
      </div>
      {typeof document !== "undefined"
        ? createPortal(<div ref={ghost} className="pz-ghost" aria-hidden style={{ display: "none" }} />, document.body)
        : null}
    </>
  );
}

// ---- part frame -------------------------------------------------------------------------------------------

export function PartChrome({ api, id, title, cover = true }: { api: GridApi; id: string; title: string; cover?: boolean }) {
  const { touch, narrow } = usePhone();
  const part = api.parts.find((p) => p.id === id);
  const visible = visibleIds(api);
  const i = visible.indexOf(id);
  const { zone, defs } = api;

  const move = (delta: number, src: "up" | "down") => {
    updateDraft((l) => movePartBy(l, zone, defs, visible, id, delta));
    const to = Math.max(0, Math.min(visible.length - 1, i + delta));
    announce(`${title}: position ${to + 1} of ${visible.length}.`);
    focusLater(`[data-part="${cssId(id)}"] [data-pz-move="${src}"]`);
  };

  const items = (): MenuItem[] => {
    const out: MenuItem[] = [
      { label: "Move up", icon: <ArrowUp className="h-3.5 w-3.5" />, disabled: i <= 0, onSelect: () => move(-1, "up") },
      { label: "Move down", icon: <ArrowDown className="h-3.5 w-3.5" />, disabled: i === -1 || i >= visible.length - 1, onSelect: () => move(1, "down") },
      {
        label: "Move to top",
        disabled: i <= 0,
        onSelect: () => {
          updateDraft((l) => movePartToTop(l, zone, defs, id));
          announce(`${title} moved to the top.`);
          focusLater(`[data-part="${cssId(id)}"] [data-pz-handle]`);
        },
      },
    ];
    if (!narrow) {
      (["full", "half", "third"] as PartWidth[]).forEach((w, n) =>
        out.push({
          label: `Width: ${WIDTH_LABEL[w]}`,
          role: "menuitemradio",
          checked: part?.width === w,
          separatorBefore: n === 0,
          onSelect: () => {
            updateDraft((l) => setPartWidth(l, zone, defs, id, w));
            announce(`${title}: ${WIDTH_LABEL[w].toLowerCase()}.`);
          },
        }),
      );
    }
    out.push({
      label: "Collapse by default",
      role: "menuitemcheckbox",
      checked: part?.collapsed === true,
      separatorBefore: true,
      onSelect: () => {
        const next = !(part?.collapsed === true);
        updateDraft((l) => setPartCollapsed(l, zone, defs, id, next));
        announce(`${title} ${next ? "starts collapsed" : "starts open"}.`);
      },
    });
    out.push({
      label: "Hide",
      icon: <EyeOff className="h-3.5 w-3.5" />,
      separatorBefore: true,
      onSelect: () => {
        updateDraft((l) => setPartHidden(l, zone, defs, id, true));
        announce(`${title} hidden. Show it again from Add part.`);
      },
    });
    return out;
  };

  const ctl = () => controllers.get(controllerKey(api));

  return (
    <>
      {/* The whole part is a drag surface for the mouse (BC: point anywhere on it and drag). A part holding
          tiles of its own is dragged by its handle, so its tiles stay reachable. */}
      {cover && (
        <div
          className="pz-cover"
          aria-hidden
          onPointerDown={(e) => ctl()?.pointerDown(e, id, false)}
        />
      )}
      <div className="pz-toolbar">
        <button
          type="button"
          data-pz-handle=""
          aria-label={`Move ${title}. Press Space to pick up, arrow keys to move, Space to drop.`}
          title="Drag to move (or press Space, then the arrow keys)"
          className={`${iconBtn} pz-handle`}
          onPointerDown={(e) => ctl()?.pointerDown(e, id, true)}
          onKeyDown={(e) => {
            if (ctl()?.handleKey(e, id)) e.preventDefault();
          }}
          onBlur={() => ctl()?.cancelKeyboard(id)}
        >
          <GripVertical className="h-4 w-4" strokeWidth={1.75} />
        </button>
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-text-primary">{title}</span>
        {touch && (
          <>
            <button type="button" data-pz-move="up" aria-label={`Move ${title} up`} className={iconBtn} disabled={i <= 0} onClick={() => move(-1, "up")}>
              <ArrowUp className="h-4 w-4" strokeWidth={1.75} />
            </button>
            <button
              type="button"
              data-pz-move="down"
              aria-label={`Move ${title} down`}
              className={iconBtn}
              disabled={i === -1 || i >= visible.length - 1}
              onClick={() => move(1, "down")}
            >
              <ArrowDown className="h-4 w-4" strokeWidth={1.75} />
            </button>
          </>
        )}
        <MenuButton label={`${title}: part options`} items={items}>
          <Ellipsis className="h-4 w-4" strokeWidth={1.75} />
        </MenuButton>
      </div>
    </>
  );
}

/** A hidden part in Personalize mode: a hatched slot at its place (nothing inside is mounted). */
export function HiddenPart({ api, part }: { api: GridApi; part: ResolvedPart }) {
  const show = () => {
    updateDraft((l) => setPartHidden(l, api.zone, api.defs, part.id, false));
    announce(`${part.title} shown.`);
    focusLater(`[data-part="${cssId(part.id)}"] [data-pz-handle]`);
  };
  return (
    <div data-pz-hidden={part.id} data-w={part.width} className="pz-hidden-part">
      <EyeOff className="h-4 w-4 shrink-0 text-text-tertiary" strokeWidth={1.75} aria-hidden />
      <span className="min-w-0 flex-1 truncate text-[12px] text-text-tertiary">
        <span className="font-mono uppercase tracking-[0.08em] text-[10px]">Hidden</span> · {part.title}
      </span>
      <button type="button" onClick={show} className={btn}>
        <Eye className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
        Show
      </button>
    </div>
  );
}

// ---- banner -----------------------------------------------------------------------------------------------

function useSession() {
  return useSyncExternalStore(subscribe, editingSession, () => null);
}

export function Banner({ api }: { api: GridApi }) {
  const session = useSession();
  const ref = useRef<HTMLDivElement>(null);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState("");
  const hidden = api.parts.filter((p) => p.hidden);

  useEffect(() => {
    say = (text: string) => {
      setMessage("");
      requestAnimationFrame(() => setMessage(text));
    };
    return () => {
      say = () => {};
    };
  }, []);

  // Room for the banner above the page, as long as it is open.
  useEffect(() => {
    const el = ref.current;
    const body = document.body;
    body.classList.add("pz-editing");
    const size = () => body.style.setProperty("--pz-banner-h", `${el?.offsetHeight ?? 0}px`);
    size();
    const ro = typeof ResizeObserver === "function" && el ? new ResizeObserver(size) : null;
    if (el) ro?.observe(el);
    return () => {
      ro?.disconnect();
      body.classList.remove("pz-editing");
      body.style.removeProperty("--pz-banner-h");
    };
  }, []);

  const pageTitle = session?.title ?? api.title;

  const addItems = (): MenuItem[] =>
    hidden.map((p) => ({
      label: p.title,
      icon: <Plus className="h-3.5 w-3.5" />,
      onSelect: () => {
        updateDraft((l) => setPartHidden(l, api.zone, api.defs, p.id, false));
        announce(`${p.title} added.`);
        focusLater(`[data-part="${cssId(p.id)}"] [data-pz-handle]`);
      },
    }));

  return createPortal(
    <div ref={ref} role="region" aria-label={`Personalizing ${pageTitle}`} className="pz-banner">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 sm:px-6">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Settings2 className="h-4 w-4 shrink-0 text-accent" strokeWidth={1.75} aria-hidden />
          <p className="min-w-0 truncate text-[13px] text-text-primary">
            <span className="font-semibold">Personalizing</span> <span className="text-text-secondary">{pageTitle}</span>
          </p>
          <p className="hidden text-[11px] text-text-tertiary lg:block">Drag a part to move it · ⋯ for more</p>
        </div>
        {confirming ? (
          <div className="flex w-full flex-wrap items-center gap-2 md:w-auto" role="alertdialog" aria-label="Clear personalization">
            <p className="min-w-0 flex-1 text-[12px] text-text-secondary">
              Put every part and column of this page back in its default place and size? This can&apos;t be undone.
            </p>
            <button type="button" className={btn} onClick={() => setConfirming(false)} autoFocus>
              Keep my layout
            </button>
            <button
              type="button"
              className={`${btn} text-down hover:text-down`}
              onClick={() => {
                setConfirming(false);
                clearAndEnd();
              }}
            >
              <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
              Clear personalization
            </button>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-1.5">
            {hidden.length > 0 ? (
              <MenuButton label={`Add part (${hidden.length} hidden)`} items={addItems} className={btn}>
                <Plus className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
                Add part ({hidden.length})
                <ChevronDown className="h-3 w-3" strokeWidth={1.75} aria-hidden />
              </MenuButton>
            ) : (
              <button type="button" className={btn} disabled title="Hidden parts are listed here">
                <Plus className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
                Add part
              </button>
            )}
            <button type="button" className={btn} onClick={() => setConfirming(true)}>
              Clear personalization
            </button>
            <button type="button" className={btn} onClick={() => endEdit(false)}>
              Cancel
            </button>
            <button
              type="button"
              onClick={() => endEdit(true)}
              className="inline-flex min-h-8 items-center rounded-full bg-accent px-4 text-[12px] font-semibold text-on-accent transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent max-md:min-h-11"
            >
              Done
            </button>
          </div>
        )}
      </div>
      <p className="sr-only" aria-live="polite" role="status">
        {message}
      </p>
    </div>,
    document.body,
  );
}

// ---- tables: column chooser and per-column menu -----------------------------------------------------------

interface ColumnProps {
  layoutKey: string;
  tableId: string;
  columns: ColumnDef[];
  resolved: ResolvedColumn[];
  defaultFreeze: string;
}

function labelOf(resolved: ResolvedColumn[], id: string): string {
  return resolved.find((c) => c.id === id)?.label ?? id;
}

function columnActions({ tableId, columns, resolved, defaultFreeze }: ColumnProps, colId: string): MenuItem[] {
  const visible = resolved.filter((c) => !c.hidden).map((c) => c.id);
  const i = visible.indexOf(colId);
  const col = resolved.find((c) => c.id === colId);
  const label = labelOf(resolved, colId);
  const lastFrozen = resolved.filter((c) => c.frozen).map((c) => c.id).pop();
  return [
    {
      label: "Move left",
      icon: <ArrowUp className="h-3.5 w-3.5 -rotate-90" />,
      disabled: i <= 0,
      onSelect: () => {
        updateDraft((l) => moveColumnBy(l, tableId, columns, visible, colId, -1));
        announce(`${label} column moved left.`);
      },
    },
    {
      label: "Move right",
      icon: <ArrowUp className="h-3.5 w-3.5 rotate-90" />,
      disabled: i === -1 || i >= visible.length - 1,
      onSelect: () => {
        updateDraft((l) => moveColumnBy(l, tableId, columns, visible, colId, 1));
        announce(`${label} column moved right.`);
      },
    },
    lastFrozen === colId
      ? {
          label: "Clear freeze pane",
          separatorBefore: true,
          onSelect: () => {
            updateDraft((l) => setColumnFreeze(l, tableId, "", defaultFreeze));
            announce("Freeze pane cleared.");
          },
        }
      : {
          label: "Set freeze pane here",
          separatorBefore: true,
          onSelect: () => {
            updateDraft((l) => setColumnFreeze(l, tableId, colId, defaultFreeze));
            announce(`Columns through ${label} stay in view when the table scrolls sideways.`);
          },
        },
    {
      label: "Hide column",
      icon: <EyeOff className="h-3.5 w-3.5" />,
      separatorBefore: true,
      disabled: col?.locked === true || visible.length <= 1,
      onSelect: () => {
        updateDraft((l) => setColumnHidden(l, tableId, columns, colId, true));
        announce(`${label} column hidden. Add it again from Columns.`);
      },
    },
  ];
}

export function ColumnMenuButton(props: ColumnProps & { colId: string }) {
  const label = labelOf(props.resolved, props.colId);
  return (
    <span className="pz-tools ml-1 inline-flex align-middle">
      <MenuButton
        label={`${label} column options`}
        items={() => columnActions(props, props.colId)}
        className="inline-flex h-6 w-6 items-center justify-center rounded-control text-text-tertiary hover:bg-surface-hover hover:text-text-primary focus-visible:outline-2 focus-visible:outline-accent max-md:h-11 max-md:w-11"
      >
        <ChevronDown className="h-3.5 w-3.5" strokeWidth={1.75} />
      </MenuButton>
    </span>
  );
}

/** Above a personalizable table in Personalize mode: show / hide columns ("+ Column") and reorder them. */
export function TableTools(props: ColumnProps) {
  const { tableId, columns, resolved, defaultFreeze } = props;
  const [open, setOpen] = useState(false);
  const visible = resolved.filter((c) => !c.hidden).map((c) => c.id);
  const lastFrozen = resolved.filter((c) => c.frozen).map((c) => c.id).pop() ?? "";
  return (
    <div className="pz-tools mb-2 rounded-control border border-dashed border-border-emphasis bg-surface-sunken/80 p-2">
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={btn} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          <Columns3 className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
          Columns ({visible.length} of {resolved.length})
          <ChevronDown className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} strokeWidth={1.75} aria-hidden />
        </button>
        <label className="flex items-center gap-1.5 text-[12px] text-text-secondary">
          Freeze pane through
          <select
            value={lastFrozen}
            onChange={(e) => {
              const v = e.target.value;
              updateDraft((l) => setColumnFreeze(l, tableId, v, defaultFreeze));
              announce(v ? `Columns through ${labelOf(resolved, v)} stay in view.` : "No frozen columns.");
            }}
            className="rounded-control border border-border-subtle bg-surface-card px-2 py-1 text-[12px] text-text-primary max-md:min-h-11"
          >
            <option value="">No column</option>
            {resolved
              .filter((c) => !c.hidden)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
          </select>
        </label>
      </div>
      {open && (
        <ul className="mt-2 space-y-0.5" aria-label="Columns">
          {resolved.map((c) => {
            const vi = visible.indexOf(c.id);
            return (
              <li key={c.id} className="flex items-center gap-2 rounded-control px-1 hover:bg-white/[0.03]">
                <label className="flex min-h-9 flex-1 items-center gap-2 text-[13px] text-text-primary max-md:min-h-11">
                  <input
                    type="checkbox"
                    checked={!c.hidden}
                    disabled={c.locked || (!c.hidden && visible.length <= 1)}
                    onChange={(e) => {
                      const hide = !e.target.checked;
                      updateDraft((l) => setColumnHidden(l, tableId, columns, c.id, hide));
                      announce(`${c.label} column ${hide ? "hidden" : "added"}.`);
                    }}
                    className="h-4 w-4 accent-[var(--color-accent)]"
                  />
                  <span className={c.hidden ? "text-text-tertiary" : undefined}>{c.label}</span>
                  {c.frozen && <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-text-tertiary">frozen</span>}
                </label>
                <button
                  type="button"
                  aria-label={`Move ${c.label} column left`}
                  className={iconBtn}
                  disabled={c.hidden || vi <= 0}
                  onClick={() => updateDraft((l) => moveColumnBy(l, tableId, columns, visible, c.id, -1))}
                >
                  <ArrowUp className="h-4 w-4" strokeWidth={1.75} />
                </button>
                <button
                  type="button"
                  aria-label={`Move ${c.label} column right`}
                  className={iconBtn}
                  disabled={c.hidden || vi === -1 || vi >= visible.length - 1}
                  onClick={() => updateDraft((l) => moveColumnBy(l, tableId, columns, visible, c.id, 1))}
                >
                  <ArrowDown className="h-4 w-4" strokeWidth={1.75} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
