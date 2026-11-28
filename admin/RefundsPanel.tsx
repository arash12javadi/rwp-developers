import { useEffect, useState, type FormEvent } from 'react';
import { decideRefund, issueRefund, markRefundPaid, ownerRefunds, retryRefund, undoRefund } from '../lib/api';
import type { DevOrder, DevRefund, DevRefundStatus } from '../lib/types';
import styles from '../developers.module.css';

/**
 * Developers → Sales & licences → Refunds. Buyers ask from "My purchases" on the store; you are the seller. A decline of a plugin listed on
 * react-wp.com is reported there (reportStoreDecline), and the buyer may ask its marketplace owner to rule; otherwise your answer is final.
 * A Stripe payment is refunded through Stripe the moment you approve; a NOWPayments (USDT) payment has no refund API, so you send it
 * back from your wallet and record it here. A full refund always revokes the licence.
 */

const errorText = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);
const when = (value: string | null | undefined) => (value ? new Date(value).toLocaleString() : '—');
const usd = (value: number) => `$${Number(value || 0).toFixed(2)}`;

const LABEL: Record<DevRefundStatus, string> = {
  requested: 'Waiting for you', declined: 'Declined', approved: 'Approved, not sent', processing: 'Being sent',
  refunded: 'Refunded', cancelled: 'Withdrawn',
};

export default function RefundsPanel({ onChanged }: { onChanged: () => void }) {
  const [rows, setRows] = useState<DevRefund[] | null>(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let live = true;
    ownerRefunds()
      .then((list) => { if (live) { setRows(list); setError(''); } })
      .catch((loadError: unknown) => { if (live) { setRows([]); setError(errorText(loadError, 'Could not load the refunds.')); } });
    return () => { live = false; };
  }, [reload]);

  const done = (text: string) => {
    setMessage(text);
    setReload((value) => value + 1);
    onChanged();
  };

  return (
    <div>
      <p className={styles.hint}>
        Buyers ask for a refund from <strong>My purchases</strong> on your store. If you decline a plugin that is listed on react-wp.com, the buyer can ask its marketplace owner to rule (that ruling is final); otherwise your answer is final. Approving a card payment refunds it
        through your Stripe account straight away; a USDT payment is sent back by you from your wallet and then recorded here. To refund an
        order nobody asked about, use <strong>Refund…</strong> on the Orders tab.
      </p>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {message && <p className={styles.notice} role="status">{message}</p>}
      {!rows ? <p className={styles.muted}>Loading…</p> : !rows.length ? <p className={styles.hint}>No refund requests yet.</p> : (
        rows.map((row) => <RefundRow key={row.id} row={row} onDone={done} />)
      )}
    </div>
  );
}

