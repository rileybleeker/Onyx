import type { Metadata } from 'next';
import FinancialsClient from './FinancialsClient';
export const metadata: Metadata = { title: 'Financials - Onyx' };
export default function FinancialsPage() { return <FinancialsClient />; }
