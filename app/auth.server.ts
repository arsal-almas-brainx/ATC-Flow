import { createHash, timingSafeEqual } from "node:crypto";
import { createCookieSessionStorage, redirect } from "react-router";
import prisma from "./db.server";
import { getAppSettings } from "./atc/app-settings.server";
import { MIN_PASSWORD_LENGTH, hashPassword, verifyPassword } from "./password-hash.server";

/**
 * Single shared admin password for the super admin, with a signed session
 * cookie (SESSION_SECRET). There are no user accounts — the people using this
 * are the internal team.
 *
 * The password is the one set in Settings (stored as an scrypt hash). Until
 * one is set there, it is the ADMIN_PASSWORD env var. Changing it signs out
 * every existing session. Forgotten? `npm run admin:reset-password`.
 */

const SESSION_MAX_AGE = 60 * 60 * 24 * 14;

const sessionStorage = createCookieSessionStorage({
  cookie: {
    name: "__atc_admin",
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_MAX_AGE,
    secrets: [process.env.SESSION_SECRET || "dev-only-insecure-secret"],
  },
});

if (process.env.NODE_ENV === "production" && !process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET must be set in production.");
}

export async function adminPasswordConfigured(): Promise<boolean> {
  return Boolean((await getAppSettings()).adminPasswordHash || process.env.ADMIN_PASSWORD);
}

/** Where the current password comes from — shown in Settings. */
export async function adminPasswordSource(): Promise<"settings" | "env" | null> {
  if ((await getAppSettings()).adminPasswordHash) return "settings";
  return process.env.ADMIN_PASSWORD ? "env" : null;
}

export async function checkAdminPassword(candidate: string): Promise<boolean> {
  const { adminPasswordHash } = await getAppSettings();
  if (adminPasswordHash) return verifyPassword(candidate, adminPasswordHash);
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return false;
  // Hash both sides so the comparison is constant-time regardless of length.
  const a = createHash("sha256").update(candidate).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** Returns an error message, or null once the new password is saved. */
export async function changeAdminPassword(
  current: string,
  next: string,
  confirm: string,
): Promise<string | null> {
  if (!(await checkAdminPassword(current))) return "The current password is wrong.";
  if (next.length < MIN_PASSWORD_LENGTH) {
    return `The new password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (next !== confirm) return "The new passwords don't match.";
  const data = { adminPasswordHash: await hashPassword(next), adminPasswordChangedAt: new Date() };
  await prisma.appSetting.upsert({ where: { id: 1 }, create: { id: 1, ...data }, update: data });
  return null;
}

/**
 * A fresh session cookie for the current admin — after changing the password,
 * so the person who changed it stays signed in while everyone else is signed out.
 */
export async function renewSession(request: Request): Promise<string> {
  const session = await getSession(request);
  session.set("admin", true);
  session.set("since", Date.now());
  return sessionStorage.commitSession(session);
}

async function getSession(request: Request) {
  return sessionStorage.getSession(request.headers.get("Cookie"));
}

export async function isAdmin(request: Request): Promise<boolean> {
  const session = await getSession(request);
  if (session.get("admin") !== true) return false;
  // Signed in before the password last changed → signed out.
  const changedAt = (await getAppSettings()).adminPasswordChangedAt?.getTime() ?? 0;
  return Number(session.get("since") ?? 0) >= changedAt;
}

/** Throws a redirect to the login page unless the request is signed in. */
export async function requireAdmin(request: Request): Promise<void> {
  if (await isAdmin(request)) return;
  const url = new URL(request.url);
  const next = url.pathname + url.search;
  throw redirect(`/login?next=${encodeURIComponent(next)}`);
}

/** Only relative, same-site paths — never an open redirect. */
export function safeNext(next: string | null): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/app";
}

export async function signIn(request: Request, next: string) {
  const session = await getSession(request);
  session.set("admin", true);
  session.set("since", Date.now());
  return redirect(safeNext(next), {
    headers: { "Set-Cookie": await sessionStorage.commitSession(session) },
  });
}

export async function signOut(request: Request) {
  const session = await getSession(request);
  return redirect("/login", {
    headers: { "Set-Cookie": await sessionStorage.destroySession(session) },
  });
}
