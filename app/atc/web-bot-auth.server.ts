import type { Store } from "@prisma/client";

/**
 * Web Bot Auth credential status, per store. Credentials are created manually
 * in the store's Shopify Admin → Online Store → Preferences → Crawler access
 * — there is no API to create or renew them — pasted into the store's
 * settings once, and every run resolves against the stored value.
 *
 * Signature-Agent is not part of this — it is the constant
 * "https://shopify.com", not merchant data.
 */

const EXPIRING_SOON_MS = 14 * 24 * 60 * 60 * 1000;

type WebBotAuthFields = Pick<
  Store,
  "webBotAuthSignature" | "webBotAuthSignatureInput" | "webBotAuthExpiresAt"
>;

export type WebBotAuthStatus = {
  configured: boolean;
  expiresAt?: number;
  expiringSoon: boolean;
  expired: boolean;
};

/**
 * The credentials to use for a run, or undefined when none are stored or they
 * have expired — an expired signature is exactly as useless as no signature.
 */
export function resolveWebBotAuthCredentials(
  store: WebBotAuthFields,
): { signature: string; signatureInput: string } | undefined {
  if (!store.webBotAuthSignature || !store.webBotAuthSignatureInput) return undefined;
  if (store.webBotAuthExpiresAt && store.webBotAuthExpiresAt.getTime() <= Date.now()) {
    return undefined;
  }
  return { signature: store.webBotAuthSignature, signatureInput: store.webBotAuthSignatureInput };
}

/** Status shape the settings UI renders directly — raw values never included. */
export function describeWebBotAuthStatus(store: WebBotAuthFields): WebBotAuthStatus {
  if (!store.webBotAuthSignature || !store.webBotAuthSignatureInput) {
    return { configured: false, expiringSoon: false, expired: false };
  }
  const expiresAt = store.webBotAuthExpiresAt?.getTime();
  const expired = expiresAt !== undefined && expiresAt <= Date.now();
  const expiringSoon =
    !expired && expiresAt !== undefined && expiresAt - Date.now() <= EXPIRING_SOON_MS;
  return { configured: true, expiresAt, expiringSoon, expired };
}
