import { randomUUID } from "node:crypto";
import type { Store } from "@prisma/client";
import prisma from "../db.server.ts";
import { getAppSettings } from "./app-settings.server.ts";
import { productUrlList } from "./stores.server.ts";
import { resolveWebBotAuthCredentials } from "./web-bot-auth.server.ts";
import { runWithBrowserSession } from "./browser/launch.server.ts";
import { installWebBotAuthHeaders } from "./browser/web-bot-auth.server.ts";
import { unlockPasswordIfNeeded } from "./checks/storefront.server.ts";
import { pickProduct } from "./checks/product-pick.server.ts";
import type { Trigger } from "./types.ts";
import {
  ALERT_DROP,
  PAGE_LABEL,
  PAGES,
  type SpeedPage,
  type SpeedResult,
  type SpeedRunView,
  rate,
} from "./speed.ts";

/**
 * Speed test: Google PageSpeed Insights (the API behind pagespeed.web.dev) on
 * three pages — homepage, a collection, a product — each on mobile and
 * desktop. Google's servers do the loading, so the six requests run in
 * parallel and never touch this app's browser queue.
 *
 * PageSpeed can't get past a storefront password; a result that landed on
 * /password is reported as such rather than scored.
 */

const PSI_URL = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";
const PSI_TIMEOUT_MS = 120_000;

async function apiKey(): Promise<string | undefined> {
  return (await getAppSettings()).pageSpeedApiKey ?? process.env.PAGESPEED_API_KEY ?? undefined;
}

export async function pageSpeedKeySource(): Promise<"settings" | "env" | null> {
  if ((await getAppSettings()).pageSpeedApiKey) return "settings";
  return process.env.PAGESPEED_API_KEY ? "env" : null;
}

/** Tests a key with one cheap request before it is saved. */
export async function testPageSpeedKey(key: string): Promise<string | null> {
  const res = await fetch(
    `${PSI_URL}?${new URLSearchParams({ url: "https://www.google.com/", key, category: "performance" })}`,
    { signal: AbortSignal.timeout(PSI_TIMEOUT_MS) },
  ).catch(() => null);
  if (!res) return "couldn't reach Google";
  if (res.ok) return null;
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return body?.error?.message ?? `HTTP ${res.status}`;
}

/**
 * The three URLs a store's speed test measures. The product is the first
 * saved product URL; otherwise, with `discover`, the store's top in-stock
 * best seller, found in a real browser the same way the flow test finds one
 * (always the top one, so scores stay comparable run to run). Without
 * `discover` (page loads), or if that fails, the product the latest flow test
 * used. Null when none of those is known.
 */
export async function speedUrls(
  store: Store,
  { discover = false } = {},
): Promise<Record<SpeedPage, string | null>> {
  const saved = productUrlList(store)[0];
  const discovered = !saved && discover ? await topBestSeller(store) : null;
  const lastTested = saved || discovered
    ? null
    : await prisma.flowRun.findFirst({
        where: { storeId: store.id, productUrl: { not: "" } },
        orderBy: { startedAt: "desc" },
        select: { productUrl: true },
      });
  return {
    home: store.url,
    collection: store.speedCollectionUrl || `${store.url}/collections/all`,
    product: saved ?? discovered ?? lastTested?.productUrl ?? null,
  };
}

/** The store's top in-stock best seller, via a real Web-Bot-Auth-authorized browser. */
async function topBestSeller(store: Store): Promise<string | null> {
  const creds = resolveWebBotAuthCredentials(store);
  if (!creds) return null;
  try {
    return await runWithBrowserSession(async (page) => {
      await installWebBotAuthHeaders(page.context(), store.url, creds);
      await unlockPasswordIfNeeded(page, store.url, store.storefrontPassword ?? undefined);
      return (await pickProduct(page, store.url, [], { random: false })).productUrl;
    });
  } catch (err) {
    console.error(`[speed] couldn't find a best seller for ${store.name}`, err);
    return null;
  }
}

type PsiResponse = {
  lighthouseResult?: {
    finalDisplayedUrl?: string;
    finalUrl?: string;
    categories?: { performance?: { score?: number | null } };
    audits?: Record<string, { numericValue?: number }>;
    runtimeError?: { message?: string };
  };
  loadingExperience?: {
    metrics?: { INTERACTION_TO_NEXT_PAINT?: { percentile?: number } };
    overall_category?: string;
  };
  error?: { message?: string };
};

/**
 * One measurement, retried once when Google's side hiccups (a dropped
 * connection or a 5xx) — those are transient and say nothing about the store.
 */
async function measure(
  page: SpeedPage,
  device: "mobile" | "desktop",
  url: string,
  key: string | undefined,
): Promise<SpeedResult> {
  let result = await measureOnce(page, device, url, key);
  if (result.retryable) result = await measureOnce(page, device, url, key);
  delete result.retryable;
  return result;
}

