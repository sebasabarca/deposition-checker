// Transcripts with no Q./A. markers, where every turn opens with its speaker's label ("MS. PARK:" /
// "THE WITNESS:"): the examining attorney's turns are the questions (parser revision 11).
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readDeposition, readTextTranscript } from "../../server/src/ingest";
import { colloquyExaminers, type AttributedLine, type ExchangePart } from "../../server/src/ingest/exchanges";
import { toLineRows } from "../../server/src/ingest/rows";
import { evidenceFieldsOf } from "../../server/src/evidence/exchange";

const ref = (l: AttributedLine) => `${l.printedPage}:${l.lineNo}`;
const keyed = (sha: string, lines: AttributedLine[], parts: ExchangePart[]) =>
  parts.map((p) => ({ span: `${ref(lines[p.span.first])}-${ref(lines[p.span.last])}`, kind: p.kind, ...evidenceFieldsOf(sha, p.kind, p.lines.map((m) => ({ page: lines[m.index].printedPage!, line: lines[m.index].lineNo, text: lines[m.index].rawText, lineRole: m.role, speakerRole: lines[m.index].role }))) }));

// A page break inside a question and inside its answer, an objection with the examiner's "You can
// answer.", an exhibit note, an unidentified speaker and the closing remarks.
const PAGE_1 = [
  "                                   1",
  " 1                EXAMINATION",
  " 2   MS. PARK:  Where were you on",
  " 3   June 3?",
  " 4   THE WITNESS:  At the plaza. I handed",
  " 5   the letter to Peter.",
  " 6   MS. PARK:  Did he read it?",
  " 7   MR. DUNMORE:  Objection, form.",
  " 8   MS. PARK:  You can answer.",
  " 9   THE WITNESS:  He read it in front of",
  "10   me.",
  "11        (Exhibit 9 was marked for identification.)",
  "12   MS. PARK:  Is Exhibit 9 the letter? I'm",
];
const PAGE_2 = [
  "                                   2",
  " 1   asking about the copy you kept.",
  " 2   THE WITNESS:  Yes, my",
  " 3   copy.",
  " 4   UNIDENTIFIED SPEAKER:  Can we go off the record?",
  " 5   MS. PARK:  Nothing further.",
  " 6   MR. DUNMORE:  No questions.",
];
const SOURCE = [...PAGE_1, "", ...PAGE_2].join("\n");

describe("who examines in a transcript with no Q./A. markers", () => {
  const c = (name: string) => ({ turn: "colloquy" as const, name });
  const A = { turn: "A" as const, name: null };
  it("is the attorney whose turn comes right before most of the witness's turns", () => {
    expect(colloquyExaminers([c("MS. PARK"), A, c("MR. DUNMORE"), A, c("MS. PARK"), A])).toEqual(Array(6).fill("MS. PARK"));
  });
  it("is no one when no attorney precedes more than half of the witness's turns", () => {
    expect(colloquyExaminers([c("MS. PARK"), A, c("MR. DUNMORE"), A])).toEqual([null, null, null, null]);
    expect(colloquyExaminers([c("THE REPORTER"), A])).toEqual([null, null]); // only a titled attorney examines
  });
  it("follows a BY heading from where it stands", () => {
    const marks = [{ turn: "examiner" as const, name: "MR. DIAZ" }, c("MR. DIAZ"), A, { turn: "examiner" as const, name: "MS. LINDQVIST" }, c("MS. LINDQVIST"), A];
    expect(colloquyExaminers(marks)).toEqual(["MR. DIAZ", "MR. DIAZ", "MR. DIAZ", "MS. LINDQVIST", "MS. LINDQVIST", "MS. LINDQVIST"]);
  });
  it("leaves a transcript with Q-marked turns, or with no witness turn, to the existing rules", () => {
    expect(colloquyExaminers([{ turn: "Q", name: null }, A, c("MS. PARK"), A, c("MS. PARK"), A])).toEqual(Array(6).fill(null));
    expect(colloquyExaminers([{ turn: "examiner", name: "MR. DIAZ" }, c("MR. DIAZ")])).toEqual([null, null]);
  });
});

