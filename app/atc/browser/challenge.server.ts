import type { Page, Response } from "playwright";
import { Skip } from "../shared.server.ts";

export const CHALLENGE =
  /verifying your connection|just a moment|checking your browser|__cf_chl|attention required/i;

/**
 * Shopify fronts storefronts with Cloudflare, which answers a request it does
 * not like with an HTML interstitial — under HTTP 429, so the status alone
 * reads as "rate limited" when it really means "you look like a bot." That is
 * the checker being blocked, not the store being broken, so it is reported as
 * a skipped check rather than a failure.
 */
export async function assertNoChallengeOnPage(
  what: string,
  page: Page,
  response: Response | null,
): Promise<void> {
  const status = response?.status() ?? 0;
  if (status !== 403 && status !== 429) {
    const title = await page.title().catch(() => "");
    const body = await page
      .locator("body")
      .innerText({ timeout: 1000 })
      .catch(() => "");
    if (!CHALLENGE.test(title) && !CHALLENGE.test(body)) return;
  }
  throw new Skip(
    `The storefront served a bot challenge for ${what} (HTTP ${status || "unknown"}) to this ` +
      "authorized browser, even with a Web Bot Auth signature attached. The signature may need " +
      "to be re-created in Shopify Admin → Online Store → Preferences → Crawler access.",
  );
}
