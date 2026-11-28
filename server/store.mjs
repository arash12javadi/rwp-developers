/**
 * The developer shop's logic: products and versions, orders, licences, downloads.
 *
 * Each function takes the route context (`ctx`: Supabase URL and keys, the caller's token) and does one job. Trust rules,
 * each of which a test pins:
 *   - an order's amount is the product's stored price, read in SQL; a request names a product, never a price;
 *   - a licence is minted only by `completePaid`, which a verified provider callback (or a free claim) calls, and only once
 *     per order (SQL is idempotent), signed with the developer's own key;
 *   - a package is handed out only for a licence that verifies, as a ten-minute signed address into a PRIVATE bucket;
 *   - an uploaded package is scanned and re-packed before it is stored; a package with a blocking finding is never stored.
 */
import {
  ReleaseSourceError, compareVersions, normalisePackage, parseRepositoryUrl, resolveReleaseCandidate, severityOf,
  sha256Hex, unpackLimited, versionFromTag,
} from '../../../server/releaseSource.mjs';
import { vetFiles } from '../../../server/pluginVet.mjs';
import { latestReleaseTag } from './releaseProbe.mjs';
import { isCommercialPlugin } from '../../../src/lib/pluginLicense.js';
import { isDevEditionPlugin } from '../../../src/lib/pluginEdition.js';
import { HttpError, deletePackage, insert, readPackage, remove, rpc, select, signedPackageUrl, update, uploadPackage } from './supabase.mjs';
import {
  clearSecret, clearSourceToken, licenseKeys, publicLicenseKey, readSecret, readSourceToken, requireSecretBox, secretsStatus, storedSecretNames,
  writeSecret, writeSourceToken,
} from './secrets.mjs';
import { expiryDate, expiryStamp, newSerial, signLicenseKey, verifyLicenseKey } from './license.mjs';
import {
  gatewayChecks, gatewayCredentials, gatewayEnabled, gatewayErrorToHttp, gatewaySecretName, paymentChecks, paymentsConfigFrom,
  PROVIDERS, shopGateway, shopGateways, webhookUrl,
} from './payments.mjs';
import { announcePayment, checkoutOrder, credentialStatus, verifiedWebhookEvents } from '../../../server/payments/registry.mjs';
import { buyerCopy, rememberRef, reportPurchase, signedPackage } from './platformSync.mjs';

const enc = encodeURIComponent;
export const MAX_PACKAGE_BYTES = 40 * 1024 * 1024;
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CATEGORIES = ['utility', 'commerce', 'marketing', 'seo', 'media', 'developer', 'integration'];
const asHttp = (error) => (error instanceof ReleaseSourceError ? new HttpError(error.status, error.message) : error);

/* ---------------------------------------------------------------------------------------- settings */

export async function readPaymentsConfig(ctx) {
  const row = (await select(ctx, 'dev_settings?id=eq.true&select=payments,license_public_key', 'service'))[0];
  return paymentsConfigFrom(row?.payments);
}

/** What the owner's Payments screen shows: switches and what is missing. Never a value. */
export async function paymentStatus(ctx) {
  const config = await readPaymentsConfig(ctx);
  const secrets = await secretsStatus(ctx);
  const row = (await select(ctx, 'dev_settings?id=eq.true&select=license_public_key', 'service'))[0];
  let secretBox = true;
  try { requireSecretBox(); } catch { secretBox = false; }
  // Every gateway (the two built-ins and any a plugin added), with its switch and what it still needs; never a value.
  const gateways = await gatewayChecks({ config, present: await storedSecretNames(ctx) });
  return {
    config,
    secrets,
    checks: paymentChecks(config, secrets),
    gateways: gateways.map((gateway) => ({ ...gateway, webhook_url: gateway.supports.webhook ? webhookUrl(ctx.origin, gateway.id) : '' })),
    secret_box: secretBox,
    license_public_key: row?.license_public_key || '',
    webhook_urls: {
      stripe: `${ctx.origin}/api/plugins/rwp-developers/webhook/stripe`,
      nowpayments: `${ctx.origin}/api/plugins/rwp-developers/webhook/nowpayments`,
    },
  };
}

/**
 * Refuses to put a priced plugin on sale before Payments & key is finished: at least one payment method switched on with
 * all its credentials, and the licence key pair created. A free plugin never needs this.
 */
export async function assertReadyToSell(ctx) {
  const config = await readPaymentsConfig(ctx);
  const gateways = await gatewayChecks({ config, present: await storedSecretNames(ctx) });
  if (!gateways.some((gateway) => gateway.ready)) {
    throw Object.assign(new HttpError(409, 'Finish Developers → Payments & key first: switch on a payment method (Stripe, NOWPayments or one a plugin added) and save its credentials. A priced plugin cannot be put on sale until a buyer can pay for it. A free plugin needs nothing.'), { code: 'payments_not_ready' });
  }
  const row = (await select(ctx, 'dev_settings?id=eq.true&select=license_public_key', 'service'))[0];
  if (!row?.license_public_key) {
    throw Object.assign(new HttpError(409, 'Your licence key pair is not created yet. Open Developers → Payments & key and save once: the pair is created there, and every sale needs it to sign the buyer\'s licence.'), { code: 'license_key_missing' });
  }
}

