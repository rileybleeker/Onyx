"use client";
import { useEffect, useRef, useState } from 'react';
import { readCalendarResponse, type CalendarCount, type CalendarEvent, type CalendarSync } from '@/lib/calendar-events';

export type CalendarRange = { start: string; end: string };
export type CalendarView = {
  state: 'loading' | 'ready' | 'not_connected' | 'error';
  events: CalendarEvent[];
  lastSync: CalendarSync | null;
  truncated: boolean;
  calendars: CalendarCount[] | null;
  // True when the newest request failed and `events` are from an earlier answer.
  stale: boolean;
};

const EMPTY: CalendarView = { state: 'loading', events: [], lastSync: null, truncated: false, calendars: null, stale: false };

// Reads the synced calendar events for the visible range from GET /api/calendar/events (owner
// session, no-store). Read-only. A slower answer for an older month can never replace a newer
// one, and a failed refresh keeps the last events with `stale` set.
export function useCalendarEvents(range: CalendarRange | null): CalendarView {
  const [view, setView] = useState<CalendarView>(EMPTY);
  const sequence = useRef(0);
  const start = range?.start ?? '';
  const end = range?.end ?? '';
  useEffect(() => {
    if (!start || !end) return;
    const current = ++sequence.current;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    fetch(`/api/calendar/events?${new URLSearchParams({ from: start, to: end, summary: '1' })}`, { cache: 'no-store', signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error('Calendar unavailable');
        return readCalendarResponse(await res.json());
      })
      .then((data) => {
        if (sequence.current !== current) return;
        setView(data.status === 'not_connected'
          ? { ...EMPTY, state: 'not_connected', lastSync: data.lastSync ?? null }
          : { state: 'ready', events: data.events, lastSync: data.lastSync ?? null, truncated: data.truncated === true, calendars: data.calendars ?? null, stale: false });
      })
      .catch(() => {
        if (sequence.current !== current) return;
        setView((previous) => previous.state === 'ready' ? { ...previous, stale: true } : { ...EMPTY, state: 'error' });
      })
      .finally(() => clearTimeout(timer));
    return () => { clearTimeout(timer); controller.abort(); };
  }, [start, end]);
  return view;
}
