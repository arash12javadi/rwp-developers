/**
 * Minimal PostgREST / Storage calls for the developer shop's server routes, in three trust levels:
 *  - "anon": the publishable key, as any visitor.
 *  - "user": the caller's own access token, so row level security applies to them.
 *  - "service": SUPABASE_SECRET_KEY, used only for what the SQL grants to service_role (orders, licences, secrets).
 *
 * Self-contained on purpose: this plugin ships to developers' own sites, which have no marketplace plugin.
 */

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const PACKAGE_BUCKET = 'rwp-developer-packages';
const enc = encodeURIComponent;
const base = (ctx) => ctx.supabase.url.replace(/\/$/, '');

const headersFor = (ctx, auth) => {
  const { publishableKey, secretKey } = ctx.supabase;
  if (auth === 'service') {
    if (!secretKey) {
      throw new HttpError(501, 'SUPABASE_SECRET_KEY is not set on this server. The developer shop needs it to record orders and licences and to store packages. Add it to the environment variables and restart or redeploy.');
    }
    return { apikey: secretKey, Authorization: `Bearer ${secretKey}` };
  }
  if (auth === 'user') {
    if (!ctx.bearerToken) throw new HttpError(401, 'Sign in required.');
    return { apikey: publishableKey, Authorization: `Bearer ${ctx.bearerToken}` };
  }
  return { apikey: publishableKey, Authorization: `Bearer ${publishableKey}` };
};

/** SQLSTATEs the shop's own functions raise on purpose; their message is meant for the caller. */
const DOMAIN_ERROR_CODES = new Set(['P0001', 'P0002', '22023', '23503', '23505']);

export async function rpc(ctx, name, args = {}, auth = 'anon') {
  const response = await fetch(`${base(ctx)}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { ...headersFor(ctx, auth), 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = text; }
  if (response.ok) return payload;
  const message = payload?.message || (typeof payload === 'string' ? payload : '') || `HTTP ${response.status}`;
  const code = typeof payload?.code === 'string' ? payload.code : '';
  if (code === 'PGRST202') {
    throw new HttpError(500, `The database function ${name} is missing from ${ctx.supabase.url}. Activate the Developers plugin under Plugins so its schema installs, or apply plugins/rwp-developers/schema.sql in the Supabase SQL Editor.`);
  }
  if (response.status === 404 && code) {
    throw new HttpError(500, `The database function ${name} failed inside ${ctx.supabase.url}: ${message} (SQLSTATE ${code}).`);
  }
  if (response.status === 401 || response.status === 403) throw new HttpError(response.status, message);
  if (DOMAIN_ERROR_CODES.has(code) || (response.status >= 400 && response.status < 500)) {
    throw new HttpError(code === '23505' ? 409 : 400, message);
  }
  throw new HttpError(502, `The database refused ${name}: ${message}${code ? ` (SQLSTATE ${code})` : ''}.`);
}

export async function select(ctx, path, auth = 'anon') {
  const response = await fetch(`${base(ctx)}/rest/v1/${path}`, { headers: headersFor(ctx, auth) });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new HttpError(500, `Supabase read of ${path.split('?')[0]} failed (HTTP ${response.status})${payload?.message ? `: ${payload.message}` : ''}.`);
  }
  return response.json();
}

/** PATCH rows matching `filter`; returns the rows. */
export async function update(ctx, table, filter, values, auth = 'service') {
  const response = await fetch(`${base(ctx)}/rest/v1/${table}?${filter}`, {
    method: 'PATCH',
    headers: { ...headersFor(ctx, auth), 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(values),
  });
  if (!response.ok) throw new HttpError(500, `Supabase update of ${table} failed (HTTP ${response.status}).`);
  return response.json();
}

/** Inserts one row and returns it. */
export async function insert(ctx, table, values, auth = 'service') {
  const response = await fetch(`${base(ctx)}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...headersFor(ctx, auth), 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(values),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    if (payload?.code === '23505') throw new HttpError(409, 'That already exists.');
    throw new HttpError(response.status === 401 || response.status === 403 ? response.status : 500,
      `Supabase insert into ${table} failed (HTTP ${response.status})${payload?.message ? `: ${payload.message}` : ''}.`);
  }
  const rows = await response.json();
  return Array.isArray(rows) ? rows[0] : rows;
}

