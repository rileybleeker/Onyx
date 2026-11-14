import type { Metadata } from 'next';
import { loadDocuments, loadLabs, type Section } from '@/lib/medical-records-server';
import type { LabResult, MedicalDocument } from '@/lib/medical-records';
import RecordsClient from './RecordsClient';

// Medical records, read with the service role: rendered per request, never ISR, never cached or
// prerendered, never indexed. Same pattern as /health and /financials. The browser never queries
// the tables or the bucket; it goes through /api/medical/* behind the owner session.
export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Medical records - Onyx', robots: { index: false, follow: false } };

export default async function MedicalRecordsPage() {
  const [documents, labs] = await Promise.all([
    loadDocuments().catch((): Section<MedicalDocument> => ({ state: 'error' })),
    loadLabs().catch((): Section<LabResult> => ({ state: 'error' })),
  ]);
  return <RecordsClient documents={documents} labs={labs} />;
}
