import type { FlowRun, RunStep } from "../atc/types";

/**
 * One source of truth for status → tone/icon/label, replacing the separate
 * emoji map and run-level tone map that used to live in the route file.
 */
const STEP_STATUS = {
  pass: { tone: "success", icon: "check-circle-filled", label: "Passed" },
  warn: { tone: "warning", icon: "alert-triangle", label: "Warning" },
  fail: { tone: "critical", icon: "x-circle", label: "Failed" },
  running: { tone: "info", icon: "in-progress", label: "Running" },
  skip: { tone: "neutral", icon: "circle-dashed", label: "Skipped" },
  pending: { tone: "neutral", icon: "clock", label: "Pending" },
} as const satisfies Record<RunStep["status"], { tone: string; icon: string; label: string }>;

const RUN_STATUS: Record<
  FlowRun["status"],
  { tone: "success" | "warning" | "critical" | "info" | "neutral"; label: string }
> = {
  passed: { tone: "success", label: "Passed" },
  failed: { tone: "critical", label: "Failed" },
  running: { tone: "info", label: "Running" },
  queued: { tone: "neutral", label: "Queued" },
  skipped: { tone: "neutral", label: "Not configured" },
};

/** Run-level status badge. */
export function StatusBadge({ status }: { status: FlowRun["status"] }) {
  const s = RUN_STATUS[status];
  return <s-badge tone={s.tone}>{s.label}</s-badge>;
}

/** Step-level status badge: a real spinner while running, an icon+tone badge otherwise. */
export function StepStatusBadge({ status }: { status: RunStep["status"] }) {
  if (status === "running") {
    return (
      <s-stack direction="inline" gap="small-200" alignItems="center">
        <s-spinner size="base" accessibilityLabel="Running" />
        <s-badge tone="info">Running</s-badge>
      </s-stack>
    );
  }
  const s = STEP_STATUS[status];
  return (
    <s-badge tone={s.tone} icon={s.icon}>
      {s.label}
    </s-badge>
  );
}
