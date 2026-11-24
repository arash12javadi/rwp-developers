-- rwp-developers uninstall.
-- Run only when an administrator asks to wipe the developer shop's data. Drops only what schema.sql creates.
-- Deliberately keeps: the packages uploaded to Supabase Storage (bucket rwp-developer-packages): delete that bucket
-- in the Supabase dashboard if you want the files gone. Nothing outside these tables and functions is touched.

drop table if exists public.dev_refunds cascade;
drop table if exists public.dev_licenses cascade;
drop table if exists public.dev_orders cascade;
drop table if exists public.dev_versions cascade;
drop table if exists public.dev_products cascade;
drop table if exists public.dev_settings cascade;
drop table if exists public.dev_secrets cascade;

drop function if exists public.dev_store_catalog();
drop function if exists public.dev_place_order(uuid, uuid, text);
drop function if exists public.dev_complete_order(uuid, text, numeric, text, text, text, timestamptz);
drop function if exists public.dev_verify_license(text, text);
drop function if exists public.dev_my_licenses();
drop function if exists public.dev_record_version(jsonb);
drop function if exists public.dev_refund_open(uuid, uuid, text, numeric);
drop function if exists public.dev_refund_cancel(uuid, uuid);
drop function if exists public.dev_refund_decide(uuid, uuid, boolean, text, boolean);
drop function if exists public.dev_refund_issue(uuid, uuid, numeric, text, boolean);
drop function if exists public.dev_refund_claim(uuid);
drop function if exists public.dev_refund_release(uuid, text);
drop function if exists public.dev_refund_settle(uuid, text, text, uuid);
drop function if exists public.dev_refund_from_gateway(text, text, numeric, uuid);
drop function if exists public.dev_touch();