describe("colloquy-format transcripts", () => {
  const read = readTextTranscript(SOURCE, "vantongeren").exchanges!;
  const at = (page: number, line: number) => read.lines.find((l) => l.printedPage === page && l.lineNo === line)!;

  it("reads the examiner's turns as questions, THE WITNESS as answers, and keeps everyone else's role", () => {
    expect(read.lines.map((l) => [ref(l), l.role, l.speakerName])).toEqual([
      ["1:1", "unknown", null],
      ["1:2", "attorney", "MS. PARK"], ["1:3", "attorney", "MS. PARK"], // a turn over two lines
      ["1:4", "witness", null], ["1:5", "witness", null],
      ["1:6", "attorney", "MS. PARK"],
      ["1:7", "colloquy", "MR. DUNMORE"], // other counsel stay colloquy
      ["1:8", "attorney", "MS. PARK"],
      ["1:9", "witness", null], ["1:10", "witness", null],
      ["1:11", "parenthetical", null],
      ["1:12", "attorney", "MS. PARK"], ["2:1", "attorney", "MS. PARK"], // across the page break
      ["2:2", "witness", null], ["2:3", "witness", null],
      ["2:4", "unknown", "UNIDENTIFIED SPEAKER"], // never promoted to the witness
      ["2:5", "attorney", "MS. PARK"],
      ["2:6", "colloquy", "MR. DUNMORE"],
    ]);
  });

  it("gives every question and its answer an exchange, with an objection kept inside it", () => {
    const sha = "0".repeat(64);
    expect(keyed(sha, read.lines, read.parts).map((p) => [p.span, p.kind, p.speakerStatus])).toEqual([
      ["1:1-1:1", "qa", "uncertain"], // the "EXAMINATION" heading has no speaker
      ["1:2-1:5", "qa", "verified"],
      ["1:6-1:11", "qa", "verified"],
      ["1:12-2:4", "qa", "uncertain"], // an unidentified speaker leaves the exchange uncertain
      ["2:5-2:6", "qa", "invalid"], // closing remarks: no answer
    ]);
    const [, first, objected, crossing] = read.parts;
    expect(first).toMatchObject({ questionText: "Where were you on June 3?", answerText: "At the plaza. I handed the letter to Peter." });
    expect(objected.questionText).toBe("Did he read it?\nYou can answer.");
    expect(objected.dialogueText).toBe("Q (MS. PARK): Did he read it?\nMR. DUNMORE: Objection, form.\nQ (MS. PARK): You can answer.\nA: He read it in front of me.\nNOTE: (Exhibit 9 was marked for identification.)");
    expect(crossing).toMatchObject({ questionText: "Is Exhibit 9 the letter? I'm asking about the copy you kept.", answerText: "Yes, my copy." });
  });

  it("puts every source line in an exchange and keeps its text and page:line exactly as printed", () => {
    const covered = new Set(read.parts.flatMap((p) => p.lines.map((m) => m.index)));
    expect(covered.size).toBe(read.lines.length);
    const printed = [...PAGE_1.slice(1).map((r) => [1, r] as const), ...PAGE_2.slice(1).map((r) => [2, r] as const)];
    expect(toLineRows(1, read.lines).map((r) => [r.printedPage, r.lineNo, r.rawText])).toEqual(printed.map(([page, row]) => [page, Number(row.slice(0, 2)), row.slice(2).trim()]));
  });

  it("reads text with no line numbers the same way, cited by file line", () => {
    const unnumbered = readTextTranscript([...PAGE_1.slice(1), ...PAGE_2.slice(1)].map((r) => r.slice(5)).join("\n"), "vantongeren").exchanges!;
    expect(unnumbered.lines.map((l) => [l.printedPage, l.lineNo])).toEqual(read.lines.map((_, i) => [0, i + 1]));
    expect(unnumbered.lines.map((l) => l.role)).toEqual(read.lines.map((l) => l.role));
    expect(unnumbered.parts.map((p) => [p.span.first, p.span.last])).toEqual(read.parts.map((p) => [p.span.first, p.span.last]));
  });

  it("reads the same file the same way every time", () => {
    const again = readTextTranscript(SOURCE, "vantongeren").exchanges!;
    expect(again).toEqual(read);
    expect(keyed("a".repeat(64), again.lines, again.parts)).toEqual(keyed("a".repeat(64), read.lines, read.parts));
  });

  it("leaves a Q./A. transcript's attorney labels as colloquy", () => {
    const qa = readTextTranscript([" 1   Q.  Where were you?", " 2   A.  Home.", " 3   MS. PARK:  Objection.", " 4   MS. PARK:  Objection again.", " 5   Q.  Why?", " 6   A.  Because."].join("\n"), "webb").exchanges!;
    expect(qa.lines.map((l) => l.role)).toEqual(["attorney", "witness", "colloquy", "colloquy", "attorney", "witness"]);
    expect(qa.parts.map((p) => [p.span.first, p.span.last])).toEqual([[0, 3], [4, 5]]);
  });
});

