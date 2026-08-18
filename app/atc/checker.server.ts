import type { FlowRun, RunOptions, RunStep, StepStatus } from "./types";

/**
 * API-based add-to-cart → checkout checker.
 *
 * There is no browser here. An earlier version drove the storefront with
 * Playwright, which does not work: Shopify fronts storefronts with Cloudflare,
 * Cloudflare fingerprints an automated browser, and the run gets a "Verifying
 * your connection..." interstitial under HTTP 429 instead of the page. Plain
 * HTTP requests are *not* challenged, so every layer a browser was there to
 * reach is reachable without one:
 *
 *   admin      — Admin GraphQL API, with the app's own offline access token.
 *                The authoritative view of product status, price and inventory.
 *   storefront  — Storefront GraphQL API (Cart API). This is the same cart
 *                engine the theme's Add-to-cart button ends up talking to, so
 *                building a cart here proves the buyer-facing path.
 *   theme      — plain HTTP to the storefront: the product page and the Ajax
 *                Cart API (/cart/add.js, /cart.js) that the theme's button
 *                actually calls. Covers the theme layer without a browser.
 *   checkout   — checkout readiness: shipping rates for a real address,
 *                payment methods, and the issued checkout URL.
 *
 * No order is ever placed. Carts are created and abandoned; Shopify expires
 * them on its own.
 */

const ADMIN_API_VERSION = "2025-10";
const STOREFRONT_API_VERSION = "2025-10";

/**
 * Node's fetch sends `user-agent: node`. The GraphQL endpoints do not care, but
 * the storefront and checkout do — checkout is the most bot-protected surface
 * Shopify has and answers a bare Node UA with 403.
 */
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/141.0.0.0 Safari/537.36";

const STEP_PLAN: Array<[key: string, title: string, layer: RunStep["layer"]]> = [
  ["shop-config", "Store is reachable & configured", "admin"],
  ["storefront-token", "Storefront API access", "admin"],
  ["product-admin", "Product status, price & inventory", "admin"],
  ["product-published", "Product is live on the online store", "storefront"],
  ["cart-create", "Cart API accepts the variant", "storefront"],
  ["cart-verify", "Cart has the right variant, quantity & price", "storefront"],
  ["cart-update", "Cart quantity can be changed", "storefront"],
  ["theme-product-page", "Product page loads with an Add-to-cart form", "theme"],
  ["theme-ajax-add", "Theme Add to cart works (/cart/add.js)", "theme"],
  ["shipping-rates", "Shipping rates exist for a delivery address", "checkout"],
  ["payment-methods", "A buyer has a way to pay", "checkout"],
  ["checkout-url", "Checkout is issued for the cart", "checkout"],
  ["checkout-reachable", "Checkout page responds", "checkout"],
];

