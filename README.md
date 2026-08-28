# ATC Flow App

A Shopify embedded admin app that verifies your store's **add-to-cart → checkout** flow using
Shopify's own APIs. Press **Run check** and it runs 13 checks across four layers, in about 8
seconds, and tells you exactly which one broke.

| Layer | # | What it proves |
|---|---|---|
| **Store & product** — Admin API | 1 | The store is reachable, SSL is on, currency is set |
| | 2 | The app can get a Storefront API token |
| | 3 | The product is active, priced above 0, and has stock |
| **Buyer path** — Storefront Cart API | 4 | The product is published to the Online Store channel |
| | 5 | The Cart API accepts the variant |
| | 6 | The cart holds the right variant, quantity and price |
| | 7 | Changing the quantity recalculates the cart |
| **Theme** — plain HTTP to the live storefront | 8 | The product page returns 200 and renders a `form[action*="/cart/add"]` |
| | 9 | The theme's own endpoint, `/cart/add.js`, actually holds the item |
| **Checkout readiness** | 10 | A shipping rate exists for the ship-to address |
| | 11 | A buyer has some way to pay |
| | 12 | Shopify issues a checkout URL for the cart |
| | 13 | That checkout URL responds |

Every check is timed and reports the exact reason on failure.

> **No order is placed and no payment is taken.** The run stops once a checkout is issued.
> Carts it creates are abandoned and Shopify expires them on its own, so it is safe to run against
> a live production store as often as you like.

---

## Why there is no browser

An earlier version drove the storefront with Playwright. That does not work, and it is worth
knowing why before you reach for it again.

Shopify fronts every storefront with Cloudflare. Cloudflare fingerprints an automated browser and
answers it with a *"Verifying your connection…"* interstitial served under **HTTP 429** — so the
product page never loads and `/cart.js` comes back as HTML. No amount of UA spoofing or request
rerouting fixes it reliably, and retrying escalates the challenge.

Plain HTTP requests are **not** fingerprinted that way, and Shopify's APIs are not behind the
challenge at all. So every layer the browser was there to reach is reachable without one:

- The **Admin API** is the authoritative view of what the store is configured to sell — better
  than scraping a page for it.
- The **Storefront Cart API** is the same cart engine the theme's Add-to-cart button ends up
  talking to. Building a cart through it *is* the buyer path.
- `/cart/add.js` and `/cart.js` — the endpoints the theme's button actually posts to — are ordinary
  HTTP. Check 9 calls them directly, which covers the theme layer with no browser.

What this genuinely cannot see is theme **JavaScript**: if a JS error stops the button from firing
at all, checks 8 and 9 still pass because the endpoint behind the button is healthy. That is the
one trade, and it buys a check that is ~5× faster, cannot be bot-blocked, and has no Chromium
dependency.

---

## Checking from the terminal

The same engine runs from the command line, so it works as a cron or CI smoke test:

```bash
npm run atc:check -- https://your-store.com/products/some-product
npm run atc:check -- https://your-store.com/products/x --qty 2
npm run atc:check -- https://your-store.com/products/x --country US --zip 10001
```

It exits `0` when the flow is healthy and `1` when it is broken. It reads the Admin API session the
app stored at install time, so the app has to have been installed and opened in Admin once.

**Password-protected store?** Pass the storefront password once with `--save` and every later
run — CLI *and* app UI — reuses it:

```bash
npm run atc:check -- https://your-store.com/products/x --password 'yourpassword' --save
npm run atc:check -- https://your-store.com/products/x     # password reused automatically
```

Only the two theme checks need it. The eleven API checks work either way.

---

## Part A — Get it running and installed on your store

You need: a **Shopify Partner account** (free) and admin access to the store.

### 1. Install dependencies (already done if you ran the setup)

```bash
npm install
```

There is no browser to download — the checker is API-only.

### 2. Create the database

```bash
npm run setup
```

This creates `prisma/dev.sqlite` with the session + run-history tables.

### 3. Create the app and link this folder to it

```bash
npm run config:link
```

The Shopify CLI walks you through it:

1. **Log in to Shopify** — it opens your browser, click *Confirm*.
2. **Pick your organization**.
3. **"Create this app on Shopify?"** → **Yes, create it as a new app**.
4. **App name** → `ATC Flow App` (or anything).

