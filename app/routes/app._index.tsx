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
import {
  hasStorefrontPassword,
  resolveStorefrontPassword,
  saveStorefrontPassword,
} from "../atc/settings.server";
import type { FlowRun, RunStep } from "../atc/types";

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
    // Never send the password itself back to the browser — only whether one is set.
    passwordSaved: await hasStorefrontPassword(session.shop),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "run");

  if (intent === "save-password") {
    const saved = await saveStorefrontPassword(
      session.shop,
      String(form.get("storefrontPassword") ?? ""),
    );
    return {
      savedMessage: saved
        ? "Storefront password saved. Every check will use it automatically."
        : "Storefront password cleared.",
    };
  }

  const productUrl = String(form.get("productUrl") ?? "").trim();
  const quantity = Math.max(1, Number(form.get("quantity") ?? 1) || 1);
  const country = String(form.get("country") ?? "").trim().toUpperCase();
  const zip = String(form.get("zip") ?? "").trim();

  if (!productUrl) {
    return { error: "Pick a product or paste a product URL first." };
  }
  if (!/^https?:\/\//i.test(productUrl)) {
    return { error: "The product URL must start with https://" };
  }
  if (country && !/^[A-Z]{2}$/.test(country)) {
    return { error: "Country must be a two-letter code, for example US or PK." };
  }

  const run = startRun({
    shop: session.shop,
    productUrl,
    quantity,
    // The checker calls the Admin API directly, so it needs the offline token
    // this session already holds. It is never persisted with the run.
    adminToken: session.accessToken!,
    country: country || undefined,
    zip: zip || undefined,
    // A password typed into the run form wins; otherwise use the saved one.
    storefrontPassword: await resolveStorefrontPassword(
      session.shop,
      String(form.get("storefrontPassword") ?? ""),
    ),
  });

  return { runId: run.id };
};

const LAYERS: Array<{ key: RunStep["layer"]; title: string; blurb: string }> = [
  {
    key: "admin",
    title: "Store & product",
    blurb: "Admin API — what the store is actually configured to sell.",
  },
  {
    key: "storefront",
    title: "Buyer path",
    blurb: "Storefront Cart API — the same cart a real buyer builds.",
  },
  {
    key: "theme",
    title: "Theme",
    blurb: "Plain HTTP to the live storefront and the theme's own cart endpoint.",
  },
  {
    key: "checkout",
    title: "Checkout readiness",
    blurb:
      "Shipping, payment and the issued checkout. On a development store the " +
      "payment check warns instead of asserting — Shopify exposes no API for " +
      "the test gateway.",
  },
];

