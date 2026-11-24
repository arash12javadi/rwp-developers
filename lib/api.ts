import { describeDbError, getSupabaseClient } from '../../../src/lib/db';
import type {
  DevLicense, DevOrder, DevProduct, DevRefund, DevRefundResult, DevVersion, ImportResult, MyLicense, PaymentSettingsInput, PaymentStatus,
  StoreCatalog, UploadResult,
} from './types';

const ROUTES = '/api/plugins/rwp-developers';

const accessToken = async (): Promise<string> => {
  const { data } = await getSupabaseClient().auth.getSession();
  return data.session?.access_token || '';
};

/** One call to this plugin's server routes. A refusal is thrown as an Error carrying the server's own sentence. */
async function request<T>(route: string, method: 'GET' | 'POST', body?: BodyInit, json = false): Promise<T> {
  const headers: Record<string, string> = {};
  const token = await accessToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (json) headers['Content-Type'] = 'application/json';
  let response: Response;
  try {
    response = await fetch(`${ROUTES}/${route}`, { method, headers, body });
  } catch {
    throw new Error('The shop server could not be reached. Check your connection and try again.');
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload?.error || payload?.message;
    if (response.status === 404 && !detail) {
      throw new Error('This site has no developer shop server. It needs the Node server (npm start) or the Vercel functions, and the Developers plugin activated.');
    }
    throw new Error(detail || `The shop server answered HTTP ${response.status}.`);
  }
  return payload as T;
}

const post = <T>(route: string, body: Record<string, unknown> = {}) => request<T>(route, 'POST', JSON.stringify(body), true);
const get = <T>(route: string) => request<T>(route, 'GET');

/* --------------------------------------------------------------------------------------------- the store */
export const loadStore = () => get<StoreCatalog>('store/catalog');
export const claimPlugin = (productId: string) => post<{ license_key: string }>('claim', { product_id: productId });
export const startCheckout = (productId: string, provider: string) => post<{ url: string }>('checkout/start', { product_id: productId, provider });
export const myLicenses = () => get<{ licenses: MyLicense[] }>('my/licenses').then((answer) => answer.licenses);
export const downloadMine = (licenseId: string) => post<{ download_url: string; version: string; sha256: string }>('my/download', { license_id: licenseId });
export const releaseMyDomain = (licenseId: string) => post<{ released: boolean }>('my/release-domain', { license_id: licenseId });
/** Refunds, the buyer's side: ask the shop's owner (their answer is final), see the answer, withdraw while it waits. */
export const myRefunds = () => get<{ refunds: DevRefund[] }>('my/refunds').then((answer) => answer.refunds);
export const askForRefund = (orderId: string, reason: string, amount?: number | null) =>
  post<{ refund: DevRefund }>('my/refund-request', { order_id: orderId, reason, ...(amount ? { amount } : {}) });
export const withdrawRefund = (refundId: string) => post<{ refund: DevRefund }>('my/refund-cancel', { refund_id: refundId });

/** Refunds, the owner's side. A Stripe refund is sent on approval; a NOWPayments (USDT) refund is sent by hand and then recorded. */
export const ownerRefunds = () => get<{ refunds: DevRefund[] }>('admin/refunds').then((answer) => answer.refunds);
export const decideRefund = (refundId: string, approve: boolean, note: string, revoke = false) =>
  post<DevRefundResult>('admin/refunds/decide', { refund_id: refundId, approve, note, revoke });
export const issueRefund = (input: { order_id: string; amount?: number | null; note: string; revoke: boolean; manual: boolean; payout_reference?: string }) =>
  post<DevRefundResult>('admin/refunds/issue', input);
export const retryRefund = (refundId: string) => post<DevRefundResult>('admin/refunds/send', { refund_id: refundId });
export const markRefundPaid = (refundId: string, payoutReference: string) =>
  post<DevRefundResult>('admin/refunds/mark-paid', { refund_id: refundId, payout_reference: payoutReference });

/* -------------------------------------------------------------------------------------------- the owner */
export const adminStatus = () => get<PaymentStatus>('admin/status');
export const savePayments = (input: PaymentSettingsInput) => post<PaymentStatus>('admin/payments/save', input as unknown as Record<string, unknown>);
/** Copies the owner's marketplace plugins into this list. Answers `available: false` when the marketplace is not installed. */
export const syncMarketplace = () => post<{ available: boolean; created: number; updated: number; archived: number; errors: string[] }>('admin/marketplace/sync');
export const prepareBucket = () => post<{ ready: boolean }>('admin/bucket/prepare');
export const saveProduct = (input: Partial<DevProduct> & { id?: string }) => post<{ product: DevProduct }>('admin/products/save', input as Record<string, unknown>);
export const deleteProduct = (id: string) => post<{ deleted: boolean }>('admin/products/delete', { id });
export const setVersionStatus = (versionId: string, status: 'published' | 'withdrawn') => post<{ current_version: string }>('admin/versions/status', { version_id: versionId, status });
export const verifyStored = (versionId: string) => post<{ ok: boolean }>('admin/versions/verify', { version_id: versionId });
export const importRelease = (input: { repository_url?: string; product_id?: string; accept_findings?: boolean; token?: string }) => post<ImportResult>('admin/source/import', input);

/** The ZIP goes as multipart, so a large package is not base64-inflated into a JSON body. */
export const uploadVersion = (input: { productId: string; version: string; changelog: string; file: File; acceptFindings: boolean }) => {
  const form = new FormData();
  form.set('product_id', input.productId);
  form.set('version', input.version);
  form.set('changelog', input.changelog);
  form.set('accept_findings', input.acceptFindings ? 'true' : 'false');
  form.set('file', input.file, input.file.name);
  return request<UploadResult>('admin/versions/upload', 'POST', form);
};

/* The owner's lists are read straight from the database: row level security lets only manage_options see them. */
const must = <T>(result: { data: T | null; error: unknown }): T => {
  if (result.error) throw new Error(describeDbError(result.error));
  return (result.data ?? ([] as unknown)) as T;
};

export const listProducts = async () => must<DevProduct[]>(await getSupabaseClient().from('dev_products').select('*').order('created_at', { ascending: false }));
export const listVersions = async (productId: string) =>
  must<DevVersion[]>(await getSupabaseClient().from('dev_versions').select('*').eq('product_id', productId).order('created_at', { ascending: false }));
export const listOrders = async () =>
  must<DevOrder[]>(await getSupabaseClient().from('dev_orders').select('id,product_id,buyer_id,provider,amount,currency,status,created_at,paid_at,refunded_amount,dev_products(title,slug)').order('created_at', { ascending: false }).limit(200));
export const listLicenses = async () =>
  must<DevLicense[]>(await getSupabaseClient().from('dev_licenses').select('id,product_id,user_id,serial,status,expires_at,domain,created_at,dev_products(title,slug)').order('created_at', { ascending: false }).limit(200));

export const setLicenseStatus = async (id: string, revoked: boolean) => {
  const rows = must<Array<{ id: string }>>(await getSupabaseClient().from('dev_licenses')
    .update({ status: revoked ? 'revoked' : 'active', revoked_at: revoked ? new Date().toISOString() : null }).eq('id', id).select('id'));
  if (!rows.length) throw new Error('The change was refused: only an administrator can revoke a licence.');
};
export const clearLicenseDomain = async (id: string) => {
  const rows = must<Array<{ id: string }>>(await getSupabaseClient().from('dev_licenses').update({ domain: null }).eq('id', id).select('id'));
  if (!rows.length) throw new Error('The change was refused: only an administrator can release a site.');
};