This creates the app in your dev dashboard and writes the real `client_id` into
`shopify.app.toml`. You do **not** need to create anything by hand in the dashboard.

### 4. Start it

```bash
npm run dev
```

One terminal, nothing else to start. This runs `shopify app dev --config dev --use-localhost`:
Admin loads the app straight from `https://localhost:3458` over a trusted local certificate, with
**no tunnel at all**. The first run installs a local certificate authority via `mkcert` and may ask
for your macOS password — that's expected, and it only happens once.

It reads [shopify.app.dev.toml](shopify.app.dev.toml), a dev-only config for the same app. Two
reasons it exists:

1. Shopify's API **rejects a localhost webhook URI**, and one bad URI fails the entire dev preview
   with `Invalid value: "https://localhost:3458/webhooks/app/uninstalled" for: "uri"`. The dev
   config declares no subscriptions, so there is nothing to reject.
2. `npm run dev` rewrites `application_url` in whichever config it uses. Pointing it at the dev
   config means your production [shopify.app.toml](shopify.app.toml) is no longer clobbered every
   time you develop.

`npm run deploy` still uses `shopify.app.toml`, so production keeps its real URL and its webhooks.

No tunnel is the deliberate default here. Tunnels are the single most fragile part of Shopify local
dev, and on a slow or restricted network they fail in ways that look like bugs in your app (see
**Troubleshooting**). Removing them removes that whole class of problem.

The one trade-off: **Shopify cannot deliver webhooks to `localhost`.** The `app/uninstalled` and
`app/scopes_update` handlers won't fire while you develop this way. Everything else — the embedded
UI, OAuth, Admin API calls, the ATC runs themselves — works normally. If you need to exercise a
webhook, use `npm run dev:tunnel` for that session, or trigger one directly:

```bash
npm run shopify -- app webhook trigger
```

Pick the store you want to test when prompted. The CLI writes `.env` and prints a preview URL.

<details>
<summary>Using a tunnel instead</summary>

```bash
npm run dev:tunnel          # Shopify's built-in Cloudflare tunnel
```

Or your own ngrok tunnel, if you want a fixed public URL. Start ngrok in its own terminal first:

```bash
ngrok http 3000
```

Copy the `https://…ngrok-free.dev` URL it prints, then in a second terminal:

```bash
npm run dev:tunnel -- --tunnel-url https://your-subdomain.ngrok-free.dev:3000
```

The `:3000` on the end is the **local** port the tunnel forwards to, not part of the public URL —
the CLI requires that format.

</details>

When it finishes you'll see something like:

```
Preview URL: https://admin.shopify.com/store/your-store/apps/…
Press p to open the app preview
```

### 5. Install it on the store

Press **`p`** in that terminal. Your browser opens the install screen → click **Install app**
(it asks for product read access for the product picker, plus unauthenticated Storefront API
access so it can mint a Storefront token and build carts).

The app now appears in your store's Shopify Admin under **Apps → ATC Flow App**.

### 6. If the storefront is password protected, save the password

In the app's **Storefront password** section, enter the password and click **Save password**.
The badge flips to **Saved** and the two theme checks will unlock the storefront automatically. The
other eleven checks do not need it.

### 7. Run a check

Pick a product from the dropdown, click **Run check**. Results stream in live, grouped by layer,
and settle in about 8 seconds.

Three outcomes are possible per check:

- **pass** — the check ran and the store is fine.
- **warn** — the check ran and found something worth your attention, but it is not proof the flow is
  broken. Checks 10 and 11 can report this, because for both a healthy store and a broken one can
  look identical over the API.
- **skip** — the check could not run: the storefront is password protected and no password is saved,
  Cloudflare rate-limited the checker, or an earlier check already failed.

Neither `warn` nor `skip` fails the run — only a genuine `fail` does.

> ⚠️ **Keep `npm run dev` running.** The app's code runs on *your machine* — Shopify Admin just
> displays it in an iframe. Close the terminal and the app page goes blank. This is how every
> Shopify app works; there is no way to run it "inside" Shopify. To use the app with no terminal
> open, deploy it — see **Part C**.

---

## Part B — Using it

