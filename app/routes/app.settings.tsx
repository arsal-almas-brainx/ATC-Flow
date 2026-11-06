import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import {
  adminPasswordSource,
  changeAdminPassword,
  renewSession,
  requireAdmin,
} from "../auth.server";
import { getAppSettings, saveAppSettings } from "../atc/app-settings.server";
import { pageSpeedKeyConfigured, testPageSpeedKey } from "../atc/speed.server";
import { parseSlackRecipients, slackBotConfigured, slackIdentity } from "../atc/slack.server";
import { MIN_PASSWORD_LENGTH } from "../password-hash.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireAdmin(request);
  const settings = await getAppSettings();
  const slackConfigured = await slackBotConfigured();
  return {
    deptHeadSlackRecipients: settings.deptHeadSlackRecipients?.replace(/,/g, ", ") ?? "",
    // Only whether secrets are set — never their values.
    slackConfigured,
    identity: slackConfigured ? await slackIdentity() : null,
    pageSpeedKey: pageSpeedKeyConfigured(),
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

  if (intent === "check-psi-key") {
    const error = await testPageSpeedKey();
    if (error) return result({ error: `Google rejected the key: ${error}` });
    return result({ message: "Google accepted the key." });
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
    slackConfigured,
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
            <s-badge tone={connected ? "success" : slackConfigured ? "critical" : "neutral"}>
              {connected ? "Connected" : slackConfigured ? "Not working" : "Not configured"}
            </s-badge>
            {identity?.ok && (
              <s-text color="subdued">
                {identity.bot} in {identity.team}
              </s-text>
            )}
          </s-stack>
          {identity && !identity.ok && (
            <s-banner tone="critical">
              <s-paragraph>Slack rejected the bot token: {identity.error}.</s-paragraph>
            </s-banner>
          )}
          <SecretNote envVar="SLACK_BOT_TOKEN" />
          <s-paragraph>
            <s-text color="subdued">
              The token is the Bot User OAuth Token (starts with xoxb-) from api.slack.com/apps →
              your app → OAuth &amp; Permissions. The app needs the chat:write and files:write
              permissions.
            </s-text>
          </s-paragraph>
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
              {pageSpeedKey ? "Set" : "Not set"}
            </s-badge>
          </s-stack>
          <SecretNote envVar="PAGESPEED_API_KEY" />
          <s-paragraph>
            <s-text color="subdued">
              Speed tests use Google PageSpeed Insights. Without a key Google allows only a few tests
              a day. To get a free key: console.cloud.google.com → create or pick a project → APIs
              &amp; Services → enable &quot;PageSpeed Insights API&quot; → Credentials → Create
              credentials → API key (restrict it to the PageSpeed Insights API).
            </s-text>
          </s-paragraph>
          {pageSpeedKey && (
            <Form method="post">
              <input type="hidden" name="intent" value="check-psi-key" />
              <s-stack direction="block" gap="base">
                {feedback("check-psi-key")}
                <s-stack direction="inline" gap="base">
                  <s-button type="submit" {...(busy("check-psi-key") ? { loading: true } : {})}>
                    Check key with Google
                  </s-button>
                </s-stack>
              </s-stack>
            </Form>
          )}
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
                A password changed here is stored only as a one-way hash, so it can&apos;t be shown or
                read back. Changing it signs out everyone else.
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

/** Where a secret lives: the server's .env file, so it's never in the database or the browser. */
function SecretNote({ envVar }: { envVar: string }) {
  return (
    <s-paragraph>
      <s-text color="subdued">
        Kept in the server&apos;s .env file as <s-text type="strong">{envVar}</s-text>, not on this
        page — it&apos;s never stored in the database or shown in the browser. To set or change it,
        edit .env and restart the app.
      </s-text>
    </s-paragraph>
  );
}
