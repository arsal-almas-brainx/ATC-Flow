import { readFile } from "node:fs/promises";
import type { Store } from "@prisma/client";
import prisma from "../db.server";
import { getAppSettings } from "./app-settings.server";
import { getCheck, type Check } from "./store.server";
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

const DEVICE_LABEL = { desktop: "Desktop", mobile: "Mobile" } as const;

function headline(check: Check): string {
  const warnings = check.runs.some((r) => r.steps.some((s) => s.status === "warn"));
  switch (check.status) {
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

const RUN_MARK = { passed: ":white_check_mark:", failed: ":x:", skipped: ":double_vertical_bar:" } as const;

function issues(run: FlowRun): RunStep[] {
  return run.steps.filter((s) => s.status === "fail" || s.status === "warn");
}

function issueLines(run: FlowRun): string {
  const found = issues(run);
  if (found.length) {
    return found
      .map(
        (s) =>
          `${s.status === "fail" ? ":x:" : ":warning:"} *${esc(s.title)}* — ${esc(clip(s.detail ?? "", MAX_DETAIL))}`,
      )
      .join("\n");
  }
  if (run.status === "failed" && run.error) return `:x: ${esc(clip(run.error, MAX_DETAIL))}`;
  return "None";
}

function tally(run: FlowRun): string {
  const count = (st: RunStep["status"]) => run.steps.filter((s) => s.status === st).length;
  // Steps never reached because an earlier one failed aren't problems of their
  // own — count them separately so the report doesn't read like a list of faults.
  const notReached = run.steps.filter((s) => s.status === "skip" && s.detail === NOT_REACHED);
  const skipped = run.steps.filter((s) => s.status === "skip" && s.detail !== NOT_REACHED);
  return (
    `${run.steps.length} checks: ${count("pass")} passed` +
    (count("warn") ? ` · ${count("warn")} warning${count("warn") > 1 ? "s" : ""}` : "") +
    (count("fail") ? ` · ${count("fail")} failed` : "") +
    (skipped.length ? ` · ${skipped.length} skipped (${skipped.map((s) => s.title).join(", ")})` : "") +
    (notReached.length ? ` · ${notReached.length} not run because of the failure above` : "")
  );
}

/** A check's report as a Slack message: plain `text` for notifications, `blocks` for display. */
export function buildCheckReport(check: Check, store: Pick<Store, "name" | "url">) {
  const checkedAt = new Date(check.startedAt).toLocaleString("en-US", {
    timeZone: "America/New_York",
    dateStyle: "medium",
    timeStyle: "short",
  });
  const finished = check.runs.map((r) => r.finishedAt).filter((t): t is number => t != null);
  const duration = finished.length
    ? `${((Math.max(...finished) - check.startedAt) / 1000).toFixed(0)}s`
    : "—";
  const productUrl = check.runs.find((r) => r.productUrl)?.productUrl;
  const productPath = productUrl ? new URL(productUrl).pathname : null;

  const title = clip(`Store Check Report – ${store.name}`, 150);
  const appUrl = process.env.APP_URL?.replace(/\/$/, "");
  const devices = check.runs.map((r) => DEVICE_LABEL[r.device]).join(" + ");

  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: title } },
    { type: "section", text: { type: "mrkdwn", text: `*${headline(check)}*` } },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Store*\n<${store.url}|${esc(store.url.replace(/^https?:\/\//, ""))}>` },
        {
          type: "mrkdwn",
          text: `*Product tested*\n${productPath && productUrl ? `<${productUrl}|${esc(productPath)}>` : "—"}`,
        },
        { type: "mrkdwn", text: `*Checked*\n${checkedAt} EST` },
        { type: "mrkdwn", text: `*Duration*\n${duration} (${devices})` },
      ],
    },
  ];

  const anyIssues = check.runs.some((r) => issueLines(r) !== "None");
  if (!anyIssues) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: "*Issues found:*\nNone" } });
  }
  for (const run of check.runs) {
    const mark = RUN_MARK[run.status as keyof typeof RUN_MARK] ?? ":hourglass:";
    if (anyIssues) {
      blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: clip(`*${mark} ${DEVICE_LABEL[run.device]} — issues found:*\n${issueLines(run)}`, 3000),
        },
      });
    }
    blocks.push({
      type: "context",
      elements: [{ type: "mrkdwn", text: clip(esc(`${DEVICE_LABEL[run.device]}: ${tally(run)}`), 3000) }],
    });
  }

  if (appUrl) {
    blocks.push({
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `<${appUrl}/app/stores/${check.runs[0].storeId}?check=${check.id}|View the full report with screenshots>`,
        },
      ],
    });
  }

  const count = check.runs.reduce((n, r) => n + issues(r).length, 0);
  const text = `${title}: ${headline(check).replace(/:[a-z_]+: /, "")} — issues found: ${count || "none"}`;
  return { text, blocks };
}

export type DeliveryResult = { audience: Audience; label: string; ok: boolean; error?: string };

/**
 * Posts one check's report to the chosen audiences. Screenshots of failed or
 * warning steps go into a thread under the report. Every attempt — success or
 * failure — is recorded in SlackDelivery, against the check's first run.
 */
export async function sendCheckReport(
  checkId: string,
  audiences: Audience[],
): Promise<{ error: string } | { results: DeliveryResult[] }> {
  if (!slackBotConfigured()) return { error: "Slack isn't connected — SLACK_BOT_TOKEN is not set." };

  const check = await getCheck(checkId);
  if (!check) return { error: "Check not found." };
  if (check.status === "running" || check.status === "queued") {
    return { error: "This check is still running — send it once it finishes." };
  }
  const store = await prisma.store.findUnique({ where: { id: check.runs[0].storeId } });
  if (!store) return { error: "Store not found." };

  const targets = (await slackTargets(store)).filter((t) => audiences.includes(t.audience));
  if (targets.length === 0) return { error: "Pick at least one channel." };

  const message = buildCheckReport(check, store);
  const shots = await loadIssueScreenshots(check);
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
        runId: check.runs[0].id,
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

async function loadIssueScreenshots(check: Check) {
  const out: Array<{ filename: string; title: string; data: Buffer }> = [];
  for (const run of check.runs) {
    for (const step of issues(run)) {
      if (out.length >= MAX_SCREENSHOTS || !step.screenshotPath) continue;
      const data = await readFile(step.screenshotPath).catch(() => null);
      const device = DEVICE_LABEL[run.device];
      if (data) out.push({ filename: `${run.device}-${step.key}.jpg`, title: `${device} — ${step.title}`, data });
    }
  }
  return out;
}

/** Recent Slack sends for a check, newest first — shown under its report. */
export async function listDeliveries(check: Check) {
  const rows = await prisma.slackDelivery.findMany({
    where: { runId: { in: check.runs.map((r) => r.id) } },
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
