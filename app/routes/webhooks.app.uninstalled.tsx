import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, session, topic } = await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  // Webhook requests can trigger multiple times and after an app has already been uninstalled.
  // If this webhook already ran, the session may have been deleted previously.
  if (session) {
    await db.session.deleteMany({ where: { shop } });
  }

  // Delete the shop's stored credentials unconditionally, not just when a
  // session is still present. ShopSetting holds the storefront password in
  // plain text (it has to be replayed to the password form) and the Storefront
  // API token, and neither has any use once the app is gone — keeping them on
  // disk after an uninstall is a credential leak, and a redelivery of this
  // webhook is exactly when the session is already gone.
  await db.shopSetting.deleteMany({ where: { shop } });
  await db.flowRun.deleteMany({ where: { shop } });

  return new Response();
};
