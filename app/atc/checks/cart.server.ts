import type { Page } from "playwright";
import { Skip, Warn, money } from "../shared.server.ts";
import { assertNoChallengeOnPage } from "../browser/challenge.server.ts";
import { readCart, type CartJson } from "../browser/cart.server.ts";

/**
 * Clicks the theme's real on-page Add-to-cart control — the one thing a
 * plain HTTP request structurally cannot prove, since it depends on the
 * theme's own JavaScript actually being wired up. Asserts success via
 * /cart.js (same-origin, cookies automatic) rather than scraping a
 * theme-specific cart badge, so the assertion stays theme-agnostic even
 * though the trigger is a real click. When no variant id could be read off
 * the product page, falls back to asserting the cart's total item count
 * rose, rather than a specific variant's line.
 */
export async function checkAddToCart(
  page: Page,
  origin: string,
  productUrl: string,
  variantId: string | null,
  variantLabel: string,
  quantity: number,
): Promise<string> {
  // The search step navigates away from the product page — a real shopper
  // who searched would land back on it before buying, so return there
  // rather than assuming the page is still where an earlier step left it.
  if (new URL(page.url()).pathname !== new URL(productUrl).pathname) {
    let response;
    try {
      response = await page.goto(productUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
    } catch (err) {
      throw new Skip(
        `The real browser could not return to the product page: ${err instanceof Error ? err.message : err}`,
      );
    }
    await assertNoChallengeOnPage("the product page", page, response);
  }

  const control = page
    .locator('form[action*="/cart/add"] button[type="submit"], form[action*="/cart/add"] input[type="submit"]')
    .first();

  if ((await control.count()) === 0) {
    throw new Skip(
      "No add-to-cart control was found on the rendered product page. This check only recognizes " +
        "the theme's default add-to-cart form; a custom or heavily modified theme layout may need a " +
        "different selector.",
    );
  }

  const before = await readCart(page, origin);
  const beforeQty = variantId ? lineQuantity(before, variantId) : (before?.item_count ?? 0);

  try {
    // `click()` auto-waits for the control to become visible, stable and
    // enabled before acting — many themes finish hydrating (revealing or
    // enabling the button) shortly after the initial page load, so this is
    // given real time rather than judged on an immediate isVisible() snapshot.
    await control.click({ timeout: 8000 });
  } catch (err) {
    throw new Error(
      `Clicking the add-to-cart button failed — it never became clickable within 8s: ` +
        `${err instanceof Error ? err.message.split("\n")[0] : err}.`,
    );
  }

  const label = variantId ? `of "${variantLabel}"` : "item(s)";
  const deadline = Date.now() + 8000;
  let afterQty = beforeQty;
  while (Date.now() < deadline) {
    const after = await readCart(page, origin);
    afterQty = variantId ? lineQuantity(after, variantId) : (after?.item_count ?? 0);
    if (afterQty >= beforeQty + quantity) break;
    await page.waitForTimeout(400);
  }

  if (afterQty < beforeQty + quantity) {
    throw new Error(
      `Clicked the real add-to-cart button, but the cart still shows ${afterQty} ${label} (expected ` +
        `at least ${beforeQty + quantity}) after 8s.`,
    );
  }

  return `Clicked the real Add-to-cart button · cart now holds ${afterQty} ${label}`;
}

/**
 * Navigates to /cart and waits for the theme to actually render its
 * contents before reading the page — many themes populate the cart via
 * client-side JS after the initial HTML, which a naive immediate read
 * mistakes for "the cart is empty."
 */
export async function checkCartPage(
  page: Page,
  origin: string,
): Promise<{ detail: string; cartTotal?: string }> {
  let response;
  try {
    response = await page.goto(`${origin}/cart`, { waitUntil: "domcontentloaded", timeout: 20_000 });
  } catch (err) {
    throw new Skip(
      `The real browser could not load the cart page: ${err instanceof Error ? err.message : err}`,
    );
  }
  await assertNoChallengeOnPage("the cart page", page, response);
  if (!response?.ok()) {
    throw new Error(`The cart page returned HTTP ${response?.status() ?? "unknown"} in a real browser`);
  }

  let cart: CartJson | null = null;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    cart = await readCart(page, origin);
    if ((cart?.item_count ?? 0) > 0) break;
    await page.waitForTimeout(300);
  }

  if (!cart || cart.item_count === 0) {
    throw new Error("The cart page shows no items even though an item was just added to the cart.");
  }

  const bodyText = await page.locator("body").innerText({ timeout: 1000 }).catch(() => "");
  if (/cart is empty|your cart is empty/i.test(bodyText)) {
    throw new Error(
      "The cart page's own text says the cart is empty, even though the theme's cart data reports items in it.",
    );
  }

  const total = money(cart.total_price / 100, cart.currency);
  return {
    detail: `HTTP ${response.status()} · ${cart.item_count} item(s) · subtotal ${total}`,
    cartTotal: total,
  };
}

