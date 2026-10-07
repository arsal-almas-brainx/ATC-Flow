import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Link, useFetcher, useLoaderData, useRevalidator } from "react-router";
import { requireAdmin } from "../auth.server";
import { listChecks, startCheck, type Check } from "../atc/store.server";
import { getStore, productUrlList, runOptionsFor } from "../atc/stores.server";
import { describeWebBotAuthStatus } from "../atc/web-bot-auth.server";
import { LAYERS } from "../atc/layers";
import { listSpeedRuns, pageSpeedKeySource, speedUrls, startSpeedRun } from "../atc/speed.server";
import type { SpeedRunView } from "../atc/speed";
import { CheckDetail } from "../components/CheckDetail";
import { SpeedDetail, SpeedHistory, SpeedMeasuredPanel } from "../components/SpeedDetail";
import { StatusBadge } from "../components/StatusBadge";

async function loadStore(id: string | undefined) {
  const store = id ? await getStore(id) : null;
  if (!store) throw new Response("Store not found", { status: 404 });
  return store;
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  await requireAdmin(request);
  const store = await loadStore(params.id);
  const url = new URL(request.url);
  return {
    // Links from Slack reports open a specific check (`?run=` from older reports), or the Speed tab.
    openCheckId: url.searchParams.get("check") ?? url.searchParams.get("run"),
    openTab: url.searchParams.get("tab") === "speed" ? ("speed" as const) : ("flow" as const),
    speedRuns: await listSpeedRuns(store.id, 20),
    speedPages: await speedUrls(store),
    speedKey: await pageSpeedKeySource(),
    store: {
      id: store.id,
      name: store.name,
      url: store.url,
      discountCode: store.discountCode ?? "",
    },
    products: productUrlList(store),
    webBotAuth: describeWebBotAuthStatus(store),
    checks: (await listChecks(store.id, 10)).map((c) => ({
      id: c.id,
      status: c.status,
      trigger: c.trigger,
      startedAt: c.startedAt,
    })),
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  await requireAdmin(request);
  const store = await loadStore(params.id);
  const form = await request.formData();

  if (form.get("intent") === "speed") {
    const { id } = await startSpeedRun(store);
    return { speedRunId: id };
  }

  const productUrl = String(form.get("productUrl") ?? "").trim();
  const quantity = Math.max(1, Number(form.get("quantity") ?? 1) || 1);
  const discountCode = String(form.get("discountCode") ?? "").trim();

  if (productUrl) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(productUrl);
    } catch {
      // handled below
    }
    if (!parsed || parsed.origin !== store.url || !/\/products\/[^/]+/.test(parsed.pathname)) {
      return { error: `The product URL must be a product page on ${store.url} (…/products/<handle>).` };
    }
  }

  const opts = runOptionsFor(store, { productUrl, quantity, discountCode });

  return { checkId: startCheck(opts).id };
};

