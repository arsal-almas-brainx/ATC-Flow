import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { requireAdmin } from "../auth.server";
import { getAppSettings, saveAppSettings } from "../atc/app-settings.server";
import { parseSlackChannel, slackBotConfigured, slackIdentity } from "../atc/slack.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await requireAdmin(request);
  const settings = await getAppSettings();
  return {
    pdcSlackChannel: settings.pdcSlackChannel ?? "",
    deptHeadSlackChannel: settings.deptHeadSlackChannel ?? "",
    botConfigured: slackBotConfigured(),
    identity: slackBotConfigured() ? await slackIdentity() : null,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  await requireAdmin(request);
  const form = await request.formData();

  const pdc = parseSlackChannel(String(form.get("pdcSlackChannel") ?? ""), "PDC channel");
  if ("error" in pdc) return { error: pdc.error };
  const head = parseSlackChannel(
    String(form.get("deptHeadSlackChannel") ?? ""),
    "Department head channel",
  );
  if ("error" in head) return { error: head.error };

  await saveAppSettings({ pdcSlackChannel: pdc.value, deptHeadSlackChannel: head.value });
  return { saved: true };
};

export default function Settings() {
  const { pdcSlackChannel, deptHeadSlackChannel, botConfigured, identity } =
    useLoaderData<typeof loader>();
  const connected = identity?.ok === true;
  const result = useActionData<typeof action>();
  const busy = useNavigation().state === "submitting";

  return (
    <s-page heading="Settings">
      <s-link slot="breadcrumb-actions" href="/app">
        Stores
      </s-link>

      <s-section heading="Slack">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-text>Slack bot:</s-text>
            <s-badge tone={connected ? "success" : botConfigured ? "critical" : "neutral"}>
              {connected ? "Connected" : botConfigured ? "Not working" : "Not configured"}
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
          {!botConfigured && (
            <s-paragraph>
              Reports are posted by a Slack bot. Set its token as the SLACK_BOT_TOKEN environment
              variable on the server and restart it. Then invite the bot to each channel below and
              to each client channel.
            </s-paragraph>
          )}

          <Form method="post">
            <s-stack direction="block" gap="base">
              <s-text-field
                label="PDC channel ID"
                name="pdcSlackChannel"
                value={pdcSlackChannel}
                placeholder="C0123ABCD"
                details="Receives every store's report."
              />
              <s-text-field
                label="Department head channel ID"
                name="deptHeadSlackChannel"
                value={deptHeadSlackChannel}
                placeholder="C0123ABCD"
                details="Receives every store's report."
              />
              <s-paragraph>
                <s-text color="subdued">
                  In Slack, open a channel&apos;s details — the Channel ID is at the bottom. Each
                  store&apos;s own client channel is set in that store&apos;s settings.
                </s-text>
              </s-paragraph>
              {result && "error" in result && (
                <s-banner tone="critical">
                  <s-paragraph>{result.error}</s-paragraph>
                </s-banner>
              )}
              {result && "saved" in result && (
                <s-banner tone="success">
                  <s-paragraph>Slack channels saved.</s-paragraph>
                </s-banner>
              )}
              <s-stack direction="inline" gap="base">
                <s-button type="submit" {...(busy ? { loading: true } : {})}>
                  Save
                </s-button>
              </s-stack>
            </s-stack>
          </Form>
        </s-stack>
      </s-section>
    </s-page>
  );
}
