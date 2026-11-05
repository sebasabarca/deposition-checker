// A whole case's candidate pool and issue packets, built from the stored evidence of all its active
// depositions with the retrieval code the frozen-corpus experiments measured: the paths of
// eval/retrievalProbe.ts (full text, LSA, question-centered, anchors), the factual path (factual.ts) and,
// when its local files are present, MiniLM (minilm.ts); then buildPool (frozen.ts), triage (triage.ts) and
// groupPool (grouping.ts), each with its defaults. No new heuristics, no model or API call.
//
// Items are eligible answer groups (evidence/eligibility.ts); every other group is listed in `excluded`.
// Keys: document d<depositionId>, session s<sessionId> (all parts of one sitting share it, so pairs are only
// across sittings), witness w<witnessId>. Pairs may join the same witness or two witnesses.

import { createHash } from "node:crypto";
import { asc, eq, inArray } from "drizzle-orm";
import type { Pool } from "pg";
import type { Database } from "../db/client";
import { depositions, exchanges, witnesses } from "../db/schema";
import type { LoadedFixtures } from "../eval/evidenceFixtures";
import { fullText, loadItems, NEIGHBOURS_PER_ITEM, type ProbeItem } from "../eval/retrievalProbe";
import { lastWords, representationText } from "./embeddings";
import { factualNeighbours } from "./factual";
import { buildPool, itemKeyOf, type Candidate, type CandidatePool, type FrozenItem, type PathNeighbours, type Ranked } from "./frozen";
import { DEFAULT_GROUPING, groupPool, type PacketSet } from "./grouping";
import { anchorNeighbours, anchors, denseNeighbours, lsa, nameVocabulary, sparseNeighbours, tfidf, tokens, type Neighbour } from "./independent";
import { loadMiniLM, MODEL_ID, MODEL_REVISION, modelFilesPresent, WINDOWING } from "./minilm";
import { DEFAULT_TRIAGE, triage } from "./triage";

export const CASE_POOL_VERSION = "case-pool-v1";
const DEFAULT_PER_ITEM = 5;
const MINILM_PATH = "E_minilm_qac_s"; // the representation the corrected baseline measured: question, answer, context, labels stripped

export type CaseItem = FrozenItem & { depositionId: number; witnessId: number; sessionId: number; exchangeIds: number[] };
export type CasePoolResult = {
  items: CaseItem[];
  excluded: { key: string; depositionId: number; groupId: number; class: string; reason: string }[];
  documents: { depositionId: number; witnessId: number; sessionId: number; excludedReason: string | null; status: string; included: boolean; reason: string | null }[];
  paths: { name: string; available: boolean; reason: string | null; depth: number }[];
  pool: CandidatePool;
  triage: { kept: Candidate[]; deferred: { a: string; b: string; stage: string; reason: string }[]; stages: { name: string; in: number; out: number }[] };
  packets: PacketSet;
  settings: Record<string, unknown>;
  sourceHash: string;
};

// Diversification (all optional, off by default): perSession / perWitness keep each item's best partners in every
// other session / witness on top of the fused top perItem; perPath keeps each path's own best partners.
export type CaseSelection = { perSession?: number; perWitness?: number; perPath?: number; minShare?: number };

