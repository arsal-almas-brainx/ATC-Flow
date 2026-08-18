import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClient;
}

// The Prisma CLI reads DATABASE_URL from prisma/.env, but the app server is
// started by the Shopify CLI, which does not necessarily forward it. Fall back
// to the same local path so a dev server always has a database.
const datasourceUrl = process.env.DATABASE_URL || "file:dev.sqlite";

const createClient = () => new PrismaClient({ datasourceUrl });

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = createClient();
  }
}

const prisma = global.prismaGlobal ?? createClient();

export default prisma;
