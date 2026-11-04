// Pure helpers for adding many transcripts at once: guessing each file's witness from its name,
// checking a row is ready to send, and sending a few files at a time.

export type UploadState = "waiting" | "sending" | "added" | "failed";

const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "esq", "md", "phd"]);

// The words of a file name, split at separators (_ - . space), at camelCase and at digits.
function fileWords(filename: string): Set<string> {
  const base = filename.replace(/\.[a-z0-9]{1,5}$/i, "").replace(/['’]/g, "");
  const plain = base.toLowerCase().split(/[^\p{L}\p{N}]+/u);
  const camel = (base.match(/\p{Lu}?\p{Ll}+|\p{Lu}+(?!\p{Ll})|\p{N}+/gu) ?? []).map((w) => w.toLowerCase());
  return new Set([...plain, ...camel].filter(Boolean));
}

function nameWords(name: string): string[] {
  return name.replace(/['’]/g, "").toLowerCase().split(/[^\p{L}]+/u).filter((w) => w.length >= 2 && !SUFFIXES.has(w));
}

// The known witness whose surname is a word of the file name; with several, the one that also
// matches the most other name words. A tie or no match gives "": never a name made up from the file.
export function guessWitness(filename: string, knownWitnesses: readonly string[]): string {
  const words = fileWords(filename);
  let best = "";
  let bestScore = 0;
  let tied = false;
  for (const witness of knownWitnesses) {
    const parts = nameWords(witness);
    if (!parts.length || !words.has(parts[parts.length - 1])) continue;
    const score = parts.filter((p) => words.has(p)).length;
    if (score > bestScore) [best, bestScore, tied] = [witness, score, false];
    else if (score === bestScore && witness !== best) tied = true;
  }
  return tied ? "" : best;
}

// A row still to send has to name its witness.
export function needsWitness(row: { witness: string; state: UploadState }): boolean {
  return row.state !== "added" && row.witness.trim() === "";
}

// Runs work on every item with at most `limit` running at once. A failure doesn't stop the rest:
// work is expected to record its own error.
export async function runLimited<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) await work(items[next++]).catch(() => undefined);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
}
