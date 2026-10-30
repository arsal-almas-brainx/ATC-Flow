import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import {
  adminPasswordSource,
  changeAdminPassword,
  renewSession,
  requireAdmin,
} from "../auth.server";
import {
  getAppSettings,
  saveAppSettings,
  savePageSpeedApiKey,
  saveSlackBotToken,
} from "../atc/app-settings.server";
import { pageSpeedKeySource, testPageSpeedKey } from "../atc/speed.server";
import { parseSlackRecipients, slackIdentity, slackTokenSource } from "../atc/slack.server";
import { MIN_PASSWORD_LENGTH } from "../password-hash.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireAdmin(request);
  const settings = await getAppSettings();
  const tokenSource = await slackTokenSource();
  return {
    deptHeadSlackRecipients: settings.deptHeadSlackRecipients?.replace(/,/g, ", ") ?? "",
    // Only where the token comes from — never the token itself.
    tokenSource,
    identity: tokenSource ? await slackIdentity() : null,
    pageSpeedKey: await pageSpeedKeySource(),
    passwordSource: await adminPasswordSource(),
    passwordChangedAt: settings.adminPasswordChangedAt?.getTime() ?? null,
    passwordJustChanged: new URL(request.url).searchParams.has("passwordChanged"),
    minPasswordLength: MIN_PASSWORD_LENGTH,
  };
};

type ActionResult = { intent: string; error?: string; message?: string };

export const action = async ({ request }: ActionFunctionArgs) => {
  await requireAdmin(request);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const result = (r: Omit<ActionResult, "intent">): ActionResult => ({ intent, ...r });

  if (intent === "save-dept-heads") {
    const heads = parseSlackRecipients(
      String(form.get("deptHeadSlackRecipients") ?? ""),
      "Department heads / team leads",
    );
    if ("error" in heads) return result({ error: heads.error });
    await saveAppSettings({ deptHeadSlackRecipients: heads.value });
    return result({ message: "Department heads / team leads saved." });
  }

  if (intent === "save-token") {
    const token = String(form.get("slackBotToken") ?? "").trim();
    if (!/^xoxb-/.test(token)) {
      return result({ error: "That isn't a bot token — it should start with xoxb-." });
    }
    // Test it with Slack before replacing a working one.
    const identity = await slackIdentity(token);
    if (!identity.ok) return result({ error: `Slack rejected this token: ${identity.error}.` });
    await saveSlackBotToken(token);
    return result({ message: `Connected to ${identity.team} as ${identity.bot}.` });
  }

  if (intent === "clear-token") {
    await saveSlackBotToken(null);
    return result({
      message: process.env.SLACK_BOT_TOKEN
        ? "Saved token removed — using the SLACK_BOT_TOKEN environment variable."
        : "Saved token removed — Slack is no longer connected.",
    });
  }

  if (intent === "save-psi-key") {
    const key = String(form.get("pageSpeedApiKey") ?? "").trim();
    if (!key) return result({ error: "Paste the API key first." });
    const error = await testPageSpeedKey(key);
    if (error) return result({ error: `Google rejected this key: ${error}` });
    await savePageSpeedApiKey(key);
    return result({ message: "PageSpeed API key saved." });
  }

  if (intent === "clear-psi-key") {
    await savePageSpeedApiKey(null);
    return result({ message: "Saved API key removed." });
  }

  if (intent === "change-password") {
    const error = await changeAdminPassword(
      String(form.get("currentPassword") ?? ""),
      String(form.get("newPassword") ?? ""),
      String(form.get("confirmPassword") ?? ""),
    );
    if (error) return result({ error });
    // A redirect is what reliably carries the renewed cookie to the browser.
    return redirect("/app/settings?passwordChanged=1", {
      headers: { "Set-Cookie": await renewSession(request) },
    });
  }

  return result({ error: "Unknown action." });
};

