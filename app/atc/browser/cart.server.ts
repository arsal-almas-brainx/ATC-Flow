import type { Page } from "playwright";

/**
 * The theme's own public Ajax Cart endpoint (`/cart.js`) — the same JSON a
 * real cart drawer/page reads from client-side JS. Read via a same-origin
 * `page.evaluate(fetch(...))` rather than a page-out `page.goto`, so it never
 * disturbs whatever page is currently loaded and always reflects the live
 * browser session's actual cart (cookies automatic).
 */
export type CartJson = {
  item_count: number;
  total_price: number;
  currency: string;
  items: Array<{ variant_id: number | string; quantity: number; product_title: string }>;
  cart_level_discount_applications?: Array<{ title: string }>;
};

export async function readCart(page: Page, origin: string): Promise<CartJson | null> {
  return page.evaluate(async (cartUrl) => {
    const res = await fetch(cartUrl, { headers: { accept: "application/json" } });
    return res.ok ? await res.json() : null;
  }, `${origin}/cart.js`);
}
