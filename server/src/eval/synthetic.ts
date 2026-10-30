// Synthetic adjudication evaluations, in suites of two invented sessions of one witness each. The
// text is invented, so it can be committed and sent to the model without exposing private testimony.
//   webb-synthetic-v1        v1's Marcus Webb transcripts (data/samples.ts), 6 cases. Development:
//                            the v2 and v3 prompts were written after seeing model results on them.
//   whitfield-synthetic-v1   Dana Whitfield (data/whitfield.ts), 10 cases. Held out: written before
//                            any model saw them, and not to be used to tune v3 (a change after seeing
//                            their results is a new prompt version, evaluated on fresh cases).
//
// Each case names the two exchanges by a phrase of their question, the label the case was built to
// have, and a verdict a correct adjudicator could give. The tests feed those verdicts through the
// real pipeline (packet, Layer 1, Layer 2, checks, score) with a fake model; a paid run sends the same
// packets to Sonnet and compares its classification with the label. Pure: no I/O.

import { TRANSCRIPT_1, TRANSCRIPT_2 } from "../data/samples";
import { WHITFIELD_1, WHITFIELD_2 } from "../data/whitfield";
import type { Verdict } from "../adjudicate/schema";
import { ELLISON_DOJ_V1 } from "../ingest/layout";
import type { SourceLine } from "../ingest/pdf";
import { parseTranscript } from "../transcript";

export const SYNTHETIC_SET = "webb-synthetic-v1";
export const SYNTHETIC_WITNESS = "Marcus Webb";
export const SYNTHETIC_SESSIONS = [
  { text: TRANSCRIPT_1, takenOn: "2023-03-14", firstPage: 10 },
  { text: TRANSCRIPT_2, takenOn: "2023-09-09", firstPage: 40 },
] as const;

const TURN_X = 112.5; // left of the layout's turn indent, where Q. and A. markers start
const LINE_WIDTH = 56;
// The layout's page length: a turn that continues from line 25 to the next page's line 1 would read
// as a gap after line 22 (ELLISON_DOJ_V1), splitting the exchange.
const LINES_PER_PAGE = ELLISON_DOJ_V1.maxLinesPerPage;

function wrap(text: string): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line && line.length + word.length + 1 > LINE_WIDTH) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}

// A v1 Q:/A: transcript as numbered transcript lines ("Q. …", "A. …", wrapped), starting at a page.
export function toSourceLines(transcript: string, firstPage: number): SourceLine[] {
  const texts = parseTranscript(transcript, "x").flatMap((p) => [...wrap(`Q. ${p.question}`), ...wrap(`A. ${p.answer}`)]);
  return texts.map((rawText, i) => {
    const printedPage = firstPage + Math.floor(i / LINES_PER_PAGE);
    const lineNo = (i % LINES_PER_PAGE) + 1;
    return { pdfPage: printedPage - firstPage + 1, printedPage, lineNo, lineFromPosition: lineNo, indentX: TURN_X, rawText };
  });
}

export type SyntheticLabel = "direct" | "inferential" | "false_positive" | "insufficient_evidence";
export type SyntheticCase = {
  id: string;
  kind:
    | "direct"
    | "direct_negation"
    | "conflicting_values"
    | "qualified"
    | "recollection_change"
    | "compatible"
    | "misleading_context"
    | "different_event"
    | "different_entity"
    | "compatible_approximation"
    | "compound_question"
    | "inferential";
  questionA: string; // a phrase of the session A (March) question
  questionB: string; // a phrase of the session B (September) question
  label: SyntheticLabel; // what the case was built to be
  acceptable: SyntheticLabel[]; // classifications a careful reviewer could also defend
  why: string;
  context?: string; // the surrounding context that matters, and how it should (or must not) be used
  dependsOnAssumption?: string; // when the label rests on something the testimony doesn't state
  ambiguity?: string; // a reason a careful reviewer might label it differently
  // A verdict a correct adjudicator could give, for the fake-model run; IDs are filled in from the packet.
  verdict?: Omit<Verdict, "evidenceAId" | "evidenceBId">;
};