async function measureOnce(
  page: SpeedPage,
  device: "mobile" | "desktop",
  url: string,
  key: string | undefined,
): Promise<SpeedResult & { retryable?: boolean }> {
  const base: SpeedResult = { page, device, url, reportUrl: pageSpeedLink(url, device) };
  const params = new URLSearchParams({ url, strategy: device, category: "performance" });
  if (key) params.set("key", key);

  let body: PsiResponse;
  try {
    const res = await fetch(`${PSI_URL}?${params}`, { signal: AbortSignal.timeout(PSI_TIMEOUT_MS) });
    body = (await res.json()) as PsiResponse;
    if (res.status === 429) {
      return {
        ...base,
        error: key
          ? "Google's daily limit for this API key is used up — try again tomorrow."
          : "Google's free limit without an API key is used up — add a PageSpeed API key in Settings.",
      };
    }
    if (!res.ok) {
      return {
        ...base,
        error: body.error?.message ?? `Google returned HTTP ${res.status}`,
        retryable: res.status >= 500,
      };
    }
  } catch (err) {
    return {
      ...base,
      error: err instanceof Error && err.name === "TimeoutError"
        ? "Google took more than 2 minutes to test this page"
        : `Couldn't reach Google PageSpeed: ${err instanceof Error ? err.message : err}`,
      retryable: !(err instanceof Error && err.name === "TimeoutError"),
    };
  }

  const lh = body.lighthouseResult;
  const landed = lh?.finalDisplayedUrl ?? lh?.finalUrl ?? url;
  if (/\/password(\?|$|\/)/.test(new URL(landed).pathname + new URL(landed).search)) {
    return {
      ...base,
      error: "The store is password protected, so Google measured the password page — no score.",
    };
  }
  if (lh?.runtimeError?.message) return { ...base, error: lh.runtimeError.message };

  const raw = lh?.categories?.performance?.score;
  if (raw == null) return { ...base, error: "Google returned no performance score for this page." };
  const score = Math.round(raw * 100);
  const audit = (id: string) => lh?.audits?.[id]?.numericValue;
  return {
    ...base,
    score,
    rating: rate(score),
    lcpMs: audit("largest-contentful-paint"),
    cls: audit("cumulative-layout-shift"),
    tbtMs: audit("total-blocking-time"),
    fcpMs: audit("first-contentful-paint"),
    fieldInpMs: body.loadingExperience?.metrics?.INTERACTION_TO_NEXT_PAINT?.percentile,
  };
}

export function pageSpeedLink(url: string, device: "mobile" | "desktop") {
  return `https://pagespeed.web.dev/analysis?${new URLSearchParams({ url, form_factor: device })}`;
}

/**
 * Starts a speed test for a store. Returns its id at once; `done` resolves
 * when all six measurements are back.
 */
export async function startSpeedRun(
  store: Store,
  trigger: Trigger = "manual",
): Promise<{ id: string; done: Promise<void> }> {
  const id = randomUUID();
  await prisma.speedRun.create({
    data: { id, storeId: store.id, trigger, status: "running", startedAt: new Date() },
  });

  const done = (async () => {
    // Finding the product can take a few seconds (a real browser), so it
    // happens after the run is saved — the UI shows it running straight away.
    const urls = await speedUrls(store, { discover: true });
    const key = await apiKey();
    const jobs = PAGES.flatMap((page) =>
      (["mobile", "desktop"] as const).map((device): Promise<SpeedResult> => {
        const url = urls[page];
        if (!url) {
          return Promise.resolve({
            page,
            device,
            url: "",
            error:
              "Couldn't find a product to test — check the store's Web Bot Auth signature, or save a product URL in its settings.",
          });
        }
        return measure(page, device, url, key);
      }),
    );
    const results = await Promise.all(jobs);
    await prisma.speedRun.update({
      where: { id },
      data: { status: "done", finishedAt: new Date(), results: JSON.stringify(results) },
    });
  })().catch(async (err) => {
    console.error("[speed] run failed", id, err);
    await prisma.speedRun
      .update({ where: { id }, data: { status: "done", finishedAt: new Date() } })
      .catch(() => {});
  });

  return { id, done };
}

function parse(raw: string): SpeedResult[] {
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

type SpeedRow = Awaited<ReturnType<typeof prisma.speedRun.findUniqueOrThrow>>;

function toView(row: SpeedRow, previous: SpeedRow | null): SpeedRunView {
  const results = parse(row.results);
  const before = previous ? parse(previous.results) : [];
  const alerts: string[] = [];
  for (const r of results) {
    if (r.score == null) continue;
    const label = `${PAGE_LABEL[r.page]} (${r.device === "mobile" ? "Mobile" : "Desktop"})`;
    const prev = before.find((p) => p.page === r.page && p.device === r.device)?.score;
    if (prev != null && prev - r.score >= ALERT_DROP) {
      alerts.push(`${label} dropped ${prev - r.score} points (${prev} → ${r.score})`);
    } else if (r.rating === "POOR") {
      alerts.push(`${label} is POOR (${r.score})`);
    }
  }
  return {
    id: row.id,
    storeId: row.storeId,
    trigger: row.trigger === "schedule" ? "schedule" : "manual",
    status: row.status === "done" ? "done" : "running",
    startedAt: row.startedAt.getTime(),
    finishedAt: row.finishedAt?.getTime(),
    results,
    alerts,
  };
}

/** One speed run, with alerts against the run before it. */
export async function getSpeedRun(id: string): Promise<SpeedRunView | null> {
  const row = await prisma.speedRun.findUnique({ where: { id } });
  if (!row) return null;
  const previous = await prisma.speedRun.findFirst({
    where: { storeId: row.storeId, status: "done", startedAt: { lt: row.startedAt } },
    orderBy: { startedAt: "desc" },
  });
  return toView(row, previous);
}

/** A store's speed history, newest first. */
export async function listSpeedRuns(storeId: string, take = 20): Promise<SpeedRunView[]> {
  const rows = await prisma.speedRun.findMany({
    where: { storeId },
    orderBy: { startedAt: "desc" },
    take: take + 1,
  });
  return rows.slice(0, take).map((row, i) => {
    const previous = rows.slice(i + 1).find((r) => r.status === "done") ?? null;
    return toView(row, previous);
  });
}
