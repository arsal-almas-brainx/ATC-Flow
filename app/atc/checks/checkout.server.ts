import type { Page } from "playwright";
import { Skip } from "../shared.server.ts";
import { assertNoChallengeOnPage } from "../browser/challenge.server.ts";

/**
 * Clicks the cart's real checkout control and confirms a real checkout was
 * reached. Asserts nothing about its contents (shipping rates, payment
 * methods) — Shopify's Web Bot Auth signature does not cover the checkout
 * host, which is the platform's most heavily bot-protected surface by
 * design, so a blocked checkout here is reported as Skip, never a failure.
 */
export async function checkCheckoutReached(
  page: Page,
  origin: string,
): Promise<{ detail: string; checkoutUrl?: string }> {
  // Whatever the previous step left the page doing (a quantity control's own
  // AJAX update, a discount redirect) isn't guaranteed to have settled —
  // load /cart fresh so the checkout control is looked for on a known,
  // stable page rather than mid-transition.
  let cartResponse;
  try {
    cartResponse = await page.goto(`${origin}/cart`, { waitUntil: "domcontentloaded", timeout: 20_000 });
  } catch (err) {
    throw new Skip(
      `The real browser could not reload the cart page: ${err instanceof Error ? err.message : err}`,
    );
  }
  await assertNoChallengeOnPage("the cart page", page, cartResponse);

  const cartCheckout = page
    .locator('form[action="/cart"] button[name="checkout"], form[action="/cart"] input[name="checkout"], button[name="checkout"], input[name="checkout"]')
    .first();
  const link = page.locator('a[href^="/checkout"]').first();

  let response;
  if ((await cartCheckout.count()) > 0) {
    [response] = await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => null),
      cartCheckout.click({ timeout: 5000 }).catch((err: unknown) => {
        throw new Error(`Clicking through to checkout failed: ${err instanceof Error ? err.message : err}`);
      }),
    ]);
  } else if ((await link.count()) > 0) {
    [response] = await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => null),
      link.click({ timeout: 5000 }).catch((err: unknown) => {
        throw new Error(`Clicking through to checkout failed: ${err instanceof Error ? err.message : err}`);
      }),
    ]);
  } else {
    throw new Skip(
      "No checkout control was found on the cart page — this theme's cart layout isn't one this " +
        "check supports yet.",
    );
  }

  await assertNoChallengeOnPage("checkout", page, response ?? null);

  const url = page.url();
  if (/\/password\b/.test(url)) {
    throw new Skip(
      "Checkout redirected to the storefront password page. The storefront password may need to be " +
        "re-saved under Settings.",
    );
  }

  const landed = /\/checkouts?\//.test(url) || /\/cart\/c\//.test(url) || /checkout\.shopify\.com/.test(url);
  if (!landed) {
    throw new Error(
      `Clicked through to checkout, but landed on ${url}, which doesn't look like a checkout page.`,
    );
  }

  return { detail: `Reached checkout at ${new URL(url).pathname}`, checkoutUrl: url };
}
