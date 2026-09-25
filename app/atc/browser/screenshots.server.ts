import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Where every step's screenshot lands. Defaults to a local, git-ignored
 * folder for dev; production sets SCREENSHOT_DIR to the mounted Fly volume
 * (/data/screenshots) so they survive restarts, the same way prod.sqlite does.
 */
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || path.join(process.cwd(), "screenshots");

/** Saves one step's screenshot (jpeg), returning the path it was written to. */
export async function saveScreenshot(
  shop: string,
  runId: string,
  stepKey: string,
  buf: Buffer,
): Promise<string> {
  const dir = path.join(SCREENSHOT_DIR, shop);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${runId}-${stepKey}.jpg`);
  await writeFile(file, buf);
  return file;
}

export function screenshotRoot(): string {
  return SCREENSHOT_DIR;
}