export default function Settings() {
  const {
    deptHeadSlackRecipients,
    tokenSource,
    identity,
    pageSpeedKey,
    passwordSource,
    passwordChangedAt,
    passwordJustChanged,
    minPasswordLength,
  } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = (intent: string) =>
    navigation.state === "submitting" && navigation.formData?.get("intent") === intent;
  const connected = identity?.ok === true;

  const feedback = (intent: string) =>
    result?.intent === intent ? (
      <s-banner tone={result.error ? "critical" : "success"}>
        <s-paragraph>{result.error ?? result.message}</s-paragraph>
      </s-banner>
    ) : null;

  return (
    <s-page heading="Settings">
      <s-link slot="breadcrumb-actions" href="/app">
        Stores
      </s-link>

      <s-section heading="Slack bot">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-text>Status:</s-text>
            <s-badge tone={connected ? "success" : tokenSource ? "critical" : "neutral"}>
              {connected ? "Connected" : tokenSource ? "Not working" : "Not configured"}
            </s-badge>
            {identity?.ok && (
              <s-text color="subdued">
                {identity.bot} in {identity.team}
                {tokenSource === "env" ? " · token from the SLACK_BOT_TOKEN environment variable" : ""}
              </s-text>
            )}
          </s-stack>
          {identity && !identity.ok && (
            <s-banner tone="critical">
              <s-paragraph>Slack rejected the bot token: {identity.error}.</s-paragraph>
            </s-banner>
          )}

          <Form method="post">
            <input type="hidden" name="intent" value="save-token" />
            <s-stack direction="block" gap="base">
              <s-password-field
                label={tokenSource === "settings" ? "Replace bot token" : "Bot token"}
                name="slackBotToken"
                placeholder="xoxb-…"
                details="From api.slack.com/apps → your app → OAuth & Permissions → Bot User OAuth Token. Needs chat:write and files:write. It's tested with Slack before saving and never shown again."
              />
              {feedback("save-token")}
              <s-stack direction="inline" gap="base">
                <s-button type="submit" {...(busy("save-token") ? { loading: true } : {})}>
                  Save token
                </s-button>
              </s-stack>
            </s-stack>
          </Form>

          {tokenSource === "settings" && (
            <Form method="post">
              <input type="hidden" name="intent" value="clear-token" />
              <s-stack direction="block" gap="base">
                {feedback("clear-token")}
                <s-stack direction="inline" gap="base">
                  <s-button type="submit" tone="critical" variant="tertiary">
                    Remove saved token
                  </s-button>
                </s-stack>
              </s-stack>
            </Form>
          )}
          {result?.intent === "clear-token" && tokenSource !== "settings" && feedback("clear-token")}
        </s-stack>
      </s-section>

      <s-section heading="Department heads / team leads">
        <Form method="post">
          <input type="hidden" name="intent" value="save-dept-heads" />
          <s-stack direction="block" gap="base">
            <s-text-field
              label="Slack IDs"
              name="deptHeadSlackRecipients"
              value={deptHeadSlackRecipients}
              placeholder="U0123ABCD, U0456EFGH, C0123ABCD"
              details="Receive every store's report. A member ID (U…) gets a direct message; a channel ID (C…) posts in that channel. Add several separated by commas."
            />
            <s-paragraph>
              <s-text color="subdued">
                Member ID: open the person&apos;s Slack profile → View full profile → ⋮ → Copy member ID
                (not the D… ID of your DM with them). Channel ID: open
                the channel&apos;s details — it&apos;s at the bottom; invite the bot to the channel. Each
                store&apos;s internal, client (external) and PDC/QA recipients are set in that
                store&apos;s settings.
              </s-text>
            </s-paragraph>
            {feedback("save-dept-heads")}
            <s-stack direction="inline" gap="base">
              <s-button type="submit" {...(busy("save-dept-heads") ? { loading: true } : {})}>
                Save
              </s-button>
            </s-stack>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading="Google PageSpeed">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-text>API key:</s-text>
            <s-badge tone={pageSpeedKey ? "success" : "neutral"}>
              {pageSpeedKey ? "Saved" : "Not set"}
            </s-badge>
            {pageSpeedKey === "env" && (
              <s-text color="subdued">from the PAGESPEED_API_KEY environment variable</s-text>
            )}
          </s-stack>
          <s-paragraph>
            <s-text color="subdued">
              Speed tests use Google PageSpeed Insights. Without a key Google allows only a few tests
              a day. To get a free key: console.cloud.google.com → create or pick a project → APIs
              &amp; Services → enable &quot;PageSpeed Insights API&quot; → Credentials → Create
              credentials → API key (restrict it to the PageSpeed Insights API).
            </s-text>
          </s-paragraph>
          <Form method="post">
            <input type="hidden" name="intent" value="save-psi-key" />
            <s-stack direction="block" gap="base">
              <s-password-field
                label={pageSpeedKey === "settings" ? "Replace API key" : "API key"}
                name="pageSpeedApiKey"
                details="Tested with Google before saving and never shown again."
              />
              {feedback("save-psi-key")}
              <s-stack direction="inline" gap="base">
                <s-button type="submit" {...(busy("save-psi-key") ? { loading: true } : {})}>
                  Save API key
                </s-button>
              </s-stack>
            </s-stack>
          </Form>
          {pageSpeedKey === "settings" && (
            <Form method="post">
              <input type="hidden" name="intent" value="clear-psi-key" />
              <s-stack direction="inline" gap="base">
                <s-button type="submit" tone="critical" variant="tertiary">
                  Remove saved key
                </s-button>
              </s-stack>
            </Form>
          )}
          {result?.intent === "clear-psi-key" && feedback("clear-psi-key")}
        </s-stack>
      </s-section>

      <s-section heading="Admin password">
        <Form method="post">
          <input type="hidden" name="intent" value="change-password" />
          <s-stack direction="block" gap="base">
            <s-paragraph>
              <s-text color="subdued">
                {passwordSource === "settings" && passwordChangedAt
                  ? `Last changed ${new Date(passwordChangedAt).toLocaleString()}.`
                  : "Currently the ADMIN_PASSWORD environment variable. Once changed here, that variable is no longer used."}{" "}
                Changing it signs out everyone else.
              </s-text>
            </s-paragraph>
            <s-password-field
              label="Current password"
              name="currentPassword"
              autocomplete="current-password"
            />
            <s-password-field
              label="New password"
              name="newPassword"
              autocomplete="new-password"
              details={`At least ${minPasswordLength} characters.`}
            />
            <s-password-field
              label="Confirm new password"
              name="confirmPassword"
              autocomplete="new-password"
            />
            {feedback("change-password")}
            {passwordJustChanged && result?.intent !== "change-password" && (
              <s-banner tone="success">
                <s-paragraph>Admin password changed. Everyone else has been signed out.</s-paragraph>
              </s-banner>
            )}
            <s-stack direction="inline" gap="base">
              <s-button type="submit" {...(busy("change-password") ? { loading: true } : {})}>
                Change password
              </s-button>
            </s-stack>
          </s-stack>
        </Form>
      </s-section>
    </s-page>
  );
}
