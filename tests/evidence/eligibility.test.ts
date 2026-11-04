// Evidence eligibility from structure and wording alone. Synthetic groups throughout.
import { describe, expect, it } from "vitest";
import { classifyGroups, type EligibilitySpan } from "../../server/src/evidence/eligibility";

const q = (text: string, speakerName: string | null = null): EligibilitySpan => ({ speaker: "attorney", speakerName, text });
const a = (text: string): EligibilitySpan => ({ speaker: "witness", speakerName: null, text });
const u = (text: string): EligibilitySpan => ({ speaker: "unknown", speakerName: null, text });
const note = (text: string): EligibilitySpan => ({ speaker: "parenthetical", speakerName: null, text });
const colloquy = (name: string, text: string): EligibilitySpan => ({ speaker: "colloquy", speakerName: name, text });
const classes = (groups: EligibilitySpan[][]) => classifyGroups(groups).map((e) => e.class);

describe("evidence eligibility", () => {
  it("excludes front and back matter by position, and keeps the testimony between", () => {
    const groups = [[u("SUPERIOR COURT OF EXAMPLE COUNTY")], [u("Appearances:")], [u("Monday, May 4")], [q("Q. State your name."), a("A. Jane Roe.")], [q("Q. Where were you?"), a("A. At home.")], [u("I have read the foregoing pages.")], [u("Date")]];
    const out = classifyGroups(groups);
    expect(out.map((e) => e.class)).toEqual(["cover_or_signature", "cover_or_signature", "cover_or_signature", "witness_testimony", "witness_testimony", "cover_or_signature", "cover_or_signature"]);
    expect(out.map((e) => e.eligible)).toEqual([false, false, false, true, true, false, false]);
    expect(out[0].reason).toMatch(/front matter/);
    expect(out[6].reason).toMatch(/back matter/);
  });

  it("keeps any group the witness speaks in, whatever else it holds", () => {
    expect(classes([[u("DEPOSITION OF JANE ROE. EXAMINATION"), q("Q. Your name?"), a("A. Jane Roe.")], [colloquy("MR. SMITH", "Objection."), a("A. I made a correction on the errata sheet.")]])).toEqual(["witness_testimony", "witness_testimony"]);
  });

  it("classes errata, exhibits, objections and headings by wording", () => {
    const testimony = [q("Q. Where?"), a("A. Home.")];
    expect(classes([testimony, [u("ERRATA SHEET Page Line Change Reason for change")], testimony])[1]).toBe("errata_or_correction");
    expect(classes([testimony, [u("(Plaintiff's Exhibit 4 was marked for identification.)")], testimony])[1]).toBe("exhibit");
    expect(classes([testimony, [q("Q. Did you sign it?"), colloquy("MS. DOE", "Objection, form.")], testimony])[1]).toBe("objection");
    expect(classes([testimony, [u("EXAMINATION (Resumed)")], testimony])[1]).toBe("cover_or_signature");
    expect(classes([testimony, [u("JANE ROE, having been previously sworn, testified further as follows:")], testimony])[1]).toBe("cover_or_signature");
    expect(classifyGroups([[u("ERRATA")]])[0]).toMatchObject({ eligible: false, reason: expect.stringMatching(/correction can change testimony/) });
  });

  it("classes named counsel without the witness as colloquy, but keeps an examiner's Q with unidentified speech", () => {
    const testimony = [q("Q. Where?"), a("A. Home.")];
    expect(classes([testimony, [q("Mr. Hunt. Can we take a break?", "Mr. Hunt"), note("[Recess.]"), u("Back on the record.")], testimony])[1]).toBe("attorney_colloquy");
    const out = classifyGroups([testimony, [q("Q. And then?"), u("4 I went to the store.")], testimony]);
    expect(out[1]).toMatchObject({ class: "unknown", eligible: true });
    // A group with no answer at all is never eligible.
    expect(classifyGroups([testimony, [q("Q. Are you sure?")], [note("(Recess.)")], testimony]).slice(1, 3).map((e) => [e.class, e.eligible])).toEqual([["attorney_colloquy", false], ["attorney_colloquy", false]]);
  });

  it("never excludes unidentified speech inside the testimony on wording alone, unless it is a short heading", () => {
    const testimony = [q("Q. Where?"), a("A. Home.")];
    expect(classes([testimony, [u("I put my signature on the certificate before the notary.")], testimony])[1]).toBe("unknown");
    expect(classes([testimony, [u(`Examination ${"of the scene took a long time and I wrote it all down ".repeat(3)}`)], testimony])[1]).toBe("unknown");
  });

  it("where the witness is never identified, excludes only short reporter wording", () => {
    const out = classes([[u("CERTIFICATE OF REPORTER")], [u(`THE WITNESS: I signed it. ${"Then I drove home and parked by the alley. ".repeat(12)}`)]]);
    expect(out).toEqual(["cover_or_signature", "unknown"]);
  });
});
