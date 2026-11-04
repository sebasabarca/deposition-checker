// Evidence eligibility: which answer groups ordinary contradiction retrieval compares. Pure: no I/O, no model.
// Each group is classified from structure and wording that hold for any transcript (who the reader says
// speaks, where the group sits relative to the witness's testimony, and the vocabulary of reporters' pages),
// never from particular passages. Nothing is dropped: an ineligible group keeps its class and the reason,
// and callers list it (errata separately, since a correction can change testimony).
//
// Classes, checked in this order for a group in which the witness never speaks:
//   errata_or_correction  errata / correction sheet vocabulary
//   exhibit               exhibit markings or an exhibit index
//   objection             counsel objecting, moving to strike, or instructing not to answer
//   cover_or_signature    reporter's matter: cover, caption, appearances, examination headings,
//                         certificate, signature: unidentified text with no counsel speaking that sits
//                         before the witness's first words or after the last, a short examination
//                         heading, or (only where the witness is never identified) short reporter wording
//   attorney_colloquy     a named counsel (or colloquy) speaks and the witness does not, or a group with
//                         no answer at all (counsel's words or reporter's notes only)
//   unknown               only unidentified speech, or an examiner's Q answered by unidentified speech:
//                         it may be the witness (a garbled answer marker), so it stays eligible, flagged
// Any group in which the witness speaks is witness_testimony, whatever else it holds.

export const EVIDENCE_CLASSES = ["witness_testimony", "attorney_colloquy", "objection", "exhibit", "cover_or_signature", "errata_or_correction", "unknown"] as const;
export type EvidenceClass = (typeof EVIDENCE_CLASSES)[number];
export const ELIGIBLE_CLASSES: ReadonlySet<EvidenceClass> = new Set(["witness_testimony", "unknown"]);

// One span of a group as Stage 2's buildUnits gives it: speaker is attorney | witness | colloquy | parenthetical | unknown.
export type EligibilitySpan = { speaker: string; speakerName: string | null; text: string };
export type Eligibility = { class: EvidenceClass; eligible: boolean; reason: string };

const ERRATA = /\berrata\b|\bcorrection (sheet|page)s?\b|\breason(s)? for (the )?change\b|\bpage\s+line\s+(change|correction)\b/i;
const EXHIBIT = /\bexhibit\b[^.]{0,80}\b(marked|identification|identified)\b|^\W*exhibits?\s*(index|no\.?|number|page|$)/i;
const OBJECTION = /\bobject(ion)?\b|\bmove to strike\b|\binstruct\w* (you|the witness|him|her|my client) not to answer\b/i;
const REPORTER = /\bcertificat(e|ion)\b|\bi have read the foregoing\b|\bhereby certify\b|\bsubscribed and sworn\b|\bnotary\b|\bcourt reporter\b|\breporter'?s\b|\bwitness name\b|\bsignature\b|\bappearances?\b|\bfor the (plaintiff|defendant|respondent|petitioner|witness|committee|select committee)s?\b|\b(deposition|interview) of\b|^\W*(date|signed)\W*$/i;
const HEADING = /^\W*((direct|cross|redirect|recross|re-?direct|re-?cross|continued|further)[- ]?)?examination\b|\bhaving been (previously |first |duly )*sworn\b|\btestified (further )?as follows\b/i;

const HEADING_WORDS = 20;
const REPORTER_WORDS = 60;

const join = (spans: readonly EligibilitySpan[]) => spans.map((s) => s.text).join(" ");
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;

// Every group of one document, in transcript order; returns one Eligibility per group.
export function classifyGroups(groups: readonly (readonly EligibilitySpan[])[]): Eligibility[] {
  const hasWitness = groups.map((g) => g.some((s) => s.speaker === "witness"));
  const first = hasWitness.indexOf(true);
  const last = hasWitness.lastIndexOf(true);
  return groups.map((g, i): Eligibility => {
    const make = (c: EvidenceClass, reason: string): Eligibility => ({ class: c, eligible: ELIGIBLE_CLASSES.has(c), reason });
    if (hasWitness[i]) return make("witness_testimony", g.some((s) => s.speaker === "unknown") ? "the witness speaks; the group also holds unidentified text" : "the witness speaks");
    const text = join(g);
    const counsel = g.filter((s) => s.speaker === "colloquy" || (s.speaker === "attorney" && s.speakerName));
    const anyCounsel = g.some((s) => s.speaker === "attorney" || s.speaker === "colloquy");
    const unidentified = join(g.filter((s) => s.speaker === "unknown"));
    if (ERRATA.test(text)) return make("errata_or_correction", "errata or correction vocabulary; kept for review, since a correction can change testimony");
    if (EXHIBIT.test(unidentified) || g.some((s) => s.speaker === "parenthetical" && EXHIBIT.test(s.text))) return make("exhibit", "exhibit marking or index; the witness does not speak");
    if (OBJECTION.test(join(g.filter((s) => s.speaker !== "parenthetical")))) return make("objection", "counsel objects or instructs; the witness does not speak");
    if (!g.some((s) => s.speaker === "unknown")) return make("attorney_colloquy", "counsel or reporter's notes only; no answer");
    // Unidentified text inside the testimony may be a garbled answer, so wording alone excludes it only when short.
    if (!anyCounsel && words(text) <= HEADING_WORDS && HEADING.test(text)) return make("cover_or_signature", "examination heading or swearing statement");
    if (!anyCounsel && first >= 0 && (i < first || i > last)) return make("cover_or_signature", `unidentified text ${i < first ? "before the witness's first" : "after the witness's last"} words, with no counsel speaking (${i < first ? "front" : "back"} matter${REPORTER.test(text) ? "; reporter's page vocabulary" : ""})`);
    if (!anyCounsel && first < 0 && words(text) <= REPORTER_WORDS && REPORTER.test(text)) return make("cover_or_signature", "reporter's page vocabulary (cover, appearances, certificate, signature) in a document where the witness is never identified");
    if (counsel.length) return make("attorney_colloquy", "named counsel speaks; the witness does not");
    return make("unknown", anyCounsel ? "an examiner's question answered only by unidentified speech, which may be the witness" : "only unidentified speech, which may be the witness");
  });
}
