// Case and witness lookup for the development CLI (scripts/ingest.ts), by name.

import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../server/src/db/client";
import { cases, orgs, witnesses } from "../server/src/db/schema";

const ORG_NAME = "Demo";

// Orgs and cases have no unique name in the schema (two cases may share a name), so this looks
// before inserting. All lookups take the same transaction-level advisory lock first, so concurrent
// CLI runs wait for each other instead of each creating its own copy. The upload endpoint will
// take IDs instead of names.
export async function findOrCreateWitness(db: Database, caseName: string, witnessName: string) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('cli:find-or-create-case', 0))`);
    const org =
      (await tx.select().from(orgs).where(eq(orgs.name, ORG_NAME)).limit(1)).at(0) ??
      (await tx.insert(orgs).values({ name: ORG_NAME }).returning())[0];
    const kase =
      (await tx.select().from(cases).where(and(eq(cases.orgId, org.id), eq(cases.name, caseName))).limit(1)).at(0) ??
      (await tx.insert(cases).values({ orgId: org.id, name: caseName }).returning())[0];
    await tx.insert(witnesses).values({ caseId: kase.id, name: witnessName }).onConflictDoNothing();
    const [witness] = await tx
      .select()
      .from(witnesses)
      .where(and(eq(witnesses.caseId, kase.id), eq(witnesses.name, witnessName)));
    return { caseId: kase.id, witnessId: witness.id };
  });
}
