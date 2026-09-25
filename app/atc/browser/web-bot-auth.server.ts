import type { BrowserContext } from "playwright";

/**
 * Attaches a Shopify Web Bot Auth signature to requests a browser context
 * makes to the shop's own origin, so Cloudflare's bot protection recognizes
 * this run as an authorized tool instead of challenging it.
 *
 * Scoped to the shop's origin only, via a routed URL glob — never
 * `setExtraHTTPHeaders()` on the whole context — so third-party requests the
 * theme's own JS fires (analytics, payment SDKs, fonts) never see the
 * credential. Shopify's docs: https://help.shopify.com/en/manual/promoting-marketing/seo/crawling-your-store
 */

// Per Shopify's docs, this header's value is an HTTP Structured Field String
// (RFC 8941) — the literal double quotes are part of the transmitted value,
// not JS string delimiters. Sending it without them is a real, silent
// mismatch: Shopify's own copy is explicit that a merchant does not generate
// this value themselves, so it is not a stored/configurable credential.
export const WEB_BOT_AUTH_AGENT = '"https://shopify.com"';

export type WebBotAuthCredentials = { signature: string; signatureInput: string };

export async function installWebBotAuthHeaders(
  context: BrowserContext,
  origin: string,
  creds: WebBotAuthCredentials,
): Promise<void> {
  await context.route(`${origin}/**`, async (route) => {
    await route.continue({
      headers: {
        ...route.request().headers(),
        Signature: creds.signature,
        "Signature-Input": creds.signatureInput,
        "Signature-Agent": WEB_BOT_AUTH_AGENT,
      },
    });
  });
}
