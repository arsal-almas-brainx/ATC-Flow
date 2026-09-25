import { useEffect, useRef, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { listRuns, startRun } from "../atc/store.server";
import { resolveStorefrontPassword } from "../atc/settings.server";
import { resolveWebBotAuthCredentials } from "../atc/web-bot-auth.server";
import { LAYERS } from "../atc/layers";
import type { FlowRun } from "../atc/types";
import { RunDetail } from "../components/RunDetail";
import { StatusBadge } from "../components/StatusBadge";

type ProductOption = { handle: string; title: string; url: string };

type ProductNode = {
  title: string;
  handle: string;
  totalInventory: number | null;
  tracksInventory: boolean;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);

  const response = await admin.graphql(
    `#graphql
      query AtcFlowProducts {
        shop { primaryDomain { host } }
        products(first: 50, query: "status:active", sortKey: UPDATED_AT, reverse: true) {
          nodes {
            title
            handle
            totalInventory
            tracksInventory
          }
        }
      }`,
  );
  const body = await response.json();

  const host: string = body.data?.shop?.primaryDomain?.host ?? session.shop;
  const nodes: ProductNode[] = body.data?.products?.nodes ?? [];

  const products: ProductOption[] = nodes
    // A sold-out product can never complete the flow, so keep it out of the picker.
    .filter((p) => !p.tracksInventory || (p.totalInventory ?? 0) > 0)
    .map((p) => ({
      handle: p.handle,
      title: p.title,
      url: `https://${host}/products/${p.handle}`,
    }));

  return {
    shop: session.shop,
    storefrontHost: host,
    products,
    runs: await listRuns(session.shop, 10),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();

  const productUrl = String(form.get("productUrl") ?? "").trim();
  const quantity = Math.max(1, Number(form.get("quantity") ?? 1) || 1);
  const discountCode = String(form.get("discountCode") ?? "").trim();

  if (!productUrl) {
    return { error: "Pick a product or paste a product URL first." };
  }
  if (!/^https?:\/\//i.test(productUrl)) {
    return { error: "The product URL must start with https://" };
  }

  const webBotAuth = await resolveWebBotAuthCredentials(session.shop);

  const run = startRun({
    shop: session.shop,
    productUrl,
    quantity,
    discountCode: discountCode || undefined,
    // A password typed into the run form wins; otherwise use the saved one.
    storefrontPassword: await resolveStorefrontPassword(
      session.shop,
      String(form.get("storefrontPassword") ?? ""),
    ),
    webBotAuthSignature: webBotAuth?.signature,
    webBotAuthSignatureInput: webBotAuth?.signatureInput,
  });

  return { runId: run.id };
};

export default function Index() {
  const { products, storefrontHost, runs } = useLoaderData<typeof loader>();
  const starter = useFetcher<typeof action>();
  const poller = useFetcher<{ run: FlowRun | null }>();
  const revalidator = useRevalidator();

  const formRef = useRef<HTMLFormElement>(null);
  const selectRef = useRef<HTMLElementTagNameMap["s-select"]>(null);
  const urlRef = useRef<HTMLElementTagNameMap["s-text-field"]>(null);

  // A run opened from the history list. Cleared whenever a new run is started,
  // so the freshly started run always wins.
  const [pickedRunId, setPickedRunId] = useState<string | null>(null);

  // With no auto-pickable product, there is nothing to collapse — a URL is
  // required, so the options stay open from the start.
  const [showAdvanced, setShowAdvanced] = useState(products.length === 0);
  const autoProduct = products[0] ?? null;

  const startedRunId =
    starter.data && "runId" in starter.data ? starter.data.runId : null;
  const activeRunId = pickedRunId ?? startedRunId ?? null;

  // Picking a product fills the URL field. Polaris fields are custom elements,
  // so we listen for the native change event rather than React's onChange.
  useEffect(() => {
    const select = selectRef.current;
    if (!select) return;
    const sync = () => {
      if (urlRef.current) urlRef.current.value = select.value ?? "";
    };
    select.addEventListener("change", sync);
    return () => select.removeEventListener("change", sync);
  }, []);

  const activeRun = poller.data?.run ?? null;
  const inFlight =
    activeRun?.status === "queued" || activeRun?.status === "running";
  const settled =
    activeRun?.status === "passed" || activeRun?.status === "failed";

  // Load the run once it becomes active, then poll while it is in flight.
  useEffect(() => {
    if (!activeRunId) return;
    poller.load(`/api/runs/${activeRunId}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRunId]);

  useEffect(() => {
    if (!activeRunId || !inFlight) return;
    const timer = setInterval(
      () => poller.load(`/api/runs/${activeRunId}`),
      1000,
    );
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeRunId, inFlight]);

  // Refresh the history sidebar once a run settles.
  useEffect(() => {
    if (settled) revalidator.revalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled, activeRun?.id]);

  const submit = () => {
    setPickedRunId(null);
    if (formRef.current) starter.submit(formRef.current, { method: "POST" });
  };

  const busy = starter.state !== "idle" || inFlight;
  const startError =
    starter.data && "error" in starter.data ? starter.data.error : null;

  return (
    <s-page heading="Add-to-cart flow check">
      <s-button
        slot="primary-action"
        onClick={submit}
        {...(busy ? { loading: true } : {})}
      >
        Run check
      </s-button>

      <s-section heading="What to check">
        <s-paragraph>
          This uses a real browser to test <s-text>{storefrontHost}</s-text> exactly like a
          real visitor would: it loads your homepage and product page, searches for the
          product, clicks the real Add-to-cart button, checks the cart, changes its
          quantity, applies a discount code, and clicks through to checkout. It stops
          there: <s-text type="strong">no order is placed and no payment is taken</s-text>.
          Requires a Web Bot Auth signature configured under Settings.
        </s-paragraph>

        {autoProduct && (
          <s-paragraph>
            Nothing else to fill in — this store is already connected, so{" "}
            <s-text type="strong">Run check</s-text> tests{" "}
            <s-text type="strong">{autoProduct.title}</s-text> automatically.{" "}
            <s-clickable onClick={() => setShowAdvanced((v) => !v)}>
              <s-text color="subdued">
                {showAdvanced ? "Hide advanced options" : "Test a different product, or set advanced options"}
              </s-text>
            </s-clickable>
          </s-paragraph>
        )}

        <form ref={formRef} onSubmit={(e) => e.preventDefault()}>
          <input type="hidden" name="intent" value="run" />
          <s-stack direction="block" gap="base">
            <div hidden={!showAdvanced}>
              <s-stack direction="block" gap="base">
                {products.length > 0 ? (
                  <s-select ref={selectRef} label="Product" name="product">
                    {products.map((p) => (
                      <s-option key={p.handle} value={p.url}>
                        {p.title}
                      </s-option>
                    ))}
                  </s-select>
                ) : (
                  <s-banner
                    tone="warning"
                    heading="No in-stock active products found"
                  >
                    <s-paragraph>Paste a product URL below instead.</s-paragraph>
                  </s-banner>
                )}

                <s-text-field
                  ref={urlRef}
                  label="Product URL"
                  name="productUrl"
                  defaultValue={products[0]?.url ?? ""}
                  details="Any live product URL on this store."
                />

                <s-stack direction="inline" gap="base">
                  <s-number-field
                    label="Quantity"
                    name="quantity"
                    defaultValue="1"
                    min={1}
                  />
                  <s-password-field
                    label="Storefront password"
                    name="storefrontPassword"
                    details="Only if the store is password protected and you want to override the saved one for this check."
                  />
                  <s-text-field
                    label="Discount code (optional)"
                    name="discountCode"
                    details="Applied to the test cart to confirm it reduces the total. Leave blank to skip this check."
                  />
                </s-stack>
              </s-stack>
            </div>

            {startError && (
              <s-banner tone="critical" heading="Could not start">
                <s-paragraph>{startError}</s-paragraph>
              </s-banner>
            )}

            <s-stack direction="inline" gap="base">
              <s-button
                variant="primary"
                onClick={submit}
                {...(busy ? { loading: true } : {})}
              >
                Run check
              </s-button>
            </s-stack>
          </s-stack>
        </form>
      </s-section>

      {activeRun && <RunDetail run={activeRun} />}

      <s-section slot="aside" heading="Recent checks">
        {runs.length === 0 ? (
          <s-paragraph>No checks yet.</s-paragraph>
        ) : (
          <s-stack direction="block" gap="small-200">
            {runs.map((r) => (
              <s-clickable key={r.id} onClick={() => setPickedRunId(r.id)}>
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  <StatusBadge status={r.status} />
                  <s-text>{new Date(r.startedAt).toLocaleString()}</s-text>
                </s-stack>
              </s-clickable>
            ))}
          </s-stack>
        )}
      </s-section>

      <s-section slot="aside" heading="How it works">
        <s-stack direction="block" gap="small-200">
          {LAYERS.map((l) => (
            <s-stack key={l.key} direction="block" gap="small-500">
              <s-text type="strong">{l.title}</s-text>
              <s-text color="subdued">{l.blurb}</s-text>
            </s-stack>
          ))}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