export default function Index() {
  const { products, storefrontHost, runs, passwordSaved } =
    useLoaderData<typeof loader>();
  const starter = useFetcher<typeof action>();
  const saver = useFetcher<typeof action>();
  const poller = useFetcher<{ run: FlowRun | null }>();
  const revalidator = useRevalidator();

  const formRef = useRef<HTMLFormElement>(null);
  const settingsRef = useRef<HTMLFormElement>(null);
  const selectRef = useRef<HTMLElementTagNameMap["s-select"]>(null);
  const urlRef = useRef<HTMLElementTagNameMap["s-text-field"]>(null);

  // A run opened from the history list. Cleared whenever a new run is started,
  // so the freshly started run always wins.
  const [pickedRunId, setPickedRunId] = useState<string | null>(null);

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

  // Reflect a saved/cleared password in the "Saved" badge.
  const savedMessage =
    saver.data && "savedMessage" in saver.data ? saver.data.savedMessage : null;
  useEffect(() => {
    if (savedMessage) revalidator.revalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedMessage]);

  const submit = () => {
    setPickedRunId(null);
    if (formRef.current) starter.submit(formRef.current, { method: "POST" });
  };

  const savePassword = () => {
    if (settingsRef.current)
      saver.submit(settingsRef.current, { method: "POST" });
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
          This runs 13 checks against <s-text>{storefrontHost}</s-text> through
          Shopify&apos;s Admin and Storefront APIs: it resolves the product, builds a
          real cart, prices it, asks for a shipping rate and confirms a checkout
          is issued. It stops there:{" "}
          <s-text type="strong">
            no order is placed and no payment is taken
          </s-text>
          .
        </s-paragraph>

        <form ref={formRef} onSubmit={(e) => e.preventDefault()}>
          <input type="hidden" name="intent" value="run" />
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
              <s-text-field
                label="Ship-to country"
                name="country"
                details="Two-letter code. Blank uses the store's own address."
              />
              <s-text-field
                label="Ship-to postal code"
                name="zip"
                details="Shopify needs one to resolve a rate for many countries."
              />
              <s-password-field
                label="Storefront password"
                name="storefrontPassword"
                details={
                  passwordSaved
                    ? "A saved password will be used — fill this in only to override it for this check."
                    : "Only if the store is password protected. Save it below to reuse it."
                }
              />
            </s-stack>

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

      <s-section heading="Storefront password">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-text>Status:</s-text>
            <s-badge tone={passwordSaved ? "success" : "neutral"}>
              {passwordSaved ? "Saved" : "Not set"}
            </s-badge>
          </s-stack>

          <s-paragraph>
            The API checks work either way. Save the password (Online Store →
            Preferences → Password protection) to also cover the two theme
            checks, which load the real product page.
          </s-paragraph>

          <form ref={settingsRef} onSubmit={(e) => e.preventDefault()}>
            <input type="hidden" name="intent" value="save-password" />
            <s-stack direction="block" gap="base">
              <s-password-field
                label="Storefront password"
                name="storefrontPassword"
                details="Leave blank and save to clear the stored password."
              />
              <s-stack direction="inline" gap="base">
                <s-button
                  onClick={savePassword}
                  {...(saver.state !== "idle" ? { loading: true } : {})}
                >
                  {passwordSaved ? "Update password" : "Save password"}
                </s-button>
              </s-stack>
              {savedMessage && (
                <s-banner tone="success" heading="Saved">
                  <s-paragraph>{savedMessage}</s-paragraph>
                </s-banner>
              )}
            </s-stack>
          </form>
        </s-stack>
      </s-section>

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

function RunDetail({ run }: { run: FlowRun }) {
  const warnings = run.steps.filter((s) => s.status === "warn").length;

  const heading =
    run.status === "failed"
      ? "The flow is broken"
      : run.status === "passed"
        ? warnings
          ? "Flow works, with warnings"
          : "Flow verified through checkout"
        : "Checking…";

  const duration =
    run.finishedAt != null
      ? `${((run.finishedAt - run.startedAt) / 1000).toFixed(1)}s`
      : null;

  const done = run.steps.filter((s) =>
    ["pass", "warn", "fail", "skip"].includes(s.status),
  ).length;

  return (
    <s-section heading={heading}>
      <s-stack direction="inline" gap="base" alignItems="center">
        <StatusBadge status={run.status} />
        <s-text color="subdued">
          {done}/{run.steps.length} checks
        </s-text>
        {duration && <s-text color="subdued">{duration}</s-text>}
        {run.cartTotal && (
          <s-text color="subdued">Order total {run.cartTotal}</s-text>
        )}
      </s-stack>

      {run.error && (
        <s-banner tone="critical" heading="What is wrong">
          <s-paragraph>{run.error}</s-paragraph>
        </s-banner>
      )}

      {run.status === "passed" && warnings > 0 && (
        <s-banner tone="warning" heading="Worth a look">
          <s-paragraph>
            The flow reaches checkout, but {warnings} check
            {warnings > 1 ? "s" : ""} found something a buyer would notice — see
            the amber rows below.
          </s-paragraph>
        </s-banner>
      )}

      {LAYERS.map((layer) => {
        const steps = run.steps.filter((s) => s.layer === layer.key);
        if (!steps.length) return null;
        return (
          <s-stack key={layer.key} direction="block" gap="small-500">
            <s-text type="strong">{layer.title}</s-text>
            {steps.map((step) => (
              <StepRow key={step.key} step={step} />
            ))}
          </s-stack>
        );
      })}

      {run.checkoutUrl && (
        <s-paragraph>
          Checkout reached:{" "}
          <s-link href={run.checkoutUrl} target="_blank">
            {run.checkoutUrl}
          </s-link>
        </s-paragraph>
      )}
    </s-section>
  );
}

const STEP_ICON: Record<RunStep["status"], string> = {
  pass: "✅",
  warn: "⚠️",
  fail: "❌",
  running: "⏳",
  skip: "⏭️",
  pending: "•",
};

function StepRow({ step }: { step: RunStep }) {
  return (
    <s-box padding="small-200" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="small-500">
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <s-text>{STEP_ICON[step.status]}</s-text>
          <s-text type="strong">{step.title}</s-text>
          {step.durationMs != null && (
            <s-text color="subdued">{step.durationMs}ms</s-text>
          )}
        </s-stack>
        {step.detail && <s-text color="subdued">{step.detail}</s-text>}
      </s-stack>
    </s-box>
  );
}

const STATUS_TONE = {
  passed: "success",
  failed: "critical",
  running: "info",
  queued: "neutral",
} as const;

function StatusBadge({ status }: { status: FlowRun["status"] }) {
  return <s-badge tone={STATUS_TONE[status]}>{status}</s-badge>;
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
