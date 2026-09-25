/**
 * `warn` is a real signal, not a skip: the check ran and found something a
 * buyer would notice, but it is not proof the flow is broken. `skip` means
 * the check could not run at all (a prerequisite step didn't succeed, or
 * nothing to test against, e.g. no discount code supplied).
 */
export type StepStatus = "pending" | "running" | "pass" | "warn" | "fail" | "skip";

export type RunStep = {
  key: string;
  title: string;
  /** Which stage of the buyer journey the step belongs to — used to group the report. */
  layer: "storefront" | "discovery" | "cart" | "checkout";
  status: StepStatus;
  detail?: string;
  durationMs?: number;
  /** Filesystem path to a viewport screenshot taken right after this step settled. */
  screenshotPath?: string;
};

/**
 * `skipped` is distinct from `failed`: it means nothing could be tested at
 * all (no Web Bot Auth signature configured), not that a real problem was
 * found.
 */
export type RunStatus = "queued" | "running" | "passed" | "failed" | "skipped";

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
  /** The *.myshopify.com domain — used to scope stored settings and the run record. */
  shop: string;
  /** Live storefront product URL the real browser navigates to. */
  productUrl: string;
  quantity?: number;
  /** Only needed while the storefront is password protected. */
  storefrontPassword?: string;
  /**
   * Discount code to apply to the real cart. Optional — we can't invent a
   * valid code, so the discount check is skipped (not failed) when omitted.
   */
  discountCode?: string;
  /**
   * Web Bot Auth credentials (Shopify Admin → Online Store → Preferences →
   * Crawler access) — what gets every check past Cloudflare's bot challenge
   * on the storefront (and, best-effort, on checkout). Not checked for
   * expiry here — the caller resolves an already-valid pair or omits both,
   * in which case the whole run is skipped.
   */
  webBotAuthSignature?: string;
  webBotAuthSignatureInput?: string;
};
