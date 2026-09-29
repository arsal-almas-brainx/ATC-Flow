/**
 * ATC flow check from the terminal — the same engine the app UI runs.
 *
 *   npm run atc:check -- https://your-store.com                 (picks a product itself)
 *   npm run atc:check -- https://your-store.com --auto          (ignore saved products)
 *   npm run atc:check -- https://your-store.com/products/some-product
 *   npm run atc:check -- https://your-store.com/products/x --qty 2
 *   npm run atc:check -- https://your-store.com/products/x --password hunter2 --save
 *   npm run atc:check -- https://your-store.com/products/x --discount SAVE10
 *   npm run atc:check -- https://your-store.com/products/x --search "gift card"
 *   npm run atc:check -- https://your-store.com/products/x --wba-signature ... \
 *                              --wba-signature-input ... --wba-expires 2026-12-01 --save
 *
 * The URL's origin must match a store added in the super admin — its saved
 * password and Web Bot Auth signature are used. Every check is a real,
 * Web-Bot-Auth-authorized Chromium browser doing what a QA person would do
 * by hand: load the homepage and product page, search, click the real
 * Add-to-cart button, look at the cart, change its quantity, apply a
 * discount, click through to checkout, and check the product is listed on a
 * collection.
 *
 * No order is ever placed; checkout is only ever reached, never completed.
 * Exits 0 when the flow is healthy and 1 when it is broken, so it also works
 * as a CI or cron smoke test.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { blankRun, runCheck } = await import(
  path.join(here, "..", "app", "atc", "checker.server.ts")
);

const argv = process.argv.slice(2);
const target = argv.find((a) => !a.startsWith("--"));

if (!target) {
  console.error(
    "Usage: npm run atc:check -- <store-or-product-url> [--qty N] [--password P] [--discount CODE] [--search TERM] [--auto] [--save]\n" +
      "                              [--wba-signature S] [--wba-signature-input SI] [--wba-expires DATE]",
  );
  process.exit(2);
}

const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};

let origin;
try {
  origin = new URL(target).origin;
} catch {
  console.error(`Not a valid URL: ${target}`);
  process.exit(2);
}

// Mirrors app/db.server.ts — this script runs outside Vite, so it does not pick
// up prisma/.env on its own.
const { PrismaClient } = await import("@prisma/client");
const db = new PrismaClient({
  datasourceUrl: process.env.DATABASE_URL || "file:dev.sqlite",
});

const store = await db.store.findFirst({ where: { url: origin } });
if (!store) {
  const all = await db.store.findMany({ select: { url: true } });
  console.error(
    all.length
      ? `No store matches ${origin}. Stores: ${all.map((s) => s.url).join(", ")}`
      : "No stores yet. Add one in the super admin first.",
  );
  process.exit(2);
}
const settings = store;

let password = flag("password");
const wbaSignature = flag("wba-signature");
const wbaSignatureInput = flag("wba-signature-input");
const wbaExpires = flag("wba-expires");

if (argv.includes("--save")) {
  if (password === undefined && wbaSignature === undefined && wbaSignatureInput === undefined) {
    console.error(
      "--save needs --password <value> and/or --wba-signature/--wba-signature-input " +
        "(use --password '' to clear the password)",
    );
    process.exit(2);
  }
  const data = {};
  if (password !== undefined) data.storefrontPassword = password || null;
  if (wbaSignature !== undefined) data.webBotAuthSignature = wbaSignature || null;
  if (wbaSignatureInput !== undefined) data.webBotAuthSignatureInput = wbaSignatureInput || null;
  if (wbaExpires !== undefined) data.webBotAuthExpiresAt = wbaExpires ? new Date(wbaExpires) : null;
  await db.store.update({ where: { id: store.id }, data });
  if (password !== undefined) {
    console.log(password ? `Saved the storefront password for ${store.name}.` : "Cleared the stored password.");
  }
  if (wbaSignature !== undefined || wbaSignatureInput !== undefined) {
    console.log(
      wbaSignature || wbaSignatureInput
        ? `Saved the Web Bot Auth signature for ${store.name}.`
        : "Cleared the stored Web Bot Auth signature.",
    );
  }
}
password = password ?? settings?.storefrontPassword ?? undefined;

const webBotAuthSignature = wbaSignature ?? settings?.webBotAuthSignature ?? undefined;
const webBotAuthSignatureInput = wbaSignatureInput ?? settings?.webBotAuthSignatureInput ?? undefined;
const webBotAuthExpiresAt =
  wbaExpires !== undefined
    ? wbaExpires
      ? new Date(wbaExpires)
      : null
    : (settings?.webBotAuthExpiresAt ?? null);
const webBotAuthConfigured =
  Boolean(webBotAuthSignature && webBotAuthSignatureInput) &&
  !(webBotAuthExpiresAt && webBotAuthExpiresAt.getTime() <= Date.now());

const opts = {
  storeId: store.id,
  storeUrl: store.url,
  // A store URL alone lets the run pick a product itself, as the app does.
  productUrl: /\/products\/[^/]+/.test(new URL(target).pathname) ? target : undefined,
  // --auto ignores the store's saved products and picks from its best sellers.
  productPool: argv.includes("--auto")
    ? []
    : store.productUrls.split("\n").map((u) => u.trim()).filter(Boolean),
  quantity: Math.max(1, Number(flag("qty") ?? 1) || 1),
  storefrontPassword: password,
  discountCode: flag("discount") ?? store.discountCode ?? undefined,
  searchQuery: flag("search") ?? store.searchQuery ?? undefined,
  webBotAuthSignature: webBotAuthConfigured ? webBotAuthSignature : undefined,
  webBotAuthSignatureInput: webBotAuthConfigured ? webBotAuthSignatureInput : undefined,
};

const run = blankRun("cli", opts);

const LAYER = {
  storefront: "Storefront",
  discovery: "Discovery",
  cart: "Cart",
  checkout: "Checkout",
};

const expiryNote = (() => {
  if (!webBotAuthConfigured || !webBotAuthExpiresAt) return "";
  const days = Math.round((webBotAuthExpiresAt.getTime() - Date.now()) / 86_400_000);
  return ` (expires in ${days}d)`;
})();

console.log(`\nATC flow check → ${target}`);
console.log(
  `store ${store.name} · quantity ${opts.quantity}` +
    `${password ? " · storefront password loaded" : ""}` +
    ` · web bot auth: ${webBotAuthConfigured ? `configured${expiryNote}` : "not configured — the run will be skipped"}\n`,
);

const announced = new Set();
let currentLayer = null;

try {
  await runCheck(run, opts, (r) => {
    for (const s of r.steps) {
      if (s.status === "pending" || s.status === "running") continue;
      if (announced.has(s.key)) continue;
      announced.add(s.key);
      if (s.layer !== currentLayer) {
        currentLayer = s.layer;
        console.log(`  ${LAYER[s.layer] ?? s.layer}`);
      }
      const label = { pass: " ok ", fail: "FAIL", warn: "WARN", skip: "skip" }[s.status] ?? s.status;
      const ms = s.durationMs != null ? ` (${s.durationMs}ms)` : "";
      console.log(`    [${label}] ${s.title}${ms}`);
      if (s.detail) console.log(`           ${s.detail}`);
    }
  });
} finally {
  await db.$disconnect().catch(() => {});
}

const warned = run.steps.filter((s) => s.status === "warn").length;
const summary =
  run.status === "skipped"
    ? "NOT CONFIGURED"
    : run.status === "passed"
      ? warned
        ? "FLOW OK (with warnings)"
        : "FLOW OK"
      : "FLOW BROKEN";
console.log(`\n${summary}`);
if (run.error) console.log(`Reason:   ${run.error}`);
if (run.productUrl) console.log(`Product:  ${run.productUrl}`);
if (run.cartTotal) console.log(`Total:    ${run.cartTotal}`);
if (run.checkoutUrl) console.log(`Checkout: ${run.checkoutUrl}`);

process.exit(run.status === "passed" ? 0 : 1);
