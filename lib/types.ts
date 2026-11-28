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
  /** Which source rules the version the shop offers: the latest GitHub release (the default) or the newest uploaded ZIP. */
  release_source: 'github' | 'zip';
  /** True when the repository is private (a plugin for sale); its read-only token is sealed on the server. */
  source_private: boolean;
  source_checked_at: string | null;
  source_last_tag: string;
  source_error: string;
  /** 'marketplace' = a mirror of one of the owner's marketplace plugins: the marketplace rules it, so it is read-only here. */
  managed_by?: '' | 'marketplace';
  /** The marketplace listing a mirror row copies (null on a plugin of this shop). */
  marketplace_plugin_id?: string | null;
  created_at: string;
}

/** One plugin of this shop sent to the React-WP marketplace (`dev_listings`). */
export interface DevListing {
  product_id: string;
  /** True while new versions and price changes are sent by themselves. */
  requested: boolean;
  sent_version: string;
  sent_price: number | null;
  /** react-wp.com's listing status: pending, approved, rejected, unlisted, deprecated; '' before the first answer. */
  status: string;
  message: string;
  error: string;
  plugin_id: string | null;
  sent_at: string | null;
  checked_at: string | null;
  /** Buyer complaints still open on react-wp.com (a count only). */
  open_complaints?: number;
}
export interface ListingOverview { connected: boolean; domain: string; listings: DevListing[]; refresh_error: string }
export interface ListingSendResult { listing: DevListing | null; verdict: string; message: string; sent_package: boolean }

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
  /** Where it came from: a GitHub release or an uploaded ZIP. */
  source?: 'github' | 'zip';
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
  refunded_amount?: number;
  /** When the sale was recorded on the buyer's react-wp.com account, and the last error doing so. */
  platform_reported_at?: string | null;
  platform_error?: string;
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
  /** The order that paid for it, so a buyer can ask for a refund of it. */
  order_id: string;
  order_status: DevOrder['status'];
  amount: number;
  currency: string;
  provider: DevOrder['provider'];
  refunded_amount: number;
  paid_at: string | null;
}

/** requested -> approved | declined (final) | cancelled; approved -> processing -> refunded (or back to approved with the error). */
export type DevRefundStatus = 'requested' | 'declined' | 'approved' | 'processing' | 'refunded' | 'cancelled';

export interface DevRefund {
  id: string;
  order_id: string;
  amount: number;
  currency: string;
  reason: string;
  owner_note: string;
  status: DevRefundStatus;
  origin: 'buyer' | 'owner' | 'gateway';
  revoke_license: boolean;
  gateway_refund_id: string | null;
  payout_reference: string;
  error: string;
  decided_at: string | null;
  refunded_at: string | null;
  created_at: string;
  updated_at: string;
  /** The owner's list: when a decline was reported to react-wp.com (or refused for good), and the last error. */
  platform_reported_at?: string | null;
  platform_error?: string;
  /** Approved without a decision: asked within 28 days of the payment (the shop cannot decline or take it back). */
  automatic?: boolean;
  /** The buyer's list: a decline react-wp.com was told about, so its marketplace owner can be asked to rule. */
  appealable?: boolean;
  /** The owner's list only. */
  order?: { id: string; product_id: string; provider: DevOrder['provider']; amount: number; refunded_amount: number; currency: string; created_at: string } | null;
  product?: { id: string; title: string; slug: string } | null;
  buyer_name?: string;
  /** The gateway that refunds through its own API ('stripe', or a plugin gateway's id), or 'manual'. */
  refund_method?: string;
}

export interface DevRefundResult { refund: DevRefund; sent: boolean; method?: string; refund_id?: string; message?: string }

export interface ProviderCheck { enabled: boolean; missing: string[]; ready: boolean }
/** One credential field a payment gateway asks for (server/payments/registry.mjs). */
export interface GatewayField { name: string; label: string; type: 'secret' | 'text' | 'boolean'; required: boolean; help: string }
/** A payment gateway as the Payments screen sees it: names, fields (never values), switch, and what it still needs. */
export interface GatewayCheck {
  id: string;
  label: string;
  buyer_label: string;
  description: string;
  built_in: boolean;
  plugin: string;
  credential_fields: GatewayField[];
  supports: { refund: boolean; confirmReturn: boolean; webhook: boolean; probe: boolean };
  enabled: boolean;
  missing: string[];
  ready: boolean;
  webhook_url: string;
}
export interface PaymentStatus {
  config: { stripe: { enabled: boolean }; nowpayments: { enabled: boolean; sandbox: boolean; pay_currency: string } };
  secrets: Record<string, boolean>;
  checks: { stripe: ProviderCheck; nowpayments: ProviderCheck };
  /** Every gateway, the built-ins first, then the ones active plugins added. */
  gateways?: GatewayCheck[];
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
  /** Plugin gateways: the switch, and any field typed (blank = keep the stored one). */
  gateways?: Record<string, { enabled: boolean; fields: Record<string, string | boolean> }>;
}

export interface UploadResult { version: string; status: string; current: boolean; held: boolean; severity: 'clean' | 'advisory' | 'critical'; report: VetReportShape; sha256: string }
export interface ImportResult extends Partial<UploadResult> { changed: boolean; message?: string; slug?: string; tag?: string; product_id?: string }

/** A conversation react-wp.com holds about one of this shop's plugins (Developers → Messages). */
export interface InboxTicket {
  id: string;
  kind: 'presale' | 'support' | 'refund';
  subject: string;
  status: 'open' | 'answered' | 'closed';
  refund_status: 'none' | 'requested' | 'approved' | 'declined' | 'escalated' | 'ruled_buyer' | 'ruled_seller' | 'cancelled';
  refund_amount: number | null;
  decision_reason: string;
  last_message_at: string;
  plugin_title: string;
  plugin_slug: string;
  buyer_name: string;
  /** The seller's display name (the other side when this account is the buyer). */
  seller_name?: string;
  /** Who wrote first: a buyer, or the seller (a message started from Sales or Messages). */
  opened_by?: 'buyer' | 'seller' | 'owner';
}

/** The buyer of one order, read on demand for the shop's owner. */
export interface BuyerContact {
  order_id: string;
  name: string;
  email: string;
  /** The purchase is on the buyer's react-wp.com account, so a conversation can be started there. */
  on_platform: boolean;
  has_key: boolean;
}

/** A plugin this account owns whose seller it can write to. */
export interface SellerPlugin {
  plugin_id: string;
  title: string;
  seller_name: string;
}

export interface InboxThread {
  /** How this account takes part: the seller of the plugin, or a buyer of someone else's. */
  role: 'seller' | 'buyer';
  ticket: InboxTicket;
  messages: Array<{ id: string; author_role: 'buyer' | 'seller' | 'owner' | 'system'; body: string; created_at: string }>;
  purchase: { license_serial: string; amount: number; currency: string; status: string; created_at: string } | null;
  dispute: { status: 'open' | 'ruled'; ruling: string | null; ruling_note: string } | null;
  /** The order and licence of this shop the refund is about, when they were found here by the key's serial. */
  local: { license: { id: string; status: string; domain: string | null }; order: { id: string; provider: string; amount: number; refunded_amount: number; currency: string; status: string } | null } | null;
}
