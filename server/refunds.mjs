/**
 * Refunds in the developer shop. The shop's owner is the seller: a buyer asks from "My purchases", the owner agrees or declines (a
 * decline is final), and the owner can refund any paid order directly. The rules (whose order it is, how much is left, one open request
 * per order, a claim before money moves, a full refund revokes the licence) are SQL (`dev_refund_*`, service role only).
 *
 * Moving the money: a Stripe payment is refunded through Stripe's API with the shop's own key, once the refund is approved and claimed,
 * with an idempotency key. A NOWPayments (USDT) payment has no refund API: the owner sends it back from their wallet and records it
 * here with a reference. A refund made in the Stripe dashboard is recorded from the webhook.
 */
import { HttpError, rpc, select } from './supabase.mjs';
import { readSecret } from './secrets.mjs';
import { createStripeRefund } from './payments.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const enc = encodeURIComponent;
const text = (value, max = 2000) => String(value ?? '').trim().slice(0, max);
const uuid = (value, what) => {
  const id = String(value || '').trim();
  if (!UUID.test(id)) throw new HttpError(400, `Choose ${what} first.`);
  return id;
};

/** Empty means "everything that is left"; otherwise a positive amount with two decimals. */
export const refundAmount = (value) => {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) throw new HttpError(400, 'Enter an amount above zero, or leave it empty to refund everything that is left.');
  return Math.round(amount * 100) / 100;
};

/** Stripe refunds through the API; NOWPayments (and anything else) is sent by hand and recorded. */
export const refundMethod = (provider) => (provider === 'stripe' ? 'stripe' : 'manual');

const COLUMNS = 'id,order_id,amount,currency,reason,owner_note,status,origin,revoke_license,gateway_refund_id,payout_reference,error,decided_at,refunded_at,created_at,updated_at';

/** The signed-in buyer's own refund requests. */
export async function buyerRefunds(ctx, user) {
  const rows = await select(ctx, `dev_refunds?buyer_id=eq.${enc(user.id)}&select=${COLUMNS}&order=created_at.desc&limit=100`, 'service');
  return { refunds: rows };
}

/** The owner's list: every refund (open first) with the order, the plugin and the buyer's name. */
export async function ownerRefunds(ctx) {
  const refunds = await select(ctx, `dev_refunds?select=${COLUMNS},buyer_id&order=updated_at.desc&limit=300`, 'service');
  const orderIds = [...new Set(refunds.map((row) => row.order_id))];
  const orders = orderIds.length ? await select(ctx, `dev_orders?id=in.(${orderIds.join(',')})&select=id,product_id,provider,amount,refunded_amount,currency,created_at`, 'service') : [];
  const productIds = [...new Set(orders.map((row) => row.product_id))];
  const products = productIds.length ? await select(ctx, `dev_products?id=in.(${productIds.join(',')})&select=id,title,slug`, 'service') : [];
  const buyerIds = [...new Set(refunds.map((row) => row.buyer_id).filter((id) => UUID.test(String(id || ''))))];
  const profiles = buyerIds.length ? await select(ctx, `profiles?id=in.(${buyerIds.join(',')})&select=id,display_name`, 'service').catch(() => []) : [];
  const rank = { approved: 0, processing: 0, requested: 1 };
  return {
    refunds: refunds.map((row) => {
      const order = orders.find((entry) => entry.id === row.order_id) || null;
      const { buyer_id: buyerId, ...rest } = row;
      return {
        ...rest,
        order,
        product: products.find((entry) => entry.id === order?.product_id) || null,
        buyer_name: profiles.find((entry) => entry.id === buyerId)?.display_name || '—',
        refund_method: refundMethod(order?.provider),
      };
    }).sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9)),
  };
}

export async function requestRefund(ctx, user, body) {
  const row = await rpc(ctx, 'dev_refund_open', {
    p_order: uuid(body?.order_id, 'the order'), p_buyer: user.id, p_reason: text(body?.reason), p_amount: refundAmount(body?.amount),
  }, 'service');
  return { refund: row };
}

export async function cancelRefund(ctx, user, body) {
  return { refund: await rpc(ctx, 'dev_refund_cancel', { p_refund: uuid(body?.refund_id, 'a request'), p_buyer: user.id }, 'service') };
}

/** The owner's answer. Approving a Stripe refund sends it at once; approving a NOWPayments refund waits for the owner to send it. */
export async function decideRefund(ctx, owner, body, { fetchImpl = fetch } = {}) {
  const approve = body?.approve === true;
  const note = text(body?.note);
  if (!approve && note.length < 5) throw new HttpError(400, 'Say why the refund is declined: the buyer reads this, and the decision is final.');
  const row = await rpc(ctx, 'dev_refund_decide', {
    p_refund: uuid(body?.refund_id, 'a request'), p_actor: owner.id, p_approve: approve, p_note: note, p_revoke: body?.revoke === true,
  }, 'service');
  if (!approve) return { refund: row, sent: false };
  return sendApproved(ctx, row, owner, { fetchImpl });
}

