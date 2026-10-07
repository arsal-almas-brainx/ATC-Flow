import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import prisma from "../db.server.ts";
import { screenshotRoot } from "./browser/screenshots.server.ts";
import type { RunStep } from "./types.ts";

/**
 * Data retention. Every check's results and every Slack send are kept for
 * good — they are the audit history. Only screenshots, which are what
 * actually takes up disk space, are deleted once they are older than
 * SCREENSHOT_RETENTION_DAYS (default 5). A step whose screenshot was removed
 * is marked so the report can say so.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export function retentionDays(): number {
  const days = Number(process.env.SCREENSHOT_RETENTION_DAYS);
  return Number.isFinite(days) && days > 0 ? days : 5;
}

export async function pruneScreenshots(now = Date.now()): Promise<{ runs: number; files: number }> {
  const cutoff = new Date(now - retentionDays() * DAY_MS);

  const rows = await prisma.flowRun.findMany({
    where: { startedAt: { lt: cutoff }, steps: { contains: '"screenshotPath"' } },
    select: { id: true, steps: true },
  });

  let files = 0;
  for (const row of rows) {
    let steps: RunStep[];
    try {
      steps = JSON.parse(row.steps);
    } catch {
      continue;
    }
    for (const step of steps) {
      if (!step.screenshotPath) continue;
      await rm(step.screenshotPath, { force: true });
      delete step.screenshotPath;
      step.screenshotExpired = true;
      files++;
    }
    await prisma.flowRun.update({ where: { id: row.id }, data: { steps: JSON.stringify(steps) } });
  }

  // Files no run points at any more (deleted stores, command-line runs).
  files += await removeOldFiles(screenshotRoot(), cutoff.getTime());

  return { runs: rows.length, files };
}

async function removeOldFiles(dir: string, cutoffMs: number): Promise<number> {
  let removed = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      removed += await removeOldFiles(full, cutoffMs);
    } else if (entry.name.endsWith(".jpg")) {
      const info = await stat(full).catch(() => null);
      if (info && info.mtimeMs < cutoffMs) {
        await rm(full, { force: true });
        removed++;
      }
    }
  }
  return removed;
}

declare global {
  // eslint-disable-next-line no-var
  var atcRetentionTimer: ReturnType<typeof setInterval> | undefined;
}

/** Prunes shortly after the server starts, then once a day. Safe to call more than once. */
export function startRetentionJob() {
  if (global.atcRetentionTimer) return;
  const run = () =>
    pruneScreenshots()
      .then(({ runs, files }) => {
        if (files) {
          console.log(`[retention] removed ${files} screenshot(s) older than ${retentionDays()} days (${runs} run(s))`);
        }
      })
      .catch((err) => console.error("[retention] prune failed", err));
  setTimeout(run, 60_000).unref?.();
  global.atcRetentionTimer = setInterval(run, DAY_MS);
  global.atcRetentionTimer.unref?.();
}
