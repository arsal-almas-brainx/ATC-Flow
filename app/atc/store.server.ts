import { randomUUID } from "node:crypto";
import prisma from "../db.server";
import { blankRun, runCheck } from "./checker.server";
import type { FlowRun, RunOptions } from "./types";

/**
 * Live runs are held in memory so the UI can poll step-by-step progress. Each
 * update is mirrored to SQLite so history survives a server restart.
 */
const live = new Map<string, FlowRun>();

/**
 * A run left in `running` by a server restart would otherwise be polled by the
 * UI forever. Anything older than this with no result is reported as failed.
 */
const STALE_AFTER_MS = 5 * 60_000;

export function startRun(opts: RunOptions): FlowRun {
  const id = randomUUID();
  const run = blankRun(id, opts);
  live.set(id, run);
  void persist(run);

  // Fire and forget — the UI polls getRun() for progress.
  void runCheck(run, opts, (updated) => {
    live.set(updated.id, { ...updated, steps: updated.steps.map((s) => ({ ...s })) });
    void persist(updated);
  })
    .catch((err) => {
      const current = live.get(id);
      if (current) {
        current.status = "failed";
        current.error = err instanceof Error ? err.message : String(err);
        current.finishedAt = Date.now();
        void persist(current);
      }
    })
    .finally(() => {
      // Keep the finished run in memory briefly, then fall back to the DB copy.
      setTimeout(() => live.delete(id), STALE_AFTER_MS).unref?.();
    });

  return run;
}

export async function getRun(id: string): Promise<FlowRun | null> {
  const inMemory = live.get(id);
  if (inMemory) return inMemory;

  const row = await prisma.flowRun.findUnique({ where: { id } });
  return row ? markStale(rowToRun(row)) : null;
}

export async function listRuns(shop: string, take = 20): Promise<FlowRun[]> {
  const rows = await prisma.flowRun.findMany({
    where: { shop },
    orderBy: { startedAt: "desc" },
    take,
  });
  return rows.map((row) => markStale(rowToRun(row)));
}

/** An unfinished run that is no longer in memory can never finish. */
function markStale(run: FlowRun): FlowRun {
  const unfinished = run.status === "queued" || run.status === "running";
  if (!unfinished || Date.now() - run.startedAt < STALE_AFTER_MS) return run;
  return {
    ...run,
    status: "failed",
    error: run.error ?? "The run was interrupted before it finished — start a new one.",
  };
}

async function persist(run: FlowRun) {
  const data = {
    shop: run.shop,
    productUrl: run.productUrl,
    quantity: run.quantity,
    status: run.status,
    startedAt: new Date(run.startedAt),
    finishedAt: run.finishedAt ? new Date(run.finishedAt) : null,
    error: run.error ?? null,
    cartTotal: run.cartTotal ?? null,
    checkoutUrl: run.checkoutUrl ?? null,
    steps: JSON.stringify(run.steps),
  };
  try {
    await prisma.flowRun.upsert({
      where: { id: run.id },
      create: { id: run.id, ...data },
      update: data,
    });
  } catch (err) {
    console.error("[atc] failed to persist run", run.id, err);
  }
}

type FlowRunRow = Awaited<ReturnType<typeof prisma.flowRun.findUniqueOrThrow>>;

function rowToRun(row: FlowRunRow): FlowRun {
  return {
    id: row.id,
    shop: row.shop,
    productUrl: row.productUrl,
    quantity: row.quantity,
    status: row.status as FlowRun["status"],
    startedAt: row.startedAt.getTime(),
    finishedAt: row.finishedAt?.getTime(),
    error: row.error ?? undefined,
    cartTotal: row.cartTotal ?? undefined,
    checkoutUrl: row.checkoutUrl ?? undefined,
    steps: safeParseSteps(row.steps),
  };
}

function safeParseSteps(raw: string): FlowRun["steps"] {
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}