// Every transcript of the independent corpus, and the real files under data/raw when they are present.
// Each read is hashed as a snapshot (lines with roles; exchanges with members, texts and evidence fields):
// the hashes below were taken before revision 11 for every file it doesn't change, and after it for the
// four colloquy-format files it fixes. Revision 12 changed three Simpson-archive reads, by exactly the 11 bare-"Q"
// splits of tests/fixtures/segments-v2-confirmed.json (checked line by line against revision 11's segments).
const CORPUS = "data/eval/independent-cross-v1";
const FIXTURE = `${CORPUS}-fixture.json`;
const SNAPSHOTS: Record<string, string> = {
  "corpus2/A01_witness1": "64fd7627b71e6f9f", "corpus2/A01_witness2": "b4269f06b5cee837", "corpus2/A02_witness1": "be4c65462f59cdac", "corpus2/A02_witness2": "bbea907dd501e575",
  "corpus2/A03_witness2": "08713836641e3761", "corpus2/A04_witness1": "eee5cd89fef0674e", "corpus2/A04_witness2": "45faeeb2cd1c67d0", "corpus2/A05_witness1": "da38b97247fd56de",
  "corpus2/B01_witness1": "bd1b9bd2a6881d81", "corpus2/B01_witness2": "0e7284a9cdc380f6", "corpus2/B02_witness1": "e64c657eec6b22c9", "corpus2/B02_witness2": "a03e37007e7051cf",
  "corpus2/B03_witness2": "6d28a033e7713bba", "corpus2/B04_witness1": "b066f73deadb8750", "corpus2/B04_witness2": "efe9099d010f941b", "corpus2/B05_witness1": "8d7ca7ff8ed30bea",
  // Revision 11's reads of the four colloquy-format files.
  "corpus2/A03_witness1": "fe317e1d35c3ca18", "corpus2/A05_witness2": "9532685be8584828", "corpus2/B03_witness1": "e9adf02f424dbe01", "corpus2/B05_witness2": "ab91113d14a2a5fc",
};
const RAW_SNAPSHOTS: Record<string, [string, string | undefined, string]> = {
  "ellison/p3171": ["data/raw/ellison/p3171.pdf", "Lawrence Ellison", "cf5f39000f32c59c"],
  "ellison/p3173": ["data/raw/ellison/p3173.pdf", "Lawrence Ellison", "6c9cbe3f1d0fcfa1"],
  "simpson/resnick-cross": ["data/raw/simpson/faye_resnick_february_11_1996_day_9_cross_examination.txt", "Faye Resnick", "a967467935050802"],
  "simpson/resnick-direct": ["data/raw/simpson/faye_resnick_february_11_1996_day_9_direct_examination.txt", "Faye Resnick", "8a16adebcbd43df1"],
  "simpson/simpson-day9": ["data/raw/simpson/o_j_simpson_february_27_1996_day_9.txt", "O.J. Simpson", "eae3b6abc3f23a33"],
  "simpson/simpson-day2": ["data/raw/simpson/o_j_simpson_january_23_1996_day_2.txt", "O.J. Simpson", "76b488d5b8248086"],
  "li-sample.txt": ["data/raw/transcripts/legalinformatics/li-sample.txt", undefined, "3c16bfe63bc5b0ae"],
  "li-sample.rtf": ["data/raw/transcripts/derived/li-sample.textutil.rtf", undefined, "1d0daa5557506866"],
  "li-sample.docx": ["data/raw/transcripts/derived/li-sample.textutil.docx", undefined, "c6f0a8d229a7be9e"],
  "sample-deposition.txt": ["data/raw/transcripts/readback/sample-deposition.txt", undefined, "a480cb046c17d7eb"],
  "sample-deposition.rtf": ["data/raw/transcripts/derived/sample-deposition.textutil.rtf", undefined, "08b8bef26045cadd"],
  "sample-deposition.docx": ["data/raw/transcripts/derived/sample-deposition.textutil.docx", undefined, "b4952c738223bde7"],
};

