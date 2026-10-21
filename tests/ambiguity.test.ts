import { describe, it, expect } from "vitest";
import { compareTimes, findTimes } from "../server/src/ambiquity";

describe("compareTimes", () => {
  const cases: [string, string, string][] = [
    ["Around 8 PM", "8:05 PM", "compatible"],
    ["Around 8 PM", "11 PM", "incompatible"],
    ["At 8", "8:05 PM", "compatible"],
    ["About 5 people", "At 5 PM", "no_times"],
    ["Arrived at 8 and left at 11", "Arrived around 9", "uncertain"],
    ["Around midnight", "12:05 AM", "compatible"],
    ["11:55 PM", "12:05 AM", "compatible"],
    ["11 PM", "2 AM", "incompatible"],
    ["Noon", "12 PM", "compatible"],
    [
      "Maybe John was there, but I arrived at exactly 8 PM",
      "Arrived at 8:20 PM",
      "incompatible",
    ],
    ["No time mentioned", "Arrived at 8 PM", "no_times"],
    [
      "I ordered pizza around 7pm and watched TV.",
      "maybe around 7:30, but came right back",
      "compatible",
    ],
    [
      "Around 10, maybe 10:30.",
      "Midnight maybe. I had trouble sleeping.",
      "incompatible",
    ],
  ];

  it.each(cases)("%s vs %s is %s", (a, b, expected) => {
    expect(compareTimes(a, b).status).toBe(expected);
  });
});

describe("findTimes", () => {
  it("ignores quantities that follow a time word", () => {
    expect(findTimes("around 3 witnesses at 4 locations")).toEqual([]);
  });

  it("ignores dates, years and numbers outside 1-12", () => {
    expect(findTimes("November 3rd, 2023, in room 15")).toEqual([]);
  });

  it("ignores invalid minutes", () => {
    expect(findTimes("at 8:75")).toEqual([]);
  });

  it("gives an unmarked time both a morning and an evening reading", () => {
    expect(findTimes("at 8")[0].minutes).toEqual([8 * 60, 20 * 60]);
  });
});
