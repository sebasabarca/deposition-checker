// Recomputes every stored finding from its stored verdict and today's packet (assess(), exactly as
// storeVerdict runs it) and compares the result with what was stored, component by component. Each
// difference is classed by the first component that diverges and attributed to its known causes
// (causesOf), or listed as unexplained. Direct-discovery findings aren't scored by assess(): their
// stored checklist is scored again with evidenceStrength() instead (their citations aren't re-verified).
// Read-only: the connection is opened with default_transaction_read_only, so nothing can be written.
// No API call. The report quotes testimony, so it goes to the git-ignored data/raw/audits/.
//   npx tsx scripts/audit-findings.ts [--out data/raw/audits/findings-<date>.json] [--limit <n>] [--previous <report of the previous verifier>]

import "dotenv/config";
import { asc, eq, sql } from "drizzle-orm";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { assess } from "../server/src/adjudicate/assess";
import { loadPacket, packetRecord } from "../server/src/adjudicate/packet";
import type { Verdict } from "../server/src/adjudicate/schema";
import { connect } from "../server/src/db/client";
import { candidates, findings, verdicts } from "../server/src/db/schema";
import { evidenceStrength, prioritize } from "../server/src/score";
import { VERIFICATION_VERSION, verificationVersionOf } from "../server/src/verify/version";

const { values } = parseArgs({ options: { out: { type: "string" }, limit: { type: "string" }, previous: { type: "string" } } });
// --previous <report>: an audit run with the previous verifier; findings absent from its differing list did not
// differ then, which is the evidence for attributing a new source or attribution difference to the current version.
const previous = values.previous ? new Map<number, string[]>((JSON.parse(readFileSync(values.previous, "utf8")) as { findings: { finding: number; diffs?: string[] }[] }).findings.map((r) => [r.finding, r.diffs ?? []])) : null;
const OUT = values.out ?? `data/raw/audits/findings-${new Date().toISOString().slice(0, 10)}.json`;

// The order code computes them in, so the first one that differs is the earliest cause.
export const COMPONENTS = ["packet", "source", "attribution", "consistency", "context", "corroboration", "timeCheck", "extractionDisagreement", "factors", "caps", "unscoredReason", "score", "band", "priority"] as const;
type Component = (typeof COMPONENTS)[number];

// jsonb reorders object keys, so values are compared with sorted keys; an undefined field is absent, a bare undefined is null.
export const canonical = (x: unknown): unknown => (Array.isArray(x) ? x.map(canonical) : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).filter((k) => (x as any)[k] !== undefined).sort().map((k) => [k, canonical((x as any)[k])])) : (x ?? null));
export const same = (x: unknown, y: unknown) => JSON.stringify(canonical(x)) === JSON.stringify(canonical(y));
// Layer 1's outcome per side; the texts it read show whether stored lines or their roles changed underneath.
const sideSource = (x: any) => ({ status: x.status, location: x.location, matchScore: x.matchScore, reason: x.reason, lineIds: x.evidenceLineIds, proposition: x.proposition, questionText: x.questionText, answerText: x.answerText });
const sourceView = (s: any) => s && { status: s.status, a: s.a && sideSource(s.a), b: s.b && sideSource(s.b) };
// Today's value cut to the fields the stored one has, so a field added later (proposition, codeRule) isn't a difference.
export const onlyStoredFields = (now: any, stored: any): any =>
  Array.isArray(now) || !now || typeof now !== "object" || !stored || typeof stored !== "object" ? now : Object.fromEntries(Object.keys(now).filter((k) => stored[k] !== undefined).map((k) => [k, onlyStoredFields(now[k], stored[k])]));
// codeRule is left out: rows stored before it existed would all differ on a field that changes nothing.
const sideLevel = (x: any) => x && { level: x.level, codeLevel: x.codeLevel, claudeLevel: x.claudeLevel };
const factorView = (fs: any[]) => fs.map((f) => `${f.component}:${f.label}=${f.points}/${f.max}`);
const capView = (cs: any[]) => cs.map((c) => `${c.rule}:${c.limit}`);
const packetView = (p: any) => p.sides.map((s: any) => ({ id: s.id, partIds: s.partIds, lineIds: s.lineIds, contextLineIds: s.contextLineIds, whole: s.wholeExchange, gaps: [s.gapBefore, s.gapAfter] }));

