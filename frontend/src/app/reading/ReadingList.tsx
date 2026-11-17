"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, BookOpen, Pencil } from "lucide-react";
import { AutosaveStatus } from "@/components/AutosaveStatus";
import { AutosaveRefused } from "@/lib/autosave";
import { useAutosave } from "@/lib/use-autosave";
import { clientCache } from "@/lib/client-cache";
import { sameJson } from "@/lib/format";
import type { Book } from "@/lib/reading";
import {
  LIST_URL,
  acknowledgement,
  applyAnswer,
  draftBaseline,
  draftSettled,
  editDraft,
  emptyLocal,
  keepMine,
  listErrorText,
  newDraft,
  newOpKey,
  nextSend,
  normalizeIdentifier,
  readLocal,
  recordPending,
  safeStorage,
  takeSaved,
  withDraft,
  withoutPending,
  writeLocal,
  type Body,
  type Draft,
  type DuplicateCandidate,
  type Fields,
  type ListItem,
  type ListLocal,
  type Resolve,
} from "@/lib/reading-list";

/**
 * Want to read (PROD-READLIST-01): the queued books of pds.books, inside /reading (and its copy in the scroll).
 *
 * Opening the screen only reads (GET /api/reading/list, from the client cache first, and this device's copy of
 * words or changes not confirmed yet). Nothing is sent until Riley types or taps. The Add a book box and each row
 * editor save themselves; Move / Start reading / Remove / Undo are actions. Every request's exact body is written
 * to this device first (when it cannot be kept, nothing is sent and the words stay on screen), an unanswered body
 * is resent unchanged, and an editor's words stay based on the version it opened with: a newer copy elsewhere is a
 * conflict Riley resolves (lib/reading-list.ts nextSend / applyAnswer).
 */

type Answer = { status: number; json: Record<string, unknown> };
type Send = (body: Body) => Promise<Answer>;
type Dup = { candidates: DuplicateCandidate[]; distinctAllowed: boolean };

const btn =
  "inline-flex items-center justify-center gap-1 min-h-[44px] min-w-[44px] px-3 rounded-control border border-border-subtle text-[13px] text-text-secondary hover:text-text-primary hover:bg-white/[0.04] disabled:opacity-40 disabled:pointer-events-none";
const field =
  "mt-1 w-full min-h-[44px] bg-white/[0.03] border border-border-subtle rounded-control px-3 py-2 text-[16px] md:text-[14px] text-text-primary";
const label = "block text-[11px] font-mono uppercase tracking-wider text-text-tertiary";

const localDay = () => new Date().toLocaleDateString("en-CA");

function cachedItems(raw: unknown): ListItem[] | null {
  const v = raw as { items?: unknown } | undefined;
  return v && Array.isArray(v.items) && v.items.every((i) => i && typeof (i as ListItem).book_id === "number") ? (v.items as ListItem[]) : null;
}

function statusText(c: DuplicateCandidate): string {
  if (c.status === "queued") return c.listed ? "on your list" : "taken off your list";
  if (c.status === "reading") return "reading now";
  if (c.status === "finished") return "finished";
  return "set aside";
}

