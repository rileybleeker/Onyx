import type { Metadata } from 'next';
import ProcurementClient from './ProcurementClient';
export const metadata: Metadata = { title: 'Procurement - Onyx' };
export default function ProcurementPage() { return <ProcurementClient />; }
