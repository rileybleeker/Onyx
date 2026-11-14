"use client";
import { useEffect, useState } from 'react';
import { GOOGLE_AUTH_URL, NOT_CONNECTED, type CalendarStatus, type CalendarSyncSummary } from '@/lib/care-google';

const button = 'rounded-lg border border-border-default px-3 py-2 text-sm hover:bg-surface-hover disabled:opacity-50';

function ago(iso: string, now: number): string {
  const mins = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}

function syncText(sync: CalendarSyncSummary, now: number): string {
  const when = ago(sync.at, now);
  if (sync.ok) return `Last sync ${when}: ${sync.created} added, ${sync.updated} changed, ${sync.removed} taken off, ${sync.unchanged} already up to date.`;
  if (sync.error === 'google_auth') return `Last sync ${when} failed: Google no longer accepts Onyx's access. Disconnect, then connect again.`;
  if (sync.error === 'calendar_missing') return `Last sync ${when} failed: the calendar Onyx created is gone from Google. Disconnect, then connect again to make a new one.`;
  return `Last sync ${when} did not finish (${sync.failed} item${sync.failed === 1 ? '' : 's'} failed${sync.error ? `, ${sync.error}` : ''}). It is retried on the next change or with Sync now.`;
}

// Google Calendar connection for /health. Not connected is the default and what every failure
// falls back to. The buttons call the owner-session routes under /api/care/google/*; this
// component never talks to Google itself and never holds a token.
export default function CalendarConnectionCard({ initial }: { initial?: CalendarStatus }) {
  const [status, setStatus] = useState<CalendarStatus>(initial ?? NOT_CONNECTED);
  const [busy, setBusy] = useState<'connect' | 'sync' | 'disconnect' | null>(null);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const [now, setNow] = useState(0);

  useEffect(() => {
    setNow(Date.now());
    // Coming back from Google's consent page: say what happened, then tidy the address bar.
    const q = new URLSearchParams(window.location.search);
    const result = q.get('calendar');
    if (!result) return;
    const reason = (q.get('reason') || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 60);
    if (result === 'connected') setMessage({ text: 'Google Calendar is connected. The first sync runs in the background; press Sync now to see its result.' });
    else if (result === 'denied') setMessage({ text: 'The Google sign-in was cancelled. Nothing was connected.' });
    else setMessage({ text: `Could not connect Google Calendar${reason ? ` (${reason})` : ''}. Nothing was connected.`, error: true });
    q.delete('calendar'); q.delete('reason');
    const rest = q.toString();
    window.history.replaceState(null, '', window.location.pathname + (rest ? `?${rest}` : ''));
  }, []);

  async function post(path: string): Promise<unknown> {
    const res = await fetch(path, { method: 'POST' });
    if (!res.ok) throw new Error(String(res.status));
    return res.json();
  }

  async function connect() {
    setBusy('connect'); setMessage(null);
    try {
      const url = ((await post('/api/care/google/start')) as { url?: unknown }).url;
      // Only ever leave for Google's own consent page.
      if (typeof url !== 'string' || !url.startsWith(`${GOOGLE_AUTH_URL}?`)) throw new Error('shape');
      window.location.assign(url);
    } catch {
      setMessage({ text: "Couldn't start the Google sign-in. Nothing was connected.", error: true });
      setBusy(null);
    }
  }

  async function syncNow() {
    setBusy('sync'); setMessage(null);
    try {
      const sync = ((await post('/api/care/google/sync')) as { sync?: CalendarSyncSummary }).sync;
      if (!sync || typeof sync.at !== 'string') throw new Error('shape');
      setNow(Date.now());
      setStatus(cur => ({ ...cur, lastSync: sync }));
    } catch {
      setMessage({ text: "Couldn't run the sync. Your care items in Onyx are unaffected.", error: true });
    } finally {
      setBusy(null);
    }
  }

  async function disconnect() {
    setBusy('disconnect'); setMessage(null);
    try {
      const next = (await post('/api/care/google/disconnect')) as CalendarStatus;
      if (typeof next?.connected !== 'boolean') throw new Error('shape');
      setStatus(next);
      setMessage({ text: `Disconnected. The "${status.calendarName}" calendar and its events are still in Google Calendar; you can remove that calendar there.` });
    } catch {
      setMessage({ text: "Couldn't disconnect. Try again.", error: true });
    } finally {
      setBusy(null);
    }
  }

  return <div className="mt-4 border-t border-border-default pt-3" aria-label="Google Calendar connection">
    <h3 className="text-sm font-semibold">Google Calendar: {status.connected ? 'connected' : 'not connected'}</h3>
    {status.connected
      ? <p className="mt-1 text-sm text-text-secondary">Active care items are copied to the &quot;{status.calendarName}&quot; calendar in your Google account, one way (Onyx to Google). Only the label, date, time and booked state are sent; notes stay in Onyx. Edit items here: changes made in Google Calendar are overwritten.</p>
      : <p className="mt-1 text-sm text-text-secondary">Nothing on this page writes to a calendar. Marking an item booked only records your confirmation here.</p>}
    <p className="mt-2 text-xs font-medium text-text-secondary">{status.connected ? 'The one permission Onyx holds' : 'The one permission a connection asks for'}</p>
    <ul className="mt-1 space-y-1 text-sm">
      <li className="flex flex-wrap justify-between gap-x-3"><span>Create its own calendar (&quot;{status.calendarName}&quot;) and manage the events on it</span><span className={status.connected ? 'text-up' : 'text-text-tertiary'}>{status.connected ? 'Granted' : 'Not granted'}</span></li>
      <li className="flex flex-wrap justify-between gap-x-3"><span>See or change your other calendars, your existing events, or Gmail</span><span className="text-text-tertiary">Never requested</span></li>
    </ul>
    {status.connected && status.lastSync && now > 0 && <p className={`mt-2 text-sm ${status.lastSync.ok ? 'text-text-secondary' : 'text-amber-400'}`}>{syncText(status.lastSync, now)}</p>}
    {status.connected && !status.lastSync && <p className="mt-2 text-sm text-text-secondary">No sync has finished yet.</p>}
    {message && <p role={message.error ? 'alert' : 'status'} className={`mt-2 text-sm ${message.error ? 'text-amber-400' : 'text-text-secondary'}`}>{message.text}</p>}
    {status.connected
      ? <div className="mt-3 flex flex-wrap gap-2">
        <button className={button} disabled={busy !== null} onClick={() => void syncNow()}>{busy === 'sync' ? 'Syncing…' : 'Sync now'}</button>
        <button className={button} disabled={busy !== null} onClick={() => void disconnect()}>{busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}</button>
      </div>
      : <>
        <button className={`${button} mt-3`} disabled={!status.configured || busy !== null} onClick={() => void connect()} aria-describedby="calendar-connect-note">{busy === 'connect' ? 'Opening Google…' : 'Connect Google Calendar'}</button>
        <p id="calendar-connect-note" className="mt-2 text-xs text-text-secondary">{status.configured
          ? 'Opens Google’s consent page. You approve the one permission above, and Google sends you back here.'
          : 'Not set up yet: Onyx has no Google credentials, so nothing can be connected and Google is never contacted. The setup steps are in docs/health-google-calendar.md.'}</p>
      </>}
  </div>;
}
