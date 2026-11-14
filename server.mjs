/**
 * Server routes for rwp-developers, served at /api/plugins/rwp-developers/<route> by server.mjs (self-hosted) and
 * api/plugins.ts (Vercel). Registered in server/plugins.mjs.
 *
 * The plugin is the developer's own shop. It never calls react-wp.com: packages live in the developer's Supabase Storage
 * (a private bucket), orders and licences in the developer's database, money goes to the developer's Stripe or
 * NOWPayments account, and licence keys are signed with a key pair the developer's site generates.
 *
 * Who may call what: the store, `verify`, `download` and `public-key` are public (a licence key is the credential for the
 * last two); checkout, claim and `my/*` need a signed-in buyer; `admin/*` needs `manage_options`; the two webhooks are
 * accepted only with the provider's own signature.
 */
import {
  HttpError, currentUser, ensureBucket, requireOwner, rpc, select,
} from './server/supabase.mjs';
import { publicLicenseKey, readSecret } from './server/secrets.mjs';
import { nowPaymentsPaidOrder, stripePaidOrder, verifyNowPaymentsSignature, verifyStripeSignature, PROVIDER_LABELS } from './server/payments.mjs';
import {
  claimFree, completePaid, deleteProduct, downloadForBuyer, downloadForKey, importFromRelease, paymentStatus, readPaymentsConfig,
  releaseDomain, saveProduct, savePayments, setVersionStatus, startCheckout, uploadVersion, verifyKey, verifyStoredPackage, MAX_PACKAGE_BYTES,
} from './server/store.mjs';
import { verifySnippet } from './server/license.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const enc = encodeURIComponent;

/** Reads a multipart/form-data body: text fields plus one `file` part. */
const parseMultipart = (ctx) => {
  const contentType = String(ctx.headers?.['content-type'] || '');
  if (!contentType.includes('multipart/form-data')) return null;
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!match) return null;
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  const raw = ctx.rawBody || Buffer.alloc(0);
  const fields = {};
  let file = null;
  let pos = raw.indexOf(boundary);
  while (pos !== -1) {
    const afterBoundary = pos + boundary.length;
    const headerEnd = raw.indexOf('\r\n\r\n', afterBoundary);
    if (headerEnd === -1) break;
    const headerText = raw.slice(afterBoundary, headerEnd).toString('utf8');
    const next = raw.indexOf(boundary, headerEnd + 4);
    if (next === -1) break;
    let value = raw.slice(headerEnd + 4, next);
    if (value.length >= 2 && value[value.length - 2] === 0x0d && value[value.length - 1] === 0x0a) value = value.slice(0, -2);
    const name = /name="([^"]+)"/i.exec(headerText)?.[1];
    const filename = /filename="([^"]+)"/i.exec(headerText)?.[1];
    if (name && !filename) fields[name] = value.toString('utf8');
    if (filename) file = value;
    pos = next;
  }
  return { fields, file };
};

/**
 * A small per-instance limiter for the public routes. It is a brake, not a wall: a serverless deployment has several
 * instances, so the real protections are the signature check (a forged key never reaches the database) and Supabase's own
 * limits. Keyed by the client address the platform reports.
 */
const buckets = new Map();
export const rateLimited = (ctx, name, limit = 40, windowMs = 60_000, now = Date.now()) => {
  const address = String(ctx.headers?.['x-forwarded-for'] || ctx.headers?.['x-real-ip'] || 'local').split(',')[0].trim();
  const key = `${name}|${address}`;
  const entry = buckets.get(key);
  if (!entry || now - entry.at > windowMs) {
    if (buckets.size > 5000) buckets.clear();
    buckets.set(key, { at: now, count: 1 });
    return false;
  }
  entry.count += 1;
  return entry.count > limit;
};

/** The signed-in account the request carries; a request with no bearer token never reaches the database. */
const signedIn = async (ctx) => {
  if (!ctx.bearerToken) throw new HttpError(401, 'Sign in required.');
  return currentUser(ctx);
};

const tooMany = () => new HttpError(429, 'Too many requests. Wait a minute and try again.');

const isUuid = (value, what = 'plugin') => {
  const text = String(value || '').trim();
  if (!UUID.test(text)) throw new HttpError(400, `Choose a ${what} first.`);
  return text;
};

