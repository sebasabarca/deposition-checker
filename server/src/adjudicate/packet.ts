// The evidence packet for one candidate pair (DESIGN.md, "Ask 2"): both logical exchanges, whole,
// from the stored source lines, with a few lines of context around each, and the witness and session
// metadata. Retrieval signals (ranks, claims, shared terms) are deliberately left out, so the model
// judges the testimony, not why the pair was retrieved. The packet is stored with the verdict.

import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { candidates, depositions, exchangeLines, exchanges, lines, witnesses } from "../db/schema";
import type { EvidenceExchange, EvidenceLine } from "../verify";

export const CONTEXT_LINES = 5;

export type PacketLine = { id: number; page: number; line: number; text: string };
export type PacketExchange = {
  id: string; // "E<first part id>": the ID the model cites
  depositionId: number;
  groupId: number;
  session: "A" | "B";
  takenOn: string | null;
  witnessId: number;
  partIds: number[];
  wholeExchange: boolean; // every part of the logical exchange is included
  lines: (PacketLine & { role: EvidenceLine["role"] })[];
  before: PacketLine[];
  after: PacketLine[];
  // Context stopped early because the transcript skips pages there (excerpted exhibits do): lines
  // from beyond the gap aren't shown as if they were continuous with the exchange.
  gapBefore: boolean;
  gapAfter: boolean;
};
export type Packet = { candidateId: number; witnessId: number; witnessName: string; a: PacketExchange; b: PacketExchange };

export const exchangeIdOf = (firstPartId: number) => `E${firstPartId}`;

// Layer 1's view of a packet side.
export const evidenceOf = (x: PacketExchange): EvidenceExchange => ({
  id: x.id,
  witnessId: x.witnessId,
  lines: x.lines,
  context: [...x.before, ...x.after],
});

const ref = (l: PacketLine) => `${l.page}:${String(l.line).padStart(2, "0")}`;
const show = (ls: readonly PacketLine[]) => ls.map((l) => `  ${ref(l)}  ${l.text}`).join("\n");

// The user message: plain text with page:line on every line. Pure.
export function formatPacket(p: Packet): string {
  const side = (x: PacketExchange) =>
    [
      `<session_${x.session.toLowerCase()} deposition="${x.depositionId}" taken_on="${x.takenOn ?? "not stated"}">`,
      x.before.length ? `Context before (not part of the exchange):\n${show(x.before)}` : "Context before: none",
      ...(x.gapBefore ? ["[pages omitted from the transcript here]"] : []),
      `Exchange [${x.id}] (pages ${ref(x.lines[0])} to ${ref(x.lines[x.lines.length - 1])}):\n${show(x.lines)}`,
      ...(x.gapAfter ? ["[pages omitted from the transcript here]"] : []),
      x.after.length ? `Context after (not part of the exchange):\n${show(x.after)}` : "Context after: none",
      `</session_${x.session.toLowerCase()}>`,
    ].join("\n");
  return [`Witness: ${p.witnessName}`, "", side(p.a), "", side(p.b), "", `Compare exchange [${p.a.id}] (session A) with exchange [${p.b.id}] (session B).`].join("\n");
}

// What is stored with the verdict: the IDs shown, never the text again (the lines are in the database).
export const packetRecord = (p: Packet) => ({
  candidateId: p.candidateId,
  witnessId: p.witnessId,
  contextLines: CONTEXT_LINES,
  sides: [p.a, p.b].map((x) => ({
    id: x.id,
    session: x.session,
    depositionId: x.depositionId,
    groupId: x.groupId,
    partIds: x.partIds,
    wholeExchange: x.wholeExchange,
    lineIds: x.lines.map((l) => l.id),
    contextLineIds: [...x.before, ...x.after].map((l) => l.id),
    gapBefore: x.gapBefore,
    gapAfter: x.gapAfter,
  })),
});

