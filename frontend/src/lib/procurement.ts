/**
 * Offline planning only. No adapter exists that can spend or change a subscription.
 * Everything here is a pure function over data Riley types in: no network, no storage.
 * Keep this file import-free: frontend/scripts/test-procurement.mjs runs it in a bare VM.
 */
export type Draft = { item: string; merchant: string; totalCents: number; currency: 'USD'; commitment: 'one-time' | 'monthly'; status: 'draft' };
export type Cycle = 'monthly' | 'quarterly' | 'annual';
// id/vendor/notes exist only on rows that came from (or were saved to) the database; hand-typed in-memory rows leave them off.
export type Subscription = { name: string; cents: number; currency: 'USD'; cycle: Cycle; renewsOn: string; id?: number; vendor?: string; notes?: string };
export const CAPABILITIES = Object.freeze({
  providers: 'subscriptions are detected from the finance ledger (read-only; Onyx never cancels or pays anything)',
  orders: 'disabled',
  recommendations: 'reorder suggestions from your own order history (read-only; no product search, no cart, no checkout)',
  tracking: 'typed-by-hand-saved-once-setup-applied',
  reminders: 'calendar-file-you-import-yourself',
} as const);

const CYCLE_MONTHS: Record<Cycle, number> = { monthly: 1, quarterly: 3, annual: 12 };
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
export const MAX_DRAFTS = 20;
export const MAX_SUBSCRIPTIONS = 30;

/* ---------- money ---------- */
function parseUsdCents(amount: string): number {
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(amount)) throw new Error('Enter a positive USD amount with at most two decimal places.');
  const [whole, fraction = ''] = amount.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (cents <= 0) throw new Error('Enter a positive USD amount with at most two decimal places.');
  return cents;
}
export function money(cents: number) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100); }

/* ---------- order drafts ---------- */
export function createDraft(item: string, merchant: string, amount: string, commitment: Draft['commitment']): Draft {
  if (!item.trim() || !merchant.trim() || item.length > 120 || merchant.length > 120) throw new Error('Enter an item and merchant, up to 120 characters each.');
  const totalCents = parseUsdCents(amount);
  if (!['one-time', 'monthly'].includes(commitment)) throw new Error('Check the amount and commitment.');
  return { item: item.trim(), merchant: merchant.trim(), totalCents, currency: 'USD', commitment, status: 'draft' };
}
export function executionReadiness(): { allowed: false; reasons: string[] } {
  // Fail closed regardless of UI state. A draft is never purchase authorization.
  return { allowed: false, reasons: ['No merchant or subscription provider connected.', 'No verified quote, delivery method, cancellation terms or payment method.', 'No server-verified authorization for this exact transaction.'] };
}

