import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { requireAdmin } from "../auth.server";
import prisma from "../db.server";
import { getCheck } from "../atc/store.server";
import {
  AUDIENCES,
  buildCheckReport,
  listDeliveries,
  sendCheckReport,
  slackTargets,
  type Audience,
} from "../atc/report.server";
import { slackBotConfigured } from "../atc/slack.server";

/** Channels, a plain-text preview of the report, and past sends for one check. */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  await requireAdmin(request);
  const check = await getCheck(String(params.id));
  const store = check
    ? await prisma.store.findUnique({ where: { id: check.runs[0].storeId } })
    : null;
  if (!check || !store) throw new Response("Not found", { status: 404 });

  const { blocks } = buildCheckReport(check, store);
  return {
    botConfigured: await slackBotConfigured(),
    targets: (await slackTargets(store)).map((t) => ({
      audience: t.audience,
      label: t.label,
      configured: Boolean(t.channel),
    })),
    preview: previewText(blocks),
    deliveries: await listDeliveries(check),
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  await requireAdmin(request);
  const form = await request.formData();
  const audiences = form
    .getAll("audience")
    .map(String)
    .filter((a): a is Audience => (AUDIENCES as readonly string[]).includes(a));
  return sendCheckReport(String(params.id), audiences);
};

type Block = {
  type: string;
  text?: { text: string };
  fields?: Array<{ text: string }>;
  elements?: Array<{ text: string }>;
};

/** Rough plain-text rendering of the Slack blocks, so the preview shows the real content. */
function previewText(blocks: unknown[]): string {
  const unlink = (s: string) =>
    s
      .replace(/<([^|>]+)\|([^>]+)>/g, "$2")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/:white_check_mark:/g, "✅")
      .replace(/:x:/g, "❌")
      .replace(/:warning:/g, "⚠️")
      .replace(/:double_vertical_bar:/g, "⏸")
      .replace(/:hourglass:/g, "⏳")
      .replace(/\*/g, "");
  return (blocks as Block[])
    .map((b) => {
      if (b.fields) return b.fields.map((f) => unlink(f.text).replace("\n", ": ")).join("\n");
      if (b.elements) return b.elements.map((e) => unlink(e.text)).join(" ");
      return unlink(b.text?.text ?? "");
    })
    .join("\n\n");
}
