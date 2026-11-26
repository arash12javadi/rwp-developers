import { useEffect, useState, type FormEvent } from 'react';
import { adminStatus, prepareBucket, savePayments } from '../lib/api';
import type { GatewayCheck, PaymentStatus } from '../lib/types';
import styles from '../developers.module.css';

const errorText = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);

const SECRET_LABELS: Record<string, string> = {
  stripe_secret_key: 'Stripe secret key',
  stripe_webhook_secret: 'Stripe webhook signing secret',
  nowpayments_api_key: 'NOWPayments API key',
  nowpayments_ipn_secret: 'NOWPayments IPN secret',
};

/**
 * Developers → Payments: your own Stripe and NOWPayments accounts, your licence key, and your package storage.
 * A credential is sealed on the server the moment it is saved and is never shown again; this screen only says whether
 * it is set.
 */
export default function PaymentsAdmin() {
  const [status, setStatus] = useState<PaymentStatus | null>(null);
  const [stripeOn, setStripeOn] = useState(false);
  const [nowOn, setNowOn] = useState(false);
  const [sandbox, setSandbox] = useState(false);
  const [payCurrency, setPayCurrency] = useState('usdttrc20');
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  // Gateways added by plugins: their switch and the fields typed now (blank = keep what is stored).
  const [extraOn, setExtraOn] = useState<Record<string, boolean>>({});
  const [extraFields, setExtraFields] = useState<Record<string, Record<string, string | boolean>>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  const apply = (next: PaymentStatus) => {
    setStatus(next);
    setStripeOn(next.config.stripe.enabled);
    setNowOn(next.config.nowpayments.enabled);
    setSandbox(next.config.nowpayments.sandbox);
    setPayCurrency(next.config.nowpayments.pay_currency);
    setExtraOn(Object.fromEntries((next.gateways || []).filter((gateway) => !gateway.built_in).map((gateway) => [gateway.id, gateway.enabled])));
  };
  const extraGateways: GatewayCheck[] = (status?.gateways || []).filter((gateway) => !gateway.built_in);

  useEffect(() => {
    adminStatus().then(apply).catch((loadError: unknown) => setError(errorText(loadError, 'Could not load the payment settings.')));
  }, []);

  const save = async (event: FormEvent, clear: string[] = []) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      apply(await savePayments({
        stripe: { enabled: stripeOn },
        nowpayments: { enabled: nowOn, sandbox, pay_currency: payCurrency.trim() || 'usdttrc20' },
        secrets,
        clear,
        gateways: Object.fromEntries(extraGateways.map((gateway) => [gateway.id, { enabled: Boolean(extraOn[gateway.id]), fields: extraFields[gateway.id] || {} }])),
      }));
      setSecrets({});
      setExtraFields({});
      setMessage('Saved. Credentials are stored sealed and are not shown again.');
    } catch (saveError) {
      setError(errorText(saveError, 'Could not save the payment settings.'));
    } finally {
      setBusy(false);
    }
  };

  const prepare = async () => {
    setError('');
    setMessage('');
    try {
      await prepareBucket();
      setMessage('The private package bucket is ready.');
    } catch (prepareError) {
      setError(errorText(prepareError, 'Could not prepare the package bucket.'));
    }
  };

  const secretField = (name: string) => (
    <div className={styles.field} key={name}>
      <label htmlFor={`dev-${name}`}>{SECRET_LABELS[name]}</label>
      <input id={`dev-${name}`} className={styles.input} type="password" autoComplete="new-password" spellCheck={false}
        value={secrets[name] || ''} disabled={busy}
        placeholder={status?.secrets[name] ? 'Stored — leave blank to keep it' : 'Paste it here'}
        onChange={(event) => setSecrets((current) => ({ ...current, [name]: event.target.value }))} />
      {status?.secrets[name] && (
        <button type="button" className={`${styles.button} ${styles.danger}`} disabled={busy} style={{ alignSelf: 'flex-start' }}
          onClick={(event) => save(event, [name])}>Remove the stored one</button>
      )}
    </div>
  );

  if (!status && !error) return <p className={styles.muted}>Loading…</p>;

  return (
    <div className={styles.wrap}>
      <h2 className={styles.title}>Payments &amp; licence key</h2>
      <p className={styles.subtitle}>
        Your shop takes payments into <strong>your own</strong> account: Stripe, NOWPayments, or a method a plugin adds (PayPal, Mollie, GoCardless with RWP Payments Plus). Nothing passes through
        react-wp.com, and no credential is shown again after it is saved.
      </p>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {message && <p className={styles.notice} role="status">{message}</p>}

      {status && !status.secret_box && (
        <p className={styles.warn} role="alert">
          <strong>One setting is missing:</strong> <code>RWP_SECRET_BOX_KEY</code>. It is the key that seals your payment
          credentials in the database, so none can be saved until it is set (32 random bytes, base64) in this site&rsquo;s
          environment variables and the site is redeployed.
        </p>
      )}

      {status && (
        <form onSubmit={save}>
          <div className={styles.panel}>
            <h3 className={styles.panelTitle}>Card payments — Stripe</h3>
            <label className={styles.check}>
              <input type="checkbox" checked={stripeOn} disabled={busy} onChange={(event) => setStripeOn(event.target.checked)} />
              <span>Accept card payments with Stripe</span>
            </label>
            <div className={styles.row}>{secretField('stripe_secret_key')}{secretField('stripe_webhook_secret')}</div>
            <p className={styles.hint}>
              In Stripe, add a webhook endpoint at <code>{status.webhook_urls.stripe}</code> for the events
              <code> checkout.session.completed</code>, <code>checkout.session.async_payment_succeeded</code> (methods that settle
              later, like SEPA) and the refund events, and paste its signing secret above. Apple Pay, Google Pay, iDEAL and other
              methods are switched on in Stripe → Settings → Payment methods; PayPal, Mollie and GoCardless come from RWP Payments Plus.
              {status.checks.stripe.enabled && (status.checks.stripe.ready ? ' Ready.' : ` Still missing: ${status.checks.stripe.missing.map((name) => SECRET_LABELS[name]).join(', ')}.`)}
            </p>
          </div>

          <div className={styles.panel}>
            <h3 className={styles.panelTitle}>USDT — NOWPayments</h3>
            <label className={styles.check}>
              <input type="checkbox" checked={nowOn} disabled={busy} onChange={(event) => setNowOn(event.target.checked)} />
              <span>Accept USDT with NOWPayments</span>
            </label>
            <label className={styles.check}>
              <input type="checkbox" checked={sandbox} disabled={busy} onChange={(event) => setSandbox(event.target.checked)} />
              <span>Use the NOWPayments sandbox (test payments, no real money)</span>
            </label>
            <div className={styles.row}>
              {secretField('nowpayments_api_key')}{secretField('nowpayments_ipn_secret')}
              <div className={styles.field}>
                <label htmlFor="dev-pay-currency">Coin buyers pay in</label>
                <input id="dev-pay-currency" className={styles.input} value={payCurrency} disabled={busy} spellCheck={false}
                  onChange={(event) => setPayCurrency(event.target.value)} />
              </div>
            </div>
            <p className={styles.hint}>
              In NOWPayments, set the IPN callback to <code>{status.webhook_urls.nowpayments}</code> and paste the IPN secret above.
              {status.checks.nowpayments.enabled && (status.checks.nowpayments.ready ? ' Ready.' : ` Still missing: ${status.checks.nowpayments.missing.map((name) => SECRET_LABELS[name]).join(', ')}.`)}
            </p>
          </div>

          {extraGateways.length > 0 && (
            <div className={styles.panel}>
              <h3 className={styles.panelTitle}>More payment methods (added by plugins)</h3>
              <p className={styles.hint}>
                These come from plugins active on this site. Each one is off until you switch it on here and save its credentials. The plugin's
                author built it, so only use one you trust; whatever it reports, the amount is still checked against the order before a licence is issued.
              </p>
              {extraGateways.map((gateway) => (
                <div key={gateway.id} className={styles.panel}>
                  <h4 className={styles.panelTitle}>{gateway.label} <span className={styles.muted}>(from {gateway.plugin})</span></h4>
                  {gateway.description && <p className={styles.hint}>{gateway.description}</p>}
                  <label className={styles.check}>
                    <input type="checkbox" checked={Boolean(extraOn[gateway.id])} disabled={busy}
                      onChange={(event) => setExtraOn((current) => ({ ...current, [gateway.id]: event.target.checked }))} />
                    <span>Offer {gateway.buyer_label || gateway.label} to buyers</span>
                  </label>
                  <div className={styles.row}>
                    {gateway.credential_fields.map((field) => {
                      const id = `gw-${gateway.id}-${field.name}`;
                      const value = extraFields[gateway.id]?.[field.name];
                      const set = (next: string | boolean) => setExtraFields((current) => ({ ...current, [gateway.id]: { ...(current[gateway.id] || {}), [field.name]: next } }));
                      if (field.type === 'boolean') {
                        return (
                          <label key={field.name} className={styles.check}>
                            <input id={id} type="checkbox" checked={value === true} disabled={busy} onChange={(event) => set(event.target.checked)} />
                            <span>{field.label}</span>
                          </label>
                        );
                      }
                      const stored = !gateway.missing.includes(field.name);
                      return (
                        <div className={styles.field} key={field.name}>
                          <label htmlFor={id}>{field.label}{field.required ? '' : ' (optional)'}</label>
                          <input id={id} className={styles.input} type={field.type === 'secret' ? 'password' : 'text'} autoComplete="off" spellCheck={false}
                            value={typeof value === 'string' ? value : ''} disabled={busy}
                            placeholder={stored && field.required ? 'Stored — leave blank to keep it' : 'Paste it here'}
                            onChange={(event) => set(event.target.value)} />
                          {field.help && <span className={styles.hint}>{field.help}</span>}
                        </div>
                      );
                    })}
                  </div>
                  <p className={styles.hint}>
                    {gateway.webhook_url && <>Give {gateway.label} this callback address: <code>{gateway.webhook_url}</code>. </>}
                    {gateway.enabled && (gateway.ready ? 'Ready.' : `Still missing: ${gateway.missing.join(', ')}.`)}
                    {!gateway.supports.refund && ' Refunds are sent by hand and recorded here.'}
                  </p>
                </div>
              ))}
            </div>
          )}

          <button type="submit" className={styles.button} disabled={busy}>{busy ? 'Saving…' : 'Save payment settings'}</button>
        </form>
      )}

      {status && (
        <div className={styles.panel} style={{ marginTop: 16 }}>
          <h3 className={styles.panelTitle}>Your licence key</h3>
          {status.license_public_key ? (
            <>
              <p className={styles.hint}>
                Every licence your shop sells is signed with a private key that stays on this server. This is the public
                half: paste it into a plugin you sell so that plugin can check a buyer&rsquo;s key without any network call.
              </p>
              <code className={styles.code}>{status.license_public_key}</code>
              <p className={styles.label} style={{ marginTop: 12 }}>The check to put in your plugin</p>
              <code className={styles.code}>{status.snippet}</code>
            </>
          ) : (
            <p className={styles.hint}>The key pair is created the first time you switch a payment method on or sell your first plugin.</p>
          )}
        </div>
      )}

      <div className={styles.panel}>
        <h3 className={styles.panelTitle}>Package storage</h3>
        <p className={styles.hint}>
          Plugin packages are kept in a <strong>private</strong> bucket (<code>rwp-developer-packages</code>) in your own Supabase
          project. Buyers only ever get a ten-minute signed address after their licence is checked. The bucket is created when
          you upload your first version; you can also prepare it now.
        </p>
        <button type="button" className={`${styles.button} ${styles.ghost}`} onClick={prepare}>Prepare the bucket</button>
      </div>
    </div>
  );
}
