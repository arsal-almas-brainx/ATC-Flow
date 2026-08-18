import { chromium, type BrowserContext, type Page } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FlowRun, RunOptions, StepStatus } from "./types";

export const RUNS_DIR = path.join(process.cwd(), ".atc-runs");

const STEP_PLAN: Array<[string, string]> = [
  ["open-product", "Open live product page"],
  ["read-form", "Find add-to-cart form & variant"],
  ["reset-cart", "Empty the cart (clean start)"],
  ["click-atc", "Click Add to cart"],
  ["verify-cart-api", "Verify cart contents (/cart.js)"],
  ["open-cart", "Open cart page"],
  ["go-checkout", "Click Checkout"],
  ["verify-checkout", "Verify checkout page & total"],
];

/** A Shopify cart as returned by /cart.js */
type AjaxCart = {
  item_count: number;
  total_price: number;
  currency: string;
  items: Array<{
    id: number;
    variant_id: number;
    quantity: number;
    product_title: string;
    line_price: number;
  }>;
};

export function blankRun(id: string, opts: RunOptions): FlowRun {
  return {
    id,
    shop: opts.shop,
    productUrl: opts.productUrl,
    quantity: opts.quantity ?? 1,
    status: "queued",
    startedAt: Date.now(),
    steps: STEP_PLAN.map(([key, title]) => ({ key, title, status: "pending" as StepStatus })),
  };
}

/**
 * Drives a real headless browser through the storefront's add-to-cart flow and
 * stops once checkout is confirmed loaded. No order is placed.
 */