// The context lines up to the first page skip, nearest first. A next page is continuous; a jump of
// more than one page means pages are missing from the transcript. Pure.
export function untilGap<T extends { page: number }>(from: { page: number }, nearestFirst: readonly T[]): { lines: T[]; gap: boolean } {
  const kept: T[] = [];
  let previous = from.page;
  for (const l of nearestFirst) {
    if (Math.abs(l.page - previous) > 1) return { lines: kept, gap: true };
    kept.push(l);
    previous = l.page;
  }
  return { lines: kept, gap: false };
}

export async function loadSide(db: Database, depositionId: number, groupId: number, session: "A" | "B"): Promise<PacketExchange> {
  const parts = await db
    .select({ id: exchanges.id, partCount: exchanges.partCount, witnessId: exchanges.witnessId })
    .from(exchanges)
    .where(and(eq(exchanges.depositionId, depositionId), eq(exchanges.groupId, groupId)))
    .orderBy(asc(exchanges.partNo));
  if (parts.length === 0) throw new Error(`No exchange ${depositionId}:${groupId}.`);
  // Parts overlap (a long answer repeats its question), so a line is kept once, with its first role.
  const members = await db
    .selectDistinctOn([lines.id], { id: lines.id, page: lines.printedPage, line: lines.lineNo, text: lines.rawText, role: exchangeLines.role })
    .from(exchangeLines)
    .innerJoin(lines, eq(lines.id, exchangeLines.lineId))
    .where(inArray(exchangeLines.exchangeId, parts.map((p) => p.id)))
    .orderBy(asc(lines.id), asc(exchangeLines.exchangeId));
  members.sort((x, y) => x.page - y.page || x.line - y.line);
  const first = members[0];
  const last = members[members.length - 1];
  const around = (op: "before" | "after") =>
    db
      .select({ id: lines.id, page: lines.printedPage, line: lines.lineNo, text: lines.rawText })
      .from(lines)
      .where(
        and(
          eq(lines.depositionId, depositionId),
          op === "before"
            ? or(sql`${lines.printedPage} < ${first.page}`, and(eq(lines.printedPage, first.page), sql`${lines.lineNo} < ${first.line}`))
            : or(sql`${lines.printedPage} > ${last.page}`, and(eq(lines.printedPage, last.page), sql`${lines.lineNo} > ${last.line}`)),
        ),
      )
      .orderBy(op === "before" ? sql`${lines.printedPage} desc, ${lines.lineNo} desc` : sql`${lines.printedPage} asc, ${lines.lineNo} asc`)
      .limit(CONTEXT_LINES);
  const [nearBefore, nearAfter] = await Promise.all([around("before"), around("after")]);
  const before = untilGap(first, nearBefore);
  const after = untilGap(last, nearAfter);
  const [deposition] = await db.select({ takenOn: depositions.takenOn }).from(depositions).where(eq(depositions.id, depositionId));
  return {
    id: exchangeIdOf(parts[0].id),
    depositionId,
    groupId,
    session,
    takenOn: deposition.takenOn,
    witnessId: parts[0].witnessId,
    partIds: parts.map((p) => p.id),
    wholeExchange: parts.length === parts[0].partCount,
    lines: members,
    before: before.lines.reverse(),
    after: after.lines,
    gapBefore: before.gap,
    gapAfter: after.gap,
  };
}

export async function loadPacket(db: Database, candidateId: number): Promise<Packet> {
  const [c] = await db.select().from(candidates).where(eq(candidates.id, candidateId));
  if (!c) throw new Error(`No candidate ${candidateId}.`);
  const [w] = await db.select({ name: witnesses.name }).from(witnesses).where(eq(witnesses.id, c.witnessId));
  const [a, b] = await Promise.all([loadSide(db, c.depositionA, c.groupA, "A"), loadSide(db, c.depositionB, c.groupB, "B")]);
  return { candidateId, witnessId: c.witnessId, witnessName: w.name, a, b };
}
