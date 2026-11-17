"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  CARE_KINDS, COPIED_KEY, DEFAULT_TZ, KIND_LABEL, REPEAT_OPTIONS, STORAGE_KEY,
  type CareItem, type CareKind, type LocalCopyState,
  careStatus, compareSchedule, completionChange, formatTime, itemInZone, localCopyState, monthGrid, sampleItems, todayLocal, validDate, validTime, validTimeZone,
} from '@/lib/care-planner';
import { MAX_CARE_ITEMS, MAX_NOTES, type CareOp, type CarePatch, applyOp, inverseOp, opId, opRequest, parseCareItem, putItem, revertOp } from '@/lib/care-items';
import type { CareLoad } from '@/lib/care-items-server';
import type { CalendarStatus } from '@/lib/care-google';
import { CareCalendar, DueSoon } from './CareCalendar';
import CalendarConnectionCard from './CalendarConnectionCard';
import CalendarEventsCard from './CalendarEventsCard';
import InfoHint from '@/components/InfoHint';
import { AutosaveStatus } from '@/components/AutosaveStatus';
import { AutosaveRefused } from '@/lib/autosave';
import { useAutosave } from '@/lib/use-autosave';
import { Part, PartGroup, PartGrid } from '@/components/personalize/PartGrid';
import type { PageLayout } from '@/lib/personalize-layout';
import { type CalendarRange, useCalendarEvents } from './useCalendarEvents';

const panel = 'rounded-2xl border border-border-default bg-surface-card p-5';
const field = 'rounded-lg border border-border-default bg-surface-card px-3 py-2 text-text-primary';
const button = 'rounded-lg border border-border-default px-3 py-2 text-sm hover:bg-surface-hover disabled:opacity-50';

