/**
 * Credentials of the developer shop: the Stripe and NOWPayments keys and the licence private key.
 *
 * They live in `dev_secrets`, sealed with `RWP_SECRET_BOX_KEY` (`server/deploy/secretBox.mjs`) before they are written.
 * RLS is on and no policy exists, so only the server's secret key reaches the table. Nothing here is ever returned to a
 * browser: the admin sees "set" or "not set" and, for the licence key, only the public half.
 *
 * Fail closed: with no `RWP_SECRET_BOX_KEY` nothing is stored, and a saved credential that cannot be opened is an error
 * naming the cause rather than an empty string that makes a payment look unconfigured.
 */
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { openSecret, sealSecret, secretBoxEnabled } from '../../../server/deploy/secretBox.mjs';
import { HttpError, insert, select, update, upsert } from './supabase.mjs';
import { newKeyPair } from './license.mjs';

/** The names a secret may have. A route can only write one of these. */
export const SECRET_NAMES = ['stripe_secret_key', 'stripe_webhook_secret', 'nowpayments_api_key', 'nowpayments_ipn_secret', 'license_private_key'];
const WRITABLE_BY_ADMIN = SECRET_NAMES.filter((name) => name !== 'license_private_key');
/** A field of a payment gateway a plugin added (server/payments/registry.mjs): `gw:<gateway id>:<field name>`. */
export const GATEWAY_SECRET = /^gw:[a-z][a-z0-9_-]{1,30}:[a-z][a-z0-9_]{1,40}$/;
const known = (name) => SECRET_NAMES.includes(name) || GATEWAY_SECRET.test(name);
const writable = (name) => WRITABLE_BY_ADMIN.includes(name) || GATEWAY_SECRET.test(name);

export function requireSecretBox() {
  let enabled = false;
  try { enabled = secretBoxEnabled(); } catch (error) { throw new HttpError(503, error instanceof Error ? error.message : 'RWP_SECRET_BOX_KEY is invalid.'); }
  if (!enabled) {
    throw new HttpError(503, 'This site cannot store payment credentials yet: set RWP_SECRET_BOX_KEY (32 random bytes, base64 or hex) in the environment variables and redeploy. It is what seals them in the database.');
  }
}

/** Which secrets are stored, never their values. */
export async function secretsStatus(ctx) {
  const rows = await select(ctx, 'dev_secrets?select=name', 'service');
  const present = new Set(rows.map((row) => row.name));
  return Object.fromEntries(SECRET_NAMES.map((name) => [name, present.has(name)]));
}

/** Every stored secret name (never a value), including plugin gateways' fields. */
export async function storedSecretNames(ctx) {
  const rows = await select(ctx, 'dev_secrets?select=name', 'service');
  return new Set(rows.map((row) => row.name));
}

/** The opened value of one secret, or '' when it is not stored. */
export async function readSecret(ctx, name) {
  if (!known(name)) throw new HttpError(500, `${name} is not a secret of this plugin.`);
  const rows = await select(ctx, `dev_secrets?name=eq.${encodeURIComponent(name)}&select=value`, 'service');
  if (!rows[0]) return '';
  try {
    return openSecret(rows[0].value);
  } catch (error) {
    throw new HttpError(503, error instanceof Error ? error.message : 'A stored credential could not be opened.');
  }
}

/** Seals and stores one credential an administrator pasted. Blank input is ignored by the caller, not stored. */
export async function writeSecret(ctx, name, value) {
  if (!writable(name)) throw new HttpError(400, `${name} cannot be set from here.`);
  const text = String(value || '').trim();
  if (!text || text.length > 400 || /\s/.test(text)) throw new HttpError(400, 'That does not look like an API key (no spaces, at most 400 characters).');
  requireSecretBox();
  await upsert(ctx, 'dev_secrets', { name, value: sealSecret(text), updated_at: new Date().toISOString() }, 'name');
}

export async function clearSecret(ctx, name) {
  if (!writable(name)) throw new HttpError(400, `${name} cannot be removed from here.`);
  const response = await fetch(`${ctx.supabase.url.replace(/\/$/, '')}/rest/v1/dev_secrets?name=eq.${encodeURIComponent(name)}`, {
    method: 'DELETE',
    headers: { apikey: ctx.supabase.secretKey, Authorization: `Bearer ${ctx.supabase.secretKey}`, Prefer: 'return=minimal' },
  });
  if (!response.ok) throw new HttpError(500, 'The credential could not be removed.');
}

