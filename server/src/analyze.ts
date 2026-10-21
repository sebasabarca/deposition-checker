import { findCandidates } from "./claude";
import { compareTimes, type TimeCheck } from "./ambiquity";
import { verifyQuote } from "./verify";
import type { Candidate } from "./schema";
import type { QAPair } from "./transcript";

export const RUNS = 3;
export const EVIDENCE_GATE = 0.6;
const PARAPHRASE_PENALTY = 15;
const TIME_CONFIRMS_BONUS = 10;
const TIME_CHALLENGE_CAP = 60;

type ContradictionType = Candidate["proposed_type"];
type Band = "high" | "medium" | "low";

export type Finding = {
  t1_id: string;
  t2_id: string;
  t1_quote: string;
  t2_quote: string;
  type: ContradictionType;
  explanation: string;
  status: "verified" | "unverified";
  confidence: number | null;
  band: Band | null;
  priority: number;
  runsAgreeing: number;
  runsTotal: number;
  timeCheck: TimeCheck;
  reasons: string[];
};

const CAUTION_ORDER: ContradictionType[] = [
  "false_positive",
  "inferential",
  "direct",
];

function majorityType(candidates: Candidate[]): {
  type: ContradictionType;
  count: number;
} {
  const counts = new Map<ContradictionType, number>();
  for (const c of candidates)
    counts.set(c.proposed_type, (counts.get(c.proposed_type) ?? 0) + 1);

  const max = Math.max(...counts.values());
  const type = CAUTION_ORDER.find((t) => counts.get(t) === max)!;
  return { type, count: max };
}

function startingScore(agreeing: number, total: number): number {
  const ratio = agreeing / total;
  if (ratio === 1) return 90;
  if (ratio >= 0.6) return 65;
  return 35;
}

function toBand(score: number): Band {
  if (score >= 75) return "high";
  if (score >= 50) return "medium";
  return "low";
}

function toPriority(type: ContradictionType, band: Band): number {
  if (type === "false_positive") return 4;
  if (band === "high") return type === "direct" ? 1 : 2;
  if (band === "medium") return type === "direct" ? 2 : 3;
  return 3;
}

function findQuoteElsewhere(quote: string, pairs: QAPair[]): string | null {
  const match = pairs.find(
    (p) => verifyQuote(quote, p.id, pairs) >= EVIDENCE_GATE,
  );
  return match ? match.id : null;
}

function checkEvidence(c: Candidate, t1: QAPair[], t2: QAPair[]) {
  const score1 = verifyQuote(c.t1_quote, c.t1_id, t1);
  const score2 = verifyQuote(c.t2_quote, c.t2_id, t2);
  const problems: string[] = [];

  for (const [score, quote, id, pairs] of [
    [score1, c.t1_quote, c.t1_id, t1],
    [score2, c.t2_quote, c.t2_id, t2],
  ] as const) {
    if (score >= EVIDENCE_GATE) continue;
    const elsewhere = findQuoteElsewhere(quote, pairs);
    problems.push(
      elsewhere
        ? `Reference mismatch: the quote cited as ${id} was found in ${elsewhere}.`
        : `Quote cited as ${id} could not be found in the transcript.`,
    );
  }

  return {
    passed: problems.length === 0,
    lowest: Math.min(score1, score2),
    problems,
  };
}

export function scoreFindings(
  runs: Candidate[][],
  t1: QAPair[],
  t2: QAPair[],
): Finding[] {
  const groups = new Map<string, Candidate[]>();
  for (const run of runs) {
    const seenThisRun = new Set<string>();
    for (const candidate of run) {
      const key = `${candidate.t1_id}|${candidate.t2_id}`;
      if (seenThisRun.has(key)) continue;
      seenThisRun.add(key);
      groups.set(key, [...(groups.get(key) ?? []), candidate]);
    }
  }

  const findings: Finding[] = [];
  for (const candidates of groups.values()) {
    const { type, count } = majorityType(candidates);
    const representative = candidates.find((c) => c.proposed_type === type)!;
    const evidence = checkEvidence(representative, t1, t2);
    const timeCheck = compareTimes(
      representative.t1_quote,
      representative.t2_quote,
    );
    const base = {
      t1_id: representative.t1_id,
      t2_id: representative.t2_id,
      t1_quote: representative.t1_quote,
      t2_quote: representative.t2_quote,
      type,
      explanation: representative.explanation,
      runsAgreeing: count,
      runsTotal: runs.length,
      timeCheck,
    };

    if (!evidence.passed) {
      findings.push({
        ...base,
        status: "unverified",
        confidence: null,
        band: null,
        priority: 5,
        reasons: evidence.problems,
      });
      continue;
    }

    const reasons: string[] = [];
    let score = startingScore(count, runs.length);
    reasons.push(
      `${count} of ${runs.length} analysis runs found this pair with the same classification.`,
    );

    if (evidence.lowest < 1) {
      score -= PARAPHRASE_PENALTY;
      reasons.push(
        "A quote is close but not word for word, so the evidence is weaker.",
      );
    } else {
      reasons.push("Both quotes match the transcripts word for word.");
    }

    const claimsConflict = type !== "false_positive";
    if (
      timeCheck.status === "compatible" ||
      timeCheck.status === "incompatible"
    ) {
      const timesAgree = timeCheck.status === "compatible";
      if (timesAgree !== claimsConflict) {
        score += TIME_CONFIRMS_BONUS;
        reasons.push(`Time check supports this label. ${timeCheck.detail}`);
      } else {
        score = Math.min(score, TIME_CHALLENGE_CAP);
        reasons.push(
          claimsConflict
            ? `Time check challenges this label: the times can match, so check whether the conflict depends on timing. ${timeCheck.detail}`
            : `Time check challenges this label: the times differ beyond the tolerance, so this may be a real change. ${timeCheck.detail}`,
        );
      }
    } else if (timeCheck.status === "uncertain") {
      reasons.push(timeCheck.detail);
    }

    score = Math.max(0, Math.min(100, score));
    const band = toBand(score);
    findings.push({
      ...base,
      status: "verified",
      confidence: score,
      band,
      priority: toPriority(type, band),
      reasons,
    });
  }

  return findings.sort(
    (a, b) =>
      a.priority - b.priority || (b.confidence ?? 0) - (a.confidence ?? 0),
  );
}

export async function analyze(t1: QAPair[], t2: QAPair[]): Promise<Finding[]> {
  const results = await Promise.allSettled(
    Array.from({ length: RUNS }, () => findCandidates(t1, t2)),
  );
  const runs = results
    .filter((r) => r.status === "fulfilled")
    .map((r) => (r as PromiseFulfilledResult<Candidate[]>).value);

  if (runs.length === 0) {
    const firstError = results.find(
      (r) => r.status === "rejected",
    ) as PromiseRejectedResult;
    throw firstError.reason;
  }

  return scoreFindings(runs, t1, t2);
}
