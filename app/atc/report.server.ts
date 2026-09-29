import { readFile } from "node:fs/promises";
import type { Store } from "@prisma/client";
import prisma from "../db.server";
import { getAppSettings } from "./app-settings.server";
import { getRun } from "./store.server";
import { postMessage, slackBotConfigured, uploadImagesToThread } from "./slack.server";
import { NOT_REACHED } from "./checker.server";
import type { FlowRun, RunStep } from "./types";

export const AUDIENCES = ["client", "pdc", "dept-head"] as const;
export type Audience = (typeof AUDIENCES)[number];

const AUDIENCE_LABEL: Record<Audience, string> = {
  client: "Client channel",
  pdc: "PDC channel",
  "dept-head": "Department head channel",
};

export type SlackTarget = { audience: Audience; label: string; channel: string | null };

/** Every audience, with its configured channel (null when not set). */
export async function slackTargets(store: Pick<Store, "slackChannel">): Promise<SlackTarget[]> {
  const settings = await getAppSettings();
  const channel: Record<Audience, string | null> = {
    client: store.slackChannel,
    pdc: settings.pdcSlackChannel,
    "dept-head": settings.deptHeadSlackChannel,
  };
  return AUDIENCES.map((audience) => ({
    audience,
    label: AUDIENCE_LABEL[audience],
    channel: channel[audience],
  }));
}

const MAX_DETAIL = 280;
const MAX_SCREENSHOTS = 5;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Slack mrkdwn treats &, < and > as control characters. */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function headline(run: FlowRun): string {
  const warnings = run.steps.some((s) => s.status === "warn");
  switch (run.status) {
    case "passed":
      return warnings ? ":warning: Flow works, with warnings" : ":white_check_mark: All checks passed";
    case "failed":
      return ":x: The flow is broken";
    case "skipped":
      return ":double_vertical_bar: Not run — Web Bot Auth is not configured for this store";
    default:
      return ":hourglass: Still running";
  }
}

function issues(run: FlowRun): RunStep[] {
  return run.steps.filter((s) => s.status === "fail" || s.status === "warn");
}

/** The run's report as a Slack message: plain `text` for notifications, `blocks` for display. */
export function buildRunReport(run: FlowRun, store: Pick<Store, "name" | "url">) {
  const checkedAt = new Date(run.startedAt).toLocaleString("en-US", {
    timeZone: "America/New_York",
    dateStyle: "medium",
    timeStyle: "short",
  });
  const duration =
    run.finishedAt != null ? `${((run.finishedAt - run.startedAt) / 1000).toFixed(0)}s` : "—";
  const productPath = run.productUrl ? new URL(run.productUrl).pathname : null;

  const found = issues(run);
  const issueText = found.length
    ? found
        .map(
          (s) =>
            `${s.status === "fail" ? ":x:" : ":warning:"} *${esc(s.title)}* — ${esc(clip(s.detail ?? "", MAX_DETAIL))}`,
        )
        .join("\n")
    : run.status === "failed" && run.error
      ? `:x: ${esc(clip(run.error, MAX_DETAIL))}`
      : "None";

  const count = (st: RunStep["status"]) => run.steps.filter((s) => s.status === st).length;
  // Steps never reached because an earlier one failed aren't problems of their
  // own — count them separately so the report doesn't read like a list of faults.
  const notReached = run.steps.filter((s) => s.status === "skip" && s.detail === NOT_REACHED);
  const skipped = run.steps.filter((s) => s.status === "skip" && s.detail !== NOT_REACHED);
  const tally =
    `${run.steps.length} checks: ${count("pass")} passed` +
    (count("warn") ? ` · ${count("warn")} warning${count("warn") > 1 ? "s" : ""}` : "") +
    (count("fail") ? ` · ${count("fail")} failed` : "") +
    (skipped.length
      ? ` · ${skipped.length} skipped (${skipped.map((s) => s.title).join(", ")})`
      : "") +
    (notReached.length ? ` · ${notReached.length} not run because of the failure above` : "");

  const title = clip(`Store Check Report – ${store.name}`, 150);
  const appUrl = process.env.APP_URL?.replace(/\/$/, "");

  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: title } },
    { type: "section", text: { type: "mrkdwn", text: `*${headline(run)}*` } },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Store*\n<${store.url}|${esc(store.url.replace(/^https?:\/\//, ""))}>` },
        {
          type: "mrkdwn",
          text: `*Product tested*\n${productPath && run.productUrl ? `<${run.productUrl}|${esc(productPath)}>` : "—"}`,
        },
        { type: "mrkdwn", text: `*Checked*\n${checkedAt} EST` },
        { type: "mrkdwn", text: `*Duration*\n${duration}` },
      ],
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: clip(`*Issues found:*\n${issueText}`, 3000) },
    },
    { type: "context", elements: [{ type: "mrkdwn", text: clip(esc(tally), 3000) }] },
  ];
  if (appUrl) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `<${appUrl}/app/stores/${run.storeId}?run=${run.id}|View the full report with screenshots>`,
        },
      ],
    });
  }

  const text = `${title}: ${headline(run).replace(/:[a-z_]+: /, "")} — issues found: ${found.length || "none"}`;
  return { text, blocks };
}

