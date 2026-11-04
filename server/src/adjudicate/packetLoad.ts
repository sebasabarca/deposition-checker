import { eq } from "drizzle-orm";
import type { FrozenItem } from "../retrieve/frozen";
import type { EvidencePacket } from "../retrieve/grouping";
import { witnesses } from "../db/schema";
import type { Database } from "../db/client";
import { loadSide } from "./packet";
import type { IssuePacket, PacketPassage } from "./packetPrompt";

export type UnresolvedItem = { key: string; reason: string };
export type ResolvedPassages = {
  passages: Map<string, PacketPassage>;
  unresolved: UnresolvedItem[];
  extraStoredLines: Record<string, number>;
};

const positionOf = (line: { page: number; line: number }) => `${line.page}:${line.line}`;

export async function resolvePassages(db: Database, items: FrozenItem[], docIds: Map<string, number>): Promise<ResolvedPassages> {
  const passages = new Map<string, PacketPassage>();
  const unresolved: UnresolvedItem[] = [];
  const extraStoredLines: Record<string, number> = {};

  for (const item of items) {
    try {
      const depositionId = docIds.get(item.document);
      if (depositionId === undefined) {
        unresolved.push({ key: item.key, reason: "document not loaded" });
        continue;
      }

      const side = await loadSide(db, depositionId, item.groupId, "A");
      const requested = new Set(item.positions);
      const storedPositions = new Set(side.lines.map(positionOf));
      const extra = side.lines.filter((line) => !requested.has(positionOf(line))).length;
      if (extra > 0) extraStoredLines[item.key] = extra;
      const missing = item.positions.filter((position) => !storedPositions.has(position)).length;
      if (missing > 0) {
        unresolved.push({ key: item.key, reason: `${missing} position${missing === 1 ? "" : "s"} not found` });
        continue;
      }

      const [storedWitness] = await db.select({ name: witnesses.name }).from(witnesses).where(eq(witnesses.id, side.witnessId));
      if (!storedWitness) {
        unresolved.push({ key: item.key, reason: "stored witness not found" });
        continue;
      }
      if (storedWitness.name !== item.witness) {
        unresolved.push({ key: item.key, reason: `witness mismatch: item "${item.witness}", stored "${storedWitness.name}"` });
        continue;
      }

      passages.set(item.key, { ...side, key: item.key, session: item.session, witnessName: storedWitness.name });
    } catch (error) {
      unresolved.push({ key: item.key, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  return { passages, unresolved, extraStoredLines };
}

export function buildIssuePacket(packet: EvidencePacket, passages: Map<string, PacketPassage>): {
  packet: IssuePacket | null;
  unbuilt: { a: string; b: string; reason: string }[];
} {
  const pairs = [] as IssuePacket["pairs"];
  const unbuilt: { a: string; b: string; reason: string }[] = [];
  for (const [index, [a, b]] of packet.pairs.entries()) {
    const pairId = `R${index + 1}`;
    const left = passages.get(a);
    const right = passages.get(b);
    if (!left || !right) {
      const missing = !left ? a : b;
      unbuilt.push({ a, b, reason: `item not resolved: ${missing}` });
      continue;
    }
    if (a !== b && left.id === right.id) {
      unbuilt.push({ a, b, reason: `different items resolve to the same passage ID: ${left.id}` });
      continue;
    }
    pairs.push({ pairId, a: left.id, b: right.id });
  }
  if (pairs.length === 0) return { packet: null, unbuilt };
  const used = new Set(pairs.flatMap((pair) => [pair.a, pair.b]));
  return { packet: { id: packet.id, passages: packet.items.map((key) => passages.get(key)).filter((p): p is PacketPassage => !!p && used.has(p.id)), pairs }, unbuilt };
}

export function pairwisePackets(packet: IssuePacket): IssuePacket[] {
  return packet.pairs.map((pair) => ({
    // The slash form is the derived packet id; packet.id:pairId is the corresponding original join key.
    id: `${packet.id}/${pair.pairId}`,
    passages: [pair.a, pair.b].map((id) => packet.passages.find((passage) => passage.id === id)!).filter(Boolean),
    pairs: [{ pairId: "R1", a: pair.a, b: pair.b }],
  }));
}
