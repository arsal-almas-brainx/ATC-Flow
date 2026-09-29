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

export type Check = {
  /** The group id, or the run id for runs from before desktop + mobile. */
  id: string;
  status: FlowRun["status"];
  startedAt: number;
  trigger: FlowRun["trigger"];
  runs: FlowRun[];
};

/**
 * One "Run check": a desktop run, then a mobile run of the same product.
 * Both are created up front so the UI can show them straight away; they run
 * one after the other (the browser takes one session at a time anyway).
 */
export function startCheck(opts: RunOptions, onComplete?: (checkId: string) => void): Check {
  const groupId = randomUUID();
  const desktopOpts: RunOptions = { ...opts, device: "desktop", groupId };
  const desktop = register(blankRun(randomUUID(), desktopOpts));
  const mobile = register(blankRun(randomUUID(), { ...opts, device: "mobile", groupId }));

  void (async () => {
    const done = await execute(desktop, desktopOpts);
    const sameProduct = !opts.productUrl && done.productUrl;
    await execute(mobile, {
      ...opts,
      device: "mobile",
      groupId,
      productUrl: opts.productUrl || done.productUrl || undefined,
      productNote: sameProduct ? "Same product as the desktop check" : undefined,
    });
    onComplete?.(groupId);
  })().catch((err) => console.error("[atc] check failed to run", groupId, err));

  return toCheck(groupId, [desktop, mobile]);
}

function register(run: FlowRun): FlowRun {
  live.set(run.id, run);
  void persist(run);
  return run;
}

async function execute(run: FlowRun, opts: RunOptions): Promise<FlowRun> {
  try {
    await runCheck(run, opts, (updated) => {
      live.set(updated.id, { ...updated, steps: updated.steps.map((s) => ({ ...s })) });
      void persist(updated);
    });
  } catch (err) {
    run.status = "failed";
    run.error = err instanceof Error ? err.message : String(err);
    run.finishedAt = Date.now();
    live.set(run.id, run);
    void persist(run);
  } finally {
    // Keep the finished run in memory briefly, then fall back to the DB copy.
    setTimeout(() => live.delete(run.id), STALE_AFTER_MS).unref?.();
  }
  return run;
}

const DEVICE_ORDER = { desktop: 0, mobile: 1 } as const;

function toCheck(id: string, runs: FlowRun[]): Check {
  const sorted = [...runs].sort((a, b) => DEVICE_ORDER[a.device] - DEVICE_ORDER[b.device]);
  const statuses = sorted.map((r) => r.status);
  const status: FlowRun["status"] = statuses.some((s) => s === "queued" || s === "running")
    ? "running"
    : statuses.includes("failed")
      ? "failed"
      : statuses.every((s) => s === "skipped")
        ? "skipped"
        : "passed";
  return {
    id,
    status,
    startedAt: Math.min(...sorted.map((r) => r.startedAt)),
    trigger: sorted[0].trigger,
    runs: sorted,
  };
}

/** A check by group id, or a single pre-grouping run by its own id. */
export async function getCheck(id: string): Promise<Check | null> {
  const rows = await prisma.flowRun.findMany({ where: { OR: [{ groupId: id }, { id }] } });
  if (rows.length === 0) return null;
  const runs = rows.map((row) => live.get(row.id) ?? markStale(rowToRun(row)));
  return toCheck(id, runs);
}

/** The most recent checks for a store, newest first. */
export async function listChecks(storeId: string, take = 10): Promise<Check[]> {
  const rows = await prisma.flowRun.findMany({
    where: { storeId },
    orderBy: { startedAt: "desc" },
    take: take * 2,
  });
  const groups = new Map<string, FlowRun[]>();
  for (const row of rows) {
    const run = live.get(row.id) ?? markStale(rowToRun(row));
    const key = run.groupId ?? run.id;
    groups.set(key, [...(groups.get(key) ?? []), run]);
  }
  return [...groups.entries()]
    .map(([id, runs]) => toCheck(id, runs))
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, take);
}

export async function getRun(id: string): Promise<FlowRun | null> {
  const inMemory = live.get(id);
  if (inMemory) return inMemory;

  const row = await prisma.flowRun.findUnique({ where: { id } });
  return row ? markStale(rowToRun(row)) : null;
}

export async function listRuns(storeId: string, take = 20): Promise<FlowRun[]> {
  const rows = await prisma.flowRun.findMany({
    where: { storeId },
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
    storeId: run.storeId,
    productUrl: run.productUrl,
    device: run.device,
    trigger: run.trigger,
    groupId: run.groupId ?? null,
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
    storeId: row.storeId,
    productUrl: row.productUrl,
    device: row.device === "mobile" ? "mobile" : "desktop",
    trigger: row.trigger === "schedule" ? "schedule" : "manual",
    groupId: row.groupId ?? undefined,
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
