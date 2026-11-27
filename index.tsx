import { lazy, Suspense } from 'react';
import { defineRwpPlugin, type RwpAdminPageProps } from '../../src/lib/plugin-api';
import manifest from './manifest.json';

/**
 * RWP Developers.
 *
 * What a plugin developer needs on their own site, in one plugin:
 *   - Check: test a plugin ZIP in the browser before installing it (the old Plugin Check).
 *   - Plugins: publish them (ZIP upload or a GitHub release) into your own private Supabase storage.
 *   - Sales / Payments: sell them with your own Stripe or NOWPayments account and licence keys signed with your own key.
 *
 *   - Messages: buyers' questions, support and refund requests from react-wp.com, answered and decided here.
 *
 * The only calls to react-wp.com go over the site's own account link (opt-in): the marketplace listing, sales reported to a
 * buyer's react-wp.com account, revoked keys, and Messages. The admin screens are lazy chunks, so a visitor to the public site
 * downloads none of them, and the shop at /store (or the [rwp_developer_store] shortcode) is its own small chunk.
 */

const DevelopersAdmin = lazy(() => import('./admin/DevelopersAdmin'));
const Store = lazy(() => import('./public/Store'));

const loading = <div style={{ padding: 40, font: '500 15px system-ui', color: '#475569' }} role="status">Loading…</div>;

function AdminScreen(props: RwpAdminPageProps) {
  return <Suspense fallback={loading}><DevelopersAdmin {...props} /></Suspense>;
}

export const developersCleanup = defineRwpPlugin(manifest, ({ admin, routes, shortcodes }) => {
  const cleanups = [
    admin.registerPage({
      id: 'rwp-developers',
      label: 'Developers',
      icon: '🧑‍💻',
      capability: 'manage_options',
      component: AdminScreen,
      submenu: [
        { id: 'plugins', label: 'Your plugins', icon: '📦' },
        { id: 'check', label: 'Plugin Check', icon: '🛡️' },
        { id: 'sales', label: 'Sales & licences', icon: '💳' },
        { id: 'payments', label: 'Payments & key', icon: '⚙️' },
        { id: 'messages', label: 'Messages', icon: '💬' },
      ],
    }),
    routes.register({ path: '/store', component: () => <Suspense fallback={loading}><Store /></Suspense> }),
    shortcodes.register({
      name: 'rwp_developer_store',
      description: 'Your plugin shop: the plugins you sell, a way to pay or claim them, and the signed-in buyer\'s own licences and downloads.',
      example: '[rwp_developer_store title="Plugins" intro="Everything I make."]',
      attributes: [
        { name: 'title', description: 'The heading. Default "Plugins".' },
        { name: 'intro', description: 'A sentence under the heading.' },
      ],
      render: (attributes) => <Suspense fallback={loading}><Store title={attributes.title || 'Plugins'} intro={attributes.intro || ''} /></Suspense>,
    }),
  ];
  return () => cleanups.forEach((cleanup) => cleanup());
});

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    developersCleanup();
  });
}