const base: Pick<Verdict, "attributionA" | "attributionB" | "stanceA" | "stanceB" | "sameEvent" | "scopeAligned" | "aboutTimingOfSameEvent" | "inferenceSteps" | "unestablishedAssumptions" | "falsePositiveReason" | "alternativeExplanation" | "needsMoreContext"> = {
  attributionA: "asserted",
  attributionB: "asserted",
  stanceA: "affirms",
  stanceB: "affirms",
  sameEvent: "yes",
  scopeAligned: "yes",
  aboutTimingOfSameEvent: false,
  inferenceSteps: [],
  unestablishedAssumptions: [],
  falsePositiveReason: null,
  alternativeExplanation: null,
  needsMoreContext: false,
};

export const SYNTHETIC_CASES: SyntheticCase[] = [
  {
    id: "webb-cho",
    kind: "direct",
    questionA: "Had you met Daniel Cho",
    questionB: "And Daniel Cho",
    label: "direct",
    acceptable: ["direct"],
    why: "March: he had never heard of Cho before the case. September: he knew of Cho through mutual friends.",
    ambiguity:
      "Possibly inferential rather than direct (flagged October 29, label unchanged): September doesn't say when he knew of Cho, so the conflict holds only if that knowledge predated the case. adjudicate-v2 classified it inferential on exactly this assumption.",
    dependsOnAssumption: "His knowing of Cho through mutual friends predates 'this whole thing'.",
    verdict: {
      ...base,
      classification: "direct",
      keyPhraseA: "I'd never heard of him before this whole thing started",
      keyPhraseB: "I knew of him",
      conflictBasis: "explicit_negation",
      explanation: "Never having heard of Cho cannot be true if he knew of him through mutual friends.",
    },
  },
  {
    id: "webb-sleep",
    kind: "conflicting_values",
    questionA: "What time did you go to sleep",
    questionB: "What time did you go to sleep",
    label: "direct",
    acceptable: ["direct", "false_positive"],
    why: "Both answers are hedged, but around 10 or 10:30 and around midnight are more than an hour apart.",
    verdict: {
      ...base,
      classification: "direct",
      keyPhraseA: "Around 10, maybe 10:30",
      keyPhraseB: "Midnight maybe",
      conflictBasis: "value_conflict",
      aboutTimingOfSameEvent: true,
      alternativeExplanation: "Both times are estimates of an evening eight months earlier.",
      explanation: "The two bedtimes are at least 90 minutes apart.",
    },
  },
  {
    id: "webb-home",
    kind: "qualified",
    questionA: "Where were you on the evening",
    questionB: "Walk me through the evening",
    label: "direct",
    acceptable: ["direct", "inferential"],
    why: "March: home all evening. September: he thinks he went out briefly for groceries. The second is qualified.",
    verdict: {
      ...base,
      classification: "direct",
      keyPhraseA: "I was at home all evening",
      keyPhraseB: "I went out briefly to get some groceries",
      attributionB: "qualified",
      conflictBasis: "mutually_exclusive",
      alternativeExplanation: "A brief errand may not count as leaving home for the evening.",
      explanation: "Being home all evening excludes going out, though the second account is hedged.",
    },
  },
  {
    id: "webb-pizza",
    kind: "recollection_change",
    questionA: "Where were you on the evening",
    questionB: "You mentioned last time you ordered pizza",
    label: "false_positive",
    acceptable: ["false_positive", "insufficient_evidence"],
    why: "September doesn't deny the pizza: he might have done both and doesn't remember exactly.",
    verdict: {
      ...base,
      classification: "false_positive",
      keyPhraseA: "I ordered pizza around 7pm",
      keyPhraseB: "I don't remember exactly",
      attributionB: "does_not_recall",
      stanceB: "unclear",
      conflictBasis: "none",
      falsePositiveReason: "uncertain_recollection",
      explanation: "The later answer allows both the pizza and the groceries and claims no memory either way.",
    },
  },
  {
    id: "webb-alone",
    kind: "qualified",
    questionA: "Did you speak to anyone that night",
    questionB: "Did anyone see you that evening",
    label: "false_positive",
    acceptable: ["false_positive", "inferential"],
    why: "Being alone and speaking to no one is compatible with a neighbor who might have seen him; the second is hedged.",
    verdict: {
      ...base,
      classification: "false_positive",
      keyPhraseA: "No, I was alone",
      keyPhraseB: "My neighbor, Tom, might have seen me",
      attributionB: "qualified",
      sameEvent: "uncertain",
      conflictBasis: "none",
      falsePositiveReason: "qualified_statement",
      alternativeExplanation: "Waving to a neighbor might count as contact he denied in March.",
      explanation: "Not speaking to anyone and possibly being seen can both be true, and the second is hedged.",
    },
  },
  {
    id: "webb-hargrove",
    kind: "compatible",
    questionA: "Have you ever been to the Hargrove Street warehouse",
    questionB: "Had you ever visited the Hargrove Street area",
    label: "false_positive",
    acceptable: ["false_positive", "inferential"],
    why: "Never having been to the warehouse is compatible with driving through the area.",
    verdict: {
      ...base,
      classification: "false_positive",
      keyPhraseA: "Have you ever been to the Hargrove Street warehouse",
      keyPhraseB: "I've driven through that part of town",
      stanceA: "denies",
      sameEvent: "no",
      scopeAligned: "no",
      conflictBasis: "none",
      falsePositiveReason: "different_event",
      explanation: "The warehouse and the surrounding area are different places.",
    },
  },
];

