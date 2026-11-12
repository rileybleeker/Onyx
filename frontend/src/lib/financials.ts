/** Pure, offline finance import. No account access, persistence, or network. */
export type Mapping = { date: number; description: number; amount: number; category: number; kind: number };
export type Transaction = { date: string; description: string; cents: number; category: string; transfer: boolean };
export const MAX_BYTES = 2_000_000;
export function parseCsv(text: string): string[][] {
  if (new TextEncoder().encode(text).length > MAX_BYTES) throw new Error('CSV must be smaller than 2 MB.');
  const rows: string[][] = []; let row: string[] = [], field = '', quoted = false, closed = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) { if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; } } else field += c; }
    else if (c === '"') { if (field || closed) throw new Error('Unexpected quote in CSV.'); quoted = true; }
    else if (c === ',' || c === '\n' || c === '\r') {
      row.push(field.trim()); field = ''; closed = false;
      if (c !== ',') { if (row.some(Boolean)) rows.push(row); row = []; if (c === '\r' && text[i + 1] === '\n') i++; }
    } else { if (closed && c.trim()) throw new Error('Unexpected text after closing quote.'); if (!closed) field += c; }
  }
  if (quoted) throw new Error('CSV has an unclosed quote.');
  row.push(field.trim()); if (row.some(Boolean)) rows.push(row);
  if (rows.length < 2 || rows.length > 10001) throw new Error('Choose a CSV with a header and 1–10,000 transactions.');
  const width = rows[0].length;
  if (width > 100) throw new Error('CSV supports at most 100 columns.');
  if (rows.some(r => r.length !== width)) throw new Error('CSV rows must have the same number of columns.');
  return rows;
}
export function defaultMapping(headers: string[]): Mapping {
  const find = (names: string[]) => headers.findIndex(h => names.includes(h.toLowerCase().trim()));
  return { date: find(['date', 'transaction date']), description: find(['name', 'description', 'merchant', 'original description']), amount: find(['amount']), category: find(['category']), kind: find(['transaction type', 'type']) };
}
export function parseDate(value: string, format: 'iso' | 'us'): string {
  const match = format === 'iso' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value);
  if (!match) throw new Error('Date does not match the selected format.');
  const [y, m, d] = format === 'iso' ? match.slice(1).map(Number) : [Number(match[3]), Number(match[1]), Number(match[2])];
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (y < 1900 || y > 2100 || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) throw new Error('Invalid calendar date.');
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
export function parseCents(value: string): number {
  if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(value)) throw new Error('Amount must be a signed number with at most two decimals (no currency symbol).');
  const negative = value.startsWith('-'); const [whole, fraction = ''] = value.replace(/[-,]/g, '').split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents > 1_000_000_000) throw new Error('Amount is outside the supported range.');
  return negative ? -cents : cents;
}
export function preview(rows: string[][], mapping: Mapping, expensePositive: boolean, format: 'iso' | 'us') {
  const required = [mapping.date, mapping.description, mapping.amount];
  if (required.some(i => i < 0 || i >= rows[0].length) || new Set(required).size !== 3) throw new Error('Choose three distinct date, description, and amount columns.');
  const transactions: Transaction[] = [], errors: string[] = [];
  rows.slice(1).forEach((r, i) => {
    try {
      const date = parseDate(r[mapping.date], format), amount = parseCents(r[mapping.amount]);
      const description = r[mapping.description]; if (!description) throw new Error('Description is empty.');
      const category = mapping.category < 0 ? 'Uncategorized' : r[mapping.category] || 'Uncategorized';
      const kind = mapping.kind < 0 ? '' : r[mapping.kind].toLowerCase();
      transactions.push({ date, description, cents: expensePositive ? -amount : amount, category, transfer: kind === 'transfer' });
    } catch (error) { errors.push(`Row ${i + 2}: ${error instanceof Error ? error.message : 'Invalid row.'}`); }
  });
  return { transactions, errors };
}
export function summarize(rows: Transaction[], excluded: string[]) {
  const included = rows.filter(r => !r.transfer && !excluded.includes(r.category));
  const income = included.reduce((n, r) => n + Math.max(r.cents, 0), 0);
  const spending = included.reduce((n, r) => n + Math.max(-r.cents, 0), 0);
  const categories: Record<string, number> = Object.create(null);
  included.filter(r => r.cents < 0).forEach(r => { categories[r.category] = (categories[r.category] || 0) - r.cents; });
  return { income, spending, net: income - spending, categories, excludedCount: rows.length - included.length };
}
