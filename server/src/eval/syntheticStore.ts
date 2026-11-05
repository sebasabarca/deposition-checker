// Stores a synthetic evaluation suite (eval/synthetic.ts) in a database: an org, case and witness,
// both sessions ingested through the real ingestion code, and one candidate per case in the suite's
// set, so the adjudication CLI and tests run them like any stored candidate. Re-running returns the
// stored candidates instead of adding more.

import { captureEpochs, fencedTransaction } from "../evidence/epoch";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { candidates, cases, exchanges, orgs, witnesses } from "../db/schema";
import { PARSER_VERSION, saveDeposition } from "../ingest";
import { buildExchangeParts } from "../ingest/exchanges";
import { ELLISON_DOJ_V1 } from "../ingest/layout";
import type { PageExtraction, SourceLine } from "../ingest/pdf";
import { validateDeposition } from "../ingest/validate";
import { toSourceLines, WEBB_SUITE, type SyntheticSuite } from "./synthetic";

// Synthetic lines grouped into the pages the PDF reader would have produced, for validation.
export function syntheticPages(lines: readonly SourceLine[]): PageExtraction[] {
  const pages = new Map<number, SourceLine[]>();
  for (const l of lines) pages.set(l.pdfPage, [...(pages.get(l.pdfPage) ?? []), l]);
  return [...pages.entries()].map(([pdfPage, ls]) => ({ pdfPage, hasText: true, printedPage: ls[0].printedPage, footer: [], lines: ls, unnumbered: [] }));
}

// A suite's case, witness and both sessions, ingested through the real ingestion code.
export async function storeSessions(db: Database, suite: SyntheticSuite) {
  let [org] = await db.select().from(orgs).where(eq(orgs.name, "Fixtures"));
  if (!org) [org] = await db.insert(orgs).values({ name: "Fixtures" }).returning();
  let [kase] = await db.select().from(cases).where(and(eq(cases.orgId, org.id), eq(cases.name, suite.caseName)));
  if (!kase) [kase] = await db.insert(cases).values({ orgId: org.id, name: suite.caseName }).returning();
  let [witness] = await db.select().from(witnesses).where(and(eq(witnesses.caseId, kase.id), eq(witnesses.name, suite.witness)));
  if (!witness) [witness] = await db.insert(witnesses).values({ caseId: kase.id, name: suite.witness }).returning();

  const depositionIds: number[] = [];
  for (const session of suite.sessions) {
    const sourceLines = toSourceLines(session.text, session.firstPage);
    // The real per-page validation, not a hand-written "ready": a fixture that breaks the layout (a
    // line past the page's last line number, say) fails here instead of mis-segmenting silently.
    const validation = validateDeposition(syntheticPages(sourceLines), ELLISON_DOJ_V1);
    if (validation.status !== "ready") throw new Error(`Synthetic session ${session.takenOn} fails validation: ${JSON.stringify(validation.reasons)}`);
    const read = { parserVersion: PARSER_VERSION, pdf: null, validation, exchanges: buildExchangeParts(sourceLines, ELLISON_DOJ_V1) };
    const sha = createHash("sha256").update(session.text).digest("hex");
    const saved = await saveDeposition(db, { caseId: kase.id, witnessId: witness.id, takenOn: session.takenOn, fileSha256: sha, storageKey: `fixtures/${sha}`, read });
    if (!("depositionId" in saved)) throw new Error("The synthetic deposition wasn't saved.");
    depositionIds.push(saved.depositionId);
  }
  return { witnessId: witness.id, depositionIds };
}

export async function storeSynthetic(db: Database, suite: SyntheticSuite = WEBB_SUITE): Promise<Map<string, number>> {
  const existing = await db.select({ id: candidates.id, evidence: candidates.evidence }).from(candidates).where(eq(candidates.candidateSet, suite.set));
  if (existing.length > 0) return new Map(existing.map((c) => [(c.evidence as { fixture: string }[])[0].fixture, c.id]));
  const { witnessId, depositionIds } = await storeSessions(db, suite);
  const epochs = await captureEpochs(db, depositionIds); // before reading the exchanges the candidates name

  const find = async (depositionId: number, phrase: string) => {
    const rows = await db.select().from(exchanges).where(eq(exchanges.depositionId, depositionId));
    const hit = rows.find((r) => r.questionText.includes(phrase));
    if (!hit) throw new Error(`No synthetic exchange asks "${phrase}".`);
    return hit;
  };
  const ids = new Map<string, number>();
  for (const [i, c] of suite.cases.entries()) {
    const a = await find(depositionIds[0], c.questionA);
    const b = await find(depositionIds[1], c.questionB);
    const [row] = await fencedTransaction(db, epochs, (tx) => tx
      .insert(candidates)
      .values({
        candidateSet: suite.set,
        witnessId,
        depositionA: depositionIds[0],
        groupA: a.groupId,
        depositionB: depositionIds[1],
        groupB: b.groupId,
        exchangeA: a.id,
        exchangeB: b.id,
        sources: ["fixture"],
        rrfScore: 0,
        mergedRank: i + 1,
        evidence: [{ path: "fixture", fixture: c.id }],
      })
      .returning({ id: candidates.id }));
    ids.set(c.id, row.id);
  }
  return ids;
}
