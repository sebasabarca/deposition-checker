// Sign-in and access control over HTTP: sessions, sign-up rules, and that one firm never sees or
// changes another firm's cases. See tests/db/database.ts for when these run.

import express from "express";
import type { PgBoss } from "pg-boss";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { analysisRoutes, caseRoutes, depositionRoutes } from "../../server/src/api";
import { authRoutes, hashPassword, requireUser, sameOrigin, scopeToOrg, verifyPassword } from "../../server/src/auth";
import type { Database } from "../../server/src/db/client";
import { cases, orgs, sessions, users } from "../../server/src/db/schema";
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

describe.skipIf(!TEST_DATABASE_URL)("sign-in and access control (Postgres)", () => {
  let pool: Pool;
  let db: Database;
  let boss: PgBoss;
  let api: { url: string; close: () => Promise<void> };

  beforeAll(async () => {
    ({ db, pool } = await openTestDatabase());
    boss = await startBoss(TEST_DATABASE_URL!, { supervise: false });
    await createIngestQueues(boss);
    await createAnalysisQueues(boss);
    const app = express();
    app.use(express.json());
    app.use("/api", authRoutes(db));
    app.use("/api", sameOrigin, requireUser(db), scopeToOrg(db));
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
  });
  afterEach(() => {
    delete process.env.ALLOW_SIGNUP;
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
  const signUp = (b: ReturnType<typeof browser>, email: string, firm = "Harlow LLP") => b("POST", "/auth/signup", { name: "Ana Ruiz", email, password: "a long passphrase", firm });

  it("lets the first account take over the existing cases, then closes sign-up unless it is allowed", async () => {
    // Cases made before sign-in may sit in several organizations; the first account takes them all.
    const [demo, fixtures] = await db.insert(orgs).values([{ name: "Demo" }, { name: "Fixtures" }]).returning();
    await db.insert(cases).values([{ orgId: demo.id, name: "Webb v. Harlow" }, { orgId: fixtures.id, name: "U.S. v. Oracle" }]);
    const a = browser();
    expect((await a("GET", "/auth/config")).body).toEqual({ signupOpen: true, firstUser: true });
    const created = await signUp(a, "Ana@Harlow.law");
    expect(created).toMatchObject({ status: 201, body: { user: { email: "ana@harlow.law", org: "Harlow LLP" } } });
    expect(created.setCookie).toMatch(/HttpOnly/i);
    expect(created.setCookie).toMatch(/SameSite=Lax/i);
    expect((await a("GET", "/cases")).body.cases.map((c: { name: string }) => c.name).sort()).toEqual(["U.S. v. Oracle", "Webb v. Harlow"]);

    expect((await a("GET", "/auth/config")).body.signupOpen).toBe(false);
    expect((await signUp(browser(), "other@firm.law")).status).toBe(403);
    process.env.ALLOW_SIGNUP = "true";
    expect((await signUp(browser(), "ana@harlow.law")).status).toBe(409);
    const [stored] = await db.select().from(users);
    expect(stored.passwordHash).not.toContain("passphrase");
  });

  it("refuses requests without a session and wrong passwords, and ends a session on sign-out", async () => {
    const anon = browser();
    expect((await anon("GET", "/cases")).status).toBe(401);
    expect((await anon("GET", "/workspace")).status).toBe(401);
    await signUp(browser(), "ana@harlow.law");
    expect((await anon("POST", "/auth/signin", { email: "ana@harlow.law", password: "wrong password" })).status).toBe(401);
    expect((await anon("POST", "/auth/signin", { email: "nobody@harlow.law", password: "wrong password" })).body.error).toBe("That email and password don't match an account.");

    const b = browser();
    expect((await b("POST", "/auth/signin", { email: "ANA@harlow.law", password: "a long passphrase" })).status).toBe(200);
    expect((await b("GET", "/auth/me")).body.user.email).toBe("ana@harlow.law");
    expect((await b("GET", "/cases")).status).toBe(200);
    await b("POST", "/auth/signout");
    expect(await db.$count(sessions)).toBe(1); // only the sign-up browser's session is left
  });

  it("keeps each firm's cases to itself: listing, reading, changing and deleting", async () => {
    process.env.ALLOW_SIGNUP = "true";
    const a = browser();
    const b = browser();
    await signUp(a, "ana@harlow.law", "Harlow LLP");
    await signUp(b, "ben@kerr.law", "Kerr & Co");
    const kase = (await a("POST", "/cases", { name: "Webb v. Harlow" })).body.case;
    expect((await b("GET", "/cases")).body.cases).toEqual([]);
    expect((await b("GET", "/workspace")).body.cases).toEqual([]);
    expect((await b("GET", `/cases/${kase.id}`)).status).toBe(404);
    expect((await b("POST", `/cases/${kase.id}/witnesses`, { name: "Marcus Webb" })).status).toBe(404);
    expect((await b("DELETE", `/cases/${kase.id}`)).status).toBe(404);
    expect((await a("GET", `/cases/${kase.id}`)).status).toBe(200);
  });

  it("refuses a change that comes from another site", async () => {
    const a = browser();
    await signUp(a, "ana@harlow.law");
    const res = await a("POST", "/cases", { name: "Forged" }, { origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect(await db.$count(cases)).toBe(0);
  });
});
