/**
 * What this shop tells react-wp.com, and what it publishes for the buyers' sites. Every call to react-wp.com goes through the
 * account link (`platformRequest`, site token sealed, `developer/*` paths only) and never fails the shop's own action: an error
 * is stored and retried from the admin status.
 *
 *   - **Purchases** (`reportPurchase`): a buyer who pressed Buy on react-wp.com arrives with `?rwp_ref=`; the order keeps it
 *     (`dev_orders.platform_ref`) and, once paid, the sale is reported (`developer/purchase`) so it shows under the buyer's
 *     My purchases there. The key itself is the proof: react-wp.com checks its signature with this shop's public key.
 *   - **Revocations**: `signedRevocationList` is the public list at `GET store/revoked` (`RWPDCRL1|<issued_at>|<serials>`,
 *     signed with this shop's licence key pair), and newly revoked serials are pushed (`developer/revocations`).
 *   - **Refund notices** (`afterRefundSettled`): the buyer is emailed through core `sendPluginMail` (this plugin's own sender
 *     row, else the site's Settings → Integrations → Email; the credentials stay in core and are never returned).
 *   - **Inbox**: the conversations react-wp.com holds about this shop's plugins (pre-sale questions, support, refund requests),
 *     read and answered from Developers → Messages. A refund is decided here, where the money is: approve refunds the order
 *     through its own gateway (or records a manual refund) and revokes the key; decline needs a written reason.
 *   - **Protected delivery**: a priced plugin is handed to a buyer compiled, obfuscated and watermarked with the licence serial
 *     (core `protectPluginZip`), cached per licence and version; `signedPackage` describes it for a buyer's site
 *     (`RWPDPKG1|plugin|version|domain|sha256|exp`, the same key pair, so the site checks it with the public key react-wp.com
 *     delivered with the licence).
 */
import { platformRequest, LicenseLinkError } from '../../../server/licenseLink.mjs';
import { sendPluginMail } from '../../../server/mailer.mjs';
import { DEVELOPERS_EMAIL_CONFIG_KEY } from '../../../server/pluginIntegrationAccess.mjs';
import { signPayload } from '../../../server/licenseCrypto.mjs';
import { sha256Hex } from '../../../server/releaseSource.mjs';
import { protectPluginZip } from '../../../server/pluginProtect.mjs';
import { HttpError, readPackage, select, signedPackageUrl, update, uploadPackage } from './supabase.mjs';
import { licenseKeys } from './secrets.mjs';
import { serviceLinkIo } from './listing.mjs';

const enc = encodeURIComponent;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF = /^[A-Za-z0-9_-]{16,100}$/;
const text = (value, max) => String(value ?? '').trim().slice(0, max);
const errorText = (error) => (error instanceof Error ? error.message : 'react-wp.com could not be reached.').slice(0, 300);

export const CRL_PREFIX = 'RWPDCRL1';
export const PACKAGE_PREFIX = 'RWPDPKG1';
export const PACKAGE_TTL_MS = 10 * 60 * 1000;

/** The buyer reference from the store address, or '' when it is not one react-wp.com could have made. */
export const cleanRef = (value) => (REF.test(String(value || '')) ? String(value) : '');

// ---------------------------------------------------------------------------------------------------- purchases

/** Keeps the buyer reference on a new order (before it is paid). */
export async function rememberRef(ctx, orderId, ref) {
  const clean = cleanRef(ref);
  if (!clean || !UUID.test(String(orderId || ''))) return;
  await update(ctx, 'dev_orders', `id=eq.${enc(orderId)}&status=eq.pending`, { platform_ref: clean }, 'service').catch(() => {});
}

/**
 * Reports one paid order to react-wp.com when it carries a buyer reference and its product is listed there. Never throws.
 * Returns `{ reported, reason }`.
 */
