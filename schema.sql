-- rwp-developers database schema.
-- Installed on activation (POST /api/admin/plugins/install-schema), never by supabase/schema.sql. Safe to re-run:
-- tables are "if not exists", functions are "or replace", policies and triggers are dropped by name first.
-- Requires the core schema (auth.users, public.profiles, public.user_has_cap).
--
-- This is a developer's OWN shop: their products, their packages, their orders and their licence keys live in
-- their own Supabase project, and nothing here refers to the react-wp.com marketplace.

create table if not exists public.dev_products (
  id uuid primary key default gen_random_uuid(),
  -- The plugin id: what manifest.json says and what a licence key is issued for.
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
  title text not null check (length(title) between 1 and 120),
  description text not null default '' check (length(description) <= 4000),
  category text not null default 'utility',
  -- Always USD. A price of 0 is a free plugin; the amount an order charges is read from here, never from a request.
  price numeric(12,2) not null default 0 check (price >= 0 and price <= 100000),
  -- null = a licence never expires; otherwise a licence lasts this many days from the payment.
  license_days integer check (license_days is null or license_days between 1 and 3650),
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  current_version text not null default '',
  -- Set when the plugin is published from a GitHub release (see server/sourceFlow.mjs of the marketplace).
  source_repo text not null default '',
  source_repo_id text not null default '',
  source_checked_at timestamptz,
  source_last_tag text not null default '',
  source_error text not null default '',
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists dev_products_source_repo_idx on public.dev_products (lower(source_repo)) where source_repo <> '';
create index if not exists dev_products_status_idx on public.dev_products(status);

-- One row per uploaded version. The package itself is a private object in Storage (`storage_path`); only the
-- server ever reads it, and only for a buyer whose licence verifies.
create table if not exists public.dev_versions (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.dev_products(id) on delete cascade,
  version text not null check (length(version) between 1 and 40),
  storage_path text not null,
  sha256 text not null default '',
  size bigint not null default 0,
  changelog text not null default '' check (length(changelog) <= 8000),
  vet_report jsonb not null default '{}'::jsonb,
  -- held = stored but not offered (the scan found something the developer has not accepted yet).
  status text not null default 'published' check (status in ('published', 'held', 'withdrawn')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (product_id, version)
);
create index if not exists dev_versions_product_idx on public.dev_versions(product_id, created_at desc);

-- Two ways to publish, one rule for which one rules: a plugin's live version is the newest published version of its preferred source
-- (`release_source`: the latest GitHub release, the default, or an uploaded ZIP). Until the preferred source has a published version of its
-- own, the other source's is offered, so a shop window is never empty because of the preference.
alter table public.dev_products add column if not exists release_source text not null default 'github';
alter table public.dev_products drop constraint if exists dev_products_release_source_check;
alter table public.dev_products add constraint dev_products_release_source_check check (release_source in ('github', 'zip'));
-- A plugin for sale is read from a private repository, with its own read-only token (sealed in dev_secrets, never in this table).
alter table public.dev_products add column if not exists source_private boolean not null default false;
-- A plugin the site owner publishes in the react-wp.com marketplace (rwp-plugin-marketplace, when it is installed on the same project) is
-- mirrored here so the owner sees every plugin in one list. The marketplace rules: a mirrored row (`managed_by = 'marketplace'`) is rewritten
-- from the marketplace on every sync, cannot be edited, uploaded to or deleted here, and is never sold by this shop (the marketplace sells it).
alter table public.dev_products add column if not exists managed_by text not null default '';
alter table public.dev_products drop constraint if exists dev_products_managed_by_check;
alter table public.dev_products add constraint dev_products_managed_by_check check (managed_by in ('', 'marketplace'));
alter table public.dev_products add column if not exists marketplace_plugin_id uuid;
-- Where a version came from, derived so it cannot disagree with its report: the release reader records `source` in the scan report, an upload does not.
alter table public.dev_versions add column if not exists source text generated always as (case when vet_report -> 'source' is not null then 'github' else 'zip' end) stored;

create table if not exists public.dev_orders (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.dev_products(id) on delete restrict,
  buyer_id uuid not null references auth.users(id) on delete restrict,
  provider text not null check (provider in ('stripe', 'nowpayments', 'free')),
  amount numeric(12,2) not null check (amount >= 0),
  currency text not null default 'usd',
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed', 'refunded')),
  provider_ref text not null default '',
  created_at timestamptz not null default now(),
  paid_at timestamptz
);
create index if not exists dev_orders_buyer_idx on public.dev_orders(buyer_id, created_at desc);
create index if not exists dev_orders_product_idx on public.dev_orders(product_id);
-- A provider's payment id can complete one order only.
create unique index if not exists dev_orders_provider_ref_idx on public.dev_orders(provider, provider_ref) where provider_ref <> '';

create table if not exists public.dev_licenses (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.dev_products(id) on delete restrict,
  order_id uuid not null unique references public.dev_orders(id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete restrict,
  license_key text not null unique,
  serial text not null unique,
  status text not null default 'active' check (status in ('active', 'revoked')),
  expires_at timestamptz,
  -- The site the key is bound to: set by the first successful verify, then fixed (one licence, one site).
  domain text,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create index if not exists dev_licenses_user_idx on public.dev_licenses(user_id);
create index if not exists dev_licenses_product_idx on public.dev_licenses(product_id);

-- Non-secret settings. One row. Which providers are on, test or live, and the public half of the licence key.
create table if not exists public.dev_settings (
  id boolean primary key default true check (id),
  payments jsonb not null default '{}'::jsonb,
  license_public_key text not null default '',
  updated_at timestamptz not null default now()
);
insert into public.dev_settings (id) values (true) on conflict (id) do nothing;

-- Secrets (Stripe and NOWPayments keys, the licence private key), each sealed with RWP_SECRET_BOX_KEY before it is
-- written. RLS is on and NO policy exists: only the server's secret key reaches this table, never a browser.
create table if not exists public.dev_secrets (
  name text primary key check (name ~ '^[a-z0-9_]{1,64}$'),
  value text not null,
  updated_at timestamptz not null default now()
);

create or replace function public.dev_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists dev_products_touch on public.dev_products;
create trigger dev_products_touch before update on public.dev_products
  for each row execute function public.dev_touch();
drop trigger if exists dev_settings_touch on public.dev_settings;
create trigger dev_settings_touch before update on public.dev_settings
  for each row execute function public.dev_touch();

alter table public.dev_products enable row level security;
alter table public.dev_versions enable row level security;
alter table public.dev_orders enable row level security;
alter table public.dev_licenses enable row level security;
alter table public.dev_settings enable row level security;
alter table public.dev_secrets enable row level security;

drop policy if exists "Public reads published products" on public.dev_products;
create policy "Public reads published products"
  on public.dev_products for select to anon, authenticated
  using (status = 'published' and managed_by = '');

drop policy if exists "Owners manage developer products" on public.dev_products;
create policy "Owners manage developer products"
  on public.dev_products for all to authenticated
  using (public.user_has_cap('manage_options'))
  with check (public.user_has_cap('manage_options'));

-- Versions hold storage paths, so only the owner reads them directly; the store reads through dev_store_catalog().
drop policy if exists "Owners manage developer versions" on public.dev_versions;
create policy "Owners manage developer versions"
  on public.dev_versions for all to authenticated
  using (public.user_has_cap('manage_options'))
  with check (public.user_has_cap('manage_options'));

drop policy if exists "Buyers read own orders" on public.dev_orders;
create policy "Buyers read own orders"
  on public.dev_orders for select to authenticated
  using (buyer_id = auth.uid());

drop policy if exists "Owners read developer orders" on public.dev_orders;
create policy "Owners read developer orders"
  on public.dev_orders for select to authenticated
  using (public.user_has_cap('manage_options'));

drop policy if exists "Buyers read own licenses" on public.dev_licenses;
create policy "Buyers read own licenses"
  on public.dev_licenses for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "Owners manage developer licenses" on public.dev_licenses;
create policy "Owners manage developer licenses"
  on public.dev_licenses for all to authenticated
  using (public.user_has_cap('manage_options'))
  with check (public.user_has_cap('manage_options'));

drop policy if exists "Owners manage developer settings" on public.dev_settings;
create policy "Owners manage developer settings"
  on public.dev_settings for all to authenticated
  using (public.user_has_cap('manage_options'))
  with check (public.user_has_cap('manage_options'));

-- The public shop window: published products and their current published version, without a storage path.
create or replace function public.dev_store_catalog()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id, 'slug', p.slug, 'title', p.title, 'description', p.description, 'category', p.category,
    'price', p.price, 'license_days', p.license_days, 'version', p.current_version,
    'changelog', coalesce(v.changelog, ''), 'size', coalesce(v.size, 0), 'updated_at', coalesce(v.created_at, p.updated_at)
  ) order by p.title), '[]'::jsonb)
  from public.dev_products p
  join public.dev_versions v on v.product_id = p.id and v.version = p.current_version and v.status = 'published'
  where p.status = 'published' and p.managed_by = '';
$$;

-- Opens an order at the stored price. service_role only: the browser can ask for a product, never for an amount.
create or replace function public.dev_place_order(p_product uuid, p_user uuid, p_provider text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_product public.dev_products%rowtype;
  v_order public.dev_orders%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the server can open an order.' using errcode = '42501';
  end if;
  select * into v_product from public.dev_products where id = p_product and status = 'published' and managed_by = '';
  if v_product.id is null or not exists (
    select 1 from public.dev_versions v where v.product_id = v_product.id and v.version = v_product.current_version and v.status = 'published'
  ) then
    raise exception 'That plugin is not for sale.' using errcode = 'P0002';
  end if;
  if exists (
    select 1 from public.dev_licenses l
    where l.product_id = v_product.id and l.user_id = p_user and l.status = 'active'
      and (l.expires_at is null or l.expires_at > now())
  ) then
    raise exception 'You already have a valid licence for this plugin.' using errcode = '23505';
  end if;
  if v_product.price = 0 and p_provider <> 'free' then
    raise exception 'This plugin is free; claim it instead of paying.' using errcode = '22023';
  end if;
  if v_product.price > 0 and p_provider not in ('stripe', 'nowpayments') then
    raise exception 'Choose a payment method.' using errcode = '22023';
  end if;
  insert into public.dev_orders (product_id, buyer_id, provider, amount, currency)
  values (v_product.id, p_user, p_provider, v_product.price, 'usd')
  returning * into v_order;
  return jsonb_build_object('order_id', v_order.id, 'amount', v_order.amount, 'currency', v_order.currency,
    'slug', v_product.slug, 'title', v_product.title, 'license_days', v_product.license_days);
end;
$$;

-- Marks an order paid and records its licence, once. service_role only: the server calls it after the provider
-- itself has confirmed the payment. A second call for the same order returns the same licence, so a repeated
-- webhook never mints a second key. The amount the provider reports must cover the stored amount.
create or replace function public.dev_complete_order(
  p_order uuid, p_provider_ref text, p_amount numeric, p_currency text,
  p_serial text, p_key text, p_expires timestamptz
)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_order public.dev_orders%rowtype;
  v_license public.dev_licenses%rowtype;
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the server can complete an order.' using errcode = '42501';
  end if;
  select * into v_order from public.dev_orders where id = p_order for update;
  if v_order.id is null then
    raise exception 'Order not found.' using errcode = 'P0002';
  end if;
  select * into v_license from public.dev_licenses where order_id = v_order.id;
  if v_license.id is not null then
    return jsonb_build_object('license_id', v_license.id, 'license_key', v_license.license_key, 'repeat', true);
  end if;
  if v_order.status not in ('pending') then
    raise exception 'This order is % and cannot be completed.', v_order.status using errcode = '22023';
  end if;
  if v_order.provider <> 'free' then
    if coalesce(p_provider_ref, '') = '' then
      raise exception 'The provider did not name the payment.' using errcode = '22023';
    end if;
    if lower(coalesce(p_currency, '')) <> v_order.currency or coalesce(p_amount, 0) < v_order.amount then
      raise exception 'The payment (% %) does not cover the order (% %).', p_amount, p_currency, v_order.amount, v_order.currency using errcode = '22023';
    end if;
  end if;
  if coalesce(p_key, '') = '' or coalesce(p_serial, '') = '' then
    raise exception 'A licence key is required.' using errcode = '22023';
  end if;
  update public.dev_orders
     set status = 'paid', paid_at = now(), provider_ref = coalesce(p_provider_ref, '')
   where id = v_order.id;
  insert into public.dev_licenses (product_id, order_id, user_id, license_key, serial, expires_at)
  values (v_order.product_id, v_order.id, v_order.buyer_id, p_key, p_serial, p_expires)
  returning * into v_license;
  return jsonb_build_object('license_id', v_license.id, 'license_key', v_license.license_key, 'repeat', false);
end;
$$;

-- Checks a licence key for a site and binds it to that site the first time. service_role only: the public route
-- verifies the signature first, then asks here whether the key is still good. Answers { valid:false, reason } rather
-- than raising, so a wrong key and a revoked one read the same way to a caller.
create or replace function public.dev_verify_license(p_key text, p_domain text)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_license public.dev_licenses%rowtype;
  v_product public.dev_products%rowtype;
  v_domain text := nullif(lower(trim(coalesce(p_domain, ''))), '');
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the server can verify a licence.' using errcode = '42501';
  end if;
  select * into v_license from public.dev_licenses where license_key = p_key for update;
  if v_license.id is null then
    return jsonb_build_object('valid', false, 'reason', 'unknown_key');
  end if;
  select * into v_product from public.dev_products where id = v_license.product_id;
  if v_license.status <> 'active' then
    return jsonb_build_object('valid', false, 'reason', 'revoked');
  end if;
  if v_license.expires_at is not null and v_license.expires_at <= now() then
    return jsonb_build_object('valid', false, 'reason', 'expired', 'expires_at', v_license.expires_at);
  end if;
  if v_domain is not null then
    if v_license.domain is null then
      update public.dev_licenses set domain = v_domain where id = v_license.id;
      v_license.domain := v_domain;
    elsif v_license.domain <> v_domain then
      return jsonb_build_object('valid', false, 'reason', 'other_site');
    end if;
  end if;
  return jsonb_build_object('valid', true, 'reason', 'ok', 'plugin', v_product.slug, 'version', v_product.current_version,
    'expires_at', v_license.expires_at, 'domain', v_license.domain, 'license_id', v_license.id);
end;
$$;

-- The signed-in buyer's own licences, with the plugin they are for.
create or replace function public.dev_my_licenses()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in to see your licences.' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', l.id, 'plugin', p.slug, 'title', p.title, 'license_key', l.license_key, 'status', l.status,
      'expires_at', l.expires_at, 'domain', l.domain, 'version', p.current_version, 'created_at', l.created_at
    ) order by l.created_at desc)
    from public.dev_licenses l
    join public.dev_products p on p.id = l.product_id
    where l.user_id = auth.uid()
  ), '[]'::jsonb);
