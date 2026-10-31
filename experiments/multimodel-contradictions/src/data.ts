// Prompt inputs built only from original testimony. Pure. Nothing here takes candidates, cards,
// topics, verdicts or labels, and packets carry only the fields below.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const ROOT = resolve("experiments/multimodel-contradictions"); // commands run from the repo root
export type Line = { ref: string; page: number; line: number; speaker: string; text: string };
export type Session = { label: "A" | "B"; description: string; lines: Line[] };
export type Dataset = { id: string; kind: "real" | "synthetic"; witness: string; sessions: [Session, Session] };
export type PacketSide = { label: "A" | "B"; description: string; range: string; before: Line[]; lines: Line[]; after: Line[] };
export type PairPacket = { pairId: string; kind: "real" | "synthetic"; witness: string; a: PacketSide; b: PacketSide };

export const refOf = (page: number, line: number) => `${page}:${String(line).padStart(2, "0")}`;
const show = (l: Line) => `${l.ref} ${l.text}`;
export const renderLines = (lines: readonly Line[]) => lines.map(show).join("\n");
const fill = (template: string, values: Record<string, string>) => template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
  if (!(k in values)) throw new Error(`No value for {{${k}}}.`);
  return values[k];
});
export const prompt = (name: string) => readFileSync(join(ROOT, "prompts", name), "utf8");
export const sha = (text: string) => createHash("sha256").update(text).digest("hex");

export const discoveryPrompt = (d: Dataset) =>
  fill(prompt("discovery-user.md"), { witness: d.witness, session_a_description: d.sessions[0].description, session_b_description: d.sessions[1].description, session_a: renderLines(d.sessions[0].lines), session_b: renderLines(d.sessions[1].lines) });

const passage = (s: PacketSide) => [...s.before.map((l) => `[context] ${show(l)}`), ...s.lines.map(show), ...s.after.map((l) => `[context] ${show(l)}`)].join("\n");
export const pairPrompt = (p: PairPacket) =>
  fill(prompt("pair-user.md"), { witness: p.witness, pair_id: p.pairId, session_a_description: p.a.description, session_b_description: p.b.description, range_a: p.a.range, range_b: p.b.range, passage_a: passage(p.a), passage_b: passage(p.b) });
