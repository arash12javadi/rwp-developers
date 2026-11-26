import type { PaymentStatus } from './types';

/**
 * Whether a buyer could pay for a priced plugin right now, as the Plugins screen shows it: at least one payment method switched
 * on with all its credentials (Stripe, NOWPayments, or one a plugin added, such as PayPal, Mollie or GoCardless from RWP Payments
 * Plus), and the licence key pair. The browser's copy of `assertReadyToSell` (server/store.mjs), which decides in the end.
 */
export function readyToSell(status: Pick<PaymentStatus, 'checks' | 'gateways' | 'license_public_key'>): boolean {
  const method = status.checks.stripe.ready || status.checks.nowpayments.ready || (status.gateways || []).some((gateway) => gateway.ready);
  return method && Boolean(status.license_public_key);
}