/** The owner refunds an order directly. `manual: true` records money already returned elsewhere (needs a reference). */
export async function issueRefund(ctx, owner, body, { fetchImpl = fetch } = {}) {
  const manual = body?.manual === true;
  const reference = text(body?.payout_reference, 300);
  if (manual && reference.length < 3) throw new HttpError(400, 'Say how the money was returned (a transaction hash or a short note).');
  const row = await rpc(ctx, 'dev_refund_issue', {
    p_order: uuid(body?.order_id, 'the order'), p_actor: owner.id, p_amount: refundAmount(body?.amount), p_note: text(body?.note), p_revoke: body?.revoke === true,
  }, 'service');
  if (manual) return markRefunded(ctx, owner, { refund_id: row.id, payout_reference: reference });
  return sendApproved(ctx, row, owner, { fetchImpl });
}

/** Tries an approved Stripe refund again. */
export async function retryRefund(ctx, owner, body, { fetchImpl = fetch } = {}) {
  const row = (await select(ctx, `dev_refunds?id=eq.${enc(uuid(body?.refund_id, 'a request'))}&select=*`, 'service'))[0];
  if (!row) throw new HttpError(404, 'That refund does not exist.');
  return sendApproved(ctx, row, owner, { fetchImpl });
}

/** Records a refund the owner sent by hand (USDT from their wallet, or anything refunded outside this site). */
export async function markRefunded(ctx, owner, body) {
  const reference = text(body?.payout_reference, 300);
  if (reference.length < 3) throw new HttpError(400, 'Say how the money was returned (a transaction hash or a short note).');
  const settled = await rpc(ctx, 'dev_refund_settle', {
    p_refund: uuid(body?.refund_id, 'a request'), p_gateway_refund_id: null, p_payout_reference: reference, p_actor: owner.id,
  }, 'service');
  return { refund: settled, sent: true, method: 'manual' };
}

/** Claim, refund at Stripe with an idempotency key, settle; or put it back with Stripe's reason. NOWPayments waits for the owner. */
export async function sendApproved(ctx, row, owner, { fetchImpl = fetch } = {}) {
  const order = (await select(ctx, `dev_orders?id=eq.${enc(row.order_id)}&select=provider`, 'service'))[0];
  if (refundMethod(order?.provider) !== 'stripe') {
    return { refund: row, sent: false, method: 'manual', message: 'Approved. This order was paid with NOWPayments (USDT), which has no refund API: send the money back from your wallet, then press "Mark as refunded" with the transaction hash.' };
  }
  const claimed = await rpc(ctx, 'dev_refund_claim', { p_refund: row.id }, 'service');
  let refund;
  try {
    const secretKey = await readSecret(ctx, 'stripe_secret_key');
    if (!secretKey) throw new HttpError(501, 'The Stripe secret key is not set under Developers → Payments & key.');
    refund = await createStripeRefund({
      secretKey, paymentIntent: claimed.provider_ref, amount: claimed.amount,
      metadata: { rwp_refund: claimed.id, order_id: claimed.order_id },
      idempotencyKey: `rwpd-refund-${claimed.id}-${String(claimed.updated_at || '').replace(/[^0-9A-Za-z]/g, '')}`,
      fetchImpl,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Stripe could not be reached.';
    await rpc(ctx, 'dev_refund_release', { p_refund: claimed.id, p_error: message }, 'service').catch(() => {});
    throw new HttpError(error?.status === 409 || error?.status === 501 ? error.status : 502, `The refund was approved but not sent: ${message} Nothing was refunded; try again from Sales & licences.`);
  }
  try {
    const settled = await rpc(ctx, 'dev_refund_settle', { p_refund: claimed.id, p_gateway_refund_id: refund.id, p_payout_reference: '', p_actor: owner?.id || null }, 'service');
    return { refund: settled, sent: true, method: 'stripe', refund_id: refund.id };
  } catch (error) {
    throw new HttpError(500, `Stripe refunded the payment (refund ${refund.id}), but recording it here failed: ${error instanceof Error ? error.message : 'unknown error'}. Do not refund again: the Stripe webhook records it, or use "Mark as refunded" with that refund id.`);
  }
}

/** Refunds Stripe reported in a verified webhook. Never throws for a refund that is not this shop's. */
export async function recordStripeRefunds(ctx, refunds) {
  const results = [];
  for (const refund of refunds) {
    if (!refund.ref && !refund.refundRequest) continue;
    const settled = await rpc(ctx, 'dev_refund_from_gateway', {
      p_provider_ref: refund.ref, p_gateway_refund_id: refund.refundId, p_amount: refund.amount, p_refund: refund.refundRequest,
    }, 'service');
    results.push({ refund: refund.refundId, recorded: Boolean(settled?.recorded), skipped: settled?.recorded ? '' : String(settled?.skipped || '') });
  }
  return results;
}
