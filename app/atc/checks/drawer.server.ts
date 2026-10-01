import type { Locator, Page } from "playwright";
import { Skip } from "../shared.server.ts";
import { readCart } from "../browser/cart.server.ts";
import { MINUS, PLUS, waitForItemCount } from "./cart.server.ts";

/**
 * Most stores show the cart in a drawer (or a small popup) rather than
 * sending shoppers to the cart page. Right after Add to cart this checks the
 * drawer the way a shopper meets it: it opens — by itself, or from the
 * header's cart icon — and shows the item just added. If the drawer has
 * + / − buttons, the quantity is changed up and back down, each confirmed
 * against /cart.js. A theme that uses the cart page instead is skipped; the
 * cart page has its own steps.
 */

const DRAWER =
  'cart-drawer, cart-notification, #CartDrawer, [id*="cart-drawer" i], [class*="cart-drawer" i], ' +
  '[id*="cart-notification" i], [class*="cart-notification" i], [role="dialog"], dialog[open], ' +
  '[aria-modal="true"], [id*="mini-cart" i], [class*="mini-cart" i], [class*="minicart" i], ' +
  '[id*="side-cart" i], [class*="side-cart" i]';

const CART_ICON =
  'header a[href$="/cart"], header a[href*="/cart?"], header button[aria-label*="cart" i], ' +
  'header [aria-controls*="cart" i], a[href$="/cart"][aria-label*="cart" i]';

const MARK = "data-atc-drawer";

export async function checkCartDrawer(
  page: Page,
  origin: string,
  productTitle: string,
  handle: string,
): Promise<string> {
  let drawer = await waitForDrawer(page, 4000);
  let how = "opened by itself after Add to cart";

  if (!drawer) {
    const icon = page.locator(CART_ICON).filter({ visible: true }).first();
    if ((await icon.count()) === 0) {
      throw new Skip("No cart drawer opened after Add to cart, and there's no cart icon in the header to open one.");
    }
    await icon.click({ timeout: 8000 }).catch(() => {});
    await page.waitForLoadState("domcontentloaded").catch(() => {});
    if (/\/cart\/?$/.test(new URL(page.url()).pathname)) {
      throw new Skip("This theme opens the cart page rather than a drawer — the cart page is checked next.");
    }
    drawer = await waitForDrawer(page, 4000);
    how = "opened from the header's cart icon";
    if (!drawer) {
      throw new Skip(
        "No cart drawer or popup appeared, either after Add to cart or from the cart icon — this theme may only update the cart count.",
      );
    }
  }

  const text = (await drawer.innerText().catch(() => "")).toLowerCase();
  const titleBit = productTitle.toLowerCase().slice(0, 25).trim();
  const showsItem =
    (titleBit && text.includes(titleBit)) ||
    (await drawer.locator(`a[href*="/products/${handle}"]`).count()) > 0;
  if (!showsItem) {
    throw new Error(`The cart drawer ${how}, but it doesn't show "${productTitle || handle}".`);
  }

  const parts = [`Cart drawer ${how} and shows "${productTitle || handle}"`];
  if ((await drawer.locator(PLUS).count()) > 0 && (await drawer.locator(MINUS).count()) > 0) {
    const start = (await readCart(page, origin))?.item_count ?? 0;
    for (const [selector, target, word] of [
      [PLUS, start + 1, "Increasing"],
      [MINUS, start, "Decreasing"],
    ] as const) {
      // Many drawers redraw themselves after each change, replacing the
      // element found earlier — find the drawer again before every press.
      const current = (await waitForDrawer(page, 4000)) ?? drawer;
      await current.locator(selector).first().click({ timeout: 10_000 });
      const reached = await waitForItemCount(page, origin, target, 8000);
      // The drawer re-renders after the cart updates; let it settle before the next press.
      await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(500);
      if (reached == null) {
        const now = (await readCart(page, origin))?.item_count ?? "unknown";
        throw new Error(
          `${word} the quantity in the cart drawer didn't update the cart within 8s (expected ${target}, cart shows ${now}).`,
        );
      }
    }
    parts.push(`quantity ${start} → ${start + 1} → ${start} in the drawer`);
  }
  const latest = (await waitForDrawer(page, 2000)) ?? drawer;
  const checkout = latest
    .locator('a[href*="/checkout"], [name="checkout"]')
    .or(latest.getByRole("button", { name: /check ?out/i }))
    .or(latest.getByRole("link", { name: /check ?out/i }));
  parts.push((await checkout.count()) > 0 ? "checkout button present" : "no checkout button in the drawer");

  await page.keyboard.press("Escape").catch(() => {});
  return parts.join(" · ");
}

/**
 * The open cart drawer: the largest visible drawer-like element that holds
 * cart content. Marked with a data attribute so it can be used as a locator.
 */
async function waitForDrawer(page: Page, timeoutMs: number): Promise<Locator | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await page
      .evaluate(
        ({ selector, mark }) => {
          document.querySelectorAll(`[${mark}]`).forEach((e) => e.removeAttribute(mark));
          const visible = (e: Element) => {
            const r = e.getBoundingClientRect();
            const cs = getComputedStyle(e);
            return (
              r.width > 150 && r.height > 100 && r.right > 0 && r.left < innerWidth &&
              r.bottom > 0 && r.top < innerHeight && cs.visibility !== "hidden" &&
              cs.display !== "none" && Number(cs.opacity) > 0.1
            );
          };
          const holdsCart = (e: Element) =>
            Boolean(e.querySelector('a[href*="/products/"], a[href*="/checkout"], [name="checkout"], form[action*="/cart"]'));
          const candidates = [...document.querySelectorAll(selector)].filter(
            (e) => visible(e) && holdsCart(e),
          );
          if (candidates.length === 0) return false;
          // The outermost match is the drawer itself, not a section inside it.
          const drawer = candidates.find((e) => !candidates.some((o) => o !== e && o.contains(e)));
          drawer?.setAttribute(mark, "");
          return Boolean(drawer);
        },
        { selector: DRAWER, mark: MARK },
      )
      .catch(() => false);
    if (found) return page.locator(`[${MARK}]`).first();
    await page.waitForTimeout(300);
  }
  return null;
}
