// Sign-in, sessions and access control. Each user belongs to one organization (a firm) and sees
// only its cases; everything a case holds (depositions, analyses, findings) is reached through it.
// Passwords are scrypt hashes; the session cookie is a random token stored only as its SHA-256, so a
// copy of the database can't be used to sign in. The cookie is HttpOnly and SameSite=Lax, and any
// request that changes data must come from this site's own origin.

import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { and, count, eq, gt, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "./db/client";
import { analyses, cases, depositions, findings, orgs, sessions, users } from "./db/schema";

const scrypt = (password: string, salt: Buffer, keylen: number, options: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scryptCb(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key))));

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
export const SESSION_COOKIE = "veridict_session";
const SESSION_DAYS = 30;
export const MIN_PASSWORD = 10;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [kind, n, r, p, salt, hash] = stored.split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const key = await scrypt(password, Buffer.from(salt, "base64"), expected.length, { N: Number(n), r: Number(r), p: Number(p) });
  return timingSafeEqual(key, expected);
}

const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");

export type SessionUser = { id: number; orgId: number; email: string; name: string };

async function startSession(db: Database, res: Response, req: Request, userId: number) {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86_400_000);
  await db.insert(sessions).values({ tokenHash: tokenHash(token), userId, expiresAt });
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: "lax", secure: secureCookies(req), path: "/", expires: expiresAt });
}

// Secure cookies need HTTPS. COOKIE_SECURE=true forces them (behind a TLS proxy, with TRUST_PROXY
// set); otherwise they follow the request, so local http development still works.
const secureCookies = (req: Request) => process.env.COOKIE_SECURE === "true" || req.secure;

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export async function sessionUser(db: Database, req: Request): Promise<SessionUser | null> {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return null;
  const [row] = await db
    .select({ id: users.id, orgId: users.orgId, email: users.email, name: users.name })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, tokenHash(token)), gt(sessions.expiresAt, new Date())));
  return row ?? null;
}

// Every API request after this one has res.locals.user, or got a 401.
export function requireUser(db: Database): RequestHandler {
  return async (req, res, next) => {
    const user = await sessionUser(db, req);
    if (!user) return res.status(401).json({ error: "Sign in to continue." });
    res.locals.user = user;
    return next();
  };
}

// A request that changes data must come from this site. Browsers send Origin on such requests; a
// form or script on another site can't fake it. Requests without one (curl, tests) are let through.
export function sameOrigin(req: Request, res: Response, next: NextFunction) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.headers.origin;
  // A proxy may pass the public host on as X-Forwarded-Host; another site's page can't set that header.
  const hosts = [req.headers.host, req.headers["x-forwarded-host"]].flat().filter(Boolean);
  if (origin && origin !== "null" && !hosts.includes(new URL(origin).host)) return res.status(403).json({ error: "Requests must come from this site." });
  if (origin === "null") return res.status(403).json({ error: "Requests must come from this site." });
  return next();
}

// Each ID in a path is checked against the signed-in user's organization before any route sees it;
// another firm's case, deposition, analysis or finding answers 404, as if it didn't exist.
const OWNERS: [RegExp, (db: Database, id: number) => Promise<number | undefined>][] = [
  [/^\/cases\/(\d+)(?:\/|$)/, async (db, id) => (await db.select({ org: cases.orgId }).from(cases).where(eq(cases.id, id)))[0]?.org],
  [/^\/depositions\/(\d+)(?:\/|$)/, async (db, id) => (await db.select({ org: cases.orgId }).from(depositions).innerJoin(cases, eq(cases.id, depositions.caseId)).where(eq(depositions.id, id)))[0]?.org],
  [/^\/analyses\/(\d+)(?:\/|$)/, async (db, id) => (await db.select({ org: cases.orgId }).from(analyses).innerJoin(cases, eq(cases.id, analyses.caseId)).where(eq(analyses.id, id)))[0]?.org],
  [/^\/findings\/(\d+)(?:\/|$)/, async (db, id) => (await db.select({ org: cases.orgId }).from(findings).innerJoin(cases, eq(cases.id, findings.caseId)).where(eq(findings.id, id)))[0]?.org],
];

export function scopeToOrg(db: Database): RequestHandler {
  return async (req, res, next) => {
    const user = res.locals.user as SessionUser;
    for (const [pattern, owner] of OWNERS) {
      const m = req.path.match(pattern);
      if (!m) continue;
      const org = await owner(db, Number(m[1]));
      if (org !== undefined && org !== user.orgId) return res.status(404).json({ error: "Not found." });
    }
    return next();
  };
}

