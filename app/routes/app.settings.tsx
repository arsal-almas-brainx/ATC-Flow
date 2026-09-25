import { useEffect, useRef } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { hasStorefrontPassword, saveStorefrontPassword } from "../atc/settings.server";
import {
  describeWebBotAuthStatus,
  saveWebBotAuthCredentials,
} from "../atc/web-bot-auth.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return {
    // Never send secret values back to the browser — only their status.
    passwordSaved: await hasStorefrontPassword(session.shop),
    webBotAuth: await describeWebBotAuthStatus(session.shop),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");

  if (intent === "save-password") {
    const saved = await saveStorefrontPassword(
      session.shop,
      String(form.get("storefrontPassword") ?? ""),
    );
    return {
      savedMessage: saved
        ? "Storefront password saved. Every check will use it automatically."
        : "Storefront password cleared.",
    };
  }

  if (intent === "save-web-bot-auth") {
    const signature = String(form.get("signature") ?? "");
    const signatureInput = String(form.get("signatureInput") ?? "");
    const expiresAt = String(form.get("expiresAt") ?? "").trim() || null;
    const saved = await saveWebBotAuthCredentials(session.shop, {
      signature,
      signatureInput,
      expiresAt,
    });
    return {
      wbaSavedMessage: saved
        ? "Web Bot Auth signature saved. The real-browser checks will use it automatically."
        : "Web Bot Auth signature cleared — the real-browser checks will be skipped.",
    };
  }

  return { error: "Unknown action." };
};

export default function Settings() {
  const { passwordSaved, webBotAuth } = useLoaderData<typeof loader>();
  const passwordSaver = useFetcher<typeof action>();
  const wbaSaver = useFetcher<typeof action>();
  const revalidator = useRevalidator();

  const passwordFormRef = useRef<HTMLFormElement>(null);
  const wbaFormRef = useRef<HTMLFormElement>(null);

  const savedMessage =
    passwordSaver.data && "savedMessage" in passwordSaver.data
      ? passwordSaver.data.savedMessage
      : null;
  useEffect(() => {
    if (savedMessage) revalidator.revalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedMessage]);

  const wbaSavedMessage =
    wbaSaver.data && "wbaSavedMessage" in wbaSaver.data ? wbaSaver.data.wbaSavedMessage : null;
  useEffect(() => {
    if (wbaSavedMessage) revalidator.revalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wbaSavedMessage]);

  const savePassword = () => {
    if (passwordFormRef.current) passwordSaver.submit(passwordFormRef.current, { method: "POST" });
  };
  const saveWebBotAuth = () => {
    if (wbaFormRef.current) wbaSaver.submit(wbaFormRef.current, { method: "POST" });
  };

  const wbaBadge = webBotAuth.expired
    ? { tone: "critical" as const, label: "Expired" }
    : webBotAuth.expiringSoon
      ? {
          tone: "warning" as const,
          label: `Expires in ${daysUntil(webBotAuth.expiresAt)}d`,
        }
      : webBotAuth.configured
        ? { tone: "success" as const, label: "Active" }
        : { tone: "neutral" as const, label: "Not configured" };

  const showWbaBanner = webBotAuth.expiringSoon || webBotAuth.expired;
  const expiresDefault = webBotAuth.expiresAt
    ? new Date(webBotAuth.expiresAt).toISOString().slice(0, 10)
    : "";

  return (
    <s-page heading="Settings">
      <s-section heading="Storefront password">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-text>Status:</s-text>
            <s-badge tone={passwordSaved ? "success" : "neutral"}>
              {passwordSaved ? "Saved" : "Not set"}
            </s-badge>
          </s-stack>

          <s-paragraph>
            The API checks work either way. Save the password (Online Store →
            Preferences → Password protection) to also cover the theme checks,
            which load the real product page.
          </s-paragraph>

          <form ref={passwordFormRef} onSubmit={(e) => e.preventDefault()}>
            <input type="hidden" name="intent" value="save-password" />
            <s-stack direction="block" gap="base">
              <s-password-field
                label="Storefront password"
                name="storefrontPassword"
                details="Leave blank and save to clear the stored password."
              />
              <s-stack direction="inline" gap="base">
                <s-button
                  onClick={savePassword}
                  {...(passwordSaver.state !== "idle" ? { loading: true } : {})}
                >
                  {passwordSaved ? "Update password" : "Save password"}
                </s-button>
              </s-stack>
              {savedMessage && (
                <s-banner tone="success" heading="Saved">
                  <s-paragraph>{savedMessage}</s-paragraph>
                </s-banner>
              )}
            </s-stack>
          </form>
        </s-stack>
      </s-section>

      <s-section heading="Web Bot Auth (real-browser checks)">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-text>Status:</s-text>
            <s-badge tone={wbaBadge.tone}>{wbaBadge.label}</s-badge>
          </s-stack>

          <s-paragraph>
            Authorizes a real Chromium browser to click the theme&apos;s actual Add-to-cart
            button, past Shopify&apos;s bot protection. Create a signature in Shopify Admin →
            Online Store → Preferences → Crawler access, then paste its three values below.
            There is no API to create or renew one — it expires after at most 3 months.
          </s-paragraph>

          {showWbaBanner && (
            <s-banner tone={webBotAuth.expired ? "critical" : "warning"} heading={wbaBadge.label}>
              <s-paragraph>
                {webBotAuth.expired
                  ? "This signature has expired, so the real-browser checks are being skipped. "
                  : "This signature is expiring soon — once it does, the real-browser checks will be skipped. "}
                Create a new one in Shopify Admin → Online Store → Preferences → Crawler access
                and paste it below.
              </s-paragraph>
            </s-banner>
          )}

          <form ref={wbaFormRef} onSubmit={(e) => e.preventDefault()}>
            <input type="hidden" name="intent" value="save-web-bot-auth" />
            <s-stack direction="block" gap="base">
              <s-password-field label="Signature" name="signature" details="From Shopify Admin's Crawler access page." />
              <s-password-field
                label="Signature-Input"
                name="signatureInput"
                details="From the same page, alongside Signature."
              />
              <s-date-field
                label="Expires"
                name="expiresAt"
                defaultValue={expiresDefault}
                details="The expiry date Shopify Admin showed for this signature."
              />
              <s-stack direction="inline" gap="base">
                <s-button
                  onClick={saveWebBotAuth}
                  {...(wbaSaver.state !== "idle" ? { loading: true } : {})}
                >
                  {webBotAuth.configured ? "Update signature" : "Save signature"}
                </s-button>
              </s-stack>
              {wbaSavedMessage && (
                <s-banner tone="success" heading="Saved">
                  <s-paragraph>{wbaSavedMessage}</s-paragraph>
                </s-banner>
              )}
            </s-stack>
          </form>
        </s-stack>
      </s-section>
    </s-page>
  );
}

function daysUntil(epochMs?: number): number {
  if (!epochMs) return 0;
  return Math.max(0, Math.ceil((epochMs - Date.now()) / 86_400_000));
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
