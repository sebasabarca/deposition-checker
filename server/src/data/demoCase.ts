// The hand-authored demonstration case (scripts/demo-case.ts): invented testimony of two witnesses,
// two sessions each, about a fire at a warehouse, and a prepared assessment for each pair of exchanges
// the demo shows. Written by hand for the demo. Not a benchmark: no evaluation reads it, and no model
// produced or graded any of it. No real person, place or case. Pure data.
//
// Each prepared assessment goes through the real pipeline when seeded (Layer 1 source check, Layer 2
// attribution, code scoring), so citations are checked against the stored lines exactly as a model's
// would be. The app shows them as "Demo: a prepared example assessment", never as model output.

import type { Verdict } from "../adjudicate/schema";

export const DEMO_CASE_NAME = "Sample case: Harbor Street warehouse fire";
// The prompt-version tag stored with every prepared assessment, so its provenance is on the row.
export const DEMO_PROVENANCE = "fixture:demo-harbor-street-v1";

export type DemoSession = { takenOn: string; firstPage: number; text: string };
export type DemoFinding = {
  id: string;
  questionA: string; // a phrase of the earlier session's question
  questionB: string; // a phrase of the later session's question
  intent: "contradiction" | "potential_discrepancy" | "needs_context" | "compatible"; // what the example illustrates (tests only)
  // Inference steps cite their exchange as "A" or "B"; the seed replaces these with the stored exchange IDs.
  verdict: Omit<Verdict, "evidenceAId" | "evidenceBId">;
};
export type DemoWitness = { name: string; sessions: [DemoSession, DemoSession]; findings: DemoFinding[] };

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

const MARSH_1 = `
Q: Please state your position at Harbor Street Logistics.
A: I'm the night shift lead. I've had that job for about three years.

Q: How many people were on the night shift on October 14?
A: Six of us, counting me.

Q: Did you go into the valve room at any point that night?
A: No, I never went into the valve room that night.

Q: Where were you when the fire started?
A: I had already left the building. I was in the parking lot.

Q: What time was the building evacuated?
A: We were all out by about 1:40 in the morning.

Q: Did Mr. Calder have the keys to the equipment cage that night?
A: I believe so. He usually does on Mondays.

Q: Did you call the fire department yourself?
A: Yes, from my cell phone, once I was outside.
`;

const MARSH_2 = `
Q: You're still the night shift lead at Harbor Street?
A: Yes, same position.

Q: How many people worked the night shift that week?
A: Usually eight, but two called out on the fourteenth.

Q: Tell me about the valve room on October 14.
A: I checked the valve room around eleven, and the sprinkler valve was closed.

Q: What did you see when the fire started?
A: I saw smoke coming out of bay four while I was still on the floor.

Q: When was everyone out of the building?
A: Everyone was out by twelve thirty.

Q: Who had the keys to the equipment cage that night?
A: I don't know who had them that night.

Q: Who called the fire department?
A: I did, once we were outside.
`;

const CALDER_1 = `
Q: What is your job at Harbor Street Logistics?
A: I'm a forklift operator on the night shift.

Q: Was bay four empty when you clocked out on October 14?
A: Yes, it was completely empty when I left.

Q: Did you smoke on the loading dock that night?
A: No. I don't smoke.

Q: Did you attend the fire drill on March 3?
A: Yes, I was there for the whole drill.

Q: Did you have the keys to the equipment cage that night?
A: Yes, I had them on my belt.
`;

const CALDER_2 = `
Q: You operate a forklift at Harbor Street?
A: Yes, nights.

Q: What did you do after your dinner break on October 14?
A: I staged the new pallets in bay four for the morning trucks.

Q: Where did you spend your break that night?
A: Out on the loading dock, having a cigarette.

Q: Did you attend the fire drill?
A: I missed the one in February. I was out sick.

Q: What happened to the cage keys at the end of the night?
A: I gave them to Elena before I left.
`;