/* ---------- dates (plain YYYY-MM-DD strings, UTC arithmetic, no time zones, no Date.now) ---------- */
type Ymd = { y: number; m: number; d: number };
function daysInMonth(y: number, m: number) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }
function isoOf(y: number, m: number, d: number) { return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`; }
export function parseIsoDate(value: string): Ymd | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const y = Number(match[1]), m = Number(match[2]), d = Number(match[3]);
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return { y, m, d };
}
function mustParse(value: string): Ymd {
  const parsed = parseIsoDate(value);
  if (!parsed) throw new Error(`Not a valid date: ${value}`);
  return parsed;
}
export function isoFromLocalDate(date: Date) { return isoOf(date.getFullYear(), date.getMonth() + 1, date.getDate()); }
export function daysBetween(fromIso: string, toIso: string) {
  const a = mustParse(fromIso), b = mustParse(toIso);
  return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86400000);
}
export function addDays(iso: string, days: number) {
  const p = mustParse(iso);
  const moved = new Date(Date.UTC(p.y, p.m - 1, p.d + days));
  return isoOf(moved.getUTCFullYear(), moved.getUTCMonth() + 1, moved.getUTCDate());
}
// Always counted from the original day-of-month, so a Jan 31 monthly bill is Feb 28 then Mar 31 (not Mar 28).
function addMonths(p: Ymd, months: number) {
  const total = p.y * 12 + (p.m - 1) + months;
  const y = Math.floor(total / 12), m = total % 12 + 1;
  return isoOf(y, m, Math.min(p.d, daysInMonth(y, m)));
}
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function formatDate(iso: string) { const p = mustParse(iso); return `${MONTH_NAMES[p.m - 1]} ${p.d}, ${p.y}`; }

/* ---------- subscription tracking ---------- */
export function createSubscription(name: string, amount: string, cycle: string, renewsOn: string): Subscription {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 80 || CONTROL_CHARS.test(trimmed)) throw new Error('Enter a subscription name, up to 80 characters.');
  const cents = parseUsdCents(amount);
  if (!Object.prototype.hasOwnProperty.call(CYCLE_MONTHS, cycle)) throw new Error('Choose monthly, quarterly or annual billing.');
  if (!parseIsoDate(renewsOn)) throw new Error('Enter the next renewal date.');
  return { name: trimmed, cents, currency: 'USD', cycle: cycle as Cycle, renewsOn };
}
export function monthlyEquivalentCents(sub: Pick<Subscription, 'cents' | 'cycle'>) { return Math.round(sub.cents / CYCLE_MONTHS[sub.cycle]); }
export function annualCents(sub: Pick<Subscription, 'cents' | 'cycle'>) { return sub.cents * (12 / CYCLE_MONTHS[sub.cycle]); }
/** First renewal on or after `today`. A date already in the past is rolled forward by whole billing cycles. */
export function nextRenewal(sub: Pick<Subscription, 'cycle' | 'renewsOn'>, today: string): string {
  const anchor = mustParse(sub.renewsOn), now = mustParse(today), step = CYCLE_MONTHS[sub.cycle];
  if (sub.renewsOn >= today) return sub.renewsOn;
  let k = Math.ceil(((now.y - anchor.y) * 12 + (now.m - anchor.m)) / step) * step;
  let candidate = addMonths(anchor, k);
  while (candidate < today) { k += step; candidate = addMonths(anchor, k); }
  return candidate;
}
export type Renewal = { index: number; sub: Subscription; nextOn: string; daysAway: number };
export function summarizeSubscriptions(subs: Subscription[], today: string) {
  const renewals: Renewal[] = subs.map((sub, index) => { const nextOn = nextRenewal(sub, today); return { index, sub, nextOn, daysAway: daysBetween(today, nextOn) }; })
    .sort((a, b) => (a.nextOn < b.nextOn ? -1 : a.nextOn > b.nextOn ? 1 : a.sub.name < b.sub.name ? -1 : a.sub.name > b.sub.name ? 1 : a.index - b.index));
  return {
    count: subs.length,
    monthlyCents: subs.reduce((sum, sub) => sum + monthlyEquivalentCents(sub), 0),
    annualCents: subs.reduce((sum, sub) => sum + annualCents(sub), 0),
    renewals,
  };
}
export function normalizeName(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function when(daysAway: number, nextOn: string) { return daysAway === 0 ? 'today' : daysAway === 1 ? 'tomorrow' : `in ${daysAway} days (${formatDate(nextOn)})`; }
/** Plain-words things worth a look. Derived only from the subscriptions typed in; these are prompts, not product advice. */
export function reviewPrompts(subs: Subscription[], today: string, soonDays = 14): string[] {
  const prompts: string[] = [];
  const summary = summarizeSubscriptions(subs, today);
  for (const r of summary.renewals) if (r.daysAway <= soonDays) prompts.push(`${r.sub.name} renews ${when(r.daysAway, r.nextOn)}. Decide whether to keep, change or cancel it with the provider before then.`);
  const seen = new Map<string, string[]>();
  for (const sub of subs) { const key = normalizeName(sub.name); seen.set(key, [...(seen.get(key) ?? []), sub.name]); }
  for (const names of seen.values()) if (names.length > 1) prompts.push(`"${names[0]}" is tracked ${names.length} times. Check whether you are paying for it twice.`);
  if (subs.length >= 3 && summary.monthlyCents > 0) {
    const biggest = subs.reduce((a, b) => (monthlyEquivalentCents(b) > monthlyEquivalentCents(a) ? b : a));
    const share = Math.round(monthlyEquivalentCents(biggest) * 100 / summary.monthlyCents);
    if (share >= 50) prompts.push(`${biggest.name} is about ${share}% of your tracked monthly spend.`);
  }
  return prompts;
}

/* ---------- order preparation ---------- */
export type MerchantGroup = { merchant: string; items: Draft[]; oneTimeCents: number; monthlyCents: number };
export function groupDrafts(drafts: Draft[]): MerchantGroup[] {
  const groups = new Map<string, MerchantGroup>();
  for (const draft of drafts) {
    const key = normalizeName(draft.merchant);
    const group = groups.get(key) ?? { merchant: draft.merchant, items: [], oneTimeCents: 0, monthlyCents: 0 };
    group.items.push(draft);
    if (draft.commitment === 'monthly') group.monthlyCents += draft.totalCents; else group.oneTimeCents += draft.totalCents;
    groups.set(key, group);
  }
  return [...groups.values()];
}
export function draftTotals(drafts: Draft[]) {
  return drafts.reduce((t, d) => (d.commitment === 'monthly' ? { ...t, monthlyCents: t.monthlyCents + d.totalCents } : { ...t, oneTimeCents: t.oneTimeCents + d.totalCents }), { oneTimeCents: 0, monthlyCents: 0 });
}
/** A recurring draft whose item or merchant matches a tracked subscription is probably a duplicate. */
export function duplicateWarnings(drafts: Draft[], subs: Subscription[]): string[] {
  const tracked = new Map(subs.map(sub => [normalizeName(sub.name), sub.name]));
  const warnings: string[] = [];
  for (const draft of drafts) {
    if (draft.commitment !== 'monthly') continue;
    const hit = tracked.get(normalizeName(draft.item)) ?? tracked.get(normalizeName(draft.merchant));
    if (hit) warnings.push(`"${draft.item}" looks like "${hit}", which you already track. Check before adding a second one.`);
  }
  return warnings;
}
/** Text Riley can copy and use to shop by hand. It states plainly that nothing was ordered. */
export function preparedListText(drafts: Draft[], subs: Subscription[] = []): string {
  const lines = ['Prepared order list (planning only)', 'Nothing has been ordered, submitted or paid for. Review each line and buy it yourself.', 'Check taxes, shipping and fees at the merchant before paying.', ''];
  for (const group of groupDrafts(drafts)) {
    lines.push(group.merchant);
    for (const d of group.items) lines.push(`- ${d.item}: ${money(d.totalCents)}${d.commitment === 'monthly' ? ' / month' : ' one-time'} (estimate)`);
    lines.push('');
  }
  const totals = draftTotals(drafts);
  lines.push(`Estimated one-time total: ${money(totals.oneTimeCents)}`, `Estimated recurring total: ${money(totals.monthlyCents)} / month`);
  const warnings = duplicateWarnings(drafts, subs);
  if (warnings.length) lines.push('', 'Check first:', ...warnings.map(w => `- ${w}`));
  return lines.join('\n');
}

/* ---------- renewal reminders as a calendar file Riley imports himself ---------- */
function utf8Length(codePoint: number) { return codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4; }
// RFC 5545: lines are at most 75 octets; continue a longer line with CRLF + one space.
function foldLine(line: string): string {
  const parts: string[] = []; let current = ''; let bytes = 0;
  for (const ch of line) {
    const size = utf8Length(ch.codePointAt(0) as number);
    if (bytes + size > (parts.length === 0 ? 75 : 74)) { parts.push(current); current = ''; bytes = 0; }
    current += ch; bytes += size;
  }
  parts.push(current);
  return parts.join('\r\n ');
}
function escapeText(value: string) { return value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
function fnv1a(value: string) { let h = 0x811c9dc5; for (let i = 0; i < value.length; i++) { h ^= value.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, '0'); }
const compact = (iso: string) => iso.replace(/-/g, '');
export const REMINDER_LEAD_DAYS = [1, 3, 7, 14] as const;
/**
 * All-day calendar events that remind Riley to review each renewal `leadDays` before it happens.
 * Deterministic for a given input (no clock reads), so the same file imports once, not twice.
 * The file only reminds; it contains no payment details and no instruction that any app could act on.
 */
export function renewalReminderIcs(subs: Subscription[], today: string, leadDays: number): string {
  if (!REMINDER_LEAD_DAYS.includes(leadDays as 1 | 3 | 7 | 14)) throw new Error('Choose 1, 3, 7 or 14 days.');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Onyx//Procurement renewal reminders//EN', 'CALSCALE:GREGORIAN'];
  for (const r of summarizeSubscriptions(subs, today).renewals) {
    const remindOn = addDays(r.nextOn, -leadDays) < today ? today : addDays(r.nextOn, -leadDays);
    const price = `${money(r.sub.cents)} ${r.sub.cycle}`;
    lines.push('BEGIN:VEVENT',
      `UID:${fnv1a(`${r.sub.name}|${r.sub.cycle}|${r.sub.cents}|${r.nextOn}`)}@onyx-procurement.invalid`,
      `DTSTAMP:${compact(today)}T000000Z`,
      `DTSTART;VALUE=DATE:${compact(remindOn)}`,
      `DTEND;VALUE=DATE:${compact(addDays(remindOn, 1))}`,
      `SUMMARY:${escapeText(`Review renewal: ${r.sub.name}`)}`,
      `DESCRIPTION:${escapeText(`${r.sub.name} (${price}) renews on ${formatDate(r.nextOn)}. Decide whether to keep, change or cancel it with the provider. This reminder cannot change or pay for anything.`)}`,
      'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

/* ---------- synthetic examples ---------- */
export const EXAMPLES = [
  { name: 'Demo workspace subscription', monthlyCents: 1800, note: 'Example only: check unused seats before the next renewal.' },
  { name: 'Demo storage subscription', monthlyCents: 600, note: 'Example only: compare storage usage before changing plans.' },
];
/** Clearly fake subscriptions with dates relative to `today`, for trying the tracker without typing anything real. */
export function syntheticSubscriptions(today: string): Subscription[] {
  return [
    createSubscription('Demo streaming service', '15.99', 'monthly', addDays(today, 5)),
    createSubscription('Demo news bundle', '12.00', 'monthly', addDays(today, 12)),
    createSubscription('Demo cloud backup', '59.88', 'annual', addDays(today, 45)),
    createSubscription('Demo gym pass', '90.00', 'quarterly', addDays(today, 30)),
  ];
}

/* ---------- saving (pure helpers; the database calls live in procurement-store.ts) ---------- */
export const PROCUREMENT_TABLE = 'procurement_subscriptions';
export const MAX_VENDOR_LENGTH = 80;
export const MAX_NOTES_LENGTH = 500;
const NOTE_CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
export type SubscriptionDetails = Subscription & { vendor: string; notes: string };
export type SubscriptionRow = {
  subscription_id: number; name: string; vendor: string | null; amount_cents: number; currency: string;
  cadence: string; next_renewal: string; notes: string | null; is_active: boolean;
};
/** Validate a request body from the browser with the same rules as the form, plus optional vendor and notes. */
export function parseSubscriptionInput(body: unknown): SubscriptionDetails {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Send the subscription as a JSON object.');
  const b = body as Record<string, unknown>;
  for (const key of ['name', 'amount', 'cycle', 'renewsOn']) if (typeof b[key] !== 'string') throw new Error(`Missing ${key}.`);
  for (const key of ['vendor', 'notes']) if (b[key] !== undefined && b[key] !== null && typeof b[key] !== 'string') throw new Error(`${key} must be text.`);
  const sub = createSubscription(b.name as string, b.amount as string, b.cycle as string, b.renewsOn as string);
  const vendor = ((b.vendor as string | null | undefined) ?? '').trim(), notes = ((b.notes as string | null | undefined) ?? '').trim();
  if (vendor.length > MAX_VENDOR_LENGTH || CONTROL_CHARS.test(vendor)) throw new Error(`Vendor can be up to ${MAX_VENDOR_LENGTH} characters.`);
  if (notes.length > MAX_NOTES_LENGTH || NOTE_CONTROL_CHARS.test(notes)) throw new Error(`Notes can be up to ${MAX_NOTES_LENGTH} characters.`);
  return { ...sub, vendor, notes };
}
export function subscriptionToRow(sub: SubscriptionDetails) {
  return { name: sub.name, vendor: sub.vendor || null, amount_cents: sub.cents, currency: 'USD', cadence: sub.cycle, next_renewal: sub.renewsOn, notes: sub.notes || null };
}
/** Database row back to the shape the page uses. Returns null for a row that fails the same checks (never throws, never shown half-valid). */
export function subscriptionFromRow(row: Partial<SubscriptionRow> | null | undefined): Subscription | null {
  if (!row || typeof row.subscription_id !== 'number' || typeof row.name !== 'string' || !row.name.trim()) return null;
  if (typeof row.amount_cents !== 'number' || !Number.isInteger(row.amount_cents) || row.amount_cents <= 0) return null;
  if (typeof row.cadence !== 'string' || !Object.prototype.hasOwnProperty.call(CYCLE_MONTHS, row.cadence)) return null;
  if (typeof row.next_renewal !== 'string' || !parseIsoDate(row.next_renewal)) return null;
  const sub: Subscription = { id: row.subscription_id, name: row.name, cents: row.amount_cents, currency: 'USD', cycle: row.cadence as Cycle, renewsOn: row.next_renewal };
  if (row.vendor) sub.vendor = row.vendor;
  if (row.notes) sub.notes = row.notes;
  return sub;
}
/** A row id from a URL segment: digits only, a safe positive integer, or null. */
export function parseRowId(value: string): number | null {
  if (!/^\d{1,15}$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
/** True when the table has not been created yet (PostgREST PGRST205 or Postgres 42P01). Any other error is a real failure. */
export function isMissingTableError(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false;
  const code = error.code ?? '', message = error.message ?? '';
  if (code === 'PGRST205' || code === '42P01') return true;
  return message.includes(PROCUREMENT_TABLE) && /schema cache|does not exist|could not find the table/i.test(message);
}
