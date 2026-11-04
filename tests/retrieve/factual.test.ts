import { describe, expect, it } from "vitest";
import { claimsOf, compatibleDims, factsOf, factualNeighbours, valueConflict, valuesOf, wordsToDigits } from "../../server/src/retrieve/factual";

const dims = (text: string) => valuesOf(text).map((v) => `${v.dim}=${v.value}`);

describe("wordsToDigits", () => {
  it("turns number words into digits, but not a lone 'one'", () => {
    expect(wordsToDigits("forty-two and two hundred and five")).toBe("42 and 205");
    expect(wordsToDigits("a hundred people")).toBe("100 people");
    expect(wordsToDigits("that one")).toBe("that one");
  });
});

describe("valuesOf", () => {
  it("reads times in digits and words, with and without a meridiem", () => {
    expect(dims("We left at 8:30 PM.")).toEqual(["time=1230"]);
    expect(dims("It was 20:30.")).toEqual(["time=1230"]);
    expect(dims("I got there at seven-fifteen.")).toEqual(["time=435"]);
    expect(dims("around nine in the evening")).toEqual(["time=1260"]);
  });
  it("reads dates, weekdays and years", () => {
    expect(dims("On Tuesday, March 4, 2024.")).toEqual(["year=2024", "date=304", "weekday=2"]);
    expect(dims("the 12th of May")).toEqual(["date=512"]);
  });
  it("reads measures with units, counts and bare numbers", () => {
    expect(dims("It read forty degrees.")).toEqual(["temperature=40"]);
    expect(dims("About 3 feet away.")[0]).toBe("length=0.9144");
    expect(dims("It cost $1,200.")).toEqual(["money=1200"]);
    expect(dims("Two hours.")).toEqual(["duration=120"]);
    expect(dims("Three trucks were parked there.")).toEqual(["count:truck=3"]);
    expect(dims("Seventy-two.")).toEqual(["number=72"]);
  });
  it("leaves out labels and identifiers", () => {
    expect(dims("Look at Exhibit 12, page 4.")).toEqual([]);
    expect(dims("We shipped version 3.1.2 to unit 7 at 40 Elm Street.")).toEqual([]);
    expect(dims("The R-200 model.")).toEqual([]);
  });
});

describe("valueConflict", () => {
  const v = (text: string) => valuesOf(text);
  it("flags differing values of one dimension, and a bare number against a measure", () => {
    expect(valueConflict(v("It read 40 degrees."), v("It read 55 degrees."))?.strength).toBe(1);
    expect(valueConflict(v("It read 40 degrees."), v("Fifty-five."))?.strength).toBe(0.6);
  });
  it("does not flag equal values, a 12-hour time against its 24-hour form, or a shared value", () => {
    expect(valueConflict(v("At 8:30."), v("At 20:30."))).toBeNull();
    expect(valueConflict(v("At 8:30 pm."), v("At 20:30."))).toBeNull();
    expect(valueConflict(v("On March 4 and March 6."), v("March 6."))).toBeNull();
  });
  it("does not compare a time with a count or a date", () => {
    expect(compatibleDims("time", "number")).toBe(false);
    expect(valueConflict(v("At 8:30 pm."), v("On March 4."))).toBeNull();
  });
  it("allows approximate values their tolerance", () => {
    expect(valueConflict(v("About 100 feet."), v("110 feet."))).toBeNull();
  });
});

describe("claimsOf", () => {
  it("resolves a bare yes or no against its question, with 'you' as the witness", () => {
    const [c] = claimsOf("Q. Were you present at the inspection?", "A. No.", "Ann Lee");
    expect(c.polarity).toBe("neg");
    expect(c.terms).toEqual(expect.arrayContaining(["inspection", "ann", "lee", "@present"]));
    expect(c.terms).not.toContain("present");
  });
  it("makes no claim of a 'No' to a knowledge question, reported speech or non-recollection", () => {
    expect(claimsOf("Q. Do you know who signed it?", "A. No.", "Ann Lee")).toEqual([]);
    expect(claimsOf("Q. Are you sure he signed it?", "A. No.", "Ann Lee")).toEqual([]);
    expect(claimsOf("Q. What happened?", "A. He told me the gate was locked.", "Ann Lee")).toEqual([]);
    expect(claimsOf("Q. Was the gate locked?", "A. I don't recall the gate.", "Ann Lee")).toEqual([]);
  });
  it("reads negation and hedges in a full sentence, with 'I' as the witness", () => {
    const [c] = claimsOf("Q. What did you do?", "A. I think I never opened the gate.", "Ann Lee");
    expect(c).toMatchObject({ polarity: "neg", weight: 0.6 });
    expect(c.terms).toEqual(expect.arrayContaining(["open", "gate", "ann", "lee"]));
  });
});

describe("factsOf", () => {
  it("adopts the question's values when the answer only agrees, and skips short groups with no question", () => {
    expect(factsOf({ session: "s", witness: "W", question: "Q. Was it 40 degrees?", answer: "A. Yes.", context: "" }).values.map((x) => x.dim)).toEqual(["temperature"]);
    expect(factsOf({ session: "s", witness: "W", question: "", answer: "Deposition of W, taken March 4, 2024", context: "" })).toEqual({ values: [], claims: [] });
  });
});

describe("factualNeighbours", () => {
  const item = (session: string, witness: string, question: string, answer: string, context = "") => ({ session, witness, question, answer, context });
  const items = [
    item("s1", "Ann Lee", "Q. What did the freezer gauge read that night?", "A. The freezer gauge read 10 degrees."),
    item("s2", "Bo Park", "Q. What did the freezer gauge show?", "A. Thirty. The freezer gauge said thirty."),
    item("s2", "Bo Park", "Q. When did the bakery truck arrive?", "A. The bakery truck came at 6:15 am."),
    item("s1", "Ann Lee", "Q. Did you work the overnight shift?", "A. Yes. I was on the overnight shift at the bakery."),
    item("s2", "Bo Park", "Q. Who worked the overnight shift?", "A. Ann Lee was not on the overnight shift."),
    item("s2", "Bo Park", "Q. And the freezer gauge?", "A. The freezer gauge read 10 degrees too."),
    // Unrelated testimony, so subject words are rare enough to weigh.
    ...["parking lot lights", "invoice totals", "loading dock door", "hiring manager", "delivery van route", "safety training", "payroll records", "roof leak", "cash register", "storage room keys"].map((t, i) => item(i % 2 ? "s1" : "s2", "X Y", `Q. Tell me about the ${t}.`, `A. The ${t} were fine.`)),
  ];
  const n = factualNeighbours(items, 10);
  it("pairs differing values on a shared subject and opposed claims, only across sessions", () => {
    expect(n[0].map((x) => x.id)).toContain(1);
    expect(n[0].map((x) => x.id)).not.toContain(5); // same value
    expect(n[3].map((x) => x.id)).toContain(4);
    for (const [a, list] of n.entries()) for (const { id } of list) expect(items[id].session).not.toBe(items[a].session);
  });
  it("gives full rankings for the requested rows and depth-limited lists for the rest", () => {
    expect(factualNeighbours(items, 0, new Set([0]))[0].length).toBeGreaterThan(0);
    expect(factualNeighbours(items, 0)[0]).toEqual([]);
  });
});
