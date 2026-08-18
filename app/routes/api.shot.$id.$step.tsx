import { readFile } from "node:fs/promises";
import path from "node:path";
import type { LoaderFunctionArgs } from "react-router";
import { RUNS_DIR } from "../atc/runner.server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STEP = /^[a-z0-9-]{1,40}$/;

/**
 * Serves a step screenshot as an <img> source. Browsers don't send the App
 * Bridge session token on image requests, so access is gated on the run's
 * unguessable UUID rather than an admin session.
 */
export const loader = async ({ params }: LoaderFunctionArgs) => {
  const id = String(params.id);
  const step = String(params.step).replace(/\.png$/, "");

  if (!UUID.test(id) || !STEP.test(step)) {
    return new Response("Not found", { status: 404 });
  }

  try {
    const file = path.join(RUNS_DIR, id, `${step}.png`);
    const buf = await readFile(file);
    return new Response(new Uint8Array(buf), {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
};