export default function StoreDashboard() {
  const { store, products, webBotAuth, checks, openCheckId, openTab, speedRuns, speedPages, speedKey } =
    useLoaderData<typeof loader>();
  const [tab, setTab] = useState<"flow" | "speed">(openTab);
  const starter = useFetcher<typeof action>();
  const poller = useFetcher<{ check: Check | null }>();
  const revalidator = useRevalidator();

  const formRef = useRef<HTMLFormElement>(null);

  // A run opened from the history list. Cleared whenever a new run is started,
  // so the freshly started run always wins.
  const [pickedCheckId, setPickedCheckId] = useState<string | null>(openCheckId);

  const [showAdvanced, setShowAdvanced] = useState(false);

  const startedCheckId =
    starter.data && "checkId" in starter.data ? starter.data.checkId : null;
  const activeCheckId = pickedCheckId ?? startedCheckId ?? null;

  const activeCheck = poller.data?.check ?? null;
  const inFlight =
    activeCheck?.status === "queued" || activeCheck?.status === "running";
  const settled = activeCheck != null && !inFlight;

  // Load the run once it becomes active, then poll while it is in flight.
  useEffect(() => {
    if (!activeCheckId) return;
    poller.load(`/api/checks/${activeCheckId}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCheckId]);

  useEffect(() => {
    if (!activeCheckId || !inFlight) return;
    const timer = setInterval(
      () => poller.load(`/api/checks/${activeCheckId}`),
      1000,
    );
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeCheckId, inFlight]);

  // Refresh the history sidebar once a run settles.
  useEffect(() => {
    if (settled) revalidator.revalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled, activeCheck?.id]);

  const submit = () => {
    setPickedCheckId(null);
    if (formRef.current) starter.submit(formRef.current, { method: "POST" });
  };

  // --- Speed tab ---------------------------------------------------------
  const speedStarter = useFetcher<typeof action>();
  const speedPoller = useFetcher<{ speed: SpeedRunView | null }>();
  const [pickedSpeedId, setPickedSpeedId] = useState<string | null>(null);
  const startedSpeedId =
    speedStarter.data && "speedRunId" in speedStarter.data ? speedStarter.data.speedRunId : null;
  const activeSpeedId = pickedSpeedId ?? startedSpeedId ?? speedRuns[0]?.id ?? null;
  const polledSpeed = speedPoller.data?.speed;
  const activeSpeed =
    (polledSpeed?.id === activeSpeedId ? polledSpeed : null) ??
    speedRuns.find((r) => r.id === activeSpeedId) ??
    null;
  const speedRunning = activeSpeed?.status === "running" || speedStarter.state !== "idle";

  useEffect(() => {
    if (!activeSpeedId || activeSpeed?.status === "done") return;
    speedPoller.load(`/api/speed/${activeSpeedId}`);
    const timer = setInterval(() => speedPoller.load(`/api/speed/${activeSpeedId}`), 3000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSpeedId, activeSpeed?.status]);

  // Refresh the history table once a speed test finishes.
  useEffect(() => {
    if (polledSpeed?.status === "done") revalidator.revalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polledSpeed?.status, polledSpeed?.id]);

  const runSpeed = () => {
    setPickedSpeedId(null);
    speedStarter.submit({ intent: "speed" }, { method: "POST" });
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

      <TabBar
        tabs={[
          { key: "flow", label: "Site Flow Test" },
          { key: "speed", label: "Speed Test" },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === "flow" && (
        <>
        <s-section heading="Site flow test">
          <s-paragraph>
            This uses a real browser to test <s-text>{store.url}</s-text> exactly like a
            real visitor would: it loads the homepage and product page, searches for the
            product, clicks the real Add-to-cart button, checks the cart drawer and the cart,
            changes its quantity, applies a discount code, and clicks through to checkout. It stops
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

          <s-paragraph>
            Each test runs on desktop, then on mobile, and{" "}
            {products.length > 0
              ? `tests one of this store's ${products.length} saved product${products.length > 1 ? "s" : ""}, picked at random.`
              : "picks an in-stock product from the store's best sellers, like a shopper browsing."}
          </s-paragraph>

          <form ref={formRef} onSubmit={(e) => e.preventDefault()}>
            <s-stack direction="block" gap="base">
              <div hidden={!showAdvanced}>
                <s-stack direction="block" gap="base">
                  <s-text-field
                    label="Product URL (optional)"
                    name="productUrl"
                    details="Test this product for this run only. Leave blank to pick one automatically."
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

              <s-stack direction="inline" gap="base" alignItems="center">
                <s-button variant="primary" onClick={submit} {...(busy ? { loading: true } : {})}>
                  Run flow test
                </s-button>
                <s-button
                  variant="secondary"
                  icon={showAdvanced ? "chevron-up" : "chevron-down"}
                  onClick={() => setShowAdvanced((v) => !v)}
                >
                  {showAdvanced ? "Hide advanced options" : "Test a specific product / advanced options"}
                </s-button>
              </s-stack>
            </s-stack>
          </form>
        </s-section>

          {activeCheck && <CheckDetail key={activeCheck.id} check={activeCheck} />}

          <s-section slot="aside" heading="Recent checks">
            {checks.length === 0 ? (
              <s-paragraph>No checks yet.</s-paragraph>
            ) : (
              <s-stack direction="block" gap="small-200">
                {checks.map((r) => (
                  <s-clickable key={r.id} onClick={() => setPickedCheckId(r.id)}>
                    <s-stack direction="inline" gap="small-200" alignItems="center">
                      <StatusBadge status={r.status} />
                      {r.trigger === "schedule" && <s-badge tone="info">Scheduled</s-badge>}
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
        </>
      )}

      {tab === "speed" && (
        <>
          <s-section heading="Speed test">
            <s-stack direction="block" gap="base">
              <s-paragraph>
                Measures how fast <s-text>{store.url}</s-text> loads for shoppers, using Google
                PageSpeed Insights — the same tool as pagespeed.web.dev. It tests the homepage, a
                collection page and a product page, each on mobile and desktop, and rates each one
                GOOD (90+), AVERAGE (50–89) or POOR (under 50). It takes about a minute. Results are
                kept as history, and a page that turns POOR or drops 10+ points is flagged.
              </s-paragraph>
              {!speedKey && (
                <s-banner tone="warning" heading="No PageSpeed API key">
                  <s-paragraph>
                    Without an API key Google allows only a few tests a day — add a free key in{" "}
                    <Link to="/app/settings">Settings</Link>.
                  </s-paragraph>
                </s-banner>
              )}
              {speedStarter.data && "error" in speedStarter.data && (
                <s-banner tone="critical" heading="Could not start">
                  <s-paragraph>{speedStarter.data.error}</s-paragraph>
                </s-banner>
              )}
              <s-stack direction="inline" gap="base">
                <s-button variant="primary" onClick={runSpeed} {...(speedRunning ? { loading: true } : {})}>
                  Run speed test
                </s-button>
              </s-stack>
            </s-stack>
          </s-section>

          {activeSpeed && <SpeedDetail key={activeSpeed.id} speed={activeSpeed} />}
          <SpeedHistory runs={speedRuns} activeId={activeSpeedId} onPick={setPickedSpeedId} />

          <SpeedMeasuredPanel
            pages={{
              home: "the homepage (/)",
              collection: speedPages.collection
                ? new URL(speedPages.collection).pathname
                : "/collections/all",
              product:
                products.length > 0
                  ? new URL(products[0]).pathname
                  : "the store's top in-stock best seller, found each time",
            }}
          />
        </>
      )}
    </s-page>
  );
}

/** Page-level tabs — a plain underlined tab bar, so the current tab is obvious. */
function TabBar<K extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: Array<{ key: K; label: string }>;
  active: K;
  onChange: (key: K) => void;
}) {
  return (
    <div
      role="tablist"
      style={{
        display: "flex",
        gap: 4,
        borderBottom: "1px solid #d4d4d4",
        marginBottom: 16,
        fontFamily: "Inter, -apple-system, BlinkMacSystemFont, sans-serif",
      }}
    >
      {tabs.map((t) => {
        const selected = t.key === active;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(t.key)}
            style={{
              background: "none",
              border: 0,
              borderBottom: `3px solid ${selected ? "#1a1a1a" : "transparent"}`,
              marginBottom: -1,
              padding: "10px 16px",
              font: "inherit",
              fontSize: 15,
              fontWeight: selected ? 650 : 500,
              color: selected ? "#1a1a1a" : "#616161",
              cursor: "pointer",
            }}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
