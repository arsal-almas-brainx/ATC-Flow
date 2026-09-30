import type { Page } from "playwright";
import { Skip, Warn } from "../shared.server.ts";
import { assertNoChallengeOnPage } from "../browser/challenge.server.ts";

/**
 * Confirms a shopper browsing the store's collections would come across this
 * product.
 *
 * A breadcrumb back to a collection says exactly which collection the product
 * belongs to, so if that collection doesn't list it, that's a real failure.
 *
 * Without a breadcrumb there's no way to know the product's collection, so
 * the check looks where a shopper would: collection links on the product page
 * itself, then the store's menu, then all products — and passes on the first
 * that lists it. Not finding it anywhere is a warning, not proof of a problem:
 * the product may simply not be in any of the collections linked from there.
 * Collection pages are followed up to MAX_PAGES deep.
 */

const MAX_CANDIDATES = 6;
const MAX_PAGES = 3;

const BREADCRUMB =
  'nav[aria-label*="breadcrumb" i] a[href*="/collections/"], .breadcrumb a[href*="/collections/"], ' +
  '[data-breadcrumb] a[href*="/collections/"]';

export async function checkCollectionListing(
  page: Page,
  origin: string,
  productUrl: string,
  handle: string,
): Promise<string> {
  // The session may have moved on to checkout — return to the product page.
  let response;
  try {
    response = await page.goto(productUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  } catch (err) {
    throw new Skip(
      `The real browser could not reload the product page: ${err instanceof Error ? err.message : err}`,
    );
  }
  await assertNoChallengeOnPage("the product page", page, response);

  const breadcrumb = await collectionHandles(page, BREADCRUMB);
  if (breadcrumb.length > 0) {
    const collection = breadcrumb[breadcrumb.length - 1];
    const found = await listsProduct(page, origin, collection, handle);
    if (!found) {
      throw new Error(
        `The product's breadcrumb links to the "${collection}" collection, but that collection ` +
          `doesn't list this product (checked up to ${MAX_PAGES} pages).`,
      );
    }
    return `Listed on its breadcrumb collection "${collection}"`;
  }

  // Product-page links first (outside the header/menu/footer), then the menu.
  const onPage = await collectionHandles(page, 'a[href*="/collections/"]', { outsideMenus: true });
  const inMenu = await collectionHandles(page, 'a[href*="/collections/"]');
  const candidates = [...new Set([...onPage, ...inMenu])]
    .filter((c) => c !== "all")
    .slice(0, MAX_CANDIDATES);

  for (const collection of [...candidates, "all"]) {
    if (await listsProduct(page, origin, collection, handle)) {
      const where =
        collection === "all"
          ? "the store's all-products page"
          : onPage.includes(collection)
            ? `the "${collection}" collection linked from the product page`
            : `the "${collection}" collection in the store's menu`;
      return `Listed on ${where}`;
    }
  }

  throw new Warn(
    `This product page has no breadcrumb, and none of the collections it or the menu link to ` +
      `list the product (checked: ${[...candidates, "all"].join(", ")}). It may just not be in ` +
      `those collections — worth a look if shoppers should find it by browsing.`,
  );
}

/**
 * Collection handles linked by `selector`, in page order, without repeats.
 * `outsideMenus` drops links inside the header, menus and footer.
 */
async function collectionHandles(
  page: Page,
  selector: string,
  { outsideMenus = false } = {},
): Promise<string[]> {
  const hrefs = await page.locator(selector).evaluateAll(
    (els, outside) =>
      els
        .filter((e) => !outside || !e.closest('header, nav, footer, [role="navigation"]'))
        .map((e) => e.getAttribute("href") ?? ""),
    outsideMenus,
  );
  const handles: string[] = [];
  for (const href of hrefs) {
    const m = href.match(/\/collections\/([^/?#]+)/);
    if (m && !handles.includes(m[1])) handles.push(decodeURIComponent(m[1]));
  }
  return handles;
}

/** Whether a collection lists the product on any of its first MAX_PAGES pages. */
async function listsProduct(
  page: Page,
  origin: string,
  collection: string,
  handle: string,
): Promise<boolean> {
  let url: string | null = `${origin}/collections/${encodeURIComponent(collection)}`;
  for (let n = 0; url && n < MAX_PAGES; n++) {
    let response;
    try {
      response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    } catch {
      return false;
    }
    await assertNoChallengeOnPage("the collection page", page, response);
    if (!response?.ok()) return false;
    if ((await page.locator(`a[href*="/products/${handle}"]`).count()) > 0) return true;

    const next = page.locator('a[rel="next"], link[rel="next"]').first();
    const href = (await next.count()) > 0 ? await next.getAttribute("href") : null;
    url = href ? new URL(href, origin).toString() : null;
  }
  return false;
}
