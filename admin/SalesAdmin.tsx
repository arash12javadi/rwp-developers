import { useCallback, useEffect, useState } from 'react';
import { clearLicenseDomain, listLicenses, listOrders, setLicenseStatus } from '../lib/api';
import type { DevLicense, DevOrder } from '../lib/types';
import styles from '../developers.module.css';

const errorText = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);
const when = (value: string | null) => (value ? new Date(value).toLocaleString() : '—');
const PROVIDERS: Record<string, string> = { stripe: 'Stripe', nowpayments: 'NOWPayments', free: 'Free' };

/** Developers → Sales: every order, and every licence with the two things an owner may do to one. */
export default function SalesAdmin() {
  const [tab, setTab] = useState<'orders' | 'licenses'>('orders');
  const [orders, setOrders] = useState<DevOrder[] | null>(null);
  const [licenses, setLicenses] = useState<DevLicense[] | null>(null);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => {
    listOrders().then(setOrders).catch((loadError: unknown) => { setOrders([]); setError(errorText(loadError, 'Could not load the orders.')); });
    listLicenses().then(setLicenses).catch((loadError: unknown) => { setLicenses([]); setError(errorText(loadError, 'Could not load the licences.')); });
  }, []);
  useEffect(() => { load(); }, [load]);

  const act = async (id: string, run: () => Promise<void>, done: string) => {
    setBusy(id);
    setError('');
    setMessage('');
    try {
      await run();
      setMessage(done);
      load();
    } catch (actionError) {
      setError(errorText(actionError, 'That could not be done.'));
    } finally {
      setBusy('');
    }
  };

  const revenue = (orders || []).filter((order) => order.status === 'paid').reduce((sum, order) => sum + Number(order.amount), 0);
  const paidCount = (orders || []).filter((order) => order.status === 'paid').length;

  return (
    <div className={styles.wrap}>
      <h2 className={styles.title}>Sales &amp; licences</h2>
      <p className={styles.subtitle}>
        {paidCount} paid order{paidCount === 1 ? '' : 's'}, ${revenue.toFixed(2)} in total. Money goes straight to your own Stripe or NOWPayments account;
        this list is your record of it.
      </p>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {message && <p className={styles.notice} role="status">{message}</p>}
      <div className={styles.tabs}>
        <button type="button" className={tab === 'orders' ? styles.button : `${styles.button} ${styles.ghost}`} onClick={() => setTab('orders')}>Orders</button>
        <button type="button" className={tab === 'licenses' ? styles.button : `${styles.button} ${styles.ghost}`} onClick={() => setTab('licenses')}>Licences</button>
      </div>

      {tab === 'orders' && (!orders ? <p className={styles.muted}>Loading…</p> : !orders.length ? <p className={styles.hint}>No orders yet.</p> : (
        <div className={styles.panel}><div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr><th>Date</th><th>Plugin</th><th>Method</th><th>Amount</th><th>Status</th></tr></thead>
            <tbody>
              {orders.map((order) => (
                <tr key={order.id}>
                  <td>{when(order.paid_at || order.created_at)}</td>
                  <td>{order.dev_products?.title || '—'}</td>
                  <td>{PROVIDERS[order.provider] || order.provider}</td>
                  <td>${Number(order.amount).toFixed(2)}</td>
                  <td><span className={`${styles.badge} ${styles[order.status]}`}>{order.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div></div>
      ))}

      {tab === 'licenses' && (!licenses ? <p className={styles.muted}>Loading…</p> : !licenses.length ? <p className={styles.hint}>No licences yet.</p> : (
        <div className={styles.panel}><div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr><th>Issued</th><th>Plugin</th><th>Serial</th><th>Site</th><th>Expires</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {licenses.map((license) => (
                <tr key={license.id}>
                  <td>{when(license.created_at)}</td>
                  <td>{license.dev_products?.title || '—'}</td>
                  <td><code>{license.serial}</code></td>
                  <td>{license.domain || <span className={styles.muted}>not used yet</span>}</td>
                  <td>{license.expires_at ? when(license.expires_at) : 'Never'}</td>
                  <td><span className={`${styles.badge} ${styles[license.status]}`}>{license.status}</span></td>
                  <td>
                    {license.status === 'active' ? (
                      <button type="button" className={`${styles.button} ${styles.danger}`} disabled={busy !== ''}
                        onClick={() => act(license.id, () => setLicenseStatus(license.id, true), 'The licence was revoked: its key stops verifying and downloading.')}>Revoke</button>
                    ) : (
                      <button type="button" className={`${styles.button} ${styles.ghost}`} disabled={busy !== ''}
                        onClick={() => act(license.id, () => setLicenseStatus(license.id, false), 'The licence is active again.')}>Restore</button>
                    )}{' '}
                    {license.domain && (
                      <button type="button" className={`${styles.button} ${styles.ghost}`} disabled={busy !== ''}
                        onClick={() => act(license.id, () => clearLicenseDomain(license.id), 'The site was released: the key can be used on a new site.')}>Release site</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div></div>
      ))}
    </div>
  );
}
