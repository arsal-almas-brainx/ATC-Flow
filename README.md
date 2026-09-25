# ATC Flow App

A Shopify embedded admin app that tests your store's **add-to-cart → checkout** flow the way a QA
person would: with a real, headless Chromium browser doing exactly what a real visitor does. Press
**Run check** and it loads your homepage and product page, searches for the product, clicks the
real Add-to-cart button, looks at the cart, changes its quantity, applies a discount code, clicks
through to checkout, and confirms the product is listed on a collection — nine checks, one
continuous browser session, one shopper's one visit.

| Layer | What it proves |
|---|---|
| **Storefront** | The homepage loads for a real visitor. The product page loads, has a buyable variant, and exposes an add-to-cart form. |
| **Discovery** | Searching for the product finds it. The product is listed on a collection page it links back to. |
| **Cart** | The theme's real Add-to-cart button works. The cart page shows the item. The quantity control works. A discount code actually applies. |
| **Checkout** | Checkout is reached. |

Every check is timed and reports the exact reason on failure.

> **No order is placed and no payment is taken.** The run stops once checkout is reached. Nothing
> is ever completed, so it is safe to run against a live production store as often as you like.

---

## Why a real browser, not APIs

An earlier version of this app asked Shopify's Admin and Storefront APIs direct questions instead
of using a browser at all — "is this product active," "does the Cart API accept this variant," and
so on. That is a reasonable way to check whether *Shopify itself* is working, but it misses the
actual point of this tool: if Shopify's backend is broken, **Shopify's own status page already says
so**. What only this app can catch is a problem specific to *your* storefront that a real visitor
would actually hit — a theme bug that stops the Add-to-cart button from firing even though the API
behind it is perfectly healthy, a page that silently fails to render, a discount field that stopped
working. None of that is visible by asking an API a question; it is only visible by actually using
the site.

So every check here is a real browser action, and none of them call Shopify's Admin or Storefront
APIs at all.

**Getting a real browser past Shopify's bot protection** is what makes this possible. Shopify
fronts every storefront with Cloudflare, which fingerprints an ordinary automated browser and
answers it with a *"Verifying your connection…"* interstitial. In May 2026 Shopify shipped **Web
Bot Auth**: a signature you create once in Shopify Admin (Online Store → Preferences → Crawler
access) that authorizes a specific tool to get past that challenge. Configure it under **Settings**
in this app and every check runs for real; without it, the whole run is cleanly skipped with a
message pointing at Settings, rather than failing.

**Checkout stays shallow on purpose.** Web Bot Auth does not cover Shopify's checkout host, which
is the platform's most heavily bot-protected surface by design. This app still authorizes that host
too, on the chance it helps — and in practice checkout is often reached successfully — but nothing
here asserts on shipping rates or payment methods inside checkout. The one thing checked is that a
real checkout is reached at all; if Cloudflare blocks it, that is reported as skipped, never as a
failure, since a blocked checker is not proof the store is broken.

---

## Checking from the terminal

The same engine runs from the command line, so it works as a cron or CI smoke test:

```bash
npm run atc:check -- https://your-store.com/products/some-product
npm run atc:check -- https://your-store.com/products/x --qty 2
npm run atc:check -- https://your-store.com/products/x --discount SAVE10
```

It exits `0` when the flow is healthy and `1` when it is broken (including when the run is skipped
for having no Web Bot Auth signature configured). It reads the app's stored session only to work
out which shop a custom domain belongs to — no Admin or Storefront API call is ever made by a
check itself.

**Save a Web Bot Auth signature once with `--save`** and every later run — CLI *and* app UI —
reuses it:

```bash
npm run atc:check -- https://your-store.com/products/x \
  --wba-signature '...' --wba-signature-input '...' --wba-expires 2026-12-01 --save
npm run atc:check -- https://your-store.com/products/x     # signature reused automatically
```

Without one, the whole run is skipped — nothing is tested until it is configured.

**Password-protected store?** Pass the storefront password once with `--save` and every later run
reuses it, unlocking the real password form before anything else runs:

```bash
npm run atc:check -- https://your-store.com/products/x --password 'yourpassword' --save
npm run atc:check -- https://your-store.com/products/x     # password reused automatically
```

