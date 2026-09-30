# ATC Flow

A standalone super admin that tests client stores' **add-to-cart → checkout** flow the way a QA
person would: with a real, headless Chromium browser doing exactly what a real visitor does. Press
**Run check** and it loads your homepage, picks an in-stock product from the best sellers, loads its product page, searches for the product, uses the
product page's quantity selector, clicks the real Add-to-cart button, looks at the cart, raises and
lowers its quantity, applies a discount code, clicks
through to checkout, and confirms the product is listed on a collection — eleven checks, one
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

## Run it locally

```bash
npm install
cp .env.example .env        # then set ADMIN_PASSWORD and SESSION_SECRET
npm run dev                 # http://localhost:3000
```

`npm run dev` creates/migrates the local SQLite database (`prisma/dev.sqlite`) and loads `.env`.
Sign in with `ADMIN_PASSWORD`. There are no user accounts — one shared password for the team.

## Using it

- **Stores** (`/app`) — every client store, its Web Bot Auth status and its last check. Add a store
  with its name, storefront URL and one or more product URLs.
- **A store's page** — **Run check** runs the whole flow twice, first on desktop (1280×800) and
  then on mobile (Playwright's iPhone 13 profile: phone screen, touch, mobile browser), testing the
  same product on both. Switch between **Desktop** and **Mobile** to see each run's results.
  It picks the product itself: one of the store's saved product
  URLs at random, or, with none saved, an in-stock product from the store's best sellers
  (`/collections/all?sort_by=best-selling`, falling back to `/products.json`). Click **Test a
  specific product, or set advanced options** to test one product URL, or change the quantity or
  discount code, for this one run. **Recent checks** (right
  sidebar) re-opens any past run.
- **A store's Settings**
  - *Store details* — name, URL, product URLs, a discount code applied on every check, an
    optional search query (typed into the store's search instead of the product's name — passes
    when it returns any product), and the client's Slack channel ID.
  - *Web Bot Auth* — the signature that gets the browser past Cloudflare, created in that store's
    Shopify Admin → Online Store → Preferences → Crawler access. Shows **Not configured / Active /
    Expires in N days / Expired**. There is no API to create or renew one, so the badge is the only
    warning you get before checks start skipping.
  - *Schedule* — **Routine** (daily / weekly / monthly) and **How often** (once / twice) with a
    start time in Eastern time. Twice spreads the runs evenly: daily 9 AM and 9 PM, weekly Monday
    and Thursday, monthly the 1st and 15th. Each scheduled check runs desktop + mobile and posts
    its report to every Slack channel set for the store. The Stores list shows each schedule and
    its next run; scheduled checks are tagged **Scheduled** in Recent checks. A run missed while
    the server was down happens once when it's back.
  - *Storefront password* — only while the store is password protected. Never sent back to the
    browser — only whether one is stored.
  - *Delete store* — removes it with all of its check history and screenshots.

- **Send to Slack** — on every finished check; one report covers both desktop and mobile. Tick the client, PDC and/or department-head
  channel, optionally **Preview message**, then **Send report**. The report lists the result, the
  product tested, the time (EST) and every failed or warning step with its reason; screenshots of
  those steps are posted in a thread under it. Every send, successful or not, is recorded and
  listed under **Sent**. Set `APP_URL` (e.g. `https://atc-flow-app.fly.dev`) to add a "view the
  full report" link — it opens that run on the store's page.
- **Settings** (`/app/settings`)
  - *Slack bot* — paste the bot token (`xoxb-…`, scopes `chat:write` and `files:write`). It's
    tested with Slack before saving and never shown again; the page shows which workspace and bot
    it belongs to. With no token saved here, the `SLACK_BOT_TOKEN` environment variable is used.
  - *Slack channels* — the PDC and department-head channel IDs, which receive every store's
    report. Invite the bot to each channel; a channel's ID is at the bottom of its details panel.
  - *Admin password* — change it here (current password + new one twice, at least 10
    characters). It's stored as an scrypt hash. Until it's changed here, `ADMIN_PASSWORD` is the
    password. Changing it signs out everyone else. Forgotten it? On the server:
    `npm run admin:reset-password -- "new password"`, or `-- --clear` to go back to
    `ADMIN_PASSWORD`.

## Data retention

Check results and Slack send records are kept permanently — they are the audit history. Only step
screenshots are deleted, once they are older than `SCREENSHOT_RETENTION_DAYS` (default 30); the
step then shows "Screenshot removed". The cleanup runs a minute after the server starts and then
daily ([app/atc/retention.server.ts](app/atc/retention.server.ts)).

## Checking from the terminal

The same engine runs from the command line. The URL must be on a store already added in the super
admin; its saved password and Web Bot Auth signature are used:

```bash
npm run atc:check -- https://your-store.com                  # picks a product itself
npm run atc:check -- https://your-store.com --auto           # ignore saved products
npm run atc:check -- https://your-store.com --mobile         # phone screen + mobile browser
npm run atc:check -- https://your-store.com/products/some-product
npm run atc:check -- https://your-store.com/products/x --qty 2
npm run atc:check -- https://your-store.com/products/x --discount SAVE10
npm run atc:check -- https://your-store.com/products/x --search "gift card"
npm run atc:check -- https://your-store.com/products/x \
  --wba-signature '...' --wba-signature-input '...' --wba-expires 2026-12-01 --save
```

It exits `0` when the flow is healthy and `1` when it is broken (including when the run is skipped
for having no Web Bot Auth signature). `--save` stores the given signature/password on the store.

## Deploy to Fly.io

The config is already in the repo ([fly.toml](fly.toml), [Dockerfile](Dockerfile)). You need
`flyctl` (`brew install flyctl`) and a Fly account. Fly builds the image remotely — no local Docker.

```bash
fly auth login
fly apps create atc-flow-app                 # rename in fly.toml if the name is taken
fly volumes create data --size 1 --region bom --app atc-flow-app
fly secrets set ADMIN_PASSWORD=... SESSION_SECRET=$(openssl rand -hex 32) --app atc-flow-app
fly deploy
```

The SQLite database and screenshots live on the `data` volume, so they survive redeploys. The
machine is kept always on (`min_machines_running = 1`) because scheduled checks and the daily
screenshot cleanup run inside the server.
Migrations run on every start (`npm run docker-start`).

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
No Web Bot Auth signature is configured for this store, or the stored one has expired. Open the
store's **Settings**, create a signature in the store's Shopify Admin → Online Store → Preferences → Crawler access,
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
browser makes to the store's own origin (and, best-effort, to Shopify's checkout host), scoped via
`context.route()` rather than applied globally, so third-party requests the theme's own JS fires
(analytics, payment SDKs) never see the credential.

