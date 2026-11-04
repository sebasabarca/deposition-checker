// Accounts, sessions and access control. Each account has a private workspace (an org) and sees
// only its cases; everything a case holds (depositions, analyses, findings) is reached through it.
// Registration is public, but uploading and checking need a verified email, and paid checks need
// analysis access, which an administrator grants (scripts/admin.ts) until credits exist.
// Passwords are scrypt hashes; the session cookie is a random token stored only as its SHA-256, so a
// copy of the database can't be used to sign in. The cookie is HttpOnly and SameSite=Lax, and any
// request that changes data must come from this site's own origin.

import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from "express";
import { and, eq, gt, isNull, ne } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "./db/client";
import { analyses, authTokens, caseRuns, cases, depositions, findings, orgs, sessions, users } from "./db/schema";
import { alreadyRegistered, emailChanged, passwordChanged, resendMailer, resetPassword, verifyEmail, type Email as EmailMessage, type Mailer } from "./email";

const scrypt = (password: string, salt: Buffer, keylen: number, options: ScryptOptions) =>
  new Promise<Buffer>((resolve, reject) => scryptCb(password, salt, keylen, options, (err, key) => (err ? reject(err) : resolve(key))));

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
export const SESSION_COOKIE = "veridict_session";
const SESSION_DAYS = 30;
export const MIN_PASSWORD = 10;
// At least 10 characters and one character that isn't a letter or digit. Checked only when a password
// is set (registration, reset, change); older passwords keep working until they're changed.
export const passwordProblem = (p: string) =>
  p.length < MIN_PASSWORD ? `Use at least ${MIN_PASSWORD} characters.` : !/[^A-Za-z0-9]/.test(p) ? "Include at least one special character, such as ! ? # or a space." : null;

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

export type SessionUser = { id: number; orgId: number; email: string; name: string; emailVerified: boolean; analysisAccess: boolean };

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
    .select({ id: users.id, orgId: users.orgId, email: users.email, name: users.name, verifiedAt: users.emailVerifiedAt, analysisAccess: users.analysisAccess })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.tokenHash, tokenHash(token)), gt(sessions.expiresAt, new Date())));
  if (!row) return null;
  const { verifiedAt, ...user } = row;
  return { ...user, emailVerified: verifiedAt !== null };
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
  [/^\/case-runs\/(\d+)(?:\/|$)/, async (db, id) => (await db.select({ org: cases.orgId }).from(caseRuns).innerJoin(cases, eq(cases.id, caseRuns.caseId)).where(eq(caseRuns.id, id)))[0]?.org],
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

// What an unverified account can't do yet, checked on the server whatever the interface shows:
// upload a deposition or start or resume a check. A live (paid) check also needs analysis access.
const NEEDS_VERIFIED: [string, RegExp][] = [
  ["POST", /^\/cases\/\d+\/depositions$/],
  ["POST", /^\/cases\/\d+\/analyses$/],
  ["POST", /^\/analyses\/\d+\/resume$/],
  ["POST", /^\/cases\/\d+\/case-runs$/],
  ["POST", /^\/case-runs\/\d+\/(?:resume|confirm)$/],
  ["POST", /^\/depositions\/\d+\/retry$/],
  ["POST", /^\/depositions\/\d+\/move$/],
];
const PAID: [string, RegExp][] = [
  ["POST", /^\/cases\/\d+\/analyses$/],
  ["POST", /^\/analyses\/\d+\/resume$/],
  ["POST", /^\/cases\/\d+\/case-runs$/],
  ["POST", /^\/case-runs\/\d+\/confirm$/], // only live runs await confirmation
  // Resuming a case run is paid only for a live run, which needs the stored run's mode: checked in the route
  // (api/caseRuns.ts) with the same analysisAccess rule.
];
const matches = (req: Request, rules: [string, RegExp][]) => rules.some(([m, re]) => req.method === m && re.test(req.path));

