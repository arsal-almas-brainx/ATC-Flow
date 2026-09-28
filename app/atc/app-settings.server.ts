import prisma from "../db.server";

const ID = 1;

export async function getAppSettings() {
  return (
    (await prisma.appSetting.findUnique({ where: { id: ID } })) ?? {
      id: ID,
      pdcSlackChannel: null,
      deptHeadSlackChannel: null,
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