export function blankRun(id: string, opts: RunOptions): FlowRun {
  return {
    id,
    shop: opts.shop,
    productUrl: opts.productUrl,
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

// ---------------------------------------------------------------- step outcomes

/**
 * A check that ran and found something worth reporting, but which is not proof
 * the flow is broken. Reported as `warn`; does not fail the run.
 */
class Warn extends Error {}

/** A check that could not run at all. Reported as `skip`; does not fail. */
class Skip extends Error {}

// ------------------------------------------------------------------- transport

/**
 * GraphQL response payloads are shaped by the query, not by a schema this app
 * generates types from, so they are read as untyped JSON. Named once here so the
 * escape hatch is declared in a single place.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

type Gql = { data?: Json; errors?: Array<{ message: string }> };

/**
 * Shopify reports a field-level error once per offending node, so a product
 * with 50 variants can produce 50 identical messages. Collapse them so the
 * failure reason stays readable.
 */
function uniqueMessages(errors: Array<{ message: string }>): string {
  return [...new Set(errors.map((e) => e.message))].join("; ");
}

function userErrors(list: Array<{ message: string }> | undefined | null): string | null {
  return list?.length ? uniqueMessages(list) : null;
}

async function adminGraphql(
  shop: string,
  adminToken: string,
  query: string,
  variables?: object,
): Promise<Json> {
  const res = await fetch(`https://${shop}/admin/api/${ADMIN_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": adminToken },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401) {
    throw new Error(
      "The Admin API rejected the app's access token. Re-open the app from Shopify Admin to " +
        "refresh the session, then run the check again.",
    );
  }
  const text = await res.text();
  let body: Gql;
  try {
    body = JSON.parse(text) as Gql;
  } catch {
    throw new Error(`Admin API returned HTTP ${res.status}, not JSON: ${text.slice(0, 160)}`);
  }
  if (body.errors?.length) throw new Error(uniqueMessages(body.errors));
  return body.data;
}

async function storefrontGraphql(
  shop: string,
  token: string,
  query: string,
  variables?: object,
): Promise<Json> {
  const res = await fetch(`https://${shop}/api/${STOREFRONT_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Storefront-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      `The Storefront API rejected the token (HTTP ${res.status}). Re-open the app in Shopify ` +
        "Admin and approve the permissions, then run the check again.",
    );
  }
  if (res.status === 429 || res.status === 430) {
    throw new Error(`Storefront API throttled the request (HTTP ${res.status}) — retry shortly`);
  }
  let body: Gql;
  try {
    body = JSON.parse(text) as Gql;
  } catch {
    throw new Error(
      `Storefront API returned HTTP ${res.status} as ${
        res.headers.get("content-type") || "an unknown type"
      } instead of JSON: ${text.slice(0, 140)}`,
    );
  }
  if (body.errors?.length) throw new Error(uniqueMessages(body.errors));
  return body.data;
}

/**
 * Mints a Storefront API access token through the Admin API.
 *
 * Deliberately takes the admin token as an argument and returns the new one
 * rather than touching the database: this module has to be importable from
 * plain Node (scripts/atc-check.mjs) as well as from the app, and the app's
 * db.server import is extensionless — Vite resolves that, Node does not. So
 * every relative import here is type-only, and callers own the caching.
 */
export async function mintStorefrontToken(shop: string, adminToken: string): Promise<string> {
  const data = await adminGraphql(
    shop,
    adminToken,
    `mutation StorefrontTokenCreate {
      storefrontAccessTokenCreate(input: { title: "ATC Flow checker" }) {
        storefrontAccessToken { accessToken }
        userErrors { field message }
      }
    }`,
  ).catch((err: Error) => {
    if (/access denied/i.test(err.message)) {
      throw new Error(
        "The app is not allowed to create a Storefront API token. Deploy the current access " +
          "scopes and re-open the app in Shopify Admin to approve them.",
      );
    }
    throw err;
  });

  const bad = userErrors(data?.storefrontAccessTokenCreate?.userErrors);
  if (bad) throw new Error(bad);
  const token: string | undefined =
    data?.storefrontAccessTokenCreate?.storefrontAccessToken?.accessToken;
  if (!token) throw new Error("Shopify returned no Storefront API token");
  return token;
}

// ------------------------------------------------------------------- HTTP layer

/**
 * fetch() with a cookie jar that survives redirects.
 *
 * Node's fetch has no jar: with redirect "follow" it drops any cookie set by an
 * intermediate hop. Three things here depend on cookies crossing hops — the
 * storefront password unlock, the Ajax cart session, and the checkout
 * permalink (/cart/c/<token> sets a session cookie and *then* redirects to
 * /checkouts/cn/<id>, which answers 403 without it).
 */
class Jar {
  private cookies = new Map<string, string>();

  absorb(res: Response) {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const pair = c.split(";")[0];
      const i = pair.indexOf("=");
      if (i > 0) this.cookies.set(pair.slice(0, i).trim(), pair.slice(i + 1).trim());
    }
  }

  header(): Record<string, string> {
    if (!this.cookies.size) return {};
    return { cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ") };
  }

  /**
   * Follows redirects by hand so every hop's cookies are kept.
   *
   * `follow: false` stops at the first response. The password unlock uses it:
   * all it needs is the cookie the 302 sets, and chasing the redirect to `/`
   * would both cost a request and make a rate-limited home page look like a
   * rejected password.
   */
  async fetch(
    url: string,
    init: RequestInit & { headers?: Record<string, string>; follow?: boolean } = {},
    maxHops = 10,
  ): Promise<{ res: Response; body: string; finalUrl: string }> {
    const { follow = true, ...rest } = init;
    let current = url;
    let method = init.method ?? "GET";
    let body = init.body;

    for (let hop = 0; hop < maxHops; hop++) {
      const res = await fetch(current, {
        ...rest,
        method,
        body,
        redirect: "manual",
        headers: { "user-agent": BROWSER_UA, ...init.headers, ...this.header() },
      });
      this.absorb(res);
      const loc = res.headers.get("location");
      if (follow && res.status >= 300 && res.status < 400 && loc) {
        current = new URL(loc, current).toString();
        // A redirect after a POST is followed as a GET, as browsers do.
        method = "GET";
        body = undefined;
        continue;
      }
      return { res, body: await res.text(), finalUrl: current };
    }
    throw new Error(`Too many redirects starting at ${url}`);
  }
}

const CHALLENGE = /verifying your connection|just a moment|checking your browser|__cf_chl|attention required/i;

/**
 * Shopify fronts storefronts with Cloudflare, which answers a request it does
 * not like with an HTML interstitial — under HTTP 429, so the status alone
 * reads as "rate limited" when it really means "you look like a bot". That is
 * the checker being blocked, not the store being broken, so it is reported as a
 * skipped check rather than a failure.
 */
function assertNoChallenge(what: string, r: { res: Response; body: string }): void {
  if (r.res.status !== 429 && !CHALLENGE.test(r.body)) return;
  throw new Skip(
    `The storefront served a bot challenge for ${what} (HTTP ${r.res.status}) instead of a ` +
      "response, so this check could not run. That is the checker being rate-limited, not the " +
      "store — the Cart API checks cover the same buyer path. Waiting a minute usually clears it.",
  );
}

/** Pulls the product handle out of a storefront product URL. */
export function handleFromUrl(productUrl: string): string {
  const { pathname } = new URL(productUrl);
  const m = pathname.match(/\/products\/([^/?#]+)/);
  if (!m) throw new Error(`Could not read a product handle from ${productUrl}`);
  return decodeURIComponent(m[1]);
}

/** `gid://shopify/ProductVariant/123` → `123`, which is what the theme uses. */
function numericId(gid: string): string {
  return gid.split("/").pop() ?? gid;
}

function money(amount: string | number, currency: string) {
  const n = Number(amount);
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}

// ------------------------------------------------------------------ the checker

export async function runCheck(
  run: FlowRun,
  opts: RunOptions,
  /** Resolves a Storefront API token; the caller decides how it is cached. */
  getToken: () => Promise<string>,
  onUpdate: (run: FlowRun) => void,
): Promise<FlowRun> {
  const quantity = opts.quantity ?? 1;
  const origin = new URL(opts.productUrl).origin;
  const handle = handleFromUrl(opts.productUrl);

  const admin = (q: string, v?: object) => adminGraphql(opts.shop, opts.adminToken, q, v);

  run.status = "running";
  onUpdate(run);

  /**
   * Runs one step. A thrown Error fails the run; Warn and Skip are recorded on
   * the step and execution continues, because neither means the flow is broken.
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
      onUpdate(run);
    }
  };

  // Shared state between steps.
  let token = "";
  let shopCountry = opts.country;
  let shopAddress: Json = null;
  let shopPlan: Json = null;
  let variantGid = "";
  let variantTitle = "";
  let unitPrice = 0;
  let requiresShipping = true;
  let cartId = "";
  let checkoutUrl = "";
  let createdCart: Json = null;
  let cartCurrency = "";
  let cartSubtotal = 0;
  const jar = new Jar();

  const sf = (q: string, v?: object) => storefrontGraphql(opts.shop, token, q, v);

  try {
    // ---------------------------------------------------------------- admin
    await step("shop-config", async () => {
      const data = await admin(`query ShopConfig {
        shop {
          name currencyCode
          primaryDomain { host sslEnabled }
          plan { displayName partnerDevelopment }
          billingAddress { address1 city provinceCode countryCodeV2 zip }
        }
      }`);
      const shop = data?.shop;
      if (!shop) throw new Error("Admin API returned no shop");
      if (!shop.primaryDomain?.sslEnabled) {
        throw new Error(`SSL is not active on ${shop.primaryDomain?.host} — checkout will fail`);
      }
      shopAddress = shop.billingAddress ?? null;
      shopPlan = shop.plan ?? null;
      const domain: string = shop.primaryDomain.host;
      // A product URL on a different host than the primary domain still works,
      // but the cart cookie lives per-origin, so it is worth flagging.
      const note =
        new URL(opts.productUrl).host !== domain
          ? ` · note: testing ${new URL(opts.productUrl).host}, primary domain is ${domain}`
          : "";
      const plan = shopPlan?.displayName ? ` · ${shopPlan.displayName}` : "";
      return `${shop.name} · ${domain} · ${shop.currencyCode}${plan}${note}`;
    });

    await step("storefront-token", async () => {
      token = await getToken();
      const data = await sf(`query TokenProbe {
        shop { name paymentSettings { countryCode } }
      }`);
      if (!data?.shop?.name) throw new Error("Storefront API returned no shop for this token");
      shopCountry = shopCountry ?? data.shop.paymentSettings?.countryCode ?? undefined;
      return "token valid, Storefront API reachable";
    });

    await step("product-admin", async () => {
      const data = await admin(
        `query ProductAdmin($handle: String!) {
          productByIdentifier(identifier: { handle: $handle }) {
            title
            status
            variants(first: 100) {
              nodes {
                id title price availableForSale
                inventoryPolicy inventoryQuantity
                inventoryItem { tracked requiresShipping }
              }
            }
          }
        }`,
        { handle },
      );
      const product = data?.productByIdentifier;
      if (!product) {
        throw new Error(
          `No product with handle "${handle}" exists in this store. Check the product URL.`,
        );
      }
      if (product.status !== "ACTIVE") {
        throw new Error(
          `"${product.title}" is ${String(product.status).toLowerCase()}, not active — a buyer ` +
            "cannot reach it.",
        );
      }

      const variants: Json[] = product.variants?.nodes ?? [];
      const sellable = variants.find((v) => v.availableForSale);
      if (!sellable) {
        const tracked = variants.filter((v) => v.inventoryItem?.tracked);
        const out = tracked.filter((v) => (v.inventoryQuantity ?? 0) <= 0);
        throw new Error(
          `"${product.title}" has no variant available for sale` +
            (out.length
              ? ` — ${out.length} of ${variants.length} variant(s) are out of stock and set to ` +
                "stop selling when stock runs out."
              : " — every variant is unavailable or unpublished."),
        );
      }

      variantGid = sellable.id;
      variantTitle = sellable.title;
      unitPrice = Number(sellable.price ?? 0);
      requiresShipping = sellable.inventoryItem?.requiresShipping ?? true;
      if (!(unitPrice > 0)) {
        throw new Error(`Variant "${variantTitle}" is priced at 0 — checkout has nothing to charge`);
      }

      const stock = sellable.inventoryItem?.tracked
        ? `${sellable.inventoryQuantity ?? 0} in stock`
        : "inventory not tracked";
      return `${product.title} · variant "${variantTitle}" · ${unitPrice} · ${stock}`;
    });

    // ----------------------------------------------------------- storefront
    await step("product-published", async () => {
      // Reaching the product through the Storefront API is the proof that it is
      // published to the Online Store channel — no extra Admin scope needed.
      const data = await sf(
        `query ProductByHandle($handle: String!) {
          product(handle: $handle) {
            title
            availableForSale
            variants(first: 100) {
              nodes { id title availableForSale price { amount currencyCode } }
            }
          }
        }`,
        { handle },
      );
      const product = data?.product;
      if (!product) {
        throw new Error(
          `"${handle}" is not visible on the online store. The product exists but is not ` +
            "published to the Online Store sales channel, so a buyer cannot see or buy it.",
        );
      }
      const nodes: Json[] = product.variants?.nodes ?? [];
      const match = nodes.find((v) => v.id === variantGid);
      if (!match) {
        throw new Error(
          `Variant "${variantTitle}" is not published to the online store even though the ` +
            "product is.",
        );
      }
      if (!match.availableForSale) {
        throw new Error(`Variant "${variantTitle}" reads as unavailable on the online store`);
      }
      cartCurrency = match.price?.currencyCode ?? "";
      return `visible on the storefront · ${nodes.length} variant(s) published`;
    });

    // ------------------------------------------------------------ cart API
    await step("cart-create", async () => {
      const data = await sf(
        `mutation CartCreate($lines: [CartLineInput!]!) {
          cartCreate(input: { lines: $lines }) {
            cart { id checkoutUrl totalQuantity
              cost { subtotalAmount { amount currencyCode } totalAmount { amount currencyCode } }
              lines(first: 10) {
                nodes { id quantity merchandise { ... on ProductVariant { id title } } }
              }
            }
            userErrors { field message }
          }
        }`,
        { lines: [{ merchandiseId: variantGid, quantity }] },
      );
      const bad = userErrors(data?.cartCreate?.userErrors);
      if (bad) throw new Error(`The Cart API refused the variant: ${bad}`);
      const cart = data?.cartCreate?.cart;
      if (!cart) throw new Error("Shopify accepted the request but returned no cart");
      cartId = cart.id;
      checkoutUrl = cart.checkoutUrl ?? "";
      createdCart = cart;
      return `cart created with ${cart.totalQuantity} item(s)`;
    });

    await step("cart-verify", async () => {
      const cart = createdCart;
      const problems: string[] = [];
      const line = cart.lines?.nodes?.[0];
      if (!line) problems.push("no line item was returned");
      if (line && line.quantity !== quantity) {
        problems.push(`quantity is ${line.quantity}, expected ${quantity}`);
      }
      if (line && line.merchandise?.id !== variantGid) {
        problems.push(`variant is ${line.merchandise?.id}, expected ${variantGid}`);
      }
      const subtotal = Number(cart.cost?.subtotalAmount?.amount ?? 0);
      if (!(subtotal > 0)) problems.push("the cart subtotal is 0");
      if (problems.length) throw new Error(problems.join("; "));

      cartCurrency = cart.cost.subtotalAmount.currencyCode;
      cartSubtotal = subtotal;
      run.cartTotal = money(cart.cost.totalAmount.amount, cart.cost.totalAmount.currencyCode);
      return `${variantTitle} ×${quantity} · subtotal ${money(subtotal, cartCurrency)}`;
    });

    await step("cart-update", async () => {
      // A buyer changes the quantity on the cart page before checking out; if
      // that mutation is broken the cart page is broken. Bumped and restored so
      // the later checks still see the requested quantity.
      const lineId = createdCart?.lines?.nodes?.[0]?.id;
      if (!lineId) throw new Skip("No cart line to update.");

      const bump = async (qty: number) => {
        const data = await sf(
          `mutation CartLinesUpdate($cartId: ID!, $lines: [CartLineUpdateInput!]!) {
            cartLinesUpdate(cartId: $cartId, lines: $lines) {
              cart { totalQuantity cost { subtotalAmount { amount currencyCode } } }
              userErrors { field message }
            }
          }`,
          { cartId, lines: [{ id: lineId, quantity: qty }] },
        );
        const bad = userErrors(data?.cartLinesUpdate?.userErrors);
        if (bad) throw new Error(bad);
        return data?.cartLinesUpdate?.cart;
      };

      const up = await bump(quantity + 1);
      if (up?.totalQuantity !== quantity + 1) {
        throw new Error(
          `Raising the quantity to ${quantity + 1} left the cart at ${up?.totalQuantity}`,
        );
      }
      const back = await bump(quantity);
      if (back?.totalQuantity !== quantity) {
        throw new Error(`Restoring the quantity to ${quantity} left the cart at ${back?.totalQuantity}`);
      }
      return `quantity ${quantity} → ${quantity + 1} → ${quantity}, subtotal recalculated`;
    });

    // ---------------------------------------------------------------- theme
    // These two steps are the only ones that touch the theme. They are plain
    // HTTP, so they see exactly what a buyer's browser is served.
    let themeReachable = true;

    await step("theme-product-page", async () => {
      if (opts.storefrontPassword) {
        const unlock = await jar.fetch(`${origin}/password`, {
          method: "POST",
          follow: false,
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            form_type: "storefront_password",
            utf8: "✓",
            password: opts.storefrontPassword,
          }).toString(),
        });
        // Order matters: a rate-limited unlock also fails to leave /password,
        // and calling that a wrong password would send the merchant chasing a
        // problem that does not exist.
        try {
          assertNoChallenge("the storefront password page", unlock);
        } catch (err) {
          themeReachable = false;
          throw err;
        }
        // A good password answers 302 to somewhere that is not /password; a bad
        // one re-renders the form or bounces back to it.
        const to = unlock.res.headers.get("location") ?? "";
        const unlocked = unlock.res.status === 302 && !/\/password\b/.test(to);
        if (!unlocked) {
          throw new Error(
            "The storefront password was rejected. Update it in the app and run the check again.",
          );
        }
      }

      const { res, body, finalUrl } = await jar.fetch(opts.productUrl, {
        headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
      });

      try {
        assertNoChallenge("the product page", { res, body });
      } catch (err) {
        themeReachable = false;
        throw err;
      }
      if (/\/password\b/.test(finalUrl)) {
        themeReachable = false;
        throw new Skip(
          "The storefront is password protected. Save the storefront password in the app to " +
            "include the theme's own Add-to-cart button in the check.",
        );
      }
      if (!res.ok) throw new Error(`The product page returned HTTP ${res.status}`);

      const hasForm = /<form[^>]+action="[^"]*\/cart\/add/i.test(body);
      if (!hasForm) {
        throw new Error(
          'The product page has no add-to-cart form (form[action*="/cart/add"]). The theme ' +
            "cannot add this product to a cart.",
        );
      }
      const hasVariant = body.includes(numericId(variantGid));
      return [
        `HTTP ${res.status}`,
        "add-to-cart form found",
        hasVariant ? `variant ${numericId(variantGid)} on the page` : null,
      ]
        .filter(Boolean)
        .join(" · ");
    });

    await step("theme-ajax-add", async () => {
      if (!themeReachable) {
        throw new Skip("Skipped because the product page could not be loaded.");
      }

      // /cart/add.js is the endpoint the theme's Add-to-cart button posts to,
      // so this is the theme's own add-to-cart path, minus the JavaScript.
      // Requests are kept to a minimum — add, then read back — because the Ajax
      // cart is rate-limited far more aggressively than the GraphQL APIs.
      const add = await jar.fetch(`${origin}/cart/add.js`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/javascript, */*; q=0.01",
          "x-requested-with": "XMLHttpRequest",
          referer: opts.productUrl,
        },
        body: JSON.stringify({ items: [{ id: Number(numericId(variantGid)), quantity }] }),
      });
      assertNoChallenge("/cart/add.js", add);

      if (!add.res.ok) {
        // Shopify answers a rejected add with a JSON body explaining why —
        // usually "You can only add N to the cart".
        let why = add.body.slice(0, 200);
        try {
          const parsed = JSON.parse(add.body);
          why = parsed.description || parsed.message || why;
        } catch {
          /* not JSON — keep the raw snippet */
        }
        throw new Error(`The theme's add-to-cart endpoint rejected the variant (HTTP ${add.res.status}): ${why}`);
      }

      const read = await jar.fetch(`${origin}/cart.js`, {
        headers: { accept: "application/json, text/javascript, */*; q=0.01" },
      });
      assertNoChallenge("/cart.js", read);
      let ajax: Json;
      try {
        ajax = JSON.parse(read.body);
      } catch {
        throw new Error(
          `/cart.js did not return JSON (HTTP ${read.res.status}): ${read.body.slice(0, 120)}`,
        );
      }

      // The session cart may already hold other items, so assert on our own
      // line rather than the first one.
      const wanted = numericId(variantGid);
      const line = (ajax.items ?? []).find((i: Json) => String(i.variant_id) === wanted);
      if (!line) {
        throw new Error(
          `The theme accepted the add, but variant ${wanted} is not in /cart.js afterwards ` +
            `(item_count ${ajax.item_count ?? 0}) — the cart is not holding the item.`,
        );
      }
      if (line.quantity < quantity) {
        throw new Error(`The cart holds ${line.quantity} of the variant, expected ${quantity}`);
      }
      if ((line.line_price ?? 0) <= 0) throw new Error("The cart line is priced at 0");

      // Ajax cart prices are in cents.
      return `${line.product_title} ×${line.quantity} · line ${money(
        line.line_price / 100,
        ajax.currency,
      )} · cart ${money((ajax.total_price ?? 0) / 100, ajax.currency)}`;
    });

    // -------------------------------------------------------- checkout ready
    await step("shipping-rates", async () => {
      if (!requiresShipping) {
        throw new Skip(
          `"${variantTitle}" does not require shipping, so no rate is needed at checkout.`,
        );
      }

      // Shopify resolves a rate from the *whole* address, not just the country:
      // for the US and many others it returns nothing at all without a postal
      // code. So prefer a complete address — an explicit one, else the shop's
      // own — and remember whether we managed to supply a postal code, because
      // that decides whether an empty result is a real finding.
      const explicit = opts.country
        ? {
            countryCode: opts.country.toUpperCase(),
            zip: opts.zip,
            city: "Test City",
            provinceCode: undefined as string | undefined,
          }
        : null;
      const fromShop =
        shopAddress?.countryCodeV2 && shopAddress.zip
          ? {
              countryCode: shopAddress.countryCodeV2,
              zip: shopAddress.zip,
              city: shopAddress.city ?? "Test City",
              provinceCode: shopAddress.provinceCode ?? undefined,
            }
          : null;
      const fallback = shopCountry
        ? { countryCode: shopCountry, zip: undefined, city: "Test City", provinceCode: undefined }
        : null;

      const addr = explicit ?? fromShop ?? fallback;
      if (!addr) {
        throw new Skip("Could not determine a country to request a shipping rate for.");
      }

      const data = await sf(
        `mutation AddAddress($cartId: ID!, $country: CountryCode!, $city: String!, $zip: String, $province: String) {
          cartDeliveryAddressesAdd(
            cartId: $cartId
            addresses: [{ selected: true, address: { deliveryAddress: {
              address1: "1 Test Street", city: $city, countryCode: $country,
              zip: $zip, provinceCode: $province,
              firstName: "ATC", lastName: "Checker"
            } } }]
          ) {
            cart {
              deliveryGroups(first: 5) {
                nodes { deliveryOptions { title estimatedCost { amount currencyCode } } }
              }
              cost { totalAmount { amount currencyCode } }
            }
            userErrors { field message }
          }
        }`,
        {
          cartId,
          country: addr.countryCode,
          city: addr.city,
          zip: addr.zip ?? null,
          province: addr.provinceCode ?? null,
        },
      );

      const bad = userErrors(data?.cartDeliveryAddressesAdd?.userErrors);
      if (bad) throw new Error(`Shopify rejected the delivery address: ${bad}`);

      const cart = data?.cartDeliveryAddressesAdd?.cart;
      const options: Json[] = (cart?.deliveryGroups?.nodes ?? []).flatMap(
        (g: Json) => g.deliveryOptions ?? [],
      );
      const where = `${addr.countryCode}${addr.zip ? ` ${addr.zip}` : ""}`;

      if (!options.length) {
        // Without a postal code an empty result is inconclusive rather than a
        // finding — reporting it as "no shipping zone" would be a false alarm.
        if (!addr.zip) {
          throw new Warn(
            `No shipping rate came back for ${addr.countryCode}, but no postal code was used and ` +
              "Shopify needs one to resolve a rate for many countries. Set a ship-to postal code, " +
              "or fill in the store address under Settings → Store details, to make this check " +
              "conclusive.",
          );
        }
        throw new Error(
          `No shipping rate is available for ${where}. A buyer there would reach checkout and be ` +
            "unable to complete the order. Add a shipping zone covering that country in " +
            "Settings → Shipping and delivery.",
        );
      }

      const total = cart?.cost?.totalAmount;
      if (total) run.cartTotal = money(total.amount, total.currencyCode);
      const cheapest = options
        .map((o: Json) => ({
          title: o.title,
          amount: Number(o.estimatedCost?.amount ?? 0),
          cur: o.estimatedCost?.currencyCode,
        }))
        .sort((a, b) => a.amount - b.amount)[0];
      return `${options.length} rate(s) for ${where} · cheapest "${cheapest.title}" ${money(
        cheapest.amount,
        cheapest.cur ?? cartCurrency,
      )}${total ? ` · order total ${money(total.amount, total.currencyCode)}` : ""}`;
    });

    await step("payment-methods", async () => {
      const data = await sf(`query PaymentSettings {
        shop {
          paymentSettings {
            acceptedCardBrands
            supportedDigitalWallets
            shopifyPaymentsAccountId
          }
        }
      }`);
      const ps: Json = data?.shop?.paymentSettings;
      const cards: string[] = ps?.acceptedCardBrands ?? [];
      const wallets: string[] = ps?.supportedDigitalWallets ?? [];

      // Whatever Shopify does report is a definite pass: a buyer has a way to
      // pay. True on a live store and on any store where the gateway surfaces.
      if (cards.length || wallets.length) {
        return [
          cards.length ? `${cards.length} card brand(s): ${cards.slice(0, 4).join(", ")}` : null,
          wallets.length ? `wallets: ${wallets.join(", ")}` : null,
          ps.shopifyPaymentsAccountId ? "Shopify Payments active" : null,
        ]
          .filter(Boolean)
          .join(" · ");
      }

      // Nothing reported. What that means depends entirely on the plan, so both
      // cases get a verdict — neither is silently stood down.
      //
      // A development store can only process test payments, and the test gateway
      // is not observable from here: the Storefront and Admin APIs both report
      // empty payment settings for it, the REST payment_gateways endpoint is
      // gone, and checkout answers 403 to any non-browser client. So this is the
      // one check that cannot be automated on a dev store, and it says so rather
      // than guessing either way.
      if (shopPlan?.partnerDevelopment) {
        throw new Warn(
          `This is a development store (${shopPlan.displayName ?? "Developer Preview"}), so it can ` +
            "only take test payments — and Shopify does not report the test gateway through any " +
            "API, so this is the one check that cannot be automated here. Confirm it by hand once: " +
            "Settings → Payments should show the test payment gateway activated. Everything before " +
            "payment selection is verified above, and this check asserts for real as soon as the " +
            "store moves to a paid plan.",
        );
      }

      throw new Warn(
        "No card brands or digital wallets are enabled on this storefront. A buyer would reach " +
          "checkout with no way to pay. If the store only uses a manual payment method (bank " +
          "transfer, cash on delivery) this is expected, since those are not reported either — " +
          "otherwise finish setting up a payment provider in Settings → Payments.",
      );
    });

    await step("checkout-url", async () => {
      if (!checkoutUrl) throw new Error("Shopify issued no checkout URL for the cart");
      // Shopify hands back a cart permalink (/cart/c/<token>?key=…) that
      // redirects into /checkouts/…; the older direct /checkouts/ form still
      // appears on some shops, so accept both. The next step follows it.
      const u = new URL(checkoutUrl);
      if (!/^\/(cart\/c\/|checkouts?\/)/.test(u.pathname)) {
        throw new Error(`The checkout URL does not look like a checkout: ${checkoutUrl}`);
      }
      run.checkoutUrl = checkoutUrl;
      return `${u.origin}${u.pathname}`;
    });

    await step("checkout-reachable", async () => {
      const { res, body, finalUrl } = await jar.fetch(checkoutUrl, {
        headers: { accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
      });

      if (CHALLENGE.test(body)) {
        throw new Skip(
          "Checkout served a bot challenge to this non-browser request. The cart and the issued " +
            "checkout URL are the real proof, and both passed.",
        );
      }
      if (res.status === 403) {
        throw new Skip(
          `Checkout answered HTTP 403 to this non-browser request (it reached ` +
            `${new URL(finalUrl).pathname}). Shopify bot-protects checkout heavily; the cart and ` +
            "the issued checkout URL are the real proof, and both passed.",
        );
      }
      if (/\/password\b/.test(finalUrl)) {
        throw new Skip(
          "Checkout redirected to the storefront password page. Save the storefront password in " +
            "the app to follow the checkout URL.",
        );
      }
      if (!res.ok) throw new Error(`Checkout returned HTTP ${res.status}`);

      const lower = body.toLowerCase();
      if (/cart is empty|your cart is empty/.test(lower)) {
        throw new Error("Checkout says the cart is empty — the cart did not carry over");
      }
      const landed = /\/checkouts?\//.test(finalUrl);
      const hasForm = /order summary|subtotal|shipping|contact|payment/.test(lower);
      if (!landed && !hasForm) {
        throw new Error(`Followed the checkout URL but landed on ${finalUrl} with no checkout form`);
      }
      run.checkoutUrl = finalUrl;
      return [
        `HTTP ${res.status}`,
        landed ? "reached /checkouts/" : null,
        hasForm ? "checkout form rendered" : null,
      ]
        .filter(Boolean)
        .join(" · ");
    });

    run.status = "passed";
  } catch (err) {
    run.status = "failed";
    run.error = err instanceof Error ? err.message : String(err);
    for (const s of run.steps) {
      if (s.status === "pending") {
        s.status = "skip";
        s.detail = "Not reached — an earlier check failed.";
      }
    }
  } finally {
    // Carts created here are abandoned, never completed. Nothing to clean up:
    // Shopify expires them on its own and no order is ever placed.
    void cartId;
    void cartSubtotal;
    run.finishedAt = Date.now();
    onUpdate(run);
  }

  return run;
}