/**
 * Saves the switches and any credential pasted. A blank credential field means "leave it as it is"; `clear` names the
 * ones to remove. Credentials are sealed before they are written and are never echoed back.
 */
export async function savePayments(ctx, body) {
  // Plugin gateways: `gateways: { <id>: { enabled, fields: { <field>: value } } }`; only gateways the registry offers this shop.
  // Every offered gateway except Stripe and NOWPayments, which keep their own fields (PayPal included, wherever it comes from).
  const offered = new Map((await shopGateways()).filter((gateway) => !PROVIDERS.includes(gateway.id)).map((gateway) => [gateway.id, gateway]));
  const asked = body?.gateways && typeof body.gateways === 'object' ? body.gateways : {};
  const current = await readPaymentsConfig(ctx);
  const extra = { ...current.gateways };
  for (const [id, entry] of Object.entries(asked)) {
    const gateway = offered.get(id);
    if (!gateway) continue;
    extra[id] = { enabled: entry?.enabled === true };
    const fields = entry?.fields && typeof entry.fields === 'object' ? entry.fields : {};
    for (const field of gateway.credentialFields) {
      const raw = fields[field.name];
      const value = field.type === 'boolean' ? (raw === undefined ? '' : String(raw === true || raw === 'true')) : String(raw ?? '').trim();
      if (value) await writeSecret(ctx, gatewaySecretName(id, field.name), value);
    }
  }
  const next = paymentsConfigFrom({
    gateways: extra,
    stripe: { enabled: body?.stripe?.enabled === true },
    nowpayments: {
      enabled: body?.nowpayments?.enabled === true,
      sandbox: body?.nowpayments?.sandbox === true,
      pay_currency: body?.nowpayments?.pay_currency,
    },
  });
  const secrets = body?.secrets && typeof body.secrets === 'object' ? body.secrets : {};
  for (const [name, value] of Object.entries(secrets)) {
    if (String(value || '').trim()) await writeSecret(ctx, name, value);
  }
  for (const name of Array.isArray(body?.clear) ? body.clear : []) await clearSecret(ctx, String(name));
  await update(ctx, 'dev_settings', 'id=eq.true', { payments: next }, 'service');
  // Creating the licence key pair now means the public key can be shown before the first sale.
  if (next.stripe.enabled || next.nowpayments.enabled || Object.values(next.gateways).some((entry) => entry.enabled)) await licenseKeys(ctx);
  return paymentStatus(ctx);
}

/* ------------------------------------------------------------------------------------------ products */

const productPatch = (body, { creating }) => {
  const patch = {};
  if (creating || body.slug !== undefined) {
    const slug = String(body.slug || '').trim().toLowerCase();
    if (!SLUG.test(slug)) throw new HttpError(400, 'The id may only use lower-case letters, digits and hyphens (for example my-plugin).');
    if (isCommercialPlugin(slug) || isDevEditionPlugin(slug)) throw new HttpError(400, `"${slug}" is the id of a plugin that ships with React-WP. Choose another id.`);
    patch.slug = slug;
  }
  if (creating || body.title !== undefined) {
    const title = String(body.title || '').trim();
    if (!title || title.length > 120) throw new HttpError(400, 'A title of up to 120 characters is required.');
    patch.title = title;
  }
  if (body.description !== undefined) patch.description = String(body.description || '').slice(0, 4000);
  if (body.category !== undefined) patch.category = CATEGORIES.includes(String(body.category)) ? String(body.category) : 'utility';
  if (body.price !== undefined) {
    const price = Number(body.price);
    if (!Number.isFinite(price) || price < 0 || price > 100000) throw new HttpError(400, 'The price must be between 0 and 100000 US dollars.');
    patch.price = Math.round(price * 100) / 100;
  }
  if (body.license_days !== undefined) {
    if (body.license_days === null || body.license_days === '' || Number(body.license_days) === 0) patch.license_days = null;
    else {
      const days = Number(body.license_days);
      if (!Number.isInteger(days) || days < 1 || days > 3650) throw new HttpError(400, 'A licence lasts between 1 and 3650 days, or leave it empty for a lifetime licence.');
      patch.license_days = days;
    }
  }
  if (body.status !== undefined) {
    if (!['draft', 'published', 'archived'].includes(String(body.status))) throw new HttpError(400, 'Choose draft, published or archived.');
    patch.status = String(body.status);
  }
  if (body.release_source !== undefined) {
    if (!['github', 'zip'].includes(String(body.release_source))) throw new HttpError(400, 'Choose "github" or "zip" as the source that rules.');
    patch.release_source = String(body.release_source);
  }
  return patch;
};

