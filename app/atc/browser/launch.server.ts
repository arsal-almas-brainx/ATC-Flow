import type { Browser, BrowserContext, Page } from "playwright";

/**
 * Owns the one Chromium process every check shares.
 *
 * A run-per-launch model would pay Chromium's ~1-2s startup cost on every
 * run; a `BrowserContext` is cheap to create (~10-50ms) and gives one run its
 * own cookie/storage isolation, so one process is kept warm and a fresh
 * context is handed out per run.
 *
 * Concurrency is capped at one context at a time: this app runs on a single
 * small machine, and a second Chromium tab rendering concurrently risks OOM.
 * Every check is now browser-driven and shares one continuous page for its
 * entire run — home → product → search → cart → checkout → collection, one
 * real shopper's one session — so a run occupies this slot for its full
 * duration, not just a couple of quick steps. `runWithBrowserSession` is the
 * single entry point: it queues behind any run already in progress, hands
 * the caller one `Page` for the whole run, enforces a hard ceiling so one
 * stuck page can't block every other run indefinitely, and always releases
 * the context afterwards.
 */

let browser: Browser | null = null;
let launching: Promise<Browser> | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let queue: Promise<unknown> = Promise.resolve();

const IDLE_CLOSE_MS = 10 * 60 * 1000;

/** A run holding the browser slot longer than this is force-failed, not left to hang the queue forever. */
export const RUN_TIMEOUT_MS = 120_000;

function clearIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
}

function armIdleTimer() {
  clearIdleTimer();
  idleTimer = setTimeout(() => {
    void browser?.close().catch(() => {});
    browser = null;
  }, IDLE_CLOSE_MS);
}

async function getBrowser(): Promise<Browser> {
  if (browser) return browser;
  if (!launching) {
    launching = import("playwright").then(({ chromium }) =>
      chromium.launch({ headless: true }),
    );
  }
  browser = await launching;
  launching = null;
  return browser;
}

async function acquireBrowserContext(): Promise<{
  context: BrowserContext;
  release: () => Promise<void>;
}> {
  let resolveTurn: () => void;
  const myTurn = new Promise<void>((r) => (resolveTurn = r));
  const previous = queue;
  queue = myTurn;
  await previous;
  clearIdleTimer();

  const b = await getBrowser();
  const context = await b.newContext({
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) " +
      "Chrome/141.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });

  let released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await context.close().catch(() => {});
    armIdleTimer();
    resolveTurn();
  };
  return { context, release };
}

/**
 * Runs `fn` with one `Page` held for the entire call, queued in FIFO order
 * behind any run already using the browser. The context is always released
 * afterwards, success, failure, or timeout.
 */
export async function runWithBrowserSession<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const { context, release } = await acquireBrowserContext();
  try {
    const page = await context.newPage();
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`The browser check timed out after ${RUN_TIMEOUT_MS / 1000}s`));
      }, RUN_TIMEOUT_MS);
    });
    try {
      return await Promise.race([fn(page), timeout]);
    } finally {
      clearTimeout(timer!);
    }
  } finally {
    await release();
  }
}
