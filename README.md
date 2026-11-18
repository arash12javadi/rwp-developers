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
| **Your plugins** | Create plugins, upload versions (ZIP) or import a GitHub release, set a price, put them on sale. |
| **Sales & licences** | Every order and every licence key; revoke a key, release the site it is bound to. |
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
     screen shows (`…/api/plugins/rwp-developers/webhook/stripe`) for the event `checkout.session.completed`.
   - **NOWPayments (USDT):** paste the API key and the IPN secret; set the IPN callback to the address shown. Use the sandbox
     switch while you test.
   - Switch the methods on and save. Credentials are sealed on the server and are never shown again; the screen only says
     whether each is set.
4. Your **licence key pair** is created the first time a method is switched on. The screen shows the public half and a short
   check you paste into a plugin you sell.

### Publish and sell a plugin

1. **Developers → Your plugins → New plugin** (id = the `id` in your `manifest.json`, which cannot change later), or
   **Import from a GitHub release** (a public repository with a published release; no token needed).
2. Upload a **version**: the ZIP, with the version equal to `version` in its `manifest.json`. The package is scanned
   first: a *blocking* finding (no valid manifest, `eval`, a server secret) is never stored; *something to read* (network
   calls, storage access) is stored but **held back** until you publish it or tick "publish even if the scan finds
   something to read".
3. Set the **price** (0 = free), optionally how many **days a licence lasts** (empty = lifetime), and set the plugin **On sale**.
   A plugin with no published version cannot be put on sale.
   **Submit to marketplace** (on a plugin linked to a GitHub repository) opens react-wp.com's `/plugins/submit` page in a
   new tab with the repository filled in. Nothing is sent from your site; you confirm on that page (react-wp.com account
   needed). The marketplace scans the release and passes it to the marketplace owner; it goes live only after approval.
4. Your shop is at **`/store`**, or put `[rwp_developer_store title="Plugins"]` on any page.

A buyer signs in, pays (or claims a free plugin), and finds their **licence key** and a **Download** button under *My
purchases*. They install the ZIP under *Plugins → Upload* and enter the key where your plugin asks for it.

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

Nothing to set up. Sign in on your shop, buy or claim, download from *My purchases*, upload the ZIP, enter the key.

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
- **No refunds or chargebacks in the shop.** Refund in Stripe/NOWPayments, then **Revoke** the licence here.
- **Taxes, invoices and payouts are yours**: this plugin records orders, it does not file anything for you.
- **Upload size:** a Vercel function accepts about 4.5 MB per request, so a larger ZIP has to come from a **GitHub release**
  (the server downloads it, up to 40 MB). A self-hosted `npm start` site has no such limit below 40 MB.
- **A licence check inside a plugin can be removed by a buyer who edits the plugin's code.** The signature stops anyone from
  minting keys; it cannot stop a determined buyer from deleting the check, as with any client-side licensing.
- The scan is a text check, not proof a plugin is safe or works.
- Currency is US dollars. Buying needs an account on the site (the licence belongs to it).

## For maintainers

- `schema.sql` / `uninstall.sql`: `dev_products`, `dev_versions`, `dev_orders`, `dev_licenses`, `dev_settings`, `dev_secrets`.
  RLS is on everywhere; `dev_secrets` has none (server only). `dev_place_order`, `dev_complete_order`, `dev_verify_license`
  and `dev_record_version` are service-role only.
- `server.mjs` routes; `server/store.mjs` logic; `server/payments.mjs`, `server/license.mjs`, `server/secrets.mjs`,
  `server/supabase.mjs`. The scanner and the GitHub release reader are core (`server/pluginVet.mjs`, `server/releaseSource.mjs`).
- Tests: `tests/developers.test.mjs` (server logic, in-memory Supabase) and `tests/sqlChecks/developers.mjs` (real Postgres via
  PGlite when installed: `npm i --no-save @electric-sql/pglite`).
- The plugin ships to clients as a free plugin release (`npm run plugin:release -- rwp-developers`); it is **not** part of the
  sync script's folders, and it must stay free (`npm run check:plugins`).
