"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AutosaveStatus } from "@/components/AutosaveStatus";
import { AutosaveRefused } from "@/lib/autosave";
import {
  StackConflict,
  StackSaveChain,
  StackSaveUnconfirmed,
  stackSaveRequest,
  stackSaveUnknownOutcome,
} from "@/lib/supplement-stack-chain";
import { useAutosave } from "@/lib/use-autosave";

/** A product from the /supplements library picker (subset of the page's Product). */
export interface StackPickerProduct {
  product_id: string;
  brand_name: string | null;
  full_name: string | null;
  serving_size: number | null;
  serving_unit: string | null;
  ingredient_count: number;
}

export interface StackItemDraft {
  product_id: string;
  doses: number;
  full_name?: string | null;
  brand_name?: string | null;
}

/** Stack being edited. stack_id null = creating a new stack. */
export interface EditableStack {
  stack_id: number | null;
  name: string;
  description: string | null;
  /** Local 'HH:MM' for the push reminder; null / empty = reminders off. */
  remind_time?: string | null;
  items: StackItemDraft[];
  /** pds.supplement_stack.version as loaded (null = a new stack, or a server without versions). */
  version?: number | null;
}

interface Props {
  open: boolean;
  stack: EditableStack | null; // null while closed; {stack_id:null,...} for a new stack
  products: StackPickerProduct[];
  onClose: () => void;
  /** Called on close when anything was saved (the caller re-reads the stacks). */
  onSaved: () => void;
}

/** What is sent: the editor's fields, items as the API takes them. */
type StackForm = { name: string; description: string; remind_time: string; items: { product_id: string; doses: number }[] };

function formOf(name: string, description: string, remindTime: string, items: StackItemDraft[]): StackForm {
  return {
    name,
    description,
    remind_time: remindTime,
    items: items.filter((i) => i.product_id).map((i) => ({ product_id: i.product_id, doses: i.doses > 0 ? i.doses : 1 })),
  };
}

/**
 * The stack's current version from the list (a stack whose list was read before versions existed has none). A failed
 * read throws (nothing is written; autosave retries). Null when the server has no version for it.
 */
async function readVersion(stackId: number): Promise<number | null> {
  const res = await fetch("/api/supplements/stacks?include_archived=1", { cache: "no-store" });
  if (!res.ok) throw new Error("The stack's latest version could not be read. Nothing was saved; retrying.");
  const json = (await res.json().catch(() => null)) as { stacks?: { stack_id: number; version?: number | null }[] } | null;
  return json?.stacks?.find((s) => s.stack_id === stackId)?.version ?? null;
}

