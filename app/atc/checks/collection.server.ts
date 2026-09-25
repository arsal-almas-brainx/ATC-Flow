import type { Page } from "playwright";
import { Skip } from "../shared.server.ts";
import { assertNoChallengeOnPage } from "../browser/challenge.server.ts";

/**
 * Looks for a breadcrumb/back-to-collection link on the product page (the
 * only way a real shopper could discover which collection this product
 * belongs to — there is no API call here) and confirms the collection page
 * actually lists it. A product whose theme exposes no such link is Skipped,
 * not failed: a real shopper couldn't browse there either.
 */
export async function checkCollectionListing(
  page: Page,
  origin: string,
  productUrl: string,
  handle: string,
): Promise<string> {
  // The session may have moved on to checkout — return to the product page.
  let response;
  try {
    response = await page.goto(productUrl, { waitUntil: "domcontentloaded", timeout: 20_000 });
  } catch (err) {
    throw new Skip(
      `The real browser could not reload the product page: ${err instanceof Error ? err.message : err}`,
    );
  }
  await assertNoChallengeOnPage("the product page", page, response);

  const breadcrumbLink = page
    .locator(
      'nav[aria-label*="breadcrumb" i] a[href*="/collections/"], .breadcrumb a[href*="/collections/"], ' +
        '[data-breadcrumb] a[href*="/collections/"]',
    )
    .first();
  const anyCollectionLink = page.locator('a[href^="/collections/"]').first();
  const link = (await breadcrumbLink.count()) > 0 ? breadcrumbLink : anyCollectionLink;

  if ((await link.count()) === 0) {
    throw new Skip(
      "This product's page exposes no discoverable link back to a collection, so the browse path " +
        "can't be tested.",
    );
  }

  const href = await link.getAttribute("href");
  const match = href?.match(/\/collections\/([^/?#]+)/);
  if (!match) {
    throw new Skip("Found a collection-looking link, but couldn't read a collection handle from it.");
  }
  const collectionHandle = match[1];

  let collectionResponse;
  try {
    collectionResponse = await page.goto(`${origin}/collections/${collectionHandle}`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
  } catch (err) {
    throw new Skip(
      `The real browser could not load the collection page: ${err instanceof Error ? err.message : err}`,
    );
  }
  await assertNoChallengeOnPage("the collection page", page, collectionResponse);
  if (!collectionResponse?.ok()) {
    throw new Error(
      `The collection page returned HTTP ${collectionResponse?.status() ?? "unknown"} in a real browser`,
    );
  }

  const tile = await page.locator(`a[href*="/products/${handle}"]`).count();
  if (tile === 0) {
    throw new Error(`"${collectionHandle}" collection page loaded, but no tile links back to this product.`);
  }

  return `Listed on collection "${collectionHandle}"`;
}
