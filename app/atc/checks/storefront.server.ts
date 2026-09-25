import type { Page } from "playwright";
import { Skip } from "../shared.server.ts";
import { assertNoChallengeOnPage } from "../browser/challenge.server.ts";

/**
 * If the storefront is password-protected, unlocks it through the real
 * password form before anything else navigates. A no-op when no password is
 * supplied, or when the store isn't actually password-walled (the form is
 * simply absent).
 */
export async function unlockPasswordIfNeeded(
  page: Page,
  origin: string,
  password?: string,
): Promise<void> {
  if (!password) return;

  await page.goto(`${origin}/password`, { waitUntil: "domcontentloaded", timeout: 20_000 });
  const input = page.locator('input[type="password"]').first();
  if ((await input.count()) === 0) return;

  await input.fill(password);
  const submit = page.locator('button[type="submit"], input[type="submit"]').first();
  await Promise.all([
    page.waitForURL((url) => !/\/password\b/.test(url.pathname), { timeout: 10_000 }).catch(() => null),
    (await submit.count()) > 0 ? submit.click() : input.press("Enter"),
  ]);

  if (/\/password\b/.test(new URL(page.url()).pathname)) {
    throw new Error(
      "The storefront password was rejected. Update it under Settings and run the check again.",
    );
  }
}

/** Real browser navigates to the shop's homepage. */
export async function checkHomeReachable(page: Page, origin: string): Promise<string> {
  let response;
  try {
    response = await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 20_000 });
  } catch (err) {
    throw new Skip(
      `The real browser could not load the homepage: ${err instanceof Error ? err.message : err}`,
    );
  }
  await assertNoChallengeOnPage("the homepage", page, response);
  if (!response?.ok()) {
    throw new Error(`The homepage returned HTTP ${response?.status() ?? "unknown"} in a real browser`);
  }
  return `HTTP ${response.status()} · real Chromium reached the homepage`;
}

export type ProductPageResult = { title: string; variantId: string | null; detail: string };

/**
 * Real browser navigates to the product page, confirms it has a buyable
 * add-to-cart form, and reads two things later steps need: the rendered
 * title (search's term) and the currently-selected variant id (add-to-cart's
 * target) — both read from the page itself, not from Shopify's Admin API.
 */
export async function checkProductPage(page: Page, productUrl: string): Promise<ProductPageResult> {
  let response;
  try {
    response = await page.goto(productUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
  } catch (err) {
    throw new Skip(
      `The real browser could not load the product page: ${err instanceof Error ? err.message : err}`,
    );
  }
  await assertNoChallengeOnPage("the product page", page, response);
  if (!response?.ok()) {
    throw new Error(
      `The product page returned HTTP ${response?.status() ?? "unknown"} in a real browser — the ` +
        "product may be unpublished or removed.",
    );
  }

  const form = page.locator('form[action*="/cart/add"]').first();
  if ((await form.count()) === 0) {
    throw new Error(
      "The product page has no add-to-cart form — a buyer cannot purchase this product as rendered.",
    );
  }

  let title = await page.locator("h1").first().innerText({ timeout: 3000 }).catch(() => "");
  if (!title) {
    title =
      (await page.locator('meta[property="og:title"]').first().getAttribute("content").catch(() => null)) ??
      "";
  }

  // `?variant=` on the URL wins (a real shopper following a variant-specific
  // link); otherwise read whatever the theme's own add-to-cart form already
  // has selected — its `id` field is Shopify's own platform convention.
  let variantId = new URL(page.url()).searchParams.get("variant");
  if (!variantId) {
    const idField = form.locator('[name="id"]').first();
    if ((await idField.count()) > 0) {
      variantId = await idField
        .evaluate((el) => (el as HTMLInputElement | HTMLSelectElement).value || null)
        .catch(() => null);
    }
  }

  return {
    title: title.trim(),
    variantId,
    detail: [
      `HTTP ${response.status()}`,
      "add-to-cart form found",
      variantId ? `variant ${variantId} selected` : "variant not determined from the page",
    ].join(" · "),
  };
}
