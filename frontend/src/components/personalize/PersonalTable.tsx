"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { EMPTY_LAYOUT, resolveColumns, type ColumnDef } from "@/lib/personalize-layout";
import { editorSnapshot, isEditing, layoutSnapshot, subscribe } from "@/lib/personalize-store";
import { useGridContext } from "./PartGrid";
import type { EditorModule } from "./editor-loader";

/**
 * A table whose columns Riley can personalize (BC: show / hide columns, move them, set the freeze pane), stored in
 * the page's layout under `tables[id]`. Use it inside a <Part> of a <PartGrid>; outside one it is a plain table.
 *
 * Cells are given per column, so a server component can pass server-rendered cells and the column order is
 * applied without sending the rows twice. Hidden columns are not rendered.
 */

export interface TableColumn extends ColumnDef {
  /** Classes of the header cell. */
  th?: string;
  /** Classes of the body cells. */
  td?: string;
}

export interface TableRow {
  key: string;
  className?: string;
  cells: Record<string, ReactNode>;
}

const noEditor = () => null;
const notEditing = () => false;

function cx(...parts: (string | false | undefined)[]): string | undefined {
  const s = parts.filter(Boolean).join(" ");
  return s || undefined;
}

function sticky(left: number | undefined): CSSProperties {
  return { position: "sticky", left: left ?? 0, zIndex: 1 };
}

export default function PersonalTable({
  id,
  columns,
  rows,
  defaultFreeze = "",
  className,
  headRowClassName,
  rowClassName,
}: {
  /** Table id within the page (one per table). */
  id: string;
  columns: TableColumn[];
  rows: TableRow[];
  /** The table's own freeze pane: the last column that sticks while scrolling sideways ("" = none). */
  defaultFreeze?: string;
  className?: string;
  headRowClassName?: string;
  rowClassName?: string;
}) {
  const ctx = useGridContext();
  const key = ctx?.key ?? "";
  const layout = useSyncExternalStore(
    subscribe,
    () => (key ? layoutSnapshot(key) : EMPTY_LAYOUT),
    () => ctx?.initial ?? EMPTY_LAYOUT,
  );
  const editing = useSyncExternalStore(subscribe, () => (key ? isEditing(key) : false), notEditing);
  const editor = useSyncExternalStore(subscribe, editorSnapshot, noEditor) as EditorModule | null;
  const live = editing && editor && key ? editor : null;

  const resolved = resolveColumns(columns, layout.tables?.[id], defaultFreeze);
  const visible = resolved.filter((c) => !c.hidden);
  const byId = new Map<string, TableColumn>();
  for (const c of columns) if (!byId.has(c.id)) byId.set(c.id, c);
  const frozen = visible.filter((c) => c.frozen).length;
  const signature = visible.map((c) => c.id).join(",");

  // Frozen columns stick at the left edge of the scroll area: their offsets are measured only when a freeze pane
  // is set (a table without one does no work here).
  const tableRef = useRef<HTMLTableElement>(null);
  const [lefts, setLefts] = useState<number[]>([]);
  useEffect(() => {
    const table = tableRef.current;
    if (!frozen || !table) {
      setLefts((l) => (l.length ? [] : l));
      return undefined;
    }
    const measure = () => {
      const cells = table.tHead?.rows[0]?.cells;
      if (!cells || cells.length === 0) return;
      const base = cells[0].offsetLeft;
      const next: number[] = [];
      for (let i = 0; i < frozen && i < cells.length; i++) next.push(cells[i].offsetLeft - base);
      setLefts((l) => (l.length === next.length && l.every((v, i) => v === next[i]) ? l : next));
    };
    measure();
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(measure) : null;
    ro?.observe(table);
    return () => ro?.disconnect();
  }, [frozen, signature]);

  return (
    <>
      {live ? <live.TableTools layoutKey={key} tableId={id} columns={columns} resolved={resolved} defaultFreeze={defaultFreeze} /> : null}
      <table ref={tableRef} className={className} data-pz-table={id}>
        <thead>
          <tr className={headRowClassName}>
            {visible.map((c, i) => (
              <th
                key={c.id}
                data-col={c.id}
                className={cx(byId.get(c.id)?.th, i < frozen && "pz-frozen", i === frozen - 1 && "pz-frozen-edge")}
                style={i < frozen ? sticky(lefts[i]) : undefined}
              >
                {c.label}
                {live ? (
                  <live.ColumnMenuButton
                    layoutKey={key}
                    tableId={id}
                    columns={columns}
                    resolved={resolved}
                    colId={c.id}
                    defaultFreeze={defaultFreeze}
                  />
                ) : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} className={r.className ?? rowClassName}>
              {visible.map((c, i) => (
                <td
                  key={c.id}
                  className={cx(byId.get(c.id)?.td, i < frozen && "pz-frozen", i === frozen - 1 && "pz-frozen-edge")}
                  style={i < frozen ? sticky(lefts[i]) : undefined}
                >
                  {r.cells[c.id]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
