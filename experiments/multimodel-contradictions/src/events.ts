// The event path: index each session's events, align them across sessions, compare one event at a
// time. Pure. Only original testimony reaches a prompt; labels and retrieval output never do.
import { z } from "zod";
import { fill, prompt, renderLines, type Dataset, type Line, type Session } from "./data";
import { Finding } from "./schemas";

export const CHUNK_PAGES = 10;
export const CHUNK_OVERLAP_PAGES = 1;
export const CONTEXT_LINES = 3;

export const MapOutput = z.strictObject({
  events: z.array(z.strictObject({ name: z.string(), when: z.string(), people: z.array(z.string()), first: z.string(), last: z.string(), procedural: z.boolean() })),
});
export const AlignOutput = z.strictObject({ groups: z.array(z.strictObject({ name: z.string(), a_ids: z.array(z.string()), b_ids: z.array(z.string()) })) });
export const CompareOutput = z.strictObject({
  details: z.array(z.strictObject({ detail: z.string(), session_a: z.string(), session_b: z.string(), relation: z.enum(["same", "different", "only_one"]) })),
  summary: z.strictObject({ completion_status: z.enum(["complete", "partial"]), limitations: z.array(z.string()) }),
  findings: z.array(Finding),
});
export type MapOutput = z.infer<typeof MapOutput>;
export type AlignOutput = z.infer<typeof AlignOutput>;

