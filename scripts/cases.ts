// Case, witness and deposition lookup for the development CLIs (scripts/ingest.ts, scripts/pathb.ts).

import { and, desc, eq, sql } from "drizzle-orm";
import type { Database } from "../server/src/db/client";
import { cases, depositions, orgs, witnesses } from "../server/src/db/schema";

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

// Finds a witness for read-only commands, without creating anything. A case is chosen by ID, or by
// name only when the name and witness resolve to exactly one case, since case names aren't unique.
export async function resolveWitness(
  db: Database,
  { caseId, caseName, witnessName }: { caseId?: number; caseName?: string; witnessName: string },
): Promise<{ caseId: number; witnessId: number }> {
  if (caseId === undefined && caseName === undefined) throw new Error("Give the case as --case-id <id> or --case <name>.");
  const matches = await db
    .select({ caseId: cases.id, witnessId: witnesses.id })
    .from(witnesses)
    .innerJoin(cases, eq(cases.id, witnesses.caseId))
    .where(and(caseId !== undefined ? eq(cases.id, caseId) : eq(cases.name, caseName!), eq(witnesses.name, witnessName)));
  const which = caseId !== undefined ? `case ${caseId}` : `a case named "${caseName}"`;
  if (matches.length === 0) throw new Error(`No witness "${witnessName}" in ${which}.`);
  if (matches.length > 1) {
    const ids = matches.map((m) => m.caseId).join(", ");
    throw new Error(`"${caseName}" with witness "${witnessName}" matches ${matches.length} cases (IDs ${ids}); choose one with --case-id.`);
  }
  return matches[0];
}

// The deposition to search from: the one given, which must be a ready deposition of this witness in
// this case, or else the witness's most recent ready deposition.
export async function resolveDeposition(
  db: Database,
  { caseId, witnessId }: { caseId: number; witnessId: number },
  depositionId?: number,
): Promise<number> {
  if (depositionId === undefined) {
    const [latest] = await db
      .select({ id: depositions.id })
      .from(depositions)
      .where(and(eq(depositions.caseId, caseId), eq(depositions.witnessId, witnessId), eq(depositions.status, "ready")))
      .orderBy(desc(depositions.id))
      .limit(1);
    if (!latest) throw new Error(`Witness ${witnessId} has no ready deposition in case ${caseId}.`);
    return latest.id;
  }
  const [row] = await db.select().from(depositions).where(eq(depositions.id, depositionId));
  if (!row) throw new Error(`Deposition ${depositionId} doesn't exist.`);
  if (row.caseId !== caseId || row.witnessId !== witnessId) {
    throw new Error(`Deposition ${depositionId} belongs to case ${row.caseId}, witness ${row.witnessId}, not case ${caseId}, witness ${witnessId}.`);
  }
  if (row.status !== "ready") throw new Error(`Deposition ${depositionId} is ${row.status}; only ready depositions are searched.`);
  return row.id;
}
