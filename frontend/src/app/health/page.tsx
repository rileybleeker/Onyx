import type { Metadata } from 'next';
import { loadCareItems, type CareLoad } from '@/lib/care-items-server';
import HealthClient from './HealthClient';

// Private data read with the service role: rendered per request, never cached or prerendered.
export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Health & appointments - Onyx', robots: { index: false, follow: false } };

export default async function HealthPage() {
  let initial: CareLoad;
  try {
    initial = await loadCareItems();
  } catch {
    initial = { state: 'error' };
  }
  return <HealthClient initial={initial} />;
}
