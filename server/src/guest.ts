// Guest mode (GUEST_MODE=true): a public, read-only demo of one finished analysis. "Explore the demo" signs a browser
// in as GUEST_EMAIL (a reserved example.test address, so never a real person's account) without a password, and the
// whole server is read-only: every request that would change something is refused, for every visitor, except
// opening the demo and signing out. No sign-up, no upload, no analysis, no decision, no profile change.
// A guest-mode server must run without ANTHROPIC_API_KEY: the API and the worker refuse to start with one, so the demo
// has no way to reach a model or spend anything.

import type { Request, RequestHandler } from "express";
import { localDemoEmail } from "./local";

type Env = Record<string, string | undefined>;

export const guestMode = (env: Env = process.env) => env.GUEST_MODE === "true";

// The guest account's email when guest mode is on and correctly set, or null.
export function guestEmail(env: Env = process.env) {
  const email = env.GUEST_EMAIL?.trim().toLowerCase();
  return guestMode(env) && email && /^[^@\s]+@(?:[a-z0-9-]+\.)*example\.test$/.test(email) ? email : null;
}

// Why a guest-mode server must not start, or null.
export function guestConfigProblem(env: Env = process.env): string | null {
  if (!guestMode(env)) return null;
  if (!guestEmail(env)) return "GUEST_MODE=true needs GUEST_EMAIL set to the demo account, a reserved …@example.test address.";
  if (env.ANTHROPIC_API_KEY?.trim()) return "GUEST_MODE=true must run without ANTHROPIC_API_KEY: a public demo must never be able to reach a model. Remove the key.";
  return null;
}

// The guest account, and in local mode the demo account (local.ts): both are read-only demos of a finished analysis.
export const isGuest = (user: { email: string } | null | undefined, env: Env = process.env) =>
  !!user && [guestEmail(env), localDemoEmail(env)].includes(user.email.toLowerCase());

// The requests a guest-mode server still accepts that change something: opening the demo and signing out.
const ALLOWED = new Set(["/auth/guest", "/auth/signout"]);
export const refusedInGuestMode = (req: Pick<Request, "method" | "path">) => !["GET", "HEAD", "OPTIONS"].includes(req.method) && !ALLOWED.has(req.path);

// Mounted on /api before every other route: in guest mode, nothing can be changed.
export function guestReadOnly(env: Env = process.env): RequestHandler {
  return (req, res, next) => {
    if (guestMode(env) && refusedInGuestMode(req)) return res.status(403).json({ error: "This is a read-only demo: nothing can be changed here.", code: "read_only_demo" });
    return next();
  };
}
