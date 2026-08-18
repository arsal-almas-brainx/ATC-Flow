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

/**
 * Used by the CLI check, which knows only the storefront host. Matches on the
 * host first; if nothing matches and exactly one shop is configured, use that.
 */
export async function resolvePasswordForHost(host: string): Promise<{
  password?: string;
  source?: string;
}> {
  const exact = await prisma.shopSetting.findUnique({ where: { shop: host } });
  if (exact?.storefrontPassword) {
    return { password: exact.storefrontPassword, source: host };
  }

  const all = await prisma.shopSetting.findMany({
    where: { storefrontPassword: { not: null } },
  });
  if (all.length === 1 && all[0].storefrontPassword) {
    return { password: all[0].storefrontPassword, source: all[0].shop };
  }
  return {};
}