export type DeliveryResult = { audience: Audience; label: string; ok: boolean; error?: string };

/**
 * Posts one run's report to the chosen audiences. Screenshots of failed or
 * warning steps go into a thread under the report. Every attempt — success or
 * failure — is recorded in SlackDelivery.
 */
export async function sendRunReport(
  runId: string,
  audiences: Audience[],
): Promise<{ error: string } | { results: DeliveryResult[] }> {
  if (!slackBotConfigured()) return { error: "Slack isn't connected — SLACK_BOT_TOKEN is not set." };

  const run = await getRun(runId);
  if (!run) return { error: "Run not found." };
  if (run.status === "queued" || run.status === "running") {
    return { error: "This check is still running — send it once it finishes." };
  }
  const store = await prisma.store.findUnique({ where: { id: run.storeId } });
  if (!store) return { error: "Store not found." };

  const targets = (await slackTargets(store)).filter((t) => audiences.includes(t.audience));
  if (targets.length === 0) return { error: "Pick at least one channel." };

  const message = buildRunReport(run, store);
  const shots = await loadIssueScreenshots(run);
  const results: DeliveryResult[] = [];

  for (const target of targets) {
    if (!target.channel) {
      results.push({ ...target, ok: false, error: "no channel ID is set" });
      continue;
    }
    const posted = await postMessage(target.channel, message);
    let error = posted.ok ? undefined : posted.error;
    if (posted.ok && shots.length > 0) {
      const up = await uploadImagesToThread(
        target.channel,
        posted.ts,
        shots,
        `Screenshots of the ${shots.length === 1 ? "step" : "steps"} with issues`,
      );
      if (!up.ok) error = `report posted, but screenshots failed: ${up.error}`;
    }
    await prisma.slackDelivery.create({
      data: {
        runId: run.id,
        audience: target.audience,
        channel: target.channel,
        ok: posted.ok,
        error: error ?? null,
        ts: posted.ok ? posted.ts : null,
      },
    });
    results.push({ audience: target.audience, label: target.label, ok: posted.ok && !error, error });
  }
  return { results };
}

async function loadIssueScreenshots(run: FlowRun) {
  const out: Array<{ filename: string; title: string; data: Buffer }> = [];
  for (const step of issues(run).slice(0, MAX_SCREENSHOTS)) {
    if (!step.screenshotPath) continue;
    const data = await readFile(step.screenshotPath).catch(() => null);
    if (data) out.push({ filename: `${step.key}.jpg`, title: step.title, data });
  }
  return out;
}

/** Recent Slack sends for a run, newest first — shown under the run's report. */
export async function listDeliveries(runId: string) {
  const rows = await prisma.slackDelivery.findMany({
    where: { runId },
    orderBy: { sentAt: "desc" },
    take: 20,
  });
  return rows.map((r) => ({
    audience: r.audience as Audience,
    label: AUDIENCE_LABEL[r.audience as Audience] ?? r.audience,
    ok: r.ok,
    error: r.error,
    sentAt: r.sentAt.getTime(),
  }));
}
