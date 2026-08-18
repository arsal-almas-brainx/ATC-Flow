/**
 * Standalone ATC flow check — runs the exact same flow as the app UI, from the
 * terminal, with no Shopify install or OAuth required.
 *
 *   npm run atc:check -- https://your-store.com/products/some-product
 *   npm run atc:check -- https://your-store.com/products/some-product --qty 2
 *   npm run atc:check -- https://your-store.com/products/x --password hunter2
 *   npm run atc:check -- https://your-store.com/products/x --password hunter2 --save
 *   npm run atc:check -- https://your-store.com/products/x --headed
 *
 * --save stores the password so later runs (and the app UI) reuse it.
 *
 * Exits 0 when the flow reaches checkout, 1 when it breaks — so it also works
 * as a CI / cron smoke test.
 */
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { blankRun, runAtcFlow, RUNS_DIR } = await import(
  path.join(here, "..", "app", "atc", "runner.server.ts")
);

const argv = process.argv.slice(2);
const target = argv.find((a) => !a.startsWith("--"));

if (!target) {
  console.error("Usage: npm run atc:check -- <product-url> [--qty N] [--password P] [--headed]");
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

/**
 * Talks to Prisma directly rather than importing app/atc/settings.server.ts —
 * the app modules use extensionless imports that Vite resolves but plain Node
 * ESM does not.
 */
async function withPrisma(fn) {
  let client;
  try {
    const { PrismaClient } = await import("@prisma/client");
    client = new PrismaClient();
    return await fn(client);
  } catch {
    return undefined; // No database yet — carry on without stored settings.
  } finally {
    await client?.$disconnect().catch(() => {});
  }
}

// An explicit --password wins; otherwise reuse whatever was saved in the app UI.
let password = flag("password");
let passwordSource = password ? "--password flag" : undefined;

if (argv.includes("--save")) {
  if (!password) {
    console.error("--save needs --password <value> (or use it to clear: --password '' --save)");
    process.exit(2);
  }
  const ok = await withPrisma((db) =>
    db.shopSetting.upsert({
      where: { shop: host },
      create: { shop: host, storefrontPassword: password },
      update: { storefrontPassword: password },
    }),
  );
  console.log(
    ok
      ? `Saved storefront password for ${host}.`
      : `Could not save password — run \`npm run setup\` to create the database.`,
  );
}

if (!password) {
  const found = await withPrisma(async (db) => {
    const exact = await db.shopSetting.findUnique({ where: { shop: host } });
    if (exact?.storefrontPassword) {
      return { password: exact.storefrontPassword, source: host };
    }
    // Fall back to the only configured shop, if there is exactly one.
    const all = await db.shopSetting.findMany({
      where: { storefrontPassword: { not: null } },
    });
    return all.length === 1
      ? { password: all[0].storefrontPassword, source: all[0].shop }
      : undefined;
  });

  if (found?.password) {
    password = found.password;
    passwordSource = `saved settings (${found.source})`;
  }
}

const opts = {
  shop: host,
  productUrl: target,
  quantity: Math.max(1, Number(flag("qty") ?? 1) || 1),
  storefrontPassword: password,
  headless: !argv.includes("--headed"),
};

// Fixed id so repeated local checks reuse one screenshot folder.
const run = blankRun("00000000-0000-4000-8000-00000000c11e", opts);

console.log(`\nATC flow check → ${target}`);
console.log(
  `quantity ${opts.quantity} · ${opts.headless ? "headless" : "headed"}` +
    (passwordSource ? ` · password from ${passwordSource}` : ""),
);
console.log("");

const announced = new Set();
await runAtcFlow(run, opts, (r) => {
  for (const s of r.steps) {
    if (s.status === "pending" || s.status === "running") continue;
    const id = `${s.key}:${s.status}`;
    if (announced.has(id)) continue;
    announced.add(id);
    const label = { pass: "PASS", fail: "FAIL", skip: "SKIP" }[s.status] ?? s.status;
    const ms = s.durationMs != null ? ` (${s.durationMs}ms)` : "";
    console.log(`  [${label}] ${s.title}${ms}`);
    if (s.detail) console.log(`         ${s.detail}`);
  }
});

console.log(`\n${run.status === "passed" ? "✅ FLOW OK" : "❌ FLOW BROKEN"}`);
if (run.error) console.log(`Reason:   ${run.error}`);
if (run.cartTotal) console.log(`Cart:     ${run.cartTotal}`);
if (run.checkoutUrl) console.log(`Checkout: ${run.checkoutUrl}`);

const dir = path.join(RUNS_DIR, run.id);
const shots = await readdir(dir).catch(() => []);
if (shots.length) console.log(`Screenshots: ${dir}`);

process.exit(run.status === "passed" ? 0 : 1);
