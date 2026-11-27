import { useCallback, useEffect, useState } from 'react';
import { inboxDecide, inboxList, inboxReply, inboxThread } from '../lib/api';
import type { InboxThread, InboxTicket } from '../lib/types';
import styles from '../developers.module.css';

const errorText = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);
const when = (value: string | null | undefined) => (value ? new Date(value).toLocaleString() : '—');
const KIND: Record<InboxTicket['kind'], string> = { presale: 'Question', support: 'Support', refund: 'Refund' };
const REFUND: Record<InboxTicket['refund_status'], string> = {
  none: '', requested: 'waiting for your decision', approved: 'approved', declined: 'declined', escalated: 'with the marketplace owner',
  ruled_buyer: 'owner ruled: refund the buyer', ruled_seller: 'owner ruled: your decision stands', cancelled: 'withdrawn',
};
const ROLE: Record<string, string> = { buyer: 'Buyer', seller: 'You', owner: 'Marketplace owner', system: 'Note' };

/**
 * Developers → Messages: what buyers asked about your plugins on react-wp.com (questions before buying, support, refund requests),
 * read over this site's account link. A refund is decided here because the money is on this shop's payment account: approving
 * refunds the order through its gateway (or records a refund you sent by hand), revokes the licence key when everything is given
 * back, puts the key on this shop's signed revocation list and emails the buyer. Declining needs a written reason; the buyer may
 * then ask the marketplace owner, whose ruling is final.
 */