export async function saveProduct(ctx, body, userId) {
  const id = String(body?.id || '').trim();
  if (!id) {
    const patch = productPatch(body || {}, { creating: true });
    return insert(ctx, 'dev_products', { ...patch, created_by: userId }, 'service').catch((error) => {
      if (error instanceof HttpError && error.status === 409) throw new HttpError(409, `The id "${patch.slug}" is already used by another plugin of yours.`);
      throw error;
    });
  }
  const current = (await select(ctx, `dev_products?id=eq.${enc(id)}&select=id,slug,status,current_version,release_source,source_repo,source_private,price`, 'service'))[0];
  if (!current) throw new HttpError(404, 'That plugin does not exist.');
  const patch = productPatch(body || {}, { creating: false });
  if (patch.slug && patch.slug !== current.slug) {
    throw new HttpError(409, 'The id of a plugin cannot change: licence keys are issued for it and its package is stored under it.');
  }
  delete patch.slug;
  if (patch.status === 'published') {
    const live = await select(ctx, `dev_versions?product_id=eq.${enc(id)}&status=eq.published&select=version&limit=1`, 'service');
    if (!live.length) throw new HttpError(409, 'Upload a version first: a plugin with no published version cannot be put on sale.');
  }
  const nextPrice = patch.price !== undefined ? patch.price : Number(current.price);
  // A priced plugin goes on sale only when a buyer can actually pay: checked when it is put on sale, or made paid while on sale.
  const nextStatus = patch.status !== undefined ? patch.status : current.status;
  const goesOnSale = patch.status === 'published' && current.status !== 'published';
  const becomesPaid = patch.price !== undefined && Number(patch.price) > 0 && !(Number(current.price) > 0);
  if (nextStatus === 'published' && nextPrice > 0 && (goesOnSale || becomesPaid)) await assertReadyToSell(ctx);
  // The same rule as the marketplace: what is sold is read from a private repository.
  if (nextPrice > 0 && current.source_repo && !current.source_private) {
    throw new HttpError(409, `${current.source_repo} is a public repository. The repository of a plugin that is sold must be private, so its source is not free for anyone to download. Make it private, save a read-only access token for it here, check for the release again, then set the price.`);
  }
  const rows = await update(ctx, 'dev_products', `id=eq.${enc(id)}`, patch, 'service');
  if (patch.release_source && patch.release_source !== current.release_source) await settleCurrentVersion(ctx, id);
  return (await select(ctx, `dev_products?id=eq.${enc(id)}&select=*`, 'service'))[0] || rows[0];
}

/** Deletes a plugin that was never ordered, with its stored packages. A plugin with orders is archived instead. */
export async function deleteProduct(ctx, id) {
  const product = (await select(ctx, `dev_products?id=eq.${enc(id)}&select=id,slug`, 'service'))[0];
  if (!product) throw new HttpError(404, 'That plugin does not exist.');
  const orders = await select(ctx, `dev_orders?product_id=eq.${enc(id)}&select=id&limit=1`, 'service');
  if (orders.length) throw new HttpError(409, 'This plugin has orders and licences, which have to be kept. Archive it instead: it disappears from the shop and keeps working for people who bought it.');
  const versions = await select(ctx, `dev_versions?product_id=eq.${enc(id)}&select=storage_path`, 'service');
  await clearSourceToken(ctx, id).catch(() => {});
  await remove(ctx, 'dev_products', `id=eq.${enc(id)}`);
  await Promise.all(versions.map((row) => deletePackage(ctx, row.storage_path)));
  return { deleted: true, slug: product.slug };
}

/* ------------------------------------------------------------------------------------------ versions */

/**
 * Which version the shop offers after a change: the highest published version of the source the owner prefers (a GitHub release by
 * default, or an uploaded ZIP). Until that source has a published version of its own, the other source's is offered.
 */
async function settleCurrentVersion(ctx, productId) {
  const rows = await select(ctx, `dev_versions?product_id=eq.${enc(productId)}&status=eq.published&select=version,source`, 'service');
  const product = (await select(ctx, `dev_products?id=eq.${enc(productId)}&select=status,release_source`, 'service'))[0];
  const preferred = product?.release_source === 'zip' ? 'zip' : 'github';
  const own = rows.filter((row) => row.source === preferred);
  const best = (own.length ? own : rows).map((row) => row.version).sort((a, b) => compareVersions(b, a))[0] || '';
  await update(ctx, 'dev_products', `id=eq.${enc(productId)}`, {
    current_version: best,
    ...(product?.status === 'published' && !best ? { status: 'draft' } : {}),
  }, 'service');
  return best;
}

/**
 * Scans and stores one package for a plugin and records it. `acceptFindings` is the developer's explicit "I have read what
 * the scan found": without it a package with advisory findings is stored but held back. A blocking finding is never stored.
 */
