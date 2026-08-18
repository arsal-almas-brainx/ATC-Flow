import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

/**
 * Mandatory compliance webhook: a customer has asked what data this app holds
 * about them.
 *
 * The answer is nothing. This app stores a shop's storefront password, a
 * Storefront API token, and its own run history — no customer records, and no
 * order or checkout ever reaches a customer. The carts it creates are anonymous
 * and abandoned. So there is nothing to gather and nothing to send, and
 * acknowledging that is the correct response.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop} — no customer data is stored`);
  return new Response();
};
