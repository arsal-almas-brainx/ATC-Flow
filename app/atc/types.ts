export type StepStatus = "pending" | "running" | "pass" | "fail" | "skip";

export type RunStep = {
  key: string;
  title: string;
  status: StepStatus;
  detail?: string;
  durationMs?: number;
  screenshot?: string;
};

export type RunStatus = "queued" | "running" | "passed" | "failed";

export type FlowRun = {
  id: string;
  shop: string;
  productUrl: string;
  quantity: number;
  status: RunStatus;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  cartTotal?: string;
  checkoutUrl?: string;
  steps: RunStep[];
};

export type RunOptions = {
  shop: string;
  productUrl: string;
  quantity?: number;
  storefrontPassword?: string;
  headless?: boolean;
};
