import type { FlowRun, RunOptions, RunStep, StepStatus } from "./types";
import { Skip, Warn, handleFromUrl } from "./shared.server.ts";
import { runWithBrowserSession } from "./browser/launch.server.ts";
import { installWebBotAuthHeaders } from "./browser/web-bot-auth.server.ts";
import {
  unlockPasswordIfNeeded,
  checkHomeReachable,
  checkProductPage,
} from "./checks/storefront.server.ts";
import { checkSearchResults } from "./checks/search.server.ts";
import {
  checkProductQuantity,
  checkAddToCart,
  checkCartPage,
  checkCartQuantityUpdate,
  checkCartDiscount,
} from "./checks/cart.server.ts";
import { checkCheckoutReached } from "./checks/checkout.server.ts";
import { checkCollectionListing } from "./checks/collection.server.ts";
import { saveScreenshot } from "./browser/screenshots.server.ts";
import { pickProduct } from "./checks/product-pick.server.ts";

/**
 * Real-browser storefront checker. No API calls of any kind — every check is
 * a real, Web-Bot-Auth-authorized Chromium browser doing what a QA person
 * would do by hand: load the homepage, load the product page, search for it,
 * click the real Add-to-cart button, look at the cart, change its quantity,
 * apply a discount, click through to checkout, and check it's listed on a
 * collection. One shopper, one continuous session, start to finish.
 *
 * The reasoning for this over asking Shopify's Admin/Storefront APIs
 * questions: if Shopify's own backend is broken, Shopify's own status page
 * already says so. This app's job is catching what only using the live site
 * for real would catch — a broken button, a page that silently fails to
 * load, checkout quietly breaking.
 *
 * `home-reachable`, `product-pick`, `product-page` and `add-to-cart` are true prerequisites —
 * each genuinely can't be judged without the one before it succeeding, so a
 * failure there aborts the run (matching a real shopper: if the site is
 * down, nothing else can be tried). Everything after that is judged
 * independently via `stepIsolated`: a stumble on the cart page shouldn't
 * stop the discount code or checkout from being tried, and vice versa.
 *
 * No order is ever placed. Checkout is only ever reached, never completed.
 */

const STEP_PLAN: Array<[key: string, title: string, layer: RunStep["layer"]]> = [
  ["home-reachable", "Homepage loads for a real visitor", "storefront"],
  ["product-pick", "Finds an in-stock product to test", "discovery"],
  ["product-page", "Product page loads with a buyable variant", "storefront"],
  ["search-results", "Search finds the product", "discovery"],
  ["product-quantity", "Product page quantity selector works", "cart"],
  ["add-to-cart", "The real Add-to-cart button works", "cart"],
  ["cart-page", "Cart page shows the added item", "cart"],
  ["cart-quantity-update", "Cart quantity can be increased and decreased", "cart"],
  ["cart-discount", "Discount code applies correctly", "cart"],
  ["checkout-reached", "Checkout is reached", "checkout"],
  ["collection-listing", "Product is listed on a collection it links to", "discovery"],
];

export const NOT_REACHED = "Not reached — an earlier check failed.";

export function blankRun(id: string, opts: RunOptions): FlowRun {
  return {
    id,
    storeId: opts.storeId,
    productUrl: opts.productUrl ?? "",
    device: opts.device ?? "desktop",
    groupId: opts.groupId,
    quantity: opts.quantity ?? 1,
    status: "queued",
    startedAt: Date.now(),
    steps: STEP_PLAN.map(([key, title, layer]) => ({
      key,
      title,
      layer,
      status: "pending" as StepStatus,
    })),
  };
}

