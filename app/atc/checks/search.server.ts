import type { Page } from "playwright";
import { Skip, Warn } from "../shared.server.ts";
import { assertNoChallengeOnPage } from "../browser/challenge.server.ts";

/**
 * Types the product's own rendered title into the theme's search (navigating
 * straight to the search results URL, which every theme serves) and confirms
 * a real visitor searching for this product would find it. Empty results are
 * a Warn (likely search-indexing lag), not proof the flow is broken; results
 * that come back without this product is a real finding.
 */
export async function checkSearchResults(
  page: Page,
  origin: string,
  productTitle: string,
  handle: string,
): Promise<string> {
  const term = productTitle.replace(/["':]/g, "").trim().slice(0, 60);
  if (!term) {
    throw new Skip("No usable product title was read from the page, so a search term could not be derived.");
  }

  let response;
  try {
    response = await page.goto(`${origin}/search?q=${encodeURIComponent(term)}&type=product`, {
      waitUntil: "domcontentloaded",
      timeout: 20_000,
    });
  } catch (err) {
    throw new Skip(
      `The real browser could not load search results: ${err instanceof Error ? err.message : err}`,
    );
  }
  await assertNoChallengeOnPage("the search results page", page, response);
  if (!response?.ok()) {
    throw new Error(`Search returned HTTP ${response?.status() ?? "unknown"} in a real browser`);
  }

  const matched = await page.locator(`a[href*="/products/${handle}"]`).count();
  if (matched > 0) {
    return `Search for "${term}" found a link to this product among the results`;
  }

  const anyResults = await page.locator('a[href*="/products/"]').count();
  if (anyResults === 0) {
    throw new Warn(
      `Search for "${term}" returned no product results at all — likely search-indexing lag rather ` +
        "than a broken flow.",
    );
  }
  throw new Error(`Search for "${term}" returned results, but none link to this product.`);
}