// Sign-in attempts per address and per email, so a password can't be guessed by brute force.
// shortcut: in memory, so it resets on restart and isn't shared between servers; move it to
// Postgres or Redis when running more than one web process.
const attempts = new Map<string, { n: number; until: number }>();
const LIMIT = 10;
const WINDOW_MS = 15 * 60_000;
function limited(key: string) {
  const now = Date.now();
  if (attempts.size > 10_000) for (const [k, a] of attempts) if (a.until < now) attempts.delete(k);
  const a = attempts.get(key);
  if (!a || a.until < now) {
    attempts.set(key, { n: 1, until: now + WINDOW_MS });
    return false;
  }
  a.n += 1;
  return a.n > LIMIT;
}

const Email = z.string().trim().toLowerCase().email().max(254);
const SignUp = z.object({ name: z.string().trim().min(1).max(200), email: Email, password: z.string().min(MIN_PASSWORD).max(200), firm: z.string().trim().min(1).max(200) });
const SignIn = z.object({ email: Email, password: z.string().min(1).max(200) });

export function authRoutes(db: Database): Router {
  const router = Router();
  router.use(sameOrigin);

  // Open when ALLOW_SIGNUP is "true", and always for the very first account, which takes over the
  // organization that holds the cases created before sign-in existed.
  router.get("/auth/config", async (_req, res) => {
    const [{ n }] = await db.select({ n: count() }).from(users);
    res.json({ signupOpen: process.env.ALLOW_SIGNUP === "true" || n === 0, firstUser: n === 0 });
  });

  router.post("/auth/signup", async (req, res) => {
    const body = SignUp.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: `Enter your name, firm, a valid email and a password of at least ${MIN_PASSWORD} characters.` });
    if (limited(`signup:${req.ip}`)) return res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });
    const passwordHash = await hashPassword(body.data.password);
    const outcome = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('veridict:signup', 0))`);
      const [{ n }] = await tx.select({ n: count() }).from(users);
      if (n > 0 && process.env.ALLOW_SIGNUP !== "true") return { error: 403 as const, userId: 0 };
      const [taken] = await tx.select({ id: users.id }).from(users).where(eq(users.email, body.data.email));
      if (taken) return { error: 409 as const, userId: 0 };
      const orgId = (await tx.insert(orgs).values({ name: body.data.firm }).returning({ id: orgs.id }))[0].id;
      // Before sign-in existed there was no tenancy, so the first account takes every existing case.
      if (n === 0) await tx.update(cases).set({ orgId });
      const [user] = await tx.insert(users).values({ orgId, email: body.data.email, name: body.data.name, passwordHash }).returning({ id: users.id });
      return { userId: user.id, error: null };
    });
    if (outcome.error !== null) return res.status(outcome.error).json({ error: outcome.error === 403 ? "New accounts are created by invitation. Ask your administrator." : "An account with this email already exists. Sign in instead." });
    await startSession(db, res, req, outcome.userId);
    return res.status(201).json({ user: await sessionUserById(db, outcome.userId) });
  });

  router.post("/auth/signin", async (req, res) => {
    const body = SignIn.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Enter your email and password." });
    if (limited(`signin:${req.ip}`) || limited(`signin:${body.data.email}`)) return res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });
    const [user] = await db.select().from(users).where(eq(users.email, body.data.email));
    // The same work and answer whether or not the email exists, so accounts can't be discovered.
    const ok = user ? await verifyPassword(body.data.password, user.passwordHash) : (await hashPassword(body.data.password), false);
    if (!user || !ok) return res.status(401).json({ error: "That email and password don't match an account." });
    await startSession(db, res, req, user.id);
    return res.json({ user: await sessionUserById(db, user.id) });
  });

  router.post("/auth/signout", async (req, res) => {
    const token = readCookie(req, SESSION_COOKIE);
    if (token) await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash(token)));
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    return res.json({ ok: true });
  });

  router.get("/auth/me", async (req, res) => {
    const user = await sessionUser(db, req);
    if (!user) return res.status(401).json({ error: "Sign in to continue." });
    return res.json({ user: await sessionUserById(db, user.id) });
  });

  return router;
}

async function sessionUserById(db: Database, id: number) {
  const [row] = await db.select({ id: users.id, email: users.email, name: users.name, org: orgs.name }).from(users).innerJoin(orgs, eq(orgs.id, users.orgId)).where(eq(users.id, id));
  return row;
}