export async function storeVersion(ctx, { product, version, changelog, bytes, acceptFindings, userId, vetExtra = {} }) {
  if (!bytes?.length) throw new HttpError(400, 'Choose the plugin ZIP to upload.');
  if (bytes.length > MAX_PACKAGE_BYTES) throw new HttpError(413, `The package is ${Math.round(bytes.length / 1024 / 1024)} MB. The limit is ${MAX_PACKAGE_BYTES / 1024 / 1024} MB.`);
  let packed;
  try {
    packed = normalisePackage(unpackLimited(bytes));
  } catch (error) {
    throw asHttp(error);
  }
  const manifest = packed.manifest;
  if (manifest.id !== product.slug) {
    throw new HttpError(422, `This package is plugin "${manifest.id || ''}", but you are uploading to "${product.slug}". The manifest id has to match.`);
  }
  const declared = String(manifest.version || '').trim();
  const wanted = String(version || declared).trim();
  if (!versionFromTag(wanted) || wanted !== declared) {
    throw new HttpError(422, `The version is ${wanted || '(empty)'}, but manifest.json inside the ZIP says ${declared || '(none)'}. They must match, and look like 1.2.3.`);
  }
  const report = { ...vetFiles(packed.entries, { docsAreInert: true }), ...vetExtra };
  const severity = severityOf(report);
  if (severity === 'critical') {
    throw Object.assign(new HttpError(422, `The scan found a problem that blocks this package: ${(report.flags || []).slice(0, 3).join('; ') || 'see the report'}. Nothing was stored.`), { report });
  }
  const status = severity === 'clean' || acceptFindings ? 'published' : 'held';
  const path = `${product.slug}/${wanted}/${product.slug}-${wanted}.zip`;
  await uploadPackage(ctx, path, packed.zip);
  const recorded = await rpc(ctx, 'dev_record_version', {
    p: {
      product_id: product.id, version: wanted, storage_path: path, sha256: sha256Hex(packed.zip), size: packed.zip.length,
      changelog: String(changelog || '').slice(0, 8000), vet_report: { ...report, severity }, status, make_current: false, created_by: userId,
    },
  }, 'service');
  // The preferred source decides which published version the shop offers, not the order things arrive in.
  const current = status === 'published' ? await settleCurrentVersion(ctx, product.id) : product.current_version || '';
  return { ...recorded, current: current === wanted, current_version: current, severity, report: { ...report, severity }, held: status === 'held', sha256: sha256Hex(packed.zip) };
}

export async function uploadVersion(ctx, { productId, version, changelog, bytes, acceptFindings, userId }) {
  const product = (await select(ctx, `dev_products?id=eq.${enc(productId)}&select=id,slug,current_version`, 'service'))[0];
  if (!product) throw new HttpError(404, 'That plugin does not exist.');
  return storeVersion(ctx, { product, version, changelog, bytes, acceptFindings, userId });
}

/** The owner's decision on a version: publish a held one, or withdraw one. The shop's current version follows. */
export async function setVersionStatus(ctx, { versionId, status }) {
  if (!['published', 'withdrawn'].includes(status)) throw new HttpError(400, 'Choose publish or withdraw.');
  const row = (await select(ctx, `dev_versions?id=eq.${enc(versionId)}&select=id,product_id,version,status`, 'service'))[0];
  if (!row) throw new HttpError(404, 'That version does not exist.');
  await update(ctx, 'dev_versions', `id=eq.${enc(versionId)}`, { status }, 'service');
  const current = await settleCurrentVersion(ctx, row.product_id);
  return { version: row.version, status, current_version: current };
}

/* ------------------------------------------------------------------------------- GitHub release source */

/**
 * Brings the latest GitHub release of a repository into the shop. With `productId` it is a new version of that plugin
 * (the repository is linked on first use and is then the only source); without it a new draft plugin is created from the
 * release's manifest. A free plugin comes from a public repository, a plugin for sale from a private one (read with its own sealed token), read
 * exactly like the marketplace does. `token` is a token the owner just pasted; without one the stored token is used.
 */
