/**
 * ATC flow check from the terminal — the same engine the app UI runs.
 *
 *   npm run atc:check -- https://your-store.com/products/some-product
 *   npm run atc:check -- https://your-store.com/products/x --qty 2
 *   npm run atc:check -- https://your-store.com/products/x --password hunter2 --save
 *   npm run atc:check -- https://your-store.com/products/x --country US --zip 10001
 *
 * It reads the app's stored Admin API session, so the app has to have been
 * installed and opened in Shopify Admin at least once.
 *
 * No browser and no order: the run builds a real cart through Shopify's APIs
 * and stops once a checkout is issued. Exits 0 when the flow is healthy and 1
 * when it is broken, so it also works as a CI or cron smoke test.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { blankRun, runCheck, mintStorefrontToken } = await import(
  path.join(here, "..", "app", "atc", "checker.server.ts")
);

const argv = process.argv.slice(2);
const target = argv.find((a) => !a.startsWith("--"));

if (!target) {
  console.error(
    "Usage: npm run atc:check -- <product-url> [--qty N] [--password P] [--save]\n" +
      "                              [--country XX] [--zip CODE]",
  );
  process.exit(2);
}

const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};

let host;
try {
  host = new URL(target).host;
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

/**
 * The product URL may be on a custom domain while the Admin API session is
 * keyed by the *.myshopify.com domain, so fall back to the only stored session
 * when the host does not match one directly.
 */
async function resolveSession() {
  const byHost = await db.session.findFirst({ where: { shop: host } });
  if (byHost?.accessToken) return byHost;
  const all = await db.session.findMany();
  if (all.length === 1 && all[0].accessToken) return all[0];
  throw new Error(
    all.length
      ? `No stored Admin API session matches ${host}. Stored: ${all.map((s) => s.shop).join(", ")}`
      : "No Admin API session stored yet. Run `npm run dev` and open the app in Shopify Admin once.",
  );
}

const session = await resolveSession().catch((err) => {
  console.error(err.message);
  process.exit(2);
});
const shop = session.shop;

const settings = await db.shopSetting.findUnique({ where: { shop } }).catch(() => null);

let password = flag("password");
if (argv.includes("--save")) {
  if (password === undefined) {
    console.error("--save needs --password <value> (use --password '' to clear it)");
    process.exit(2);
  }
  await db.shopSetting.upsert({
    where: { shop },
    create: { shop, storefrontPassword: password || null },
    update: { storefrontPassword: password || null },
  });
  console.log(password ? `Saved the storefront password for ${shop}.` : "Cleared the stored password.");
}
password = password ?? settings?.storefrontPassword ?? undefined;

/** Reuses the cached Storefront API token, minting one the first time. */
async function getToken() {
  const cached = await db.shopSetting.findUnique({ where: { shop } });
  if (cached?.storefrontApiToken) return cached.storefrontApiToken;
  const token = await mintStorefrontToken(shop, session.accessToken);
  await db.shopSetting.upsert({
    where: { shop },
    create: { shop, storefrontApiToken: token },
    update: { storefrontApiToken: token },
  });
  return token;
}

const opts = {
  shop,
  productUrl: target,
  quantity: Math.max(1, Number(flag("qty") ?? 1) || 1),
  adminToken: session.accessToken,
  storefrontPassword: password,
  country: flag("country"),
  zip: flag("zip"),
};

const run = blankRun("cli", opts);

const LAYER = {
  admin: "Store & product (Admin API)",
  storefront: "Buyer path (Cart API)",
  theme: "Theme (live storefront)",
  checkout: "Checkout readiness",
};

console.log(`\nATC flow check → ${target}`);
console.log(
  `shop ${shop} · quantity ${opts.quantity} · no browser${password ? " · storefront password loaded" : ""}\n`,
);

const announced = new Set();
let currentLayer = null;

try {
  await runCheck(run, opts, getToken, (r) => {
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
console.log(
  `\n${run.status === "passed" ? (warned ? "FLOW OK (with warnings)" : "FLOW OK") : "FLOW BROKEN"}`,
);
if (run.error) console.log(`Reason:   ${run.error}`);
if (run.cartTotal) console.log(`Total:    ${run.cartTotal}`);
if (run.checkoutUrl) console.log(`Checkout: ${run.checkoutUrl}`);

process.exit(run.status === "passed" ? 0 : 1);
