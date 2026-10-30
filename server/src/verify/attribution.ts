// Layer 2: claim attribution (DESIGN.md, "Evidence verification"). Pure: no I/O. Code makes its own
// reading of each side from the stored lines, in the order clear, qualified, uncertain, then
// not_adopted or no_recall, and says how far its reading goes:
//   exact  a deterministic rule establishes the level: a plain yes or no to the question, a whole
//          no-recall answer, or a phrase only in an attorney's words. Code's level stands, whether
//          Claude overstated or understated it.
//   upper  a rule caps the level: a hedge (at most qualified), conditional wording or an answer that
//          isn't a plain yes or no (at most uncertain). Claude can be more cautious, never more certain.
//   none   the witness's own words, where code found nothing: code can't see every qualifier,
//          hypothetical or reported speech, so Claude's reading stands.
// A disagreement is recorded on the side for inspection, never silently resolved.

import type { Attribution, Stance } from "../adjudicate/schema";
import { readRecollection } from "./answers";
import { normalize } from "./quotes";
import type { Location, SideSource } from "./source";
import { findHedge } from "./text";

export const LEVELS = ["clear", "qualified", "uncertain", "not_adopted", "no_recall"] as const;
export type Level = (typeof LEVELS)[number];

export type SideAttribution = {
  location: Location | null; // null when Layer 1 didn't find the phrase in the cited exchange
  codeStance: "affirms" | "denies" | "uncertain"; // from readAnswer(); a plain "No." is always 'denies'
  noRecall: boolean;
  qualifier: string | null; // the hedge governing the phrase, if any
  conditional: boolean;
  approximation: boolean; // "about 8", "around 2001", "or so": feeds the time check and the U deduction
  codeLevel: Level;
  claudeLevel: Level;
  codeBound: "exact" | "upper" | "none";
  codeRule: string; // the rule behind code's reading, for the reviewer
  stanceMismatch: boolean; // Claude's affirm-or-deny reading contradicts code's reading of a plain yes or no
  level: Level; // the combined level (see above); a stance mismatch makes it 'not_adopted'
  disagreement: "claude_overstates" | "claude_understates" | "claude_differs" | "stance_conflict" | null;
  claudeContradicted: boolean; // a recorded disagreement (false positives' A component)
};
export type AttributionCheck = { a: SideAttribution; b: SideAttribution };

// not_adopted and no_recall are both the lowest level; when both readings are at it, code's wins.
const RANK: Record<Level, number> = { clear: 0, qualified: 1, uncertain: 2, not_adopted: 3, no_recall: 3 };

const CLAUDE_LEVEL: Record<Attribution, Level> = {
  asserted: "clear",
  qualified: "qualified",
  does_not_recall: "no_recall",
  reported_by_other: "not_adopted",
  hypothetical: "not_adopted",
  attorney_statement: "not_adopted",
  unclear: "uncertain",
};

const CONDITIONAL = /\b(if (i|we|he|she|they) (had|were|was|did)|would have|wouldn't have|could have|assuming|suppose|hypothetically)\b/;
const NUMBER = String.raw`(\$?\d[\d,.:]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|a hundred|a dozen|a (few|couple))`;
const APPROXIMATION = new RegExp(String.raw`\b(about|around|approximately|roughly|nearly|almost|some) ${NUMBER}\b|\b\d+ ?ish\b|\bor so\b|\bgive or take\b`, "i");

// The sentence of the cited exchange that holds the phrase, or the phrase itself.
function sentenceOf(phrase: string, text: string): string {
  const target = normalize(phrase);
  return text.split(/(?<=[.?!;])\s+/).find((s) => normalize(s).includes(target)) ?? phrase;
}

type CodeReading = { level: Level; bound: SideAttribution["codeBound"]; rule: string };
type Pattern = Pick<SideAttribution, "location" | "noRecall" | "qualifier" | "conditional">;

export function codeReadingOf(side: Pattern): CodeReading {
  if (side.noRecall) return { level: "no_recall", bound: "exact", rule: "the whole answer is a no-recall answer" };
  if (side.location === null || side.location === "attorney_or_colloquy") return { level: "not_adopted", bound: "exact", rule: "the phrase is only in an attorney's words" };
  if (side.location === "question_affirmed" || side.location === "question_denied") return { level: "clear", bound: "exact", rule: "a plain yes or no to the question" };
  if (side.location === "question_other") return { level: "uncertain", bound: "upper", rule: "the answer isn't a plain yes or no to the question" };
  if (side.conditional) return { level: "uncertain", bound: "upper", rule: "conditional wording" };
  if (side.qualifier) return { level: "qualified", bound: "upper", rule: `the hedge "${side.qualifier}"` };
  return { level: "clear", bound: "none", rule: "no pattern found in the witness's own words" };
}

export const codeLevelOf = (side: Pattern): Level => codeReadingOf(side).level;

export function attributeSide(source: SideSource, phrase: string, attribution: Attribution, stance: Stance): SideAttribution {
  const location = source.location;
  const inQuestion = location?.startsWith("question_") ?? false;
  const own = location === "answer" ? sentenceOf(phrase, source.answerText) : inQuestion ? `${source.questionText} ${source.answerText}` : phrase;
  const codeStance =
    location === "question_affirmed" ? "affirms" : location === "question_denied" ? "denies" : "uncertain";
  const reading = {
    location,
    codeStance,
    noRecall: location !== null && location !== "attorney_or_colloquy" && readRecollection(source.answerText) !== null,
    qualifier: location === "answer" ? findHedge(phrase, source.answerText) : null,
    conditional: CONDITIONAL.test(own.toLowerCase().replace(/’/g, "'")),
    approximation: APPROXIMATION.test(own),
  } as const;
  const code = codeReadingOf(reading);
  const claudeLevel = CLAUDE_LEVEL[attribution];
  const stanceMismatch = (codeStance === "affirms" && stance === "denies") || (codeStance === "denies" && stance === "affirms");
  // RANK grows as the level falls: a lower rank is a more certain attribution.
  let level: Level = claudeLevel;
  let disagreement: SideAttribution["disagreement"] = null;
  if (code.bound === "exact") {
    level = code.level;
    if (RANK[claudeLevel] < RANK[code.level]) disagreement = "claude_overstates";
    else if (RANK[claudeLevel] > RANK[code.level]) disagreement = "claude_understates";
    else if (claudeLevel !== code.level) disagreement = "claude_differs"; // no recall against not adopted
  } else if (code.bound === "upper" && RANK[claudeLevel] < RANK[code.level]) {
    level = code.level;
    disagreement = "claude_overstates";
  }
  if (stanceMismatch) {
    level = "not_adopted";
    disagreement = "stance_conflict";
  }
  return {
    ...reading,
    codeLevel: code.level,
    claudeLevel,
    codeBound: code.bound,
    codeRule: code.rule,
    stanceMismatch,
    level,
    disagreement,
    claudeContradicted: disagreement !== null,
  };
}

export function checkAttribution(
  verdict: { keyPhraseA: string; keyPhraseB: string; attributionA: Attribution; attributionB: Attribution; stanceA: Stance; stanceB: Stance },
  source: { a: SideSource; b: SideSource },
): AttributionCheck {
  return {
    a: attributeSide(source.a, verdict.keyPhraseA, verdict.attributionA, verdict.stanceA),
    b: attributeSide(source.b, verdict.keyPhraseB, verdict.attributionB, verdict.stanceB),
  };
}
