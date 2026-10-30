// Which retrieval path found a candidate, from its stored `sources`. Pure. 'claims' is the earlier
// Path A; 'topics' is the statement-card Path A.
export type Provenance = "path_a" | "path_b" | "both" | "other";

export function provenanceOf(sources: readonly string[]): Provenance {
  const a = sources.includes("topics") || sources.includes("claims");
  const b = sources.includes("fulltext");
  return a && b ? "both" : a ? "path_a" : b ? "path_b" : "other";
}

// A candidate counts toward both paths' coverage when both found it, but is assessed and billed once.
export const countsToward = (sources: readonly string[], path: "path_a" | "path_b") => {
  const p = provenanceOf(sources);
  return p === path || p === "both";
};