// When each change reached the stored rows. Commit times are upper bounds: code ran from the working
// tree before it was committed. Before the baseline commit there is no commit history, only docs/agent-log.md.
const BASELINE_COMMIT = Date.parse("2026-10-30T21:40:57Z"); // 9bd6bb9
const BAR_FIX_COMMIT = Date.parse("2026-11-02T00:32:43Z"); // 85ebc23: verify/quotes.ts reads OCR's "|" as "I"
const UPSTREAM: readonly string[] = ["packet", "source", "attribution", "consistency", "context", "corroboration", "timeCheck", "extractionDisagreement"];

export type Difference = { createdAt: Date | string; diffs: readonly string[]; detail: Record<string, { stored: any; now: any }>; verificationVersion?: string; previousDiffs?: readonly string[] };

// The known causes of one finding's difference, or "unexplained" when an input differs for no known reason. Pure.
export function causesOf(d: Difference): string[] {
  const causes = new Set<string>();
  const explained = new Set<string>();
  const created = new Date(d.createdAt).getTime();
  const preBaseline = created < BASELINE_COMMIT;
  const ed = d.detail.extractionDisagreement;
  if (ed && ed.stored === true && ed.now === false) {
    causes.add("path_a_claims_removed");
    explained.add("extractionDisagreement");
  }
  if (preBaseline) {
    // The Oct 29 fixes, uncommitted until the baseline (docs/agent-log.md, Oct 29 entries).
    const byComponent: Record<string, string> = {
      source: "pre_baseline_bare_answer_evidence",
      corroboration: "pre_baseline_bare_answer_evidence",
      attribution: "pre_baseline_hedge_detection",
      consistency: "pre_baseline_consistency_check",
      context: "pre_baseline_page_gap_label",
    };
    for (const c of Object.keys(byComponent)) {
      if (!d.diffs.includes(c)) continue;
      causes.add(byComponent[c]);
      explained.add(c);
    }
    // False positives with a context request now keep their score-based priority.
    if (d.detail.priority?.stored === "needs_context") causes.add("pre_baseline_priority_routing");
  }
  const src = d.detail.source;
  if (src && !preBaseline && created < BAR_FIX_COMMIT) {
    const sides = (["a", "b"] as const).filter((k) => !same(src.stored?.[k], src.now?.[k]));
    const barOnly = sides.every(
      (k) =>
        src.stored[k].matchScore < src.now[k].matchScore &&
        // The bar is in the stored line; today's reader may already have turned it into "I" in the recomputed text.
        /\|/.test(`${src.stored[k].questionText ?? ""} ${src.stored[k].answerText ?? ""} ${src.now[k].questionText ?? ""} ${src.now[k].answerText ?? ""}`) &&
        same({ ...src.stored[k], matchScore: 0, status: "" }, { ...src.now[k], matchScore: 0, status: "" }),
    );
    if (sides.length > 0 && barOnly) {
      causes.add("ocr_bar_normalization");
      explained.add("source");
    }
  }
  // Milestone 2.5 reading fixes (verify-2026-11-04): a source or attribution input no earlier cause explains, on a
  // component that did NOT differ in an audit of the previous verifier (--previous). Without that evidence it stays
  // unexplained, so a genuinely unknown change is never hidden behind this cause.
  if (d.previousDiffs && (d.verificationVersion ?? "unversioned") !== VERIFICATION_VERSION) {
    for (const c of ["source", "attribution"]) {
      if (d.diffs.includes(c) && !explained.has(c) && !d.previousDiffs.includes(c)) { causes.add("reading_fixes_verify_2026_11_04"); explained.add(c); }
    }
    // Corroboration reads the attribution levels, so it follows an explained attribution change.
    if (explained.has("attribution") && d.diffs.includes("corroboration") && !d.previousDiffs.includes("corroboration")) explained.add("corroboration");
  }
  // Factor labels reworded for lawyers ("Claude's attribution" -> "the analysis's attribution"), same points.
  const f = d.detail.factors;
  if (f && Array.isArray(f.stored) && Array.isArray(f.now) && factorLabelsReworded(f.stored, f.now)) causes.add("factor_labels_reworded");
  if (d.diffs.some((c) => UPSTREAM.includes(c) && !explained.has(c)) || causes.size === 0) causes.add("unexplained");
  return [...causes];
}

