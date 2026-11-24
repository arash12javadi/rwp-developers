<div align="center">

# 🧑‍💻 RWP Developers

**Test, publish and sell your plugins from your own site.**

![Edition](https://img.shields.io/badge/edition-public-blue)
![Licence](https://img.shields.io/badge/licence-free-green)
![Version](https://img.shields.io/badge/version-1.0.0-blue)

</div>

One plugin for people who make plugins. Everything it does happens on **your own site, in your own Supabase project, with
your own payment accounts**. Nothing is sent to react-wp.com, and react-wp.com is not involved in what you sell.

| Screen | What it is for |
|---|---|
| **Plugin Check** | Test a plugin ZIP in the browser before you install it ([details](./check/README.md)). |
| **Your plugins** | Create plugins, import a GitHub release (the default) or upload versions (ZIP), choose which of the two rules, set a price, put them on sale. |
| **Sales & licences** | Every order and every licence key; revoke a key, release the site it is bound to; refunds (buyers' requests, and refunding any order). |
| **Payments & key** | Your Stripe and NOWPayments credentials, your licence public key, your package storage. |
| **`/store`** (and `[rwp_developer_store]`) | The public shop: what is on sale, buy or claim, "My purchases" with downloads. |

Free plugins you want **everyone** to find in the React-WP marketplace are published differently: give the marketplace your
public GitHub repository and publish ordinary GitHub releases (see the marketplace's README). This plugin is for what you
**sell or hand out yourself**.

## For you, the developer (Owner of the site)

### One-time setup

1. **Activate the plugin** under *Plugins*. That installs its database tables (`dev_*`) in your Supabase project.
2. Set these environment variables on the site (the **Setup Wizard** already asks for the first three):
   - `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`;
   - **`RWP_SECRET_BOX_KEY`**: 32 random bytes, base64 (`node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"`).
     It seals your payment credentials and your licence private key in the database. Without it nothing can be saved, and
     the screen says so.
3. Open **Developers → Payments & key**:
   - **Stripe:** paste the secret key and the webhook signing secret. In Stripe add a webhook endpoint at the address the
     screen shows (`…/api/plugins/rwp-developers/webhook/stripe`) for the events `checkout.session.completed`,
     `refund.created`, `refund.updated` and `charge.refunded` (the last three record refunds made in the Stripe dashboard).
   - **NOWPayments (USDT):** paste the API key and the IPN secret; set the IPN callback to the address shown. Use the sandbox
     switch while you test.
   - Switch the methods on and save. Credentials are sealed on the server and are never shown again; the screen only says
     whether each is set.
4. Your **licence key pair** is created the first time a method is switched on. The screen shows the public half and a short
   check you paste into a plugin you sell.

### Publish and sell a plugin

1. **Developers → Your plugins → New plugin** (id = the `id` in your `manifest.json`, which cannot change later), or
   **Import from a GitHub release** (a repository with a published release). A plugin you **sell** must come from a **private**
   repository: paste a fine-grained GitHub token with read-only "Contents" access to that one repository (it is sealed in your
   database with `RWP_SECRET_BOX_KEY` and never shown again; replace it any time under the plugin's *GitHub release* panel). A free
   plugin from a public repository needs no token. A priced plugin whose repository is public is refused.
2. Add a **version** from a GitHub release (it is read when you press *Check for new release*, and whenever the screen opens more than
   six hours after the last look) or by uploading the **ZIP**, with the version equal to `version` in its `manifest.json`. **You choose which
   source rules** (*Which source rules the live version*, default **the latest GitHub release**): the shop offers the newest published
   version of that source, the other source is kept ready and used only until the chosen source has a version of its own. The package is scanned
   first: a *blocking* finding (no valid manifest, `eval`, a server secret) is never stored; *something to read* (network
   calls, storage access) is stored but **held back** until you publish it or tick "publish even if the scan finds
   something to read".
3. Set the **price** (0 = free), optionally how many **days a licence lasts** (empty = lifetime), and set the plugin **On sale**.
   A plugin with no published version cannot be put on sale.
4. Your shop is at **`/store`**, or put `[rwp_developer_store title="Plugins"]` on any page.

A buyer signs in, pays (or claims a free plugin), and finds their **licence key** and a **Download** button under *My
purchases*. They install the ZIP under *Plugins → Upload* and enter the key where your plugin asks for it.

### Your marketplace plugins are listed here too

When the Marketplace plugin is installed on the same Supabase project, every plugin whose author is the site owner (an administrator or super admin) is **mirrored** into *Developers → Your plugins* with a **Marketplace** badge, each time the list opens. **The Marketplace rules them**: title, price, status, version and GitHub release are changed in *Marketplace → Inventory → Manage* and are rewritten here at the next sync; a mirrored plugin cannot be edited, uploaded to, checked or deleted here, and this shop never sells it (the Marketplace does, with its own licences). A plugin of this shop with the same id as one of the owner's marketplace plugins is adopted (the Marketplace wins); one removed from the Marketplace is archived here, never deleted. On a developer's own site, without the Marketplace, nothing is mirrored. Re-apply `schema.sql` after updating (two new columns, `managed_by` and `marketplace_plugin_id`, and the public catalogue and order functions now skip mirrored rows). Plugins created only in this shop are not copied into the Marketplace.

### Refunds

You are the seller, so you decide, and your answer is final.

- **A buyer asks** from *My purchases* on `/store` (**Ask for a refund**: a reason, and optionally a smaller amount). They can withdraw
  it while it waits. You see it under **Sales & licences → Refunds**.
- **You answer:** *Approve refund* or *Decline (final)* with a reason the buyer reads. A declined order cannot be asked about again.
- **You refund without being asked:** **Refund…** on a paid order in **Sales & licences → Orders** (all, or part of it).
- **Card (Stripe):** approving refunds it through your own Stripe account at once. It is claimed in the database first and sent with an
  idempotency key, so a double click never refunds twice; if Stripe refuses, it stays *approved* with Stripe's reason and you can try
  again. Add the events `refund.created`, `refund.updated` and `charge.refunded` to your Stripe webhook: a refund you make in the
  Stripe dashboard is then recorded here once.
- **USDT (NOWPayments):** NOWPayments has no refund API. Send the USDT back from your wallet, then press **Mark as refunded** with the
  transaction hash.
- A **full** refund revokes the licence (its key stops verifying and downloading) and marks the order `refunded`; a partial refund keeps
  the licence unless you tick *Also revoke the licence*. After a refund the buyer can buy the plugin again. *Sales & licences* shows the
  total after refunds.
- The buyer is **not emailed** about refunds (this plugin sends no email); they see the answer on `/store`. Tell them yourself if you
  want them to know sooner.

### Checking a licence in your own plugin

A key looks like `RWPD1.<plugin id>.<YYYYMMDD or NEVER>.<serial>.<signature>` and is signed with **your** private key. Your
plugin embeds only the **public** key and can verify a key with no network call (the screen shows the exact code). For a
check that also knows about revocation and the site, call your shop:

```
POST https://your-site/api/plugins/rwp-developers/verify    { "license_key": "…", "domain": "buyer-site.com" }
POST https://your-site/api/plugins/rwp-developers/download  { "license_key": "…", "domain": "buyer-site.com" }
GET  https://your-site/api/plugins/rwp-developers/public-key
```

The first successful `verify` binds the key to that site; another site is refused until the buyer (or you) releases it.

## For the people who buy from you (Client)

Nothing to set up. Sign in on your shop, buy or claim, download from *My purchases*, upload the ZIP, enter the key. To get your
money back, press **Ask for a refund** on the purchase and say why; the shop's answer appears on the same page. A full refund ends
the licence.

## How it is protected

- **The price is never taken from the browser.** An order is opened in SQL at the plugin's stored price; the browser sends a
  plugin id and a payment method.
- **A payment is believed only after the provider's own signature verifies** (Stripe `Stripe-Signature`, NOWPayments
  `x-nowpayments-sig`, both over the raw body). SQL then checks the amount and currency cover the order and mints the
  licence **once**: a repeated webhook returns the same key. One provider payment id can complete one order.
- **Licences are signed with your own key**, generated on your site; the private half is sealed (`RWP_SECRET_BOX_KEY`) and
  has no policy in the database, so only the server reads it. A key for one plugin does not unlock another; the expiry is
  inside the signature.
- **Packages are private.** The `rwp-developer-packages` bucket is never public; a download is a ten-minute signed address,
  handed out only for a licence that verifies (not revoked, not expired, the right site).
- **Every uploaded version is scanned and re-packed** before it is stored; the stored copy is the scanned copy, with its
  SHA-256 recorded ("Check file" re-reads it and compares).
- **Access:** the owner screens need `manage_options`; the owner's lists are read through row level security; orders and
  licences cannot be written from a browser at all. `verify`/`download` are rate limited per address (a per-instance brake;
  forged keys are rejected before any database call).
- **Fail closed:** no `RWP_SECRET_BOX_KEY` means no credential is stored; a stored credential that cannot be opened is an
  error that names the cause.

## Limits and honest notes

- **Not run against live Stripe, NOWPayments, Supabase or Vercel yet.** The server logic, the SQL (in a real Postgres), and the
  signature checks are tested; a first real payment in test mode is the remaining proof. Use Stripe's test keys and the
  NOWPayments sandbox first.
- **Refunds are built in (see *Refunds*); chargebacks are not.** A card dispute is handled in Stripe; revoke the licence here yourself.
  USDT refunds are sent by hand (no NOWPayments refund API).
- **Taxes, invoices and payouts are yours**: this plugin records orders, it does not file anything for you.
- **Upload size:** a Vercel function accepts about 4.5 MB per request, so a larger ZIP has to come from a **GitHub release**
  (the server downloads it, up to 40 MB). A self-hosted `npm start` site has no such limit below 40 MB.
- **A licence check inside a plugin can be removed by a buyer who edits the plugin's code.** The signature stops anyone from
  minting keys; it cannot stop a determined buyer from deleting the check, as with any client-side licensing.
- The scan is a text check, not proof a plugin is safe or works.
- Currency is US dollars. Buying needs an account on the site (the licence belongs to it).

## For maintainers

- `schema.sql` / `uninstall.sql`: `dev_products`, `dev_versions`, `dev_orders`, `dev_licenses`, `dev_refunds`, `dev_settings`, `dev_secrets`.
  Refunds: `dev_refund_open` / `_cancel` / `_decide` / `_issue` / `_claim` / `_release` / `_settle` / `_from_gateway`, all
  service-role only (`server/refunds.mjs` checks the session or `manage_options` first); `dev_refunds` has RLS on, no policy, and no
  browser grants.
  The schema is safe to re-run. If Payments & keys or the GitHub release import shows
  `permission denied for table dev_settings` (HTTP 403), re-run `schema.sql` in the Supabase SQL editor: it grants
  `service_role` access to the `dev_*` tables.
  RLS is on everywhere; `dev_secrets` has none (server only). `dev_place_order`, `dev_complete_order`, `dev_verify_license`
  and `dev_record_version` are service-role only.
- `server.mjs` routes; `server/store.mjs` logic; `server/payments.mjs`, `server/license.mjs`, `server/secrets.mjs`,
  `server/supabase.mjs`. The scanner and the GitHub release reader are core (`server/pluginVet.mjs`, `server/releaseSource.mjs`).
- Tests: `tests/developers.test.mjs` (server logic, in-memory Supabase) and `tests/sqlChecks/developers.mjs` (real Postgres via
  PGlite when installed: `npm i --no-save @electric-sql/pglite`).
- The plugin ships to clients as a free plugin release (`npm run plugin:release -- rwp-developers`); it is **not** part of the
  sync script's folders, and it must stay free (`npm run check:plugins`).