end;
$$;

-- Records an uploaded version and, when asked, makes it the one the store offers. service_role only: the server has
-- already scanned the package and stored the object.
create or replace function public.dev_record_version(p jsonb)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare
  v_product public.dev_products%rowtype;
  v_version text := trim(coalesce(p->>'version', ''));
  v_status text := coalesce(p->>'status', 'published');
  v_current boolean := coalesce((p->>'make_current')::boolean, false);
begin
  if auth.role() <> 'service_role' then
    raise exception 'Only the server can record a version.' using errcode = '42501';
  end if;
  if v_status not in ('published', 'held', 'withdrawn') then
    raise exception 'Invalid version status.' using errcode = '22023';
  end if;
  select * into v_product from public.dev_products where id = (p->>'product_id')::uuid;
  if v_product.id is null then
    raise exception 'Plugin not found.' using errcode = 'P0002';
  end if;
  insert into public.dev_versions (product_id, version, storage_path, sha256, size, changelog, vet_report, status, created_by)
  values (v_product.id, v_version, p->>'storage_path', coalesce(p->>'sha256', ''), coalesce((p->>'size')::bigint, 0),
          left(coalesce(p->>'changelog', ''), 8000), coalesce(p->'vet_report', '{}'::jsonb), v_status, nullif(p->>'created_by', '')::uuid)
  on conflict (product_id, version) do update
    set storage_path = excluded.storage_path, sha256 = excluded.sha256, size = excluded.size,
        changelog = excluded.changelog, vet_report = excluded.vet_report, status = excluded.status, created_at = now()
    where public.dev_versions.status <> 'published' or v_product.current_version is distinct from excluded.version;
  if v_current and v_status = 'published' then
    update public.dev_products set current_version = v_version where id = v_product.id;
  end if;
  return jsonb_build_object('product_id', v_product.id, 'version', v_version, 'status', v_status, 'current', v_current and v_status = 'published');
