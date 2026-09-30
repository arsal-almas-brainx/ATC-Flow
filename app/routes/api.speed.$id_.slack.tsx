import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { requireAdmin } from "../auth.server";
import prisma from "../db.server";
import { getSpeedRun } from "../atc/speed.server";
import {
  AUDIENCES,
  buildSpeedReport,
  listDeliveries,
  previewText,
  sendSpeedReport,
  slackTargets,
  type Audience,
} from "../atc/report.server";
import { slackBotConfigured } from "../atc/slack.server";

/** Channels, a plain-text preview of the report, and past sends for one speed test. */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  await requireAdmin(request);
  const speed = await getSpeedRun(String(params.id));
  const store = speed ? await prisma.store.findUnique({ where: { id: speed.storeId } }) : null;
  if (!speed || !store) throw new Response("Not found", { status: 404 });

  return {
    botConfigured: await slackBotConfigured(),
    targets: (await slackTargets(store)).map((t) => ({
      audience: t.audience,
      label: t.label,
      configured: Boolean(t.channel),
    })),
    preview: previewText(buildSpeedReport(speed, store).blocks),
    deliveries: await listDeliveries({ speedRunId: speed.id }),
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  await requireAdmin(request);
  const form = await request.formData();
  const audiences = form
    .getAll("audience")
    .map(String)
    .filter((a): a is Audience => (AUDIENCES as readonly string[]).includes(a));
  return sendSpeedReport(String(params.id), audiences);
};
