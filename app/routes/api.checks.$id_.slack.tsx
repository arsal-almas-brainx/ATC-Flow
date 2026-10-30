import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { requireAdmin } from "../auth.server";
import prisma from "../db.server";
import { getCheck } from "../atc/store.server";
import {
  AUDIENCES,
  buildCheckReport,
  listDeliveries,
  previewText,
  sendCheckReport,
  slackTargetOptions,
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
    targets: await slackTargetOptions(store),
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
