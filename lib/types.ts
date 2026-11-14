export type ProductStatus = 'draft' | 'published' | 'archived';

export interface DevProduct {
  id: string;
  slug: string;
  title: string;
  description: string;
  category: string;
  price: number;
  license_days: number | null;
  status: ProductStatus;
  current_version: string;
  source_repo: string;
  source_checked_at: string | null;
  source_last_tag: string;
  source_error: string;
  created_at: string;
}

export interface VetFinding { name: string; ok: boolean; detail: string }
export interface VetReportShape { pass?: boolean; severity?: 'clean' | 'advisory' | 'critical'; checks?: VetFinding[]; flags?: string[] }

export interface DevVersion {
  id: string;
  product_id: string;
  version: string;
  sha256: string;
  size: number;
  changelog: string;
  status: 'published' | 'held' | 'withdrawn';
  vet_report: VetReportShape;
  created_at: string;
}

export interface DevOrder {
  id: string;
  product_id: string;
  buyer_id: string;
  provider: 'stripe' | 'nowpayments' | 'free';
  amount: number;
  currency: string;
  status: 'pending' | 'paid' | 'failed' | 'refunded';
  created_at: string;
  paid_at: string | null;
  dev_products?: { title: string; slug: string } | null;
}

export interface DevLicense {
  id: string;
  product_id: string;
  user_id: string;
  serial: string;
  status: 'active' | 'revoked';
  expires_at: string | null;
  domain: string | null;
  created_at: string;
  dev_products?: { title: string; slug: string } | null;
}

export interface StoreProduct {
  id: string;
  slug: string;
  title: string;
  description: string;
  category: string;
  price: number;
  license_days: number | null;
  version: string;
  changelog: string;
  size: number;
  updated_at: string;
}
export interface StoreCatalog { products: StoreProduct[]; methods: Array<{ id: 'stripe' | 'nowpayments'; label: string }> }

export interface MyLicense {
  id: string;
  plugin: string;
  title: string;
  license_key: string;
  status: 'active' | 'revoked';
  expires_at: string | null;
  domain: string | null;
  version: string;
  created_at: string;
}

export interface ProviderCheck { enabled: boolean; missing: string[]; ready: boolean }
export interface PaymentStatus {
  config: { stripe: { enabled: boolean }; nowpayments: { enabled: boolean; sandbox: boolean; pay_currency: string } };
  secrets: Record<string, boolean>;
  checks: { stripe: ProviderCheck; nowpayments: ProviderCheck };
  secret_box: boolean;
  license_public_key: string;
  webhook_urls: { stripe: string; nowpayments: string };
  max_package_mb: number;
  snippet: string;
}
export interface PaymentSettingsInput {
  stripe: { enabled: boolean };
  nowpayments: { enabled: boolean; sandbox: boolean; pay_currency?: string };
  secrets: Record<string, string>;
  clear?: string[];
}

export interface UploadResult { version: string; status: string; current: boolean; held: boolean; severity: 'clean' | 'advisory' | 'critical'; report: VetReportShape; sha256: string }
export interface ImportResult extends Partial<UploadResult> { changed: boolean; message?: string; slug?: string; tag?: string; product_id?: string }
