import { useState } from "react";
import type { Check } from "../atc/store.server";
import type { Device } from "../atc/types";
import { StatusBadge } from "./StatusBadge";
import { RunDetail } from "./RunDetail";
import { SlackSend } from "./SlackSend";

const DEVICE_LABEL: Record<Device, string> = { desktop: "Desktop", mobile: "Mobile" };

/** One check: switch between its desktop and mobile runs, and send it to Slack. */
export function CheckDetail({ check }: { check: Check }) {
  const [device, setDevice] = useState<Device>("desktop");
  const run = check.runs.find((r) => r.device === device) ?? check.runs[0];
  const settled = check.status !== "running" && check.status !== "queued";

  return (
    <>
      <s-section>
        <s-stack direction="block" gap="base">
          {check.runs.length > 1 && (
            <s-stack direction="inline" gap="small-200" alignItems="center">
              {check.runs.map((r) => (
                <s-button
                  key={r.id}
                  variant={r.device === run.device ? "primary" : "secondary"}
                  onClick={() => setDevice(r.device)}
                >
                  {DEVICE_LABEL[r.device]}
                </s-button>
              ))}
              {check.runs.map((r) => (
                <s-stack key={r.id} direction="inline" gap="small-100" alignItems="center">
                  <s-text color="subdued">{DEVICE_LABEL[r.device]}</s-text>
                  <StatusBadge status={r.status} />
                </s-stack>
              ))}
            </s-stack>
          )}
          {settled ? (
            <SlackSend key={check.id} checkId={check.id} />
          ) : (
            <s-text color="subdued">Send to Slack becomes available when both checks finish.</s-text>
          )}
        </s-stack>
      </s-section>
      <RunDetail
        key={run.id}
        run={run}
        label={check.runs.length > 1 ? DEVICE_LABEL[run.device] : undefined}
      />
    </>
  );
}
