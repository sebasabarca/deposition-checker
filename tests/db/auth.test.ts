// Accounts and access control over HTTP: registration, email verification, password reset,
// sessions, what an unverified or unfunded account may do, and that one account never sees another's
// cases. Email goes to a fake mailer; nothing is sent. See tests/db/database.ts for when these run.

import express from "express";
import type { PgBoss } from "pg-boss";
import type { Pool } from "pg";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { analysisRoutes, caseRoutes, depositionRoutes } from "../../server/src/api";
import { accountGates, authRoutes, hashPassword, resetRateLimits, requireUser, sameOrigin, scopeToOrg, verifyPassword } from "../../server/src/auth";
import type { Database } from "../../server/src/db/client";
import { authTokens, cases, orgs, sessions, users } from "../../server/src/db/schema";
import type { Email } from "../../server/src/email";
import { createAnalysisQueues, createIngestQueues, startBoss } from "../../server/src/jobs";
import { emptyTables, listen, openTestDatabase, TEST_DATABASE_URL } from "./database";

describe("password hashing", () => {
  it("verifies the right password only, and never stores it in clear", async () => {
    const stored = await hashPassword("correct horse battery");
    expect(stored).not.toContain("correct horse");
    expect(await verifyPassword("correct horse battery", stored)).toBe(true);
    expect(await verifyPassword("correct horse batterz", stored)).toBe(false);
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
  });
});

