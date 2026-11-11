/** Offline planning only. No adapter exists that can spend or change a subscription. */
export type Draft = { item: string; merchant: string; totalCents: number; currency: 'USD'; commitment: 'one-time' | 'monthly'; status: 'draft' };
export const CAPABILITIES = Object.freeze({ subscriptions: 'disconnected', orders: 'disabled', recommendations: 'examples-only' } as const);
export function createDraft(item: string, merchant: string, amount: string, commitment: Draft['commitment']): Draft {
  if (!item.trim() || !merchant.trim() || item.length > 120 || merchant.length > 120) throw new Error('Enter an item and merchant, up to 120 characters each.');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(amount)) throw new Error('Enter a positive USD amount with at most two decimal places.');
  const [whole, fraction = ''] = amount.split('.');
  const totalCents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (totalCents <= 0 || !['one-time', 'monthly'].includes(commitment)) throw new Error('Check the amount and commitment.');
  return { item: item.trim(), merchant: merchant.trim(), totalCents, currency: 'USD', commitment, status: 'draft' };
}
export function executionReadiness(): { allowed: false; reasons: string[] } {
  // Fail closed regardless of UI state. A draft is never purchase authorization.
  return { allowed: false, reasons: ['No merchant or subscription provider connected.', 'No verified quote, delivery method, cancellation terms or payment method.', 'No server-verified authorization for this exact transaction.'] };
}
export const EXAMPLES = [
  { name: 'Demo workspace subscription', monthlyCents: 1800, note: 'Example only: check unused seats before the next renewal.' },
  { name: 'Demo storage subscription', monthlyCents: 600, note: 'Example only: compare storage usage before changing plans.' },
];
export function money(cents: number) { return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100); }
