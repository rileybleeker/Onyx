export type CareItem = { id: string; title: string; due: string; months: number; booked: boolean; archived: boolean };
export const STORAGE_KEY = 'onyx-care-planner-v1';
export function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}
export function todayLocal(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
export function nextDue(date: string, months: number): string {
  if (!validDate(date) || !Number.isInteger(months) || months < 1 || months > 120) throw new Error('Invalid recurrence');
  const [year, month, day] = date.split('-').map(Number);
  const result = new Date(Date.UTC(year, month - 1 + months, 1, 12));
  const last = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, last));
  return result.toISOString().slice(0, 10);
}
export function parseItems(raw: string): CareItem[] {
  const value: unknown = JSON.parse(raw);
  if (!Array.isArray(value) || value.length > 500) throw new Error('Invalid saved planner');
  const ids = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item.id !== 'string' || ids.has(item.id) || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 100 || typeof item.due !== 'string' || !validDate(item.due) || !Number.isInteger(item.months) || ![0, 1, 3, 6, 12, 24].includes(item.months) || typeof item.booked !== 'boolean' || typeof item.archived !== 'boolean') throw new Error('Invalid saved planner');
    ids.add(item.id);
    return { id: item.id, title: item.title, due: item.due, months: item.months, booked: item.booked, archived: item.archived };
  });
}
