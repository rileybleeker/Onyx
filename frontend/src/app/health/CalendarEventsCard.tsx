import { CALENDAR_SOURCE_LABEL, readConnection, type CalendarReadStatus } from '@/lib/calendar-events';
import { ageLabel } from '@/lib/urgent-email';
import type { CalendarView } from './useCalendarEvents';

// Heading word for each state. "connected" is what Riley looks for: the hourly read sync is the
// Google Calendar connection; the card below it (copying care items INTO Google) is optional.
const HEADING: Record<CalendarReadStatus, string> = {
  checking: 'checking',
  synced: 'connected',
  late: 'connected',
  failing: 'sync failing',
  'not-synced': 'not synced yet',
  unavailable: "couldn't be checked",
};

const TONE: Record<CalendarReadStatus, string> = {
  checking: 'text-text-secondary',
  synced: 'text-up',
  late: 'text-mid',
  failing: 'text-down',
  'not-synced': 'text-text-secondary',
  unavailable: 'text-mid',
};

// Read-only status of the hourly calendar sync (google_calendar_etl.py, calendar -> Onyx): the
// events it copied are what the Month and Agenda views show next to the care items. This is NOT
// the optional card below it (care items -> a calendar Onyx created): nothing here signs in to
// Google, holds a token, or writes anywhere, so there is no button.
export default function CalendarEventsCard({ calendar }: { calendar: CalendarView }) {
  const now = new Date();
  const connection = readConnection(calendar.state, calendar.lastSync, now.getTime());
  const calendars = calendar.calendars ?? [];
  const total = calendars.reduce((sum, c) => sum + c.events, 0);
  const hasData = calendar.state === 'ready' && connection.status !== 'not-synced';
  return <div className="mt-4 border-t border-border-default pt-3" aria-label="Calendar events sync">
    <h3 className="text-sm font-semibold">Google Calendar: <span className={TONE[connection.status]}>{HEADING[connection.status]}</span></h3>
    <p className="mt-1 text-sm text-text-secondary" role={connection.status === 'checking' ? 'status' : undefined}>{connection.detail}</p>
    {calendar.stale && <p className="mt-1 text-sm text-amber-300">Couldn&apos;t refresh the calendar events. Showing the ones from the last check.</p>}
    {hasData && <>
      {calendars.length > 0
        ? <ul className="mt-2 space-y-1 text-sm" aria-label="Synced calendars">{calendars.map(c => <li key={`${c.account}/${c.calendar}`} className="flex flex-wrap justify-between gap-x-3"><span className="break-words">{c.calendar} <span className="text-text-tertiary">({c.account})</span></span><span className="text-text-secondary">{c.events} event{c.events === 1 ? '' : 's'}</span></li>)}</ul>
        : calendar.calendars && <p className="mt-2 text-sm text-text-secondary">No events are stored yet.</p>}
      {calendars.length > 1 && <p className="mt-1 text-xs text-text-secondary">{total} events in all, from about 13 months back to 13 months ahead.</p>}
    </>}
    {calendar.lastSync && <p className={`mt-2 text-xs ${connection.status === 'failing' || connection.status === 'late' ? 'text-amber-300' : 'text-text-secondary'}`}>Last sync {ageLabel(calendar.lastSync.at, now)}{calendar.lastSync.status !== 'success' ? ` (that run: ${calendar.lastSync.status})` : ''}.{calendar.lastSync.error && calendar.lastSync.status !== 'success' ? ` ${calendar.lastSync.error}` : ''}</p>}
    {calendar.truncated && <p className="mt-1 text-xs text-amber-300">This month has more events than one request returns, so some are not shown.</p>}
    <p className="mt-2 text-xs text-text-secondary">One way only, {CALENDAR_SOURCE_LABEL} to Onyx: Onyx copies each event&apos;s title, time, location and calendar name from your calendars&apos; private iCal addresses about once an hour. It does not copy descriptions, guests or meeting links, and this sync cannot change your calendars or turn a care item into a calendar event.</p>
  </div>;
}