export async function runAtcFlow(
  run: FlowRun,
  opts: RunOptions,
  onUpdate: (run: FlowRun) => void,
): Promise<FlowRun> {
  const quantity = opts.quantity ?? 1;
  const shotDir = path.join(RUNS_DIR, run.id);
  await mkdir(shotDir, { recursive: true });

  run.status = "running";
  onUpdate(run);

  const browser = await chromium.launch({ headless: opts.headless !== false });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 900 },
    locale: "en-US",
  });
  const page = await context.newPage();

  // Shared state between steps.
  let variantId: string | null = null;
  let cart: AjaxCart | null = null;

  const stepIndex = (key: string) => run.steps.findIndex((s) => s.key === key);

  const step = async (key: string, fn: () => Promise<string | void>) => {
    const i = stepIndex(key);
    const s = run.steps[i];
    s.status = "running";
    onUpdate(run);
    const t0 = Date.now();
    try {
      const detail = await fn();
      s.status = "pass";
      if (detail) s.detail = detail;
    } catch (err) {
      s.status = "fail";
      s.detail = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      s.durationMs = Date.now() - t0;
      s.screenshot = await safeShot(page, shotDir, key);
      onUpdate(run);
    }
  };

  try {
    await step("open-product", async () => {
      if (opts.storefrontPassword) {
        // The unlock cookie is set per origin, so it has to be submitted on the
        // same origin as the product URL — not on the .myshopify.com domain,
        // which may differ from the store's primary domain.
        const origin = new URL(opts.productUrl).origin;
        await page.goto(`${origin}/password`, { waitUntil: "domcontentloaded" });
        const pw = page.locator('input[type="password"], input[name="password"]').first();
        if (await pw.count()) {
          await pw.fill(opts.storefrontPassword);
          await pw.press("Enter");
          await page.waitForLoadState("domcontentloaded");
          if (page.url().includes("/password")) {
            throw new Error("Storefront password was rejected — check the password and retry");
          }
        }
      }
      const res = await page.goto(opts.productUrl, {
        waitUntil: "domcontentloaded",
        timeout: 45_000,
      });
      const status = res?.status() ?? 0;
      if (status >= 400) throw new Error(`Product page returned HTTP ${status}`);
      if (page.url().includes("/password")) {
        throw new Error(
          opts.storefrontPassword
            ? "Storefront re-locked after unlocking — the password may be for a different domain"
            : "Storefront is password protected — enter the storefront password and retry",
        );
      }
      const title = (await page.locator("h1").first().textContent().catch(() => null))?.trim();
      return `HTTP ${status}${title ? ` · "${title}"` : ""}`;
    });

    await step("read-form", async () => {
      const form = page.locator('form[action*="/cart/add"]').first();
      await form.waitFor({ state: "attached", timeout: 15_000 }).catch(() => {
        throw new Error('No add-to-cart form found (form[action*="/cart/add"]) on the page');
      });

      // Variant can be a <select name="id">, hidden <input name="id">, or radio swatches.
      const select = form.locator('select[name="id"]').first();
      if (await select.count()) {
        const value = await select
          .locator("option:not([disabled])")
          .first()
          .getAttribute("value");
        if (value) {
          await select.selectOption(value).catch(() => {});
          variantId = value;
        }
      } else {
        const hidden = form.locator('input[name="id"]').first();
        if (await hidden.count()) variantId = await hidden.getAttribute("value");
      }

      if (quantity > 1) {
        const qty = form.locator('input[name="quantity"]').first();
        if (await qty.count()) await qty.fill(String(quantity));
      }

      return variantId
        ? `variant ${variantId}, quantity ${quantity}`
        : `default variant, quantity ${quantity}`;
    });

    await step("reset-cart", async () => {
      const before = await readCart(page);
      await page.evaluate(() =>
        fetch("/cart/clear.js", { method: "POST", headers: { "Content-Type": "application/json" } }),
      );
      const after = await readCart(page);
      if (after.item_count !== 0) throw new Error(`Cart did not clear (item_count=${after.item_count})`);
      return `cleared ${before.item_count} item(s)`;
    });

    await step("click-atc", async () => {
      const clicked = await clickAddToCart(page);
      const c = await waitForCartCount(page, 1, 20_000);
      cart = c;
      return `matched ${clicked} → cart item_count ${c.item_count}`;
    });

    await step("verify-cart-api", async () => {
      const c = cart ?? (await readCart(page));
      cart = c;
      const problems: string[] = [];
      if (c.item_count < 1) problems.push("cart is empty");
      const line = c.items[0];
      if (!line) problems.push("no line item returned");
      if (line && line.quantity !== quantity) {
        problems.push(`quantity is ${line.quantity}, expected ${quantity}`);
      }
      if (line && variantId && String(line.variant_id) !== String(variantId)) {
        problems.push(`variant is ${line.variant_id}, expected ${variantId}`);
      }
      if (c.total_price <= 0) problems.push("total_price is 0");
      if (problems.length) throw new Error(problems.join("; "));
      return `${line.product_title} ×${line.quantity} · ${money(c.total_price, c.currency)}`;
    });

    await step("open-cart", async () => {
      const res = await page.goto(`https://${opts.shop}/cart`, { waitUntil: "domcontentloaded" });
      if ((res?.status() ?? 0) >= 400) throw new Error(`Cart page returned HTTP ${res?.status()}`);
      const title = cart?.items[0]?.product_title;
      if (title) {
        const body = (await page.locator("body").innerText()).toLowerCase();
        if (!body.includes(title.toLowerCase().slice(0, 20))) {
          throw new Error(`"${title}" not visible on the cart page`);
        }
      }
      const btn = checkoutButton(page);
      if (!(await btn.count())) throw new Error("No checkout button found on the cart page");
      return `line item rendered, checkout button present`;
    });

    await step("go-checkout", async () => {
      const btn = checkoutButton(page).first();
      await Promise.all([
        page.waitForURL(/\/checkouts?\b|\/checkouts\//, { timeout: 45_000 }).catch(() => {}),
        btn.click({ timeout: 15_000 }),
      ]);
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      if (!/\/checkouts?\//.test(page.url())) {
        // Fall back to the canonical checkout URL before declaring failure.
        await page.goto(`https://${opts.shop}/checkout`, { waitUntil: "domcontentloaded" });
      }
      if (!/\/checkouts?\b/.test(page.url())) {
        throw new Error(`Did not reach checkout — landed on ${page.url()}`);
      }
      run.checkoutUrl = page.url();
      return page.url();
    });

    await step("verify-checkout", async () => {
      const body = await page.locator("body").innerText();
      const lower = body.toLowerCase();

      if (/captcha|are you a human|verifying you are human|unusual traffic/.test(lower)) {
        throw new Error("Checkout served a bot/captcha challenge instead of the checkout form");
      }
      if (/cart is empty|your cart is empty/.test(lower)) {
        throw new Error("Checkout says the cart is empty — the cart did not carry over");
      }

      const hasEmail = await page
        .locator('input[type="email"], input[name="email"], input[name="checkout[email]"]')
        .count();
      const hasSummary = /order summary|subtotal|shipping/.test(lower);
      if (!hasEmail && !hasSummary) {
        throw new Error("Checkout page has neither a contact field nor an order summary");
      }

      const expected = cart ? (cart.total_price / 100).toFixed(2) : null;
      const totalMatches = expected ? body.includes(expected) : false;
      run.cartTotal = cart ? money(cart.total_price, cart.currency) : undefined;

      return [
        hasEmail ? "contact field ✓" : null,
        hasSummary ? "order summary ✓" : null,
        expected ? (totalMatches ? `total ${expected} ✓` : `total ${expected} not found in summary`) : null,
      ]
        .filter(Boolean)
        .join(" · ");
    });

    run.status = "passed";
  } catch (err) {
    run.status = "failed";
    run.error = err instanceof Error ? err.message : String(err);
    for (const s of run.steps) if (s.status === "pending") s.status = "skip";
  } finally {
    run.finishedAt = Date.now();
    onUpdate(run);
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  return run;
}

// ---------- helpers ----------

function checkoutButton(page: Page) {
  return page.locator(
    [
      'button[name="checkout"]',
      'input[name="checkout"]',
      'form[action*="/cart"] [type="submit"][name="checkout"]',
      'a[href="/checkout"]',
      'a[href*="/checkout"]',
      'button:has-text("Check out")',
      'button:has-text("Checkout")',
    ].join(", "),
  );
}

async function clickAddToCart(page: Page): Promise<string> {
  const candidates = [
    'form[action*="/cart/add"] [type="submit"][name="add"]',
    'form[action*="/cart/add"] button[type="submit"]',
    'form[action*="/cart/add"] input[type="submit"]',
    'button[name="add"]',
    '[data-testid="add-to-cart"]',
    'button:has-text("Add to cart")',
    'button:has-text("Add to bag")',
  ];
  for (const sel of candidates) {
    const el = page.locator(sel).first();
    if (!(await el.count())) continue;
    if (!(await el.isEnabled().catch(() => false))) continue;
    await el.scrollIntoViewIfNeeded().catch(() => {});
    await el.click({ timeout: 10_000 });
    return sel;
  }
  throw new Error("No enabled Add-to-cart button matched any known selector");
}

async function readCart(page: Page): Promise<AjaxCart> {
  return page.evaluate(async () => {
    const r = await fetch("/cart.js", { headers: { Accept: "application/json" } });
    return r.json();
  });
}

async function waitForCartCount(page: Page, min: number, timeoutMs: number): Promise<AjaxCart> {
  const deadline = Date.now() + timeoutMs;
  let last: AjaxCart | null = null;
  while (Date.now() < deadline) {
    last = await readCart(page).catch(() => null);
    if (last && last.item_count >= min) return last;
    await page.waitForTimeout(500);
  }
  throw new Error(
    `Cart never reached ${min} item(s) after clicking Add to cart (last item_count=${last?.item_count ?? "unknown"})`,
  );
}

async function safeShot(page: Page, dir: string, key: string): Promise<string | undefined> {
  try {
    const file = path.join(dir, `${key}.png`);
    const buf = await page.screenshot({ fullPage: false });
    await writeFile(file, buf);
    return `${key}.png`;
  } catch {
    return undefined;
  }
}

function money(cents: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

export type { BrowserContext };