export function accountGates(): RequestHandler {
  return (req, res, next) => {
    const user = res.locals.user as SessionUser;
    if (!user.emailVerified && matches(req, NEEDS_VERIFIED)) return res.status(403).json({ error: "Verify your email address first. Check your inbox for the link, or send a new one from the banner.", code: "email_unverified" });
    // A demo analysis replays stored results and costs nothing; anything else is a paid check.
    // A mock case run uses the deterministic mock and is never billed.
    const mode = (req.body as { mode?: string } | undefined)?.mode;
    const paid = matches(req, PAID) && !(req.path.endsWith("/analyses") && mode === "demo") && !(req.path.endsWith("/case-runs") && mode === "mock");
    if (paid && !user.analysisAccess) return res.status(403).json({ error: "Paid checks aren't enabled for this account yet. Veridict is in early access; contact us to turn them on.", code: "no_analysis_access" });
    return next();
  };
}

// Sign-in attempts per address and per email, so a password can't be guessed by brute force.
// shortcut: in memory, so it resets on restart and isn't shared between servers; move it to
// Postgres or Redis when running more than one web process.
const attempts = new Map<string, { n: number; until: number }>();
export const resetRateLimits = () => attempts.clear(); // for tests
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
const Password = z.string().max(200).refine((p) => passwordProblem(p) === null);
const SignUp = z.object({ name: z.string().trim().min(1).max(200), email: Email, password: Password });
const SignIn = z.object({ email: Email, password: z.string().min(1).max(200) });
const Token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

const TOKEN_HOURS = { verify_email: 24, reset_password: 1 } as const;
const tooMany = (res: Response) => res.status(429).json({ error: "Too many attempts. Try again in 15 minutes." });

// A one-time token for an emailed link: random, stored only as its hash. Issuing one retires the
// user's earlier unused tokens of the same purpose, so only the latest link works.
async function issueToken(db: Database, userId: number, purpose: keyof typeof TOKEN_HOURS) {
  const token = randomBytes(32).toString("base64url");
  await db.transaction(async (tx) => {
    await tx.update(authTokens).set({ usedAt: new Date() }).where(and(eq(authTokens.userId, userId), eq(authTokens.purpose, purpose), isNull(authTokens.usedAt)));
    await tx.insert(authTokens).values({ tokenHash: tokenHash(token), userId, purpose, expiresAt: new Date(Date.now() + TOKEN_HOURS[purpose] * 3_600_000) });
  });
  return token;
}

// Marks a token used and returns its user, or null when it's unknown, used, expired or for another
// purpose. The update is the check, so two clicks on one link can't both succeed.
async function spendToken(db: Database, token: string, purpose: keyof typeof TOKEN_HOURS) {
  const [row] = await db
    .update(authTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(authTokens.tokenHash, tokenHash(token)), eq(authTokens.purpose, purpose), isNull(authTokens.usedAt), gt(authTokens.expiresAt, new Date())))
    .returning({ userId: authTokens.userId });
  return row?.userId ?? null;
}

// Sending never decides the answer: failures are logged without the message (which holds the link)
// and the response stays the same, so the reply can't reveal whether an account exists.
async function send(mailer: Mailer, to: string, email: Omit<EmailMessage, "to">) {
  try {
    await mailer({ ...email, to });
  } catch (error) {
    console.error(`Email to a user failed: ${error instanceof Error ? error.message : error}`);
  }
}

const CHECK_EMAIL = "Check your email. If the address can be used, a link is on its way.";

