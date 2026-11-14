import { lazy, Suspense } from 'react';
import type { RwpAdminPageProps } from '../../../src/lib/plugin-api';
import ProductsAdmin from './ProductsAdmin';
import SalesAdmin from './SalesAdmin';
import PaymentsAdmin from './PaymentsAdmin';

// Plugin Check carries the name tables and, when a check runs, the TypeScript compiler, so it is its own chunk.
const PluginCheckAdmin = lazy(() => import('../check/admin/PluginCheckAdmin'));

/** The Developers screen: the section is chosen from the admin sidebar submenu. */
export default function DevelopersAdmin(props: RwpAdminPageProps) {
  const section = props.subsection || 'plugins';
  if (section === 'check') {
    return <Suspense fallback={<div role="status" style={{ padding: 40 }}>Loading…</div>}><PluginCheckAdmin {...props} /></Suspense>;
  }
  if (section === 'sales') return <SalesAdmin />;
  if (section === 'payments') return <PaymentsAdmin />;
  return <ProductsAdmin />;
}