const COMMON_ZONES = ['America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'Europe/London', 'Europe/Madrid', 'UTC'];
const zoneLabel = (tz: string) => tz.replace(/_/g, ' ');

// `id`: the item this form writes (a fresh id for a new one, so the autosaved create and its later edits are one
// item). `editing`: the item is already in Onyx (opened with Edit, or created by this form).
type Form = { id: string; editing: string | null; title: string; kind: CareKind; due: string; time: string; tz: string; months: number; booked: boolean; notes: string };
const emptyForm = (tz: string): Form => ({ id: newId(), editing: null, title: '', kind: 'other', due: '', time: '', tz, months: 0, booked: false, notes: '' });
/** What autosave sends for the form (lib/autosave.ts). */
type FormValue = { id: string; title: string; kind: CareKind; due: string; time: string | null; tz: string; months: number; booked: boolean; notes: string };
const valueOf = (f: Form): FormValue => ({ id: f.id, title: f.title.trim(), kind: f.kind, due: f.due, time: f.time || null, tz: f.tz, months: f.months, booked: f.booked, notes: f.notes });
const hasInput = (f: Form) => !!(f.title.trim() || f.due || f.time || f.notes);

function newId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map(n => n.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function statusText(item: CareItem, today: string): string {
  const status = careStatus(item, today);
  return status === 'booked' ? 'Booked by you' : status === 'confirm-past' ? 'Past appointment — confirm completion' : status === 'overdue' ? 'Overdue — needs booking' : 'Due — needs booking';
}

// "2026-01-15 at 9:30 AM (Europe/Madrid; 3:30 AM your time)" when the item's zone is not the reader's.
function whenText(item: CareItem, viewerTz: string): string {
  if (!item.time) return item.due;
  const base = `${item.due} at ${formatTime(item.time)}`;
  if (item.tz === viewerTz) return base;
  const here = itemInZone(item, viewerTz);
  if (!here) return base;
  return `${base} (${zoneLabel(item.tz)}; ${formatTime(here.time)}${here.date === item.due ? '' : ` on ${here.date}`} your time)`;
}

// headingTestId: "feed-page-heading" when rendered as a section of the continuous scroll (FeedSection.tsx).
// layout: the saved Personalize layout from the page's cookie (routed page only).
export default function HealthClient({ initial, calendar, headingTestId = 'page-heading', layout }: { initial: CareLoad; calendar?: CalendarStatus; headingTestId?: string; layout?: PageLayout }) {
  const [items, setItems] = useState<CareItem[]>(initial.state === 'ready' ? initial.items : []);
  const [load, setLoad] = useState<'ready' | 'loading' | 'failed'>(initial.state === 'ready' ? 'ready' : 'failed');
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [undo, setUndo] = useState<CareOp | null>(null);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const [form, setFormState] = useState<Form>(() => emptyForm(DEFAULT_TZ));
  const [today, setToday] = useState('');
  const [viewerTz, setViewerTz] = useState(DEFAULT_TZ);
  const [demo, setDemo] = useState(false);
  const [local, setLocal] = useState<LocalCopyState>({ state: 'none' });
  const [copying, setCopying] = useState(false);
  // Read-only copies of the events on Riley's calendars for the days the month grid shows
  // (GET /api/calendar/events). Separate from `calendar` above, which is the care-items -> Google
  // connection: these are only ever read, and never become care items.
  const [range, setRange] = useState<CalendarRange | null>(null);
  const showRange = useCallback((start: string, end: string) => setRange(previous => previous && previous.start === start && previous.end === end ? previous : { start, end }), []);
  // Until the month grid reports its days (or when Personalize hides the calendar), read this month's grid,
  // the same days the calendar opens on, so the Google Calendar card still settles.
  const fallbackRange = useMemo<CalendarRange | null>(() => {
    if (!today) return null;
    const grid = monthGrid(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1);
    return { start: grid[0][0].date, end: grid[grid.length - 1][6].date };
  }, [today]);
  const events = useCalendarEvents(range ?? fallbackRange);

  // The latest list and form, kept outside render: a save that fails restores only its own item,
  // so overlapping saves on different items never undo each other.
  const itemsRef = useRef(items);
  const formRef = useRef(form);
  const inFlight = useRef(new Set<string>());
  const commit = (fn: (cur: CareItem[]) => CareItem[]) => { itemsRef.current = fn(itemsRef.current); setItems(itemsRef.current); };
  const setForm = (next: Form) => { formRef.current = next; setFormState(next); };
  // The item as it was when the form opened it (null for a new one): Undo takes the whole edit back to it.
  const sessionBefore = useRef<CareItem | null>(null);

  // Sample items are display-only: never in `items`, never saved, never sent, never editable.
  const shown = useMemo(() => (demo && today ? [...items, ...sampleItems(today)] : items), [demo, items, today]);
  const active = useMemo(() => items.filter(item => !item.archived).sort(compareSchedule), [items]);
  const archived = useMemo(() => items.filter(item => item.archived).sort(compareSchedule), [items]);

  useEffect(() => {
    const updateDay = () => setToday(todayLocal());
    updateDay();
    const interval = setInterval(updateDay, 60000);
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (validTimeZone(zone)) {
      setViewerTz(zone);
      if (!formRef.current.editing && !formRef.current.title) { formRef.current = { ...formRef.current, tz: zone }; setFormState(formRef.current); }
    }
    // The old browser-only planner: offer one copy into Onyx. Reading never changes what is saved.
    try { setLocal(localCopyState(localStorage.getItem(STORAGE_KEY), localStorage.getItem(COPIED_KEY))); } catch { /* storage unavailable: nothing to offer */ }
    return () => clearInterval(interval);
  }, []);

  async function reload() {
    setLoad('loading');
    try {
      const res = await fetch('/api/care/items', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const data: unknown = await res.json();
      const list = (data as { items?: unknown }).items;
      if (!Array.isArray(list)) throw new Error('shape');
      const next: CareItem[] = [];
      for (const raw of list) { const parsed = parseCareItem(raw); if (parsed.ok) next.push(parsed.item); }
      commit(() => next);
      setUndo(null); setNotice(null); setLoad('ready');
    } catch {
      setLoad('failed');
    }
  }

  // One change to one item: shown at once, sent to Onyx, and taken back if Onyx does not confirm it.
  // mode "autosave": the form's own save, which sets Undo itself (for the whole edit, see autosave below).
  async function run(op: CareOp, undoable: boolean | 'autosave' = true): Promise<boolean> {
    const id = opId(op);
    if (inFlight.current.has(id)) return false;
    inFlight.current.add(id);
    const before = itemsRef.current.find(item => item.id === id) ?? null;
    commit(cur => applyOp(cur, op));
    setBusy(cur => new Set(cur).add(id));
    try {
      const request = opRequest(op);
      const res = await fetch(request.path, {
        method: request.method,
        ...(request.body === null ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request.body) }),
      });
      if (!res.ok) throw new Error(String(res.status));
      if (op.type !== 'remove') {
        const saved = parseCareItem(((await res.json()) as { item?: unknown }).item);
        if (!saved.ok) throw new Error('shape');
        commit(cur => putItem(cur, saved.item));
      }
      if (undoable === 'autosave') setNotice(null);
      else {
        setUndo(undoable ? inverseOp(op, before) : null);
        setNotice(undoable ? null : { text: 'Undone.' });
      }
      return true;
    } catch {
      commit(cur => revertOp(cur, op, before));
      setNotice({ text: "Couldn't save that to Onyx, so it was not changed. Try again.", error: true });
      return false;
    } finally {
      inFlight.current.delete(id);
      setBusy(cur => { const next = new Set(cur); next.delete(id); return next; });
    }
  }

  const update = (id: string, patch: CarePatch) => run({ type: 'update', id, patch });

  // Autosave (Riley 2026-11-15, lib/autosave.ts): the form saves on its own. A new item is created as soon as it
  // has a label and a valid date and Riley pauses or leaves the field; after that the same form edits that item.
  // Edit saves each change the same way. Same validation, same optimistic list + revert as before; Undo takes the
  // whole edit back (removes a new item, restores an edited one).
  const formReady = (v: FormValue): string | null => {
    if (!v.title || !validDate(v.due)) return 'Enter a label and a valid date.';
    if (v.time && !validTime(v.time)) return 'Enter the time as hours and minutes, or leave it empty.';
    const exists = itemsRef.current.some(item => item.id === v.id);
    if (!exists && itemsRef.current.length >= MAX_CARE_ITEMS) return `Limit of ${MAX_CARE_ITEMS} items reached. Remove an archived item first.`;
    return null;
  };
  const autosave = useAutosave<FormValue>('care-item', {
    delayMs: 1200,
    ready: formReady,
    save: async v => {
      const { id, ...fields } = v;
      const exists = itemsRef.current.some(item => item.id === id);
      const op: CareOp = exists ? { type: 'update', id, patch: fields } : { type: 'create', item: { id, ...fields, archived: false, completedOn: null } };
      // run() has already taken the change back and said so; Retry (or the next change) sends it again.
      if (!(await run(op, 'autosave'))) throw new AutosaveRefused("Couldn't save that to Onyx.");
      // A create retried after a lost answer gets the stored row back (the route is idempotent on the id), which
      // may predate edits made since: send those as an update.
      const stored = exists ? null : itemsRef.current.find(item => item.id === id);
      const stale = !!stored && (Object.keys(fields) as (keyof typeof fields)[]).some(key => JSON.stringify(stored[key]) !== JSON.stringify(fields[key]));
      if (stale && !(await run({ type: 'update', id, patch: fields }, 'autosave'))) throw new AutosaveRefused("Couldn't save that to Onyx.");
      const before = sessionBefore.current;
      setUndo(before ? inverseOp({ type: 'update', id, patch: fields }, before) : { type: 'remove', id });
      if (formRef.current.id === id && !formRef.current.editing) setForm({ ...formRef.current, editing: id });
    },
  });

  /** A field changed: show it and let autosave send it (typed fields after a pause, the rest almost at once). */
  function change(next: Form, typed = false) {
    setForm(next);
    if (!hasInput(next) && !next.editing) { autosave.reset(); return; }
    // A new item waits for a pause on every field, so it is created once with what was entered.
    autosave.change(valueOf(next), { delayMs: typed || !next.editing ? 1200 : 400 });
  }

  /** Done (and Enter): send what is waiting; the form then starts a new item. An incomplete entry stays with its reason. */
  async function finish(event?: React.FormEvent) {
    event?.preventDefault();
    const cur = formRef.current;
    if (!hasInput(cur) && !cur.editing) return;
    const why = formReady(valueOf(cur));
    if (why) { setNotice({ text: why, error: true }); return; }
    if (!(await autosave.flush()) || formRef.current.id !== cur.id) return; // not saved: the status line has Retry
    sessionBefore.current = null;
    const fresh = emptyForm(viewerTz);
    setForm(fresh);
    autosave.reset();
  }

  async function edit(item: CareItem) {
    // Send what the form still holds before it switches to another item. If that is not saved (it failed, or the
    // entry is incomplete), the form keeps it and says so instead of dropping it.
    const cur = formRef.current;
    if ((hasInput(cur) || cur.editing) && !(await autosave.flush())) {
      setNotice({
        text: formReady(valueOf(cur))
          ? 'Finish or clear the item in the form before editing another one.'
          : 'The item in the form is not saved yet. Retry it (next to Done) before editing another one.',
        error: true,
      });
      return;
    }
    if (formRef.current.id !== cur.id) return; // the form changed while saving
    sessionBefore.current = item;
    const next: Form = { id: item.id, editing: item.id, title: item.title, kind: item.kind, due: item.due, time: item.time ?? '', tz: item.tz, months: item.months, booked: item.booked, notes: item.notes };
    setForm(next);
    autosave.reset(valueOf(next));
  }

  async function copyLocal() {
    if (local.state !== 'offer' || copying) return;
    setCopying(true);
    try {
      const res = await fetch('/api/care/items/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: local.items, tz: viewerTz }) });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { copied?: unknown; skipped?: unknown; items?: unknown };
      if (!Array.isArray(data.items) || typeof data.copied !== 'number' || typeof data.skipped !== 'number') throw new Error('shape');
      const fresh: CareItem[] = [];
      for (const raw of data.items) { const parsed = parseCareItem(raw); if (parsed.ok) fresh.push(parsed.item); }
      commit(cur => fresh.reduce((list, item) => (inFlight.current.has(item.id) ? list : putItem(list, item)), cur));
      try { localStorage.setItem(COPIED_KEY, new Date().toISOString()); } catch { /* the copy is idempotent, so being offered it again is harmless */ }
      setLocal({ state: 'copied', count: local.items.length });
      setNotice({ text: `Copied ${data.copied} item${data.copied === 1 ? '' : 's'} into Onyx${data.skipped ? ` (${data.skipped} already there)` : ''}.` });
    } catch {
      setNotice({ text: "Couldn't copy the items saved in this browser. Nothing was changed; try again.", error: true });
    } finally {
      setCopying(false);
    }
  }

  function removeLocal() {
    try { localStorage.removeItem(STORAGE_KEY); localStorage.removeItem(COPIED_KEY); setLocal({ state: 'none' }); }
    catch { setNotice({ text: 'Could not remove the copy saved in this browser.', error: true }); }
  }

  const zones = [...new Set([form.tz, viewerTz, ...COMMON_ZONES])].filter(validTimeZone);

  return <div className="mx-auto max-w-4xl space-y-6 p-4 sm:p-8">
    <header><h1 data-testid={headingTestId} className="text-2xl font-semibold">Health & appointments</h1></header>
    {notice && <p role={notice.error ? 'alert' : 'status'} className={`text-sm ${notice.error ? 'text-amber-400' : 'text-text-secondary'}`}>{notice.text}</p>}
    {undo && load === 'ready' && <button className={button} disabled={busy.has(opId(undo))} onClick={() => { const op = undo; setUndo(null); if (formRef.current.id === opId(op)) { autosave.reset(); sessionBefore.current = null; setForm(emptyForm(viewerTz)); } void run(op, false); }}>Undo last change</button>}
    {load === 'loading' && <p role="status">Loading your care items…</p>}
    {load === 'failed' && <section className={`${panel} space-y-3`} role="alert">
      <h2 className="font-semibold">Couldn&apos;t load your care items</h2>
      <p className="text-sm text-text-secondary">Onyx did not answer, so nothing is shown and nothing was changed. This is not an empty list.</p>
      <button className={button} onClick={() => void reload()}>Try again</button>
    </section>}
    {/* Personalize: every panel is its own part, in two sections; a part moves within its section or into the
        other. `layout` (routed page only) is the saved layout from the page's cookie, so the server renders it. */}
    <PartGrid page="/health" title="Health & appointments" initial={layout}>
      <PartGroup id="about" title="Privacy & calendars">
        <Part id="privacy-note" title="Private planning, saved in Onyx">
          <section className={panel} aria-label="Privacy">
            <div className="flex items-center gap-2">
              <h2 className="font-semibold">Private planning, saved in Onyx</h2>
              <InfoHint label="Private planning">
                <p>Items are saved to your Onyx account and show on any device where you are signed in. Lab results and documents go in <Link href="/health/records" className="text-accent hover:underline">Medical records</Link>.</p>
                <p>Nothing is sent to a provider or a reminder service, and nothing goes to a calendar unless you connect one below. Dates and repeat intervals are yours to choose, not medical recommendations.</p>
              </InfoHint>
            </div>
            {local.state === 'offer' && <div className="mt-3 rounded-xl border border-border-default p-3 text-sm">
              <p>This browser holds {local.items.length} item{local.items.length === 1 ? '' : 's'} saved by the earlier version of this page.</p>
              <button className={`${button} mt-2`} disabled={copying || load !== 'ready'} onClick={copyLocal}>{copying ? 'Copying…' : `Copy ${local.items.length === 1 ? 'it' : `all ${local.items.length}`} into Onyx`}</button>
            </div>}
            {local.state === 'copied' && <div className="mt-3 rounded-xl border border-border-default p-3 text-sm">
              <p>The {local.count} item{local.count === 1 ? '' : 's'} saved in this browser {local.count === 1 ? 'is' : 'are'} now in Onyx. The old browser copy is no longer used.</p>
              <button className={`${button} mt-2`} onClick={removeLocal}>Remove the browser copy</button>
            </div>}
            {local.state === 'unreadable' && <p className="mt-3 text-sm text-text-secondary">This browser holds an older saved planner that cannot be read. It has been left untouched and is not used.</p>}
          </section>
        </Part>
        <Part id="calendar-events" title="Google Calendar (read-only events)" width="half">
          <CalendarEventsCard calendar={events} />
        </Part>
        <Part id="calendar-copy" title="Copy care items to Google Calendar" width="half">
          <CalendarConnectionCard initial={calendar} />
        </Part>
      </PartGroup>
      <PartGroup
        id="planner"
        title="Care planner"
        header={load === 'ready' ? <label className="mb-4 flex items-start gap-2 text-sm"><input type="checkbox" checked={demo} onChange={event => setDemo(event.target.checked)} />Show sample data (invented, not saved)</label> : null}
      >
        {load === 'ready' && <Part id="due-soon" title="Due soon">
          <DueSoon items={shown} today={today} />
        </Part>}
        {load === 'ready' && <Part id="care-calendar" title="Care calendar">
          <CareCalendar items={shown} today={today} external={events.events} onRangeChange={showRange} />
        </Part>}
        {load === 'ready' && <Part id="add-item" title="Add care item">
          <form onSubmit={finish} className={`${panel} space-y-4`}>
            <div className="flex items-center gap-2">
              <h2 className="font-semibold">{sessionBefore.current?.id === form.id ? 'Edit care item' : 'Add care item'}</h2>
              <InfoHint label="Care items">
                <p>Marking complete uses today&apos;s date for the next interval. A repeat becomes due, never automatically booked.</p>
                <p>The time is the clock time where the appointment is, so it does not shift when clocks change.</p>
              </InfoHint>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm">Short label<input className={field} required maxLength={100} value={form.title} onChange={e => change({ ...form, title: e.target.value }, true)} onBlur={() => void autosave.flush()} placeholder="e.g. Routine checkup" /></label>
              <label className="flex flex-col gap-1 text-sm">Kind<select className={field} value={form.kind} onChange={e => change({ ...form, kind: e.target.value as CareKind })}>{CARE_KINDS.map(kind => <option key={kind} value={kind}>{KIND_LABEL[kind]}</option>)}</select></label>
              <label className="flex flex-col gap-1 text-sm">{form.booked ? 'Confirmed appointment date' : 'Due date'}<input className={field} type="date" required min="1900-01-01" max="9998-12-31" value={form.due} onChange={e => change({ ...form, due: e.target.value }, true)} onBlur={() => void autosave.flush()} /></label>
              <label className="flex flex-col gap-1 text-sm">Time (optional)<input className={field} type="time" value={form.time} onChange={e => change({ ...form, time: e.target.value }, true)} onBlur={() => void autosave.flush()} /></label>
              {form.time && <label className="flex flex-col gap-1 text-sm">Time zone of the appointment<select className={field} value={form.tz} onChange={e => change({ ...form, tz: e.target.value })}>{zones.map(tz => <option key={tz} value={tz}>{zoneLabel(tz)}{tz === viewerTz ? ' (this device)' : ''}</option>)}</select></label>}
              <label className="flex flex-col gap-1 text-sm">Repeat after completion<select className={field} value={form.months} onChange={e => change({ ...form, months: Number(e.target.value) })}>{REPEAT_OPTIONS.map(n => <option key={n} value={n}>{n === 0 ? 'Does not repeat' : `Every ${n} month${n === 1 ? '' : 's'}`}</option>)}</select></label>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.booked} onChange={e => change({ ...form, booked: e.target.checked })} />I have already booked this appointment</label>
              <label className="flex flex-col gap-1 text-sm sm:col-span-2">Note (optional)<textarea className={field} rows={2} maxLength={MAX_NOTES} value={form.notes} onChange={e => change({ ...form, notes: e.target.value }, true)} onBlur={() => void autosave.flush()} placeholder="e.g. bring the referral form" /></label>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button className={button} type="submit" disabled={!hasInput(form) && !form.editing}>Done</button>
              {!form.editing && hasInput(form) && <button className={button} type="button" onClick={() => { autosave.reset(); setForm(emptyForm(viewerTz)); }}>Clear</button>}
              <AutosaveStatus state={autosave.state} onRetry={() => void autosave.retry()} showIncomplete={hasInput(form)} savedText={form.editing && !sessionBefore.current ? 'Added' : 'Saved'} />
            </div>
            <p className="text-xs text-text-tertiary">Saves on its own once it has a label and a date. Done starts a new item.</p>
          </form>
        </Part>}
        {load === 'ready' && <Part id="upcoming" title="Upcoming care">
          <section className={`${panel} space-y-3`}><h2 className="font-semibold">Upcoming care</h2>
            {active.length === 0 && <p className="text-sm text-text-secondary">No care items yet. Add a date when you know one.</p>}
            {active.map(item => {
              const locked = busy.has(item.id) || form.editing === item.id;
              return <article key={item.id} className="space-y-2 rounded-xl border border-border-default p-4" aria-busy={busy.has(item.id)}>
                <h3 className="font-medium break-words">{item.title}</h3>
                <p className="text-sm text-text-secondary">{whenText(item, viewerTz)} · {KIND_LABEL[item.kind]} · {statusText(item, today)}{item.months > 0 && ` · Every ${item.months} month${item.months === 1 ? '' : 's'} after completion`}{busy.has(item.id) && ' · Saving…'}</p>
                {item.notes && <p className="text-sm whitespace-pre-wrap break-words">{item.notes}</p>}
                <div className="flex flex-wrap gap-2"><button className={button} disabled={busy.has(item.id)} onClick={() => void edit(item)}>Edit</button><button className={button} disabled={locked} onClick={() => void update(item.id, completionChange(item, todayLocal()))}>Mark complete today</button><button className={button} disabled={locked} onClick={() => void update(item.id, { archived: true })}>Archive</button></div>
              </article>;
            })}
          </section>
        </Part>}
        {load === 'ready' && archived.length > 0 && <Part id="archived" title="Archived and completed items">
          <details className={panel}><summary>Archived and completed items</summary>{archived.map(item => <div key={item.id} className="mt-3 flex flex-wrap items-center justify-between gap-3"><span className="break-words">{item.title} · {item.due}{item.completedOn && ` · completed ${item.completedOn}`}</span><span className="flex gap-2"><button className={button} disabled={busy.has(item.id)} onClick={() => void update(item.id, { archived: false })}>Restore</button><button className={button} disabled={busy.has(item.id)} onClick={() => void run({ type: 'remove', id: item.id })}>Remove</button></span></div>)}</details>
        </Part>}
      </PartGroup>
    </PartGrid>
    <nav aria-label="Health dashboards" className="flex flex-wrap gap-4 text-sm text-accent"><Link href="/sleep">Sleep & recovery</Link><Link href="/supplements">Supplements</Link><Link href="/chat">Onyx Chat</Link></nav>
  </div>;
}
