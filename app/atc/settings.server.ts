import prisma from "../db.server";

/**
 * Storefront password persistence, so it only has to be typed once instead of
 * on every run. Saved per shop.
 */

export async function getStorefrontPassword(shop: string): Promise<string | null> {
  const row = await prisma.shopSetting.findUnique({ where: { shop } });
  return row?.storefrontPassword ?? null;
}

export async function hasStorefrontPassword(shop: string): Promise<boolean> {
  return (await getStorefrontPassword(shop)) !== null;
}

export async function saveStorefrontPassword(shop: string, password: string) {
  const value = password.trim() || null;
  await prisma.shopSetting.upsert({
    where: { shop },
    create: { shop, storefrontPassword: value },
    update: { storefrontPassword: value },
  });
  return value !== null;
}

/**
 * Resolves the password to use for a run: an explicitly supplied one wins,
 * otherwise fall back to whatever is saved for the shop.
 */
export async function resolveStorefrontPassword(
  shop: string,
  supplied?: string,
): Promise<string | undefined> {
  if (supplied?.trim()) return supplied.trim();
  return (await getStorefrontPassword(shop)) ?? undefined;
}