describe.skipIf(!TEST_DATABASE_URL)("accounts and access control (Postgres)", () => {
  let pool: Pool;
  let db: Database;
  let boss: PgBoss;
  let api: { url: string; close: () => Promise<void> };
  const sent: Email[] = [];

  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
    boss = await startBoss(TEST_DATABASE_URL!, { supervise: false });
    await createIngestQueues(boss);
    await createAnalysisQueues(boss);
    const app = express();
    app.use(express.json());
    app.use("/api", authRoutes(db, { mailer: async (e) => void sent.push(e) }));
    app.use("/api", sameOrigin, requireUser(db), scopeToOrg(db), accountGates());
    app.use("/api", caseRoutes({ db }));
    app.use("/api", analysisRoutes({ db, pool, boss }));
    app.use("/api", depositionRoutes({ db, pool, boss }));
    api = await listen(app);
  });
  afterAll(async () => {
    await api?.close();
    await boss?.stop({ graceful: false });
    await pool?.end();
  });
  beforeEach(async () => {
    await emptyTables(db);
    sent.length = 0;
    resetRateLimits();
  });

  // A tiny cookie jar per browser.
  const browser = () => {
    let cookie = "";
    return async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
      const res = await fetch(`${api.url}/api${url}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      const set = res.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0];
      return { status: res.status, body: await res.json(), setCookie: set };
    };
  };
  const tokenIn = (e: Email) => e.text.match(/token=([A-Za-z0-9_-]{43})/)?.[1];
  const lastTo = (to: string) => sent.filter((e) => e.to === to).at(-1)!;
  const register = (b: ReturnType<typeof browser>, email: string, password = "a long passphrase") => b("POST", "/auth/signup", { name: "Ana Ruiz", email, password });
  const registerAndVerify = async (b: ReturnType<typeof browser>, email: string) => {
    await register(b, email);
    return b("POST", "/auth/verify", { token: tokenIn(lastTo(email)) });
  };

  it("answers registration the same whether or not the address is taken, and emails the right note", async () => {
    const a = await register(browser(), "Ana@Harlow.law");
    expect(a).toMatchObject({ status: 202, setCookie: null });
    const again = await register(browser(), "ana@harlow.law", "another long passphrase");
    expect(again.status).toBe(202);
    expect(again.body).toEqual(a.body);
    expect(sent.map((e) => [e.to, e.subject])).toEqual([["ana@harlow.law", "Verify your email for Veridict"], ["ana@harlow.law", "You already have a Veridict account"]]);
    expect(tokenIn(sent[1])).toBeUndefined();
    expect(await db.$count(users)).toBe(1);
    const [stored] = await db.select().from(authTokens);
    expect(stored.tokenHash).not.toBe(tokenIn(sent[0])); // only the hash is kept
  });

  it("verifies through the emailed link once, and signs that browser in", async () => {
    const b = browser();
    await register(b, "ana@harlow.law");
    const token = tokenIn(sent[0])!;
    expect(await b("POST", "/auth/verify", { token: "x".repeat(43) })).toMatchObject({ status: 400 });
    const ok = await b("POST", "/auth/verify", { token });
    expect(ok).toMatchObject({ status: 200, body: { user: { email: "ana@harlow.law", emailVerified: true, analysisAccess: false } } });
    expect(ok.setCookie).toMatch(/HttpOnly/i);
    expect((await b("GET", "/auth/me")).body.user.emailVerified).toBe(true);
    expect((await browser()("POST", "/auth/verify", { token })).status).toBe(400); // single use
  });

  it("opens the demo workspace without a password only in local mode, and grants paid access only there", async () => {
    const [org] = await db.insert(orgs).values({ name: "Demo" }).returning({ id: orgs.id });
    await db.insert(users).values({ orgId: org.id, email: "demo@example.test", name: "Demo", passwordHash: await hashPassword("a long passphrase"), emailVerifiedAt: new Date() });
    const saved = { mode: process.env.LOCAL_MODE, email: process.env.LOCAL_DEMO_EMAIL };
    try {
      delete process.env.LOCAL_MODE;
      process.env.LOCAL_DEMO_EMAIL = "demo@example.test";
      expect((await browser()("GET", "/auth/local-demo")).body).toEqual({ available: false });
      expect((await browser()("POST", "/auth/local-demo")).status).toBe(404);
      process.env.LOCAL_MODE = "true";
      const b = browser();
      expect((await b("GET", "/auth/local-demo")).body).toEqual({ available: true }); // the test server is on 127.0.0.1
      expect((await b("POST", "/auth/local-demo", undefined, { origin: "http://evil.example" })).status).toBe(403);
      const opened = await b("POST", "/auth/local-demo");
      expect(opened).toMatchObject({ status: 200, body: { user: { email: "demo@example.test", analysisAccess: true } } });
      expect((await b("GET", "/auth/me")).body.user.analysisAccess).toBe(true);
      process.env.LOCAL_DEMO_EMAIL = "ana@harlow.law"; // never a real account
      expect((await browser()("POST", "/auth/local-demo")).status).toBe(404);
      delete process.env.LOCAL_MODE;
      expect((await b("GET", "/auth/me")).body.user.analysisAccess).toBe(false); // outside local mode, as granted
    } finally {
      for (const [k, v] of [["LOCAL_MODE", saved.mode], ["LOCAL_DEMO_EMAIL", saved.email]] as const) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  it("refuses an expired link", async () => {
    await register(browser(), "ana@harlow.law");
    await db.update(authTokens).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await browser()("POST", "/auth/verify", { token: tokenIn(sent[0]) })).status).toBe(400);
  });

  it("lets an unverified account sign in but not upload or check, and keeps paid checks off until granted", async () => {
    const b = browser();
    await register(b, "ana@harlow.law");
    expect((await b("POST", "/auth/signin", { email: "ana@harlow.law", password: "a long passphrase" })).body.user.emailVerified).toBe(false);
    const kase = (await b("POST", "/cases", { name: "Webb v. Harlow" })).body.case;
    expect(await b("POST", `/cases/${kase.id}/depositions?witness=Webb`, { text: "x" })).toMatchObject({ status: 403, body: { code: "email_unverified" } });
    expect(await b("POST", `/cases/${kase.id}/analyses`, { depositionA: 1, depositionB: 2, mode: "demo" })).toMatchObject({ status: 403, body: { code: "email_unverified" } });

    await b("POST", "/auth/verify", { token: tokenIn(sent[0]) });
    expect(await b("POST", `/cases/${kase.id}/analyses`, { depositionA: 1, depositionB: 2, mode: "live" })).toMatchObject({ status: 403, body: { code: "no_analysis_access" } });
    expect((await b("POST", `/cases/${kase.id}/analyses`, { depositionA: 1, depositionB: 2, mode: "demo" })).status).toBe(404); // past the gates: the depositions don't exist
    await db.update(users).set({ analysisAccess: true });
    expect((await b("POST", `/cases/${kase.id}/analyses`, { depositionA: 1, depositionB: 2, mode: "live" })).status).toBe(404);
  });

  it("resets a password with a single-use link, ends every other session, and answers forgot-password the same for anyone", async () => {
    const old = browser();
    await registerAndVerify(old, "ana@harlow.law");
    expect((await old("GET", "/cases")).status).toBe(200);

    const unknown = await browser()("POST", "/auth/forgot", { email: "nobody@harlow.law" });
    const known = await browser()("POST", "/auth/forgot", { email: "ana@harlow.law" });
    expect(unknown.status).toBe(202);
    expect(known.body).toEqual(unknown.body);
    expect(sent.filter((e) => e.to === "nobody@harlow.law")).toEqual([]);
    const token = tokenIn(lastTo("ana@harlow.law"))!;

    const b = browser();
    expect((await b("POST", "/auth/reset", { token, password: "short" })).status).toBe(400);
    const reset = await b("POST", "/auth/reset", { token, password: "a brand new passphrase" });
    expect(reset).toMatchObject({ status: 200, body: { user: { email: "ana@harlow.law" } } });
    expect(lastTo("ana@harlow.law").subject).toBe("Your Veridict password was changed");
    expect((await old("GET", "/cases")).status).toBe(401); // the old session ended
    expect((await b("GET", "/cases")).status).toBe(200);
    expect((await browser()("POST", "/auth/reset", { token, password: "yet another passphrase" })).status).toBe(400);
    expect((await browser()("POST", "/auth/signin", { email: "ana@harlow.law", password: "a long passphrase" })).status).toBe(401);
    expect((await browser()("POST", "/auth/signin", { email: "ana@harlow.law", password: "a brand new passphrase" })).status).toBe(200);
  });

  it("issues only the latest link: an earlier reset link stops working when a new one is sent", async () => {
    await registerAndVerify(browser(), "ana@harlow.law");
    await browser()("POST", "/auth/forgot", { email: "ana@harlow.law" });
    const first = tokenIn(lastTo("ana@harlow.law"))!;
    await browser()("POST", "/auth/forgot", { email: "ana@harlow.law" });
    expect((await browser()("POST", "/auth/reset", { token: first, password: "a brand new passphrase" })).status).toBe(400);
  });

  it("refuses requests without a session and wrong passwords, and ends a session on sign-out", async () => {
    const anon = browser();
    expect((await anon("GET", "/cases")).status).toBe(401);
    expect((await anon("GET", "/workspace")).status).toBe(401);
    const b = browser();
    await registerAndVerify(b, "ana@harlow.law");
    expect((await anon("POST", "/auth/signin", { email: "ana@harlow.law", password: "wrong password" })).status).toBe(401);
    expect((await anon("POST", "/auth/signin", { email: "nobody@harlow.law", password: "wrong password" })).body.error).toBe("That email and password don't match an account.");
    await b("POST", "/auth/signout");
    expect((await b("GET", "/cases")).status).toBe(401);
    expect(await db.$count(sessions)).toBe(0);
  });

  it("keeps each account's cases to itself: listing, reading, changing and deleting", async () => {
    const a = browser();
    const b = browser();
    await registerAndVerify(a, "ana@harlow.law");
    await registerAndVerify(b, "ben@kerr.law");
    const kase = (await a("POST", "/cases", { name: "Webb v. Harlow" })).body.case;
    expect((await b("GET", "/cases")).body.cases).toEqual([]);
    expect((await b("GET", "/workspace")).body.cases).toEqual([]);
    expect((await b("GET", `/cases/${kase.id}`)).status).toBe(404);
    expect((await b("POST", `/cases/${kase.id}/witnesses`, { name: "Marcus Webb" })).status).toBe(404);
    expect((await b("DELETE", `/cases/${kase.id}`)).status).toBe(404);
    expect((await a("GET", `/cases/${kase.id}`)).status).toBe(200);
    const [row] = await db.select().from(cases).where(eq(cases.id, kase.id));
    expect(row.orgId).not.toBe((await db.select().from(users).where(eq(users.email, "ben@kerr.law")))[0].orgId);
  });

  it("requires 10 characters with a special character for new passwords", async () => {
    const b = browser();
    expect(await register(b, "ana@harlow.law", "abcdefghij")).toMatchObject({ status: 400, body: { error: expect.stringMatching(/special character/) } });
    expect(await register(b, "ana@harlow.law", "abc!")).toMatchObject({ status: 400, body: { error: expect.stringMatching(/10 characters/) } });
    expect((await register(b, "ana@harlow.law", "abcdefghi!")).status).toBe(202);
  });

  it("changes the name, the password (ending other sessions) and the email (needing a new verification)", async () => {
    const b = browser();
    const other = browser();
    await registerAndVerify(b, "ana@harlow.law");
    await other("POST", "/auth/signin", { email: "ana@harlow.law", password: "a long passphrase" });
    expect((await b("GET", "/auth/me")).body.user).toMatchObject({ onboarded: false, emailVerified: true });

    expect((await b("PATCH", "/auth/profile", { name: "Ana M. Ruiz" })).body.user.name).toBe("Ana M. Ruiz");

    expect((await b("POST", "/auth/password", { current: "wrong", password: "a brand new passphrase" })).status).toBe(400);
    expect((await b("POST", "/auth/password", { current: "a long passphrase", password: "nospecialchars" })).status).toBe(400);
    expect((await b("POST", "/auth/password", { current: "a long passphrase", password: "a brand new passphrase" })).status).toBe(200);
    expect((await other("GET", "/cases")).status).toBe(401);
    expect((await b("GET", "/cases")).status).toBe(200);

    expect((await b("POST", "/auth/email", { email: "ana@new.law", password: "a long passphrase" })).status).toBe(400);
    expect((await b("POST", "/auth/email", { email: "ana@new.law", password: "a brand new passphrase" })).status).toBe(202);
    expect((await b("GET", "/auth/me")).body.user).toMatchObject({ email: "ana@new.law", emailVerified: false });
    expect(lastTo("ana@harlow.law").subject).toBe("Your Veridict email is changing");
    expect(tokenIn(lastTo("ana@new.law"))).toBeDefined();

    await b("POST", "/auth/onboarded");
    expect((await b("GET", "/auth/me")).body.user.onboarded).toBe(true);
  });

  it("doesn't move an email onto an address another account uses", async () => {
    const a = browser();
    await registerAndVerify(a, "ana@harlow.law");
    await registerAndVerify(browser(), "ben@kerr.law");
    const res = await a("POST", "/auth/email", { email: "ben@kerr.law", password: "a long passphrase" });
    expect(res.status).toBe(202);
    expect((await a("GET", "/auth/me")).body.user.email).toBe("ana@harlow.law");
    expect(lastTo("ben@kerr.law").subject).toBe("You already have a Veridict account");
  });

  it("limits repeated attempts", async () => {
    const b = browser();
    const statuses = [];
    for (let i = 0; i < 12; i++) statuses.push((await b("POST", "/auth/forgot", { email: "ana@harlow.law" })).status);
    expect(statuses.slice(0, 10).every((s) => s === 202)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });

  it("refuses a change that comes from another site", async () => {
    const a = browser();
    await registerAndVerify(a, "ana@harlow.law");
    const res = await a("POST", "/cases", { name: "Forged" }, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(await db.$count(cases)).toBe(0);
  });
});
