import type { LoaderFunctionArgs } from "react-router";
import { requireAdmin } from "../auth.server";
import { getCheck } from "../atc/store.server";

/** Polled by the dashboard while a check (desktop + mobile) is in flight. */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  await requireAdmin(request);
  return { check: await getCheck(String(params.id)) };
};