export async function reportPurchase(ctx, orderId, { io = serviceLinkIo(ctx), fetchImpl } = {}) {
  try {
    const [order] = await select(ctx, `dev_orders?id=eq.${enc(orderId)}&select=id,product_id,provider,amount,currency,status,platform_ref,platform_reported_at`, 'service');
    if (!order || order.status !== 'paid' || !order.platform_ref || order.platform_reported_at) return { reported: false, reason: 'nothing_to_report' };
    const [license] = await select(ctx, `dev_licenses?order_id=eq.${enc(order.id)}&select=license_key,domain`, 'service');
    const [product] = await select(ctx, `dev_products?id=eq.${enc(order.product_id)}&select=slug`, 'service');
    const [listing] = await select(ctx, `dev_listings?product_id=eq.${enc(order.product_id)}&select=plugin_id`, 'service').catch(() => []);
    if (!license || !product || !listing?.plugin_id) return { reported: false, reason: 'not_listed' };
    const answer = await platformRequest({
      io, path: 'developer/purchase', method: 'POST', timeoutMs: 15_000, ...(fetchImpl ? { fetchImpl } : {}),
      body: {
        plugin: product.slug, license_key: license.license_key, buyer_ref: order.platform_ref, order_ref: order.id,
        amount: Number(order.amount) || 0, currency: order.currency, gateway: order.provider, domains: license.domain ? [license.domain] : [],
      },
    });
    // Accepted, already known, or no buyer to match (the reference expired): either way it is not sent again.
    await update(ctx, 'dev_orders', `id=eq.${enc(order.id)}`, {
      platform_reported_at: new Date().toISOString(), platform_ref: '',
      platform_error: answer.body?.recorded ? '' : `react-wp.com did not match a buyer (${String(answer.body?.reason || 'unknown')}).`,
    }, 'service');
    return { reported: Boolean(answer.body?.recorded), reason: answer.body?.recorded ? '' : String(answer.body?.reason || '') };
  } catch (error) {
    await update(ctx, 'dev_orders', `id=eq.${enc(orderId)}`, { platform_error: errorText(error) }, 'service').catch(() => {});
    // A refusal about this order (4xx) is final; anything else is retried.
    if (error instanceof LicenseLinkError && error.status >= 400 && error.status < 500 && error.status !== 401 && error.status !== 429) {
      await update(ctx, 'dev_orders', `id=eq.${enc(orderId)}`, { platform_ref: '' }, 'service').catch(() => {});
    }
    return { reported: false, reason: errorText(error) };
  }
}

/** Paid orders whose report is still due (a few per call), from the admin status. */
export async function reportPendingPurchases(ctx, { io, fetchImpl, max = 5 } = {}) {
  const rows = await select(ctx, `dev_orders?status=eq.paid&platform_ref=neq.&platform_reported_at=is.null&select=id&order=paid_at.asc&limit=${max}`, 'service').catch(() => []);
  let reported = 0;
  for (const row of rows) {
    if ((await reportPurchase(ctx, row.id, { ...(io ? { io } : {}), fetchImpl })).reported) reported += 1;
  }
  return reported;
}

// ---------------------------------------------------------------------------------------------------- revocations

let listCache = { at: 0, body: null };
export const resetRevocationCache = () => { listCache = { at: 0, body: null }; };

/** The public, signed list of every revoked serial of this shop. Cached for a minute. */
export async function signedRevocationList(ctx, { now = new Date() } = {}) {
  if (listCache.body && now.getTime() - listCache.at < 60_000) return listCache.body;
  const rows = await select(ctx, 'dev_licenses?status=eq.revoked&select=serial&limit=50000', 'service');
  const serials = [...new Set(rows.map((row) => String(row.serial)))].sort();
  const { privateKey } = await licenseKeys(ctx);
  const issued = now.toISOString();
  const body = { format: CRL_PREFIX, issued_at: issued, serials, signature: signPayload(`${CRL_PREFIX}|${issued}|${serials.join(',')}`, privateKey) };
  listCache = { at: now.getTime(), body };
  return body;
}

/** Tells react-wp.com about revoked serials it was not told about yet (per listed product). Never throws. */
export async function pushRevocations(ctx, { io = serviceLinkIo(ctx), fetchImpl } = {}) {
  try {
    const rows = await select(ctx, 'dev_licenses?status=eq.revoked&platform_revoked_at=is.null&select=id,serial,product_id&limit=500', 'service');
    if (!rows.length) return { pushed: 0 };
    const listed = new Set((await select(ctx, 'dev_listings?plugin_id=not.is.null&select=product_id', 'service').catch(() => [])).map((row) => row.product_id));
    const byProduct = new Map();
    for (const row of rows) {
      if (!listed.has(row.product_id)) continue;
      byProduct.set(row.product_id, [...(byProduct.get(row.product_id) || []), row]);
    }
    let pushed = 0;
    for (const [productId, licences] of byProduct) {
      const [product] = await select(ctx, `dev_products?id=eq.${enc(productId)}&select=slug`, 'service');
      if (!product) continue;
      await platformRequest({ io, path: 'developer/revocations', method: 'POST', timeoutMs: 15_000, ...(fetchImpl ? { fetchImpl } : {}), body: { plugin: product.slug, serials: licences.map((row) => row.serial) } });
      await update(ctx, 'dev_licenses', `id=in.(${licences.map((row) => row.id).join(',')})`, { platform_revoked_at: new Date().toISOString() }, 'service');
      pushed += licences.length;
    }
    resetRevocationCache();
    return { pushed };
  } catch (error) {
    return { pushed: 0, error: errorText(error) };
  }
}

// ---------------------------------------------------------------------------------------------------- refund notices

