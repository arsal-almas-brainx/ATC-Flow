import prisma from "../db.server.ts";

const ID = 1;

export async function getAppSettings() {
  return (
    (await prisma.appSetting.findUnique({ where: { id: ID } })) ?? {
      id: ID,
      pdcSlackChannel: null,
      deptHeadSlackChannel: null,
      slackBotToken: null,
      pageSpeedApiKey: null,
      adminPasswordHash: null,
      adminPasswordChangedAt: null,
      updatedAt: new Date(0),
    }
  );
}

export function saveAppSettings(data: {
  pdcSlackChannel: string | null;
  deptHeadSlackChannel: string | null;
}) {
  return prisma.appSetting.upsert({
    where: { id: ID },
    create: { id: ID, ...data },
    update: data,
  });
}

export function saveSlackBotToken(token: string | null) {
  return prisma.appSetting.upsert({
    where: { id: ID },
    create: { id: ID, slackBotToken: token },
    update: { slackBotToken: token },
  });
}

export function savePageSpeedApiKey(key: string | null) {
  return prisma.appSetting.upsert({
    where: { id: ID },
    create: { id: ID, pageSpeedApiKey: key },
    update: { pageSpeedApiKey: key },
  });
}