- **Product dropdown** — auto-populated with your 50 most recently updated active, in-stock
  products (sold-out products are filtered out since they can never pass).
- **Product URL** — paste any live storefront URL instead, if you want to test a specific one.
- **Quantity** — how many units to add, asserted against the cart afterwards.
- **Ship-to country** — the two-letter country used to request a shipping rate (check 10). Blank
  uses the store's own country. Set it to a country you actually sell to if you want to prove that
  lane works.
- **Storefront password section** — if the store is password protected (Online Store →
  Preferences → Password protection), save the password once here and every run unlocks the
  storefront automatically. A **Saved / Not set** badge shows the current state. The password is
  never sent back to the browser — only whether one is stored. Save with the field blank to clear
  it. The per-run password field above overrides the saved one for a single run.
- **Recent checks** (right sidebar) — click any past run to re-open its full result.

---

## Part C — Deploy it (no terminal required)

An embedded Shopify app's UI is served by **your** server — Shopify Admin only frames it. So
"installed" is not enough on its own: for the app to open with no terminal running, something has
to be serving it around the clock. That is what deploying means here.

This app deploys to **[Fly.io](https://fly.io)**. The config is already in the repo
([fly.toml](fly.toml), [Dockerfile](Dockerfile)) and the machine sleeps when idle and wakes on the
first request, so an app only you use costs cents a month. You need the `flyctl` CLI
(`brew install flyctl`) and a Fly account with a card on file. No Docker install required — Fly
builds the image on its own remote builder.

### 1. Log in and create the app

```bash
fly auth login
fly apps create atc-flow-app
```

If that name is taken, pick another — then change **both** `app` and `SHOPIFY_APP_URL` in
[fly.toml](fly.toml), and `application_url` + `redirect_urls` in
[shopify.app.toml](shopify.app.toml), to match the new `https://<name>.fly.dev`.

### 2. Create the database volume

SQLite has to live on a persistent disk. Without it, every redeploy wipes the session table and
the store has to reinstall the app.

```bash
fly volumes create data --size 1 --region bom --app atc-flow-app --yes
```

`bom` is Mumbai. Use whatever region is closest to you — `fly platform regions` lists them — and
keep it the same as `primary_region` in [fly.toml](fly.toml).

### 3. Set the API secret

Everything else lives in `fly.toml`; only the client secret is a secret.

```bash
npm run env -- show          # prints SHOPIFY_API_SECRET
fly secrets set SHOPIFY_API_SECRET=<paste-it-here> --app atc-flow-app
```

### 4. Deploy

```bash
fly deploy
```

Confirm it is serving:

```bash
curl -o /dev/null -w '%{http_code}\n' https://atc-flow-app.fly.dev/      # want 200 or 302
```

### 5. Push the URL to Shopify

[shopify.app.toml](shopify.app.toml) already points at `https://atc-flow-app.fly.dev`. Send it:

```bash
npm run deploy
```

### 6. Install on the store — once

Dev dashboard → your app → **Distribution** → **Custom distribution** → enter the store's
`.myshopify.com` domain → open the install link → **Install app**.

Now close every terminal. The app is at **Apps → ATC Flow App** in Shopify Admin, whenever you
want it.

### Shipping a code change

```bash
fly deploy                   # code
npm run deploy               # only if you changed shopify.app.toml (scopes, webhooks, URLs)
```

### Managing it

```bash
fly logs --app atc-flow-app
fly status --app atc-flow-app
fly ssh console --app atc-flow-app          # shell in; the database is at /data/prod.sqlite
fly apps destroy atc-flow-app               # tear it all down
```

> `npm run dev` is unaffected by any of this — it uses [shopify.app.dev.toml](shopify.app.dev.toml)
> and localhost. But note that `automatically_update_urls_on_dev` is now **false** in
> [shopify.app.toml](shopify.app.toml), so `npm run dev:tunnel` will no longer silently repoint the
> deployed app at a temporary tunnel. If you do need a tunnel session, flip it to `true`, and run
> `npm run deploy` afterwards to restore the Fly URL.

---

## Part D — Alternative: run it on this Mac, free

If you would rather not pay for hosting, the app can instead run as two macOS launch agents that
start on boot and keep running with no terminal open. $0, no credit card. The limitation is that
the Mac must be powered on and online for the app to work at all — a closed lid means a blank app
page in Admin.

### 1. Claim your free ngrok static domain

Go to <https://dashboard.ngrok.com/domains> → **Create domain**. The free plan includes one
static domain, e.g. `flashily-dizzy-maturely.ngrok-free.dev`.

This step cannot be skipped: without a claimed static domain ngrok hands out a new random URL on
every restart, and ngrok rejects made-up subdomains with `ERR_NGROK_313`.

### 2. Install the services

Stop `npm run dev` and any hand-started `ngrok` first — the installer refuses to run while
something else holds port 3000, and tells you which process it is.

```bash
npm run service:install -- flashily-dizzy-maturely.ngrok-free.dev
```

That one command does everything: reads your Shopify credentials, writes `.env.production`
(chmod 600), repoints `application_url` and `redirect_urls` in `shopify.app.toml` at your domain,
sets `automatically_update_urls_on_dev = false`, builds the app, then writes and loads two launch
agents:

| Service | What it does |
|---|---|
| `com.atcflow.server` | serves the built app on port 3000 |
| `com.atcflow.ngrok` | exposes port 3000 at your static domain |

Both use `KeepAlive`, so macOS restarts them if they crash or the Mac reboots.

> This rewrites `application_url` and `redirect_urls` in [shopify.app.toml](shopify.app.toml) to
> your ngrok domain, so it is one or the other — not both. To go back to Fly, restore those two
> values to `https://atc-flow-app.fly.dev`, run `npm run service:uninstall`, then `npm run deploy`.

### 3. Push the URL to Shopify and install on the store

```bash
npm run deploy
```

Then dev dashboard → your app → **Distribution** → **Custom distribution** → enter the store's
`.myshopify.com` domain → open the install link → **Install app**.

### 4. Confirm

Close every terminal. Open the store admin → **Apps → ATC Flow App**.

### Managing the services

```bash
npm run service:logs        # tail the server log
npm run service:uninstall   # stop and remove both services
launchctl list | grep atcflow
```

Logs are in `.logs/`. Re-run `service:install` after code changes to rebuild and reload.

> If your ngrok account does not offer a free static domain, **Tailscale Funnel** is a free
> alternative that also gives a permanent HTTPS hostname — swap the ngrok launch agent for
> `tailscale funnel 3000`.

---

## Troubleshooting

**Admin shows "Find this app in the pages where you work" instead of the app**
The Shopify CLI didn't find a web server to run, so it left `application_url` pointing at Shopify's
placeholder page. The CLI discovers the server through `shopify.web.toml` in the project root — if
that file is missing (or is still the un-rendered `shopify.web.toml.liquid` template), the dev
output starts no `web` process and logs
`app_home │ └ Using URL: https://shopify.dev/apps/default-app-home`. Restore `shopify.web.toml`.

**Admin shows "The connection was reset."**
Two different causes; check the local server first, then the tunnel.

*Local:* on macOS `localhost` resolves to the IPv6 loopback `::1` first, so the CLI proxy binds
`[::1]:3000` while a tunnel dialing IPv4 `127.0.0.1:3000` gets refused. The `dev` script sets
`NODE_OPTIONS=--dns-result-order=ipv4first` to force the IPv4 bind. Verify:

```bash
lsof -nP -iTCP:3000 -sTCP:LISTEN        # want 127.0.0.1:3000, not [::1]:3000
curl -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/    # want 200
```

*Tunnel:* if the local checks pass but Admin still resets, the failure is upstream of your machine.
Confirm by hitting the public URL directly — a reset during the TLS handshake, with
`http://127.0.0.1:4040/api/tunnels` still reporting `conns.count: 0`, means requests are dying at
the ngrok edge and never reaching your agent. Restart ngrok, or use `npm run dev` (no tunnel).

**"Failed to start dev preview." with no other detail**
Re-run with `--verbose` and look near the end of the output — the CLI prints a one-line banner but
the real reason is only in the verbose log:

```bash
npm run dev -- --verbose 2>&1 | tail -40
```

The usual cause with `--use-localhost` is a webhook subscription in the config, since Shopify
rejects `https://localhost:…` as a webhook `uri` and one invalid URI fails the whole preview. That
is why `npm run dev` uses [shopify.app.dev.toml](shopify.app.dev.toml); if you add a subscription,
add it to [shopify.app.toml](shopify.app.toml) only.

**`Could not start Cloudflare tunnel: failed to dial to edge with quic`**
Your network is blocking or throttling the path to Cloudflare. Check how slow it actually is:

```bash
curl -o /dev/null -w '%{http_code} in %{time_total}s\n' https://api.trycloudflare.com/
```

A `405` is the correct response (the endpoint only accepts POST) — the number that matters is the
time. Above ~10s, `cloudflared` times out while *creating* the tunnel, before any QUIC connection
is attempted, so transport flags like `TUNNEL_TRANSPORT_PROTOCOL=http2` cannot help. Use
`npm run dev`, which needs no tunnel.

**"No product with handle … exists in this store"**
The product URL does not match a product in the store this app is installed on. Check the handle,
and check you are pointing at the right store.

**"… is not visible on the online store"**
The product exists and is active, but it is not published to the **Online Store** sales channel, so
no buyer can see or buy it. Fix it on the product page under **Publishing → Online Store**. This is
the single most common genuine failure the checker catches.

**"has no variant available for sale"**
Every variant is either out of stock with *"Stop selling when out of stock"* set, or unpublished.
The message reports how many. Restock, allow overselling, or test a different product.

**"No shipping rate is available for XX …"**
A buyer at that address would reach checkout and be unable to finish. Add a shipping zone covering
it in **Settings → Shipping and delivery**. If the product does not need shipping (a digital good),
this check reports as skipped instead.

**"No shipping rate came back for XX, but no postal code was used"** (a `warn`, not a failure)
Shopify resolves rates from the whole address, not just the country — for the US and many others it
returns nothing at all without a postal code, so an empty result with no postal code proves nothing.
Rather than cry "no shipping zone" on incomplete input, the check says so.

Make it conclusive either way:

- fill in the store address under **Settings → Store details** — the check uses it by default, and a
  real address is the best ship-to since it is somewhere the store demonstrably operates; or
- set an explicit **Ship-to country** and **Ship-to postal code** in the app (`--country` and
  `--zip` on the CLI) to prove a specific lane works.

**Check 11, payment methods** — the one check that cannot always be automated

It reports one of three verdicts, and never stands down silently:

- **pass** — Shopify reports card brands or digital wallets, so a buyer can pay.
- **warn, development store** — a dev store can only take test payments, and Shopify does not expose
  the test gateway through *any* API. Confirm it by hand once: **Settings → Payments** should show
  the test payment gateway activated. The check asserts for real as soon as the store is on a paid
  plan.
- **warn, live store** — nothing is set up in **Settings → Payments**, so a buyer reaching checkout
  has no way to pay. A warning rather than a failure because a store taking only a manual payment
  method (bank transfer, cash on delivery) looks identical over the API — those are not reported
  either. If you have a card gateway configured and still see this, it is not finished activating.

For the record, these are all the surfaces that could have answered it, and none does:

| Source | Reports the test gateway? |
|---|---|
| Storefront `shop.paymentSettings` (all 7 fields) | no — `acceptedCardBrands: []`, `shopifyPaymentsAccountId: null` |
| Admin `shop.paymentSettings` | no — only `supportedDigitalWallets`, also empty |
| REST `/payment_gateways.json` | no — endpoint removed (404) |
| Checkout HTML | no — 403 to any non-browser client, whatever the headers |
| `paymentSettings.cardVaultUrl` | no — Shopify's global PCI endpoint, identical for every store |

`cartSubmitForCompletion` *would* settle it, but it places a real order, so it is categorically off
limits here. `cartPaymentUpdate` only validates its own input and says nothing about gateway
configuration — inferring from it would be a false-positive generator.

**"The theme's add-to-cart endpoint rejected the variant"**
`/cart/add.js` returned an error, and the message carries Shopify's own explanation — usually a
stock limit. This is a real add-to-cart failure a customer would hit.

**"The product page has no add-to-cart form"**
The page loaded but has no `form[action*="/cart/add"]`. Either the theme is broken on that template
or the product renders as unavailable. Load the URL in a browser to see which.

**"The storefront served a bot challenge"** (a `skip`, not a failure)
Shopify fronts every storefront with Cloudflare, and Cloudflare answers a request it considers
automated with an HTML interstitial titled *"Verifying your connection…"* — served under **HTTP
429**, which is why it can read as rate limiting. It affects only the checks that touch the
storefront over HTTP: 8, 9 and 13.

Nothing is wrong with your store or the app when this happens. It is triggered by the volume of
automated requests from your IP, so it clears on its own — space checks out rather than firing
several back to back. The eleven API checks are never affected.

**"Checkout answered HTTP 403 to this non-browser request"** (a `skip`, not a failure)
Checkout is the most bot-protected surface Shopify has and routinely refuses any non-browser client
even when it is perfectly healthy. That is why check 13 is advisory: the real proof is check 12, the
checkout URL Shopify issued for a cart that priced correctly and has a shipping rate.

**"The Admin API rejected the app's access token"**
The stored offline session has expired or was revoked. Open the app from Shopify Admin once to
refresh it, then run the check again.

**"The app is not allowed to create a Storefront API token"**
The app is installed without the `unauthenticated_*` scopes. Run `npm run deploy`, then open the app
in Admin and approve the updated permissions.

**"The storefront password was rejected"**
The saved password is wrong, or it is for a different domain. Confirm the store really is protected:

```bash
curl -s -o /dev/null -w '%{http_code} -> %{redirect_url}\n' https://your-store.com/products/some-product
```

A `302` to `/password` means protected. Note that a **dev store re-locks itself**, so a check that
passed earlier can start skipping the theme checks without you changing anything.

**A check is stuck on "running" forever**
It cannot be. A run left unfinished by a server restart is reported as failed once it is more than
five minutes old — see `STALE_AFTER_MS` in [app/atc/store.server.ts](app/atc/store.server.ts).

---

## How the checker talks to Shopify

Four transports, each doing what it is best at:

| Transport | Auth | Used for |
|---|---|---|
| Admin GraphQL API | the app's offline access token | checks 1–3 |
| Storefront GraphQL API | a Storefront access token the app mints and caches | checks 2, 4–7, 10–11 |
| Plain HTTPS to the storefront | the storefront password cookie, if set | checks 8–9, 13 |

The Storefront token is minted once per shop through the Admin API
(`storefrontAccessTokenCreate`) and cached in `ShopSetting.storefrontApiToken`, because tokens are a
limited per-shop resource. If a cached one stops being accepted, `store.server.ts` discards it and
mints a replacement rather than failing every future run.

`Jar` in [app/atc/checker.server.ts](app/atc/checker.server.ts) exists because Node's `fetch` has no
cookie jar: with `redirect: "follow"` it silently drops any cookie set by an intermediate hop. Three
things depend on cookies crossing hops — the password unlock, the Ajax cart session, and the
checkout permalink, where `/cart/c/<token>` sets a session cookie and *then* redirects to
`/checkouts/cn/<id>`, which answers 403 without it.

**This is not a licence to hammer the store.** The GraphQL APIs have generous documented limits, but
the Ajax cart endpoints are rate-limited aggressively and Cloudflare escalates against sustained
automated traffic. This is a periodic smoke check, not a loop.

---

## Layout

```
app/atc/checker.server.ts  the 13 checks — the whole engine, no browser
app/atc/store.server.ts    starts runs, keeps live progress in memory, persists to SQLite
app/atc/token.server.ts    mints and caches the Storefront API token
app/atc/settings.server.ts stores the storefront password per shop
app/atc/types.ts           RunStep / FlowRun / RunOptions shapes
app/routes/app._index.tsx  the dashboard: product picker, Run button, live results by layer
app/routes/api.runs.$id.tsx  polled for live progress
scripts/atc-check.mjs      the same engine from the terminal
prisma/schema.prisma       Session (Shopify) + ShopSetting + FlowRun (history)
```

`checker.server.ts` is imported by both the app and the CLI script. The CLI loads it as a raw `.ts`
file through Node's `--experimental-strip-types`, which is why every relative import in it is
**type-only** — Vite resolves extensionless imports, plain Node does not. Anything needing the
database (the token cache, the password store) lives outside it and is passed in.
