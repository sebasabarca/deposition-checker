// Entity names as stored on claims: one normalized form, so the same name written differently
// matches. Pure: no I/O. Real alias resolution ("Safra" as "Safra Catz") is DESIGN.md backlog item 9;
// the extraction prompt asks for canonical names instead.

const HONORIFIC = /^(mr|mrs|ms|dr|sir)\.?\s+/;

export function normalizeEntity(name: string): string {
  return name
    .toLowerCase()
    .replace(/[’]/g, "'")
    .replace(/'s\b/g, "")
    .replace(/[^a-z0-9&]+/g, " ")
    .trim()
    .replace(/^the\s+/, "")
    .replace(HONORIFIC, "")
    .trim();
}

export function normalizeEntities(names: readonly string[]): string[] {
  return [...new Set(names.map(normalizeEntity).filter(Boolean))].sort();
}
