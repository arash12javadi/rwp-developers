/**
 * Payments for the developer shop, on the site's payment-gateway registry (server/payments/registry.mjs): the built-in Stripe
 * (cards) and NOWPayments (USDT), plus any gateway an active plugin registered and the owner switched on here.
 *
 * The amount is always the order's stored amount, in USD, read from the database on the server; the browser names a product and
 * a gateway, never a price. A payment is only believed after the gateway verified its own callback (or read the payment back on
 * return), and the database then checks that the amount covers the order (`dev_complete_order`).
 *
 * The helpers below with the old names (createStripeSession, stripePaidOrder, …) are thin wrappers over the core gateways, kept so
 * the rest of this plugin and its tests read the same.
 */
import { HttpError } from './supabase.mjs';
import { credentialStatus, getGateway, listGateways, publicGateway } from '../../../server/payments/registry.mjs';
import {
  stripeGateway, stripePaidEvent, stripeRefundEvents, verifyStripeSignature as verifyStripe,
} from '../../../server/payments/gateways/stripe.mjs';
import {
  createNowPaymentsInvoice as nowInvoice, nowPaymentsEvents, verifyNowPaymentsSignature as verifyNow,
} from '../../../server/payments/gateways/nowpayments.mjs';

export const PROVIDERS = ['stripe', 'nowpayments'];
export const PROVIDER_LABELS = { stripe: 'Card (Stripe)', nowpayments: 'USDT (NOWPayments)' };
const GATEWAY_ID = /^[a-z][a-z0-9_-]{1,30}$/;

/** Re-throws a core GatewayError as this plugin's HttpError (same status and sentence). */
const asHttp = (error) => (error && !(error instanceof HttpError) && Number.isInteger(error.status) ? new HttpError(error.status, error.message) : error);

/** The non-secret part of the settings, normalised. A gateway is on only when the owner switched it on. */
export function paymentsConfigFrom(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const stripe = value.stripe && typeof value.stripe === 'object' ? value.stripe : {};
  const now = value.nowpayments && typeof value.nowpayments === 'object' ? value.nowpayments : {};
  const extra = value.gateways && typeof value.gateways === 'object' ? value.gateways : {};
  return {
    stripe: { enabled: stripe.enabled === true },
    nowpayments: {
      enabled: now.enabled === true,
      sandbox: now.sandbox === true,
      pay_currency: /^[a-z0-9]{2,16}$/.test(String(now.pay_currency || '')) ? String(now.pay_currency) : 'usdttrc20',
    },
    // Gateways added by plugins, by id: only the switch lives here; their credentials are sealed in dev_secrets (gw:<id>:<field>).
    gateways: Object.fromEntries(Object.entries(extra)
      .filter(([id]) => GATEWAY_ID.test(id) && !PROVIDERS.includes(id))
      .map(([id, entry]) => [id, { enabled: entry?.enabled === true }])),
  };
}

/** What each built-in provider still needs before it can take a payment, given which secrets are stored. */
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

/* ------------------------------------------------------------------------------------- the registry */

/** Where a built-in gateway's fields have always been stored; a plugin gateway's go to `gw:<id>:<field>`. */
const LEGACY_SECRETS = {
  stripe: { secret_key: 'stripe_secret_key', webhook_secret: 'stripe_webhook_secret' },
  nowpayments: { api_key: 'nowpayments_api_key', ipn_secret: 'nowpayments_ipn_secret' },
};
export const gatewaySecretName = (gatewayId, field) => LEGACY_SECRETS[gatewayId]?.[field] || `gw:${gatewayId}:${field}`;

/** NOWPayments' two options are not secrets: they live in the settings row, as before. */
const settingsField = (config, gatewayId, field) => {
  if (gatewayId !== 'nowpayments') return undefined;
  if (field === 'pay_currency') return config.nowpayments.pay_currency;
  if (field === 'sandbox') return String(config.nowpayments.sandbox);
  return undefined;
};

/** The gateways this shop may offer: the two built-ins, then active plugins' gateways. */
export const shopGateways = () => listGateways({ scope: 'developers', builtIns: PROVIDERS });

export const gatewayEnabled = (config, gatewayId) => (PROVIDERS.includes(gatewayId)
  ? config[gatewayId]?.enabled === true
  : config.gateways?.[gatewayId]?.enabled === true);

/** The credentials a gateway is called with, opened from dev_secrets (and the settings row for NOWPayments' options). */
export async function gatewayCredentials({ readSecret, config, gateway }) {
  const credentials = {};
  for (const field of gateway.credentialFields) {
    const fromSettings = settingsField(config, gateway.id, field.name);
    credentials[field.name] = fromSettings !== undefined ? fromSettings : await readSecret(gatewaySecretName(gateway.id, field.name));
  }
  return credentials;
}

/**
 * Every gateway with its switch and what it still needs, for the Payments screen, the store and the "can this be sold" check.
 * `present` is the set of stored secret names (never a value).
 */
