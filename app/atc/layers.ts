import type { RunStep } from "./types";

/**
 * Display metadata for grouping steps by the stage of the buyer journey they
 * belong to. Plain client-safe data — not `.server.ts` — kept alongside the
 * business-logic module it describes rather than inline in a route file.
 */
export type LayerInfo = {
  key: RunStep["layer"];
  title: string;
  blurb: string;
};

export const LAYERS: LayerInfo[] = [
  {
    key: "storefront",
    title: "Storefront",
    blurb: "Can a real visitor reach your homepage and product page?",
  },
  {
    key: "discovery",
    title: "Discovery",
    blurb: "Can a real visitor find this product through search or browsing?",
  },
  {
    key: "cart",
    title: "Cart",
    blurb: "Does adding to cart, changing quantity, and applying a discount actually work?",
  },
  {
    key: "checkout",
    title: "Checkout",
    blurb:
      "Does checkout get reached? Shopify protects checkout itself too heavily for this to check further.",
  },
];