/**
 * Bumps the cart quantity by one via whatever control the theme exposes,
 * then restores it. This selector is a best-effort heuristic across many
 * possible theme patterns (unlike add-to-cart's, which targets Shopify's own
 * platform-standard form) — so when a control is found but Playwright can't
 * actually interact with it, that is reported as inconclusive (Skip), not
 * proof the flow is broken.
 */
export async function checkCartQuantityUpdate(page: Page, origin: string): Promise<string> {
  const before = await readCart(page, origin);
  const beforeCount = before?.item_count ?? 0;
  if (beforeCount === 0) {
    throw new Skip("Skipped — the cart is empty, so there is no quantity to change.");
  }

  // Some themes render several hidden `name="quantity"` inputs (line-item
  // templates not currently in use) ahead of the one real, visible control in
  // DOM order — `:not([type="hidden"])` keeps `.first()` from grabbing one of
  // those instead of the actual control a shopper would use.
  const qtyInput = page
    .locator(
      'input[name^="updates["]:not([type="hidden"]), input[name="quantity"]:not([type="hidden"]), ' +
        "[data-quantity-input] input:not([type=\"hidden\"])",
    )
    .first();
  const plusButton = page.locator('button[name="plus"], [data-quantity-increase]').first();
  const minusButton = page.locator('button[name="minus"], [data-quantity-decrease]').first();

  const hasInput = (await qtyInput.count()) > 0;
  const hasStepper = !hasInput && (await plusButton.count()) > 0;
  if (!hasInput && !hasStepper) {
    throw new Skip(
      "No recognizable quantity control was found on the cart page — this theme's cart layout isn't " +
        "one this check supports yet.",
    );
  }

  try {
    if (hasInput) {
      const current = Number(await qtyInput.inputValue().catch(() => "")) || 1;
      await qtyInput.fill(String(current + 1), { timeout: 8000 });
      await qtyInput.press("Enter").catch(() => {});
    } else {
      await plusButton.click({ timeout: 8000 });
    }
  } catch (err) {
    throw new Skip(
      `Found a quantity control, but couldn't interact with it (${err instanceof Error ? err.message.split("\n")[0] : err}) — this theme's cart layout isn't fully supported yet.`,
    );
  }

  const bumped = await waitForItemCount(page, origin, beforeCount + 1, 8000);
  if (bumped == null) {
    throw new Error(`Raising the cart quantity did not update the cart within 8s (still ${beforeCount}).`);
  }

  if (hasInput) {
    await qtyInput.fill(String(beforeCount), { timeout: 8000 }).catch(() => {});
    await qtyInput.press("Enter").catch(() => {});
  } else if ((await minusButton.count()) > 0) {
    await minusButton.click({ timeout: 8000 }).catch(() => {});
  }
  const restored = await waitForItemCount(page, origin, beforeCount, 8000);

  return `Cart item count ${beforeCount} → ${bumped}${restored == null ? " (restore did not confirm — check the cart)" : " → restored"}`;
}

/**
 * Applies a discount via Shopify's own discount-permalink route
 * (`/discount/<code>`) rather than a theme discount field, since that field
 * is inconsistently present across themes (often shown only at checkout)
 * while the permalink route is a platform-level guarantee on every store.
 */
export async function checkCartDiscount(page: Page, origin: string, code: string): Promise<string> {
  const before = await readCart(page, origin);
  const beforeTotal = before?.total_price ?? 0;
  const currency = before?.currency ?? "USD";

  let response;
  try {
    response = await page.goto(`${origin}/discount/${encodeURIComponent(code)}?redirect=%2Fcart`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
  } catch (err) {
    throw new Skip(
      `The real browser could not apply the discount code: ${err instanceof Error ? err.message : err}`,
    );
  }
  await assertNoChallengeOnPage("the discount link", page, response);
  if (!response?.ok()) {
    throw new Error(`The discount link returned HTTP ${response?.status() ?? "unknown"} in a real browser`);
  }

  const after = await readCart(page, origin);
  const applied = (after?.cart_level_discount_applications ?? []).some(
    (d) => d.title.toLowerCase() === code.toLowerCase(),
  );
  if (!applied) {
    throw new Error(
      `The discount code "${code}" was not applied — the cart does not show it as active. Check that ` +
        "it's active and matches this product.",
    );
  }

  const afterTotal = after?.total_price ?? beforeTotal;
  if (!(afterTotal < beforeTotal)) {
    throw new Warn(
      `The discount code "${code}" was accepted, but the cart total did not decrease (still ` +
        `${money(afterTotal / 100, currency)}) — expected for free-shipping-only or non-monetary discounts.`,
    );
  }

  return `"${code}" applied — total dropped from ${money(beforeTotal / 100, currency)} to ${money(afterTotal / 100, currency)}`;
}

function lineQuantity(cart: CartJson | null, variantId: string): number {
  const line = cart?.items.find((i) => String(i.variant_id) === variantId);
  return line?.quantity ?? 0;
}

async function waitForItemCount(
  page: Page,
  origin: string,
  target: number,
  timeoutMs: number,
): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const cart = await readCart(page, origin);
    if ((cart?.item_count ?? -1) === target) return target;
    await page.waitForTimeout(400);
  }
  return null;
}
