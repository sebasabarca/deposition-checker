// Checks extracted claims against the claim fixtures (data/eval/claim-fixtures.json): known
// extraction cases, each anchored by a PDF SHA-256 and page:line, with what a correct extraction
// yields there. Resolves anchors to exchange parts at check time, so fixtures survive re-ingestion.

import { readFile } from "node:fs/promises";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import { claims, claimTagging, depositions, exchangeLines, lines } from "../db/schema";

const Expectation = z.union([
  z.strictObject({
    claim: z.strictObject({
      source: z.string().optional(),
      predicate: z.string().optional(),
      polarity: z.string().optional(),
      epistemic: z.string().optional(),
      keyPhraseIncludes: z.string().optional(),
      contextDependent: z.boolean().optional(),
      qualified: z.boolean().optional(), // the model said qualified, or code found a hedge
    }),
  }),
  z.strictObject({ noUsableClaim: z.literal(true) }), // no verified or approximate claim that enters retrieval
]);

export const ClaimFixtures = z.strictObject({
  version: z.literal(1),
  about: z.string(),
  documents: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
  cases: z.array(z.strictObject({ name: z.string(), at: z.strictObject({ document: z.string(), page: z.number(), line: z.number() }), expect: Expectation })),
});

export type FixtureResult = { name: string; outcome: "pass" | "fail" | "not_tagged" | "anchor_not_found"; detail: string };

type ClaimRow = typeof claims.$inferSelect;
const usable = (c: ClaimRow) => (c.status === "verified" || c.status === "approximate") && !c.contextDependent;

export function matchesExpectation(c: ClaimRow, e: z.infer<typeof Expectation> & { claim: object }): boolean {
  const x = e.claim as Record<string, unknown>;
  if (!(c.status === "verified" || c.status === "approximate")) return false;
  if (x.source !== undefined && c.source !== x.source) return false;
  if (x.predicate !== undefined && c.predicate !== x.predicate) return false;
  if (x.polarity !== undefined && c.polarity !== x.polarity) return false;
  if (x.epistemic !== undefined && c.epistemic !== x.epistemic) return false;
  if (x.contextDependent !== undefined && c.contextDependent !== x.contextDependent) return false;
  if (x.keyPhraseIncludes !== undefined && !c.keyPhrase.toLowerCase().includes(String(x.keyPhraseIncludes).toLowerCase())) return false;
  if (x.qualified !== undefined && (c.epistemic === "qualified" || c.hedge !== null) !== x.qualified) return false;
  return true;
}

export async function checkClaimFixtures(db: Database, path: string, extractorVersion: string): Promise<FixtureResult[]> {
  const file = ClaimFixtures.parse(JSON.parse(await readFile(path, "utf8")));
  const results: FixtureResult[] = [];
  for (const fixture of file.cases) {
    const sha = file.documents[fixture.at.document];
    const parts = await db
      .selectDistinct({ id: exchangeLines.exchangeId })
      .from(exchangeLines)
      .innerJoin(lines, eq(lines.id, exchangeLines.lineId))
      .innerJoin(depositions, eq(depositions.id, lines.depositionId))
      .where(and(eq(depositions.fileSha256, sha ?? ""), eq(depositions.status, "ready"), eq(lines.printedPage, fixture.at.page), eq(lines.lineNo, fixture.at.line)));
    if (parts.length === 0) {
      results.push({ name: fixture.name, outcome: "anchor_not_found", detail: `${fixture.at.document} ${fixture.at.page}:${fixture.at.line}` });
      continue;
    }
    const found = await db
      .select()
      .from(claims)
      .where(and(inArray(claims.exchangeId, parts.map((p) => p.id)), eq(claims.extractorVersion, extractorVersion)));
    const tagged =
      (await db.$count(
        claimTagging,
        and(inArray(claimTagging.exchangeId, parts.map((p) => p.id)), eq(claimTagging.extractorVersion, extractorVersion), eq(claimTagging.status, "tagged")),
      )) > 0;
    const e = fixture.expect;
    let pass: boolean;
    if ("noUsableClaim" in e) pass = !found.some(usable);
    else pass = found.some((c) => matchesExpectation(c, e));
    const summary = found.map((c) => `${c.predicate}/${c.polarity}/${c.epistemic}${c.hedge ? `+hedge` : ""}${c.contextDependent ? "/context" : ""} "${c.keyPhrase.slice(0, 40)}"`).join("; ");
    results.push({
      name: fixture.name,
      outcome: !tagged ? "not_tagged" : pass ? "pass" : "fail",
      detail: summary || "no claims",
    });
  }
  return results;
}