export default function ReadingList({ books, onChanged }: { books: Book[]; onChanged: (e: { started?: string }) => void }) {
  const [items, setItems] = useState<ListItem[] | null>(() => cachedItems(clientCache.peek(LIST_URL)));
  const [loadState, setLoadState] = useState<"loading" | "ok" | "error" | "unavailable">("loading");
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const localRef = useRef<ListLocal>(emptyLocal());
  const [local, setLocal] = useState<ListLocal | null>(null);
  const [rowMsg, setRowMsg] = useState<{ id: number; text: string; retry?: Body } | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [undo, setUndo] = useState<ListItem | null>(null);
  const [startFor, setStartFor] = useState<number | null>(null);
  const [startDate, setStartDate] = useState("");
  const [editing, setEditing] = useState<Record<number, boolean>>({});
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  /** Keep the device copy in step; false = it could not be written (callers must not send). */
  const persist = useCallback((next: ListLocal): boolean => {
    localRef.current = next;
    setLocal(next);
    return writeLocal(safeStorage(), next);
  }, []);

  const applyItems = useCallback((next: ListItem[]) => {
    clientCache.put(LIST_URL, { items: next });
    setItems((prev) => (sameJson(prev, next) ? prev : next));
  }, []);

  const loadList = useCallback(async () => {
    try {
      const res = await fetch(LIST_URL, { cache: "no-store" });
      const json = (await res.json().catch(() => ({}))) as { items?: ListItem[] };
      if (res.status === 503) return setLoadState("unavailable");
      if (!res.ok || !Array.isArray(json.items)) throw new Error("load");
      applyItems(json.items);
      setLoadState("ok");
    } catch {
      // Keep whatever is on screen (cached list, and the quest above is untouched).
      setLoadState("error");
    }
  }, [applyItems]);

  // Mount: read only. The device copy (unsaved words, unconfirmed changes) is shown, never sent from here.
  useEffect(() => {
    const l = readLocal(safeStorage());
    localRef.current = l;
    setLocal(l);
    setEditing(Object.fromEntries(Object.keys(l.edits).map((k) => [Number(k), true])));
    void loadList();
  }, [loadList]);

  /** One request, in order with every other one. Throws when the outcome is unknown (network, 5xx). */
  const send = useCallback<Send>(
    (body) => {
      const run = async (): Promise<Answer> => {
        const res = await fetch(LIST_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        const json = (await res.json()) as Record<string, unknown>;
        if (res.status >= 500 || res.status === 408 || res.status === 429) throw new Error(listErrorText(typeof json.error === "string" ? json.error : null));
        if (res.ok && (json.success !== true || !Number.isInteger(json.book_id) || !Number.isInteger(json.op_version))) {
          throw new Error("Couldn't confirm the save. Retry will check the same change.");
        }
        if (Array.isArray(json.items)) applyItems(json.items as ListItem[]);
        else if (res.ok) void loadList();
        if (res.ok) onChangedRef.current({ started: typeof json.started === "string" ? json.started : undefined });
        return { status: res.status, json };
      };
      const p = chain.current.then(run, run);
      chain.current = p.catch(() => undefined);
      return p;
    },
    [applyItems, loadList],
  );

  /** A box's draft into the device copy; false = not kept. */
  const persistDraft = useCallback(
    (which: "add" | number, d: Draft | null) => persist(withDraft(localRef.current, which, d && !draftSettled(d) ? d : null)),
    [persist],
  );

  /** A tapped action (move, remove, restore, start): recorded on the device first, or not sent at all. */
  const act = async (item: ListItem, body: Body) => {
    setRowMsg(null);
    const rec = recordPending(safeStorage(), localRef.current, body, Date.now());
    if (!rec.ok) {
      setRowMsg({ id: item.book_id, text: listErrorText(rec.reason) });
      return null;
    }
    localRef.current = rec.local;
    setLocal(rec.local);
    setBusy(item.book_id);
    try {
      const a = await send(body);
      persist(withoutPending(localRef.current, body.op_key));
      if (a.status !== 200) {
        if (a.json.error === "changed") void loadList();
        setRowMsg({ id: item.book_id, text: listErrorText(a.json.error as string) });
        return null;
      }
      applyAck(body, a.json);
      return a.json;
    } catch (e) {
      setRowMsg({ id: item.book_id, text: e instanceof Error && e.message ? e.message : listErrorText(null), retry: body });
      return null;
    } finally {
      setBusy(null);
    }
  };

  /** One acknowledgement path for a first attempt AND a retry: Undo for a removed book, reset of the start UI, etc. */
  const applyAck = useCallback((body: Body, json: Record<string, unknown> | null) => {
    const effect = acknowledgement(body, json);
    if (effect.kind === "undo") setUndo(effect.item);
    else if (effect.kind === "clearUndo") setUndo(null);
    else if (effect.kind === "resetStart") {
      setStartFor(null);
      setStartDate("");
    }
  }, []);

  const list = items ?? [];
  const move = (item: ListItem, direction: "up" | "down") =>
    void act(item, { op: "move", op_key: newOpKey(), book_id: item.book_id, direction, expected_order: list.map((i) => i.book_id) });
  const remove = (item: ListItem) => void act(item, { op: "remove", op_key: newOpKey(), book_id: item.book_id, expected_version: item.version });
  const restore = (item: ListItem) => void act(item, { op: "restore", op_key: newOpKey(), book_id: item.book_id, expected_version: item.version });
  const start = (item: ListItem) =>
    void act(item, { op: "start", op_key: newOpKey(), book_id: item.book_id, expected_version: item.version, start_date: startDate || null });

  const retryPending = async () => {
    for (const p of [...localRef.current.pending]) {
      try {
        if (!writeLocal(safeStorage(), localRef.current)) throw new Error(listErrorText("storage"));
        const a = await send(p.body);
        persist(withoutPending(localRef.current, p.body.op_key));
        if (a.status !== 200) setRowMsg({ id: Number(p.body.book_id ?? 0), text: listErrorText(a.json.error as string) });
        else applyAck(p.body, a.json);
      } catch {
        return; // still unreachable: the rest stay recorded
      }
    }
  };
  const dismissPending = () => persist({ ...localRef.current, pending: [] });

  const titleOf = (id: number) => books.find((b) => b.book_id === id)?.title ?? items?.find((i) => i.book_id === id)?.title ?? null;
  const pendingCount = local?.pending.length ?? 0;

  return (
    <section className="bg-surface-card border border-border-subtle rounded-card shadow-card p-4" data-testid="reading-want-list">
      <div className="flex items-baseline justify-between">
        <h3 className="text-[11px] font-mono uppercase tracking-wider text-text-tertiary flex items-center gap-1.5">
          <BookOpen className="w-3.5 h-3.5" aria-hidden /> Want to read
        </h3>
        {list.length > 0 && <span className="text-[11px] font-mono text-text-tertiary">{list.length}</span>}
      </div>

      {loadState === "unavailable" && <p className="mt-2 text-[13px] text-[var(--color-mid)]">Your list isn&apos;t available yet.</p>}
      {loadState === "error" && (
        <p className="mt-2 text-[13px] text-red-400">
          Couldn&apos;t load your list.{" "}
          <button type="button" className="underline min-h-[44px]" onClick={() => void loadList()}>
            Try again
          </button>
        </p>
      )}

      {pendingCount > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px] text-[var(--color-mid)]" role="status">
          <span>{pendingCount === 1 ? "A change may not have saved." : `${pendingCount} changes may not have saved.`}</span>
          <button type="button" className={btn} onClick={() => void retryPending()}>
            Retry
          </button>
          <button type="button" className={btn} onClick={dismissPending}>
            Dismiss
          </button>
        </div>
      )}

      {items && list.length === 0 && loadState !== "unavailable" && <p className="mt-2 text-[13px] text-text-tertiary">Nothing on your list yet.</p>}

      {list.length > 0 && (
        <ol className="mt-3 space-y-2" aria-label="Want to read">
          {list.map((item, i) => {
            const name = item.title;
            const rowBusy = busy === item.book_id;
            return (
              <li key={item.book_id} className="border border-border-subtle rounded-control p-3" data-testid="want-to-read-item">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-[14px] text-text-primary break-words">{name}</p>
                    {(item.author || item.edition) && (
                      <p className="text-[12px] text-text-tertiary">
                        {item.author}
                        {item.author && item.edition ? " · " : ""}
                        {item.edition && <span className="font-mono">{item.edition}</span>}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    <button type="button" className={btn} aria-label={`Move ${name} up`} disabled={i === 0 || busy !== null} onClick={() => move(item, "up")}>
                      <ArrowUp className="w-4 h-4" aria-hidden />
                    </button>
                    <button type="button" className={btn} aria-label={`Move ${name} down`} disabled={i === list.length - 1 || busy !== null} onClick={() => move(item, "down")}>
                      <ArrowDown className="w-4 h-4" aria-hidden />
                    </button>
                    <button
                      type="button"
                      className={btn}
                      aria-label={`Edit ${name}`}
                      aria-expanded={!!editing[item.book_id]}
                      onClick={() => setEditing((e) => ({ ...e, [item.book_id]: !e[item.book_id] }))}
                    >
                      <Pencil className="w-4 h-4" aria-hidden />
                    </button>
                    <button type="button" className={btn} aria-expanded={startFor === item.book_id} disabled={rowBusy} onClick={() => setStartFor((s) => (s === item.book_id ? null : item.book_id))}>
                      Start reading
                    </button>
                    <button type="button" className={btn} aria-label={`Remove ${name} from your list`} disabled={rowBusy} onClick={() => void remove(item)}>
                      Remove
                    </button>
                  </div>
                </div>

                {startFor === item.book_id && (
                  <div className="mt-2 flex flex-wrap items-end gap-2">
                    <label className="text-[13px] text-text-secondary">
                      <span className={label}>Start date (optional)</span>
                      <input type="date" className={field} value={startDate} max={localDay()} onChange={(e) => setStartDate(e.target.value)} />
                    </label>
                    <button type="button" className={`${btn} border-accent/60 text-accent`} disabled={rowBusy} onClick={() => void start(item)}>
                      Start {name.length > 40 ? "this book" : name}
                    </button>
                    <button type="button" className={btn} onClick={() => setStartFor(null)}>
                      Cancel
                    </button>
                  </div>
                )}

                {editing[item.book_id] && local && (
                  <DraftBox
                    key={`edit-${item.book_id}`}
                    which={item.book_id}
                    initial={local.edits[String(item.book_id)] ?? editDraft(item)}
                    restored={!!local.edits[String(item.book_id)]}
                    send={send}
                    persistDraft={persistDraft}
                    titleOf={titleOf}
                    onClose={() => setEditing((e) => ({ ...e, [item.book_id]: false }))}
                  />
                )}

                {rowMsg && rowMsg.id === item.book_id && (
                  <p className="mt-2 text-[13px] text-red-400" role="alert">
                    {rowMsg.text}{" "}
                    {rowMsg.retry && (
                      <button type="button" className="underline min-h-[44px]" onClick={() => void act(item, rowMsg.retry!)}>
                        Retry
                      </button>
                    )}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      )}

      {undo && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-[13px] text-text-secondary" role="status">
          <span>Removed from your list.</span>
          <button type="button" className={btn} disabled={busy === undo.book_id} onClick={() => void restore(undo)}>
            Undo
          </button>
          {rowMsg && rowMsg.id === undo.book_id && <span className="text-red-400">{rowMsg.text}</span>}
        </div>
      )}

      {local && loadState === "ok" && Object.entries(local.edits).filter(([id]) => !list.some((i) => i.book_id === Number(id))).map(([id, d]) => (
        <div key={`retained-${id}`} className="mt-3 border border-border-subtle rounded-control p-3">
          <p className="text-[13px] text-mid" role="status">This book left the list. Your unsaved words are still here.</p>
          <label className={label}>Retained book details
            <textarea className={field} readOnly value={[d.fields.title, d.fields.author, d.fields.edition].filter(Boolean).join("\n")} />
          </label>
          <button type="button" className={btn} onClick={() => persistDraft(Number(id), null)}>Discard retained changes</button>
        </div>
      ))}

      {local && (
        <DraftBox
          key="add"
          which="add"
          initial={local.add ?? newDraft()}
          restored={!!local.add}
          send={send}
          persistDraft={persistDraft}
          titleOf={titleOf}
        />
      )}
    </section>
  );
}

/* ------------------------------------------------------------------ */

function ready(f: Fields): string | null {
  if (!f.title.trim()) return "Add a title.";
  if (normalizeIdentifier(f.edition) === undefined) return listErrorText("bad_identifier");
  return null;
}

/**
 * One self-saving box: Add a book (`which = "add"`) or a row's editor (`which = book id`). What it holds lives in a
 * Draft (lib/reading-list.ts); `drive` sends what nextSend says, one body at a time, each written to the device
 * first, and folds each answer in with applyAnswer.
 */
function DraftBox({
  which,
  initial,
  restored: restoredAtMount,
  send,
  persistDraft,
  titleOf,
  onClose,
}: {
  which: "add" | number;
  initial: Draft;
  restored: boolean;
  send: Send;
  persistDraft: (which: "add" | number, d: Draft | null) => boolean;
  titleOf: (id: number) => string | null;
  onClose?: () => void;
}) {
  const isAdd = which === "add";
  const [draft, setDraftState] = useState<Draft>(initial);
  const draftRef = useRef<Draft>(initial);
  const [restored, setRestored] = useState(restoredAtMount);
  const [dup, setDup] = useState<Dup | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deviceWarn, setDeviceWarn] = useState(false);

  const setDraft = (d: Draft) => {
    draftRef.current = d;
    setDraftState(d);
  };
  const keep = (d: Draft) => {
    const ok = persistDraft(which, d);
    setDeviceWarn(!ok);
    return ok;
  };

  const drive = async () => {
    for (let step = 0; step < 6; step++) {
      // Waiting on Riley's choice after a conflict: nothing is sent, and nothing may read as saved.
      if (draftRef.current.conflict) throw new AutosaveRefused(listErrorText("changed"));
      const next = nextSend(draftRef.current, newOpKey);
      if (!next) return;
      // Fail closed: the exact body is on this device before it leaves, or it does not leave.
      if (!keep(next.draft)) throw new AutosaveRefused(listErrorText("storage"));
      setDraft(next.draft);
      const a = await send(next.body); // unknown outcome throws: `sent` stays, the retry resends it unchanged
      const { draft: after, outcome } = applyAnswer(draftRef.current, next.body, a.status, a.json);
      setDraft(after);
      keep(after);
      switch (outcome.kind) {
        case "applied":
          setDup(null);
          continue; // newer words typed meanwhile go next, as an edit on the version just confirmed
        case "reused":
          setDup(null);
          setNotice(outcome.item?.listed ? `${outcome.item.title} is on your list.` : listErrorText("not_queued"));
          return;
        case "not_listed":
          setNotice(listErrorText("not_queued"));
          setRestored(true);
          return;
        case "duplicate":
          setDup({ candidates: outcome.candidates, distinctAllowed: outcome.distinctAllowed });
          throw new AutosaveRefused(listErrorText("duplicate"));
        case "conflict":
          throw new AutosaveRefused(listErrorText("changed"));
        default:
          if (outcome.code === "changed") setDup(null);
          throw new AutosaveRefused(listErrorText(outcome.code));
      }
    }
    if (!draftSettled(draftRef.current)) throw new Error("More changes are waiting. Retry to finish saving them.");
  };

  const autosave = useAutosave<Fields>(isAdd ? "reading-want-list-add" : `reading-want-list-${which}`, { delayMs: 1500, ready, save: () => drive() }, draftBaseline(initial));

  const edit = (patch: Partial<Fields>) => {
    const fields = { ...draftRef.current.fields, ...patch };
    // A new choice is needed after the words change (the duplicate check runs again).
    const d = { ...draftRef.current, fields, resolve: draftRef.current.book_id === null ? null : draftRef.current.resolve };
    setDraft(d);
    keep(d);
    setRestored(false);
    setNotice(null);
    if (d.book_id === null) setDup(null);
    autosave.change(fields);
  };

  const startOver = () => {
    const d = newDraft();
    setDraft(d);
    persistDraft(which, null);
    setDup(null);
    setRestored(false);
    autosave.reset(d.fields);
  };

  const choose = (r: Resolve) => {
    setDraft({ ...draftRef.current, resolve: r });
    void autosave.retry();
  };

  const conflict = draft.conflict;
  const onKeepMine = () => {
    const d = keepMine(draftRef.current);
    setDraft(d);
    keep(d);
    setRestored(false);
    autosave.change(d.fields, { delayMs: 0 });
    void autosave.flush();
  };
  const onTakeSaved = () => {
    const d = takeSaved(draftRef.current);
    setDraft(d);
    persistDraft(which, null);
    autosave.reset(d.fields);
    if (!isAdd) onClose?.();
  };

  const f = draft.fields;
  const id = isAdd ? "add" : `edit-${which}`;

  return (
    <div className={isAdd ? "mt-4 border-t border-border-subtle pt-3" : "mt-2"} onBlur={() => !restored && void autosave.flush()}>
      {isAdd && <p className={label}>Add a book</p>}
      <div className="mt-2 grid gap-2 md:grid-cols-3">
        <label className="md:col-span-3 text-[13px] text-text-secondary" htmlFor={`${id}-title`}>
          <span className={label}>Title</span>
          <input
            id={`${id}-title`}
            className={field}
            value={f.title}
            maxLength={300}
            onChange={(e) => edit({ title: e.target.value })}
            onKeyDown={(e) => e.key === "Enter" && !restored && void autosave.flush()}
          />
        </label>
        <label className="text-[13px] text-text-secondary md:col-span-2" htmlFor={`${id}-author`}>
          <span className={label}>Author (optional)</span>
          <input id={`${id}-author`} className={field} value={f.author} maxLength={200} onChange={(e) => edit({ author: e.target.value })} />
        </label>
        <label className="text-[13px] text-text-secondary" htmlFor={`${id}-edition`}>
          <span className={label}>ISBN or ASIN (optional)</span>
          <input
            id={`${id}-edition`}
            className={`${field} font-mono`}
            value={f.edition}
            maxLength={40}
            autoCapitalize="characters"
            onChange={(e) => edit({ edition: e.target.value })}
          />
        </label>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2 min-h-[44px]" aria-live="polite">
        {restored ? (
          <>
            <span className="text-[13px] text-[var(--color-mid)]">{draft.sent ? "Your last change may not have saved." : "Not saved yet."}</span>
            <button
              type="button"
              className={btn}
              onClick={() => {
                setRestored(false);
                autosave.change(draftRef.current.fields, { delayMs: 0 });
                void autosave.flush();
              }}
            >
              Keep
            </button>
            <button type="button" className={btn} onClick={isAdd ? startOver : onTakeSavedOrClose}>
              Discard
            </button>
          </>
        ) : (
          <AutosaveStatus state={autosave.state} onRetry={() => void autosave.retry()} savedText={isAdd && draft.book_id ? "On your list" : "Saved"} />
        )}
        {notice && <span className="text-[13px] text-text-secondary">{notice}</span>}
        {deviceWarn && <span className="text-[13px] text-red-400">{listErrorText("storage")}</span>}
        {isAdd && draft.book_id && !restored && (
          <button
            type="button"
            className={btn}
            onClick={async () => {
              if ((await autosave.flush()) && draftSettled(draftRef.current)) startOver();
            }}
          >
            Add another
          </button>
        )}
      </div>

      {dup && (
        <div className="mt-2 rounded-control border border-border-default p-3 text-[13px] text-text-secondary" role="alert">
          <p>{dup.distinctAllowed ? "A book with this title is already in Reading:" : "This ISBN or ASIN is already in Reading:"}</p>
          <ul className="mt-1 space-y-1">
            {dup.candidates.map((c) => (
              <li key={c.book_id} className="flex flex-wrap items-center gap-2">
                <span className="text-text-primary">{titleOf(c.book_id) ?? "A book"}</span>
                <span className="text-text-tertiary">({statusText(c)})</span>
                {c.status === "queued" && (
                  <button type="button" className={btn} onClick={() => choose({ reuse: c.book_id, expected_version: c.version, expected_listed: c.listed })}>
                    Use this one
                  </button>
                )}
              </li>
            ))}
          </ul>
          {dup.distinctAllowed ? (
            <button type="button" className={`${btn} mt-2`} onClick={() => choose("distinct")}>
              Add as a separate edition
            </button>
          ) : (
            <p className="mt-1 text-text-tertiary">Clear the ISBN or ASIN to add it separately.</p>
          )}
        </div>
      )}

      {conflict && (
        <div className="mt-2 flex flex-wrap items-center gap-2 rounded-control border border-border-default p-3 text-[13px] text-text-secondary" role="alert">
          <span>This book was changed somewhere else.</span>
          <button type="button" className={btn} onClick={onKeepMine}>
            Keep my changes
          </button>
          <button type="button" className={btn} onClick={onTakeSaved}>
            Use the saved version
          </button>
        </div>
      )}
    </div>
  );

  function onTakeSavedOrClose() {
    // Discard restored words of a row editor: drop the device copy and close (the list shows the saved book).
    persistDraft(which, null);
    autosave.reset(initial.fields);
    onClose?.();
  }
}