/**
 * Only the public half, for the routes that merely verify (`verify`, `download`, `public-key`): one small read and no private
 * key opened. Falls back to `licenseKeys` when the pair has not been created yet.
 */
export async function publicLicenseKey(ctx) {
  const settings = (await select(ctx, 'dev_settings?id=eq.true&select=license_public_key', 'service'))[0];
  if (settings?.license_public_key) return settings.license_public_key;
  return (await licenseKeys(ctx)).publicKey;
}

/**
 * The developer's licence key pair, created the first time it is needed. The private half is sealed in `dev_secrets`;
 * the public half is copied to `dev_settings.license_public_key`, where the admin and `GET public-key` read it.
 * Two requests racing to create it end with one pair: the second insert is refused and the first pair is read back.
 */
export async function licenseKeys(ctx) {
  const stored = await readSecret(ctx, 'license_private_key');
  const settings = (await select(ctx, 'dev_settings?id=eq.true&select=license_public_key', 'service'))[0];
  if (stored && settings?.license_public_key) return { privateKey: stored, publicKey: settings.license_public_key };
  if (stored) {
    // The private half exists but the public copy was lost (an interrupted first run): derive it, never replace the key.
    const publicKey = createPublicKey(createPrivateKey({ key: Buffer.from(stored, 'base64'), format: 'der', type: 'pkcs8' }))
      .export({ type: 'spki', format: 'der' }).toString('base64');
    await update(ctx, 'dev_settings', 'id=eq.true', { license_public_key: publicKey }, 'service');
    return { privateKey: stored, publicKey };
  }

  requireSecretBox();
  const pair = newKeyPair();
  try {
    await insert(ctx, 'dev_secrets', { name: 'license_private_key', value: sealSecret(pair.privateKey) }, 'service');
  } catch (error) {
    if (error instanceof HttpError && error.status === 409) return licenseKeys(ctx);
    throw error;
  }
  await update(ctx, 'dev_settings', 'id=eq.true', { license_public_key: pair.publicKey }, 'service');
  return { privateKey: pair.privateKey, publicKey: pair.publicKey };
}

/* ------------------------------------------------------------------------ a private repository's read token */

/** The name one product's repository token is kept under (the table's name rule has no hyphens, a UUID has). */
const sourceTokenName = (productId) => `gh_${String(productId).replace(/-/g, '_')}`;

/** The read-only token of a product's private repository: sealed, never returned by any route, '' when none is stored. */
export async function readSourceToken(ctx, productId) {
  const rows = await select(ctx, `dev_secrets?name=eq.${encodeURIComponent(sourceTokenName(productId))}&select=value`, 'service');
  if (!rows[0]) return '';
  try {
    return openSecret(rows[0].value);
  } catch (error) {
    throw new HttpError(503, error instanceof Error ? error.message : 'A stored repository token could not be opened.');
  }
}

export async function writeSourceToken(ctx, productId, token) {
  const text = String(token || '').trim();
  if (text.length < 20 || text.length > 255 || /\s/.test(text)) {
    throw new HttpError(400, 'That does not look like a GitHub access token. Create a fine-grained token with read-only "Contents" access to this one repository and paste it whole.');
  }
  requireSecretBox();
  await upsert(ctx, 'dev_secrets', { name: sourceTokenName(productId), value: sealSecret(text), updated_at: new Date().toISOString() }, 'name');
}

export async function clearSourceToken(ctx, productId) {
  const response = await fetch(`${ctx.supabase.url.replace(/\/$/, '')}/rest/v1/dev_secrets?name=eq.${encodeURIComponent(sourceTokenName(productId))}`, {
    method: 'DELETE',
    headers: { apikey: ctx.supabase.secretKey, Authorization: `Bearer ${ctx.supabase.secretKey}`, Prefer: 'return=minimal' },
  });
  if (!response.ok) throw new HttpError(500, 'The repository token could not be removed.');
}
