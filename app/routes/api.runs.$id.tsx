import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getRun } from "../atc/store.server";

/** Polled by the dashboard while a run is in flight. */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const run = await getRun(String(params.id));

  if (!run || run.shop !== session.shop) return { run: null };
  return { run };
};
