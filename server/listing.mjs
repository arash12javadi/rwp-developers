/**
 * Listing a plugin of this shop on the React-WP marketplace (react-wp.com/plugins).
 *
 * The site has to be connected to the owner's react-wp.com account first (Plugins -> Connect to react-wp.com, the core
 * account link). "Send to React-WP Marketplace" then calls react-wp.com with that connection (`platformRequest` in
 * server/licenseLink.mjs, which keeps the site token sealed): the first request carries the package and waits in the
 * marketplace owner's Inventory -> Pending; once the owner approved it, later versions go live after the marketplace's own scan.
 *
 * This shop stays the seller: a priced listing's Buy button on react-wp.com sends the customer to this site's /store, where this
 * shop's own payment accounts take the money and its own key signs the licence. Nothing secret is sent: the package, the price,
 * which payment methods are ready (names only) and the licence PUBLIC key.
 *
 * After the first send, a new published version or a new price is sent by itself (`autoSendListing`), until the owner presses
 * "Stop sending updates". A failure there never fails the change in this shop; it is kept in `dev_listings.error`.
 */
import { settingsIo } from '../../../server/gitDeploy/connection.mjs';
import { LICENSE_LINK_CONFIG_KEY, LicenseLinkError, isLicenseLinked, licenseLinkFrom, platformRequest } from '../../../server/licenseLink.mjs';
import { HttpError, readPackage, select, upsert } from './supabase.mjs';
import { gatewayChecks } from './payments.mjs';
import { storedSecretNames } from './secrets.mjs';
import { assertReadyToSell, readPaymentsConfig } from './store.mjs';

const enc = encodeURIComponent;
const LISTING_COLUMNS = 'product_id,requested,sent_version,sent_price,status,message,error,plugin_id,sent_at,checked_at,open_complaints';

/** The account-link settings, read with the owner's own session (RLS decides, as on the Plugins screen). */
export const linkIo = (ctx) => settingsIo({ supabaseUrl: ctx.supabase.url, supabaseKey: ctx.supabase.publishableKey, accessToken: ctx.bearerToken });

const asHttp = (error) => (error instanceof LicenseLinkError ? new HttpError(error.status, error.message) : error);

async function readListing(ctx, productId) {
  return (await select(ctx, `dev_listings?product_id=eq.${enc(productId)}&select=${LISTING_COLUMNS}`, 'service'))[0] || null;
}

async function saveListing(ctx, productId, patch) {
  await upsert(ctx, 'dev_listings', { product_id: productId, ...patch, updated_at: new Date().toISOString() }, 'product_id', 'service');
}

/** What the owner's screen shows: whether the site is connected, and one row per plugin that was sent. */
export async function listingOverview(ctx, { io = linkIo(ctx), refresh = false, fetchImpl } = {}) {
  let connected = false;
  let domain = '';
  try {
    const row = licenseLinkFrom(await io.read(LICENSE_LINK_CONFIG_KEY));
    connected = isLicenseLinked(row);
    domain = connected ? row.domain : '';
  } catch {
    connected = false;
  }
  let refreshError = '';
  if (connected && refresh) {
    try {
      const answer = await platformRequest({ io, path: 'developer/listings', method: 'GET', ...(fetchImpl ? { fetchImpl } : {}) });
      const remote = new Map((answer.body?.listings || []).map((entry) => [String(entry.slug), entry]));
      const products = await select(ctx, 'dev_products?managed_by=eq.&select=id,slug', 'service');
      const sent = new Set((await select(ctx, 'dev_listings?select=product_id', 'service')).map((row) => row.product_id));
      const now = new Date().toISOString();
      for (const product of products) {
        const entry = remote.get(product.slug);
        if (!entry || !sent.has(product.id)) continue;
        await saveListing(ctx, product.id, {
          status: String(entry.status || ''), plugin_id: entry.plugin_id || null, checked_at: now,
          open_complaints: Math.max(0, Math.trunc(Number(entry.open_complaints) || 0)),
        });
      }
    } catch (error) {
      refreshError = error instanceof Error ? error.message : 'react-wp.com could not be asked just now.';
    }
  }
  const listings = await select(ctx, `dev_listings?select=${LISTING_COLUMNS}`, 'service');
  return { connected, domain, listings, refresh_error: refreshError };
}

/**
 * Sends one plugin to the marketplace: its price, ready payment methods and licence public key, and its package when react-wp.com
 * does not have the version this shop offers yet. Throws a sentence the owner can act on.
 */