export function authRoutes(db: Database, { mailer = resendMailer }: { mailer?: Mailer } = {}): Router {
  const router = Router();
  router.use(sameOrigin);

  // Public registration. The answer is the same whether or not the address is taken: a new address
  // gets a verification link (which also signs in), a taken one gets a note to sign in instead.
  router.post("/auth/signup", async (req, res) => {
    const body = SignUp.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: passwordProblem(String(req.body?.password ?? "")) ?? "Enter your name and a valid email." });
    if (limited(`signup:${req.ip}`) || limited(`signup:${body.data.email}`)) return tooMany(res);
    const passwordHash = await hashPassword(body.data.password);
    const created = await db.transaction(async (tx) => {
      const [taken] = await tx.select({ id: users.id }).from(users).where(eq(users.email, body.data.email));
      if (taken) return null;
      const orgId = (await tx.insert(orgs).values({ name: body.data.name }).returning({ id: orgs.id }))[0].id;
      const inserted = await tx.insert(users).values({ orgId, email: body.data.email, name: body.data.name, passwordHash }).onConflictDoNothing().returning({ id: users.id });
      if (inserted.length === 0) throw new Error("taken"); // registered between the check and the insert
      return inserted[0].id;
    }).catch((e: Error) => (e.message === "taken" ? null : Promise.reject(e)));
    if (created === null) await send(mailer, body.data.email, alreadyRegistered());
    else await send(mailer, body.data.email, verifyEmail(body.data.name, await issueToken(db, created, "verify_email")));
    return res.status(202).json({ ok: true, message: CHECK_EMAIL });
  });

  // The emailed link: verifies the address and signs that browser in.
  router.post("/auth/verify", async (req, res) => {
    const token = Token.safeParse(req.body?.token);
    if (limited(`verify:${req.ip}`)) return tooMany(res);
    const userId = token.success ? await spendToken(db, token.data, "verify_email") : null;
    if (userId === null) return res.status(400).json({ error: "This link has expired or was already used. Sign in and send a new one." });
    await db.update(users).set({ emailVerifiedAt: new Date() }).where(and(eq(users.id, userId), isNull(users.emailVerifiedAt)));
    await startSession(db, res, req, userId);
    return res.json({ user: await sessionUserById(db, userId) });
  });

  // A new verification link for the signed-in account.
  router.post("/auth/verify/resend", async (req, res) => {
    const user = await sessionUser(db, req);
    if (!user) return res.status(401).json({ error: "Sign in to continue." });
    if (user.emailVerified) return res.json({ ok: true, message: "Your email is already verified." });
    if (limited(`resend:${user.id}`)) return tooMany(res);
    await send(mailer, user.email, verifyEmail(user.name, await issueToken(db, user.id, "verify_email")));
    return res.status(202).json({ ok: true, message: `A new link is on its way to ${user.email}.` });
  });

  router.post("/auth/signin", async (req, res) => {
    const body = SignIn.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: "Enter your email and password." });
    if (limited(`signin:${req.ip}`) || limited(`signin:${body.data.email}`)) return tooMany(res);
    const [user] = await db.select().from(users).where(eq(users.email, body.data.email));
    // The same work and answer whether or not the email exists, so accounts can't be discovered.
    const ok = user ? await verifyPassword(body.data.password, user.passwordHash) : (await hashPassword(body.data.password), false);
    if (!user || !ok) return res.status(401).json({ error: "That email and password don't match an account." });
    await startSession(db, res, req, user.id);
    return res.json({ user: await sessionUserById(db, user.id) });
  });

  // Always the same answer, so it can't be used to find out who has an account.
  router.post("/auth/forgot", async (req, res) => {
    const email = Email.safeParse(req.body?.email);
    if (!email.success) return res.status(400).json({ error: "Enter a valid email address." });
    if (limited(`forgot:${req.ip}`) || limited(`forgot:${email.data}`)) return tooMany(res);
    const [user] = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.email, email.data));
    if (user) await send(mailer, email.data, resetPassword(user.name, await issueToken(db, user.id, "reset_password")));
    return res.status(202).json({ ok: true, message: "If an account uses that address, a reset link is on its way. It expires in 1 hour." });
  });

  // A new password from an emailed link. Every existing session ends, and the browser that reset it
  // is signed in. A reset link proves the address too, so it also verifies it.
  router.post("/auth/reset", async (req, res) => {
    const body = z.object({ token: Token, password: Password }).safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: passwordProblem(String(req.body?.password ?? "")) ?? "This link isn't valid." });
    if (limited(`reset:${req.ip}`)) return tooMany(res);
    const passwordHash = await hashPassword(body.data.password);
    const userId = await spendToken(db, body.data.token, "reset_password");
    if (userId === null) return res.status(400).json({ error: "This link has expired or was already used. Ask for a new one." });
    const [user] = await db.transaction(async (tx) => {
      await tx.delete(sessions).where(eq(sessions.userId, userId));
      await tx.update(authTokens).set({ usedAt: new Date() }).where(and(eq(authTokens.userId, userId), isNull(authTokens.usedAt)));
      return tx.update(users).set({ passwordHash }).where(eq(users.id, userId)).returning({ email: users.email, name: users.name, verifiedAt: users.emailVerifiedAt });
    });
    if (!user.verifiedAt) await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.id, userId));
    await startSession(db, res, req, userId);
    await send(mailer, user.email, passwordChanged(user.name));
    return res.json({ user: await sessionUserById(db, userId) });
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

  // The profile: name, password and email of the signed-in account.
  const signedIn = async (req: Request, res: Response) => {
    const user = await sessionUser(db, req);
    if (!user) res.status(401).json({ error: "Sign in to continue." });
    return user;
  };

  router.patch("/auth/profile", async (req, res) => {
    const user = await signedIn(req, res);
    if (!user) return;
    const name = z.string().trim().min(1).max(200).safeParse(req.body?.name);
    if (!name.success) return res.status(400).json({ error: "Enter your name." });
    await db.update(users).set({ name: name.data }).where(eq(users.id, user.id));
    return res.json({ user: await sessionUserById(db, user.id) });
  });

  // A new password needs the current one. Every other session ends; this browser stays signed in.
  router.post("/auth/password", async (req, res) => {
    const user = await signedIn(req, res);
    if (!user) return;
    if (limited(`password:${user.id}`)) return tooMany(res);
    const current = String(req.body?.current ?? "");
    const next = String(req.body?.password ?? "");
    const problem = passwordProblem(next);
    if (problem || next.length > 200) return res.status(400).json({ error: problem ?? "That password is too long." });
    const [row] = await db.select({ hash: users.passwordHash }).from(users).where(eq(users.id, user.id));
    if (!(await verifyPassword(current, row.hash))) return res.status(400).json({ error: "Your current password isn't right." });
    const keep = tokenHash(readCookie(req, SESSION_COOKIE) ?? "");
    await db.transaction(async (tx) => {
      await tx.update(users).set({ passwordHash: await hashPassword(next) }).where(eq(users.id, user.id));
      await tx.delete(sessions).where(and(eq(sessions.userId, user.id), ne(sessions.tokenHash, keep)));
      await tx.update(authTokens).set({ usedAt: new Date() }).where(and(eq(authTokens.userId, user.id), eq(authTokens.purpose, "reset_password"), isNull(authTokens.usedAt)));
    });
    await send(mailer, user.email, passwordChanged(user.name));
    return res.json({ ok: true, message: "Password changed. Other devices were signed out." });
  });

  // A new email needs the current password and is unverified until its link is opened. The old
  // address is told. If the new one is taken, nothing changes and its owner gets a note instead,
  // and the answer is the same, so it can't reveal who has an account.
  router.post("/auth/email", async (req, res) => {
    const user = await signedIn(req, res);
    if (!user) return;
    if (limited(`email:${user.id}`)) return tooMany(res);
    const email = Email.safeParse(req.body?.email);
    if (!email.success) return res.status(400).json({ error: "Enter a valid email address." });
    const [row] = await db.select({ hash: users.passwordHash }).from(users).where(eq(users.id, user.id));
    if (!(await verifyPassword(String(req.body?.password ?? ""), row.hash))) return res.status(400).json({ error: "Your current password isn't right." });
    if (email.data === user.email) return res.json({ ok: true, message: "That's already your email." });
    const [taken] = await db.select({ id: users.id }).from(users).where(eq(users.email, email.data));
    if (taken) await send(mailer, email.data, alreadyRegistered());
    else {
      await db.update(users).set({ email: email.data, emailVerifiedAt: null }).where(eq(users.id, user.id));
      await send(mailer, email.data, verifyEmail(user.name, await issueToken(db, user.id, "verify_email")));
      await send(mailer, user.email, emailChanged(user.name, email.data));
    }
    return res.status(202).json({ ok: true, message: `If ${email.data} can be used, a verification link is on its way to it.` });
  });

  // The first-run tour was finished or skipped; it isn't offered again (Help can replay it).
  router.post("/auth/onboarded", async (req, res) => {
    const user = await signedIn(req, res);
    if (!user) return;
    await db.update(users).set({ onboardedAt: new Date() }).where(and(eq(users.id, user.id), isNull(users.onboardedAt)));
    return res.json({ ok: true });
  });

  return router;
}

async function sessionUserById(db: Database, id: number) {
  const [row] = await db.select({ id: users.id, email: users.email, name: users.name, verifiedAt: users.emailVerifiedAt, analysisAccess: users.analysisAccess, onboardedAt: users.onboardedAt }).from(users).where(eq(users.id, id));
  const { verifiedAt, onboardedAt, ...user } = row;
  return { ...user, emailVerified: verifiedAt !== null, onboarded: onboardedAt !== null };
}
