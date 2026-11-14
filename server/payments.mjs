/**
 * Payments for the developer shop: Stripe Checkout (cards) and NOWPayments (USDT), each with the developer's own
 * account. The amount is always the order's stored amount, in USD, read from the database on the server; the browser
 * names a product and a provider, never a price. A payment is only believed after the provider's own signature on its
 * callback verifies, and the database then checks that the amount covers the order (`dev_complete_order`).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { HttpError } from './supabase.mjs';

export const PROVIDERS = ['stripe', 'nowpayments'];
export const PROVIDER_LABELS = { stripe: 'Card (Stripe)', nowpayments: 'USDT (NOWPayments)' };

const NOWPAYMENTS = { live: 'https://api.nowpayments.io/v1', sandbox: 'https://api-sandbox.nowpayments.io/v1' };

/** The non-secret part of the settings, normalised. A provider is on only when the owner switched it on. */
export function paymentsConfigFrom(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const stripe = value.stripe && typeof value.stripe === 'object' ? value.stripe : {};
  const now = value.nowpayments && typeof value.nowpayments === 'object' ? value.nowpayments : {};
  return {
    stripe: { enabled: stripe.enabled === true },
    nowpayments: {
      enabled: now.enabled === true,
      sandbox: now.sandbox === true,
      pay_currency: /^[a-z0-9]{2,16}$/.test(String(now.pay_currency || '')) ? String(now.pay_currency) : 'usdttrc20',
    },
  };
}

/** What each provider still needs before it can take a payment, given which secrets are stored. */
export function paymentChecks(config, secrets) {
  const needs = {
    stripe: ['stripe_secret_key', 'stripe_webhook_secret'],
    nowpayments: ['nowpayments_api_key', 'nowpayments_ipn_secret'],
  };
  return Object.fromEntries(PROVIDERS.map((provider) => {
    const missing = needs[provider].filter((name) => !secrets[name]);
    return [provider, { enabled: config[provider].enabled, missing, ready: config[provider].enabled && missing.length === 0 }];
  }));
}

export const toCents = (amount) => Math.round(Number(amount) * 100);

const form = (value, prefix = '', pairs = []) => {
  if (value === undefined || value === null) return pairs;
  if (typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) form(inner, prefix ? `${prefix}[${key}]` : key, pairs);
  } else {
    pairs.push([prefix, String(value)]);
  }
  return pairs;
};

/**
 * Opens a Stripe Checkout session for one order. `successUrl` and `cancelUrl` are built by the caller from the site's
 * own origin. Returns `{ url, id }`.
 */
export async function createStripeSession({ secretKey, order, title, email, successUrl, cancelUrl, fetchImpl = fetch }) {
  const params = form({
    mode: 'payment',
    client_reference_id: order.order_id,
    customer_email: email || undefined,
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { order_id: order.order_id },
    payment_intent_data: { metadata: { order_id: order.order_id } },
    line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: toCents(order.amount), product_data: { name: title } } }],
  });
  const response = await fetchImpl('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new HttpError(502, `Stripe: ${payload.error?.message || `request failed with HTTP ${response.status}`}`);
  if (!payload.url) throw new HttpError(502, 'Stripe did not return a checkout address.');
  return { url: String(payload.url), id: String(payload.id || '') };
}

/** Stripe-Signature over the raw body: `t=<unix>,v1=<hmac>`, within five minutes. */
export function verifyStripeSignature(rawBody, header, secret, { toleranceSeconds = 300, now = Date.now() } = {}) {
  if (!secret || !header) return false;
  const items = String(header).split(',').map((part) => part.split('='));
  const timestamp = Number(items.find(([key]) => key === 't')?.[1]);
  const signatures = items.filter(([key, value]) => key === 'v1' && value).map(([, value]) => value);
  if (!timestamp || !signatures.length || Math.abs(now / 1000 - timestamp) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${Buffer.from(rawBody).toString('utf8')}`).digest();
  return signatures.some((signature) => {
    const given = Buffer.from(signature, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

/**
 * What a verified Stripe event means for the shop: `{ orderId, ref, amount, currency }` for a paid Checkout session, or
 * null for anything else (other events are acknowledged and ignored).
 */
export function stripePaidOrder(event) {
  if (event?.type !== 'checkout.session.completed' && event?.type !== 'checkout.session.async_payment_succeeded') return null;
  const session = event.data?.object;
  if (!session || session.payment_status !== 'paid') return null;
  const orderId = String(session.client_reference_id || session.metadata?.order_id || '');
  if (!orderId) return null;
  return {
    orderId,
    ref: String(session.payment_intent || session.id || ''),
    amount: Number(session.amount_total) / 100,
    currency: String(session.currency || '').toLowerCase(),
  };
}

export async function createNowPaymentsInvoice({ apiKey, sandbox, payCurrency, order, title, callbackUrl, successUrl, cancelUrl, fetchImpl = fetch }) {
  const response = await fetchImpl(`${sandbox ? NOWPAYMENTS.sandbox : NOWPAYMENTS.live}/invoice`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      price_amount: Number(order.amount),
      price_currency: 'usd',
      pay_currency: payCurrency,
      order_id: order.order_id,
      order_description: title,
      ipn_callback_url: callbackUrl,
      success_url: successUrl,
      cancel_url: cancelUrl,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = String(payload.message || payload.error || '');
    if (/minimal|minimum/i.test(detail)) throw new HttpError(422, `NOWPayments refused this invoice: ${detail} Nothing was charged.`);
    throw new HttpError(502, `NOWPayments: ${detail || `request failed with HTTP ${response.status}`}`);
  }
  const url = String(payload.invoice_url || '');
  if (!/^https:\/\//i.test(url)) throw new HttpError(502, 'NOWPayments did not return an invoice address.');
  return { url, id: String(payload.id || '') };
}

const canonical = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
};

/** NOWPayments IPN: HMAC-SHA512 of the key-sorted JSON body, over the IPN secret. */
export function verifyNowPaymentsSignature(rawBody, header, secret) {
  if (!secret || !header) return false;
  let value;
  try { value = JSON.parse(Buffer.from(rawBody).toString('utf8')); } catch { return false; }
  const expected = createHmac('sha512', secret).update(canonical(value)).digest();
  const given = Buffer.from(String(header), 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** `{ orderId, ref, amount, currency }` for a finished NOWPayments payment, null for any other state. */
export function nowPaymentsPaidOrder(payload) {
  if (!payload || payload.payment_status !== 'finished') return null;
  const orderId = String(payload.order_id || '');
  if (!orderId) return null;
  return {
    orderId,
    ref: String(payload.payment_id || ''),
    amount: Number(payload.price_amount),
    currency: String(payload.price_currency || '').toLowerCase(),
  };
}
