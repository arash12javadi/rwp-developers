import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { getSupabaseClient } from '../../../src/lib/db';
import {
  askForRefund, claimPlugin, downloadMine, loadStore, myLicenses, myRefunds, releaseMyDomain, startCheckout, withdrawRefund,
} from '../lib/api';
import type { DevRefund, DevRefundStatus, MyLicense, StoreCatalog, StoreProduct } from '../lib/types';
import styles from '../developers.module.css';

const errorText = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);
const priceLabel = (product: StoreProduct) => (Number(product.price) > 0 ? `$${Number(product.price).toFixed(2)}${product.license_days ? ` / ${product.license_days} days` : ''}` : 'Free');

function useUser(): string | null {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const client = getSupabaseClient();
    void client.auth.getSession().then(({ data }) => { if (live) setId(data.session?.user.id || ''); });
    const { data } = client.auth.onAuthStateChange((_event, session) => { if (live) setId(session?.user.id || ''); });
    return () => { live = false; data.subscription.unsubscribe(); };
  }, []);
  return id;
}

/**
 * The developer's public shop: the plugins on sale, a way to pay or claim, and the signed-in buyer's own licences with
 * their downloads. The price shown is for reading only; the amount that is charged is read again on the server.
 */
export default function Store({ title = 'Plugins', intro = '' }: { title?: string; intro?: string }) {
  const user = useUser();
  const [catalog, setCatalog] = useState<StoreCatalog | null>(null);
  const [licenses, setLicenses] = useState<MyLicense[]>([]);
  const [refunds, setRefunds] = useState<DevRefund[]>([]);
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const params = typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(window.location.search);
  const returned = params.get('paid') === '1';

  const loadLicenses = useCallback(async () => {
    try { setLicenses(await myLicenses()); } catch { setLicenses([]); }
    // Refund requests are a convenience on top of the list: if they cannot be read, the licences still show.
    try { setRefunds(await myRefunds()); } catch { setRefunds([]); }
  }, []);

  useEffect(() => {
    loadStore().then(setCatalog).catch((loadError: unknown) => { setCatalog({ products: [], methods: [] }); setError(errorText(loadError, 'The shop could not be loaded.')); });
  }, []);

  useEffect(() => { if (user) void loadLicenses(); else setLicenses([]); }, [user, loadLicenses]);

  // Coming back from the payment page: the provider's confirmation reaches the shop a moment later, so look a few times.
  useEffect(() => {
    if (!returned || !user) return;
    setMessage('Thank you. Waiting for the payment to be confirmed…');
    let tries = 0;
    const timer = window.setInterval(async () => {
      tries += 1;
      await loadLicenses();
      if (tries >= 8) {
        window.clearInterval(timer);
        setMessage('Your payment can take a few minutes to be confirmed. Your licence will appear below as soon as it is.');
      }
    }, 4000);
    return () => window.clearInterval(timer);
  }, [returned, user, loadLicenses]);

  useEffect(() => {
    if (returned && licenses.length) setMessage('Your payment was confirmed. Your licence is below.');
  }, [returned, licenses.length]);

  const owned = (product: StoreProduct) => licenses.some((license) => license.plugin === product.slug && license.status === 'active' && (!license.expires_at || Date.parse(license.expires_at) > Date.now()));

  const act = async (id: string, run: () => Promise<void>) => {
    setBusy(id);
    setError('');
    setMessage('');
    try { await run(); } catch (actionError) { setError(errorText(actionError, 'That did not work.')); } finally { setBusy(''); }
  };

  const claim = (product: StoreProduct) => act(product.id, async () => {
    await claimPlugin(product.id);
    await loadLicenses();
    setMessage(`“${product.title}” is yours. Your licence and download are below.`);
  });

  const pay = (product: StoreProduct, provider: string) => act(`${product.id}:${provider}`, async () => {
    const { url } = await startCheckout(product.id, provider);
    window.location.assign(url);
  });

  const download = (license: MyLicense) => act(license.id, async () => {
    const result = await downloadMine(license.id);
    window.location.assign(result.download_url);
  });

  const release = (license: MyLicense) => act(license.id, async () => {
    await releaseMyDomain(license.id);
    await loadLicenses();
    setMessage('The site was released. The key can be used on a new site.');
  });

  const copy = async (license: MyLicense) => {
    try { await navigator.clipboard.writeText(license.license_key); setMessage('Licence key copied.'); } catch { setError('Select the key and copy it by hand.'); }
  };

  return (
    <div className={styles.store}>
      <div className={styles.storeHead}>
        <h1 className={styles.title}>{title}</h1>
        {intro && <p className={styles.subtitle}>{intro}</p>}
      </div>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {message && <p className={styles.notice} role="status">{message}</p>}

      {!catalog ? <p className={styles.muted}>Loading…</p> : !catalog.products.length ? <p className={styles.hint}>Nothing is for sale yet.</p> : (
        <ul className={styles.cards}>
          {catalog.products.map((product) => (
            <li key={product.id} className={styles.card}>
              <h2 className={styles.cardTitle}>{product.title}</h2>
              <span className={styles.cardMeta}>{product.category} · version {product.version}</span>
              <p className={styles.cardText}>{product.description || 'No description yet.'}</p>
              <div className={styles.cardFoot}>
                <span className={styles.price}>{priceLabel(product)}</span>
                {owned(product) ? (
                  <span className={`${styles.badge} ${styles.ready}`}>You own this</span>
                ) : user === '' ? (
                  <a className={styles.button} href={`/login?redirect=${encodeURIComponent('/store')}`}>Sign in to get it</a>
                ) : Number(product.price) <= 0 ? (
                  <button type="button" className={styles.button} disabled={busy !== '' || user === null} onClick={() => claim(product)}>{busy === product.id ? 'Getting it…' : 'Get it free'}</button>
                ) : catalog.methods.length ? (
                  <div className={styles.methods}>
                    {catalog.methods.map((method) => (
                      <button key={method.id} type="button" className={styles.button} disabled={busy !== '' || user === null} onClick={() => pay(product, method.id)}>
                        {busy === `${product.id}:${method.id}` ? 'Opening…' : `Pay · ${method.label}`}
                      </button>
                    ))}
                  </div>
                ) : <span className={styles.muted}>Not available to buy yet</span>}
              </div>
            </li>
          ))}
        </ul>
      )}

      {user && licenses.length > 0 && (
        <section className={styles.panel} style={{ marginTop: 28 }} aria-label="My purchases">
          <h2 className={styles.panelTitle}>My purchases</h2>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead><tr><th>Plugin</th><th>Licence key</th><th>Expires</th><th>Site</th><th /><th>Refund</th></tr></thead>
              <tbody>
                {licenses.map((license) => (
                  <tr key={license.id}>
                    <td><strong>{license.title}</strong><br /><span className={styles.muted}>version {license.version}</span></td>
                    <td><code className={styles.licence}>{license.license_key}</code><br /><button type="button" className={`${styles.button} ${styles.ghost}`} onClick={() => copy(license)}>Copy</button></td>
                    <td>{license.expires_at ? new Date(license.expires_at).toLocaleDateString() : 'Never'}</td>
                    <td>{license.domain || <span className={styles.muted}>not used yet</span>}</td>
                    <td>
                      {license.status === 'active'
                        ? <button type="button" className={styles.button} disabled={busy !== ''} onClick={() => download(license)}>{busy === license.id ? 'Preparing…' : 'Download'}</button>
                        : <span className={`${styles.badge} ${styles.revoked}`}>revoked</span>}
                      {license.domain && <> <button type="button" className={`${styles.button} ${styles.ghost}`} disabled={busy !== ''} onClick={() => release(license)}>Move to another site</button></>}
                    </td>
                    <td>
                      <RefundCell
                        license={license}
                        requests={refunds.filter((row) => row.order_id === license.order_id)}
                        onDone={async (text) => { await loadLicenses(); setMessage(text); }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className={styles.hint}>
            To use a plugin, install the ZIP from Plugins → Upload on your site and enter the licence key where the plugin asks for it.
            To ask for your money back, use <strong>Ask for a refund</strong>: the shop answers here. A full refund ends the licence.
          </p>
        </section>
      )}
    </div>
  );
}

const REFUND_STATUS: Record<DevRefundStatus, string> = {
  requested: 'Refund asked, waiting for the shop',
  declined: 'Refund declined',
  approved: 'Refund approved, being sent',
  processing: 'Refund being sent',
  refunded: 'Refunded',
  cancelled: 'Request withdrawn',
};

/** The refund column of one purchase: its latest request, the shop's answer, and "Ask for a refund" when that is possible. */
function RefundCell({ license, requests, onDone }: { license: MyLicense; requests: DevRefund[]; onDone: (message: string) => Promise<void> }) {
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const latest = requests[0];
  const open = requests.find((row) => ['requested', 'approved', 'processing'].includes(row.status));
  const declined = requests.some((row) => row.status === 'declined');
  const left = Math.round((Number(license.amount || 0) - Number(license.refunded_amount || 0)) * 100) / 100;
  const canAsk = license.order_status === 'paid' && left > 0 && !open && !declined;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await askForRefund(license.order_id, reason.trim(), amount.trim() ? Number(amount) : null);
      setAsking(false);
      await onDone('Your refund request was sent to the shop. The answer appears here.');
    } catch (submitError) {
      setError(errorText(submitError, 'Could not send the request.'));
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async () => {
    if (!open || !window.confirm('Withdraw your refund request?')) return;
    setBusy(true);
    setError('');
    try {
      await withdrawRefund(open.id);
      await onDone('Your refund request was withdrawn.');
    } catch (withdrawError) {
      setError(errorText(withdrawError, 'Could not withdraw the request.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {latest && (
        <p className={styles.hint}>
          {REFUND_STATUS[latest.status]} ({`$${Number(latest.amount).toFixed(2)}`})
          {latest.owner_note ? `. The shop: ${latest.owner_note}` : ''}
          {latest.status === 'refunded' && latest.payout_reference ? `. Reference: ${latest.payout_reference}` : ''}
          {latest.status === 'approved' && license.provider === 'nowpayments' ? '. USDT is sent back by hand, so it can take a few days.' : ''}
        </p>
      )}
      {open?.status === 'requested' && (
        <button type="button" className={`${styles.button} ${styles.ghost}`} disabled={busy} onClick={() => void withdraw()}>Withdraw</button>
      )}
      {canAsk && (asking ? (
        <form onSubmit={submit}>
          <label className={styles.hint} htmlFor={`why-${license.id}`}>Why do you want a refund? The shop reads this.</label>
          <textarea id={`why-${license.id}`} className={styles.textarea} rows={3} maxLength={2000} value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)} />
          <label className={styles.hint} htmlFor={`amt-${license.id}`}>Amount (empty = all ${left.toFixed(2)})</label>
          <input id={`amt-${license.id}`} className={styles.input} type="number" min="0.01" max={left} step="0.01" value={amount} disabled={busy} onChange={(event) => setAmount(event.target.value)} />
          <p className={styles.hint}>A full refund ends this licence: the key stops working.</p>
          <button type="submit" className={styles.button} disabled={busy || reason.trim().length < 10}>{busy ? 'Sending…' : 'Send'}</button>{' '}
          <button type="button" className={`${styles.button} ${styles.ghost}`} disabled={busy} onClick={() => setAsking(false)}>Cancel</button>
        </form>
      ) : (
        <button type="button" className={`${styles.button} ${styles.ghost}`} onClick={() => setAsking(true)}>Ask for a refund</button>
      ))}
    </div>
  );
}
