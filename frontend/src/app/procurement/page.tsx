import type { Metadata } from 'next';
import { loadDetectedSubscriptions } from '@/lib/procurement-recurring-server';
import { loadSubscriptionAdvice } from '@/lib/procurement-flags-server';
import ProcurementClient from './ProcurementClient';
// Private financial data: rendered per request on the server, never ISR, never cached (same rule as /financials).
export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Procurement - Onyx', robots: { index: false, follow: false } };
export default async function ProcurementPage() {
  const detected = await loadDetectedSubscriptions();
  // Waste flags (price increase, possible duplicate, no recent iPhone use) for what was detected. Rule-based, server-side.
  const advice = detected.state === 'ok' ? await loadSubscriptionAdvice(detected.subs) : null;
  return <ProcurementClient detected={detected} advice={advice} />;
}
