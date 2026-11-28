import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { inboxAskSeller, inboxDecide, inboxList, inboxReply, inboxSellers, inboxThread, listOrders } from '../lib/api';
import type { DevOrder, InboxThread, InboxTicket, SellerPlugin } from '../lib/types';
import BuyerMessage from './BuyerMessage';
import styles from '../developers.module.css';

const errorText = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);
const when = (value: string | null | undefined) => (value ? new Date(value).toLocaleString() : '—');
const KIND: Record<InboxTicket['kind'], string> = { presale: 'Question', support: 'Support', refund: 'Refund' };
const REFUND: Record<InboxTicket['refund_status'], string> = {
  none: '', requested: 'waiting for your decision', approved: 'approved', declined: 'declined', escalated: 'with the marketplace owner',
  ruled_buyer: 'owner ruled: refund the buyer', ruled_seller: 'owner ruled: your decision stands', cancelled: 'withdrawn',
};
/** Who wrote a message, from where this account stands in the thread. */
const author = (role: string, viewer: 'seller' | 'buyer') => {
  if (role === viewer) return 'You';
  return ({ buyer: 'Buyer', seller: 'Seller', owner: 'Marketplace owner', system: 'Note' } as Record<string, string>)[role] || role;
};
type Scope = 'seller' | 'buyer';

/**
 * Developers → Messages, the conversations between buyers and sellers held on react-wp.com and read over this site's account link:
 *   - **Your buyers**: questions, support and refund requests about your plugins, and conversations you start with a buyer (New
 *     message, or Contact buyer on Sales). A refund is decided here because the money is on this shop's payment account: approving
 *     refunds the order through its gateway (or records a refund you sent by hand), revokes the licence key when everything is given
 *     back, puts the key on this shop's signed revocation list and emails the buyer. Declining needs a written reason; the buyer may
 *     then ask the marketplace owner, whose ruling is final.
 *   - **Your sellers**: conversations with the developers of plugins this account bought, and a new message to one of them.
 */
