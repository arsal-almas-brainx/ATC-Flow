import type { LoaderFunctionArgs } from "react-router";
import { requireAdmin } from "../auth.server";
import { getSpeedRun } from "../atc/speed.server";

/** Polled by the Speed tab while a speed test is running. */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  await requireAdmin(request);
  return { speed: await getSpeedRun(String(params.id)) };
};