/** A webhook problem the provider should not retry (the order is not ours to complete) is answered 200. */
const webhookOutcome = async (run) => {
  try {
    await run();
    return { status: 200, body: { received: true } };
  } catch (error) {
    if (error instanceof HttpError && error.status >= 400 && error.status < 500) {
      console.warn(`[rwp-developers] a payment callback was acknowledged but not applied: ${error.message}`);
      return { status: 200, body: { received: true, applied: false } };
    }
    throw error;
  }
};

const developersServer = {
  id: 'rwp-developers',
  // A buyer's own site calls verify/download from its server or browser with only a licence key.
  cors: ['POST verify', 'POST download', 'GET public-key'],
  routes: {
    /* ----------------------------------------------------------------------------------------- the store */
    'GET store/catalog': async (ctx) => {
      const products = (await rpc(ctx, 'dev_store_catalog', {}, 'anon')) || [];
      let methods = [];
      if (ctx.supabase.secretKey) {
        const config = await readPaymentsConfig(ctx).catch(() => null);
        if (config) methods = Object.entries(config).filter(([, value]) => value.enabled).map(([name]) => ({ id: name, label: PROVIDER_LABELS[name] }));
      }
      return { status: 200, body: { products, methods } };
    },

    'POST claim': async (ctx) => {
      const user = await signedIn(ctx);
      const result = await claimFree(ctx, user, isUuid(ctx.json()?.product_id));
      return { status: 200, body: { license_key: result.license_key } };
    },

    'POST checkout/start': async (ctx) => {
      const user = await signedIn(ctx);
      const body = ctx.json() || {};
      const result = await startCheckout(ctx, user, { productId: isUuid(body.product_id), provider: String(body.provider || '') });
      return { status: 200, body: { url: result.url } };
    },

    'GET my/licenses': async (ctx) => {
      await signedIn(ctx);
      return { status: 200, body: { licenses: (await rpc(ctx, 'dev_my_licenses', {}, 'user')) || [] } };
    },

    'POST my/download': async (ctx) => {
      const user = await signedIn(ctx);
      return { status: 200, body: await downloadForBuyer(ctx, user, isUuid(ctx.json()?.license_id, 'licence')) };
    },

    'POST my/release-domain': async (ctx) => {
      const user = await signedIn(ctx);
      return { status: 200, body: await releaseDomain(ctx, user, isUuid(ctx.json()?.license_id, 'licence')) };
    },

    /* ------------------------------------------------------------------ licence check for a buyer's site */
    'GET public-key': async (ctx) => {
      if (rateLimited(ctx, 'public-key')) throw tooMany();
      return { status: 200, body: { algorithm: 'ed25519', format: 'RWPD1', public_key: await publicLicenseKey(ctx) } };
    },

    'POST verify': async (ctx) => {
      if (rateLimited(ctx, 'verify')) throw tooMany();
      const body = ctx.json() || {};
      if (!String(body.license_key || '').trim()) throw new HttpError(400, 'Send the licence key.');
      return { status: 200, body: await verifyKey(ctx, { key: body.license_key, domain: body.domain }) };
    },

    'POST download': async (ctx) => {
      if (rateLimited(ctx, 'download', 20)) throw tooMany();
      const body = ctx.json() || {};
      if (!String(body.license_key || '').trim()) throw new HttpError(400, 'Send the licence key.');
      if (!String(body.domain || '').trim()) throw new HttpError(400, 'Send the address of the site the plugin is for (its domain).');
      return { status: 200, body: await downloadForKey(ctx, { key: body.license_key, domain: body.domain }) };
    },

    /* ---------------------------------------------------------------------------------------- webhooks */
    'POST webhook/stripe': async (ctx) => {
      const secret = await readSecret(ctx, 'stripe_webhook_secret');
      if (!secret) throw new HttpError(501, 'The Stripe webhook secret is not set.');
      if (!verifyStripeSignature(ctx.rawBody || Buffer.alloc(0), String(ctx.headers?.['stripe-signature'] || ''), secret)) {
        throw new HttpError(400, 'The Stripe signature does not verify.');
      }
      let event;
      try { event = JSON.parse(Buffer.from(ctx.rawBody).toString('utf8')); } catch { throw new HttpError(400, 'The event is not valid JSON.'); }
      const paid = stripePaidOrder(event);
      if (!paid) return { status: 200, body: { received: true } };
      return webhookOutcome(async () => {
        const order = (await select(ctx, `dev_orders?id=eq.${enc(paid.orderId)}&select=provider`, 'service'))[0];
        if (!order || order.provider !== 'stripe') throw new HttpError(404, 'That order is not a Stripe order of this shop.');
        await completePaid(ctx, paid);
      });
    },

    'POST webhook/nowpayments': async (ctx) => {
      const secret = await readSecret(ctx, 'nowpayments_ipn_secret');
      if (!secret) throw new HttpError(501, 'The NOWPayments IPN secret is not set.');
      if (!verifyNowPaymentsSignature(ctx.rawBody || Buffer.alloc(0), String(ctx.headers?.['x-nowpayments-sig'] || ''), secret)) {
        throw new HttpError(400, 'The NOWPayments signature does not verify.');
      }
      let payload;
      try { payload = JSON.parse(Buffer.from(ctx.rawBody).toString('utf8')); } catch { throw new HttpError(400, 'The IPN is not valid JSON.'); }
      const paid = nowPaymentsPaidOrder(payload);
      if (!paid) return { status: 200, body: { received: true } };
      return webhookOutcome(async () => {
        const order = (await select(ctx, `dev_orders?id=eq.${enc(paid.orderId)}&select=provider`, 'service'))[0];
        if (!order || order.provider !== 'nowpayments') throw new HttpError(404, 'That order is not a NOWPayments order of this shop.');
        await completePaid(ctx, paid);
      });
    },

    /* ------------------------------------------------------------------------------------- the owner */
    'GET admin/status': async (ctx) => {
      await requireOwner(ctx);
      const status = await paymentStatus(ctx);
      return {
        status: 200,
        body: { ...status, max_package_mb: MAX_PACKAGE_BYTES / 1024 / 1024, snippet: status.license_public_key ? verifySnippet(status.license_public_key) : '' },
      };
    },

    'POST admin/payments/save': async (ctx) => {
      await requireOwner(ctx);
      return { status: 200, body: await savePayments(ctx, ctx.json() || {}) };
    },

    'POST admin/bucket/prepare': async (ctx) => {
      await requireOwner(ctx);
      await ensureBucket(ctx);
      return { status: 200, body: { ready: true } };
    },

    'POST admin/products/save': async (ctx) => {
      await requireOwner(ctx);
      const user = await signedIn(ctx);
      const saved = await saveProduct(ctx, ctx.json() || {}, user.id);
      return { status: 200, body: { product: saved } };
    },

    'POST admin/products/delete': async (ctx) => {
      await requireOwner(ctx);
      return { status: 200, body: await deleteProduct(ctx, isUuid(ctx.json()?.id)) };
    },

    'POST admin/versions/upload': async (ctx) => {
      await requireOwner(ctx);
      const user = await signedIn(ctx);
      const parsed = parseMultipart(ctx);
      if (!parsed?.file) throw new HttpError(400, 'Choose the plugin ZIP to upload.');
      const fields = parsed.fields;
      const result = await uploadVersion(ctx, {
        productId: isUuid(fields.product_id), version: fields.version, changelog: fields.changelog,
        bytes: new Uint8Array(parsed.file), acceptFindings: fields.accept_findings === 'true', userId: user.id,
      });
      return { status: 201, body: result };
    },

    'POST admin/versions/status': async (ctx) => {
      await requireOwner(ctx);
      const body = ctx.json() || {};
      return { status: 200, body: await setVersionStatus(ctx, { versionId: isUuid(body.version_id, 'version'), status: String(body.status || '') }) };
    },

    'POST admin/versions/verify': async (ctx) => {
      await requireOwner(ctx);
      return { status: 200, body: await verifyStoredPackage(ctx, isUuid(ctx.json()?.version_id, 'version')) };
    },

    // A plugin published from a public GitHub repository's latest release: a new plugin (repository_url) or a new version of one
    // that is already linked (product_id). Used by the button and by the admin's own periodic check.
    'POST admin/source/import': async (ctx) => {
      await requireOwner(ctx);
      const user = await signedIn(ctx);
      const body = ctx.json() || {};
      const productId = body.product_id ? isUuid(body.product_id) : '';
      if (!productId && !String(body.repository_url || '').trim()) throw new HttpError(400, 'Enter the address of the GitHub repository.');
      const result = await importFromRelease(ctx, {
        productId, repositoryUrl: body.repository_url, acceptFindings: body.accept_findings === true, userId: user.id,
      });
      return { status: 200, body: result };
    },
  },
};

export default developersServer;