export default function InboxAdmin() {
  const [scope, setScope] = useState<Scope>('seller');
  const [tickets, setTickets] = useState<InboxTicket[] | null>(null);
  const [open, setOpen] = useState('');
  const [composing, setComposing] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      setTickets((await inboxList(scope)).tickets || []);
      setError('');
    } catch (failure) {
      setTickets([]);
      setError(errorText(failure, 'The messages could not be read from react-wp.com.'));
    }
  }, [scope]);
  useEffect(() => { setTickets(null); void load(); }, [load]);

  const choose = (next: Scope) => { setScope(next); setOpen(''); setComposing(false); };
  const other = (row: InboxTicket) => (scope === 'seller' ? row.buyer_name : row.seller_name || 'Seller');

  return (
    <div className={styles.wrap}>
      <h1 className={styles.title}>Messages</h1>
      <p className={styles.subtitle}>
        Conversations between buyers and sellers, held on react-wp.com: with the buyers of your plugins, and with the sellers of plugins
        you bought. This site must be connected to your react-wp.com account (Plugins → Connect to react-wp.com).
      </p>
      <div className={styles.tabs} role="tablist" aria-label="Which conversations">
        <button type="button" role="tab" aria-selected={scope === 'seller'} className={scope === 'seller' ? styles.button : `${styles.button} ${styles.ghost}`} onClick={() => choose('seller')}>Your buyers</button>
        <button type="button" role="tab" aria-selected={scope === 'buyer'} className={scope === 'buyer' ? styles.button : `${styles.button} ${styles.ghost}`} onClick={() => choose('buyer')}>Your sellers</button>
        <button type="button" className={`${styles.button} ${styles.ghost}`} aria-expanded={composing} onClick={() => setComposing(!composing)}>
          {composing ? 'Close' : scope === 'seller' ? 'New message to a buyer' : 'New message to a seller'}
        </button>
      </div>
      {composing && (scope === 'seller'
        ? <NewToBuyer onSent={() => { setComposing(false); void load(); }} />
        : <NewToSeller onSent={() => { setComposing(false); void load(); }} />)}
      {error && <p className={styles.error} role="alert">{error}</p>}
      {!tickets ? <p className={styles.muted}>Loading…</p> : !tickets.length ? (
        <p className={styles.muted}>{scope === 'seller' ? 'No conversations with buyers yet.' : 'No conversations with sellers yet.'}</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead><tr><th>Subject</th><th>Plugin</th><th>{scope === 'seller' ? 'Buyer' : 'Seller'}</th><th>Status</th><th>Last message</th><th /></tr></thead>
            <tbody>
              {tickets.map((row) => {
                const waiting = scope === 'seller' ? row.status === 'open' : row.status === 'answered';
                return (
                  <tr key={row.id}>
                    <td><strong>{row.subject}</strong><br /><span className={styles.muted}>{row.opened_by === 'seller' ? 'Started by the seller' : KIND[row.kind]}{row.refund_status !== 'none' ? ` · ${REFUND[row.refund_status]}` : ''}</span></td>
                    <td>{row.plugin_title}</td>
                    <td>{other(row)}</td>
                    <td><span className={`${styles.badge} ${waiting ? styles.pending : styles.active}`}>{row.status === 'closed' ? 'closed' : waiting ? 'needs your answer' : 'waiting for them'}</span></td>
                    <td>{when(row.last_message_at)}</td>
                    <td><button type="button" className={`${styles.button} ${styles.ghost}`} onClick={() => setOpen(open === row.id ? '' : row.id)}>{open === row.id ? 'Close' : 'Open'}</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {open && <Thread id={open} onChanged={() => void load()} />}
    </div>
  );
}

/** Pick one of this shop's paid orders, then write to its buyer (on react-wp.com when the purchase is there, else by email). */
function NewToBuyer({ onSent }: { onSent: () => void }) {
  const [orders, setOrders] = useState<DevOrder[] | null>(null);
  const [orderId, setOrderId] = useState('');
  useEffect(() => {
    listOrders().then((rows) => setOrders(rows.filter((row) => row.status === 'paid' || row.status === 'refunded'))).catch(() => setOrders([]));
  }, []);
  if (!orders) return <p className={styles.muted}>Loading your sales…</p>;
  if (!orders.length) return <p className={styles.hint}>No sales yet, so there is no buyer to write to.</p>;
  const order = orders.find((row) => row.id === orderId);
  return (
    <div className={styles.panel}>
      <div className={styles.field}>
        <label htmlFor="new-buyer-order">Which sale</label>
        <select id="new-buyer-order" className={styles.input} value={orderId} onChange={(event) => setOrderId(event.target.value)}>
          <option value="">Choose a sale…</option>
          {orders.map((row) => (
            <option key={row.id} value={row.id}>
              {row.dev_products?.title || 'Plugin'} · {when(row.paid_at || row.created_at)} · ${Number(row.amount).toFixed(2)}{row.platform_reported_at ? ' · on react-wp.com' : ''}
            </option>
          ))}
        </select>
      </div>
      {order && <BuyerMessage key={order.id} orderId={order.id} title={order.dev_products?.title || 'your plugin'} onSent={onSent} />}
    </div>
  );
}

/** Write to the developer of a plugin this account owns (a support conversation on react-wp.com). */
function NewToSeller({ onSent }: { onSent: () => void }) {
  const [plugins, setPlugins] = useState<SellerPlugin[] | null>(null);
  const [pluginId, setPluginId] = useState('');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    inboxSellers().then((result) => setPlugins(result.plugins || [])).catch((failure: unknown) => { setPlugins([]); setError(errorText(failure, 'Your purchases could not be read from react-wp.com.')); });
  }, []);
  const send = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await inboxAskSeller({ plugin_id: pluginId, subject: subject.trim(), message: message.trim() });
      onSent();
    } catch (failure) {
      setError(errorText(failure, 'The message was not sent.'));
    } finally {
      setBusy(false);
    }
  };
  if (!plugins) return <p className={styles.muted}>Loading the plugins you bought…</p>;
  if (!plugins.length) return error ? <p className={styles.error} role="alert">{error}</p> : <p className={styles.hint}>This account owns no plugin from another developer yet.</p>;
  return (
    <form className={styles.panel} onSubmit={send}>
      <div className={styles.field}>
        <label htmlFor="new-seller-plugin">Plugin</label>
        <select id="new-seller-plugin" className={styles.input} value={pluginId} disabled={busy} onChange={(event) => setPluginId(event.target.value)}>
          <option value="">Choose a plugin…</option>
          {plugins.map((row) => <option key={row.plugin_id} value={row.plugin_id}>{row.title} · {row.seller_name}</option>)}
        </select>
      </div>
      <div className={styles.field}>
        <label htmlFor="new-seller-subject">Subject</label>
        <input id="new-seller-subject" className={styles.input} maxLength={200} value={subject} disabled={busy} onChange={(event) => setSubject(event.target.value)} />
      </div>
      <div className={styles.field}>
        <label htmlFor="new-seller-message">Message</label>
        <textarea id="new-seller-message" className={styles.textarea} rows={4} maxLength={4000} value={message} disabled={busy} onChange={(event) => setMessage(event.target.value)} />
      </div>
      {error && <p className={styles.error} role="alert">{error}</p>}
      <button type="submit" className={styles.button} disabled={busy || !pluginId || subject.trim().length < 3 || message.trim().length < 10}>{busy ? 'Sending…' : 'Send'}</button>
    </form>
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
  const viewer = thread.role === 'buyer' ? 'buyer' : 'seller';
  const deciding = viewer === 'seller' && ticket.kind === 'refund' && ['requested', 'ruled_buyer'].includes(ticket.refund_status);
  const order = local?.order;
  const manual = Boolean(order && !['stripe', 'paypal', 'mollie', 'gocardless'].includes(order.provider));

  return (
    <section className={styles.panel} aria-label="Conversation">
      <h2 className={styles.panelTitle}>{ticket.subject}</h2>
      <p className={styles.muted}>{KIND[ticket.kind]} · {ticket.plugin_title} · {viewer === 'seller' ? ticket.buyer_name : ticket.seller_name || 'Seller'}{ticket.refund_status !== 'none' ? ` · refund ${REFUND[ticket.refund_status]}` : ''}</p>
      {thread.dispute?.status === 'ruled' && <p className={styles.warn}>Marketplace ruling: {thread.dispute.ruling_note}</p>}
      <ol>
        {thread.messages.map((row) => (
          <li key={row.id}><strong>{author(row.author_role, viewer)}</strong> <span className={styles.muted}>{when(row.created_at)}</span><p style={{ whiteSpace: 'pre-wrap', margin: '4px 0 10px' }}>{row.body}</p></li>
        ))}
      </ol>
      {ticket.status !== 'closed' && (
        <div className={styles.field}>
          <label htmlFor={`reply-${ticket.id}`}>Reply</label>
          <textarea id={`reply-${ticket.id}`} className={styles.textarea} maxLength={4000} value={reply} onChange={(event) => setReply(event.target.value)} disabled={busy !== ''} />
          <div className={styles.row}>
            <button type="button" className={styles.button} disabled={busy !== '' || !reply.trim()}
              onClick={() => void run('reply', async () => { await inboxReply(ticket.id, reply); setReply(''); return `Sent. The ${viewer === 'seller' ? 'buyer' : 'seller'} is told on react-wp.com.`; })}>
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
              <button type="button" className={`${styles.button} ${styles.danger}`} disabled={busy !== ''}
                onClick={() => {
                  if (reason.trim().length < 10) { setNote({ ok: false, text: 'Write your reason above first (at least 10 characters): the buyer reads it.' }); return; }
                  void run('decline', async () => { await inboxDecide({ ticket_id: ticket.id, decision: 'decline', reason }); return 'Declined. The buyer may ask the marketplace owner to rule.'; });
                }}>
                {busy === 'decline' ? 'Saving…' : 'Decline refund'}
              </button>
            )}
          </div>
        </div>
      )}
      {note && <p className={note.ok ? styles.notice : styles.error} role="status">{note.text}</p>}
    </section>
  );
}