export async function sendToMarketplace(ctx, { productId, io = linkIo(ctx), fetchImpl } = {}) {
  const product = (await select(ctx, `dev_products?id=eq.${enc(productId)}&select=id,slug,title,price,status,category,current_version,managed_by`, 'service'))[0];
  if (!product) throw new HttpError(404, 'That plugin does not exist.');
  if (product.managed_by) throw new HttpError(409, 'This plugin is already managed by the Marketplace.');
  if (product.status !== 'published' || !product.current_version) {
    throw new HttpError(409, 'Put the plugin on sale in your own shop first (with a published version); then send it to the React-WP marketplace.');
  }
  const price = Number(product.price) || 0;
  // A priced plugin needs a shop that can take the money, exactly as putting it on sale here does.
  if (price > 0) await assertReadyToSell(ctx);
  // Names only: the built-ins and any plugin gateway that is switched on and finished. Never a credential.
  const methods = (await gatewayChecks({ config: await readPaymentsConfig(ctx), present: await storedSecretNames(ctx) }))
    .filter((gateway) => gateway.ready).map((gateway) => gateway.id);
  const settings = (await select(ctx, 'dev_settings?id=eq.true&select=license_public_key', 'service'))[0];
  const listing = await readListing(ctx, product.id);
  const sendPackage = !listing || listing.sent_version !== product.current_version;

  const form = new FormData();
  form.append('slug', product.slug);
  form.append('price', String(price));
  form.append('payment_methods', methods.join(','));
  form.append('license_public_key', String(settings?.license_public_key || ''));
  form.append('category', String(product.category || ''));
  if (sendPackage) {
    const version = (await select(ctx, `dev_versions?product_id=eq.${enc(product.id)}&version=eq.${enc(product.current_version)}&status=eq.published&select=version,storage_path,changelog`, 'service'))[0];
    if (!version) throw new HttpError(409, `Version ${product.current_version} is not published in your shop, so it cannot be sent.`);
    const bytes = await readPackage(ctx, version.storage_path);
    form.append('version', version.version);
    form.append('changelog', String(version.changelog || ''));
    form.append('file_name', `${product.slug}-${version.version}.zip`);
    form.append('file', new Blob([bytes], { type: 'application/zip' }), `${product.slug}-${version.version}.zip`);
  }

  let answer;
  try {
    answer = await platformRequest({ io, path: 'developer/submit', method: 'POST', body: form, ...(fetchImpl ? { fetchImpl } : {}) });
  } catch (error) {
    await saveListing(ctx, product.id, { requested: true, error: error instanceof Error ? error.message.slice(0, 1000) : 'The request failed.' }).catch(() => {});
    throw asHttp(error);
  }
  const body = answer.body || {};
  const now = new Date().toISOString();
  const message = String(body.error_for_publisher || body.reason || '').slice(0, 2000);
  await saveListing(ctx, product.id, {
    requested: true,
    sent_version: sendPackage ? product.current_version : listing.sent_version,
    sent_price: price,
    status: String(body.listing?.status || (body.verdict === 'rejected' ? 'rejected' : '')),
    message,
    error: '',
    plugin_id: body.listing?.plugin_id || listing?.plugin_id || null,
    sent_at: now,
    checked_at: now,
  });
  return { listing: await readListing(ctx, product.id), verdict: String(body.verdict || ''), message, sent_package: sendPackage };
}

/**
 * After a change in this shop: sends the plugin again when it was sent before, is still requested, and react-wp.com has an
 * older version or another price. Never throws: a failure is stored for the owner to read, and the change here stands.
 */
export async function autoSendListing(ctx, productId, { io, fetchImpl } = {}) {
  try {
    if (!productId) return { sent: false };
    const listing = await readListing(ctx, productId);
    if (!listing?.requested) return { sent: false };
    const product = (await select(ctx, `dev_products?id=eq.${enc(productId)}&select=price,status,current_version`, 'service'))[0];
    if (!product || product.status !== 'published' || !product.current_version) return { sent: false };
    const priceChanged = listing.sent_price === null || Number(listing.sent_price) !== Number(product.price);
    if (listing.sent_version === product.current_version && !priceChanged) return { sent: false };
    await sendToMarketplace(ctx, { productId, ...(io ? { io } : {}), ...(fetchImpl ? { fetchImpl } : {}) });
    return { sent: true };
  } catch (error) {
    const text = error instanceof Error ? error.message : 'The update could not be sent.';
    await saveListing(ctx, productId, { error: text.slice(0, 1000) }).catch(() => {});
    return { sent: false, error: text };
  }
}

/** "Stop sending updates": nothing is sent by itself any more. The listing stays on react-wp.com until its owner removes it. */
export async function stopListing(ctx, productId) {
  const listing = await readListing(ctx, productId);
  if (!listing) throw new HttpError(404, 'This plugin was never sent to the React-WP marketplace.');
  await saveListing(ctx, productId, { requested: false });
  return { listing: await readListing(ctx, productId) };
}
