import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

/**
 * Mandatory compliance webhook. Shopify sends it 48 hours after an uninstall,
 * as the final instruction to erase everything held for the shop.
 *
 * `webhooks.app.uninstalled` already clears these, so this is normally a no-op —
 * which is the point: it is the backstop for an uninstall webhook that was never
 * delivered.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  await db.session.deleteMany({ where: { shop } });
  await db.shopSetting.deleteMany({ where: { shop } });
  await db.flowRun.deleteMany({ where: { shop } });

  return new Response();
};
