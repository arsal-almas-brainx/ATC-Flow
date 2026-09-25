import { useState } from "react";
import type { RunStep } from "../atc/types";
import { StepStatusBadge } from "./StatusBadge";
import { useAuthenticatedImage } from "./useAuthenticatedImage";

const INLINE_DETAIL_LIMIT = 80;

export function StepRow({
  step,
  runId,
  onViewScreenshot,
}: {
  step: RunStep;
  runId: string;
  onViewScreenshot?: (url: string, title: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const detail = step.detail ?? "";
  const long = detail.length > INLINE_DETAIL_LIMIT || detail.includes("\n");
  const screenshotUrl = step.screenshotPath ? `/api/screenshots/${runId}/${step.key}` : null;
  const thumbnailSrc = useAuthenticatedImage(screenshotUrl);

  return (
    <s-stack direction="block" gap="small-200">
      <s-stack direction="inline" gap="base" alignItems="center" justifyContent="space-between">
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <StepStatusBadge status={step.status} />
          <s-text type="strong">{step.title}</s-text>
        </s-stack>
        {step.durationMs != null && <s-text color="subdued">{step.durationMs}ms</s-text>}
      </s-stack>

      {screenshotUrl && thumbnailSrc && (
        <s-clickable onClick={() => onViewScreenshot?.(screenshotUrl, step.title)}>
          <s-thumbnail src={thumbnailSrc} alt={`Screenshot: ${step.title}`} size="large" />
        </s-clickable>
      )}

      {detail && !long && <s-text color="subdued">{detail}</s-text>}

      {detail && long && (
        <s-stack direction="block" gap="small-200">
          <s-clickable onClick={() => setExpanded((v) => !v)}>
            <s-stack direction="inline" gap="small-200" alignItems="center">
              <s-icon type={expanded ? "chevron-up" : "chevron-down"} size="small" color="subdued" />
              <s-text color="subdued">{expanded ? "Hide details" : "Show details"}</s-text>
            </s-stack>
          </s-clickable>
          {expanded && (
            <s-box background="subdued" borderRadius="base" padding="small-200">
              <s-text color="subdued">{detail}</s-text>
            </s-box>
          )}
        </s-stack>
      )}
    </s-stack>
  );
}
