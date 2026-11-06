// The case page's session rows: which need a date, and where a session can move.
import { describe, expect, it } from "vitest";
import { dateAction, moveTargets } from "../../client/src/components/sessionActions";

const found = (date: string) => ({ date, ref: "1:5", text: `Taken on ${date}` });

describe("dateAction", () => {
  it("asks for a missing date, with or without one in the transcript", () => {
    expect(dateAction({ takenOn: null, dateFound: null })).toBe("missing");
    expect(dateAction({ takenOn: null, dateFound: found("1996-01-23") })).toBe("missing");
  });
  it("flags an entered date the transcript contradicts, and passes one it agrees with or lacks", () => {
    expect(dateAction({ takenOn: "1996-01-24", dateFound: found("1996-01-23") })).toBe("differs");
    expect(dateAction({ takenOn: "1996-01-23", dateFound: found("1996-01-23") })).toBeNull();
    expect(dateAction({ takenOn: "1996-01-23", dateFound: null })).toBeNull();
  });
  it("stops flagging a date the person kept, until they enter another", () => {
    expect(dateAction({ takenOn: "1996-01-24", dateFound: found("1996-01-23"), dateConfirmed: "1996-01-24" })).toBeNull();
    expect(dateAction({ takenOn: "1996-01-25", dateFound: found("1996-01-23"), dateConfirmed: "1996-01-24" })).toBe("differs");
  });
});

describe("moveTargets", () => {
  const witnesses = [{ id: 1, name: "Simpson", depositions: [10, 11] }, { id: 2, name: "Resnick", depositions: [20] }, { id: 3, name: "Kato", depositions: [] }];
  it("offers the other witnesses with sessions, never the session's own", () => {
    expect(moveTargets(witnesses, 1).map((w) => w.name)).toEqual(["Resnick"]);
    expect(moveTargets(witnesses, 2).map((w) => w.name)).toEqual(["Simpson"]);
  });
  it("offers nothing when only one witness has sessions", () => {
    expect(moveTargets(witnesses.slice(0, 1), 1)).toEqual([]);
  });
});
