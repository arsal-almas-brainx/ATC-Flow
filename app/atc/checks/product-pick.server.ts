import type { Page } from "playwright";
import { assertNoChallengeOnPage } from "../browser/challenge.server.ts";

/**
 * Picks the product a run tests, the way a shopper would find one: browse the
 * store's best sellers and choose one that is in stock. Falls back to the
 * store's public product list when the theme hides the all-products page.
 * Picked at random from the top few, so repeated runs cover more than one
 * product.
 */

const TOP_N = 8;

export type PickedProduct = { productUrl: string; detail: string };

export async function pickProduct(
  page: Page,
  origin: string,
  pool: string[],
): Promise<PickedProduct> {
  if (pool.length > 0) {
    const productUrl = pool[Math.floor(Math.random() * pool.length)];
    return {
      productUrl,
      detail:
        pool.length === 1
          ? "Using this store's saved product"
          : `Picked at random from ${pool.length} saved products`,
    };
  }

  const fromBestSellers = await bestSellerHandles(page, origin);
  const available = await firstAvailable(page, origin, shuffle(fromBestSellers.slice(0, TOP_N)));
  if (available) {
    return {
      productUrl: `${origin}/products/${available}`,
      detail: `Picked an in-stock product from the store's best sellers (top ${Math.min(TOP_N, fromBestSellers.length)})`,
    };
  }

  const fromCatalog = await catalogAvailableHandles(page, origin);
  if (fromCatalog.length > 0) {
    const handle = fromCatalog[Math.floor(Math.random() * fromCatalog.length)];
    return {
      productUrl: `${origin}/products/${handle}`,
      detail:
        fromBestSellers.length > 0
          ? "None of the best sellers were in stock — picked another in-stock product at random"
          : "The store has no browsable best-sellers page — picked an in-stock product at random",
    };
  }

  throw new Error(
    "Could not find any in-stock product on the storefront to test — neither the best-sellers page " +
      "nor the store's product list returned one.",
  );
}

/** Product handles on the all-products page sorted by best-selling, in page order. */
async function bestSellerHandles(page: Page, origin: string): Promise<string[]> {
  let response;
  try {
    response = await page.goto(`${origin}/collections/all?sort_by=best-selling`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
  } catch {
    return [];
  }
  await assertNoChallengeOnPage("the best-sellers page", page, response);
  if (!response?.ok()) return [];

  const hrefs = await page
    .locator('a[href*="/products/"]:visible')
    .evaluateAll((els) => els.map((e) => (e as HTMLAnchorElement).href));
  const handles: string[] = [];
  for (const href of hrefs) {
    const m = new URL(href).pathname.match(/\/products\/([^/?#]+)/);
    if (m && !handles.includes(m[1])) handles.push(decodeURIComponent(m[1]));
  }
  return handles;
}

/** The first handle whose product has an available variant, via the theme's own `/products/<handle>.js`. */
async function firstAvailable(page: Page, origin: string, handles: string[]): Promise<string | null> {
  for (const handle of handles) {
    const available = await page.evaluate(async (url) => {
      try {
        const res = await fetch(url, { headers: { accept: "application/json" } });
        return res.ok ? Boolean((await res.json()).available) : false;
      } catch {
        return false;
      }
    }, `${origin}/products/${encodeURIComponent(handle)}.js`);
    if (available) return handle;
  }
  return null;
}

/** Handles with at least one available variant, from the storefront's public product list. */
async function catalogAvailableHandles(page: Page, origin: string): Promise<string[]> {
  return page.evaluate(async (url) => {
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (!res.ok) return [];
      const body = (await res.json()) as {
        products?: Array<{ handle: string; variants?: Array<{ available?: boolean }> }>;
      };
      return (body.products ?? [])
        .filter((p) => p.variants?.some((v) => v.available))
        .map((p) => p.handle);
    } catch {
      return [];
    }
  }, `${origin}/products.json?limit=250`);
}

function shuffle<T>(items: T[]): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