export const DEMO_WITNESSES: DemoWitness[] = [
  {
    name: "Elena Marsh",
    sessions: [
      { takenOn: "2024-03-11", firstPage: 12, text: MARSH_1 },
      { takenOn: "2024-08-20", firstPage: 8, text: MARSH_2 },
    ],
    findings: [
      {
        id: "marsh-valve-room",
        intent: "contradiction",
        questionA: "Did you go into the valve room",
        questionB: "Tell me about the valve room",
        verdict: {
          ...base,
          classification: "direct",
          keyPhraseA: "I never went into the valve room that night",
          keyPhraseB: "I checked the valve room around eleven",
          stanceA: "denies",
          conflictBasis: "explicit_negation",
          explanation: "In March she never went into the valve room that night; in August she checked it around eleven.",
        },
      },
      {
        id: "marsh-evacuation-time",
        intent: "contradiction",
        questionA: "What time was the building evacuated",
        questionB: "When was everyone out of the building",
        verdict: {
          ...base,
          classification: "direct",
          keyPhraseA: "We were all out by about 1:40 in the morning",
          keyPhraseB: "Everyone was out by twelve thirty",
          conflictBasis: "value_conflict",
          aboutTimingOfSameEvent: true,
          alternativeExplanation: "Both are estimates of a time months earlier; 'about' qualifies the March answer.",
          explanation: "The two evacuation times are more than an hour apart.",
        },
      },
      {
        id: "marsh-where-at-fire",
        intent: "potential_discrepancy",
        questionA: "Where were you when the fire started",
        questionB: "What did you see when the fire started",
        verdict: {
          ...base,
          classification: "inferential",
          keyPhraseA: "I had already left the building",
          keyPhraseB: "while I was still on the floor",
          conflictBasis: "requires_inference",
          inferenceSteps: [
            { statement: "In March she had left the building before the fire started.", supportingIds: ["A"] },
            { statement: "In August she saw smoke from bay four while still on the warehouse floor, so she was inside when the fire was under way.", supportingIds: ["B"] },
          ],
          unestablishedAssumptions: ["The smoke she saw marks the start of the fire, not a later stage of it."],
          explanation: "Being in the parking lot when the fire started sits uneasily with seeing the smoke from inside.",
        },
      },
      {
        id: "marsh-cage-keys",
        intent: "needs_context",
        questionA: "Did Mr. Calder have the keys",
        questionB: "Who had the keys to the equipment cage",
        verdict: {
          ...base,
          classification: "insufficient_evidence",
          keyPhraseA: "I believe so",
          keyPhraseB: "I don't know who had them that night",
          attributionA: "qualified",
          attributionB: "does_not_recall",
          stanceB: "unclear",
          conflictBasis: "none",
          needsMoreContext: true,
          explanation: "A qualified belief in March and no knowledge in August: neither answer commits to who held the keys.",
        },
      },
      {
        id: "marsh-shift-size",
        intent: "compatible",
        questionA: "How many people were on the night shift",
        questionB: "How many people worked the night shift that week",
        verdict: {
          ...base,
          classification: "false_positive",
          keyPhraseA: "Six of us, counting me",
          keyPhraseB: "two called out on the fourteenth",
          conflictBasis: "none",
          falsePositiveReason: "both_can_be_true",
          explanation: "Eight usually, two out that night: six on shift, as she said in March.",
        },
      },
    ],
  },
  {
    name: "Owen Calder",
    sessions: [
      { takenOn: "2024-03-12", firstPage: 20, text: CALDER_1 },
      { takenOn: "2024-08-21", firstPage: 6, text: CALDER_2 },
    ],
    findings: [
      {
        id: "calder-smoking",
        intent: "contradiction",
        questionA: "Did you smoke on the loading dock",
        questionB: "Where did you spend your break",
        verdict: {
          ...base,
          classification: "direct",
          keyPhraseA: "I don't smoke",
          keyPhraseB: "having a cigarette",
          stanceA: "denies",
          conflictBasis: "explicit_negation",
          explanation: "In March he did not smoke on the dock and doesn't smoke; in August he spent his break on the dock having a cigarette.",
        },
      },
      {
        id: "calder-bay-four",
        intent: "potential_discrepancy",
        questionA: "Was bay four empty when you clocked out",
        questionB: "What did you do after your dinner break",
        verdict: {
          ...base,
          classification: "inferential",
          keyPhraseA: "it was completely empty when I left",
          keyPhraseB: "I staged the new pallets in bay four",
          conflictBasis: "requires_inference",
          inferenceSteps: [
            { statement: "In March bay four was empty when he clocked out.", supportingIds: ["A"] },
            { statement: "In August he staged new pallets in bay four after his dinner break.", supportingIds: ["B"] },
          ],
          unestablishedAssumptions: ["He clocked out after the dinner break, and nobody moved the pallets before he left."],
          explanation: "Pallets staged in bay four after dinner would not leave it empty at clock-out, if he left after staging them.",
        },
      },
      {
        id: "calder-fire-drill",
        intent: "compatible",
        questionA: "Did you attend the fire drill on March 3",
        questionB: "Did you attend the fire drill?",
        verdict: {
          ...base,
          classification: "false_positive",
          keyPhraseA: "I was there for the whole drill",
          keyPhraseB: "I missed the one in February",
          sameEvent: "no",
          scopeAligned: "no",
          conflictBasis: "none",
          falsePositiveReason: "different_event",
          explanation: "He attended the March 3 drill and missed a February one: two different drills.",
        },
      },
    ],
  },
];
