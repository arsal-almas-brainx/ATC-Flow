# ATC Flow App

A Shopify embedded admin app that verifies your storefront's **add-to-cart → checkout** flow by
driving a real headless browser over your **live** pages.

Press **Run ATC flow** in the app and it will:

| # | Step | What it proves |
|---|------|----------------|
| 1 | Open live product page | The PDP actually returns HTTP 200 |
| 2 | Find add-to-cart form & variant | The theme renders a `form[action*="/cart/add"]` with a variant |
| 3 | Empty the cart | Every run starts from a known-clean state |
| 4 | Click Add to cart | The real button is present, enabled, and clickable |
| 5 | Verify `/cart.js` | Correct variant, correct quantity, non-zero price |
| 6 | Open cart page | The line item actually renders and a Checkout button exists |
| 7 | Click Checkout | The button reaches `/checkouts/…` |
| 8 | Verify checkout | Contact field + order summary present, and the total matches the cart |

Every step is timed, gets a screenshot, and reports the exact reason on failure.

> **No order is placed and no payment is taken.** The run stops on the checkout page.
> This makes it safe to run against a live production store as often as you like.

---

## Quick check without installing anything

You can verify a store's flow from the terminal right now — no Shopify app, no OAuth:

```bash
npm run atc:check -- https://your-store.com/products/some-product
npm run atc:check -- https://your-store.com/products/some-product --qty 2 --headed
```

`--headed` opens a visible browser so you can watch it. Exits `0` if the flow reaches checkout
and `1` if it breaks, so it doubles as a CI or cron smoke test.

**Password-protected store?** Pass the storefront password once with `--save` and every later
run — CLI *and* app UI — reuses it:

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
npx playwright install chromium
```

`playwright install chromium` downloads the browser the runner drives. It's a one-time ~150 MB download.

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

Pick the store you want to test when prompted. The CLI writes `.env`, starts a Cloudflare tunnel,
and prints a preview URL.

When it finishes you'll see something like:

```
Preview URL: https://xxxx-yyyy.trycloudflare.com
Press p to open the app preview
```

### 5. Install it on the store

Press **`p`** in that terminal. Your browser opens the install screen → click **Install app**
(it asks for product read access, which the product picker needs).

The app now appears in your store's Shopify Admin under **Apps → ATC Flow App**.

### 6. If the storefront is password protected, save the password

In the app's **Storefront password** section, enter the password and click **Save password**.
The badge flips to **Saved** and every run will unlock the storefront automatically.

### 7. Run a flow

Pick a product from the dropdown, click **Run ATC flow**. Steps stream in live as the browser
works through them (~15–40 seconds).

> ⚠️ **Keep `npm run dev` running.** The app's code runs on *your machine* — Shopify Admin just
> displays it in an iframe. Close the terminal and the app page goes blank. See Part C to make it
> permanent.

---

## Part B — Using it

- **Product dropdown** — auto-populated with your 50 most recently updated active, in-stock
  products (sold-out products are filtered out since they can never pass).
- **Product URL** — paste any live storefront URL instead, if you want to test a specific one.
- **Quantity** — sets the quantity field before clicking Add to cart, then asserts the cart matches.
- **Storefront password section** — if the store is password protected (Online Store →
  Preferences → Password protection), save the password once here and every run unlocks the
  storefront automatically. A **Saved / Not set** badge shows the current state. The password is
  never sent back to the browser — only whether one is stored. Save with the field blank to clear
  it. The per-run password field above overrides the saved one for a single run.
- **Recent runs** (right sidebar) — click any past run to re-open its steps and screenshots.
- **screenshot** link on any step — expands the exact page state at that moment. This is the
  fastest way to see *why* a step failed.

---

## Part C — Making it permanent (optional, later)

Right now the app only works while `npm run dev` is running on this Mac. To have it always
available in the store's admin, deploy it somewhere that can run a headless browser:

1. The repo ships a `Dockerfile`. Add the Playwright browsers to it:
   ```dockerfile
   RUN npx playwright install --with-deps chromium
   ```
2. Deploy to Fly.io / Railway / Render (needs ~1 GB RAM for Chromium).
3. Set env vars: `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SCOPES=read_products`.
4. Point the app's URL at the deployment: `npm run deploy`.
5. Move SQLite → Postgres if you want run history to survive redeploys (swap the `datasource` in
   `prisma/schema.prisma`).

To install on a **production** store permanently, set the app to **Custom distribution** in the
dev dashboard (App → Distribution), enter the store's `.myshopify.com` domain, and use the
generated install link.

---

## Troubleshooting

**"No enabled Add-to-cart button matched any known selector"**
Your theme uses a non-standard button. Add its selector to the `candidates` array in
[app/atc/runner.server.ts](app/atc/runner.server.ts) — that's the one list you'll likely need to
tune per theme.

**"Cart never reached 1 item(s) after clicking Add to cart"**
The click landed but the cart didn't change — this is a genuine ATC bug, usually a JS error in the
theme or a blocked `/cart/add.js` request. Check the `click-atc` screenshot.

**"Checkout served a bot/captcha challenge"**
Shopify occasionally challenges automated traffic at checkout. Re-run; if it's persistent, that's
worth knowing — real customers on flaky networks can hit it too.

**"Storefront is password protected"**
Enter the storefront password in the app, or remove password protection.

**Screenshots don't load**
They're written to `.atc-runs/<run-id>/`. That folder is gitignored and safe to delete.

---

## Layout

```
app/atc/runner.server.ts   the Playwright flow — the 8 steps live here
app/atc/store.server.ts    starts runs, keeps live progress in memory, persists to SQLite
app/atc/types.ts           RunStep / FlowRun shapes
app/routes/app._index.tsx  the dashboard: product picker, Run button, live step list
app/routes/api.runs.$id.tsx           polled for live progress
app/routes/api.runs.$id.shot.$step.tsx serves step screenshots
prisma/schema.prisma       Session (Shopify) + FlowRun (history)
```
