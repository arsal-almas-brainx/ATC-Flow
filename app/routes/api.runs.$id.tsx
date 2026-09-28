import type { LoaderFunctionArgs } from "react-router";
import { requireAdmin } from "../auth.server";
import { getRun } from "../atc/store.server";

/** Polled by the dashboard while a run is in flight. */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  await requireAdmin(request);
  return { run: await getRun(String(params.id)) };
};