/** One random id per new stack: a retried create (lost answer) then returns the same stack instead of a second. */
function newClientKey(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (n) => n.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function notReady(f: StackForm): string | null {
  if (!f.name.trim()) return "Give the stack a name.";
  if (f.items.length === 0) return "Add at least one product.";
  return null;
}

/**
 * Autosave (Riley 2026-11-15, lib/autosave.ts): an existing stack's changes are sent on their own (taps almost at
 * once, typing after a pause and when the field is left) through PATCH /api/supplements/stacks. A new stack is
 * created (POST) as soon as it has a name and a product, and later changes PATCH that stack. The create carries a
 * client_key (one UUID per new stack), so a create retried after a lost answer returns that stack instead of a second
 * copy (sql/supplement_stack_client_key.sql). Done (or a tap outside) sends what is waiting and closes; a failed save
 * keeps the editor open with its message.
 *
 * Each save is one transaction on the server (header + the complete item list, sql/supplement_stack_atomic_save.sql)
 * and carries the version this editor last saw plus save ids (lib/supplement-stack-chain.ts). When the stack was
 * changed somewhere else in the meantime the server refuses with 409; the editor then stops sending and offers to load
 * the latest version instead of overwriting it.
 */
export default function StackEditorModal({ open, stack, products, onClose, onSaved }: Props) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [remindTime, setRemindTime] = useState("");
  const [items, setItems] = useState<StackItemDraft[]>([]);
  const [addProductId, setAddProductId] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The stack being edited: the one opened, or the one this editor created. State so the Delete button follows. */
  const [stackId, setStackId] = useState<number | null>(null);
  const stackIdRef = useRef<number | null>(null);
  const clientKey = useRef<string | null>(null);
  const savedAny = useRef(false);
  const chain = useRef<StackSaveChain>(new StackSaveChain(null, newClientKey));
  /** The stack changed somewhere else since it was loaded: nothing more is sent until the latest is loaded. */
  const [conflict, setConflict] = useState(false);
  /** The last save got no clear answer: it may have gone through. Shown as "Not confirmed", retried with its save id. */
  const [unconfirmed, setUnconfirmed] = useState(false);

  const autosave = useAutosave<StackForm>("stack-editor", {
    delayMs: 500,
    ready: notReady,
    // After an unconfirmed save the stack may hold that value: changing back to the loaded values is then sent (as a
    // newer save after the unanswered one), never dropped as "unchanged" with the unwanted change left stored.
    unknownOutcome: stackSaveUnknownOutcome,
    save: async (f, { keepalive }) => {
      const body = {
        name: f.name.trim(),
        description: f.description.trim() || null,
        // Empty = reminders off (the API stores NULL).
        remind_time: f.remind_time || null,
        items: f.items,
      };
      // An existing stack with no version yet (loaded before versions existed): read it first, so the save carries a
      // version instead of none (the server refuses a save without one).
      if (stackIdRef.current !== null && chain.current.knownVersion === null) {
        chain.current.learnVersion(await readVersion(stackIdRef.current));
      }
      const fields = chain.current.next(body);
      const creating = stackIdRef.current === null;
      let json: Record<string, unknown>;
      try {
        if (creating) {
          clientKey.current ??= newClientKey();
          json = await stackSaveRequest("POST", { ...body, client_key: clientKey.current, ...fields }, keepalive);
        } else {
          json = await stackSaveRequest("PATCH", { stack_id: stackIdRef.current, ...body, ...fields }, keepalive);
        }
      } catch (e) {
        // A refusal wrote nothing; a network or server failure may have gone through (its id stays unanswered, so the
        // retry sends the same save id and a save that went through is answered as a replay, not written twice).
        if (e instanceof AutosaveRefused) chain.current.refused(fields);
        if (e instanceof StackConflict) setConflict(true);
        setUnconfirmed(e instanceof StackSaveUnconfirmed);
        // It may have gone through: closing then re-reads the list (onSaved) instead of keeping the old version.
        if (e instanceof StackSaveUnconfirmed) savedAny.current = true;
        throw e;
      }
      setUnconfirmed(false);
      chain.current.accepted(json.version);
      if (creating) {
        const id = Number(json.stack_id);
        if (Number.isFinite(id)) {
          stackIdRef.current = id;
          setStackId(id);
        }
      }
      savedAny.current = true;
    },
  });
  const { reset: resetAutosave } = autosave;

  useEffect(() => {
    if (!stack) return;
    setName(stack.name);
    setDescription(stack.description ?? "");
    setRemindTime(stack.remind_time ?? "");
    setItems(stack.items.map((i) => ({ ...i })));
    setAddProductId("");
    setError(null);
    stackIdRef.current = stack.stack_id ?? null;
    setStackId(stack.stack_id ?? null);
    clientKey.current = stack.stack_id ? null : newClientKey();
    chain.current = new StackSaveChain(stack.stack_id ? (stack.version ?? null) : null, newClientKey);
    setConflict(false);
    setUnconfirmed(false);
    savedAny.current = false;
    resetAutosave(stack.stack_id ? formOf(stack.name, stack.description ?? "", stack.remind_time ?? "", stack.items) : undefined);
  }, [stack, resetAutosave]);

  const isNew = !stack?.stack_id;

  // Products not already in the stack, for the "add" dropdown.
  const available = useMemo(() => {
    const chosen = new Set(items.map((i) => i.product_id));
    return products.filter((p) => !chosen.has(p.product_id));
  }, [products, items]);

  const productById = useMemo(
    () => Object.fromEntries(products.map((p) => [p.product_id, p])),
    [products],
  );

  if (!open || !stack) return null;

  /** Fields and buttons that change the stack stop while a delete runs or after a 409 (load the latest first). */
  const locked = deleting || conflict;

  /** Every edit goes through here: typing waits for a pause, a tap is sent almost at once. */
  function send(next: Partial<{ name: string; description: string; remindTime: string; items: StackItemDraft[] }>, typed = false) {
    if (conflict) return;
    const f = formOf(next.name ?? name, next.description ?? description, next.remindTime ?? remindTime, next.items ?? items);
    autosave.change(f, { delayMs: typed ? 1200 : 400 });
  }

  function addItem(product_id: string) {
    if (!product_id) return;
    const p = productById[product_id];
    const next = [...items, { product_id, doses: 1, full_name: p?.full_name ?? null, brand_name: p?.brand_name ?? null }];
    setItems(next);
    setAddProductId("");
    send({ items: next });
  }

  function setDoses(product_id: string, value: string) {
    const n = Number(value);
    const next = items.map((i) => (i.product_id === product_id ? { ...i, doses: Number.isFinite(n) ? n : i.doses } : i));
    setItems(next);
    send({ items: next }, true);
  }

  function removeItem(product_id: string) {
    const next = items.filter((i) => i.product_id !== product_id);
    setItems(next);
    send({ items: next });
  }

  /**
   * Done / a tap outside: send what is waiting, then close. A failed save keeps the editor open; so does a stack
   * already saved and now left without a name or products (its last complete version stays saved; Close leaves).
   */
  async function done() {
    if (conflict) return loadLatest();
    if (notReady(formOf(name, description, remindTime, items)) && stackIdRef.current !== null) return;
    await closeNow();
  }

  /**
   * Close (top right): leave even when the form is incomplete; whatever is complete and waiting is sent first. A
   * complete change that could not be saved keeps the editor open (its status line has Retry).
   */
  async function closeNow() {
    if (conflict) return loadLatest();
    const ok = await autosave.flush();
    if (!ok && !notReady(formOf(name, description, remindTime, items))) return;
    if (savedAny.current) onSaved();
    else onClose();
  }

  /** After a 409: the refused change is let go and the stacks are read again (open the stack again to edit it). */
  function loadLatest() {
    autosave.reset();
    onSaved();
  }

  async function archive() {
    const id = stackIdRef.current;
    if (id === null) return;
    if (!confirm(`Delete the "${name}" stack?\n\nYour logged intake history is kept — only the saved template is removed.`)) {
      return;
    }
    autosave.reset();
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/supplements/stacks?stack_id=${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("delete failed");
      onSaved();
    } catch {
      setError("Couldn't delete this stack. Try again.");
    } finally {
      setDeleting(false);
    }
  }

  const totalDoses = items.reduce((s, i) => s + (i.doses > 0 ? i.doses : 0), 0);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-start justify-center p-4 overflow-y-auto"
      onClick={() => void done()}
    >
      <div
        className="bg-surface-card border border-border-subtle rounded-card shadow-card p-5 w-full max-w-lg mt-12"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[14px] font-medium text-text-primary">
            {isNew ? "New stack" : "Edit stack"}
          </h2>
          <button
            onClick={() => void closeNow()}
            disabled={deleting}
            className="text-[11px] text-text-tertiary hover:text-text-secondary font-mono disabled:opacity-40"
          >
            Close
          </button>
        </div>

        <label className="block text-[10px] font-mono uppercase tracking-wide text-text-tertiary mb-1">
          Name
        </label>
        <input
          type="text"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            send({ name: e.target.value }, true);
          }}
          onBlur={() => void autosave.flush()}
          disabled={locked}
          placeholder="e.g. Morning stack"
          className="w-full mb-3 px-3 py-2 text-[14px] bg-black/40 border border-border-subtle rounded-control text-text-primary focus:border-accent/50 outline-none disabled:opacity-50"
        />

        <label className="block text-[10px] font-mono uppercase tracking-wide text-text-tertiary mb-1">
          Description (optional)
        </label>
        <input
          type="text"
          value={description}
          onChange={(e) => {
            setDescription(e.target.value);
            send({ description: e.target.value }, true);
          }}
          onBlur={() => void autosave.flush()}
          disabled={locked}
          placeholder="e.g. taken right after waking"
          className="w-full mb-4 px-3 py-2 text-[13px] bg-black/40 border border-border-subtle rounded-control text-text-primary focus:border-accent/50 outline-none disabled:opacity-50"
        />

        <label className="block text-[10px] font-mono uppercase tracking-wide text-text-tertiary mb-1">
          Reminder time (optional)
        </label>
        <div className="flex items-center gap-2 mb-1">
          <input
            type="time"
            value={remindTime}
            onChange={(e) => {
              setRemindTime(e.target.value);
              send({ remindTime: e.target.value }, true);
            }}
            onBlur={() => void autosave.flush()}
            disabled={locked}
            aria-label="Reminder time"
            className="px-3 py-2 text-[13px] tabular-nums bg-black/40 border border-border-subtle rounded-control text-text-primary focus:border-accent/50 outline-none disabled:opacity-50"
          />
          {remindTime && (
            <button
              type="button"
              onClick={() => {
                setRemindTime("");
                send({ remindTime: "" });
              }}
              disabled={locked}
              className="px-2 py-1 text-[11px] font-mono text-text-tertiary hover:text-text-primary disabled:opacity-40 transition-colors"
            >
              clear
            </button>
          )}
        </div>
        <p className="text-[10px] text-text-tertiary font-mono mb-4">
          {remindTime
            ? "Onyx pushes a Log it / Skip card to your Agents chat at this time (your local clock) if the stack isn't logged yet."
            : "Empty = no reminder."}
        </p>

        <div className="flex items-center justify-between mb-1">
          <label className="block text-[10px] font-mono uppercase tracking-wide text-text-tertiary">
            Products ({items.length}) · {totalDoses} doses
          </label>
        </div>

        {items.length === 0 ? (
          <p className="text-[11px] text-text-tertiary font-mono py-3 text-center border border-dashed border-border-subtle rounded-control mb-3">
            No products yet — add one below.
          </p>
        ) : (
          <div className="space-y-1.5 mb-3">
            {items.map((it) => {
              const p = productById[it.product_id];
              return (
                <div
                  key={it.product_id}
                  className="flex items-center gap-2 bg-black/30 border border-border-subtle rounded-control px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-[12px] text-text-primary truncate">
                      {p?.full_name ?? it.full_name ?? it.product_id}
                    </p>
                    <p className="text-[10px] text-text-tertiary font-mono truncate">
                      {p?.brand_name ?? it.brand_name ?? "—"}
                      {p?.serving_size && p?.serving_unit ? ` · ${p.serving_size} ${p.serving_unit}` : ""}
                    </p>
                  </div>
                  <input
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.5"
                    value={it.doses}
                    onChange={(e) => setDoses(it.product_id, e.target.value)}
                    onBlur={() => void autosave.flush()}
                    disabled={locked}
                    className="w-[64px] px-2 py-1 text-[13px] tabular-nums bg-black/40 border border-border-subtle rounded-control text-text-primary focus:border-accent/50 outline-none disabled:opacity-50"
                    title="Doses logged for this product"
                  />
                  <span className="text-[10px] text-text-tertiary font-mono shrink-0">dose</span>
                  <button
                    onClick={() => removeItem(it.product_id)}
                    disabled={locked}
                    className="px-1 text-[14px] text-text-tertiary/60 hover:text-red-400 disabled:opacity-40 transition-colors"
                    aria-label="Remove product"
                  >
                    ✕
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Add-product picker driven by the already-loaded library. */}
        <div className="flex gap-2 mb-4">
          <select
            value={addProductId}
            onChange={(e) => addItem(e.target.value)}
            aria-label="Add a product"
            disabled={locked || available.length === 0}
            className="flex-1 px-3 py-2 text-[12px] bg-black/40 border border-border-subtle rounded-control text-text-primary focus:border-accent/50 outline-none disabled:opacity-50"
          >
            <option value="">
              {available.length === 0 ? "All library products added" : "+ Add a product…"}
            </option>
            {available.map((p) => (
              <option key={p.product_id} value={p.product_id}>
                {(p.full_name ?? p.product_id) + (p.brand_name ? ` — ${p.brand_name}` : "")}
              </option>
            ))}
          </select>
        </div>

        {error && <p className="text-[11px] font-mono text-red-400 mb-3 break-words">{error}</p>}
        {conflict && (
          <button
            type="button"
            onClick={loadLatest}
            className="mb-3 px-3 py-2 text-[12px] font-medium text-text-primary border border-border-subtle rounded-control hover:border-accent/50 transition-colors"
          >
            Load the latest version
          </button>
        )}

        <div className="flex items-center justify-between gap-2">
          {stackId !== null ? (
            <button
              onClick={archive}
              disabled={deleting}
              className="px-3 py-2 text-[12px] text-red-400/80 hover:text-red-400 disabled:opacity-40 transition-colors"
            >
              Delete stack
            </button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-3">
            <AutosaveStatus
              state={autosave.state}
              onRetry={() => void autosave.retry()}
              showIncomplete
              errorLabel={unconfirmed ? "Not confirmed:" : undefined}
              savedText={isNew && stackId !== null ? "Stack created" : "Saved"}
            />
            <button
              onClick={() => void done()}
              disabled={deleting}
              className="px-4 py-2 text-[12px] font-medium text-on-accent font-semibold bg-accent hover:bg-accent/90 disabled:opacity-40 disabled:cursor-not-allowed border border-accent rounded-full transition-colors"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
