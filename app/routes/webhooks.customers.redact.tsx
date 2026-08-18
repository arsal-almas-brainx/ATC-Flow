import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

/**
 * Mandatory compliance webhook: erase a customer's data.
 *
 * Nothing to erase — see webhooks.customers.data_request. Shopify still requires
 * the endpoint to exist and answer 200.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop} — no customer data is stored`);
  return new Response();
};
