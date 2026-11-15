import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import { layoutCookieName, layoutFromCookie } from '@/lib/personalize-layout';
import { NOT_CONNECTED } from '@/lib/care-google';
import { calendarStatus } from '@/lib/care-google-server';
import { loadCareItems, type CareLoad } from '@/lib/care-items-server';
import HealthClient from './HealthClient';

// Private data read with the service role: rendered per request, never cached or prerendered.
export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Health & appointments - Onyx', robots: { index: false, follow: false } };

export default async function HealthPage() {
  // The calendar status makes no Google call, and no database call until credentials exist.
  const [initial, calendar] = await Promise.all([
    loadCareItems().catch((): CareLoad => ({ state: 'error' })),
    calendarStatus().catch(() => NOT_CONNECTED),
  ]);
  // Personalize: the saved layout rides in a cookie scoped to this page, so the server renders it as is.
  const layout = layoutFromCookie((await cookies()).get(layoutCookieName('/health'))?.value);
  return <HealthClient initial={initial} calendar={calendar} layout={layout} />;
}
