// Which terms an exchange's Path B query uses. Pure: no I/O.

import type { TermFrequency } from "./score";

// Two ways of building a query, compared on labelled pairs before one becomes the default.
export type PathBQueryMode = "rare_terms" | "all_terms";

export const RARE_TERMS_PER_QUERY = 12;

// all_terms: every content term. rare_terms: the RARE_TERMS_PER_QUERY used by the fewest logical
// exchanges in the case, ties broken alphabetically so the choice is stable.
export function queryTerms(terms: readonly string[], mode: PathBQueryMode, { frequency }: TermFrequency): string[] {
  if (mode === "all_terms") return [...terms];
  const df = (t: string) => frequency.get(t) ?? 1;
  return [...terms].sort((x, y) => df(x) - df(y) || x.localeCompare(y)).slice(0, RARE_TERMS_PER_QUERY);
}
