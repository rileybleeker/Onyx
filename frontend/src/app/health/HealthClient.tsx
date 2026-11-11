"use client";
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { type CareItem, STORAGE_KEY, nextDue, parseItems, todayLocal, validDate } from '@/lib/care-planner';

const panel = 'rounded-2xl border border-border-default bg-surface-card p-5';
const field = 'rounded-lg border border-border-default bg-surface-card px-3 py-2 text-text-primary';
const button = 'rounded-lg border border-border-default px-3 py-2 text-sm hover:bg-surface-hover disabled:opacity-50';
export default function HealthClient() {
  const [items, setItems] = useState<CareItem[]>([]);
  const [ready, setReady] = useState(false);
  const [undo, setUndo] = useState<CareItem[] | null>(null);
  const [save, setSave] = useState(false);
  const [storageBlocked, setStorageBlocked] = useState(false);
  const savedRaw = useRef<string | null>(null);
  const [error, setError] = useState('');
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [months, setMonths] = useState(0);
  const [booked, setBooked] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [today, setToday] = useState('');
  useEffect(() => {
    const updateDay = () => setToday(todayLocal());
    updateDay();
    const interval = setInterval(updateDay, 60000);
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      savedRaw.current = raw;
      if (raw) {
        try { setItems(parseItems(raw)); setSave(true); }
        catch { setStorageBlocked(true); setError('Saved planner is unreadable and has not been changed. Saving is disabled to protect it.'); }
      }
    } catch { setStorageBlocked(true); setError('Browser storage is unavailable. Changes will remain in this session only.'); }
    const storageChanged = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY && event.key !== null) return;
      setSave(false); setStorageBlocked(true); setUndo(null);
      setError('Planner storage changed in another tab. Saving is paused to prevent overwriting changes. Reload to use the latest saved planner.');
    };
    window.addEventListener('storage', storageChanged);
    setReady(true);
    return () => { clearInterval(interval); window.removeEventListener('storage', storageChanged); };
  }, []);
  function writeSaved(next: CareItem[] | null) {
    if (storageBlocked || localStorage.getItem(STORAGE_KEY) !== savedRaw.current) {
      setSave(false); setStorageBlocked(true);
      throw new Error('Planner storage changed. Reload before saving again.');
    }
    const raw = next === null ? null : JSON.stringify(next);
    if (raw === null) localStorage.removeItem(STORAGE_KEY); else localStorage.setItem(STORAGE_KEY, raw);
    savedRaw.current = raw;
  }
  function persist(next: CareItem[], enabled = save) {
    setUndo(items);
    setItems(next);
    if (enabled) {
      try { writeSaved(next); setError(''); }
      catch { setError('Changes are only in this session. Storage is unavailable, full, or changed in another tab; reload before saving again.'); }
    }
  }
  function reset() { setEditing(null); setTitle(''); setDue(''); setMonths(0); setBooked(false); }
  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim() || !validDate(due)) { setError('Enter a label and a valid date.'); return; }
    if (items.length >= 500 && !editing) { setError('Limit of 500 items reached. Remove an archived item first.'); return; }
    const item: CareItem = { id: editing ?? (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`), title: title.trim(), due, months, booked, archived: false };
    persist(editing ? items.map(old => old.id === editing ? item : old) : [...items, item]); reset();
  }
  function complete(item: CareItem) {
    persist(items.map(old => old.id !== item.id ? old : item.months ? { ...old, due: nextDue(todayLocal(), item.months), booked: false } : { ...old, archived: true }));
  }
  return <div className="mx-auto max-w-4xl space-y-6 p-4 sm:p-8">
    <header><h1 className="text-2xl font-semibold">Health & appointments</h1><p className="mt-2 text-text-secondary">Plan routine care and keep track of what needs booking.</p></header>
    <section className={panel} aria-label="Privacy and calendar connection">
      <h2 className="font-semibold">Private planning, on this browser</h2>
      <p className="mt-2 text-sm text-text-secondary">Start with a short label and date. No medical records, provider contact, bookings or reminders are sent. Dates and repeat intervals are yours to choose, not medical recommendations.</p>
      <label className="mt-3 flex items-start gap-2 text-sm"><input type="checkbox" checked={save} disabled={!ready || storageBlocked} onChange={event => {
        const enabled = event.target.checked;
        if (!enabled) { try { writeSaved(null); setSave(false); setError(''); } catch { setError('Could not remove the saved copy. Browser storage may still contain it.'); } }
        else { try { writeSaved(items); setSave(true); setError(''); } catch { setError('Could not save this session. Storage may be unavailable or changed in another tab.'); } }
      }} />Save on this browser (not encrypted, not synced; anyone using this browser profile may access it). Uncheck to remove the saved copy; current entries remain for this session.</label>
      <div className="mt-4 border-t border-border-default pt-3"><h3 className="text-sm font-semibold">Google Calendar: not connected</h3><p className="mt-1 text-sm text-text-secondary">Personal calendars are not being read or updated. Two-way calendar sync still needs a secure connection and calendar selection. Marking an item booked only records your confirmation here.</p></div>
    </section>
    {error && <p role="alert" className="text-sm text-amber-400">{error}</p>}
    {undo && <button className={button} onClick={() => { persist(undo); setUndo(null); if (editing && !undo.some(item => item.id === editing && !item.archived)) reset(); }}>Undo last change</button>}
    {!ready ? <p role="status">Loading local planner…</p> : <>
      <form onSubmit={submit} className={`${panel} space-y-4`}>
        <h2 className="font-semibold">{editing ? 'Edit care item' : 'Add care item'}</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-sm">Short label<input className={field} required maxLength={100} value={title} onChange={e => setTitle(e.target.value)} placeholder="e.g. Routine checkup" /></label>
          <label className="flex flex-col gap-1 text-sm">{booked ? 'Confirmed appointment date' : 'Due date'}<input className={field} type="date" required min="1900-01-01" max="9998-12-31" value={due} onChange={e => setDue(e.target.value)} /></label>
          <label className="flex flex-col gap-1 text-sm">Repeat after completion<select className={field} value={months} onChange={e => setMonths(Number(e.target.value))}><option value={0}>Does not repeat</option>{[1,3,6,12,24].map(n => <option key={n} value={n}>Every {n} month{n === 1 ? '' : 's'}</option>)}</select></label>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={booked} onChange={e => setBooked(e.target.checked)} />I have already booked this appointment</label>
        </div>
        <p className="text-xs text-text-secondary">Marking complete uses today&apos;s date for the next interval. A repeat becomes due, never automatically booked.</p>
        <button className={button} type="submit">{editing ? 'Save changes' : 'Add item'}</button>{editing && <button className={`${button} ml-2`} type="button" onClick={reset}>Cancel</button>}
      </form>
      <section className={`${panel} space-y-3`}><h2 className="font-semibold">Upcoming care</h2>
        {!items.some(item => !item.archived) && <p className="text-sm text-text-secondary">No care items yet. Add a date when you know one.</p>}
        {items.filter(item => !item.archived).sort((a,b) => a.due.localeCompare(b.due) || a.id.localeCompare(b.id)).map(item => <article key={item.id} className="space-y-2 rounded-xl border border-border-default p-4">
          <h3 className="font-medium break-words">{item.title}</h3><p className="text-sm text-text-secondary">{item.due} · {item.booked ? (item.due < today ? 'Past appointment — confirm completion' : 'Booked by you') : item.due < today ? 'Overdue — needs booking' : 'Due — needs booking'}{item.months > 0 && ` · Every ${item.months} month${item.months === 1 ? '' : 's'} after completion`}</p>
          <div className="flex flex-wrap gap-2"><button className={button} onClick={() => { setEditing(item.id); setTitle(item.title); setDue(item.due); setMonths(item.months); setBooked(item.booked); }}>Edit</button><button className={button} disabled={editing === item.id} onClick={() => complete(item)}>Mark complete today</button><button className={button} disabled={editing === item.id} onClick={() => persist(items.map(old => old.id === item.id ? { ...old, archived: true } : old))}>Archive</button></div>
        </article>)}
      </section>
      {items.some(item => item.archived) && <details className={panel}><summary>Archived and completed items</summary>{items.filter(item => item.archived).map(item => <div key={item.id} className="mt-3 flex items-center justify-between gap-3"><span>{item.title} · {item.due}</span><button className={button} onClick={() => persist(items.map(old => old.id === item.id ? { ...old, archived: false } : old))}>Restore</button><button className={button} onClick={() => persist(items.filter(old => old.id !== item.id))}>Remove</button></div>)}</details>}
    </>}
    <nav aria-label="Health dashboards" className="flex flex-wrap gap-4 text-sm text-accent"><Link href="/sleep">Sleep & recovery</Link><Link href="/supplements">Supplements</Link><Link href="/chat">Health Q&A</Link></nav>
  </div>;
}
