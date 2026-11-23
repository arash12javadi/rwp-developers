/**
 * The owner's marketplace plugins, listed in the developer shop too.
 *
 * When the marketplace plugin (rwp-plugin-marketplace) is installed on the same Supabase project, every plugin whose author is the
 * site's owner (a user with the administrator or super_admin role) is copied into `dev_products` as a MIRROR row
 * (`managed_by = 'marketplace'`). The marketplace is the source of truth and always wins:
 *   - a mirror row is rewritten from the marketplace on every sync, so a change made in Marketplace → Inventory shows up here;
 *   - it cannot be edited, uploaded to, checked or deleted here (`refuseManaged`), and the shop never sells it (the SQL
 *     filters `managed_by = ''` in the public catalogue and in `dev_place_order`): the marketplace sells it, with its own licences;
 *   - a plugin of this shop that has the same id as a marketplace plugin of the owner is adopted: from then on the marketplace rules it;
 *   - a mirror row whose marketplace plugin was removed is archived, never deleted, so nothing that was ordered is lost.
 * Without the marketplace tables (a developer's own site) nothing happens and nothing fails.
 */
import { HttpError, insert, select, update } from './supabase.mjs';

const enc = encodeURIComponent;
const OWNER_ROLES = ['administrator', 'super_admin'];
const CATEGORIES = ['utility', 'commerce', 'marketing', 'seo', 'media', 'developer', 'integration'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** approved = on sale; deprecated and unlisted are hidden; pending and rejected are not live. */
const STATUS = { approved: 'published', deprecated: 'archived', unlisted: 'archived' };

/** The columns of a mirror row, from one marketplace listing. */
export function mirrorRowFrom(plugin) {
  const repo = String(plugin.source_repo || '').trim().toLowerCase();
  return {
    slug: String(plugin.slug || ''),
    title: String(plugin.title || plugin.slug || '').slice(0, 120) || String(plugin.slug || ''),
    description: String(plugin.description || '').slice(0, 4000),
    category: CATEGORIES.includes(String(plugin.category)) ? String(plugin.category) : 'utility',
    price: Math.min(100000, Math.max(0, Math.round((Number(plugin.price) || 0) * 100) / 100)),
    status: STATUS[plugin.status] || 'draft',
    current_version: String(plugin.version || ''),
    release_source: plugin.release_source === 'zip' ? 'zip' : 'github',
    source_repo: repo,
    source_repo_id: String(plugin.source_repo_id || ''),
    source_private: Boolean(plugin.source_private),
    source_checked_at: plugin.source_checked_at || null,
    source_last_tag: String(plugin.source_last_tag || ''),
    source_error: String(plugin.source_error || ''),
    managed_by: 'marketplace',
    marketplace_plugin_id: UUID.test(String(plugin.id)) ? plugin.id : null,
  };
}

const MIRRORED = Object.keys(mirrorRowFrom({}));
const same = (row, wanted) => MIRRORED.every((key) => String(row[key] ?? '') === String(wanted[key] ?? ''));

/**
 * Brings the mirror rows in line with the marketplace. Returns `{ available, created, updated, archived, errors }`;
 * `available: false` means the marketplace is not installed here. Never throws for a marketplace problem.
 */
export async function syncMarketplaceMirror(ctx) {
  const result = { available: true, created: 0, updated: 0, archived: 0, errors: [] };
  let plugins;
  try {
    const owners = await select(ctx, `profiles?role=in.(${OWNER_ROLES.join(',')})&select=id`, 'service');
    const ids = owners.map((row) => row.id).filter((id) => UUID.test(String(id)));
    plugins = ids.length ? await select(ctx, `rwp_plugins?author_id=in.(${ids.join(',')})&select=*`, 'service') : [];
  } catch (error) {
    // The marketplace tables are absent (a developer's own site) or unreadable: this is not an error of the shop.
    if (error instanceof HttpError && error.status === 501) throw error;
    return { ...result, available: false };
  }

  const rows = await select(ctx, 'dev_products?select=id,slug,status,managed_by,marketplace_plugin_id,price,title,description,category,current_version,release_source,source_repo,source_repo_id,source_private,source_checked_at,source_last_tag,source_error', 'service');
  const bySlug = new Map(rows.map((row) => [row.slug, row]));
  const seen = new Set();

  for (const plugin of plugins) {
    const wanted = mirrorRowFrom(plugin);
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(wanted.slug) || !wanted.title) continue;
    seen.add(wanted.slug);
    const existing = bySlug.get(wanted.slug);
    try {
      if (!existing) {
        await insert(ctx, 'dev_products', wanted, 'service');
        result.created += 1;
      } else if (!same(existing, wanted)) {
        // The slug and the creation data stay; everything the marketplace owns is rewritten (and an adopted shop plugin becomes a mirror).
        const { slug: _slug, ...patch } = wanted;
        await update(ctx, 'dev_products', `id=eq.${enc(existing.id)}`, patch, 'service');
        result.updated += 1;
      }
    } catch (error) {
      result.errors.push(`${wanted.slug}: ${error instanceof Error ? error.message : 'could not be mirrored'}`.slice(0, 300));
    }
  }

  for (const row of rows) {
    if (row.managed_by !== 'marketplace' || seen.has(row.slug) || row.status === 'archived') continue;
    try {
      await update(ctx, 'dev_products', `id=eq.${enc(row.id)}`, { status: 'archived' }, 'service');
      result.archived += 1;
    } catch (error) {
      result.errors.push(`${row.slug}: ${error instanceof Error ? error.message : 'could not be archived'}`.slice(0, 300));
    }
  }
  return result;
}

/** Throws the sentence for an edit of a mirror row. `productId` is a product id; `versionId` a version id. */
export async function refuseManaged(ctx, { productId = '', versionId = '' } = {}) {
  let id = productId;
  if (!id && versionId) {
    id = (await select(ctx, `dev_versions?id=eq.${enc(versionId)}&select=product_id`, 'service'))[0]?.product_id || '';
  }
  if (!id) return;
  const row = (await select(ctx, `dev_products?id=eq.${enc(id)}&select=managed_by`, 'service'))[0];
  if (row?.managed_by === 'marketplace') {
    throw new HttpError(409, 'This plugin is managed by the Marketplace, which rules it. Change it in Marketplace → Inventory → Manage; the change shows up here at the next sync.');
  }
}
