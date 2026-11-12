import { CALENDAR_CONNECTION } from '@/lib/care-planner';

// Read-only status card. There is no sign-in, token or calendar access behind it.
export default function CalendarConnectionCard() {
  const connection = CALENDAR_CONNECTION;
  return <div className="mt-4 border-t border-border-default pt-3" aria-label={`${connection.provider} connection`}>
    <h3 className="text-sm font-semibold">{connection.provider}: {connection.statusLabel.toLowerCase()}</h3>
    <p className="mt-1 text-sm text-text-secondary">Nothing on this page reads from or writes to a calendar. Marking an item booked only records your confirmation here.</p>
    <p className="mt-2 text-xs font-medium text-text-secondary">Permissions a future connection would ask for</p>
    <ul className="mt-1 space-y-1 text-sm">{connection.permissions.map(permission => <li key={permission.id} className="flex flex-wrap justify-between gap-x-3"><span>{permission.label}</span><span className={permission.granted ? 'text-up' : 'text-text-tertiary'}>{permission.granted ? 'Granted' : 'Not granted'}</span></li>)}</ul>
    <button className="mt-3 rounded-lg border border-border-default px-3 py-2 text-sm opacity-50" disabled={!connection.canConnect} aria-describedby="calendar-connect-note">Connect {connection.provider}</button>
    <p id="calendar-connect-note" className="mt-2 text-xs text-text-secondary">Not available yet. Connecting needs an approved sign-in, a calendar you pick, and safe token storage. You will be asked for permission at that point, never before.</p>
  </div>;
}
