import prisma from "../db.server";
import { mintStorefrontToken } from "./checker.server";

/**
 * Storefront API tokens are a limited per-shop resource, so one is minted on
 * first use and cached. If a cached token stops being accepted, `refresh`
 * discards it and mints a replacement.
 */
export async function getStorefrontToken(shop: string, adminToken: string): Promise<string> {
  const cached = await prisma.shopSetting.findUnique({ where: { shop } });
  if (cached?.storefrontApiToken) return cached.storefrontApiToken;
  return refreshStorefrontToken(shop, adminToken);
}

export async function refreshStorefrontToken(shop: string, adminToken: string): Promise<string> {
  const token = await mintStorefrontToken(shop, adminToken);
  await prisma.shopSetting.upsert({
    where: { shop },
    create: { shop, storefrontApiToken: token },
    update: { storefrontApiToken: token },
  });
  return token;
}
