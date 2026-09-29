import { rm } from "node:fs/promises";
import path from "node:path";
import type { Store } from "@prisma/client";
import prisma from "../db.server";
import { resolveWebBotAuthCredentials } from "./web-bot-auth.server";
import { screenshotRoot } from "./browser/screenshots.server";
import { parseSlackChannel } from "./slack.server";
import type { RunOptions } from "./types";

/** Raw form values. Optional fields may be omitted (e.g. the quick "Add a store" form). */
export type StoreInput = {
  name: string;
  url: string;
  productUrls: string;
  discountCode?: string;
  searchQuery?: string;
  slackChannel?: string;
};

export type StoreData = {
  name: string;
  url: string;
  productUrls: string;
  discountCode: string | null;
  searchQuery: string | null;
  slackChannel: string | null;
};

export function listStores() {
  return prisma.store.findMany({ orderBy: { name: "asc" } });
}

export function getStore(id: string) {
  return prisma.store.findUnique({ where: { id } });
}

export function productUrlList(store: Pick<Store, "productUrls">): string[] {
  return store.productUrls
    .split(/\r?\n/)
    .map((u) => u.trim())
    .filter(Boolean);
}

/** Returns an error message, or the cleaned values ready to save. */
export function validateStoreInput(
  input: StoreInput,
): { error: string } | { data: StoreData } {
  const name = input.name.trim();
  if (!name) return { error: "Give the store a name." };

  let url: string;
  try {
    const parsed = new URL(input.url.trim());
    if (!/^https?:$/.test(parsed.protocol)) throw new Error();
    url = parsed.origin;
  } catch {
    return { error: "Store URL must be a full URL, e.g. https://example.com" };
  }

  const products = input.productUrls
    .split(/\r?\n/)
    .map((u) => u.trim())
    .filter(Boolean);
  for (const p of products) {
    let parsed: URL;
    try {
      parsed = new URL(p);
    } catch {
      return { error: `Not a valid URL: ${p}` };
    }
    if (parsed.origin !== url) return { error: `${p} is not on ${url}` };
    if (!/\/products\/[^/]+/.test(parsed.pathname)) {
      return { error: `${p} is not a product URL (…/products/<handle>)` };
    }
  }

  const slack = parseSlackChannel(input.slackChannel ?? "", "Client Slack channel");
  if ("error" in slack) return { error: slack.error };

  return {
    data: {
      name,
      url,
      productUrls: products.join("\n"),
      discountCode: input.discountCode?.trim() || null,
      searchQuery: input.searchQuery?.trim() || null,
      slackChannel: slack.value,
    },
  };
}

export function createStore(data: StoreData) {
  return prisma.store.create({ data });
}

export function updateStore(id: string, data: StoreData) {
  return prisma.store.update({ where: { id }, data });
}

export async function deleteStore(id: string) {
  await prisma.store.delete({ where: { id } });
  await rm(path.join(screenshotRoot(), id), { recursive: true, force: true });
}

export async function saveStorefrontPassword(id: string, password: string) {
  const value = password.trim() || null;
  await prisma.store.update({ where: { id }, data: { storefrontPassword: value } });
  return value !== null;
}

export async function saveWebBotAuthCredentials(
  id: string,
  input: { signature: string; signatureInput: string; expiresAt: string | null },
): Promise<boolean> {
  const signature = input.signature.trim() || null;
  const signatureInput = input.signatureInput.trim() || null;
  await prisma.store.update({
    where: { id },
    data: {
      webBotAuthSignature: signature,
      webBotAuthSignatureInput: signatureInput,
      webBotAuthExpiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
    },
  });
  return signature !== null && signatureInput !== null;
}

/**
 * Builds the checker's options from a store's saved config. Per-run overrides
 * (a different product, quantity, or discount code) win over saved values.
 */
export function runOptionsFor(
  store: Store,
  overrides: { productUrl?: string; quantity?: number; discountCode?: string } = {},
): RunOptions {
  const webBotAuth = resolveWebBotAuthCredentials(store);
  return {
    storeId: store.id,
    storeUrl: store.url,
    productUrl: overrides.productUrl || undefined,
    productPool: productUrlList(store),
    quantity: overrides.quantity ?? 1,
    discountCode: overrides.discountCode || store.discountCode || undefined,
    searchQuery: store.searchQuery ?? undefined,
    storefrontPassword: store.storefrontPassword ?? undefined,
    webBotAuthSignature: webBotAuth?.signature,
    webBotAuthSignatureInput: webBotAuth?.signatureInput,
  };
}