/** The buyer's address on this site (the profile, else Supabase Auth with the server key). */
async function buyerEmail(ctx, userId) {
  const [profile] = await select(ctx, `profiles?id=eq.${enc(userId)}&select=email`, 'service').catch(() => []);
  if (String(profile?.email || '').includes('@')) return String(profile.email).trim();
  if (!ctx.supabase?.secretKey) return '';
  const response = await fetch(`${String(ctx.supabase.url).replace(/\/$/, '')}/auth/v1/admin/users/${enc(userId)}`, {
    headers: { apikey: ctx.supabase.secretKey, Authorization: `Bearer ${ctx.supabase.secretKey}` },
  }).catch(() => null);
  if (!response?.ok) return '';
  return String((await response.json().catch(() => ({}))).email || '').trim();
}

const escape = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * After a refund is settled: email the buyer, and tell react-wp.com when the key was revoked. Never throws, so a refund
 * that was sent is never reported as failed because a notice could not go out. `deps.send` is a test seam.
 */
export async function afterRefundSettled(ctx, settled, { deps = {} } = {}) {
  const outcome = { emailed: false, pushed: 0 };
  try {
    const [order] = await select(ctx, `dev_orders?id=eq.${enc(settled?.order_id)}&select=id,buyer_id,product_id,amount,refunded_amount,currency,status`, 'service');
    if (!order) return outcome;
    const [product] = await select(ctx, `dev_products?id=eq.${enc(order.product_id)}&select=title`, 'service').catch(() => []);
    const [license] = await select(ctx, `dev_licenses?order_id=eq.${enc(order.id)}&select=status`, 'service').catch(() => []);
    const revoked = license?.status === 'revoked';
    const to = await buyerEmail(ctx, order.buyer_id);
    if (to) {
      const amount = Number(settled?.amount || 0).toFixed(2);
      const title = String(product?.title || 'your plugin');
      const lines = [
        `Your refund of ${amount} ${String(order.currency || 'usd').toUpperCase()} for ${title} has been sent.`,
        revoked ? 'The licence key of this purchase no longer works and its updates have stopped.' : 'Your licence key keeps working.',
        'It can take a few days for the money to show, depending on how you paid.',
      ];
      const send = deps.send || ((message) => sendPluginMail('rwp-developers', DEVELOPERS_EMAIL_CONFIG_KEY, ctx, message));
      const result = await send({
        to: [to],
        subject: `Refund for ${title}`,
        text: lines.join('\n\n'),
        html: lines.map((line) => `<p>${escape(line)}</p>`).join(''),
      });
      outcome.emailed = Boolean(result?.sent);
    }
    if (revoked) outcome.pushed = (await (deps.push || pushRevocations)(ctx)).pushed || 0;
  } catch {
    // A notice that could not go out does not undo the refund.
  }
  return outcome;
}

// ---------------------------------------------------------------------------------------------------- the inbox

const asHttp = (error) => (error instanceof LicenseLinkError ? new HttpError(error.status, error.message) : error);
const inboxCall = async (ctx, path, method, body, { io = serviceLinkIo(ctx), fetchImpl } = {}) => {
  try {
    return (await platformRequest({ io, path, method, ...(body ? { body } : {}), timeoutMs: 20_000, ...(fetchImpl ? { fetchImpl } : {}) })).body;
  } catch (error) {
    throw asHttp(error);
  }
};

export const inboxList = (ctx, options) => inboxCall(ctx, 'developer/tickets', 'GET', undefined, options);

/** One conversation, with the local order and licence a refund is about when they can be found here. */
export async function inboxThread(ctx, ticketId, options) {
  const thread = await inboxCall(ctx, 'developer/ticket-thread', 'POST', { ticket_id: String(ticketId || '') }, options);
  const serial = String(thread?.purchase?.license_serial || '');
  let local = null;
  if (/^[0-9A-HJKMNP-TV-Z]{12}$/.test(serial)) {
    const [license] = await select(ctx, `dev_licenses?serial=eq.${enc(serial)}&select=id,order_id,status,domain,expires_at`, 'service').catch(() => []);
    if (license) {
      const [order] = await select(ctx, `dev_orders?id=eq.${enc(license.order_id)}&select=id,provider,amount,refunded_amount,currency,status,paid_at`, 'service').catch(() => []);
      local = { license, order: order || null };
    }
  }
  return { ...thread, local };
}

export const inboxReply = (ctx, ticketId, message, options) =>
  inboxCall(ctx, 'developer/ticket-reply', 'POST', { ticket_id: String(ticketId || ''), message: text(message, 4000) }, options);

/**
 * Decides a refund request from react-wp.com. `approve`: refunds the local order (`refund(order, amount, reason)` from
 * server/refunds.mjs, full refunds revoke the key), then reports it. `decline`: needs a reason of 10+ characters.
 */