export async function importFromRelease(ctx, { productId, repositoryUrl, acceptFindings, userId, fetchImpl = fetch, token = '' }) {
  const repository = productId
    ? null
    : (() => { try { return parseRepositoryUrl(repositoryUrl); } catch (error) { throw asHttp(error); } })();
  let product = productId
    ? (await select(ctx, `dev_products?id=eq.${enc(productId)}&select=id,slug,current_version,source_repo,source_repo_id,price,source_private`, 'service'))[0]
    : null;
  if (productId && !product) throw new HttpError(404, 'That plugin does not exist.');
  const address = product?.source_repo ? `https://github.com/${product.source_repo}` : repositoryUrl;

  if (!product) {
    const linked = await select(ctx, `dev_products?source_repo=eq.${enc(repository.fullName.toLowerCase())}&select=id,slug`, 'service');
    if (linked[0]) throw new HttpError(409, `${repository.fullName} is already linked to "${linked[0].slug}". Open that plugin and check it for a new release.`);
  }

  const privateToken = String(token || '').trim() || (product && (product.source_private || Number(product.price) > 0) ? await readSourceToken(ctx, product.id) : '');
  if (privateToken) requireSecretBox();
  let candidate;
  try {
    candidate = await resolveReleaseCandidate(address, {
      expectedSlug: product?.slug || '', isOwner: true, fetchImpl,
      allowPrivate: Boolean(privateToken), privateToken, requirePrivate: Number(product?.price) > 0,
    });
  } catch (error) {
    if (product) await update(ctx, 'dev_products', `id=eq.${enc(product.id)}`, { source_checked_at: new Date().toISOString(), source_error: String(error?.message || error).slice(0, 600) }, 'service').catch(() => {});
    throw asHttp(error);
  }

  if (product?.source_repo_id && product.source_repo_id !== candidate.repository.id) {
    throw new HttpError(409, `The repository behind ${product.source_repo} is not the one this plugin was linked to (its GitHub id changed), so its releases are not trusted. Remove the link and add it again if this is intended.`);
  }
  if (product && product.current_version && compareVersions(candidate.version, product.current_version) < 0) {
    return { changed: false, version: candidate.version, message: `The latest release (${candidate.version}) is older than the current version (${product.current_version}), so it was ignored.` };
  }
  const known = product ? (await select(ctx, `dev_versions?product_id=eq.${enc(product.id)}&version=eq.${enc(candidate.version)}&select=sha256,status`, 'service'))[0] : null;
  if (known && known.sha256 === candidate.sha256) {
    await update(ctx, 'dev_products', `id=eq.${enc(product.id)}`, { source_checked_at: new Date().toISOString(), source_error: '', source_last_tag: candidate.release.tag }, 'service');
    return { changed: false, version: candidate.version, message: `${candidate.version} is already in your shop; nothing new.` };
  }

  if (!product) {
    const taken = await select(ctx, `dev_products?slug=eq.${enc(candidate.id)}&select=id`, 'service');
    if (taken[0]) throw new HttpError(409, `You already have a plugin with the id "${candidate.id}". Open it and import the release there instead.`);
    product = await insert(ctx, 'dev_products', {
      slug: candidate.id, title: candidate.manifest.name.slice(0, 120), description: (candidate.manifest.description || candidate.repository.description || '').slice(0, 4000),
      category: CATEGORIES.includes(candidate.manifest.category) ? candidate.manifest.category : 'utility',
      status: 'draft', created_by: userId,
    }, 'service');
  }
  await update(ctx, 'dev_products', `id=eq.${enc(product.id)}`, {
    source_repo: candidate.repository.fullName.toLowerCase(), source_repo_id: candidate.repository.id, source_private: Boolean(candidate.repository.private),
    source_checked_at: new Date().toISOString(), source_last_tag: candidate.release.tag, source_error: '',
  }, 'service');
  if (candidate.repository.private && String(token || '').trim()) await writeSourceToken(ctx, product.id, token);

  // The package was already scanned and re-packed by the release reader; storeVersion scans the stored bytes again, so
  // what is judged is exactly what is kept.
  const stored = await storeVersion(ctx, {
    product: { ...product, current_version: product.current_version || '' },
    version: candidate.version, changelog: candidate.release.body, bytes: candidate.zip, acceptFindings, userId,
    vetExtra: { source: candidate.report.source },
  });
  return { changed: true, product_id: product.id, slug: product.slug, tag: candidate.release.tag, ...stored };
}

/**
 * New releases of the plugins linked to a GitHub repository, found without anyone pressing "Check for release": run when the store
 * or the admin is opened (bounded by the caller). Each plugin not looked at for `staleMs` gets one call for its newest tag; only a
 * new tag is read, scanned and stored (`importFromRelease`), and a clean one becomes the shop's version at once (findings are held
 * for the owner, as with the button). Free and paid alike: a private repository is asked with its own sealed token. Returns the
 * products that got a new version, so the caller can update their marketplace listing. Never throws.
 */
export const AUTO_RELEASE_CHECK_MS = 5 * 60 * 1000;
export async function checkProductReleases(ctx, { staleMs = AUTO_RELEASE_CHECK_MS, max = 5, now = Date.now(), fetchImpl = fetch } = {}) {
  if (!ctx.supabase?.secretKey) return { checked: 0, changed: [] };
  const cutoff = new Date(now - staleMs).toISOString();
  const rows = await select(ctx, 'dev_products?source_repo=like.*/*&managed_by=eq.&status=neq.archived'
    + `&or=${enc(`(source_checked_at.is.null,source_checked_at.lt.${cutoff})`)}&order=source_checked_at.asc.nullsfirst&limit=${max}`
    + '&select=id,slug,price,source_repo,source_private,source_last_tag,source_error', 'service').catch(() => []);
  const changed = [];
  const touch = (id) => update(ctx, 'dev_products', `id=eq.${enc(id)}`, { source_checked_at: new Date().toISOString() }, 'service').catch(() => {});
  await Promise.allSettled(rows.map(async (product) => {
    const privateToken = product.source_private || Number(product.price) > 0 ? await readSourceToken(ctx, product.id).catch(() => '') : '';
    if (product.source_last_tag && !product.source_error) {
      try {
        const tag = await latestReleaseTag(product.source_repo, { token: privateToken, fetchImpl });
        if (tag && tag === product.source_last_tag) return touch(product.id);
      } catch (error) {
        if (error?.code === 'github_rate_limit') return touch(product.id);
      }
    }
    try {
      const result = await importFromRelease(ctx, { productId: product.id, acceptFindings: false, userId: null, fetchImpl });
      if (result?.changed) changed.push(product.id);
    } catch {
      // importFromRelease recorded the reason on the product (source_error), where the Plugins screen shows it.
      await touch(product.id);
    }
  }));
  return { checked: rows.length, changed };
}