export async function buildCasePool(db: Database, pool: Pool, caseId: number, options: { perItem?: number; minilm?: "auto" | "off"; selection?: CaseSelection; depositionIds?: readonly number[] } = {}): Promise<CasePoolResult> {
  const perItem = options.perItem ?? DEFAULT_PER_ITEM;
  const depth = NEIGHBOURS_PER_ITEM;
  const rows = await db
    .select({ id: depositions.id, witnessId: depositions.witnessId, sessionId: depositions.sessionId, excludedReason: depositions.excludedReason, status: depositions.status, parserVersion: depositions.parserVersion })
    .from(depositions).where(eq(depositions.caseId, caseId)).orderBy(asc(depositions.id));
  const documents = rows.map((d) => {
    // depositionIds: an analysis of selected depositions only; every other deposition of the case is left out of it.
    const reason = d.excludedReason !== null ? `excluded: ${d.excludedReason}` : d.status !== "ready" ? `not ready: ${d.status}` : options.depositionIds && !options.depositionIds.includes(d.id) ? "not selected for this analysis" : null;
    return { depositionId: d.id, witnessId: d.witnessId, sessionId: d.sessionId, excludedReason: d.excludedReason, status: d.status, included: reason === null, reason };
  });
  const included = rows.filter((_, n) => documents[n].included);
  const docOf = new Map(included.map((d) => [`d${d.id}`, d]));

  // loadItems reads only the document map; ids are contiguous in deposition order.
  const { items: probe, excluded: probeExcluded } = await loadItems(db, { docId: new Map(included.map((d) => [`d${d.id}`, d.id])) } as LoadedFixtures);
  const parts = included.length ? await db.select({ id: exchanges.id, depositionId: exchanges.depositionId, groupId: exchanges.groupId }).from(exchanges).where(inArray(exchanges.depositionId, included.map((d) => d.id))).orderBy(asc(exchanges.id)) : [];
  const exchangeIdsOf = new Map<string, number[]>();
  for (const p of parts) { const k = `${p.depositionId}:${p.groupId}`; exchangeIdsOf.set(k, [...(exchangeIdsOf.get(k) ?? []), p.id]); }

  const toItem = (i: ProbeItem): CaseItem => {
    const d = docOf.get(i.document)!;
    return {
      key: itemKeyOf(i.document, i.orderedPositions), document: i.document, witness: `w${d.witnessId}`, session: `s${d.sessionId}`, groupId: i.groupId,
      positions: i.orderedPositions, sourceHash: i.sourceHash, question: i.question, answer: i.answer, context: i.context, eligibility: i.eligibility,
      depositionId: d.id, witnessId: d.witnessId, sessionId: d.sessionId, exchangeIds: exchangeIdsOf.get(`${d.id}:${i.groupId}`) ?? [],
    };
  };
  const items = probe.map(toItem);
  const excluded = probeExcluded.map(toItem).map((i) => ({ key: i.key, depositionId: i.depositionId, groupId: i.groupId, class: i.eligibility!.class, reason: i.eligibility!.reason }));
  if (new Set([...items.map((i) => i.key), ...excluded.map((i) => i.key)]).size !== items.length + excluded.length) throw new Error("item keys are not unique");

  // Each path's neighbours, other sessions only (every path excludes the item's own session).
  const toNeighbours = (name: string, lists: Neighbour[][]): PathNeighbours => ({ path: name, depth, neighbours: Object.fromEntries(lists.map((ns, i) => [items[i].key, ns.slice(0, depth).map((x): Ranked => [items[x.id].key, Math.round(x.score * 1e6) / 1e6])])) });
  const paths: CasePoolResult["paths"] = [];
  const neighbours: PathNeighbours[] = [];
  const minilm = options.minilm ?? "auto";
  if (new Set(items.map((i) => i.sessionId)).size >= 2) {
    const context = (i: ProbeItem) => lastWords(i.context);
    const names = nameVocabulary(probe.map((i) => `${i.text} ${i.context}`));
    const add = (name: string, lists: Neighbour[][]) => { neighbours.push(toNeighbours(name, lists)); paths.push({ name, available: true, reason: null, depth }); };
    add("A_fulltext", await fullText(pool, probe, depth));
    { const t = tfidf(probe.map((i) => tokens(`${i.question} ${i.answer} ${context(i)}`)), { maxDfShare: 0.5 }); add("B_semantic_lsa", denseNeighbours(probe, lsa(t.vectors, t.vocabulary.length), depth)); }
    { const t = tfidf(probe.map((i) => tokens(`${i.question} ${context(i)}`))); add("C_question", sparseNeighbours(probe, t.vectors, depth)); }
    add("D_anchors", anchorNeighbours(probe, probe.map((i) => anchors(i.text, names)), probe.map((i) => anchors(i.context, names)), depth));
    // F reads the witness's name to recognise "I" in claims, so it gets the stored name, not the w<id> key.
    const witnessName = new Map((await db.select({ id: witnesses.id, name: witnesses.name }).from(witnesses).where(eq(witnesses.caseId, caseId))).map((w) => [w.id, w.name]));
    add("F_factual", factualNeighbours(items.map((i) => ({ ...i, witness: witnessName.get(i.witnessId) ?? "" })), depth));
    if (minilm === "off") paths.push({ name: MINILM_PATH, available: false, reason: "turned off", depth });
    else if (!modelFilesPresent()) paths.push({ name: MINILM_PATH, available: false, reason: "model files absent under data/raw/models (never downloaded here)", depth });
    else {
      try {
        const model = await loadMiniLM();
        const { vectors } = await model.embed(items.map((i) => representationText(i, "qac", true)));
        if (model.fetchAttempts()) throw new Error("the model library attempted network access");
        add(MINILM_PATH, denseNeighbours(probe, vectors.map((v) => Float64Array.from(v)), depth));
      } catch (e) {
        paths.push({ name: MINILM_PATH, available: false, reason: e instanceof Error ? e.message : String(e), depth });
      }
    }
  } else paths.push({ name: "all", available: false, reason: "fewer than two sessions with eligible testimony", depth });

  const sel = options.selection ?? {};
  if ((sel.perSession ?? 0) > 0 && (sel.perWitness ?? 0) > 0) throw new Error("selection: perSession and perWitness are alternatives");
  const byKey = new Map(items.map((i) => [i.key, i]));
  const quota = (sel.perSession ?? 0) > 0 ? { groupOf: (k: string) => byKey.get(k)!.session, perGroup: sel.perSession!, minShare: sel.minShare } : (sel.perWitness ?? 0) > 0 ? { groupOf: (k: string) => byKey.get(k)!.witness, perGroup: sel.perWitness!, minShare: sel.minShare } : undefined;
  const selName = [quota ? `${sel.perSession ? "s" : "w"}${quota.perGroup}${sel.minShare ? `f${sel.minShare}` : ""}` : "", sel.perPath ? `p${sel.perPath}` : ""].filter(Boolean).join("-");
  const candidatePool = buildPool(`case-${caseId}-fused-top${perItem}${selName ? `-${selName}` : ""}`, neighbours, perItem, { quota, perPath: sel.perPath });
  const t = triage(candidatePool, items);
  if (t.kept.length + t.deferred.length !== candidatePool.candidates.length) throw new Error("triage lost candidates");
  const packets = groupPool({ ...candidatePool, name: `${candidatePool.name}-triaged`, candidates: t.kept }, items, `case-${caseId}-packets`, candidatePool.name);

  const sourceHash = createHash("sha256").update(items.map((i) => `${i.key}\t${i.sourceHash}`).sort().join("\n")).digest("hex");
  return {
    items, excluded, documents, paths, pool: candidatePool,
    triage: { kept: t.kept, deferred: t.deferred.map((d) => ({ a: d.candidate.a, b: d.candidate.b, stage: d.stage, reason: d.reason })), stages: t.stages },
    packets,
    settings: {
      version: CASE_POOL_VERSION, perItem, ...(options.selection ? { selection: options.selection } : {}), neighboursPerItem: depth, fusion: "reciprocal rank, k = 60, per query", contextWords: 60, lsa: { dims: 150, seed: 7 },
      minilm: paths.some((p) => p.name === MINILM_PATH && p.available) ? { model: MODEL_ID, revision: MODEL_REVISION, representation: "qac", strip: true, windowing: WINDOWING } : "unavailable",
      triage: DEFAULT_TRIAGE, grouping: DEFAULT_GROUPING,
      parserVersions: Object.fromEntries(included.map((d) => [`d${d.id}`, d.parserVersion])),
    },
    sourceHash,
  };
}