export async function inboxDecide(ctx, owner, body, { refund, ...options } = {}) {
  const ticketId = String(body?.ticket_id || '');
  const decision = body?.decision === 'approve' ? 'approve' : body?.decision === 'decline' ? 'decline' : '';
  const reason = text(body?.reason, 2000);
  if (!decision) throw new HttpError(400, 'Choose approve or decline.');
  if (decision === 'decline') {
    if (reason.length < 10) throw new HttpError(400, 'Write why you decline (at least 10 characters). The buyer reads it and may ask the marketplace owner to rule.');
    return inboxCall(ctx, 'developer/refund-decide', 'POST', { ticket_id: ticketId, decision, reason }, options);
  }
  const thread = await inboxThread(ctx, ticketId, options);
  if (thread?.ticket?.kind !== 'refund') throw new HttpError(409, 'That conversation is not a refund request.');
  const order = thread.local?.order;
  if (!order) throw new HttpError(404, 'The order of this purchase was not found in this shop, so it cannot be refunded from here.');
  const left = Math.max(Number(order.amount || 0) - Number(order.refunded_amount || 0), 0);
  const asked = Number(body?.amount || thread.ticket.refund_amount || 0);
  const amount = Math.round((asked > 0 ? Math.min(asked, left) : left) * 100) / 100;
  let result = { sent: true, method: 'none' };
  if (left > 0 && amount > 0) {
    result = await refund({ order_id: order.id, amount, note: reason || 'Refund approved from a react-wp.com request.', revoke: amount + 0.001 >= left, manual: body?.manual === true, payout_reference: body?.payout_reference });
  }
  // A manual refund (USDT, a gateway without refunds) is approved here once the money was sent and recorded.
  if (result?.sent === false) return { ...result, reported: false, message: result.message || 'Approved here; send the money back, then mark it as refunded and approve again.' };
  const [license] = await select(ctx, `dev_licenses?order_id=eq.${enc(order.id)}&select=status`, 'service').catch(() => []);
  const reported = await inboxCall(ctx, 'developer/refund-decide', 'POST', { ticket_id: ticketId, decision: 'approve', reason, amount, revoked: license?.status === 'revoked' }, options);
  return { ...result, reported: true, platform: reported };
}

// ---------------------------------------------------------------------------------------------------- protected delivery

/**
 * The copy of a version a buyer downloads: for a priced product, compiled, obfuscated and watermarked with the licence serial
 * (core `protectPluginZip`), stored once per licence and version under `protected/`; a free product's published package as it is.
 * Returns `{ path, sha256, size }`.
 */
export async function buyerCopy(ctx, { product, version, license, deps = {} }) {
  if (!(Number(product.price) > 0)) return { path: version.storage_path, sha256: version.sha256, size: Number(version.size) || 0, protected: false };
  const path = `protected/${license.id}/${product.slug}-${String(version.version || product.current_version).replace(/[^0-9A-Za-z.-]/g, '')}.zip`;
  const read = deps.readPackage || readPackage;
  try {
    const cached = await read(ctx, path);
    return { path, sha256: sha256Hex(cached), size: cached.length, protected: true };
  } catch {
    // Not built yet for this licence and version.
  }
  const master = await read(ctx, version.storage_path);
  if (sha256Hex(master) !== version.sha256) throw new HttpError(409, 'The stored package does not match its checksum, so it is not handed out. Upload the version again.');
  const { zip } = deps.protectPluginZip
    ? await deps.protectPluginZip(master, { watermark: license.serial || license.id, label: product.slug })
    : await protectPluginZip(master, { watermark: license.serial || license.id, label: product.slug });
  await (deps.uploadPackage || uploadPackage)(ctx, path, zip);
  return { path, sha256: sha256Hex(zip), size: zip.length, protected: true };
}

/** The signed description of a package for a buyer's site: `RWPDPKG1|plugin|version|domain|sha256|exp`. */
export function packagePayload({ plugin, version, domain, sha256, exp }) {
  return `${PACKAGE_PREFIX}|${plugin}|${version}|${String(domain || '').toLowerCase()}|${sha256}|${exp}`;
}

export async function signedPackage(ctx, { product, version, license, domain, now = new Date(), deps = {} }) {
  const copy = await buyerCopy(ctx, { product, version, license, deps });
  const exp = new Date(now.getTime() + PACKAGE_TTL_MS).toISOString();
  const { privateKey } = await (deps.licenseKeys || licenseKeys)(ctx);
  const sig = signPayload(packagePayload({ plugin: product.slug, version: version.version || product.current_version, domain, sha256: copy.sha256, exp }), privateKey);
  return {
    plugin: product.slug,
    version: version.version || product.current_version,
    domain: String(domain || '').toLowerCase(),
    sha256: copy.sha256,
    size: copy.size,
    exp,
    sig,
    url: await (deps.signedPackageUrl || signedPackageUrl)(ctx, copy.path, 600),
    protected: copy.protected,
  };
}
