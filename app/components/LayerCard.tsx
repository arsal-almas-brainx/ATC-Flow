import type { LayerInfo } from "../atc/layers";
import type { RunStep } from "../atc/types";
import { StepRow } from "./StepRow";

const LAYER_ICON = {
  storefront: "home",
  discovery: "search",
  cart: "cart",
  checkout: "credit-card",
} as const satisfies Record<LayerInfo["key"], string>;

export function LayerCard({
  layer,
  steps,
  runId,
  onViewScreenshot,
}: {
  layer: LayerInfo;
  steps: RunStep[];
  runId: string;
  onViewScreenshot?: (url: string, title: string) => void;
}) {
  if (!steps.length) return null;
  return (
    <s-box background="subdued" borderRadius="base" padding="base">
      <s-stack direction="block" gap="base">
        <s-stack direction="block" gap="small-200">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-icon type={LAYER_ICON[layer.key]} size="small" color="subdued" />
            <s-text type="strong">{layer.title}</s-text>
          </s-stack>
          <s-text color="subdued">{layer.blurb}</s-text>
        </s-stack>

        <s-grid gridTemplateColumns="repeat(auto-fill, minmax(260px, 1fr))" gap="base">
          {steps.map((step) => (
            <s-box key={step.key} border="base" borderRadius="base" padding="base">
              <StepRow step={step} runId={runId} onViewScreenshot={onViewScreenshot} />
            </s-box>
          ))}
        </s-grid>
      </s-stack>
    </s-box>
  );
}
