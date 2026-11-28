import { useEffect, useState, type FormEvent } from 'react';
import { buyerContact, emailBuyer, inboxOpen } from '../lib/api';
import type { BuyerContact } from '../lib/types';
import styles from '../developers.module.css';

const errorText = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);

/**
 * The buyer of one order: name and email address (read on demand, owner only) and a message box. When the purchase is on the
 * buyer's react-wp.com account the message starts a conversation there (Developers → Messages, and the buyer's Messages on
 * react-wp.com, with an email notice); otherwise, or when chosen, it is emailed through the site's email settings and replies
 * come back to your own address.
 */
export default function BuyerMessage({ orderId, title, onSent, onClose }: {
  orderId: string;
  title: string;
  onSent?: (text: string) => void;
  onClose?: () => void;
}) {
  const [contact, setContact] = useState<BuyerContact | null>(null);
  const [error, setError] = useState('');
  const [via, setVia] = useState<'platform' | 'email'>('email');
  const [subject, setSubject] = useState(`About your purchase of ${title}`);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => {
    let live = true;
    buyerContact(orderId)
      .then((result) => { if (live) { setContact(result); setVia(result.on_platform ? 'platform' : 'email'); } })
      .catch((failure: unknown) => { if (live) setError(errorText(failure, 'The buyer could not be read.')); });
    return () => { live = false; };
  }, [orderId]);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNote('');
    try {
      if (via === 'platform') {
        await inboxOpen({ order_id: orderId, subject: subject.trim(), message: message.trim() });
      } else {
        await emailBuyer({ order_id: orderId, subject: subject.trim(), message: message.trim() });
      }
      const text = via === 'platform'
        ? 'Sent. The conversation is under Developers → Messages; the buyer reads it on react-wp.com and gets an email about it.'
        : 'Emailed. Replies come to your own email address.';
      setMessage('');
      setNote(text);
      onSent?.(text);
    } catch (failure) {
      setError(errorText(failure, 'The message was not sent.'));
    } finally {
      setBusy(false);
    }
  };

  if (!contact) return error ? <p className={styles.error} role="alert">{error}</p> : <p className={styles.muted}>Loading the buyer…</p>;

  return (
    <form className={styles.panel} onSubmit={send} aria-label={`Message the buyer of ${title}`}>
      <p className={styles.hint}>
        <strong>{contact.name || 'Buyer'}</strong>
        {contact.email ? <> · <a href={`mailto:${contact.email}`}>{contact.email}</a></> : ' · no email address on this site'}
        {' · '}{contact.on_platform ? 'this purchase is on their react-wp.com account' : 'not on a react-wp.com account (they can claim the key there)'}
      </p>
      <fieldset style={{ border: 0, margin: 0, padding: 0 }}>
        <legend className={styles.muted}>Send it</legend>
        <label>
          <input type="radio" name={`via-${orderId}`} checked={via === 'platform'} disabled={!contact.on_platform || busy} onChange={() => setVia('platform')} />{' '}
          As a conversation on react-wp.com
        </label>{' '}
        <label>
          <input type="radio" name={`via-${orderId}`} checked={via === 'email'} disabled={!contact.email || busy} onChange={() => setVia('email')} />{' '}
          As an email
        </label>
      </fieldset>
      <div className={styles.field}>
        <label htmlFor={`subject-${orderId}`}>Subject</label>
        <input id={`subject-${orderId}`} className={styles.input} maxLength={200} value={subject} disabled={busy} onChange={(event) => setSubject(event.target.value)} />
      </div>
      <div className={styles.field}>
        <label htmlFor={`message-${orderId}`}>Message</label>
        <textarea id={`message-${orderId}`} className={styles.textarea} rows={4} maxLength={4000} value={message} disabled={busy} onChange={(event) => setMessage(event.target.value)} />
      </div>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {note && <p className={styles.notice} role="status">{note}</p>}
      <div className={styles.row}>
        <button type="submit" className={styles.button} disabled={busy || message.trim().length < 10 || subject.trim().length < 3 || (via === 'email' && !contact.email)}>
          {busy ? 'Sending…' : 'Send'}
        </button>
        {onClose && <button type="button" className={`${styles.button} ${styles.ghost}`} disabled={busy} onClick={onClose}>Close</button>}
      </div>
      {message.trim().length > 0 && message.trim().length < 10 && <p className={styles.muted}>Write at least 10 characters.</p>}
    </form>
  );
}