/* ------------------------------------------------------------------------------------- orders and licences */

/**
 * The licence for a verified payment (or a free claim): signs the key with the developer's own private key and lets SQL
 * record it once. Called only from the webhook handlers and `claimFree`.
 */
export async function completePaid(ctx, { orderId, ref, amount, currency }) {
  const order = (await select(ctx, `dev_orders?id=eq.${enc(orderId)}&select=id,product_id,provider,status`, 'service'))[0];
  if (!order) throw new HttpError(404, 'That order does not exist.');
  const product = (await select(ctx, `dev_products?id=eq.${enc(order.product_id)}&select=id,slug,license_days`, 'service'))[0];
  const { privateKey } = await licenseKeys(ctx);
  const stamp = expiryStamp(product.license_days);
  const serial = newSerial();
  const key = signLicenseKey({ plugin: product.slug, stamp, serial, privateKey });
  const end = expiryDate(stamp);
  const result = await rpc(ctx, 'dev_complete_order', {
    p_order: order.id, p_provider_ref: ref || '', p_amount: amount ?? 0, p_currency: currency || 'usd',
    p_serial: serial, p_key: key, p_expires: end ? end.toISOString() : null,
  }, 'service');
  // After SQL accepted it, once (a repeated callback returns the same licence with repeat: true).
  if (!result?.repeat) {
    await announcePayment('complete', { scope: 'developers', gateway: order.provider, order_id: order.id, amount: Number(amount ?? 0), currency: String(currency || 'usd').toUpperCase(), reference: ref || '', plugin: product.slug });
    // A listed plugin's sale goes onto the buyer's react-wp.com account (Buy reference, else their confirmed email address); never
    // throws, retried from the admin status.
    await reportPurchase(ctx, order.id);
  }
  return result;
}

export async function claimFree(ctx, user, productId, { platformRef = '' } = {}) {
  const order = await rpc(ctx, 'dev_place_order', { p_product: productId, p_user: user.id, p_provider: 'free' }, 'service');
  if (Number(order.amount) !== 0) throw new HttpError(400, 'This plugin is not free.');
  await rememberRef(ctx, order.order_id, platformRef);
  return completePaid(ctx, { orderId: order.order_id, ref: '', amount: 0, currency: 'usd' });
}

