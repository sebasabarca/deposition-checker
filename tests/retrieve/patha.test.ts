import { describe, expect, it } from "vitest";
import { claimSignal, objectsOverlap, type SignalClaim } from "../../server/src/retrieve";

const c = (fields: Partial<SignalClaim>): SignalClaim => ({
  polarity: "affirms",
  epistemic: "asserted",
  object: null,
  time: null,
  place: null,
  quantity: null,
  entities: [],
  ...fields,
});

describe("objectsOverlap", () => {
  it("links objects sharing meaningful words, conservatively", () => {
    expect(objectsOverlap("software package", "software")).toBe(true);
    expect(objectsOverlap("the 10% discount", "The 10 discount")).toBe(true);
    expect(objectsOverlap("the board", "the discount")).toBe(false);
    expect(objectsOverlap("enterprise software for large companies", "software")).toBe(true); // all of the smaller
    expect(objectsOverlap("large companies buying databases", "small companies selling services")).toBe(false); // 1 of 4
    expect(objectsOverlap(null, "software")).toBe(false);
  });
});

describe("claimSignal", () => {
  it("regression fixture: P3171 249:19-20 ('not buying any software') against P3173 51:13 ('the customer buy the software? Yes')", () => {
    const p3171 = c({ object: "software", polarity: "denies" }); // the claim the first pilot missed
    const p3173 = c({ object: "the software", polarity: "affirms" }); // as extracted: no shared entity
    expect(claimSignal(p3171, p3173)).toEqual({ signal: "opposite_polarity", sharedEntities: [] });
  });

  it("finds a different value, but not for objects that merely overlap", () => {
    expect(claimSignal(c({ time: "May 2003", entities: ["sap"] }), c({ time: "June 2003", entities: ["sap"] }))?.signal).toBe("different_value");
    expect(claimSignal(c({ object: "software package" }), c({ object: "software" }))).toBeNull(); // same polarity, overlapping: no signal
    expect(claimSignal(c({ object: "the database", entities: ["ibm"] }), c({ object: "the applications", entities: ["ibm"] }))?.signal).toBe(
      "different_value",
    );
  });

  it("keeps not recalling and not knowing as separate signals, and never as opposite polarity", () => {
    const stated = c({ entities: ["board meeting"] });
    expect(claimSignal(stated, c({ entities: ["board meeting"], epistemic: "does_not_recall" }))?.signal).toBe("recollection_change");
    expect(claimSignal(c({ entities: ["board meeting"], epistemic: "does_not_know" }), stated)?.signal).toBe("knowledge_change");
    expect(claimSignal(stated, c({ entities: ["board meeting"], epistemic: "does_not_know", polarity: "denies" }))?.signal).toBe("knowledge_change");
  });

  it("needs a shared entity or overlapping objects, and is symmetric", () => {
    expect(claimSignal(c({ entities: ["sap"] }), c({ entities: ["ibm"], polarity: "denies" }))).toBeNull();
    const x = c({ entities: ["sap"], polarity: "denies" });
    const y = c({ entities: ["sap"] });
    expect(claimSignal(x, y)).toEqual(claimSignal(y, x));
  });
});
