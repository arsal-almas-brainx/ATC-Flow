import { readFile } from "node:fs/promises";
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { getRun } from "../atc/store.server";

/**
 * Serves one step's screenshot. Never builds a filesystem path from the URL
 * itself — always resolves through the already shop-authorized run's own
 * `steps` array, so there is no path-traversal surface.
 */
export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const run = await getRun(String(params.runId));
  if (!run || run.shop !== session.shop) {
    throw new Response("Not found", { status: 404 });
  }

  const step = run.steps.find((s) => s.key === params.stepKey);
  if (!step?.screenshotPath) {
    throw new Response("Not found", { status: 404 });
  }

  const buf = await readFile(step.screenshotPath).catch(() => null);
  if (!buf) {
    throw new Response("Not found", { status: 404 });
  }

  // Each run gets a fresh id, so a given URL's image never changes once
  // written — safe to cache aggressively.
  return new Response(buf, {
    headers: {
      "Content-Type": "image/jpeg",
      "Cache-Control": "private, max-age=31536000, immutable",
    },
  });
};
