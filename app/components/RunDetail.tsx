import { useState, type ReactNode } from "react";
import type { FlowRun } from "../atc/types";
import { LAYERS } from "../atc/layers";
import { StatusBadge } from "./StatusBadge";
import { RunProgressBar } from "./RunProgressBar";
import { LayerCard } from "./LayerCard";
import { useAuthenticatedImage } from "./useAuthenticatedImage";

const SCREENSHOT_MODAL_ID = "atc-screenshot-modal";

export function RunDetail({ run }: { run: FlowRun }) {
  const [screenshot, setScreenshot] = useState<{ url: string; title: string } | null>(null);
  const modalSrc = useAuthenticatedImage(screenshot?.url ?? null);
  const warnings = run.steps.filter((s) => s.status === "warn").length;
  const inFlight = run.status === "queued" || run.status === "running";

  const viewScreenshot = (url: string, title: string) => {
    setScreenshot({ url, title });
    // App Bridge's declarative modal API; if it isn't wired up for any reason
    // the modal still renders inline below, just without the open animation.
    (window as { shopify?: { modal?: { show?: (id: string) => void } } }).shopify?.modal?.show?.(
      SCREENSHOT_MODAL_ID,
    );
  };

  const heading =
    run.status === "skipped"
      ? "Not configured yet"
      : run.status === "failed"
        ? "The flow is broken"
        : run.status === "passed"
          ? warnings
            ? "Flow works, with warnings"
            : "Flow verified through checkout"
          : "Checking…";

  const duration =
    run.finishedAt != null ? `${((run.finishedAt - run.startedAt) / 1000).toFixed(1)}s` : null;

  const done = run.steps.filter((s) => ["pass", "warn", "fail", "skip"].includes(s.status)).length;

  return (
    <s-section heading={heading}>
      <s-stack direction="block" gap="base">
        <s-box background="subdued" borderRadius="base" padding="base">
          <s-stack direction="block" gap="base">
            <s-grid gridTemplateColumns="repeat(auto-fit, minmax(140px, 1fr))" gap="base">
              <StatTile label="Status">
                <StatusBadge status={run.status} />
              </StatTile>
              <StatTile label="Progress" icon={<s-icon type="check-circle-filled" size="small" color="subdued" />}>
                <s-text type="strong">
                  {done}/{run.steps.length}
                </s-text>
              </StatTile>
              {duration && (
                <StatTile label="Duration" icon={<s-icon type="clock" size="small" color="subdued" />}>
                  <s-text type="strong">{duration}</s-text>
                </StatTile>
              )}
              {run.cartTotal && (
                <StatTile label="Order total" icon={<s-icon type="cart" size="small" color="subdued" />}>
                  <s-text type="strong">{run.cartTotal}</s-text>
                </StatTile>
              )}
            </s-grid>
            {inFlight && <RunProgressBar done={done} total={run.steps.length} />}
          </s-stack>
        </s-box>

        {run.status === "skipped" && run.error && (
          <s-banner tone="info" heading="Add a Web Bot Auth signature to run checks">
            <s-paragraph>{run.error}</s-paragraph>
          </s-banner>
        )}

        {run.status !== "skipped" && run.error && (
          <s-banner tone="critical" heading="What is wrong">
            <s-paragraph>{run.error}</s-paragraph>
          </s-banner>
        )}

        {run.status === "passed" && warnings > 0 && (
          <s-banner tone="warning" heading="Worth a look">
            <s-paragraph>
              The flow reaches checkout, but {warnings} check{warnings > 1 ? "s" : ""} found
              something a buyer would notice — see the amber rows below.
            </s-paragraph>
          </s-banner>
        )}

        {LAYERS.map((layer) => (
          <LayerCard
            key={layer.key}
            layer={layer}
            steps={run.steps.filter((s) => s.layer === layer.key)}
            runId={run.id}
            onViewScreenshot={viewScreenshot}
          />
        ))}

        {run.checkoutUrl && (
          <s-paragraph>
            Checkout reached:{" "}
            <s-link href={run.checkoutUrl} target="_blank">
              {run.checkoutUrl}
            </s-link>
          </s-paragraph>
        )}
      </s-stack>

      <s-modal id={SCREENSHOT_MODAL_ID} heading={screenshot?.title ?? "Screenshot"}>
        {screenshot && modalSrc && (
          <img src={modalSrc} alt={screenshot.title} style={{ maxWidth: "100%", display: "block" }} />
        )}
      </s-modal>
    </s-section>
  );
}

function StatTile({ label, icon, children }: { label: string; icon?: ReactNode; children: ReactNode }) {
  return (
    <s-box background="strong" borderRadius="base" padding="base">
      <s-stack direction="block" gap="small-200">
        <s-stack direction="inline" gap="small-200" alignItems="center">
          {icon}
          <s-text color="subdued">{label}</s-text>
        </s-stack>
        {children}
      </s-stack>
    </s-box>
  );
}