export type SyntheticSuite = {
  set: string;
  witness: string;
  caseName: string;
  split: "development" | "held_out";
  sessions: readonly { text: string; takenOn: string; firstPage: number }[];
  cases: SyntheticCase[];
};

export const WEBB_SUITE: SyntheticSuite = {
  set: SYNTHETIC_SET,
  witness: SYNTHETIC_WITNESS,
  caseName: "Synthetic: Marcus Webb (fixture)",
  split: "development",
  sessions: SYNTHETIC_SESSIONS,
  cases: SYNTHETIC_CASES,
};

// Held out (written October 29, before any model call on them). Labels are for the developer's review.
export const WHITFIELD_CASES: SyntheticCase[] = [
  {
    id: "whit-delivery-log",
    kind: "misleading_context",
    questionA: "Did you sign the delivery log on June 4th",
    questionB: "Who signed the delivery log on June 4th",
    label: "false_positive",
    acceptable: ["false_positive"],
    why: "Both sessions say she signed the June 4 delivery log after her shift: the two exchanges agree.",
    context:
      "Right after the session B exchange, she says she wasn't at the depot at all that week. That statement conflicts with signing at the end of a shift, but it is not one of the cited exchanges, so it must not turn this agreeing pair into a contradiction.",
  },
  {
    id: "whit-safety-meeting",
    kind: "different_event",
    questionA: "Did you attend the safety meeting in March",
    questionB: "Did you attend the safety meeting?",
    label: "false_positive",
    acceptable: ["false_positive"],
    why: "Same wording, different events: she ran the March 12 meeting and missed the October one.",
  },
  {
    id: "whit-halvorsen",
    kind: "different_entity",
    questionA: "Did you approve the Halvorsen invoice",
    questionB: "Did you approve the Halverson Freight contract",
    label: "false_positive",
    acceptable: ["false_positive", "insufficient_evidence"],
    why: "Different documents (an invoice against a contract) from similarly named parties; approving one and not the other is compatible.",
    dependsOnAssumption: "Halvorsen and Halverson Freight may be the same company misspelled; even so, an invoice and a contract are different documents.",
  },
  {
    id: "whit-reyes",
    kind: "direct_negation",
    questionA: "Did you ever discuss the overtime policy with Mr. Reyes",
    questionB: "Have you ever talked to Luis Reyes about overtime",
    label: "direct",
    acceptable: ["direct"],
    why: "February: she discussed the overtime policy with Mr. Reyes twice in April. August: she never talked to Luis Reyes about overtime, not once.",
    context: "The exchange before the session A pair identifies Luis Reyes as the night shift supervisor, so 'Mr. Reyes' is Luis Reyes: a legitimate use of context to resolve a reference.",
  },
  {
    id: "whit-pallets",
    kind: "conflicting_values",
    questionA: "How many pallets were damaged in the May 9 incident",
    questionB: "How many pallets were damaged on May 9",
    label: "direct",
    acceptable: ["direct"],
    why: "Fourteen pallets against three, maybe four: the hedge on the second doesn't bring it near the first.",
  },
  {
    id: "whit-dock-lock",
    kind: "qualified",
    questionA: "Did you lock the loading dock on the night of May 8",
    questionB: "Did you lock the loading dock on the night of May 8",
    label: "direct",
    acceptable: ["direct", "inferential"],
    why: "February: she locked the dock herself at nine. August: she believes somebody else did and thinks she left before closing. A qualified conflict, not compatibility.",
  },
  {
    id: "whit-fire-call",
    kind: "recollection_change",
    questionA: "Who called the fire department on May 9",
    questionB: "Do you know who called the fire department",
    label: "false_positive",
    acceptable: ["false_positive", "insufficient_evidence"],
    why: "February: she called. August: she doesn't recall who made the call. A loss of memory asserts nothing inconsistent, though a lawyer may still note the change.",
  },
  {
    id: "whit-alarm",
    kind: "compatible_approximation",
    questionA: "What time did the alarm go off",
    questionB: "When did the alarm sound",
    label: "false_positive",
    acceptable: ["false_positive"],
    why: "Around 2:15 against about 2:20, give or take: the approximations overlap.",
  },
  {
    id: "whit-incident-report",
    kind: "compound_question",
    questionA: "Did you review the incident report and sign it",
    questionB: "Did you sign the incident report",
    label: "false_positive",
    acceptable: ["false_positive", "insufficient_evidence", "inferential"],
    why: "A plain 'No.' to 'review the report and sign it?' denies doing both, not signing; signing it on May 12 without reviewing it is consistent.",
    dependsOnAssumption: "That the 'No.' denies only the combination. A reader who takes it as denying each part would see an inferential conflict about signing.",
    ambiguity: "Compound questions are genuinely ambiguous; insufficient_evidence or inferential with that assumption stated are defensible.",
  },
  {
    id: "whit-fire-location",
    kind: "inferential",
    questionA: "Were you at the Tacoma depot on the day of the fire",
    questionB: "Did you see the fire yourself",
    label: "inferential",
    acceptable: ["inferential", "direct"],
    why: "February: she was at the Fife office all day, not the Tacoma depot. August: she watched the crews put the fire out from the loading yard, which places her at the depot.",
    context:
      "The exchange before the session B pair establishes that the fire started in the Tacoma depot's loading yard. Using it to say which loading yard 'the loading yard' is resolves a reference, which is allowed; the contradicting assertion itself is in the cited exchange.",
    dependsOnAssumption: "'The loading yard' she watched from is the Tacoma depot's, which the context supports, and she watched on the day of the fire.",
  },
];

export const WHITFIELD_SUITE: SyntheticSuite = {
  set: "whitfield-synthetic-v1",
  witness: "Dana Whitfield",
  caseName: "Synthetic: Dana Whitfield (fixture)",
  split: "held_out",
  sessions: [
    { text: WHITFIELD_1, takenOn: "2024-02-05", firstPage: 12 },
    { text: WHITFIELD_2, takenOn: "2024-08-19", firstPage: 55 },
  ],
  cases: WHITFIELD_CASES,
};

export const SYNTHETIC_SUITES = [WEBB_SUITE, WHITFIELD_SUITE] as const;
