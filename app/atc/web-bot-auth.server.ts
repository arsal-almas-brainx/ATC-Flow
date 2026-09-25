import prisma from "../db.server";

/**
 * Web Bot Auth credential persistence, per shop. Mirrors settings.server.ts:
 * a merchant pastes these once (created manually in Shopify Admin → Online
 * Store → Preferences → Crawler access — there is no API to create or renew
 * them), we store them, and every run resolves against the stored value.
 *
 * Signature-Agent is not part of this — it is the constant
 * "https://shopify.com", not merchant data.
 */

const EXPIRING_SOON_MS = 14 * 24 * 60 * 60 * 1000;

export type WebBotAuthCredentials = {
  signature: string;
  signatureInput: string;
  expiresAt: Date | null;
};

export type WebBotAuthStatus = {
  configured: boolean;
  expiresAt?: number;
  expiringSoon: boolean;
  expired: boolean;
};

export async function getWebBotAuthCredentials(
  shop: string,
): Promise<WebBotAuthCredentials | null> {
  const row = await prisma.shopSetting.findUnique({ where: { shop } });
  if (!row?.webBotAuthSignature || !row.webBotAuthSignatureInput) return null;
  return {
    signature: row.webBotAuthSignature,
    signatureInput: row.webBotAuthSignatureInput,
    expiresAt: row.webBotAuthExpiresAt,
  };
}

/** True only if a signature is stored and not past its expiry. */
export async function hasWebBotAuthCredentials(shop: string): Promise<boolean> {
  const creds = await getWebBotAuthCredentials(shop);
  if (!creds) return false;
  if (creds.expiresAt && creds.expiresAt.getTime() <= Date.now()) return false;
  return true;
}

export async function saveWebBotAuthCredentials(
  shop: string,
  input: { signature: string; signatureInput: string; expiresAt: string | null },
): Promise<boolean> {
  const signature = input.signature.trim() || null;
  const signatureInput = input.signatureInput.trim() || null;
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : null;
  await prisma.shopSetting.upsert({
    where: { shop },
    create: {
      shop,
      webBotAuthSignature: signature,
      webBotAuthSignatureInput: signatureInput,
      webBotAuthExpiresAt: expiresAt,
    },
    update: {
      webBotAuthSignature: signature,
      webBotAuthSignatureInput: signatureInput,
      webBotAuthExpiresAt: expiresAt,
    },
  });
  return signature !== null && signatureInput !== null;
}

/**
 * Resolves the credentials to use for a run: an explicitly supplied pair wins,
 * otherwise fall back to whatever is saved for the shop. Expired credentials
 * are not returned — callers see "not configured" either way, since an
 * expired signature is exactly as useless as no signature.
 */
export async function resolveWebBotAuthCredentials(
  shop: string,
  supplied?: { signature?: string; signatureInput?: string },
): Promise<{ signature: string; signatureInput: string } | undefined> {
  if (supplied?.signature?.trim() && supplied?.signatureInput?.trim()) {
    return { signature: supplied.signature.trim(), signatureInput: supplied.signatureInput.trim() };
  }
  const creds = await getWebBotAuthCredentials(shop);
  if (!creds) return undefined;
  if (creds.expiresAt && creds.expiresAt.getTime() <= Date.now()) return undefined;
  return { signature: creds.signature, signatureInput: creds.signatureInput };
}

/** Status shape the settings UI renders directly — raw values never included. */
export async function describeWebBotAuthStatus(shop: string): Promise<WebBotAuthStatus> {
  const creds = await getWebBotAuthCredentials(shop);
  if (!creds) return { configured: false, expiringSoon: false, expired: false };
  const expiresAt = creds.expiresAt?.getTime();
  const expired = expiresAt !== undefined && expiresAt <= Date.now();
  const expiringSoon = !expired && expiresAt !== undefined && expiresAt - Date.now() <= EXPIRING_SOON_MS;
  return { configured: true, expiresAt, expiringSoon, expired };
}
