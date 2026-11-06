import prisma from "../db.server.ts";

const ID = 1;

export async function getAppSettings() {
  return (
    (await prisma.appSetting.findUnique({ where: { id: ID } })) ?? {
      id: ID,
      deptHeadSlackRecipients: null,
      adminPasswordHash: null,
      adminPasswordChangedAt: null,
      updatedAt: new Date(0),
    }
  );
}

export function saveAppSettings(data: { deptHeadSlackRecipients: string | null }) {
  return prisma.appSetting.upsert({
    where: { id: ID },
    create: { id: ID, ...data },
    update: data,
  });
}
