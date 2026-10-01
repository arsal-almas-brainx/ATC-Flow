import type { Page } from "playwright";
import { Skip, Warn, money } from "../shared.server.ts";
import { assertNoChallengeOnPage } from "../browser/challenge.server.ts";
import { readCart, type CartJson } from "../browser/cart.server.ts";

/**
 * Quantity controls, across theme conventions: Shopify's own names
 * (plus/minus, quantity, updates[]), data attributes, and — for themes that
 * name nothing — accessible labels ("button-plus", "Increase quantity",
 * "Quantity for …"). `:visible` skips hidden templates and closed drawers.
 */
export const PLUS =
  'button[name="plus"]:visible, [data-quantity-increase]:visible, ' +
  'button[aria-label*="plus" i]:visible, button[aria-label*="increase" i]:visible';
export const MINUS =
  'button[name="minus"]:visible, [data-quantity-decrease]:visible, ' +
  'button[aria-label*="minus" i]:visible, button[aria-label*="decrease" i]:visible';
const PRODUCT_QTY_INPUT =
  'input[name="quantity"]:visible, input[type="number"][aria-label*="quantity" i]:visible';
const CART_QTY_INPUT =
  'input[name^="updates["]:visible, [data-quantity-input] input:visible, ' +
  'input[type="number"][aria-label*="quantity" i]:visible';

/**
 * Tests the product page's quantity selector the way a shopper uses it —
 * + then − — confirming the number shown actually changes each time, then
 * leaves it set to `quantity` for the add-to-cart step. Falls back to typing
 * into the box when the theme has no + / − buttons.
 */
export async function checkProductQuantity(
  page: Page,
  productUrl: string,
  quantity: number,
): Promise<string> {
  await returnToProductPage(page, productUrl);

  const input = page.locator(PRODUCT_QTY_INPUT).first();
  if ((await input.count()) === 0) {
    if (quantity > 1) {
      throw new Error(
        `This product page has no quantity selector, so a quantity of ${quantity} can't be chosen.`,
      );
    }
    throw new Skip("This product page has no quantity selector — the theme adds one at a time.");
  }

  const plus = page.locator(PLUS).first();
  const minus = page.locator(MINUS).first();
  const useButtons = (await plus.count()) > 0 && (await minus.count()) > 0;

  const read = async () => Number(await input.inputValue()) || 0;
  const waitFor = async (target: number) => {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if ((await read()) === target) return true;
      await page.waitForTimeout(200);
    }
    return false;
  };
  const press = async (button: typeof plus, target: number, what: string) => {
    await button.click({ timeout: 8000 });
    if (!(await waitFor(target))) {
      throw new Error(
        `Pressing ${what} on the product page did not change the quantity (expected ${target}, shows ${await read()}).`,
      );
    }
  };

  const start = (await read()) || 1;
  if (useButtons) {
    await press(plus, start + 1, "+");
    await press(minus, start, "−");
    while ((await read()) < quantity) await press(plus, (await read()) + 1, "+");
  } else {
    await input.fill(String(quantity));
    await input.press("Tab");
    if (!(await waitFor(quantity))) {
      throw new Error(`Typing ${quantity} into the product page's quantity box did not stick.`);
    }
  }

  return useButtons
    ? `Quantity ${start} → ${start + 1} → ${start} using + / −, then set to ${quantity}`
    : `No + / − buttons; typed ${quantity} into the quantity box`;
}

/** The search step navigates away; a shopper who searched lands back here before buying. */
async function returnToProductPage(page: Page, productUrl: string) {
  if (new URL(page.url()).pathname === new URL(productUrl).pathname) return;
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
  await returnToProductPage(page, productUrl);

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

  // The product-quantity step has already set the selector to the requested
  // amount; expect exactly what the page will send, not what was asked for.
  const selected = page.locator(PRODUCT_QTY_INPUT).first();
  if ((await selected.count()) > 0) {
    quantity = Number(await selected.inputValue().catch(() => "")) || quantity;
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
 * Changes the cart line's quantity up by one and back down, the way a shopper
 * would: the theme's own + / − buttons, falling back to typing into the
 * quantity box and moving focus away (never Enter — on many themes Enter
 * submits the whole cart form, whose default button is Checkout). Each change
 * is confirmed against /cart.js, so a control that only looks like it worked
 * is still caught.
 */
export async function checkCartQuantityUpdate(page: Page, origin: string): Promise<string> {
  const before = await readCart(page, origin);
  const start = before?.item_count ?? 0;
  if (start === 0) {
    throw new Skip("Skipped — the cart is empty, so there is no quantity to change.");
  }

  // `:visible` skips hidden line-item templates and product-card forms some
  // themes render on the cart page ahead of the real control.
  const plus = page.locator(PLUS).first();
  const minus = page.locator(MINUS).first();
  const input = page
    .locator(CART_QTY_INPUT)
    .first();

  const useButtons = (await plus.count()) > 0 && (await minus.count()) > 0;
  if (!useButtons && (await input.count()) === 0) {
    throw new Skip(
      "No recognizable quantity control was found on the cart page — this theme's cart layout isn't " +
        "one this check supports yet.",
    );
  }

  const change = async (direction: 1 | -1, target: number) => {
    try {
      if (useButtons) {
        // click() waits for the button to be enabled — − is disabled at 1 and
        // themes briefly disable both while an update is in flight.
        await (direction === 1 ? plus : minus).click({ timeout: 8000 });
      } else {
        await input.fill(String(target), { timeout: 8000 });
        await input.press("Tab");
      }
    } catch (err) {
      throw new Skip(
        `Found a quantity control, but couldn't interact with it (${err instanceof Error ? err.message.split("\n")[0] : err}) — this theme's cart layout isn't fully supported yet.`,
      );
    }
    const reached = await waitForItemCount(page, origin, target, 8000);
    assertStillOnCart(page);
    if (reached == null) {
      const now = (await readCart(page, origin))?.item_count ?? "unknown";
      throw new Error(
        `${direction === 1 ? "Increasing" : "Decreasing"} the cart quantity did not update the cart ` +
          `within 8s (expected ${target}, cart shows ${now}).`,
      );
    }
  };

  await change(1, start + 1);
  await change(-1, start);

  const how = useButtons ? "+ / − buttons" : "quantity box";
  return `Cart quantity ${start} → ${start + 1} → ${start} using the cart's ${how}`;
}

function assertStillOnCart(page: Page) {
  const { pathname } = new URL(page.url());
  if (!/\/cart\/?$/.test(pathname)) {
    throw new Error(
      `Changing the cart quantity navigated away from the cart (landed on ${pathname}) instead of ` +
        "updating it in place.",
    );
  }
}

/**
 * Applies a discount via Shopify's own discount-permalink route
 * (`/discount/<code>`) rather than a theme discount field, since that field
 * is inconsistently present across themes (often shown only at checkout)
 * while the permalink route is a platform-level guarantee on every store.
 */
export async function checkCartDiscount(
  page: Page,
  origin: string,
  code: string,
): Promise<{ detail: string; cartTotal: string }> {
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

  return {
    detail: `"${code}" applied — total dropped from ${money(beforeTotal / 100, currency)} to ${money(afterTotal / 100, currency)}`,
    cartTotal: money(afterTotal / 100, currency),
  };
}

function lineQuantity(cart: CartJson | null, variantId: string): number {
  const line = cart?.items.find((i) => String(i.variant_id) === variantId);
  return line?.quantity ?? 0;
}

export async function waitForItemCount(
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