export default function InboxAdmin() {
  const [tickets, setTickets] = useState<InboxTicket[] | null>(null);
  const [open, setOpen] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      setTickets((await inboxList()).tickets || []);
      setError('');
    } catch (failure) {
      setTickets([]);
      setError(errorText(failure, 'The messages could not be read from react-wp.com.'));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <div className={styles.wrap}>
      <h1 className={styles.title}>Messages</h1>
      <p className={styles.subtitle}>
        Questions, support requests and refund requests from buyers of your plugins on react-wp.com. This site must be connected to your
        react-wp.com account (Plugins → Connect to react-wp.com).
      </p>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {!tickets ? <p className={styles.muted}>Loading…</p> : !tickets.length ? <p className={styles.muted}>No messages yet.</p> : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr><th>Subject</th><th>Plugin</th><th>Buyer</th><th>Status</th><th>Last message</th><th /></tr></thead>
            <tbody>
              {tickets.map((row) => (
                <tr key={row.id}>
                  <td><strong>{row.subject}</strong><br /><span className={styles.muted}>{KIND[row.kind]}{row.refund_status !== 'none' ? ` · ${REFUND[row.refund_status]}` : ''}</span></td>
                  <td>{row.plugin_title}</td>
                  <td>{row.buyer_name}</td>
                  <td><span className={`${styles.badge} ${row.status === 'open' ? styles.pending : styles.active}`}>{row.status === 'open' ? 'needs an answer' : row.status}</span></td>
                  <td>{when(row.last_message_at)}</td>
                  <td><button type="button" className={`${styles.button} ${styles.ghost}`} onClick={() => setOpen(open === row.id ? '' : row.id)}>{open === row.id ? 'Close' : 'Open'}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <Thread id={open} onChanged={() => void load()} />}
    </div>
  );
}

function Thread({ id, onChanged }: { id: string; onChanged: () => void }) {
  const [thread, setThread] = useState<InboxThread | null>(null);
  const [reply, setReply] = useState('');
  const [reason, setReason] = useState('');
  const [amount, setAmount] = useState('');
  const [manualRef, setManualRef] = useState('');
  const [busy, setBusy] = useState('');
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const load = useCallback(async () => {
    try {
      setThread(await inboxThread(id));
    } catch (failure) {
      setNote({ ok: false, text: errorText(failure, 'The conversation could not be read.') });
    }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  const run = async (name: string, action: () => Promise<string>) => {
    setBusy(name);
    setNote(null);
    try {
      setNote({ ok: true, text: await action() });
      await load();
      onChanged();
    } catch (failure) {
      setNote({ ok: false, text: errorText(failure, 'That did not work.') });
    } finally {
      setBusy('');
    }
  };

  if (!thread) return note ? <p className={styles.error}>{note.text}</p> : <p className={styles.muted}>Loading the conversation…</p>;
  const { ticket, local } = thread;
  const deciding = ticket.kind === 'refund' && ['requested', 'ruled_buyer'].includes(ticket.refund_status);
  const order = local?.order;
  const manual = Boolean(order && !['stripe', 'paypal', 'mollie', 'gocardless'].includes(order.provider));

  return (
    <section className={styles.panel} aria-label="Conversation">
      <h2 className={styles.panelTitle}>{ticket.subject}</h2>
      <p className={styles.muted}>{KIND[ticket.kind]} · {ticket.plugin_title} · {ticket.buyer_name}{ticket.refund_status !== 'none' ? ` · refund ${REFUND[ticket.refund_status]}` : ''}</p>
      {thread.dispute?.status === 'ruled' && <p className={styles.warn}>Marketplace ruling: {thread.dispute.ruling_note}</p>}
      <ol>
        {thread.messages.map((row) => (
          <li key={row.id}><strong>{ROLE[row.author_role] || row.author_role}</strong> <span className={styles.muted}>{when(row.created_at)}</span><p style={{ whiteSpace: 'pre-wrap', margin: '4px 0 10px' }}>{row.body}</p></li>
        ))}
      </ol>
      {ticket.status !== 'closed' && (
        <div className={styles.field}>
          <label htmlFor={`reply-${ticket.id}`}>Reply</label>
          <textarea id={`reply-${ticket.id}`} className={styles.textarea} maxLength={4000} value={reply} onChange={(event) => setReply(event.target.value)} disabled={busy !== ''} />
          <div className={styles.row}>
            <button type="button" className={styles.button} disabled={busy !== '' || !reply.trim()}
              onClick={() => void run('reply', async () => { await inboxReply(ticket.id, reply); setReply(''); return 'Sent. The buyer is told on react-wp.com.'; })}>
              {busy === 'reply' ? 'Sending…' : 'Send reply'}
            </button>
          </div>
        </div>
      )}
      {deciding && (
        <div className={styles.panel}>
          <h3 className={styles.panelTitle}>Refund decision</h3>
          {order ? (
            <p className={styles.hint}>
              Order {order.id.slice(0, 8)}… paid {order.amount} {order.currency.toUpperCase()} with {order.provider}; {order.refunded_amount} refunded so far.
              Licence {local?.license.status}{local?.license.domain ? ` on ${local.license.domain}` : ''}.
              {ticket.refund_amount ? ` The buyer asks for ${ticket.refund_amount}.` : ' The buyer asks for everything.'}
            </p>
          ) : <p className={styles.warn}>The order of this purchase was not found in this shop (a key from another shop?). You can still decline with a reason.</p>}
          <div className={styles.row}>
            <div className={styles.field}>
              <label htmlFor={`amount-${ticket.id}`}>Amount to refund (empty = what the buyer asked, or everything left)</label>
              <input id={`amount-${ticket.id}`} className={styles.input} inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} disabled={busy !== ''} />
            </div>
            {manual && (
              <div className={styles.field}>
                <label htmlFor={`manual-${ticket.id}`}>How you sent it back (transaction hash or note)</label>
                <input id={`manual-${ticket.id}`} className={styles.input} value={manualRef} onChange={(event) => setManualRef(event.target.value)} disabled={busy !== ''} />
              </div>
            )}
          </div>
          <div className={styles.field}>
            <label htmlFor={`reason-${ticket.id}`}>Your reason (required to decline; the buyer reads it)</label>
            <textarea id={`reason-${ticket.id}`} className={styles.textarea} maxLength={2000} value={reason} onChange={(event) => setReason(event.target.value)} disabled={busy !== ''} />
          </div>
          <div className={styles.row}>
            <button type="button" className={styles.button} disabled={busy !== '' || !order || (manual && manualRef.trim().length < 3)}
              onClick={() => {
                if (!window.confirm('Refund this purchase? A full refund also revokes the licence key, so the plugin stops receiving updates.')) return;
                void run('approve', async () => {
                  const result = await inboxDecide({
                    ticket_id: ticket.id, decision: 'approve', reason, amount: amount.trim() ? Number(amount) : null,
                    manual, payout_reference: manual ? manualRef : undefined,
                  });
                  return result.reported ? 'Refunded, and the buyer was told on react-wp.com.' : result.message || 'Approved.';
                });
              }}>
              {busy === 'approve' ? 'Refunding…' : 'Approve refund'}
            </button>
            {ticket.refund_status === 'requested' && (
              <button type="button" className={`${styles.button} ${styles.danger}`} disabled={busy !== '' || reason.trim().length < 10}
                onClick={() => void run('decline', async () => { await inboxDecide({ ticket_id: ticket.id, decision: 'decline', reason }); return 'Declined. The buyer may ask the marketplace owner to rule.'; })}>
                {busy === 'decline' ? 'Saving…' : 'Decline'}
              </button>
            )}
          </div>
        </div>
      )}
      {note && <p className={note.ok ? styles.notice : styles.error} role="status">{note.text}</p>}
    </section>
  );
}
