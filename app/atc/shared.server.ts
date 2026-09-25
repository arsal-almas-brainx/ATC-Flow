/**
 * Pure, dependency-free primitives shared by the checker orchestrator and the
 * individual check modules under ./checks. No I/O here — just the vocabulary
 * every check is written in.
 */

/**
 * A check that ran and found something worth reporting, but which is not proof
 * the flow is broken. Reported as `warn`; does not fail the run.
 */
export class Warn extends Error {}

/** A check that could not run at all. Reported as `skip`; does not fail. */
export class Skip extends Error {}

export function money(amount: string | number, currency: string) {
  const n = Number(amount);
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}

/** Pulls the product handle out of a storefront product URL. */
export function handleFromUrl(productUrl: string): string {
  const { pathname } = new URL(productUrl);
  const m = pathname.match(/\/products\/([^/?#]+)/);
  if (!m) throw new Error(`Could not read a product handle from ${productUrl}`);
  return decodeURIComponent(m[1]);
}

/** `gid://shopify/ProductVariant/123` → `123`, which is what the theme uses. */
export function numericId(gid: string): string {
  return gid.split("/").pop() ?? gid;
}
