import { createHash, timingSafeEqual } from "node:crypto";
import { createCookieSessionStorage, redirect } from "react-router";

/**
 * Single shared admin password for the super admin (ADMIN_PASSWORD), with a
 * signed session cookie (SESSION_SECRET). There are no user accounts — the
 * people using this are the internal team.
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

export function adminPasswordConfigured(): boolean {
  return Boolean(process.env.ADMIN_PASSWORD);
}

export function checkAdminPassword(candidate: string): boolean {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return false;
  // Hash both sides so the comparison is constant-time regardless of length.
  const a = createHash("sha256").update(candidate).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

async function getSession(request: Request) {
  return sessionStorage.getSession(request.headers.get("Cookie"));
}

export async function isAdmin(request: Request): Promise<boolean> {
  return (await getSession(request)).get("admin") === true;
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
