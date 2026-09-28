import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Link, useFetcher, useLoaderData, useRevalidator } from "react-router";
import { requireAdmin } from "../auth.server";
import { listRuns, startRun } from "../atc/store.server";
import { getStore, productUrlList, runOptionsFor } from "../atc/stores.server";
import { describeWebBotAuthStatus } from "../atc/web-bot-auth.server";
import { LAYERS } from "../atc/layers";
import type { FlowRun } from "../atc/types";
import { RunDetail } from "../components/RunDetail";
import { StatusBadge } from "../components/StatusBadge";

async function loadStore(id: string | undefined) {
  const store = id ? await getStore(id) : null;
  if (!store) throw new Response("Store not found", { status: 404 });
  return store;
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  await requireAdmin(request);
  const store = await loadStore(params.id);
  return {
    store: {
      id: store.id,
      name: store.name,
      url: store.url,
      discountCode: store.discountCode ?? "",
    },
    products: productUrlList(store),
    webBotAuth: describeWebBotAuthStatus(store),
    runs: await listRuns(store.id, 10),
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  await requireAdmin(request);
  const store = await loadStore(params.id);
  const form = await request.formData();

  const productUrl = String(form.get("productUrl") ?? "").trim();
  const quantity = Math.max(1, Number(form.get("quantity") ?? 1) || 1);
  const discountCode = String(form.get("discountCode") ?? "").trim();

  const opts = runOptionsFor(store, { productUrl, quantity, discountCode });
  if (!opts.productUrl) {
    return { error: "Add a product URL in this store's settings, or paste one below." };
  }
  if (!/^https?:\/\//i.test(opts.productUrl)) {
    return { error: "The product URL must start with https://" };
  }

  return { runId: startRun(opts).id };
};

export default function StoreDashboard() {
  const { store, products, webBotAuth, runs } = useLoaderData<typeof loader>();
  const starter = useFetcher<typeof action>();
  const poller = useFetcher<{ run: FlowRun | null }>();
  const revalidator = useRevalidator();

  const formRef = useRef<HTMLFormElement>(null);
  const selectRef = useRef<HTMLElementTagNameMap["s-select"]>(null);
  const urlRef = useRef<HTMLElementTagNameMap["s-text-field"]>(null);

  // A run opened from the history list. Cleared whenever a new run is started,
  // so the freshly started run always wins.
  const [pickedRunId, setPickedRunId] = useState<string | null>(null);

  // With no saved product, there is nothing to collapse — a URL is required,
  // so the options stay open from the start.
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
    <s-page heading={store.name}>
      <s-link slot="breadcrumb-actions" href="/app">
        Stores
      </s-link>
      <s-button slot="secondary-actions" href={`/app/stores/${store.id}/settings`}>
        Settings
      </s-button>

      <s-section heading="What to check">
        <s-paragraph>
          This uses a real browser to test <s-text>{store.url}</s-text> exactly like a
          real visitor would: it loads the homepage and product page, searches for the
          product, clicks the real Add-to-cart button, checks the cart, changes its
          quantity, applies a discount code, and clicks through to checkout. It stops
          there: <s-text type="strong">no order is placed and no payment is taken</s-text>.
        </s-paragraph>

        {!webBotAuth.configured || webBotAuth.expired ? (
          <s-banner tone="warning" heading="Web Bot Auth needed">
            <s-paragraph>
              Checks are skipped until a valid Web Bot Auth signature is saved in{" "}
              <Link to={`/app/stores/${store.id}/settings`}>this store&apos;s settings</Link>.
            </s-paragraph>
          </s-banner>
        ) : null}

        {autoProduct && (
          <s-paragraph>
            <s-text type="strong">Run check</s-text> tests{" "}
            <s-text type="strong">{autoProduct}</s-text>.{" "}
            <s-clickable onClick={() => setShowAdvanced((v) => !v)}>
              <s-text color="subdued">
                {showAdvanced ? "Hide advanced options" : "Test a different product, or set advanced options"}
              </s-text>
            </s-clickable>
          </s-paragraph>
        )}

        <form ref={formRef} onSubmit={(e) => e.preventDefault()}>
          <s-stack direction="block" gap="base">
            <div hidden={!showAdvanced}>
              <s-stack direction="block" gap="base">
                {products.length > 1 && (
                  <s-select ref={selectRef} label="Saved product" name="product">
                    {products.map((url) => (
                      <s-option key={url} value={url}>
                        {url}
                      </s-option>
                    ))}
                  </s-select>
                )}

                <s-text-field
                  ref={urlRef}
                  label="Product URL"
                  name="productUrl"
                  value={products[0] ?? ""}
                  details="Any live product URL on this store."
                />

                <s-stack direction="inline" gap="base">
                  <s-number-field
                    label="Quantity"
                    name="quantity"
                    value="1"
                    min={1}
                  />
                  <s-text-field
                    label="Discount code (optional)"
                    name="discountCode"
                    value={store.discountCode}
                    details="Applied to the test cart. Leave blank to skip this check."
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