function RefundRow({ row, onDone }: { row: DevRefund; onDone: (message: string) => void }) {
  const [note, setNote] = useState('');
  const [revoke, setRevoke] = useState(false);
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const order = row.order;
  const partial = order ? Number(row.amount) < Number(order.amount) - Number(order.refunded_amount || 0) - 0.001 : false;

  const run = async (name: string, action: () => Promise<string>) => {
    setBusy(name);
    setError('');
    try { onDone(await action()); } catch (actionError) { setError(errorText(actionError, 'That did not work.')); } finally { setBusy(''); }
  };

  const decide = (approve: boolean) => {
    if (!approve && note.trim().length < 10) { setError('Say why you decline (at least 10 characters): the buyer reads it, and it is final.'); return; }
    const confirmText = approve
      ? `Refund ${usd(row.amount)}? ${row.refund_method && row.refund_method !== 'manual' ? `The payment is refunded through ${row.refund_method === 'stripe' ? 'Stripe' : row.refund_method} now.` : 'You send the money back by hand, then record it here.'}`
      : 'Decline this refund? The buyer cannot ask this shop again for this order. If the plugin is listed on react-wp.com, they can ask its marketplace owner to rule.';
    if (!window.confirm(confirmText)) return;
    void run(approve ? 'approve' : 'decline', async () => {
      const result = await decideRefund(row.id, approve, note.trim(), revoke);
      if (!approve) return 'Declined.';
      return result.sent ? `Refunded ${usd(row.amount)} through Stripe.` : (result.message || 'Approved.');
    });
  };

  // Takes back an approval before any money moved: a buyer's request waits for your answer again; your own refund is cancelled.
  const undo = () => {
    const ask = row.origin === 'buyer'
      ? 'Cancel this approval? Nothing has been sent. The request goes back to waiting for your answer, so you can decline it with a reason or approve it again.'
      : 'Cancel this refund? Nothing has been sent, and the order stays as it is.';
    if (!window.confirm(ask)) return;
    void run('undo', async () => {
      await undoRefund(row.id);
      return row.origin === 'buyer' ? 'The approval was cancelled. The request is waiting for your answer again.' : 'The refund was cancelled.';
    });
  };

  const markPaid = (event: FormEvent) => {
    event.preventDefault();
    void run('paid', async () => { await markRefundPaid(row.id, reference.trim()); return 'Recorded as refunded.'; });
  };

  return (
    <div className={styles.panel}>
      <h3 className={styles.panelTitle}>
        {row.product?.title || 'Plugin'} · {usd(row.amount)} · {row.buyer_name || '—'}{' '}
        <span className={`${styles.badge} ${styles[row.status === 'refunded' ? 'paid' : row.status === 'declined' ? 'revoked' : 'pending'] || ''}`}>{LABEL[row.status]}</span>
      </h3>
      <p className={styles.hint}>
        {row.origin === 'owner' ? 'Issued by you' : row.origin === 'gateway' ? 'Made in the Stripe dashboard' : 'Asked by the buyer'} on {when(row.created_at)}
        {' · '}{row.refund_method === 'stripe' ? 'Card (Stripe)' : row.refund_method && row.refund_method !== 'manual' ? `${row.refund_method}: refunded automatically` : 'Sent by hand (USDT or another method)'}
        {order ? ` · order ${usd(order.amount)} on ${when(order.created_at)}` : ''}
      </p>
      {row.automatic && <p className={styles.hint}>Automatic refund: the buyer asked within 28 days of the payment, so it cannot be declined or cancelled.</p>}
      {row.reason && <p><strong>Buyer:</strong> {row.reason}</p>}
      {row.owner_note && <p><strong>You:</strong> {row.owner_note}</p>}
      {row.status === 'declined' && row.origin === 'buyer' && (
        <p className={styles.hint}>
          {row.platform_reported_at && !row.platform_error
            ? 'react-wp.com was told: the buyer can ask its marketplace owner to rule, and that ruling is final.'
            : row.platform_error
              ? `react-wp.com: ${row.platform_error}`
              : 'Not reported to react-wp.com yet; it is retried when you open Developers.'}
        </p>
      )}
      {row.payout_reference && <p className={styles.hint}>Payout reference: {row.payout_reference}</p>}
      {row.gateway_refund_id && <p className={styles.hint}>Stripe refund: <code>{row.gateway_refund_id}</code></p>}
      {row.error && <p className={styles.error}>Last attempt: {row.error}</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}

      {row.status === 'requested' && (
        <div className={styles.field}>
          <label htmlFor={`n-${row.id}`}>Your answer (the buyer reads it; required to decline)</label>
          <textarea id={`n-${row.id}`} className={styles.textarea} rows={2} maxLength={2000} value={note} disabled={busy !== ''} onChange={(event) => setNote(event.target.value)} />
          {partial && (
            <label><input type="checkbox" checked={revoke} disabled={busy !== ''} onChange={(event) => setRevoke(event.target.checked)} /> Also revoke the licence (a full refund always does)</label>
          )}
          <div className={styles.row}>
            <button type="button" className={styles.button} disabled={busy !== ''} onClick={() => decide(true)}>{busy === 'approve' ? 'Refunding…' : 'Approve refund'}</button>
            <button type="button" className={`${styles.button} ${styles.danger}`} disabled={busy !== ''} onClick={() => decide(false)}>{busy === 'decline' ? 'Saving…' : 'Decline'}</button>
          </div>
        </div>
      )}

      {row.status === 'approved' && row.refund_method && row.refund_method !== 'manual' && (
        <button type="button" className={styles.button} disabled={busy !== ''} onClick={() => void run('send', async () => { await retryRefund(row.id); return `Refunded ${usd(row.amount)} through Stripe.`; })}>
          {busy === 'send' ? 'Sending…' : 'Send the refund through Stripe'}
        </button>
      )}

      {row.status === 'approved' && !row.gateway_refund_id && !row.automatic && (
        <button type="button" className={`${styles.button} ${styles.danger}`} disabled={busy !== ''} onClick={undo}>
          {busy === 'undo' ? 'Cancelling…' : 'Cancel this refund'}
        </button>
      )}

      {row.status === 'approved' && (
        <form className={styles.row} onSubmit={markPaid}>
          <div className={styles.field} style={{ flex: '1 1 260px' }}>
            <label htmlFor={`r-${row.id}`}>{row.refund_method && row.refund_method !== 'manual' ? 'Refunded it in the gateway\'s own dashboard instead? Its refund id' : 'After you sent it: the transaction hash or reference'}</label>
            <input id={`r-${row.id}`} className={styles.input} maxLength={300} value={reference} disabled={busy !== ''} onChange={(event) => setReference(event.target.value)} />
          </div>
          <button type="submit" className={`${styles.button} ${styles.ghost}`} disabled={busy !== '' || reference.trim().length < 3}>{busy === 'paid' ? 'Saving…' : 'Mark as refunded'}</button>
        </form>
      )}
    </div>
  );
}