Each of the eleven checks lives in its own file under `app/atc/checks/`, and reads the page the same
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
app/atc/checker.server.ts   the 11 checks — the whole engine, one continuous browser session
app/atc/checks/             one file per journey stage: storefront, search, cart, checkout, collection
app/atc/browser/            Chromium lifecycle, Web Bot Auth headers, challenge detection, screenshots
app/atc/store.server.ts     starts runs, keeps live progress in memory, persists to SQLite
app/atc/stores.server.ts    store config: CRUD, validation, building a run's options
app/atc/app-settings.server.ts   global settings (PDC / department-head Slack channels)
app/atc/slack.server.ts     Slack API: bot identity, posting, screenshot uploads, channel ID validation
app/atc/report.server.ts    builds a run's Slack report and sends it; records every send (SlackDelivery)
app/atc/checks/product-pick.server.ts   picks the product to test (saved pool or best sellers)
app/atc/schedule.ts         schedule maths (next run, Eastern time + daylight saving) — pure
app/atc/scheduler.server.ts once-a-minute scheduler: starts due checks, posts reports to Slack
app/atc/retention.server.ts deletes screenshots older than the retention period (daily)
app/components/CheckDetail.tsx   one check: Desktop / Mobile switch + Send to Slack
app/atc/web-bot-auth.server.ts   resolves a store's Web Bot Auth signature and its expiry status
app/atc/types.ts            RunStep / FlowRun / RunOptions shapes
app/atc/layers.ts           display metadata for the 4 layers (storefront/discovery/cart/checkout)
app/auth.server.ts          admin password (Settings hash, or ADMIN_PASSWORD) + signed session cookie
app/password-hash.server.ts scrypt hashing for the admin password
scripts/reset-admin-password.mjs  resets a forgotten admin password
app/routes/login.tsx        sign in
app/routes/app._index.tsx   all stores + add a store
app/routes/app.stores.$id._index.tsx    a store's dashboard: Run button, live results, recent checks
app/routes/app.stores.$id.settings.tsx  a store's details, storefront password, Web Bot Auth
app/routes/app.settings.tsx global settings
app/routes/api.runs.$id.tsx polled for live progress
app/routes/api.checks.$id.tsx       polled for a check's live progress (desktop + mobile)
app/routes/api.checks.$id_.slack.tsx   Slack channels, preview and send for one check
scripts/atc-check.mjs       the same engine from the terminal
prisma/schema.prisma        Store (config) + AppSetting (global) + FlowRun (history) + SlackDelivery (audit)
```

`checker.server.ts` is imported by both the app and the CLI script. The CLI loads it as a raw `.ts`
file through Node's `--experimental-strip-types`, which is why every relative import in it ends in
an explicit `.ts` extension — Vite resolves extensionless imports, plain Node does not.