// Whether two factor lists differ only in label wording ("Claude" -> "the analysis"/"Analysis"), point for point.
export function factorLabelsReworded(stored: readonly string[], now: readonly string[]): boolean {
  const plain = (x: string) => x.replace(/Claude's/g, "the analysis's").replace(/\bClaude:/g, "Analysis:").replace(/\bClaude\b/g, "The analysis");
  if (stored.length !== now.length) return false;
  const a = [...stored].map(plain).sort();
  const b = [...now].sort();
  return a.every((x, i) => x === b[i]) && stored.some((x, i) => x !== [...now][i] || x.includes("Claude"));
}

async function main() {
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set("options", "-c default_transaction_read_only=on");
  const { db, pool } = connect(url.toString());
  try {
    const { rows: [ro] } = await pool.query("show default_transaction_read_only");
    if (ro.default_transaction_read_only !== "on") throw new Error("The connection is not read-only; refusing to run.");
    const rows = await db
      // review_note is in the development database but not yet in this branch's schema; null where absent.
      .select({ f: findings, v: verdicts, set: candidates.candidateSet, reviewNote: sql<string | null>`to_jsonb(${findings}.*)->>'review_note'` })
      .from(findings)
      .innerJoin(verdicts, eq(verdicts.id, findings.verdictId))
      .innerJoin(candidates, eq(candidates.id, findings.candidateId))
      .orderBy(asc(findings.id))
      .limit(values.limit ? Number(values.limit) : 1_000_000);

    const report: any[] = [];
    let unchanged = 0;
    for (const { f, v, set, reviewNote } of rows) {
      const stored = f.checks as any;
      const base = { finding: f.id, candidate: f.candidateId, verdict: v.id, set, promptVersion: v.promptVersion, origin: v.origin, createdAt: f.createdAt, verdictCreatedAt: v.createdAt, reviewState: f.reviewState, reviewNote, rubricVersion: f.rubricVersion, verificationVersion: verificationVersionOf(f.checks) };
      let packet;
      try {
        packet = await loadPacket(db, f.candidateId);
      } catch (error) {
        report.push({ ...base, firstDiff: "packet", diffs: ["packet"], error: String(error) });
        continue;
      }
      const r = assess(packet, v.parsed as Verdict, { a: [], b: [] });
      if (stored.direct) {
        // Direct discovery findings are verified by verify/direct.ts and scored by evidence-strength-v1, never by
        // assess(); assess() gives another result by construction, so they are listed apart and re-scored their own way.
        const d = stored.direct;
        const s = evidenceStrength({ classification: d.modelClassification, comparable: (v.parsed as { sameEvent: string }).sameEvent, lane: d.lane, a: d.a, b: d.b });
        const rescoreDiffers = f.rubricVersion === "evidence-strength-v1" && (f.score !== s.score || f.band !== s.band || f.priority !== s.priority);
        if (!rescoreDiffers) unchanged++;
        report.push({ ...base, firstDiff: "not_assess_pipeline", diffs: ["not_assess_pipeline"], causes: rescoreDiffers ? ["unexplained"] : [], scoreOrBandChanged: f.score !== r.assessment.score || f.band !== r.assessment.band, old: { score: f.score, band: f.band, priority: f.priority }, evidenceStrengthNow: { score: s.score, band: s.band, priority: s.priority }, assessWouldGive: { score: r.assessment.score, band: r.assessment.band } });
        continue;
      }
      const recomputedPriority = prioritize((v.parsed as Verdict).classification, r.checks.source.status, r.assessment, "unreviewed", (v.parsed as Verdict).needsMoreContext);
      const pairs: Record<Component, [unknown, unknown]> = {
        packet: [packetView(v.packet), packetView(packetRecord(packet))],
        source: [sourceView(stored.source), onlyStoredFields(sourceView(r.checks.source), sourceView(stored.source))],
        attribution: [{ a: sideLevel(stored.attribution?.a), b: sideLevel(stored.attribution?.b), storedColumns: [f.attributionA, f.attributionB] }, { a: sideLevel(r.checks.attribution.a), b: sideLevel(r.checks.attribution.b), storedColumns: [r.checks.attribution.a.level, r.checks.attribution.b.level] }],
        consistency: [stored.consistencyIssues ?? v.consistencyIssues, r.consistencyIssues],
        context: [stored.context, r.checks.context],
        corroboration: [stored.corroboration, r.checks.corroboration],
        timeCheck: [stored.timeCheck, r.checks.timeCheck],
        extractionDisagreement: [stored.extractionDisagreement, r.checks.extractionDisagreement],
        factors: [factorView(f.factors as any[]), factorView(r.assessment.factors)],
        caps: [capView(f.caps as any[]), capView(r.assessment.capsApplied)],
        unscoredReason: [f.unscoredReason, r.assessment.unscoredReason],
        score: [f.score, r.assessment.score],
        band: [f.band, r.assessment.band],
        priority: [f.priority, recomputedPriority],
      };
      const diffs = COMPONENTS.filter((c) => !same(...pairs[c]));
      const scoreOrBand = !same(f.score, r.assessment.score) || !same(f.band, r.assessment.band);
      if (diffs.length === 0) {
        unchanged++;
        continue;
      }
      const detail = Object.fromEntries(diffs.map((c) => [c, { stored: pairs[c][0], now: pairs[c][1] }]));
      report.push({
        ...base,
        causes: causesOf({ createdAt: f.createdAt, diffs, detail, verificationVersion: verificationVersionOf(f.checks), previousDiffs: previous ? previous.get(f.id) ?? [] : undefined }),
        firstDiff: diffs[0],
        diffs,
        scoreOrBandChanged: scoreOrBand,
        old: { score: f.score, band: f.band, unscoredReason: f.unscoredReason, priority: f.priority, evidenceStatus: f.evidenceStatus, attribution: [f.attributionA, f.attributionB] },
        new: { score: r.assessment.score, band: r.assessment.band, unscoredReason: r.assessment.unscoredReason, priority: recomputedPriority, evidenceStatus: r.checks.source.status, attribution: [r.checks.attribution.a.level, r.checks.attribution.b.level] },
        detail,
      });
    }

    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), total: rows.length, unchanged, differing: report.length, findings: report }, null, 2));

    const count = (xs: any[], key: (x: any) => string) => Object.fromEntries([...xs.reduce((m, x) => m.set(key(x), (m.get(key(x)) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]));
    const assessed = report.filter((x) => x.firstDiff !== "not_assess_pipeline");
    const scored = assessed.filter((x) => x.scoreOrBandChanged);
    console.log(`Findings: ${rows.length}; identical on recompute: ${unchanged}; differing: ${assessed.length}; score or band differs: ${scored.length}; direct findings whose evidence-strength re-score differs: ${report.filter((x) => x.firstDiff === "not_assess_pipeline" && x.causes.length > 0).length}; direct-discovery findings (not scored by assess()): ${report.length - assessed.length}, of which assess() would give another score or band: ${report.filter((x) => x.firstDiff === "not_assess_pipeline" && x.scoreOrBandChanged).length}`);
    console.log("Verification versions stored:", count(rows, (x) => verificationVersionOf(x.f.checks)));
    console.log("First differing component (all differences):", count(assessed, (x) => x.firstDiff));
    console.log("First differing component (score or band differs):", count(scored, (x) => x.firstDiff));
    console.log("Causes (a finding can have several):", count(assessed.flatMap((x) => x.causes), (c) => c));
    console.log("Causes of score or band differences:", count(scored, (x) => x.causes.join("+")));
    console.log("By candidate set (score or band differs):", count(scored, (x) => x.set));
    console.log("Band change:", count(scored, (x) => `${x.old.band ?? "unscored"} -> ${x.new.band ?? "unscored"}`));
    const reviewedDirect = report.filter((x) => x.firstDiff === "not_assess_pipeline" && (x.reviewState !== "unreviewed" || x.reviewNote));
    console.log(`Reviewed direct findings: ${reviewedDirect.length}; assess() would give another score or band for ${reviewedDirect.filter((x) => x.scoreOrBandChanged).map((x) => `#${x.finding}`).join(", ") || "none"} (not applicable to them)`);
    const reviewed = assessed.filter((x) => x.reviewState !== "unreviewed" || x.reviewNote);
    console.log(`Reviewed findings that differ: ${reviewed.length}`);
    for (const x of reviewed) console.log(`  #${x.finding} ${x.reviewState} causes ${x.causes.join("+")}: score ${x.old.score} -> ${x.new.score}, band ${x.old.band} -> ${x.new.band}, priority ${x.old.priority} -> ${x.new.priority}`);
    console.log(`Report: ${OUT}`);
  } finally {
    await pool.end();
  }
}

// Runs only as a script, so tests can import the pure helpers.
if (process.argv[1]?.endsWith("audit-findings.ts")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
