import { describe, expect, it } from "vitest";
import {
  findHedge,
  groundEntities,
  locate,
  normalizeEntities,
  type PartLine,
} from "../../server/src/claims";

describe("locate", () => {
  it("returns every given line when the phrase isn't found exactly", () => {
    const longAnswer: PartLine[] = [10, 11, 12, 13].map((id) => ({ id, role: "answer", text: `line ${id}` }));
    expect(locate("nothing like this", longAnswer)).toEqual([10, 11, 12, 13]);
  });
});

describe("normalizeEntities", () => {
  it("writes the same name one way, dropping honorifics, possessives, a leading 'the' and duplicates", () => {
    expect(normalizeEntities(["Ms. Safra Catz", "safra catz", "Oracle's", "The PeopleSoft Board", "R&D", ""])).toEqual([
      "oracle",
      "peoplesoft board",
      "r&d",
      "safra catz",
    ]);
  });
});

describe("findHedge: only a hedge governing the phrase's own clause", () => {
  it("finds a hedge in the phrase's clause, and a bare disclaimer introducing it", () => {
    expect(findHedge("business process outsourcing had become a very hot topic", "I think business process outsourcing had become a very hot topic, probably a hotter topic.")).toBe("i think");
    expect(findHedge("it has to go to Safra Catz for approval", "I don't know that for a fact, but it has to go to Safra Catz for approval.")).toBe(
      "i don t know that for a fact",
    );
  });

  it("doesn't let a hedge in another sentence or clause qualify the phrase", () => {
    const p299 = "Well, I'm sure I've seen something similar to it in terms of the overall plan for the acquisition, but I don't think I've ever seen this specific presentation.";
    expect(findHedge("I'm sure I've seen something similar to it", p299)).toBeNull();
    expect(findHedge("I don't think I've ever seen this specific presentation", p299)).toBe("i don t think");
    expect(findHedge("It is integration software", "It is integration software. Again, I'm not sure what I have already mentioned.")).toBeNull();
    // P3171 35:03: the "I believe" belongs to the later conjunct; the disclaimer governs this phrase.
    const p22 = "I don't know that for a fact, but it has to go to Safra Catz for approval and HQ -- and I believe it likely to goes through HQ Apps.";
    expect(findHedge("it has to go to Safra Catz for approval", p22)).toBe("i don t know that for a fact");
    expect(findHedge("I believe it likely to goes through HQ Apps", p22)).toBe("i believe");
  });

  it("finds possibility and recollection hedges governing the phrase", () => {
    expect(findHedge("Tom, might have seen me", "My neighbor, Tom, might have seen me. We waved or something.")).toBe("might have");
    expect(findHedge("Around 10, maybe 10:30", "Around 10, maybe 10:30. I had work the next morning.")).toBe("maybe");
    expect(findHedge("it was in March", "As far as I recall, it was in March.")).toBe("as far as i recall");
    expect(findHedge("we signed it", "Perhaps we signed it that week.")).toBe("perhaps");
  });

  it("ignores a hedge that is negated, quoted, or in someone else's reported words", () => {
    expect(findHedge("I was home", "There's no maybe about it, I was home.")).toBeNull();
    expect(findHedge("the memo said that", 'The memo said that "we may have to cut prices."')).toBeNull();
    expect(findHedge("he might have signed it", "Safra told me he might have signed it.")).toBeNull();
    expect(findHedge("she might have signed it", "They said she might have signed it.")).toBeNull();
    // A hedge in a later sentence still doesn't reach back.
    expect(findHedge("I signed it", "I signed it. Maybe in March.")).toBeNull();
  });
});

describe("groundEntities", () => {
  it("keeps names the exchange's words support, by full name or a capitalized alias, and sets aside the rest", () => {
    const text = "Q. Who approved it? A. Ms. Catz did, through the e-business suite, as Oracle E-Business Suite users do.";
    expect(groundEntities(["Safra Catz", "Oracle", "Oracle E-Business Suite", "PeopleSoft"], text)).toEqual({
      entities: ["oracle", "oracle e business suite", "safra catz"],
      ungrounded: ["peoplesoft"],
    });
  });

  it("doesn't ground a name on lowercase common words alone, or add the company the exchange doesn't name", () => {
    const text = "Q. And the systems? A. Our e-business suite runs on those systems.";
    expect(groundEntities(["Siebel Systems", "Oracle E-Business Suite", "Oracle"], text)).toEqual({
      entities: [],
      ungrounded: ["oracle", "oracle e business suite", "siebel systems"],
    });
  });
});

describe("normalizeEntities (unchanged)", () => {
  it("still normalizes", () => {
    expect(normalizeEntities(["The Board"])).toEqual(["board"]);
  });
});
