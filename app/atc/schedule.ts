/**
 * Store check schedules. A schedule is a period (day / week / month), how many
 * times per period (1–3), and a start time in US Eastern time. Runs are spread
 * evenly through the period:
 *
 *   day   ×1: 09:00          ×2: 09:00, 21:00          ×3: 09:00, 17:00, 01:00
 *   week  ×1: Mon            ×2: Mon, Thu              ×3: Mon, Wed, Fri
 *   month ×1: 1st            ×2: 1st, 15th             ×3: 1st, 11th, 21st
 *
 * All calendar maths happens in America/New_York, so daylight saving is handled.
 * Pure — no I/O — so it is safe to import from the UI.
 */

export const SCHEDULE_TZ = "America/New_York";

export type SchedulePeriod = "day" | "week" | "month";

export type Schedule = {
  period: SchedulePeriod;
  /** Runs per period, 1–3. */
  frequency: number;
  /** Start time, "HH:MM" (24h) in Eastern time. */
  time: string;
};

const WEEK_DAYS: Record<number, number[]> = { 1: [0], 2: [0, 3], 3: [0, 2, 4] };
const MONTH_DAYS: Record<number, number[]> = { 1: [1], 2: [1, 15], 3: [1, 11, 21] };
const WEEKDAY_NAME = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const TIMES = { 1: "once", 2: "twice", 3: "three times" } as const;

export function parseTime(time: string): { h: number; m: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  return h < 24 && m < 60 ? { h, m } : null;
}

function clampFrequency(n: number): 1 | 2 | 3 {
  return (n >= 3 ? 3 : n <= 1 ? 1 : 2) as 1 | 2 | 3;
}

/** Year/month/day/weekday of an instant, as seen in Eastern time. */
function easternDate(at: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SCHEDULE_TZ,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(get("weekday"));
  return { y: Number(get("year")), mo: Number(get("month")), d: Number(get("day")), weekday };
}

/** Milliseconds Eastern time is ahead of UTC at `at` (negative: -4h or -5h). */
function easternOffset(at: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: SCHEDULE_TZ,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(at));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(at / 1000) * 1000;
}

/**
 * The instant that is y-mo-d h:m on an Eastern wall clock. Day and minute
 * overflow roll over (d = 32 is next month, minutes past 1440 are next day).
 */
function easternToUtc(y: number, mo: number, d: number, minutes: number): number {
  const wall = Date.UTC(y, mo - 1, d, 0, minutes);
  const first = wall - easternOffset(wall);
  // A correction pass settles instants near a daylight-saving switch…
  const second = wall - easternOffset(first);
  // …unless the wall time doesn't exist (clocks jump 2:00 → 3:00): then run
  // at the equivalent moment after the jump, the way a cron would.
  return second + easternOffset(second) === wall ? second : first;
}

/** Every run time in the period containing `after` and the one after it. */
function candidates(schedule: Schedule, after: Date): number[] {
  const t = parseTime(schedule.time) ?? { h: 9, m: 0 };
  const start = t.h * 60 + t.m;
  const n = clampFrequency(schedule.frequency);
  const today = easternDate(after);
  const out: number[] = [];

  if (schedule.period === "day") {
    for (const dayShift of [-1, 0, 1]) {
      for (let k = 0; k < n; k++) {
        out.push(easternToUtc(today.y, today.mo, today.d + dayShift, start + k * Math.round(1440 / n)));
      }
    }
  } else if (schedule.period === "week") {
    const monday = today.d - today.weekday;
    for (const weekShift of [0, 7]) {
      for (const offset of WEEK_DAYS[n]) {
        out.push(easternToUtc(today.y, today.mo, monday + weekShift + offset, start));
      }
    }
  } else {
    for (const monthShift of [0, 1]) {
      for (const day of MONTH_DAYS[n]) {
        out.push(easternToUtc(today.y, today.mo + monthShift, day, start));
      }
    }
  }
  return out;
}

/** The first scheduled run strictly after `after`. */
export function nextRunAfter(schedule: Schedule, after: Date): Date {
  const next = candidates(schedule, after)
    .filter((t) => t > after.getTime())
    .sort((a, b) => a - b)[0];
  return new Date(next);
}

function formatTime(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  const h = Math.floor(m / 60);
  return `${h % 12 || 12}:${String(m % 60).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/** e.g. "Twice a day, at 9:00 AM and 9:00 PM EST". */
export function describeSchedule(schedule: Schedule): string {
  const t = parseTime(schedule.time) ?? { h: 9, m: 0 };
  const start = t.h * 60 + t.m;
  const n = clampFrequency(schedule.frequency);
  const list = (items: string[]) =>
    items.length === 1 ? items[0] : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
  const times = TIMES[n];
  const cap = times[0].toUpperCase() + times.slice(1);

  if (schedule.period === "day") {
    const at = Array.from({ length: n }, (_, k) => formatTime(start + k * Math.round(1440 / n)));
    return `${cap} a day, at ${list(at)} EST`;
  }
  if (schedule.period === "week") {
    return `${cap} a week — ${list(WEEK_DAYS[n].map((d) => WEEKDAY_NAME[d]))} at ${formatTime(start)} EST`;
  }
  const ord = (d: number) => `${d}${d === 1 || d === 21 ? "st" : d === 2 ? "nd" : d === 3 ? "rd" : "th"}`;
  return `${cap} a month — on the ${list(MONTH_DAYS[n].map(ord))} at ${formatTime(start)} EST`;
}

export function formatEastern(at: Date | number): string {
  return new Date(at).toLocaleString("en-US", {
    timeZone: SCHEDULE_TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