export const jsonSchema = (s: z.ZodType) => {
  const { $schema: _unused, ...rest } = z.toJSONSchema(s);
  return rest as Record<string, unknown>;
};
export function parseWith<T>(schema: z.ZodType<T>) {
  return (text: string | null): { output: T | null; error: string | null } => {
    if (!text) return { output: null, error: "no output" };
    try {
      const parsed = schema.safeParse(JSON.parse(text));
      return parsed.success ? { output: parsed.data, error: null } : { output: null, error: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
    } catch {
      return { output: null, error: "not JSON" };
    }
  };
}

export function chunksOf(lines: readonly Line[], pages = CHUNK_PAGES, overlap = CHUNK_OVERLAP_PAGES): Line[][] {
  const numbers = [...new Set(lines.map((l) => l.page))];
  const out: Line[][] = [];
  for (let at = 0; at < numbers.length; at += pages - overlap) {
    const wanted = new Set(numbers.slice(at, at + pages));
    out.push(lines.filter((l) => wanted.has(l.page)));
    if (at + pages >= numbers.length) break;
  }
  return out;
}

export const mapPrompt = (d: Dataset, s: Session, chunk: readonly Line[]) => fill(prompt("events-map.md"), { witness: d.witness, description: s.description, excerpt: renderLines(chunk) });

export type PlacedEvent = { id: string; session: "A" | "B"; name: string; when: string; people: string[]; from: number; to: number; procedural: boolean }; // from, to: indexes into session.lines
export type Rejected = { session: "A" | "B"; chunk: number; name: string; first: string; last: string };

// Code checks each span against the chunk the model was shown. A bad one is kept and counted, and its
// lines stay unplaced.
export function placeEvents(session: Session, chunks: readonly Line[][], outputs: readonly (MapOutput | null)[]) {
  const events: PlacedEvent[] = [];
  const rejected: Rejected[] = [];
  const failedChunks: number[] = [];
  const at = new Map(session.lines.map((l, i) => [l.ref, i]));
  outputs.forEach((output, c) => {
    if (!output) return void failedChunks.push(c);
    const shown = new Set(chunks[c].map((l) => l.ref));
    for (const e of output.events) {
      const [first, last] = [e.first.trim(), e.last.trim()];
      if (!shown.has(first) || !shown.has(last) || at.get(first)! > at.get(last)!) rejected.push({ session: session.label, chunk: c, name: e.name, first, last });
      else events.push({ id: `${session.label}${events.length + 1}`, session: session.label, name: e.name, when: e.when, people: e.people, from: at.get(first)!, to: at.get(last)!, procedural: e.procedural });
    }
  });
  return { events, rejected, failedChunks };
}

export function coverage(session: Session, events: readonly PlacedEvent[]) {
  const state = new Array<"unplaced" | "procedural" | "event">(session.lines.length).fill("unplaced");
  for (const e of events) for (let i = e.from; i <= e.to; i++) if (state[i] !== "event") state[i] = e.procedural ? "procedural" : "event";
  const unplaced = session.lines.filter((_, i) => state[i] === "unplaced");
  return { lines: session.lines.length, event: state.filter((s) => s === "event").length, procedural: state.filter((s) => s === "procedural").length, unplaced: unplaced.length, unplacedPages: [...new Set(unplaced.map((l) => l.page))] };
}

export const alignPrompt = (d: Dataset, events: readonly PlacedEvent[]) => {
  const list = (label: "A" | "B") => events.filter((e) => e.session === label && !e.procedural).map((e) => `${e.id} | ${e.name} | when: ${e.when} | people: ${e.people.join(", ") || "none named"}`).join("\n");
  return fill(prompt("events-align.md"), { witness: d.witness, events_a: list("A"), events_b: list("B") });
};

export type Group = { id: string; name: string; a: PlacedEvent[]; b: PlacedEvent[] };
// Groups with both sessions get compared. One-sided events, ids the model left out and ids it made up
// are returned for counting, never dropped silently.
export function readGroups(output: AlignOutput, events: readonly PlacedEvent[]) {
  const known = new Map(events.filter((e) => !e.procedural).map((e) => [e.id, e]));
  const seen = new Set<string>();
  const unknownIds: string[] = [];
  const groups: Group[] = output.groups.map((g, n) => {
    const members = [...g.a_ids, ...g.b_ids].flatMap((id) => {
      const e = known.get(id.trim());
      if (!e) unknownIds.push(id);
      else seen.add(e.id);
      return e ? [e] : [];
    });
    return { id: `G${n + 1}`, name: g.name, a: members.filter((e) => e.session === "A"), b: members.filter((e) => e.session === "B") };
  });
  return { comparable: groups.filter((g) => g.a.length > 0 && g.b.length > 0), oneSided: groups.filter((g) => g.a.length + g.b.length > 0 && (g.a.length === 0 || g.b.length === 0)), leftOut: [...known.keys()].filter((id) => !seen.has(id)), unknownIds };
}

// A group's testimony from one session: its spans with context, overlaps merged, in transcript order.
export function groupLines(session: Session, events: readonly PlacedEvent[], context = CONTEXT_LINES): string {
  const spans = events.map((e) => [Math.max(0, e.from - context), Math.min(session.lines.length - 1, e.to + context)] as [number, number]).sort((x, y) => x[0] - y[0]);
  const merged: [number, number][] = [];
  for (const [from, to] of spans) {
    const last = merged[merged.length - 1];
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged.map(([from, to]) => renderLines(session.lines.slice(from, to + 1))).join("\n[...]\n");
}

export const comparePrompt = (d: Dataset, g: Group) =>
  fill(prompt("events-compare.md"), { witness: d.witness, event: g.name, session_a_description: d.sessions[0].description, session_b_description: d.sessions[1].description, session_a: groupLines(d.sessions[0], g.a), session_b: groupLines(d.sessions[1], g.b) });

// Whether a known target's lines both reach one compared group: what grouping alone can make possible.
export const reachesComparison = (g: Group, d: Dataset, target: { a: readonly string[]; b: readonly string[] }) => {
  const has = (s: Session, events: readonly PlacedEvent[], refs: readonly string[]) => events.some((e) => s.lines.slice(e.from, e.to + 1).some((l) => refs.includes(l.ref)));
  return has(d.sessions[0], g.a, target.a) && has(d.sessions[1], g.b, target.b);
};

// Rule-based stand-ins that measure the plumbing, never Haiku: fixed windows, paired by shared words.
export function mockEvents(d: Dataset, window = 12) {
  return d.sessions.flatMap((s) => {
    const out: PlacedEvent[] = [];
    for (let from = 0; from < s.lines.length; from += window) out.push({ id: `${s.label}${out.length + 1}`, session: s.label, name: s.lines.slice(from, from + window).map((l) => l.text).join(" "), when: "not stated", people: [], from, to: Math.min(s.lines.length - 1, from + window - 1), procedural: false });
    return out;
  });
}
export function mockAlign(events: readonly PlacedEvent[], words: (t: string) => string[], perEvent = 3): AlignOutput {
  const bag = new Map(events.map((e) => [e.id, new Set(words(e.name))]));
  const shared = (x: PlacedEvent, y: PlacedEvent) => [...bag.get(x.id)!].filter((w) => bag.get(y.id)!.has(w)).length;
  return { groups: events.filter((e) => e.session === "A").flatMap((a) => events.filter((b) => b.session === "B").map((b) => ({ b, n: shared(a, b) })).filter((x) => x.n > 0).sort((x, y) => y.n - x.n).slice(0, perEvent).map(({ b }) => ({ name: `${a.id}/${b.id}`, a_ids: [a.id], b_ids: [b.id] }))) };
}
