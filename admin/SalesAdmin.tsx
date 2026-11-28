import { Fragment, useCallback, useEffect, useState } from 'react';
import { clearLicenseDomain, listLicenses, listOrders, ownerRefunds, setLicenseStatus } from '../lib/api';
import type { DevLicense, DevOrder, DevRefund } from '../lib/types';
import BuyerMessage from './BuyerMessage';
import RefundsPanel, { OrderRefundForm } from './RefundsPanel';
import styles from '../developers.module.css';

const errorText = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);
const when = (value: string | null) => (value ? new Date(value).toLocaleString() : '—');
// Payment methods plugins add are shown by name too; anything else shows its id.
const PROVIDERS: Record<string, string> = {
  stripe: 'Stripe', nowpayments: 'NOWPayments', free: 'Free', paypal: 'PayPal', mollie: 'Mollie', gocardless: 'GoCardless',
};

/** Developers → Sales: every order, and every licence with the two things an owner may do to one. */
export default function SalesAdmin() {
  const [tab, setTab] = useState<'orders' | 'licenses' | 'refunds'>('orders');
  const [refunding, setRefunding] = useState('');
  const [contacting, setContacting] = useState('');
  const [refunds, setRefunds] = useState<DevRefund[]>([]);
  const [orders, setOrders] = useState<DevOrder[] | null>(null);
  const [licenses, setLicenses] = useState<DevLicense[] | null>(null);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(() => {
    listOrders().then(setOrders).catch((loadError: unknown) => { setOrders([]); setError(errorText(loadError, 'Could not load the orders.')); });
    listLicenses().then(setLicenses).catch((loadError: unknown) => { setLicenses([]); setError(errorText(loadError, 'Could not load the licences.')); });
    // Open refund requests are marked on their order; if they cannot be read, the orders still show.
    ownerRefunds().then(setRefunds).catch(() => setRefunds([]));
  }, []);
  const openRequest = useCallback((orderId: string) => refunds.find((row) => row.order_id === orderId && ['requested', 'approved', 'processing'].includes(row.status)) || null, [refunds]);
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

  // Net of refunds: a fully refunded order adds nothing, a partly refunded one what was kept.
  const kept = (orders || []).filter((order) => order.status === 'paid' || order.status === 'refunded');
  const revenue = kept.reduce((sum, order) => sum + Number(order.amount) - Number(order.refunded_amount || 0), 0);
  const refunded = kept.reduce((sum, order) => sum + Number(order.refunded_amount || 0), 0);
  const paidCount = (orders || []).filter((order) => order.status === 'paid').length;

  return (
    <div className={styles.wrap}>
      <h2 className={styles.title}>Sales &amp; licences</h2>
      <p className={styles.subtitle}>
        {paidCount} paid order{paidCount === 1 ? '' : 's'}, ${revenue.toFixed(2)} in total after ${refunded.toFixed(2)} of refunds. Money goes straight to
        your own payment account (Stripe, NOWPayments, PayPal…); this list is your record of it.
      </p>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {message && <p className={styles.notice} role="status">{message}</p>}
      <div className={styles.tabs}>
        <button type="button" className={tab === 'orders' ? styles.button : `${styles.button} ${styles.ghost}`} onClick={() => setTab('orders')}>Orders</button>
        <button type="button" className={tab === 'licenses' ? styles.button : `${styles.button} ${styles.ghost}`} onClick={() => setTab('licenses')}>Licences</button>
        <button type="button" className={tab === 'refunds' ? styles.button : `${styles.button} ${styles.ghost}`} onClick={() => setTab('refunds')}>Refunds</button>
      </div>

      {tab === 'refunds' && <RefundsPanel onChanged={load} />}

      {tab === 'orders' && (!orders ? <p className={styles.muted}>Loading…</p> : !orders.length ? <p className={styles.hint}>No orders yet.</p> : (
        <div className={styles.panel}><div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr><th>Date</th><th>Plugin</th><th>Buyer</th><th>Method</th><th>Amount</th><th>Status</th><th /></tr></thead>
            <tbody>
              {orders.map((order) => {
                const request = openRequest(order.id);
                return (
                <Fragment key={order.id}>
                <tr>
                  <td>{when(order.paid_at || order.created_at)}</td>
                  <td>{order.dev_products?.title || '—'}</td>
                  <td>
                    <button type="button" className={`${styles.button} ${styles.ghost}`} aria-expanded={contacting === order.id}
                      onClick={() => setContacting(contacting === order.id ? '' : order.id)}>
                      {contacting === order.id ? 'Close' : 'Contact buyer'}
                    </button>
                    <br />
                    <span className={styles.muted}>
                      {order.platform_reported_at && !order.platform_error ? 'On their react-wp.com account' : order.platform_error ? `react-wp.com: ${order.platform_error}` : order.status === 'paid' ? 'Not reported to react-wp.com yet (sent when you open Developers)' : ''}
                    </span>
                  </td>
                  <td>{PROVIDERS[order.provider] || order.provider}</td>
                  <td>${Number(order.amount).toFixed(2)}{Number(order.refunded_amount || 0) > 0 ? <><br /><span className={styles.muted}>${Number(order.refunded_amount).toFixed(2)} refunded</span></> : null}</td>
                  <td>
                    <span className={`${styles.badge} ${styles[order.status]}`}>{order.status}</span>
                    {request && (
                      <><br /><button type="button" className={`${styles.button} ${styles.ghost}`} onClick={() => setTab('refunds')}>
                        {request.status === 'requested' ? 'Refund requested: answer it' : 'Refund approved, not sent: open'}
                      </button></>
                    )}
                  </td>
                  <td>
                    {order.status === 'paid' && Number(order.amount) - Number(order.refunded_amount || 0) > 0 && (refunding === order.id
                      ? <OrderRefundForm order={order} onClose={() => setRefunding('')} onDone={(text) => { setMessage(text); load(); }} />
                      : <button type="button" className={`${styles.button} ${styles.ghost}`} disabled={busy !== ''} onClick={() => setRefunding(order.id)}>Refund…</button>)}
                  </td>
                </tr>
                {contacting === order.id && (
                  <tr><td colSpan={7}>
                    <BuyerMessage orderId={order.id} title={order.dev_products?.title || 'your plugin'} onSent={(text) => setMessage(text)} onClose={() => setContacting('')} />
                  </td></tr>
                )}
                </Fragment>
                );
              })}
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
