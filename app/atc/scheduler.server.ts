import type { Store } from "@prisma/client";
import prisma from "../db.server";
import { nextRunAfter, parseTime, type Schedule, type SchedulePeriod } from "./schedule";
import { startCheck } from "./store.server";
import { runOptionsFor } from "./stores.server";
import { AUDIENCES, sendCheckReport, slackTargets } from "./report.server";
import { slackBotConfigured } from "./slack.server";
import { startSpeedRun } from "./speed.server";

/**
 * Runs scheduled checks. Once a minute, any store whose `nextRunAt` has
 * passed gets a flow check (desktop + mobile) and a speed test, and one
 * report covering both is posted to every configured Slack channel when they
 * finish. `nextRunAt` is moved on before
 * the check starts, so a slow check or a restart never runs it twice.
 *
 * A time missed while the server was down runs once when it comes back, then
 * the schedule carries on from the current time — missed runs don't pile up.
 */

const TICK_MS = 60_000;

export function scheduleOf(store: Pick<Store, "schedulePeriod" | "scheduleFrequency" | "scheduleTime">): Schedule {
  return {
    period: store.schedulePeriod as SchedulePeriod,
    frequency: store.scheduleFrequency,
    time: store.scheduleTime,
  };
}

/** Recomputes a store's next run after its schedule is changed. */
export async function refreshNextRun(storeId: string) {
  const store = await prisma.store.findUnique({ where: { id: storeId } });
  if (!store) return;
  await prisma.store.update({
    where: { id: storeId },
    data: {
      nextRunAt: store.scheduleEnabled ? nextRunAfter(scheduleOf(store), new Date()) : null,
    },
  });
}

export async function runDueChecks(now = new Date()): Promise<number> {
  const due = await prisma.store.findMany({
    where: { scheduleEnabled: true, nextRunAt: { lte: now } },
  });

  for (const store of due) {
    await prisma.store.update({
      where: { id: store.id },
      data: { lastScheduledAt: now, nextRunAt: nextRunAfter(scheduleOf(store), now) },
    });
    // Flow check and speed test together; one report once both are back.
    const flowDone = new Promise<string>((resolve) => {
      startCheck({ ...runOptionsFor(store), trigger: "schedule" }, resolve);
    });
    const speed = await startSpeedRun(store, "schedule").catch((err) => {
      console.error(`[scheduler] couldn't start ${store.name}'s speed test`, err);
      return null;
    });
    void Promise.all([flowDone, speed?.done]).then(([checkId]) =>
      postScheduledReport(store, checkId, speed?.id),
    );
    console.log(`[scheduler] started a scheduled check and speed test for ${store.name}`);
  }
  return due.length;
}

async function postScheduledReport(started: Store, checkId: string, speedRunId?: string) {
  if (!(await slackBotConfigured())) return;
  // Re-read the store: its channels may have changed while the check ran.
  const store = await prisma.store.findUnique({ where: { id: started.id } });
  if (!store) return;
  const audiences = (await slackTargets(store)).filter((t) => t.channel).map((t) => t.audience);
  if (audiences.length === 0) return;
  const result = await sendCheckReport(
    checkId,
    audiences.filter((a) => AUDIENCES.includes(a)),
    { speedRunId },
  );
  if ("error" in result) {
    console.error(`[scheduler] couldn't post ${store.name}'s report: ${result.error}`);
  } else {
    for (const r of result.results.filter((x) => !x.ok)) {
      console.error(`[scheduler] ${store.name} → ${r.label}: ${r.error}`);
    }
  }
}

declare global {
  // eslint-disable-next-line no-var
  var atcSchedulerTimer: ReturnType<typeof setInterval> | undefined;
}

/** Starts the once-a-minute scheduler. Safe to call more than once. */
export function startScheduler() {
  if (global.atcSchedulerTimer) return;
  const tick = () =>
    runDueChecks().catch((err) => console.error("[scheduler] tick failed", err));
  setTimeout(tick, 10_000).unref?.();
  global.atcSchedulerTimer = setInterval(tick, TICK_MS);
  global.atcSchedulerTimer.unref?.();
}

/** Validates the schedule fields of a store form (Add store and store settings). */
export function parseScheduleForm(form: FormData):
  | { error: string }
  | {
      data: {
        scheduleEnabled: boolean;
        schedulePeriod: string;
        scheduleFrequency: number;
        scheduleTime: string;
      };
    } {
  const period = String(form.get("period") ?? "day");
  const frequency = Number(form.get("frequency") ?? 1);
  const parsed = parseTime(String(form.get("time") ?? "").trim());
  if (!["day", "week", "month"].includes(period)) return { error: "Pick a routine." };
  if (![1, 2].includes(frequency)) return { error: "Pick once or twice." };
  if (!parsed) return { error: "Start time must be 24-hour HH:MM, e.g. 09:00 or 21:30." };
  return {
    data: {
      scheduleEnabled: form.get("enabled") === "on",
      schedulePeriod: period,
      scheduleFrequency: frequency,
      scheduleTime: `${String(parsed.h).padStart(2, "0")}:${String(parsed.m).padStart(2, "0")}`,
    },
  };
}
