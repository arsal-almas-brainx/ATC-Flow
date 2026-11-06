-- The Slack bot token and PageSpeed API key are env vars only (SLACK_BOT_TOKEN,
-- PAGESPEED_API_KEY); values saved through Settings are dropped.
ALTER TABLE "AppSetting" DROP COLUMN "slackBotToken";
ALTER TABLE "AppSetting" DROP COLUMN "pageSpeedApiKey";
