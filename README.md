<div align="center">

# 🧑‍💻 RWP Developers

**Test, publish and sell your plugins from your own site.**

![Edition](https://img.shields.io/badge/edition-public-blue)
![Licence](https://img.shields.io/badge/licence-free-green)
![Version](https://img.shields.io/badge/version-1.0.0-blue)

</div>

One plugin for people who make plugins. Everything it does happens on **your own site, in your own Supabase project, with
your own payment accounts**. react-wp.com never takes your money and never sees your payment credentials. What is sent there, over
your site's own account link and only for plugins you list on the React-WP marketplace: the listing itself, sales of buyers who came
from react-wp.com (so they appear on the buyer's account), revoked licence serials, and your answers under *Messages*.

| Screen | What it is for |
|---|---|
| **Plugin Check** | Test a plugin ZIP in the browser before you install it ([details](./check/README.md)). |
| **Your plugins** | Create plugins, import a GitHub release (the default) or upload versions (ZIP), choose which of the two rules, set a price, put them on sale. |
| **Sales & licences** | Every order and every licence key; revoke a key, release the site it is bound to; refunds (buyers' requests, and refunding any order). |
| **Payments & key** | Your Stripe and NOWPayments credentials, your licence public key, your package storage. |
| **Messages** | Questions, support and refund requests from your buyers on react-wp.com; answer them, approve or decline refunds. |
| **`/store`** (and `[rwp_developer_store]`) | The public shop: what is on sale, buy or claim, "My purchases" with downloads. |

This plugin is for what you **sell or hand out yourself**. To be found on **react-wp.com/plugins** as well, send a plugin from
its screen to the React-WP marketplace: you stay the seller (see below).

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
     `checkout.session.async_payment_succeeded` (methods that settle later, such as SEPA Direct Debit), `refund.created`, `refund.updated` and `charge.refunded` (the last three record refunds made in the Stripe dashboard).
   - **NOWPayments (USDT):** paste the API key and the IPN secret; set the IPN callback to the address shown. Use the sandbox
     switch while you test.
   - Switch the methods on and save. Credentials are sealed on the server and are never shown again; the screen only says
     whether each is set.
   - **Other payment methods:** a plugin active on your site can add a payment gateway (see `docs/extending-react-wp.md`). The free
     **RWP Payments Plus** adds PayPal, Mollie and GoCardless; choose them on its Payment methods screen first. It is
     listed under *More payment methods (added by plugins)*, off until you switch it on and save its fields; its callback
     address is shown there. Refunds go through it when it supports them, else you send them by hand and record them.
4. Your **licence key pair** is created the first time a method is switched on. The screen shows the public half and a short
   check you paste into a plugin you sell.

### Publish and sell a plugin

1. **Developers → Your plugins → New plugin** (id = the `id` in your `manifest.json`, which cannot change later), or
   **Import from a GitHub release** (a repository with a published release). A plugin you **sell** must come from a **private**
   repository: paste a fine-grained GitHub token with read-only "Contents" access to that one repository (it is sealed in your
   database with `RWP_SECRET_BOX_KEY` and never shown again; replace it any time under the plugin's *GitHub release* panel). A free
   plugin from a public repository needs no token. A priced plugin whose repository is public is refused.
2. Add a **version** from a GitHub release. After the first one, **new releases are found by themselves**: whenever your store or
   this admin is opened, each linked plugin not looked at for five minutes is asked for its newest release tag (one GitHub call); a new
   tag is read, scanned and stored, a clean one becomes the shop's version, and its react-wp.com listing (if any) is updated. *Check for
   new release* still does it at once or by uploading the **ZIP**, with the version equal to `version` in its `manifest.json`. **You choose which
   source rules** (*Which source rules the live version*, default **the latest GitHub release**): the shop offers the newest published
   version of that source, the other source is kept ready and used only until the chosen source has a version of its own. The package is scanned
   first: a *blocking* finding (no valid manifest, `eval`, a server secret) is never stored; *something to read* (network
   calls, storage access) is stored but **held back** until you publish it or tick "publish even if the scan finds
   something to read".
3. Set the **price** (0 = free), optionally how many **days a licence lasts** (empty = lifetime), and set the plugin **On sale**.
   A plugin with no published version cannot be put on sale. A plugin **with a price** cannot be put on sale (or given a price
   while it is on sale) until **Payments & key** is finished: at least one method switched on with all its credentials, and the
   licence key pair created. The plugin screen says so and links there; the server refuses it too. A free plugin needs nothing.
4. Your shop is at **`/store`**, or put `[rwp_developer_store title="Plugins"]` on any page.

A buyer signs in, pays (or claims a free plugin), and finds their **licence key** and a **Download** button under *My
purchases*. They install the ZIP under *Plugins → Upload* and enter the key where your plugin asks for it.

### List a plugin on the React-WP marketplace (react-wp.com/plugins)

You stay the seller: sales, refunds and support are yours. react-wp.com shows your plugin with a *Sold by the developer* box
(your site's address and how your shop takes payment), and its **Buy on the developer's store** button sends customers to
**your** `/store?plugin=<id>` (that plugin is shown first and highlighted), where your own Stripe/NOWPayments takes the money
and your own key signs the licence.

1. Have an account on react-wp.com. On your site open **Plugins → Connect to react-wp.com** and connect with a pairing code
   from your react-wp.com account (the same account link customers use; `RWP_SECRET_BOX_KEY` must be set).
2. Put the plugin **On sale** in your shop with a published version. A plugin with a price also needs **Payments & key**
   finished (a ready payment method and your licence key pair).
3. Open the plugin under **Developers → Your plugins** and press **Send to React-WP Marketplace** (bottom of the screen).
   Its package, price, the names of your ready payment methods and your licence **public** key are sent. No credential is
   sent; the site token stays sealed on your server.
4. The marketplace owner reviews it **once** (it waits in their *Inventory → Pending*). The screen shows the status
   (*Waiting for approval*, *Live*, *Rejected*…); it is refreshed from react-wp.com each time the screen opens.
5. After that it is automatic: every **new version** you publish here and every **price change** is sent by itself and goes
   live after react-wp.com's own scan (no new review), until you press **Stop sending updates**. If an automatic send fails,
   your change here still stands and the reason is shown on the plugin; press **Send update now** to retry.
6. **A free plugin linked to a public GitHub repository** is sent with that repository's name, and react-wp.com links it to the
   listing (after checking it on GitHub). From then on react-wp.com follows the repository's releases itself, so a new release
   shows there within minutes even when nobody opens this site. A listing sent before this (20261126) is sent again once, the next
   time this admin is opened, to add its repository. A plugin for sale comes from a private repository, which react-wp.com cannot
   read: its new versions are sent by this site (found automatically whenever the store or the admin is opened).

Notes and limits:
- The plugin id must not be used by someone else's plugin on react-wp.com, and a plugin is listed from one site only.
- A free plugin is installed from the marketplace like any free plugin (react-wp.com stores its scanned copy).
- A plugin with a price is never handed out by react-wp.com; buyers download it from your `/store`.
- Buyers can review the plugin on react-wp.com, and report problems to the marketplace owner, by pasting the licence key
  your shop gave them (it is checked against your licence public key). You can answer reviews there when you are signed
  in to react-wp.com with the account the site is connected to. The plugin screen here shows how many complaints are open
  (the count only; the owner reads them).
- *Stop sending updates* does not remove the listing; ask the marketplace owner to unlist it. The owner can also reject or
  unlist it, for example after complaints.
- On Vercel a request body is limited to about 4.5 MB, so a larger package cannot be sent this way yet.
- Re-apply `schema.sql` after updating (new table `dev_listings`).

### Your marketplace plugins are listed here too

When the Marketplace plugin is installed on the same Supabase project, every plugin whose author is the site owner (an administrator or super admin) is **mirrored** into *Developers → Your plugins* with a **Marketplace** badge, each time the list opens. **The Marketplace rules them**: title, price, status, version and GitHub release are changed in *Marketplace → Inventory → Manage* and are rewritten here at the next sync; a mirrored plugin cannot be edited, uploaded to, checked or deleted here, and this shop never sells it (the Marketplace does, with its own licences). **Manage** on a mirrored plugin opens the same dialog as *Marketplace → Inventory → Manage* (catalogue details, presentation, release source and token, vetting report, release history) without the marketplace owner's decisions: storefront status (publish, unlist, reject…), approving or rejecting a waiting release, and deleting stay in *Inventory*. Saving there writes to the marketplace and the list here is synced again. With the Marketplace plugin inactive, Manage shows a read-only summary. A plugin of this shop with the same id as one of the owner's marketplace plugins is adopted (the Marketplace wins); one removed from the Marketplace is archived here, never deleted. On a developer's own site, without the Marketplace, nothing is mirrored. Re-apply `schema.sql` after updating (two new columns, `managed_by` and `marketplace_plugin_id`, and the public catalogue and order functions now skip mirrored rows). Plugins created only in this shop are not copied into the Marketplace.

### Refunds

**Within 28 days of the payment a buyer gets their money back without discussion:** their request is approved at once (no reason needed,
an earlier "no" does not count) and sent through the order's gateway; a USDT payment waits for you to send it by hand. You cannot decline
or cancel such a refund (`dev_refunds.automatic`). After 28 days you are the seller, so you decide. Your answer is final on this shop; for a plugin **listed on react-wp.com**, a buyer whose request
you declined can ask the react-wp.com marketplace owner to rule (see *Declined refunds can be appealed* below).

- **A buyer asks** from *My purchases* on `/store` (**Ask for a refund**: a reason, and optionally a smaller amount). They can withdraw
  it while it waits. You see it under **Sales & licences → Refunds**.
- **You answer:** *Approve refund* or *Decline* with a reason the buyer reads. A declined order cannot be asked about again on this shop.
- **You refund without being asked:** **Refund…** on a paid order in **Sales & licences → Orders** (all, or part of it).
- **Cancel a refund you approved, before anything was sent:** **Cancel this refund** on an *Approved, not sent* refund (a USDT refund
  waiting for you to send it, or a card refund the gateway refused). A buyer's request goes back to *Waiting for you*, so you can decline
  it with a reason or approve it again; a refund you started yourself is cancelled. Once a gateway refund id is recorded it cannot be
  cancelled. An order with an open request shows *Refund requested: answer it* on the Orders tab.
- **Card (Stripe):** approving refunds it through your own Stripe account at once. It is claimed in the database first and sent with an
  idempotency key, so a double click never refunds twice; if Stripe refuses, it stays *approved* with Stripe's reason and you can try
  again. Add the events `refund.created`, `refund.updated` and `charge.refunded` to your Stripe webhook: a refund you make in the
  Stripe dashboard is then recorded here once.
- **USDT (NOWPayments):** NOWPayments has no refund API. Send the USDT back from your wallet, then press **Mark as refunded** with the
  transaction hash.
- A **full** refund revokes the licence (its key stops verifying and downloading) and marks the order `refunded`; a partial refund keeps
  the licence unless you tick *Also revoke the licence*. After a refund the buyer can buy the plugin again. *Sales & licences* shows the
  total after refunds.
- **The buyer is emailed** when the refund is sent (amount, and whether the key stopped working), through your site's email settings
  (*Settings → Integrations → Email*; core `sendPluginMail`, so this plugin never sees the mail credentials). Without email set up,
  they see the answer on `/store` only.
- A **declined** request needs a reason of at least 10 characters.
- **Declined refunds can be appealed (20261128).** When the plugin is listed on react-wp.com, every decline is reported there over the
  account link (the key, the amount, the buyer's reason and yours; `dev_refunds.platform_reported_at` / `platform_error`, retried when
  you open *Developers*). react-wp.com opens a declined refund conversation on the buyer's account (at once, or when they claim the key
  there); the buyer sees a link to it on `/store` and can ask the marketplace owner to rule. That ruling is final: if it says you must
  refund, the request appears under **Developers → Messages** as *owner ruled: refund the buyer*. *Sales → Refunds* shows whether
  react-wp.com was told. A plugin that is not listed there is not reported, and your answer stays final.
- **A revoked key goes on your signed revocation list** (`GET /api/plugins/rwp-developers/store/revoked`) and, when the plugin is
  listed on react-wp.com, is pushed there too (at the refund, and again from the admin status if that failed), so it no longer counts
  as a purchase there either.

### Messages between buyers and sellers (Developers → Messages)

The conversations are held on react-wp.com and read here over this site's account link, so this site must be connected
(*Plugins → Connect to react-wp.com*). **Developers → Messages** has two lists:

- **Your buyers**: questions before buying, support and refund requests about your listed plugins, and conversations you start.
  **New message to a buyer** (or **Contact buyer** on *Sales & licences → Orders*) picks one of your sales. When the purchase is on the
  buyer's react-wp.com account (they pressed Buy there, or claimed the key), the message starts a conversation there: it shows here and
  under the buyer's *Messages* on react-wp.com, and they are emailed about it. Otherwise it is **emailed** to the buyer through your
  site's email settings, with replies going to your own address (at most 30 emails an hour from one server instance). **Contact buyer**
  also shows the buyer's name and email address, read on demand for that one order.
- **Your sellers**: conversations with the developers of plugins this account bought, and **New message to a seller** for any plugin you
  own from another developer.

You can start at most 20 conversations with buyers a day; a buyer can start 5 a day, and conversations a seller starts do not count
against the buyer's 5. A **refund request** is decided here, because the money is on your payment account:

- **Approve refund** finds your own order by the key's serial, refunds it through its gateway (Stripe, PayPal, Mollie, GoCardless) or,
  for USDT or another method without a refund API, after you type how you sent it back; a full refund revokes the key. The decision is
  then reported to react-wp.com and the buyer is told.
- **Decline refund** needs a written reason (10 characters or more; the button tells you when it is missing). The buyer may then ask the react-wp.com marketplace owner to rule. That ruling is final there: if
  it says you must refund, the request comes back here as *owner ruled: refund the buyer*, and the listing may be flagged or unlisted if
  you do not.

### Sales from react-wp.com appear on the buyer's account there

A buyer who presses Buy on react-wp.com while signed in arrives here with `?rwp_ref=…`. The shop keeps that reference with the order
(`dev_orders.platform_ref`, also across signing in here) and, once the payment is confirmed, reports the sale over the account link, so it
appears under the buyer's *My purchases* on react-wp.com and on their connected sites. Only the key and the order's amount, currency,
gateway and bound site are sent; react-wp.com checks the key's signature with your public key. A report that failed is retried when you
open *Developers*. Without a reference (someone who bought here directly) the buyer can claim the key on react-wp.com instead.

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

A buyer's **connected React-WP site** installs and updates your plugin by itself from your shop:

```
POST https://your-site/api/plugins/rwp-developers/package   { "license_key": "…", "domain": "buyer-site.com" }
GET  https://your-site/api/plugins/rwp-developers/store/revoked
```

`package` answers `{ plugin, version, domain, sha256, exp, sig, url }`: `sig` signs `RWPDPKG1|plugin|version|domain|sha256|exp` with your
licence key pair (ten minutes), and the buyer's site refuses anything whose signature, host, version or bytes' SHA-256 do not match
(core `server/developerPackages.mjs`). `store/revoked` is `{ format: "RWPDCRL1", issued_at, serials, signature }`, signed the same way.

**Priced plugins are protected for buyers.** A buyer's download (from *My purchases*, `download` or `package`) of a plugin with a
price is compiled, obfuscated and watermarked with the licence serial (core `protectPluginZip`), built once per licence and version and
stored under `protected/` in your private bucket. Free plugins go out as published. You keep your readable source in your repository and
in the stored master.

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
- The protected copy is built on the first download of each licence and version, which can take several seconds on a large plugin.
- A buyer's site binds a key to its host (`buyer-site.com`); a key first bound by a browser download to `https://buyer-site.com` is a
  different string, so release it once if the site's own install is refused.
- **Upload size:** a Vercel function accepts about 4.5 MB per request, so a larger ZIP has to come from a **GitHub release**
  (the server downloads it, up to 40 MB). A self-hosted `npm start` site has no such limit below 40 MB.
- **A licence check inside a plugin can be removed by a buyer who edits the plugin's code.** The signature stops anyone from
  minting keys; it cannot stop a determined buyer from deleting the check, as with any client-side licensing.
- The scan is a text check, not proof a plugin is safe or works.
- Currency is US dollars. Buying needs an account on the site (the licence belongs to it).

## For maintainers

- `schema.sql` / `uninstall.sql`: `dev_products`, `dev_versions`, `dev_orders`, `dev_licenses`, `dev_refunds`, `dev_settings`, `dev_secrets`.
  20261127: `dev_orders.platform_ref` / `platform_reported_at` / `platform_error`, `dev_licenses.revoke_reason` / `platform_revoked_at`,
  trigger `dev_licenses_revoked_at`. `server/platformSync.mjs`: purchase reports, the revocation list and its push, refund emails,
  Messages, protected and signed delivery.
  Refunds: `dev_refund_open` / `_cancel` / `_decide` / `_issue` / `_claim` / `_release` / `_settle` / `_from_gateway`, all
  service-role only (`server/refunds.mjs` checks the session or `manage_options` first); `dev_refunds` has RLS on, no policy, and no
  browser grants.
  The schema is safe to re-run. If Payments & keys or the GitHub release import shows
  `permission denied for table dev_settings` (HTTP 403), re-run `schema.sql` in the Supabase SQL editor: it grants
  `service_role` access to the `dev_*` tables.
  RLS is on everywhere; `dev_secrets` has none (server only). `dev_place_order`, `dev_complete_order`, `dev_verify_license`
  and `dev_record_version` are service-role only.
- `server/listing.mjs`: the marketplace listing (`admin/listing`, `admin/listing/send`, `admin/listing/stop`, and `autoSendListing`
  after a save, upload, publish/withdraw or GitHub import). It calls react-wp.com only through core `platformRequest`
  (`server/licenseLink.mjs`), which allows `developer/*` routes only. `dev_listings` is owner-read, server-written.
- `server.mjs` routes; `server/store.mjs` logic; `server/payments.mjs`, `server/license.mjs`, `server/secrets.mjs`,
  `server/supabase.mjs`. The scanner and the GitHub release reader are core (`server/pluginVet.mjs`, `server/releaseSource.mjs`).
- Tests: `tests/developers.test.mjs` (server logic, in-memory Supabase) and `tests/sqlChecks/developers.mjs` (real Postgres via
  PGlite when installed: `npm i --no-save @electric-sql/pglite`).
- The plugin ships to clients as a free plugin release (`npm run plugin:release -- rwp-developers`); it is **not** part of the
  sync script's folders, and it must stay free (`npm run check:plugins`).