/** Opens a payment for a product. The browser sent a product id and a provider name; everything else is read here. */
export async function startCheckout(ctx, user, { productId, provider, platformRef = '', fetchImpl = fetch }) {
  const gateway = await shopGateway(provider);
  const config = await readPaymentsConfig(ctx);
  if (!gatewayEnabled(config, gateway.id)) throw new HttpError(409, `${gateway.label} is not available in this shop.`);
  const credentials = await gatewayCredentials({ readSecret: (name) => readSecret(ctx, name), config, gateway });
  const status = credentialStatus(gateway, credentials);
  if (!status.ready) {
    throw new HttpError(501, `${gateway.label} is switched on but not finished: ${status.missing.join(', ')} is not set. The shop owner has to finish it under Developers → Payments.`);
  }
  // The price is read in SQL from the product; the gateway is only handed the order's own amount.
  const order = await rpc(ctx, 'dev_place_order', { p_product: productId, p_user: user.id, p_provider: gateway.id }, 'service');
  // The buyer pressed Buy on react-wp.com: the reference stays with the order until the paid sale is reported there.
  await rememberRef(ctx, order.order_id, platformRef);
  const success = `${ctx.origin}/store?order=${order.order_id}&paid=1&gateway=${encodeURIComponent(gateway.id)}`;
  const cancel = `${ctx.origin}/store?cancelled=1`;
  try {
    const opened = await gateway.createCheckout({
      credentials,
      order: await checkoutOrder({ id: order.order_id, amount: Number(order.amount), currency: String(order.currency || 'usd').toUpperCase(), title: order.title, email: user.email || '' }, { scope: 'developers', gateway }),
      urls: { success, cancel, webhook: webhookUrl(ctx.origin, gateway.id) },
      idempotencyKey: `rwpd-order-${order.order_id}`,
      fetchImpl,
    });
    if (!/^https?:\/\//i.test(String(opened?.url || ''))) throw new HttpError(502, `${gateway.label} did not return a payment address.`);
    return { url: String(opened.url), id: String(opened.reference || '') };
  } catch (error) {
    await update(ctx, 'dev_orders', `id=eq.${enc(order.order_id)}`, { status: 'failed' }, 'service').catch(() => {});
    await announcePayment('failed', { scope: 'developers', gateway: gateway.id, order_id: order.order_id, amount: Number(order.amount), currency: 'USD', reason: error instanceof Error ? error.message : '' });
    throw gatewayErrorToHttp(error);
  }
}

/**
 * The buyer is back from a gateway that confirms on return (PayPal, or a plugin gateway without a webhook): the payment is read
 * from the gateway with the shop's own credentials, never trusted from the address, and applied once.
 */
export async function confirmReturn(ctx, user, { orderId, gatewayId, query, fetchImpl = fetch }) {
  const order = (await select(ctx, `dev_orders?id=eq.${enc(orderId)}&select=id,buyer_id,provider,status`, 'service'))[0];
  if (!order || order.buyer_id !== user.id) throw new HttpError(404, 'That order is not yours.');
  if (order.status === 'paid') return { status: 'paid' };
  if (order.provider !== gatewayId) throw new HttpError(400, 'That order was opened with another payment method.');
  const gateway = await shopGateway(gatewayId);
  if (!gateway.confirmReturn) return { status: order.status, pending: true };
  const config = await readPaymentsConfig(ctx);
  const credentials = await gatewayCredentials({ readSecret: (name) => readSecret(ctx, name), config, gateway });
  let result;
  try {
    result = await gateway.confirmReturn({ credentials, query: query && typeof query === 'object' ? query : {}, expectedOrderId: order.id, fetchImpl });
  } catch (error) {
    throw gatewayErrorToHttp(error);
  }
  const paid = (result?.events || []).find((event) => event.type === 'paid' && String(event.orderId) === String(order.id));
  if (!paid) return { status: order.status, pending: true };
  await completePaid(ctx, { orderId: order.id, ref: paid.reference, amount: paid.amount, currency: String(paid.currency || '').toLowerCase() });
  return { status: 'paid' };
}

/** A verified webhook of any gateway this shop offers (plugin gateways use `webhook/gateway/<id>`). Unverified: 401, nothing applied. */
export async function applyGatewayWebhook(ctx, { gatewayId, rawBody, headers, fetchImpl }) {
  const gateway = await shopGateway(gatewayId);
  const config = await readPaymentsConfig(ctx);
  const credentials = await gatewayCredentials({ readSecret: (name) => readSecret(ctx, name), config, gateway });
  let events;
  try {
    events = await verifiedWebhookEvents(gateway, { rawBody, headers, credentials, ...(fetchImpl ? { fetchImpl } : {}) });
  } catch (error) {
    throw gatewayErrorToHttp(error);
  }
  const applied = [];
  for (const event of events) {
    if (event.type !== 'paid' || !event.orderId) continue;
    const order = (await select(ctx, `dev_orders?id=eq.${enc(event.orderId)}&select=provider`, 'service'))[0];
    if (!order || order.provider !== gateway.id) continue;
    try {
      await completePaid(ctx, { orderId: event.orderId, ref: event.reference, amount: event.amount, currency: String(event.currency || '').toLowerCase() });
      applied.push(event.orderId);
    } catch (error) {
      // A verified callback the order refuses (amount short, already used): acknowledged so the gateway stops retrying, and logged.
      if (!(error instanceof HttpError) || error.status >= 500) throw error;
      console.warn(`[rwp-developers] a ${gateway.id} payment was acknowledged but not applied: ${error.message}`);
    }
  }
  return { received: true, applied };
}

/* -------------------------------------------------------------------------------- verification and download */

/**
 * Whether a key is good for a site. The signature is checked here first (a forged key never reaches the database), then
 * the database answers for revocation, expiry and the site the key is bound to.
 */
export async function verifyKey(ctx, { key, domain }) {
  const publicKey = await publicLicenseKey(ctx);
  const checked = verifyLicenseKey(key, { publicKey });
  if (checked.state === 'bad' || checked.state === 'no-key') return { valid: false, reason: 'unknown_key' };
  if (checked.state === 'expired') return { valid: false, reason: 'expired' };
  return rpc(ctx, 'dev_verify_license', { p_key: String(key).trim(), p_domain: String(domain || '') }, 'service');
}

async function packageFor(ctx, slug) {
  const product = (await select(ctx, `dev_products?slug=eq.${enc(slug)}&select=id,slug,title,price,current_version,status`, 'service'))[0];
  if (!product || !product.current_version) throw new HttpError(404, 'This plugin has no package to download right now.');
  const version = (await select(ctx, `dev_versions?product_id=eq.${enc(product.id)}&version=eq.${enc(product.current_version)}&status=eq.published&select=version,storage_path,sha256,size`, 'service'))[0];
  if (!version) throw new HttpError(404, 'This plugin has no package to download right now.');
  return { product, version };
}

/**
 * The copy one licence downloads: a priced plugin compiled, obfuscated and watermarked with the licence serial
 * (`buyerCopy` in server/platformSync.mjs), a free one as published. The developer keeps their readable source.
 */
async function deliveredCopy(ctx, found, licenseId) {
  const license = (await select(ctx, `dev_licenses?id=eq.${enc(licenseId)}&select=id,serial`, 'service'))[0];
  if (!license) throw new HttpError(404, 'That licence does not exist.');
  const copy = await buyerCopy(ctx, { product: found.product, version: found.version, license });
  return { ...copy, url: await signedPackageUrl(ctx, copy.path, 600) };
}

/** The host of a site address (`https://example.com/x` -> `example.com`), lower case, or ''. */
export const siteHost = (value) => {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  try {
    return new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`).host;
  } catch {
    return '';
  }
};

/** A download for a site that presents a licence key. */
export async function downloadForKey(ctx, { key, domain }) {
  const verdict = await verifyKey(ctx, { key, domain });
  if (!verdict?.valid) throw new HttpError(403, DOWNLOAD_REASONS[verdict?.reason] || 'This licence key cannot download the plugin.');
  const found = await packageFor(ctx, verdict.plugin);
  const copy = await deliveredCopy(ctx, found, verdict.license_id);
  return { plugin: found.product.slug, version: found.product.current_version, sha256: copy.sha256, size: copy.size, download_url: copy.url, expires_in: 600 };
}

/**
 * For a buyer's site that installs or updates the plugin by itself (core `server/developerPackages.mjs`): the licence must
 * verify for that site's host (the first request binds it, as any download does), and the answer is signed with this shop's
 * licence key pair over plugin, version, host, sha256 and a ten-minute expiry, so the site can prove the bytes are this shop's.
 */
export async function packageForSite(ctx, { key, domain }) {
  const host = siteHost(domain);
  if (!host) throw new HttpError(400, 'Send the address of the site the plugin is for.');
  const verdict = await verifyKey(ctx, { key, domain: host });
  if (!verdict?.valid) throw new HttpError(403, DOWNLOAD_REASONS[verdict?.reason] || 'This licence key cannot download the plugin.');
  const found = await packageFor(ctx, verdict.plugin);
  const license = (await select(ctx, `dev_licenses?id=eq.${enc(verdict.license_id)}&select=id,serial`, 'service'))[0];
  return signedPackage(ctx, { product: found.product, version: found.version, license, domain: host });
}

export const DOWNLOAD_REASONS = {
  unknown_key: 'That licence key is not valid for this shop.',
  revoked: 'This licence has been revoked.',
  expired: 'This licence has expired.',
  other_site: 'This licence is already in use on another site. Its owner can release it from their purchases.',
};

/** A download for the signed-in buyer, from their own licence. */
export async function downloadForBuyer(ctx, user, licenseId) {
  const license = (await select(ctx, `dev_licenses?id=eq.${enc(licenseId)}&user_id=eq.${enc(user.id)}&select=id,status,expires_at,product_id`, 'service'))[0];
  if (!license) throw new HttpError(404, 'That licence is not yours.');
  if (license.status !== 'active') throw new HttpError(403, DOWNLOAD_REASONS.revoked);
  if (license.expires_at && Date.parse(license.expires_at) <= Date.now()) throw new HttpError(403, DOWNLOAD_REASONS.expired);
  const product = (await select(ctx, `dev_products?id=eq.${enc(license.product_id)}&select=slug`, 'service'))[0];
  const found = await packageFor(ctx, product.slug);
  const copy = await deliveredCopy(ctx, found, license.id);
  return { plugin: found.product.slug, version: found.product.current_version, sha256: copy.sha256, download_url: copy.url, expires_in: 600 };
}

/** A buyer may free the site a licence is bound to (to move it). The owner can do the same from the admin. */
export async function releaseDomain(ctx, user, licenseId) {
  const rows = await update(ctx, 'dev_licenses', `id=eq.${enc(licenseId)}&user_id=eq.${enc(user.id)}`, { domain: null }, 'service');
  if (!rows.length) throw new HttpError(404, 'That licence is not yours.');
  return { released: true };
}

/** Reads a package back from private storage and checks it still has the checksum recorded for it. */
export async function verifyStoredPackage(ctx, versionId) {
  const row = (await select(ctx, `dev_versions?id=eq.${enc(versionId)}&select=storage_path,sha256`, 'service'))[0];
  if (!row) throw new HttpError(404, 'That version does not exist.');
  const bytes = await readPackage(ctx, row.storage_path);
  return { ok: sha256Hex(bytes) === row.sha256, sha256: row.sha256 };
}
