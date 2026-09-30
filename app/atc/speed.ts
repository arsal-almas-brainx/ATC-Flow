/** Speed test shapes and rules shared by the server and the UI. */

export const PAGES = ["home", "collection", "product"] as const;
export type SpeedPage = (typeof PAGES)[number];

export const PAGE_LABEL: Record<SpeedPage, string> = {
  home: "Homepage",
  collection: "Collection",
  product: "Product",
};

export type Rating = "GOOD" | "AVERAGE" | "POOR";

/** A score drop this big since the previous test raises an alert. */
export const ALERT_DROP = 10;

/** Google's own bands: 90+ good, 50–89 needs improvement, under 50 poor. */
export function rate(score: number): Rating {
  return score >= 90 ? "GOOD" : score >= 50 ? "AVERAGE" : "POOR";
}

export type SpeedResult = {
  page: SpeedPage;
  device: "mobile" | "desktop";
  url: string;
  /** Google's full report for this page. */
  reportUrl?: string;
  /** Performance score 0–100. Absent when the page couldn't be measured. */
  score?: number;
  rating?: Rating;
  /** Largest Contentful Paint — when the main content has loaded. */
  lcpMs?: number;
  /** Cumulative Layout Shift — how much the layout jumps. */
  cls?: number;
  /** Total Blocking Time — how long the page is unresponsive while loading. */
  tbtMs?: number;
  /** First Contentful Paint. */
  fcpMs?: number;
  /** Interaction to Next Paint from real Chrome visitors, when Google has enough data. */
  fieldInpMs?: number;
  error?: string;
};

export type SpeedRunView = {
  id: string;
  storeId: string;
  trigger: "manual" | "schedule";
  status: "running" | "done";
  startedAt: number;
  finishedAt?: number;
  results: SpeedResult[];
  /** Pages that turned POOR or dropped ALERT_DROP+ points since the previous test. */
  alerts: string[];
};