/** Inserts or replaces by the unique column named in `onConflict`. */
export async function upsert(ctx, table, row, onConflict, auth = 'service') {
  const response = await fetch(`${base(ctx)}/rest/v1/${table}?on_conflict=${enc(onConflict)}`, {
    method: 'POST',
    headers: { ...headersFor(ctx, auth), 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(row),
  });
  if (!response.ok) throw new HttpError(500, `Supabase write to ${table} failed (HTTP ${response.status}).`);
}

export async function remove(ctx, table, filter, auth = 'service') {
  if (!String(filter || '').includes('=')) throw new HttpError(500, `Refusing to delete from ${table} without a filter.`);
  const response = await fetch(`${base(ctx)}/rest/v1/${table}?${filter}`, {
    method: 'DELETE',
    headers: { ...headersFor(ctx, auth), Prefer: 'return=minimal' },
  });
  if (!response.ok) throw new HttpError(500, `Supabase delete from ${table} failed (HTTP ${response.status}).`);
}

/** The signed-in user the request carries, verified against Supabase Auth. */
export async function currentUser(ctx) {
  if (!ctx.bearerToken) throw new HttpError(401, 'Sign in required.');
  const response = await fetch(`${base(ctx)}/auth/v1/user`, {
    headers: { apikey: ctx.supabase.publishableKey, Authorization: `Bearer ${ctx.bearerToken}` },
  });
  if (!response.ok) throw new HttpError(401, 'Your session has expired. Sign in again.');
  const user = await response.json();
  return { id: String(user.id), email: String(user.email || '') };
}

/** `manage_options`, asked of the database for the caller's own session. */
export async function requireOwner(ctx) {
  if (!ctx.bearerToken) throw new HttpError(401, 'Sign in as a site administrator to do this.');
  const allowed = await rpc(ctx, 'user_has_cap', { capability: 'manage_options' }, 'user').catch(() => false);
  if (allowed !== true) throw new HttpError(403, 'Your role cannot manage the developer shop. It needs the manage_options capability.');
}

/** Creates the private package bucket when it is missing. Idempotent: an existing bucket is fine. */
export async function ensureBucket(ctx) {
  const { secretKey } = ctx.supabase;
  if (!secretKey) throw new HttpError(501, 'SUPABASE_SECRET_KEY is not set, so the package bucket cannot be prepared.');
  const response = await fetch(`${base(ctx)}/storage/v1/bucket`, {
    method: 'POST',
    headers: { apikey: secretKey, Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: PACKAGE_BUCKET, name: PACKAGE_BUCKET, public: false, file_size_limit: 41943040 }),
  });
  if (response.ok) return;
  const payload = await response.json().catch(() => null);
  const text = `${payload?.message || ''} ${payload?.error || ''}`;
  if (response.status === 409 || /already exists|Duplicate/i.test(text)) return;
  throw new HttpError(502, `Supabase Storage could not create the ${PACKAGE_BUCKET} bucket (HTTP ${response.status}): ${text.trim() || 'no reason given'}.`);
}

const pathOf = (path) => String(path || '').split('/').filter(Boolean).map(enc).join('/');

export async function uploadPackage(ctx, path, bytes) {
  const { secretKey } = ctx.supabase;
  if (!secretKey) throw new HttpError(501, 'SUPABASE_SECRET_KEY is not set, so the package could not be stored.');
  await ensureBucket(ctx);
  const response = await fetch(`${base(ctx)}/storage/v1/object/${PACKAGE_BUCKET}/${pathOf(path)}`, {
    method: 'POST',
    headers: { apikey: secretKey, Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/zip', 'x-upsert': 'true' },
    body: bytes,
  });
  if (!response.ok) throw new HttpError(502, `Supabase Storage rejected the upload (HTTP ${response.status}): ${await response.text()}`);
  return path;
}

export async function deletePackage(ctx, path) {
  const { secretKey } = ctx.supabase;
  if (!secretKey) return;
  await fetch(`${base(ctx)}/storage/v1/object/${PACKAGE_BUCKET}/${pathOf(path)}`, {
    method: 'DELETE', headers: { apikey: secretKey, Authorization: `Bearer ${secretKey}` },
  }).catch(() => {});
}

/** A short-lived address for one private object. The bucket is never public. */
export async function signedPackageUrl(ctx, path, expiresIn = 600) {
  const { secretKey } = ctx.supabase;
  if (!secretKey) throw new HttpError(501, 'SUPABASE_SECRET_KEY is not set, so the package cannot be handed out.');
  const response = await fetch(`${base(ctx)}/storage/v1/object/sign/${PACKAGE_BUCKET}/${pathOf(path)}`, {
    method: 'POST',
    headers: { apikey: secretKey, Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.signedURL) {
    throw new HttpError(502, `Supabase Storage could not sign the package (HTTP ${response.status}): ${payload?.message || payload?.error || 'no signed URL returned'}`);
  }
  return `${base(ctx)}/storage/v1${payload.signedURL.startsWith('/') ? '' : '/'}${payload.signedURL}`;
}

export async function readPackage(ctx, path) {
  const { secretKey } = ctx.supabase;
  if (!secretKey) throw new HttpError(501, 'SUPABASE_SECRET_KEY is not set, so the package cannot be read.');
  const response = await fetch(`${base(ctx)}/storage/v1/object/${PACKAGE_BUCKET}/${pathOf(path)}`, {
    headers: { apikey: secretKey, Authorization: `Bearer ${secretKey}` },
  });
  if (!response.ok) throw new HttpError(502, `Supabase Storage could not read the package (HTTP ${response.status}).`);
  return new Uint8Array(await response.arrayBuffer());
}
