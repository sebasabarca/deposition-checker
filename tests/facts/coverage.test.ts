// The recall interface Stage 2 prepares for real extractions. Pure; SYNTHETIC IDs only. Nothing in this
// repository reports recall from mocked or hand-authored facts.
import { describe, expect, it } from "vitest";
import { evaluateRecall } from "../../server/src/claims/facts";

describe("recall against labelled facts", () => {
  it("counts a labelled fact found when an indexed fact shares a source line and its dimension", () => {
    const labels = [{ id: "a", depositionId: 1, lineIds: [10, 11], dimension: "dog_escape_route" }, { id: "b", depositionId: 2, lineIds: [20] }, { id: "c", depositionId: 1, lineIds: [30], dimension: "vehicle_type" }];
    const found = [{ depositionId: 1, lineIds: [11], factualDimension: "dog_escape_route" }, { depositionId: 2, lineIds: [20], factualDimension: "anything" }, { depositionId: 1, lineIds: [30], factualDimension: "car_colour" }];
    expect(evaluateRecall(labels, found)).toEqual({ labelled: 3, found: 2, recall: 2 / 3, missed: ["c"] });
    expect(evaluateRecall([], found).recall).toBeNull();
  });
});