export async function runCheck(
  run: FlowRun,
  opts: RunOptions,
  onUpdate: (run: FlowRun) => void,
): Promise<FlowRun> {
  const quantity = opts.quantity ?? 1;
  const origin = new URL(opts.storeUrl).origin;
  // Set by the product-pick step, before anything uses them.
  let productUrl = "";
  let handle = "";

  const webBotAuth =
    opts.webBotAuthSignature && opts.webBotAuthSignatureInput
      ? { signature: opts.webBotAuthSignature, signatureInput: opts.webBotAuthSignatureInput }
      : null;

  // Nothing here can run at all without a Web Bot Auth signature — mark the
  // whole run skipped up front instead of repeating the same explanation on
  // eleven separate steps.
  if (!webBotAuth) {
    run.status = "skipped";
    run.error =
      "No Web Bot Auth signature is configured for this store. Create one in the store's Shopify Admin → " +
      "Online Store → Preferences → Crawler access, then save it in this store's settings.";
    for (const s of run.steps) {
      s.status = "skip";
      s.detail = "Not run — Web Bot Auth is not configured for this store.";
    }
    run.finishedAt = Date.now();
    onUpdate(run);
    return run;
  }

  run.status = "running";
  // A mobile run waits in the queue behind desktop; time it from when it actually starts.
  run.startedAt = Date.now();
  onUpdate(run);

  // Every check after the true prerequisite chain (home/product/add-to-cart)
  // is independent of the others — a broken cart-quantity stepper has
  // nothing to do with whether a discount code applies or checkout is
  // reached, so one failing must not skip the rest. `stepIsolated` still
  // records its own step's real pass/fail/warn/skip via `step`, it just
  // doesn't let a plain Error abort the run.
  let hardFailed = false;
  let firstHardFailure: string | undefined;

  try {
    await runWithBrowserSession(async (page) => {
      // Authorize both the storefront's own origin and Shopify's central
      // checkout host — checkout very often lives on a different origin
      // than the storefront, and registering both up front is harmless if
      // the second one turns out not to be needed.
      await installWebBotAuthHeaders(page.context(), origin, webBotAuth);
      await installWebBotAuthHeaders(page.context(), "https://checkout.shopify.com", webBotAuth);

      /**
       * Runs one step. A thrown Error fails the run; Warn and Skip are
       * recorded on the step and execution continues, because neither means
       * the flow is broken. Defined here (not at `runCheck`'s top level) so
       * it closes over `page` — every step gets a real screenshot of
       * whatever the browser was looking at once it settles, pass or fail,
       * as diagnostic evidence alongside the text result.
       */
      const step = async (key: string, fn: () => Promise<string | void>) => {
        const s = run.steps.find((x: RunStep) => x.key === key)!;
        s.status = "running";
        onUpdate(run);
        const t0 = Date.now();
        try {
          const detail = await fn();
          s.status = "pass";
          if (detail) s.detail = detail;
        } catch (err) {
          if (err instanceof Warn || err instanceof Skip) {
            s.status = err instanceof Warn ? "warn" : "skip";
            s.detail = err.message;
            return;
          }
          s.status = "fail";
          s.detail = err instanceof Error ? err.message : String(err);
          throw err;
        } finally {
          s.durationMs = Date.now() - t0;
          try {
            const buf = await page.screenshot({ type: "jpeg", quality: 70, timeout: 5000 });
            s.screenshotPath = await saveScreenshot(opts.storeId, run.id, key, buf);
          } catch {
            // Best-effort only — a screenshot failure must never fail the step itself.
          }
          onUpdate(run);
        }
      };

      const stepIsolated = async (key: string, fn: () => Promise<string | void>) => {
        try {
          await step(key, fn);
        } catch (err) {
          hardFailed = true;
          firstHardFailure ??= err instanceof Error ? err.message : String(err);
        }
      };

      await unlockPasswordIfNeeded(page, origin, opts.storefrontPassword);

      let productTitle = "";
      let variantId: string | null = null;

      await step("home-reachable", () => checkHomeReachable(page, origin));

      await step("product-pick", async () => {
        const picked = opts.productUrl
          ? { productUrl: opts.productUrl, detail: opts.productNote ?? "Using the product chosen for this run" }
          : await pickProduct(page, origin, opts.productPool ?? []);
        productUrl = picked.productUrl;
        handle = handleFromUrl(productUrl);
        run.productUrl = productUrl;
        return `${picked.detail}: /products/${handle}`;
      });

      await step("product-page", async () => {
        const result = await checkProductPage(page, productUrl);
        productTitle = result.title;
        variantId = result.variantId;
        return result.detail;
      });

      await stepIsolated("search-results", () =>
        checkSearchResults(page, origin, productTitle, handle, opts.searchQuery),
      );

      await stepIsolated("product-quantity", () =>
        checkProductQuantity(page, productUrl, quantity),
      );

      await step("add-to-cart", () =>
        checkAddToCart(page, origin, productUrl, variantId, productTitle || handle, quantity),
      );

      await stepIsolated("cart-page", async () => {
        const result = await checkCartPage(page, origin);
        if (result.cartTotal) run.cartTotal = result.cartTotal;
        return result.detail;
      });

      await stepIsolated("cart-quantity-update", () => checkCartQuantityUpdate(page, origin));

      await stepIsolated("cart-discount", async () => {
        if (!opts.discountCode) throw new Skip("No discount code supplied.");
        const result = await checkCartDiscount(page, origin, opts.discountCode);
        run.cartTotal = result.cartTotal;
        return result.detail;
      });

      await stepIsolated("checkout-reached", async () => {
        const result = await checkCheckoutReached(page, origin);
        if (result.checkoutUrl) run.checkoutUrl = result.checkoutUrl;
        return result.detail;
      });

      await stepIsolated("collection-listing", () =>
        checkCollectionListing(page, origin, productUrl, handle),
      );
    }, opts.device);

    // hardFailed means an isolated step failed — every step still ran, so
    // nothing here needs to be marked skip, but the run as a whole did find
    // a real problem.
    run.status = hardFailed ? "failed" : "passed";
    if (hardFailed) run.error = firstHardFailure;
  } catch (err) {
    run.status = "failed";
    run.error = err instanceof Error ? err.message : String(err);
    for (const s of run.steps) {
      if (s.status === "pending") {
        s.status = "skip";
        s.detail = NOT_REACHED;
      }
    }
  } finally {
    run.finishedAt = Date.now();
    onUpdate(run);
  }

  return run;
}