end;
$$;

revoke execute on function public.dev_touch() from public, anon, authenticated;
revoke execute on function public.dev_place_order(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.dev_complete_order(uuid, text, numeric, text, text, text, timestamptz) from public, anon, authenticated;
revoke execute on function public.dev_verify_license(text, text) from public, anon, authenticated;
revoke execute on function public.dev_record_version(jsonb) from public, anon, authenticated;
grant execute on function public.dev_place_order(uuid, uuid, text) to service_role;
grant execute on function public.dev_complete_order(uuid, text, numeric, text, text, text, timestamptz) to service_role;
grant execute on function public.dev_verify_license(text, text) to service_role;
grant execute on function public.dev_record_version(jsonb) to service_role;
-- The shop window is public on purpose (it returns published products only, never a storage path).
grant execute on function public.dev_store_catalog() to anon, authenticated;
-- A buyer's own licences need a session; an anonymous caller gets nothing, not even the function.
revoke execute on function public.dev_my_licenses() from public, anon;
grant execute on function public.dev_my_licenses() to authenticated;

revoke all on public.dev_secrets from anon, authenticated;
grant all on public.dev_secrets to service_role;
-- The server reads and writes these with the secret key. Newer Supabase projects no longer hand
-- service_role table privileges by default, so grant them explicitly (else: "permission denied for table").
grant all on public.dev_settings to service_role;
grant all on public.dev_products to service_role;
grant all on public.dev_versions to service_role;
grant all on public.dev_orders to service_role;
grant all on public.dev_licenses to service_role;
revoke all on public.dev_orders from anon;
revoke insert, update, delete on public.dev_orders from authenticated;
revoke all on public.dev_licenses from anon;
revoke insert, update, delete on public.dev_licenses from authenticated;
-- An owner may revoke a licence or release its domain, nothing else.
grant update (status, revoked_at, domain) on public.dev_licenses to authenticated;
revoke all on public.dev_versions from anon;
revoke all on public.dev_settings from anon;

notify pgrst, 'reload schema';
