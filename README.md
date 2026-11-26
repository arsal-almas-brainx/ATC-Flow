# ATC Flow

A standalone super admin that tests client stores' **add-to-cart → checkout** flow the way a QA
person would: with a real, headless Chromium browser doing exactly what a real visitor does. Press
**Run check** and it loads your homepage, picks an in-stock product from the best sellers, loads its product page, searches for the product, uses the
product page's quantity selector, clicks the real Add-to-cart button, checks the cart drawer
(opened by itself or from the cart icon, with its quantity buttons), looks at the cart, raises and
lowers its quantity, applies a discount code, clicks
through to checkout, and confirms the product is listed on a collection — twelve checks, one
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

## Set up from scratch (checklist)

1. **Run it locally** (below) and sign in.
2. **Create the Slack bot** ([Slack bot setup](#slack-bot-setup)) and put its token in `.env`.
3. **Get a PageSpeed API key** (Google Cloud → APIs & Services → enable *PageSpeed Insights API* →
   Credentials → Create API key) and put it in `.env` as `PAGESPEED_API_KEY`.
4. Restart, then open **Settings**: Slack should say *Connected* and PageSpeed *Set*. Add the
   department heads / team leads.
5. **Add a store** (Stores → Add store), including its Web Bot Auth signature, then **Run check**.
6. For the shared server, see [Deploy to the staging server](#deploy-to-the-staging-server).

## Run it locally

Needs Node.js 20.19+ or 22.12+ (the staging server runs Node 24).

```bash
npm install
npx playwright install chromium   # the browser the checks run in (one-time download)
cp .env.example .env              # then set ADMIN_PASSWORD and SESSION_SECRET
npm run dev                       # http://localhost:3000
```

`npm run dev` creates/migrates the local SQLite database (`prisma/dev.sqlite`) and loads `.env`.
Sign in with `ADMIN_PASSWORD`. There are no user accounts — one shared password for the team.

> `npm run dev` applies any pending database migrations on start. Before pulling a change that
> drops or moves data, copy `prisma/dev.sqlite` somewhere safe.

## Slack bot setup

One bot posts every report. Someone with admin rights in the Slack workspace creates it once:

1. Go to <https://api.slack.com/apps> → **Create New App** → **From scratch**. Name it (e.g.
   *ATC Flow*) and pick the workspace.
2. **OAuth & Permissions** → *Bot Token Scopes* → add `chat:write` and `files:write`.
3. **App Home** → turn on the **Messages Tab** (so people can read the bot's direct messages).
4. **Install to Workspace** → Allow. Copy the **Bot User OAuth Token** (`xoxb-…`).
5. Put it in `.env` as `SLACK_BOT_TOKEN` (see [Editing .env](#editing-env)). Share it privately —
   never in a channel, ticket or commit.
6. In every channel that should receive reports, type `/invite @ATC Flow` (use the bot's name).
   Direct messages to member IDs need no invite.

Channel IDs: channel name → *View channel details* → bottom of the *About* tab (`C…`).
Member IDs: profile → *View full profile* → ⋮ → *Copy member ID* (`U…`).

## Editing .env

Server-wide settings and secrets live only in `.env` (never committed, never in the database):

| Variable | What it is |
|---|---|
| `ADMIN_PASSWORD` | Starting admin password. Ignored once the password is changed in Settings. |
| `SESSION_SECRET` | Signs the login cookie (`openssl rand -hex 32`). Changing it signs everyone out. |
| `SLACK_BOT_TOKEN` | The Slack bot token (`xoxb-…`). |
| `PAGESPEED_API_KEY` | Google PageSpeed Insights API key. |
| `APP_URL` | Public URL of the app; adds a "view full report" link to Slack reports. |
| `SCREENSHOT_RETENTION_DAYS` | Days to keep step screenshots (default 5). |
| `PORT`, `HOST`, `DATABASE_URL`, `SCREENSHOT_DIR` | Server only — see [Deploy to the staging server](#deploy-to-the-staging-server). |

One setting per line, `NAME=value`, no spaces around `=` and no quotes.

**Locally:** edit `.env`, save, then stop `npm run dev` (Ctrl+C) and start it again.

**On the staging server:**

```bash
ssh brainx-server
nano /var/www/atc-flow/.env          # edit, then Ctrl+O, Enter, Ctrl+X to save and close
pm2 startOrReload /var/www/atc-flow/ecosystem.config.cjs --update-env
exit
```

A plain `pm2 restart` does **not** re-read `.env` — use the `startOrReload` line. Then check
**Settings**: Slack *Connected*, PageSpeed *Set* (and **Check key with Google**).

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
    when it returns any product), the store's internal and client (external) Slack channel IDs, and its PDC/QA recipients. Leave the client channel empty
    to keep reports internal (e.g. while trialling a store).
  - *Web Bot Auth* — the signature that gets the browser past Cloudflare, created in that store's
    Shopify Admin → Online Store → Preferences → Crawler access. Shows **Not configured / Active /
    Expires in N days / Expired**. There is no API to create or renew one, so the badge is the only
    warning you get before checks start skipping.
  - *Schedule* — **Routine** (daily / weekly / monthly) and **How often** (once / twice) with a
    start time in Eastern time. Twice spreads the runs evenly: daily 9 AM and 9 PM, weekly Monday
    and Thursday, monthly the 1st and 15th. Each scheduled run does a flow check (desktop + mobile)
    and a speed test, then posts one report covering both to every Slack channel set for the store. The Stores list shows each schedule and
    its next run; scheduled checks are tagged **Scheduled** in Recent checks. A run missed while
    the server was down happens once when it's back.
  - *Storefront password* — only while the store is password protected. Never sent back to the
    browser — only whether one is stored.
  - Per-store values (Web Bot Auth signature, storefront password) are saved in the database rather
    than `.env`: every store has its own, and signatures are replaced every few months from this
    page. Server-wide secrets (Slack token, PageSpeed key, `SESSION_SECRET`) live only in `.env`.
  - *Delete store* — removes it with all of its check history and screenshots.

- **Run speed test** — the **Speed** tab. Google PageSpeed Insights measures the homepage, a
  collection (`/collections/all`, or the store's chosen one) and a product page (the first saved
  product, else the store's top in-stock best seller, found in a real browser each time), each on mobile and desktop. Each gets Google's
  performance score (90+ GOOD, 50–89 AVERAGE, under 50 POOR), its main timings and a link to
  Google's full report. An alert is raised when a page turns POOR or drops 10+ points since the
  previous test. Results are kept as history, and have their own **Send to Slack**. Needs
  `PAGESPEED_API_KEY` in `.env`. Password-protected stores can't be measured — Google can't get
  past the password, and the result says so.
- **Send to Slack** — on every finished check; one report covers both desktop and mobile. Tick the internal, client (external), PDC/QA and/or department-head
  channel (the client channel starts unticked, so it's never sent to by accident), optionally **Preview message**, then **Send report**. The report lists the result, the
  product tested, the time (EST) and every failed or warning step with its reason; screenshots of
  those steps are posted in a thread under it. Every send, successful or not, is recorded and
  listed under **Sent**. Set `APP_URL` (e.g. `https://site-checkup.brainxdemo.com`) to add a "view the
  full report" link — it opens that run on the store's page.
- **Settings** (`/app/settings`)
  - *Slack bot* — shows whether Slack is connected and which workspace and bot. The token
    (`xoxb-…`, scopes `chat:write` and `files:write`) is the `SLACK_BOT_TOKEN` env var in `.env`,
    never stored in the database or shown in the browser; edit `.env` and restart to change it.
  - *Department heads / team leads* — Slack IDs that receive every store's report, separated by
    commas: member IDs (`U…`, sent as a direct message; profile → View full profile → ⋮ → Copy member ID — not the
    `D…` ID of your own DM with them) and/or
    channel IDs (`C…`; at the bottom of the channel's details — invite the bot to the channel).
    Each store's **PDC/QA** is set the same way in that store's settings.
  - *Google PageSpeed* — shows whether the `PAGESPEED_API_KEY` env var (in `.env`) is set, with a
    button to check it with Google. Like the Slack token, it's never stored in the database.
  - *Admin password* — change it here (current password + new one twice, at least 10
    characters). It's stored as an scrypt hash. Until it's changed here, `ADMIN_PASSWORD` is the
    password. Changing it signs out everyone else. Forgotten it? On the server:
    `npm run admin:reset-password -- "new password"`, or `-- --clear` to go back to
    `ADMIN_PASSWORD`.

## Data retention

Check results and Slack send records are kept permanently — they are the audit history. Only step
screenshots are deleted, once they are older than `SCREENSHOT_RETENTION_DAYS` (default 5 — issues are looked at the same or next day); the
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

## Deploy to the staging server

Staging runs on BrainX's shared AWS server (Ubuntu, Node 24), next to other apps, under **pm2**
behind **nginx**:

| | |
|---|---|
| URL | <https://site-checkup.brainxdemo.com> |
| SSH | `ssh brainx-server` (an `~/.ssh/config` entry for `ubuntu@13.214.27.28` with the team's `.pem` key — ask the team lead for the key) |
| App folder | `/var/www/atc-flow` |
| pm2 app | `atc-flow` on `127.0.0.1:3070` ([ecosystem.config.cjs](ecosystem.config.cjs)) |
| Database + screenshots | `/var/www/atc-flow/data/prod.sqlite`, `/var/www/atc-flow/data/screenshots` |
| nginx site | `/etc/nginx/sites-available/site-checkup.brainxdemo.com`, HTTPS by certbot |

[server.mjs](server.mjs) is the production server. It trusts proxy headers from nginx on the same
machine, so form posts (e.g. login) pass React Router's cross-site check behind HTTPS. pm2 starts
it with `npm run docker-start`, which applies pending migrations first.

### Updating staging

From the project folder on your machine:

```bash
npm run build
ssh brainx-server 'cp /var/www/atc-flow/data/prod.sqlite /var/www/atc-flow/data/prod.sqlite.bak-$(date +%F)'
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude .env --exclude data \
  --exclude prisma/dev.sqlite --exclude screenshots --exclude .react-router \
  --exclude CLAUDE.md --exclude .claude --exclude Caddyfile --exclude docker-compose.yml \
  ./ brainx-server:/var/www/atc-flow/
ssh brainx-server 'cd /var/www/atc-flow && npm ci --omit=dev && npx prisma generate && pm2 startOrReload ecosystem.config.cjs --update-env'
```

Check it came up: `ssh brainx-server 'pm2 logs atc-flow --lines 20 --nostream'` should end with
`[server] http://127.0.0.1:3070`. The `--exclude` list is what keeps the server's `.env` and
database from being overwritten.

### First-time setup (already done on staging)

1. `sudo mkdir -p /var/www/atc-flow && sudo chown ubuntu: /var/www/atc-flow`, then the rsync above.
2. Create `/var/www/atc-flow/.env` with the [Editing .env](#editing-env) values plus:
   ```
   PORT=3070
   HOST=127.0.0.1
   DATABASE_URL=file:/var/www/atc-flow/data/prod.sqlite
   SCREENSHOT_DIR=/var/www/atc-flow/data/screenshots
   APP_URL=https://site-checkup.brainxdemo.com
   ```
3. `npm ci --omit=dev && npx prisma generate && npx playwright install --with-deps chromium`
4. `pm2 start ecosystem.config.cjs && pm2 save`
5. nginx site: `proxy_pass http://127.0.0.1:3070` with `Host`, `X-Forwarded-For` and
   `X-Forwarded-Proto` headers and `proxy_read_timeout 300s`; enable it, `sudo nginx -t && sudo
   systemctl reload nginx`, then `sudo certbot --nginx -d <domain>`.

The server is shared and low on memory; pm2 restarts the app if it goes over 1 GB.

## Deploy to Fly.io (alternative, not in use)

[fly.toml](fly.toml) and the [Dockerfile](Dockerfile) can run the app on Fly.io instead. You need
`flyctl` (`brew install flyctl`) and a Fly account.

```bash
fly auth login
fly apps create atc-flow-app                 # rename in fly.toml if the name is taken
fly volumes create data --size 1 --region bom --app atc-flow-app
fly secrets set ADMIN_PASSWORD=... SESSION_SECRET=$(openssl rand -hex 32) --app atc-flow-app
fly secrets set SLACK_BOT_TOKEN=... PAGESPEED_API_KEY=... --app atc-flow-app
fly deploy
```

The database and screenshots live on the `data` volume. Migrations run on every start.

---

## Troubleshooting

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

Each of the twelve checks lives in its own file under `app/atc/checks/`, and reads the page the same
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
app/atc/checker.server.ts   the 12 checks — the whole engine, one continuous browser session
app/atc/checks/             one file per journey stage: storefront, search, cart, checkout, collection
app/atc/browser/            Chromium lifecycle, Web Bot Auth headers, challenge detection, screenshots
app/atc/store.server.ts     starts runs, keeps live progress in memory, persists to SQLite
server.mjs                  production server (behind nginx)
ecosystem.config.cjs        pm2 config for the staging server
app/atc/stores.server.ts    store config: CRUD, validation, building a run's options
app/atc/app-settings.server.ts   global settings (department heads / team leads, admin password hash)
app/atc/slack.server.ts     Slack API: bot identity, posting, screenshot uploads, channel ID validation
app/atc/report.server.ts    builds a run's Slack report and sends it; records every send (SlackDelivery)
app/atc/checks/product-pick.server.ts   picks the product to test (saved pool or best sellers)
app/atc/speed.server.ts     speed tests via Google PageSpeed Insights; history + alerts
app/atc/speed.ts            speed result shapes and rating rules (shared with the UI)
app/components/SpeedDetail.tsx   the Speed tab: results table, history, Send to Slack
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
prisma/schema.prisma        Store (config) + AppSetting (global) + FlowRun + SpeedRun (history) + SlackDelivery (audit)
```

`checker.server.ts` is imported by both the app and the CLI script. The CLI loads it as a raw `.ts`
file through Node's `--experimental-strip-types`, which is why every relative import in it ends in
an explicit `.ts` extension — Vite resolves extensionless imports, plain Node does not.