export async function gatewayChecks({ config, present }) {
  const gateways = await shopGateways();
  return gateways.map((gateway) => {
    const stored = Object.fromEntries(gateway.credentialFields.map((field) => {
      const fromSettings = settingsField(config, gateway.id, field.name);
      return [field.name, fromSettings !== undefined ? fromSettings : present.has(gatewaySecretName(gateway.id, field.name))];
    }));
    const status = credentialStatus(gateway, stored);
    const enabled = gatewayEnabled(config, gateway.id);
    return { ...publicGateway(gateway), enabled, missing: status.missing, ready: enabled && status.ready };
  });
}

/** One gateway this shop offers, or a 400. */
export async function shopGateway(id) {
  const gateway = getGateway(String(id || ''));
  if (!gateway || !(await shopGateways()).some((entry) => entry.id === gateway.id)) throw new HttpError(400, 'Choose a payment method.');
  return gateway;
}

/** The address a gateway calls back: the old ones for the built-ins (already registered at Stripe/NOWPayments), else the generic one. */
export const webhookUrl = (origin, gatewayId) => (PROVIDERS.includes(gatewayId)
  ? `${origin}/api/plugins/rwp-developers/webhook/${gatewayId}`
  : `${origin}/api/plugins/rwp-developers/webhook/gateway/${encodeURIComponent(gatewayId)}`);

/* ------------------------------------------------------------------------ the old helpers, on the core */

export const toCents = (amount) => Math.round(Number(amount) * 100);

/** Opens a Stripe Checkout session for one order. Returns `{ url, id }`. */
export async function createStripeSession({ secretKey, order, title, email, successUrl, cancelUrl, fetchImpl = fetch }) {
  try {
    const result = await stripeGateway.createCheckout({
      credentials: { secret_key: secretKey },
      order: { id: order.order_id, amount: order.amount, currency: 'USD', title, email },
      urls: { success: successUrl, cancel: cancelUrl },
      fetchImpl,
    });
    return { url: result.url, id: result.reference };
  } catch (error) {
    throw asHttp(error);
  }
}

/** Stripe-Signature over the raw body: `t=<unix>,v1=<hmac>`, within five minutes. */
export const verifyStripeSignature = (rawBody, header, secret, options = {}) => verifyStripe(rawBody, header, secret, options);

/** `{ orderId, ref, amount, currency }` for a paid Checkout session event, or null for anything else. */
export function stripePaidOrder(event) {
  if (event?.type !== 'checkout.session.completed' && event?.type !== 'checkout.session.async_payment_succeeded') return null;
  const paid = stripePaidEvent(event.data?.object);
  return paid ? { orderId: paid.orderId, ref: paid.reference, amount: paid.amount, currency: paid.currency.toLowerCase() } : null;
}

/** Refunds part or all of a Stripe payment, with an idempotency key. Returns Stripe's refund (`{ id, status, … }`). */
export async function createStripeRefund({ secretKey, paymentIntent, amount, metadata = {}, idempotencyKey, fetchImpl = fetch }) {
  try {
    const refund = await stripeGateway.refund({ credentials: { secret_key: secretKey }, reference: paymentIntent, amount, currency: 'USD', metadata, idempotencyKey, fetchImpl });
    return refund.raw;
  } catch (error) {
    throw asHttp(error);
  }
}

/** The refunds a verified Stripe event reports: `[{ ref, refundId, amount, refundRequest }]`. */
export const stripeRefunds = (event) => stripeRefundEvents(event).map((refund) => ({
  ref: refund.reference, refundId: refund.refundId, amount: refund.amount, refundRequest: refund.refundRequest,
}));

export async function createNowPaymentsInvoice({ apiKey, sandbox, payCurrency, order, title, callbackUrl, successUrl, cancelUrl, fetchImpl = fetch }) {
  try {
    const invoice = await nowInvoice({
      apiKey, sandbox, fetchImpl,
      body: {
        price_amount: Number(order.amount), price_currency: 'usd', pay_currency: payCurrency, order_id: order.order_id,
        order_description: title, ipn_callback_url: callbackUrl, success_url: successUrl, cancel_url: cancelUrl,
      },
    });
    const url = String(invoice.invoice_url || '');
    if (!/^https:\/\//i.test(url)) throw new HttpError(502, 'NOWPayments did not return an invoice address.');
    return { url, id: String(invoice.id || '') };
  } catch (error) {
    throw asHttp(error);
  }
}

/** NOWPayments IPN: HMAC-SHA512 of the key-sorted JSON body, over the IPN secret. */
export const verifyNowPaymentsSignature = (rawBody, header, secret) => verifyNow(rawBody, header, secret);

/** `{ orderId, ref, amount, currency }` for a finished NOWPayments payment, null for any other state. */
export function nowPaymentsPaidOrder(payload) {
  const paid = nowPaymentsEvents(payload).find((event) => event.type === 'paid');
  return paid ? { orderId: paid.orderId, ref: paid.reference, amount: paid.amount, currency: paid.currency.toLowerCase() } : null;
}

export { asHttp as gatewayErrorToHttp };