/** "Refund…" on one paid order of the Orders tab: the owner refunds it without a request (or records one made elsewhere). */
export function OrderRefundForm({ order, onClose, onDone }: { order: DevOrder; onClose: () => void; onDone: (message: string) => void }) {
  const left = Math.round((Number(order.amount) - Number(order.refunded_amount || 0)) * 100) / 100;
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [revoke, setRevoke] = useState(false);
  const [manual, setManual] = useState(order.provider !== 'stripe');
  const [reference, setReference] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const value = amount.trim() ? Number(amount) : left;
  const full = value >= left - 0.001;
  const record = manual && reference.trim().length >= 3;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const how = record ? 'Record a refund already paid back' : order.provider === 'stripe' ? 'Refund the card through Stripe now' : 'Approve it (you send the USDT by hand, then record it)';
    if (!window.confirm(`${how}: ${usd(value)}?${full ? ' The licence is revoked.' : ''}`)) return;
    setBusy(true);
    setError('');
    try {
      const result = await issueRefund({
        order_id: order.id, amount: amount.trim() ? Number(amount) : null, note: note.trim(), revoke, manual: record,
        payout_reference: record ? reference.trim() : undefined,
      });
      onClose();
      onDone(result.sent ? `Refunded ${usd(value)}.` : (result.message || 'Approved. Send it by hand, then mark it as refunded under Refunds.'));
    } catch (submitError) {
      setError(errorText(submitError, 'Could not refund this order.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className={styles.field} style={{ minWidth: 240 }}>
      {error && <p className={styles.error} role="alert">{error}</p>}
      <label htmlFor={`a-${order.id}`}>Amount (empty = all {usd(left)})</label>
      <input id={`a-${order.id}`} className={styles.input} type="number" min="0.01" max={left} step="0.01" value={amount} disabled={busy} onChange={(event) => setAmount(event.target.value)} />
      <label htmlFor={`w-${order.id}`}>Note to the buyer</label>
      <input id={`w-${order.id}`} className={styles.input} maxLength={2000} value={note} disabled={busy} onChange={(event) => setNote(event.target.value)} />
      {!full && <label><input type="checkbox" checked={revoke} disabled={busy} onChange={(event) => setRevoke(event.target.checked)} /> Also revoke the licence</label>}
      {order.provider === 'stripe' && <label><input type="checkbox" checked={manual} disabled={busy} onChange={(event) => setManual(event.target.checked)} /> Already refunded elsewhere: only record it</label>}
      {manual && (
        <>
          <label htmlFor={`p-${order.id}`}>How it was paid back (transaction hash, Stripe refund id, a note)</label>
          <input id={`p-${order.id}`} className={styles.input} maxLength={300} value={reference} disabled={busy} onChange={(event) => setReference(event.target.value)} />
        </>
      )}
      <div className={styles.row}>
        <button type="submit" className={styles.button} disabled={busy || (manual && order.provider === 'stripe' && !record)}>
          {busy ? 'Working…' : record ? 'Record refund' : order.provider === 'stripe' ? 'Refund through Stripe' : 'Approve, send by hand later'}
        </button>
        <button type="button" className={`${styles.button} ${styles.ghost}`} disabled={busy} onClick={onClose}>Cancel</button>
      </div>
    </form>
  );
}