async function snapshot(path: string, witness?: string) {
  const data = new Uint8Array(readFileSync(path));
  const sha = createHash("sha256").update(data).digest("hex");
  const ex = (await readDeposition(data, undefined, undefined, witness)).exchanges!;
  const L = ex.lines;
  const shape = {
    sha,
    lines: L.map((l) => [l.printedPage, l.lineNo, l.rawText, l.role, l.speakerName, l.segments ?? null]),
    parts: ex.parts.map((p) => ({
      g: p.groupNo, p: p.partNo, kind: p.kind, flags: p.flags, members: p.lines, q: p.questionText, a: p.answerText, d: p.dialogueText,
      ...evidenceFieldsOf(sha, p.kind, p.lines.map((m) => {
        const l = L[m.index];
        return { page: l.printedPage!, line: l.lineNo, text: l.rawText, lineRole: m.role, speakerRole: l.role, segments: (m.segments ? (l.segments ?? []).slice(m.segments.from, m.segments.to + 1) : (l.segments ?? [])).map((s) => ({ role: s.role, start: s.start, end: s.end })) };
      })),
    })),
  };
  return { read: ex, digest: createHash("sha256").update(JSON.stringify(shape)).digest("hex").slice(0, 16) };
}

const fixture = existsSync(FIXTURE) ? (JSON.parse(readFileSync(FIXTURE, "utf8")) as { documents: Record<string, { local: string; witness: string }> }) : null;
describe.skipIf(!fixture || !Object.values(fixture.documents).every((d) => existsSync(d.local)))("the independent corpus (20 transcripts)", () => {
  it("reads every file as before, except the four colloquy-format files", async () => {
    for (const [name, doc] of Object.entries(fixture!.documents)) expect([name, (await snapshot(doc.local, doc.witness)).digest]).toEqual([name, SNAPSHOTS[`corpus2/${name}`]]);
  });

  const COUNTS: Record<string, { lines: number; exchanges: number; qa: number; verified: number }> = {
    A03_witness1: { lines: 93, exchanges: 25, qa: 23, verified: 23 },
    A05_witness2: { lines: 85, exchanges: 23, qa: 21, verified: 21 },
    B03_witness1: { lines: 110, exchanges: 27, qa: 25, verified: 25 },
    B05_witness2: { lines: 96, exchanges: 24, qa: 22, verified: 22 },
  };
  it("splits each colloquy-format file into its questions and answers, and rebuilds its text from the stored lines", async () => {
    for (const [name, want] of Object.entries(COUNTS)) {
      const doc = fixture!.documents[name];
      const { read } = await snapshot(doc.local, doc.witness);
      const statuses = keyed("0".repeat(64), read.lines, read.parts).map((p) => p.speakerStatus);
      expect([name, read.lines.length, read.exchanges.length, read.parts.filter((p) => p.kind === "qa" && p.question && p.answer).length, statuses.filter((s) => s === "verified").length]).toEqual([name, want.lines, want.exchanges, want.qa, want.verified]);
      expect(new Set(read.parts.flatMap((p) => p.lines.map((m) => m.index))).size).toBe(read.lines.length);
      // Every numbered row of the file is a stored line with that row's text, in order; nothing else is a line.
      const rows = readFileSync(doc.local, "utf8").replace(/\r\n?/g, "\n").split("\n");
      const stored = toLineRows(1, read.lines);
      const numbered = rows.filter((r) => /^\s*\d{1,2}(?:\s|$)/.test(r) && !/^\s{6,}\d+\s*$/.test(r));
      expect(numbered.map((r) => r.trim().replace(/^\d{1,2}\s*/, ""))).toEqual(stored.map((l) => l.rawText));
    }
  });
});

describe("real transcripts under data/raw (skipped when absent)", () => {
  for (const [name, [path, witness, digest]] of Object.entries(RAW_SNAPSHOTS)) {
    it.skipIf(!existsSync(path))(`${name} reads exactly as before revision 11`, async () => {
      expect((await snapshot(path, witness)).digest).toBe(digest);
    }, 120_000);
  }
});
