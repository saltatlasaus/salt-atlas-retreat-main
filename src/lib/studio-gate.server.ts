/**
 * Server-only studio password check. Do not import this from client components.
 * Scheduled cron has no request cookie store, so it is allowed.
 */
import { deleteCookie, getCookie, setCookie } from "@tanstack/react-start/server";

const COOKIE = "sa_studio";

function secret(): string {
  return process.env["STUDIO_ACCESS_SECRET"]?.trim() ?? "";
}

function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function hasRequest(): boolean {
  try {
    getCookie(COOKIE);
    return true;
  } catch {
    return false;
  }
}

export function assertStudioUnlocked(): void {
  if (!hasRequest()) return;
  const expected = secret();
  if (!expected) throw new Error("Set STUDIO_ACCESS_SECRET before enabling live research.");
  const got = getCookie(COOKIE) ?? "";
  if (!same(got, expected)) throw new Error("Unlock the studio before live research.");
}

export function studioGateStatus() {
  const expected = secret();
  return {
    configured: Boolean(expected),
    unlocked: Boolean(expected) && hasRequest() && same(getCookie(COOKIE) ?? "", expected),
  };
}

export function unlockStudio(password: string): { unlocked: true } {
  const expected = secret();
  if (!expected) throw new Error("STUDIO_ACCESS_SECRET is not set on the server.");
  if (!same(password, expected)) throw new Error("Wrong studio password.");
  setCookie(COOKIE, expected, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 14,
  });
  return { unlocked: true };
}

export function lockStudio(): { unlocked: false } {
  deleteCookie(COOKIE, { path: "/" });
  return { unlocked: false };
}
