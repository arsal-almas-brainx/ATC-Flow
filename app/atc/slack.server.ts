import { getAppSettings } from "./app-settings.server.ts";

/**
 * Slack is reached through one bot. Its token is saved in Settings, or — when
 * none is saved there — read from the SLACK_BOT_TOKEN env var. Channels are
 * configured by ID; the bot must be invited to each channel it posts to.
 * People are reached by member ID, as a direct message from the bot.
 */

export type TokenSource = "settings" | "env";

async function botToken(): Promise<{ token: string; source: TokenSource } | null> {
  const saved = (await getAppSettings()).slackBotToken;
  if (saved) return { token: saved, source: "settings" };
  if (process.env.SLACK_BOT_TOKEN) return { token: process.env.SLACK_BOT_TOKEN, source: "env" };
  return null;
}

export async function slackBotConfigured(): Promise<boolean> {
  return (await botToken()) !== null;
}

export async function slackTokenSource(): Promise<TokenSource | null> {
  return (await botToken())?.source ?? null;
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

/**
 * Accepts one or more Slack IDs separated by commas, spaces or new lines.
 * Channel IDs (C…/G…) post to the channel; member IDs (U…/W…) get a direct
 * message from the bot. Returns them comma-separated, or null for blank input.
 */
export function parseSlackRecipients(
  raw: string,
  label: string,
): { value: string | null } | { error: string } {
  const entries = raw.split(/[\s,]+/).filter(Boolean);
  // A DM's own ID (D…) is your conversation with that person — the bot isn't in it.
  const dm = entries.find((e) => /^D[A-Z0-9]{8,}$/i.test(e));
  if (dm) {
    return {
      error:
        `${label}: "${dm}" is the ID of your own DM with that person, which the bot can't post in. ` +
        "Use their member ID instead: open their profile → View full profile → ⋮ → Copy member ID (starts with U).",
    };
  }
  const bad = entries.find((e) => !/^[CGUW][A-Z0-9]{8,}$/.test(e.replace(/^[#@]/, "").toUpperCase()));
  if (bad) {
    return {
      error:
        `${label}: "${bad}" isn't a Slack ID. Use a channel ID like C0123ABCD (channel details → ` +
        "bottom) or a member ID like U0123ABCD (profile → View full profile → ⋮ → Copy member ID).",
    };
  }
  const ids = entries.map((e) => e.replace(/^[#@]/, "").toUpperCase());
  return { value: ids.length ? [...new Set(ids)].join(",") : null };
}

export function recipientList(value: string | null): string[] {
  return value ? value.split(",").filter(Boolean) : [];
}

/** Member IDs are sent as a direct message rather than to a channel. */
export const isMemberId = (id: string) => /^[UW]/.test(id);

type SlackResponse = { ok: boolean; error?: string; [key: string]: unknown };

/** Plain-language versions of the Slack errors a misconfiguration produces. */
const SLACK_ERRORS: Record<string, string> = {
  not_in_channel: "the bot isn't in this channel — type /invite @<bot name> in the channel",
  channel_not_found:
    "channel or member not found — check the ID, and for a private channel invite the bot first",
  user_not_found: "member not found — check the member ID",
  cannot_dm_bot: "that member ID belongs to a bot, which can't receive direct messages",
  invalid_auth: "the Slack bot token is invalid",
  not_authed: "no Slack bot token is set",
  account_inactive: "the Slack bot token belongs to an app that was removed",
  missing_scope: "the Slack app is missing a permission (needs chat:write and files:write)",
  is_archived: "the channel is archived",
};

export function describeSlackError(code: string | undefined): string {
  return (code && SLACK_ERRORS[code]) ?? `Slack error: ${code ?? "unknown"}`;
}

async function slackApi(
  method: string,
  body: Record<string, unknown>,
  form = false,
  tokenOverride?: string,
): Promise<SlackResponse> {
  const token = tokenOverride ?? (await botToken())?.token;
  if (!token) return { ok: false, error: "not_authed" };
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": form
        ? "application/x-www-form-urlencoded"
        : "application/json; charset=utf-8",
    },
    body: form
      ? new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)]))
      : JSON.stringify(body),
  });
  if (!res.ok) return { ok: false, error: `http_${res.status}` };
  return (await res.json()) as SlackResponse;
}

/**
 * Which workspace and bot a token belongs to — shown in Settings to confirm
 * the connection, and used to test a token before it is saved.
 */
export async function slackIdentity(token?: string): Promise<
  { ok: true; team: string; bot: string } | { ok: false; error: string }
> {
  const res = await slackApi("auth.test", {}, false, token);
  if (!res.ok) return { ok: false, error: describeSlackError(res.error) };
  return { ok: true, team: String(res.team ?? ""), bot: String(res.user ?? "") };
}

export async function postMessage(
  channel: string,
  message: { text: string; blocks?: unknown[] },
  threadTs?: string,
): Promise<{ ok: true; ts: string; channel: string } | { ok: false; error: string }> {
  // A member ID opens the bot's DM with that person; Slack replies with the
  // DM's own channel ID, which is what the screenshot upload needs.
  const res = await slackApi("chat.postMessage", {
    channel,
    text: message.text,
    blocks: message.blocks,
    unfurl_links: false,
    unfurl_media: false,
    ...(threadTs ? { thread_ts: threadTs } : {}),
  });
  if (!res.ok) return { ok: false, error: describeSlackError(res.error) };
  return { ok: true, ts: String(res.ts), channel: String(res.channel) };
}

/**
 * Uploads images into a thread using Slack's external-upload flow
 * (files.upload is retired): reserve an upload URL per file, send the bytes,
 * then share them all in one message.
 */
export async function uploadImagesToThread(
  channel: string,
  threadTs: string,
  files: Array<{ filename: string; title: string; data: Buffer }>,
  comment: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const uploaded: Array<{ id: string; title: string }> = [];
  for (const file of files) {
    const reserve = await slackApi(
      "files.getUploadURLExternal",
      { filename: file.filename, length: file.data.length },
      true,
    );
    if (!reserve.ok) return { ok: false, error: describeSlackError(reserve.error) };
    const put = await fetch(String(reserve.upload_url), {
      method: "POST",
      body: new Uint8Array(file.data),
    });
    if (!put.ok) return { ok: false, error: `screenshot upload failed (HTTP ${put.status})` };
    uploaded.push({ id: String(reserve.file_id), title: file.title });
  }
  if (uploaded.length === 0) return { ok: true };

  const done = await slackApi("files.completeUploadExternal", {
    files: uploaded,
    channel_id: channel,
    thread_ts: threadTs,
    initial_comment: comment,
  });
  if (!done.ok) return { ok: false, error: describeSlackError(done.error) };
  return { ok: true };
}
