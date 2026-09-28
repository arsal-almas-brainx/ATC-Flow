/**
 * Slack is reached through one bot (SLACK_BOT_TOKEN, a server secret — never
 * stored in the database). Channels are configured by ID; the bot must be
 * invited to each channel it posts to.
 */

export function slackBotConfigured(): boolean {
  return Boolean(process.env.SLACK_BOT_TOKEN);
}

/**
 * Accepts a channel ID (C…/G…), optionally pasted with a leading "#".
 * Returns null for blank input, or an error for anything that isn't an ID —
 * channel names break silently when a channel is renamed, IDs never change.
 */
export function parseSlackChannel(
  raw: string,
  label: string,
): { value: string | null } | { error: string } {
  const value = raw.trim().replace(/^#/, "").toUpperCase();
  if (!value) return { value: null };
  if (!/^[CG][A-Z0-9]{8,}$/.test(value)) {
    return {
      error:
        `${label} must be a Slack channel ID like C0123ABCD — in Slack, open the channel's ` +
        "details and copy the Channel ID at the bottom.",
    };
  }
  return { value };
}
