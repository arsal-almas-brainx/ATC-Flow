/**
 * `warn` is a real signal, not a skip: the check ran and found something a
 * buyer would notice, but it is not proof the flow is broken (e.g. no card
 * brands enabled, which is also how a manual-payment-only store looks).
 * `skip` means the check could not run at all.
 */
export type StepStatus = "pending" | "running" | "pass" | "warn" | "fail" | "skip";

export type RunStep = {
  key: string;
  title: string;
  /** Which layer the step exercises — used to group the report. */
  layer: "admin" | "storefront" | "theme" | "checkout";
  status: StepStatus;
  detail?: string;
  durationMs?: number;
};

export type RunStatus = "queued" | "running" | "passed" | "failed";

export type FlowRun = {
  id: string;
  shop: string;
  productUrl: string;
  quantity: number;
  status: RunStatus;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  cartTotal?: string;
  checkoutUrl?: string;
  steps: RunStep[];
};

export type RunOptions = {
  /** The *.myshopify.com domain — both GraphQL endpoints are called on it. */
  shop: string;
  /** Live storefront product URL; its origin is used for the theme HTTP checks. */
  productUrl: string;
  quantity?: number;
  /** Offline Admin API access token for `shop`. Never persisted with the run. */
  adminToken: string;
  /** Only needed while the storefront is password protected. */
  storefrontPassword?: string;
  /**
   * Ship-to country for the shipping-rate probe. Defaults to the shop's own
   * address, falling back to the shop's country.
   */
  country?: string;
  /**
   * Postal code for that country. Shopify will not resolve a rate for the US
   * (among others) without one, so supplying it turns an inconclusive result
   * into a real assertion.
   */
  zip?: string;
};
