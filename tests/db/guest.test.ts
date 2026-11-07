// Guest mode (server/src/guest.ts): a public read-only demo. Anyone can open it without a password; nothing can be
// changed by anyone; it never runs with a model key. Postgres, synthetic data, no model call.

import express from "express";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { caseRoutes, findingRoutes } from "../../server/src/api";
import { authRoutes, requireUser, sameOrigin, scopeToOrg } from "../../server/src/auth";
import type { Database } from "../../server/src/db/client";
import { cases, orgs, users } from "../../server/src/db/schema";
import { guestConfigProblem, guestEmail, guestReadOnly, refusedInGuestMode } from "../../server/src/guest";
import { emptyTables, listen, openTestDatabase, TEST_DATABASE_URL } from "./database";

const GUEST = "guest@demo.example.test";

describe("guest mode configuration", () => {
  it("starts only with a reserved demo address and never with a model key", () => {
    expect(guestConfigProblem({})).toBeNull(); // off: nothing to check
    expect(guestConfigProblem({ GUEST_MODE: "true", GUEST_EMAIL: GUEST })).toBeNull();
    expect(guestConfigProblem({ GUEST_MODE: "true", GUEST_EMAIL: GUEST, ANTHROPIC_API_KEY: "sk-anything" })).toMatch(/without ANTHROPIC_API_KEY/);
    expect(guestConfigProblem({ GUEST_MODE: "true" })).toMatch(/GUEST_EMAIL/);
    expect(guestConfigProblem({ GUEST_MODE: "true", GUEST_EMAIL: "someone@gmail.com" })).toMatch(/example\.test/); // never a real person's account
    expect(guestEmail({ GUEST_EMAIL: GUEST })).toBeNull(); // the address alone doesn't turn it on
  });
  it("refuses every change except opening the demo and signing out", () => {
    expect(refusedInGuestMode({ method: "GET", path: "/workspace" })).toBe(false);
    expect(refusedInGuestMode({ method: "POST", path: "/auth/guest" })).toBe(false);
    expect(refusedInGuestMode({ method: "POST", path: "/auth/signout" })).toBe(false);
    for (const [method, path] of [["POST", "/auth/signup"], ["POST", "/auth/signin"], ["PATCH", "/cases/1"], ["POST", "/cases/1/case-runs"], ["PATCH", "/findings/1/review"], ["DELETE", "/cases/1"], ["PATCH", "/auth/profile"], ["POST", "/auth/onboarded"]]) {
      expect(refusedInGuestMode({ method, path })).toBe(true);
    }
  });
});

describe.skipIf(!TEST_DATABASE_URL)("guest mode (Postgres)", () => {
  let db: Database;
  let pool: Pool;
  let api: { url: string; close: () => Promise<void> };
  let caseId: number;
  const saved = { mode: process.env.GUEST_MODE, email: process.env.GUEST_EMAIL };

  beforeAll(async () => {
    process.env.GUEST_MODE = "true";
    process.env.GUEST_EMAIL = GUEST;
    ({ db, pool } = await openTestDatabase());
    await emptyTables(db);
    const [org] = await db.insert(orgs).values({ name: "Demo" }).returning();
    await db.insert(users).values({ orgId: org.id, email: GUEST, name: "Guest", passwordHash: "unusable", emailVerifiedAt: new Date(), onboardedAt: new Date() });
    [{ id: caseId }] = await db.insert(cases).values({ orgId: org.id, name: "Demo case" }).returning({ id: cases.id });
    const app = express().use(express.json());
    app.use("/api", guestReadOnly());
    app.use("/api", authRoutes(db));
    app.use("/api", sameOrigin, requireUser(db), scopeToOrg(db));
    app.use("/api", caseRoutes({ db }), findingRoutes({ db }));
    api = await listen(app);
  });
  afterAll(async () => {
    process.env.GUEST_MODE = saved.mode;
    process.env.GUEST_EMAIL = saved.email;
    if (saved.mode === undefined) delete process.env.GUEST_MODE;
    if (saved.email === undefined) delete process.env.GUEST_EMAIL;
    await api?.close();
    await pool?.end();
  });

  const browser = () => {
    let cookie = "";
    return async (method: string, url: string, body?: unknown) => {
      const res = await fetch(`${api.url}/api${url}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
      const set = res.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0];
      return { status: res.status, body: await res.json() };
    };
  };

  it("opens the demo without a password, as a guest with no paid access, and shows the demo's data", async () => {
    const b = browser();
    expect((await b("GET", "/auth/guest")).body).toEqual({ available: true });
    const opened = await b("POST", "/auth/guest");
    expect(opened.status).toBe(200);
    expect(opened.body.user).toMatchObject({ email: GUEST, guest: true, analysisAccess: false });
    expect((await b("GET", "/auth/me")).body.user.guest).toBe(true);
    expect((await b("GET", "/cases")).body.cases.map((c: { id: number }) => c.id)).toEqual([caseId]);
    expect((await b("GET", "/workspace")).status).toBe(200);
  });

  it("refuses every change, for the guest and for anyone else, and lets the guest sign out", async () => {
    const b = browser();
    await b("POST", "/auth/guest");
    const renamed = await b("PATCH", `/cases/${caseId}`, { name: "Changed" });
    expect(renamed).toMatchObject({ status: 403, body: { code: "read_only_demo" } });
    expect((await b("PATCH", "/auth/profile", { name: "Mallory" })).status).toBe(403);
    expect((await b("GET", `/cases/${caseId}`)).body.case.name).toBe("Demo case");
    const stranger = browser();
    expect((await stranger("POST", "/auth/signup", { name: "Mallory", email: "m@example.com", password: "a long passphrase!" })).status).toBe(403);
    expect((await stranger("POST", "/auth/signin", { email: GUEST, password: "anything" })).status).toBe(403);
    expect((await b("POST", "/auth/signout")).status).toBe(200);
    expect((await b("GET", "/auth/me")).status).toBe(401);
  });
});
