/**
 * Resets the admin password when nobody can sign in. Run on the server
 * (locally, or on Fly with `fly ssh console`):
 *
 *   npm run admin:reset-password -- "new password here"
 *   npm run admin:reset-password -- --clear     (go back to the ADMIN_PASSWORD env var)
 *
 * Either way every existing session is signed out.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { hashPassword, MIN_PASSWORD_LENGTH } = await import(
  path.join(here, "..", "app", "password-hash.server.ts")
);

const arg = process.argv[2];
if (!arg) {
  console.error('Usage: npm run admin:reset-password -- "new password"   |   -- --clear');
  process.exit(2);
}
if (arg !== "--clear" && arg.length < MIN_PASSWORD_LENGTH) {
  console.error(`The password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  process.exit(2);
}

const { PrismaClient } = await import("@prisma/client");
const db = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL || "file:dev.sqlite" });

const data = {
  adminPasswordHash: arg === "--clear" ? null : await hashPassword(arg),
  adminPasswordChangedAt: new Date(),
};
await db.appSetting.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
await db.$disconnect();

console.log(
  arg === "--clear"
    ? "Admin password reset to the ADMIN_PASSWORD environment variable. Everyone is signed out."
    : "Admin password changed. Everyone is signed out.",
);