---

## Part A — Get it running and installed on your store

You need: a **Shopify Partner account** (free) and admin access to the store.

### 1. Install dependencies (already done if you ran the setup)

```bash
npm install
```

This also downloads a headless Chromium build — every check uses it.

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
UI, OAuth, the ATC runs themselves — works normally. If you need to exercise a webhook, use
`npm run dev:tunnel` for that session, or trigger one directly:

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

Press **`p`** in that terminal. Your browser opens the install screen → click **Install app** (it
asks for product read access, used only to populate the product picker dropdown — nothing in the
check engine itself calls the Admin API).

The app now appears in your store's Shopify Admin under **Apps → ATC Flow App**.

### 6. Configure Web Bot Auth and, if needed, the storefront password

In the app's **Settings** page:

- Create a signature in Shopify Admin → Online Store → Preferences → Crawler access, then paste
  its **Signature** and **Signature-Input** values (plus the expiry date shown there) into the Web
  Bot Auth section and save. Nothing runs until this is configured.
- If the storefront is password protected, enter the password and click **Save password**. The
  browser unlocks it automatically on every run.

### 7. Run a check

Click **Run check** — it auto-picks a recently active, in-stock product, so no other input is
required. Results stream in live, grouped by layer.

Four outcomes are possible per check:

- **pass** — the check ran and the store is fine.
- **warn** — the check ran and found something worth your attention, but it is not proof the flow
  is broken (e.g. a discount code was accepted but didn't change the total — expected for
  free-shipping-only codes).
- **skip** — the check could not run at all: no Web Bot Auth signature is configured, Cloudflare
  blocked the browser anyway, no discount code was supplied, or an earlier, genuinely-prerequisite
  check already failed.
- **fail** — a real, observed problem: a button that doesn't work, a page that doesn't load, a
  discount code that doesn't apply.

Only `fail` marks the run broken. A check that couldn't run at all because a *different*, unrelated
check (say, the cart's own quantity stepper) failed still runs on its own — one broken capability
doesn't hide the rest of the report.

> ⚠️ **Keep `npm run dev` running.** The app's code runs on *your machine* — Shopify Admin just
> displays it in an iframe. Close the terminal and the app page goes blank. This is how every
> Shopify app works; there is no way to run it "inside" Shopify. To use the app with no terminal
> open, deploy it — see **Part C**.

---

## Part B — Using it

- **Run check** — needs no input in the common case; it tests whatever product the loader
  auto-picked. Click **Test a different product, or set advanced options** to override the product,
  quantity, a per-run storefront password, or a discount code to test.
- **Settings → Web Bot Auth** — the signature that gets the browser past Cloudflare. Shows
  **Not configured / Active / Expires in N days / Expired**, with a banner only when it actually
  needs attention. There is no API to create or renew one, so a reminder here is the only warning
  you'll get before checks silently start skipping again.
- **Settings → Storefront password** — if the store is password protected (Online Store →
  Preferences → Password protection), save it once and every run unlocks the storefront
  automatically through the real password form. The password is never sent back to the browser —
  only whether one is stored.
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

**"Not configured yet" / the run is skipped**
No Web Bot Auth signature is configured for this shop, or the stored one has expired. Go to
**Settings**, create a signature in Shopify Admin → Online Store → Preferences → Crawler access,
and save its values. There is no API to create or renew one — it has a hard 3-month maximum
lifetime, so this will happen again; the Settings page shows a countdown once it's within 14 days
of expiring.

**"The storefront served a bot challenge"** (a `skip`, not a failure)
Cloudflare blocked this browser session even with the Web Bot Auth signature attached. The
signature may need to be re-created in Shopify Admin. This is the checker being blocked, not the
store being broken.

**"No add-to-cart control was found on the rendered product page"**
This check only recognizes Shopify's standard `form[action*="/cart/add"]` add-to-cart form. A
heavily customized theme layout may render it differently — this is a checker limitation, not
necessarily a real problem.

**"Found a quantity control, but couldn't interact with it"** / **"No checkout control was found"**
The cart-quantity and checkout controls are matched by common theme conventions
(`button[name="checkout"]`, `input[name^="updates["]`, etc.), which cover Shopify's own reference
themes but not every custom theme. Reported as skipped rather than failed, since this reflects the
checker's own coverage, not a confirmed store problem. If this happens on a standard theme, it's
worth reporting — the selector likely needs widening.

**"Clicking through to checkout failed" / landed somewhere that doesn't look like checkout**
A genuine finding: the checkout control was found and clicked, but didn't behave as expected. Worth
investigating directly in a real browser.

**"The storefront password was rejected"**
The saved password is wrong, or it's for a different domain. Confirm the store really is
protected:

```bash
curl -s -o /dev/null -w '%{http_code} -> %{redirect_url}\n' https://your-store.com/products/some-product
```

A `302` to `/password` means protected. Note that a **dev store re-locks itself**, so a check that
passed earlier can start failing at the very first step without you changing anything.

**A check is stuck on "running" forever**
It cannot be. A run left unfinished by a server restart is reported as failed once it is more than
five minutes old — see `STALE_AFTER_MS` in [app/atc/store.server.ts](app/atc/store.server.ts). A
single run's own hard ceiling is much shorter — see `RUN_TIMEOUT_MS` in
[app/atc/browser/launch.server.ts](app/atc/browser/launch.server.ts).

---

## How the checker works

One real, headless Chromium browser session per run — no Admin or Storefront API calls anywhere in
the check engine. `app/atc/browser/launch.server.ts` owns a single warm Chromium process; each run
gets one exclusive `BrowserContext`/`Page` for its entire duration (queued behind any run already
in progress — this app runs on a single machine, so only one browser session is ever open at a
time), released when the run ends or its hard time limit is hit.

`app/atc/browser/web-bot-auth.server.ts` attaches the Web Bot Auth signature to every request the
browser makes to the shop's own origin (and, best-effort, to Shopify's checkout host), scoped via
`context.route()` rather than applied globally, so third-party requests the theme's own JS fires
(analytics, payment SDKs) never see the credential.

