import type { Metadata } from 'next';
import './globals.css';
import './workflows.css';
import './enhancements.css';
import './invoice-polish.css';
import { StoreProvider } from '@/components/store';
import Shell from '@/components/shell';
export const metadata: Metadata = { title: 'Billing Software', description: 'Multi-tenant print billing with customers, products, services, invoices, receipts and reports.' };
export default function RootLayout({ children }: { children: React.ReactNode }) { return <html lang="en"><body><StoreProvider><Shell>{children}</Shell></StoreProvider></body></html>; }