Each of the nine checks lives in its own file under `app/atc/checks/`, and reads the page the same
way a person would: the add-to-cart form's own `id` field for which variant is selected, `<h1>` for
the product title used to search, `/cart.js` (the same JSON the theme's own cart drawer reads) to
confirm quantities and totals, a breadcrumb link for which collection to check. The first three
checks (`home-reachable`, `product-page`, `add-to-cart`) are genuine prerequisites of one another —
a failure there stops the run, since nothing after it could be judged meaningfully. Every check
after that is judged independently: a broken discount code doesn't stop checkout from being tried.

**This is not a licence to hammer the store.** This is a periodic smoke check, not a loop — space
runs out rather than firing several back to back, and Cloudflare will escalate against sustained
automated traffic regardless of authorization.

---

## Layout

```
app/atc/checker.server.ts   the 9 checks — the whole engine, one continuous browser session
app/atc/checks/             one file per journey stage: storefront, search, cart, checkout, collection
app/atc/browser/            Chromium lifecycle, Web Bot Auth headers, challenge detection, screenshots
app/atc/store.server.ts     starts runs, keeps live progress in memory, persists to SQLite
app/atc/settings.server.ts  stores the storefront password per shop
app/atc/web-bot-auth.server.ts   stores/resolves the Web Bot Auth signature per shop
app/atc/types.ts            RunStep / FlowRun / RunOptions shapes
app/atc/layers.ts           display metadata for the 4 layers (storefront/discovery/cart/checkout)
app/routes/app._index.tsx   the dashboard: Run button, live results by layer, recent checks
app/routes/app.settings.tsx storefront password + Web Bot Auth settings
app/routes/api.runs.$id.tsx polled for live progress
scripts/atc-check.mjs       the same engine from the terminal
prisma/schema.prisma        Session (Shopify) + ShopSetting + FlowRun (history)
```

`checker.server.ts` is imported by both the app and the CLI script. The CLI loads it as a raw `.ts`
file through Node's `--experimental-strip-types`, which is why every relative import in it ends in
an explicit `.ts` extension — Vite resolves extensionless imports, plain Node does not.
