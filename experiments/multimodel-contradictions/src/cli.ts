// The experiment's commands. See README.md. Dry runs and every local step make no network call.
import "dotenv/config";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { connect, type Database } from "../../../server/src/db/client";
import { depositions, witnesses } from "../../../server/src/db/schema";
import { withDistractors } from "../../../server/src/eval/discovery";
import { SYNTHETIC_SUITES, toSourceLines, type SyntheticCase, type SyntheticSuite } from "../../../server/src/eval/synthetic";
import { contentWords } from "../../../server/src/verify";
import { clusterFindings, discoverySummary, isProposedConflict, pairAccuracy, pairAgreement, recovered, type ArmFinding, type HumanLabel, type PairRow, type Target } from "./compare";
import { discoveryPrompt, pairPrompt, prompt, refOf, ROOT, sha, type Dataset, type Line, type PacketSide, type PairPacket, type Session } from "./data";
import { costUsd, estimate, type ArmConfig } from "./estimate";
import { alignPrompt, AlignOutput, chunksOf, comparePrompt, CompareOutput, coverage, jsonSchema, mapPrompt, MapOutput, mockAlign, mockEvents, parseWith, placeEvents, reachesComparison, readGroups, type PlacedEvent } from "./events";
import { canAfford, gateFailure, ledgerOf, type Approval } from "./gate";
import { parseOutput, RUN_OUTPUT_JSON_SCHEMA } from "./schemas";
import { verifyFinding } from "./verify";

const WORK = join(ROOT, "work");
const CONFIG = JSON.parse(readFileSync(join(ROOT, "config", "arms.json"), "utf8")) as { planning: { charsPerToken: number }; output: { discoveryMaxTokens: number; pairMaxTokens: number; discoveryExpectedTokens: number; pairExpectedTokens: number }; arms: Record<string, ArmConfig> };
const read = <T>(path: string) => JSON.parse(readFileSync(path, "utf8")) as T;
const write = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const flag = (name: string) => process.argv.includes(`--${name}`);
const option = (name: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? undefined : process.argv[at + 1];
};

async function linesOf(db: Database, depositionId: number): Promise<Line[]> {
  const rows = await db.execute<{ page: number; line: number; speaker: string; text: string }>(sql`select printed_page as page, line_no as line, speaker_role::text as speaker, raw_text as text from lines where deposition_id = ${depositionId} order by printed_page, line_no`);
  return rows.rows.map((r) => ({ ref: refOf(Number(r.page), r.line), page: Number(r.page), line: r.line, speaker: r.speaker, text: r.text }));
}

function syntheticSession(text: string, label: "A" | "B", firstPage: number, description: string): Session {
  let speaker = "attorney";
  const lines = toSourceLines(text, firstPage).map((l) => {
    if (/^Q\./.test(l.rawText)) speaker = "attorney";
    if (/^A\./.test(l.rawText)) speaker = "witness";
    return { ref: refOf(l.printedPage!, l.lineNo), page: l.printedPage!, line: l.lineNo, speaker, text: l.rawText };
  });
  return { label, description, lines };
}

// Lines of the exchange a target's question phrase opens: its question and answer.
function exchangeRefs(session: Session, phrase: string): string[] {
  const words = phrase.split(" ");
  const start = session.lines.findIndex((_, i) => session.lines.slice(i, i + 3).map((l) => l.text.replace(/^Q\.\s*/, "")).join(" ").startsWith(words[0]) && session.lines.slice(i, i + 4).map((l) => l.text.replace(/^Q\.\s*/, "")).join(" ").includes(phrase));
  if (start < 0) throw new Error(`No exchange asks "${phrase}".`);
  const next = session.lines.findIndex((l, i) => i > start && /^Q\./.test(l.text));
  return session.lines.slice(start, next < 0 ? undefined : next).map((l) => l.ref);
}

async function prepare() {
  mkdirSync(join(WORK, "datasets"), { recursive: true });
  const { db, pool } = connect();
  try {
    const docs = await db.select({ id: depositions.id, takenOn: depositions.takenOn, witness: witnesses.name }).from(depositions).innerJoin(witnesses, eq(witnesses.id, depositions.witnessId));
    const describe = (id: number) => `session of ${docs.find((d) => d.id === id)?.takenOn ?? "date not stated"}`;
    const real: Dataset = { id: "ellison", kind: "real", witness: "Lawrence Ellison", sessions: [{ label: "A", description: describe(1), lines: await linesOf(db, 1) }, { label: "B", description: describe(2), lines: await linesOf(db, 2) }] };
    write(join(WORK, "datasets", "ellison.json"), real);
    const targets: Record<string, Target[]> = {};
    for (const suite of SYNTHETIC_SUITES as readonly SyntheticSuite[]) {
      const mixed = withDistractors(suite, 60);
      const [a, b] = mixed.sessions.map((s, i) => syntheticSession(s.text, i === 0 ? "A" : "B", s.firstPage, `session of ${s.takenOn}`));
      const id = suite.set.replace("-synthetic-v1", "");
      write(join(WORK, "datasets", `${id}.json`), { id, kind: "synthetic", witness: suite.witness, sessions: [a, b] } satisfies Dataset);
      // Evaluator only: no prompt reads this file.
      targets[id] = suite.cases.filter((c) => c.label === "direct" || c.label === "inferential").map((c) => ({ id: c.id, a: exchangeRefs(a, c.questionA), b: exchangeRefs(b, c.questionB) }));
    }
    write(join(WORK, "synthetic-targets.json"), targets);

    // The review set supplies only which passages; its labels and verdicts are never read into a packet.
    const set = read<{ pairs: { id: string; source: "real" | "synthetic"; witness: string; a: { depositionId: number; range: string }; b: { depositionId: number; range: string } }[] }>("data/eval/review-set-v1.json");
    const side = async (label: "A" | "B", s: { depositionId: number; range: string }): Promise<PacketSide> => {
      const all = await linesOf(db, s.depositionId);
      const [first, last] = s.range.split("–");
      const from = all.findIndex((l) => l.ref === first);
      const to = all.findIndex((l) => l.ref === (last ?? first));
      if (from < 0 || to < 0) throw new Error(`Deposition ${s.depositionId} has no range ${s.range}.`);
      return { label, description: describe(s.depositionId), range: s.range, before: all.slice(Math.max(0, from - 5), from), lines: all.slice(from, to + 1), after: all.slice(to + 1, to + 6) };
    };
    const packets: PairPacket[] = [];
    for (const p of set.pairs) packets.push({ pairId: p.id, kind: p.source, witness: p.witness, a: await side("A", p.a), b: await side("B", p.b) });
    write(join(WORK, "pairs.json"), packets);
    console.log(`Prepared ${real.sessions.map((s) => s.lines.length).join(" + ")} real lines, ${Object.keys(targets).length} synthetic sets, ${packets.length} pair packets.`);
  } finally {
    await pool.end();
  }
}

// Two stored depositions as a dataset: every stored line, whatever its OCR confidence.
async function dataset() {
  const [id, a, b, witness] = [option("id")!, Number(option("a")), Number(option("b")), option("witness")!];
  const { db, pool } = connect();
  try {
    const dates = await db.select({ id: depositions.id, takenOn: depositions.takenOn }).from(depositions);
    const describe = (d: number) => `session of ${dates.find((x) => x.id === d)?.takenOn ?? "date not stated"}`;
    const value: Dataset = { id, kind: "real", witness, sessions: [{ label: "A", description: describe(a), lines: await linesOf(db, a) }, { label: "B", description: describe(b), lines: await linesOf(db, b) }] };
    write(join(WORK, "datasets", `${id}.json`), value);
    console.log(`${id}: ${value.sessions.map((s) => s.lines.length).join(" + ")} lines.`);
  } finally {
    await pool.end();
  }
}

type Job = { id: string; kind: "real" | "synthetic"; user: string; datasetId: string };
function jobsFor(experiment: string, dataset: string): Job[] {
  if (experiment === "discovery") {
    const d = read<Dataset>(join(WORK, "datasets", `${dataset}.json`));
    return [{ id: `discovery-${d.id}`, kind: d.kind, user: discoveryPrompt(d), datasetId: d.id }];
  }
  const packets = read<PairPacket[]>(join(WORK, "pairs.json")).filter((p) => dataset === "all" || p.kind === dataset);
  return packets.map((p) => ({ id: p.pairId, kind: p.kind, user: pairPrompt(p), datasetId: p.pairId }));
}
const limitsOf = (experiment: string) => (experiment === "discovery" ? { maxOutput: Number(option("max-tokens") ?? CONFIG.output.discoveryMaxTokens), expectedOutput: CONFIG.output.discoveryExpectedTokens } : { maxOutput: CONFIG.output.pairMaxTokens, expectedOutput: CONFIG.output.pairExpectedTokens });
const planOf = (arm: ArmConfig, experiment: string, jobs: Job[]) => estimate(arm, jobs.map((j) => j.user.length + prompt("system.md").length + JSON.stringify(RUN_OUTPUT_JSON_SCHEMA).length), { charsPerToken: CONFIG.planning.charsPerToken, ...limitsOf(experiment) });

function estimates() {
  const scopes = [["discovery", "ellison"], ["discovery", "webb"], ["discovery", "whitfield"], ["pairs", "synthetic"], ["pairs", "real"]];
  const rows = Object.entries(CONFIG.arms).filter(([, a]) => a.kind === "external").flatMap(([id, arm]) => scopes.map(([experiment, dataset]) => {
    const jobs = jobsFor(experiment, dataset);
    const e = planOf(arm, experiment, jobs);
    return { arm: id, experiment, dataset, calls: e.calls, largestInput: e.largestInputTokens, expectedUsd: Number(e.expectedUsd.toFixed(4)), worstCaseUsd: Number(e.worstCaseUsd.toFixed(4)), fits: e.fits, fit: e.fitNote };
  }));
  console.table(rows);
}

const PROBE = { system: 'This is a connection test. Return one JSON object matching the required schema: summary with completion_status "complete" and no limitations, and an empty findings list.', user: "Connection test. There is no testimony. Return the JSON object." };
const PROBE_MAX_TOKENS = 1000;

const approvalOf = () => {
  const path = join(ROOT, "config", "approval.local.json");
  return existsSync(path) ? read<Approval>(path) : null;
};
const spentBy = (armId: string) => ledgerOf(runsOf().map((r) => ({ arm: r.manifest.arm.id, calls: r.manifest.calls, costUsd: r.manifest.costUsd, uncertainUsd: r.manifest.uncertainUsd ?? 0 })), armId);

type Call = Awaited<ReturnType<typeof import("./providers.js")["adapterFor"]>>;
// One job, one attempt. Everything the provider returned is kept, errors included.
async function attempt(call: Call, job: { id: string; datasetId: string }, req: { system: string; user: string; maxTokens: number; schema?: Record<string, unknown> }, dir: string, manifest: Manifest, arm: ArmConfig, worstCallUsd: number, parse: (text: string | null) => { output: unknown; error: string | null } = parseOutput) {
  const started = performance.now();
  manifest.calls++;
  try {
    const reply = await call(req);
    const { output, error } = parse(reply.text);
    write(join(dir, "raw", `${job.id}.json`), { job: job.id, datasetId: job.datasetId, reply, output, error, wallMs: Math.round(performance.now() - started) });
    for (const k of ["input", "output", "cacheRead", "cacheWrite"] as const) manifest.usage[k] += reply.usage[k];
    manifest.costUsd += costUsd(arm.rates!, reply.usage);
    manifest.wallMs += Math.round(performance.now() - started);
    if (reply.modelReported && !manifest.modelsReported.includes(reply.modelReported)) manifest.modelsReported.push(reply.modelReported);
    if (error) manifest.failures.push({ job: job.id, error });
  } catch (error) {
    manifest.uncertainUsd += worstCallUsd;
    const e = error as { status?: number; requestID?: string; message?: string; error?: unknown };
    write(join(dir, "raw", `${job.id}.error.json`), { job: job.id, status: e.status ?? null, requestId: e.requestID ?? null, message: e.message ?? String(error), body: e.error ?? null, wallMs: Math.round(performance.now() - started) });
    manifest.failures.push({ job: job.id, error: e.message ?? String(error) });
  }
  write(join(dir, "manifest.json"), manifest); // survives a crash mid-run
}

function startRun(armId: string, arm: ArmConfig, experiment: string, dataset: string, system: string, maxTokens: number) {
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${experiment}-${dataset}-${armId}`;
  const dir = join(ROOT, "runs", runId);
  mkdirSync(join(dir, "raw"), { recursive: true });
  const manifest = {
    runId, arm: { id: armId, ...arm }, experiment, dataset, startedAt: new Date().toISOString(), finishedAt: null as string | null,
    gitCommit: execSync("git rev-parse HEAD").toString().trim(), systemPromptSha: sha(system), schemaSha: sha(JSON.stringify(RUN_OUTPUT_JSON_SCHEMA)), discoveryTemplateSha: sha(prompt("discovery-user.md")), maxTokens,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: 0, uncertainUsd: 0, wallMs: 0, calls: 0, failures: [] as { job: string; error: string }[], stopped: null as string | null, modelsReported: [] as string[],
  };
  return { runId, dir, manifest };
}
type Manifest = ReturnType<typeof startRun>["manifest"];

async function probe() {
  const armId = option("arm")!;
  const arm = CONFIG.arms[armId];
  if (arm?.kind !== "external") throw new Error("Choose an external arm.");
  const worst = costUsd(arm.rates!, { input: Math.ceil((PROBE.system.length + PROBE.user.length) / CONFIG.planning.charsPerToken) * 2, output: PROBE_MAX_TOKENS });
  const used = spentBy(armId);
  const blocked = gateFailure({ arm: armId, experiment: "probe", kind: "synthetic", calls: used.calls + 1, worstCaseUsd: used.costUsd + used.uncertainUsd + worst, fits: true }, approvalOf(), process.env, flag("execute"));
  if (blocked) return console.log(`No call made: ${blocked}.`);
  const { adapterFor } = await import("./providers.js");
  const { runId, dir, manifest } = startRun(armId, arm, "probe", "none", PROBE.system, PROBE_MAX_TOKENS);
  await attempt(adapterFor(arm), { id: "probe", datasetId: "none" }, { system: PROBE.system, user: PROBE.user, maxTokens: PROBE_MAX_TOKENS }, dir, manifest, arm, worst);
  manifest.finishedAt = new Date().toISOString();
  write(join(dir, "manifest.json"), manifest);
  console.log(`Probe ${runId}: $${manifest.costUsd.toFixed(6)}, ${manifest.failures.length} failures, model ${manifest.modelsReported.join(",")}.`);
}

async function run() {
  const [armId, experiment, dataset] = [option("arm")!, option("experiment")!, option("dataset")!];
  const arm = CONFIG.arms[armId];
  if (arm?.kind !== "external") throw new Error("Choose an external arm: A, B or C. D is imported with armd.");
  if (!["discovery", "pairs"].includes(experiment)) throw new Error("--experiment is discovery or pairs.");
  const jobs = jobsFor(experiment, dataset);
  const plan = planOf(arm, experiment, jobs);
  const approval = approvalOf();
  const used = spentBy(armId);
  const kind = jobs.some((j) => j.kind === "real") ? "real" : "synthetic";
  const blocked = gateFailure({ arm: armId, experiment, kind, calls: used.calls + plan.calls, worstCaseUsd: used.costUsd + used.uncertainUsd + plan.worstCaseUsd, fits: plan.fits }, approval, process.env, flag("execute"));
  const system = prompt("system.md") + (arm.systemExtra ? prompt(arm.systemExtra) : "");
  if (blocked) {
    const dir = join(WORK, "dry-run", `${experiment}-${dataset}-${armId}`);
    mkdirSync(dir, { recursive: true });
    write(join(dir, "plan.json"), { arm, experiment, dataset, plan, used, blocked });
    writeFileSync(join(dir, "first-prompt.txt"), `${system}\n---\n${jobs[0].user}`);
    console.log(`No call made: ${blocked}. Plan written to ${dir}.`);
    return;
  }
  const { adapterFor } = await import("./providers.js");
  const call = adapterFor(arm);
  const maxTokens = limitsOf(experiment).maxOutput;
  const { runId, dir, manifest } = startRun(armId, arm, experiment, dataset, system, maxTokens);
  const cap = approval!.arms[armId].maxUsd - used.costUsd - used.uncertainUsd;
  for (const job of jobs) {
    if (!canAfford(manifest.costUsd + manifest.uncertainUsd, plan.worstCallUsd, cap)) {
      manifest.stopped = "budget";
      break;
    }
    await attempt(call, job, { system, user: job.user, maxTokens }, dir, manifest, arm, plan.worstCallUsd);
  }
  manifest.finishedAt = new Date().toISOString();
  write(join(dir, "manifest.json"), manifest);
  console.log(`Run ${runId}: ${manifest.calls} calls, $${manifest.costUsd.toFixed(4)}, ${manifest.failures.length} failures.`);
}

// Target metadata can't reach a prompt: checked on the exact text that would be sent. The transcripts
// themselves necessarily hold the testimony; what is withheld is which passages are the targets.
function preflight() {
  const system = prompt("system.md");
  const suites = SYNTHETIC_SUITES as readonly SyntheticSuite[];
  const report = suites.map((suite) => {
    const id = suite.set.replace("-synthetic-v1", "");
    const text = `${system}\n${discoveryPrompt(read<Dataset>(join(WORK, "datasets", `${id}.json`)))}`;
    const forbidden = [...suite.cases.flatMap((c: SyntheticCase) => [c.id, c.why, c.context, c.dependsOnAssumption, c.ambiguity, c.verdict?.explanation].filter((x): x is string => !!x)), suite.set, "synthetic", "fixture", "distractor", "target", "webb-", "whit-", "label:", "statement card", "topic map", "candidate"];
    return { id, chars: text.length, leaks: forbidden.filter((f) => text.toLowerCase().includes(f.toLowerCase())), realWitnessLines: /ellison|oracle|peoplesoft/i.test(text) };
  });
  console.log(JSON.stringify(report, null, 2));
  if (report.some((r) => r.leaks.length > 0 || r.realWitnessLines)) throw new Error("Preflight failed.");
  console.log("Preflight passed.");
}

// Arm D's stored results, for comparison only: other arms never see this file.
async function armD() {
  const analysis = option("analysis") ?? "12";
  const { db, pool } = connect();
  try {
    const rows = await db.execute(sql`select f.id, f.type, f.evidence_status, v.parsed->>'sameEvent' as same_event from findings f join verdicts v on v.id = f.verdict_id join candidates c on c.id = f.candidate_id where c.candidate_set = ${`analysis-${analysis}`}`);
    write(join(WORK, `arm-d-analysis-${analysis}.json`), { analysis, rows: rows.rows });
    console.log(`Arm D: ${rows.rows.length} stored findings from analysis ${analysis}.`);
  } finally {
    await pool.end();
  }
}

const runsOf = () => (existsSync(join(ROOT, "runs")) ? readdirSync(join(ROOT, "runs")) : []).filter((id) => existsSync(join(ROOT, "runs", id, "manifest.json"))).map((id) => ({ id, dir: join(ROOT, "runs", id), manifest: read<{ arm: { id: string }; experiment: string; dataset: string; calls: number; costUsd: number; uncertainUsd?: number; wallMs?: number; failures: unknown[]; usage: unknown }>(join(ROOT, "runs", id, "manifest.json")) }));

function collect() {
  const items: ArmFinding[] = [];
  const pairs: PairRow[] = [];
  const byDataset: Record<string, ArmFinding[]> = {};
  const packets = new Map(read<PairPacket[]>(join(WORK, "pairs.json")).map((p) => [p.pairId, p]));
  for (const r of runsOf().filter((x) => x.manifest.experiment !== "probe")) {
    for (const file of readdirSync(join(r.dir, "raw")).filter((f) => !f.endsWith(".error.json"))) {
      const raw = read<{ datasetId: string; output: { findings?: ArmFinding["finding"][] } | null }>(join(r.dir, "raw", file));
      if (!raw.output?.findings) continue;
      const packet = packets.get(raw.datasetId);
      const dataset: Dataset = packet
        ? { id: packet.pairId, kind: packet.kind, witness: packet.witness, sessions: [{ label: "A", description: packet.a.description, lines: [...packet.a.before, ...packet.a.lines, ...packet.a.after] }, { label: "B", description: packet.b.description, lines: [...packet.b.before, ...packet.b.lines, ...packet.b.after] }] }
        : read<Dataset>(join(WORK, "datasets", `${raw.datasetId}.json`));
      for (const finding of raw.output.findings) {
        const item = { arm: r.manifest.arm.id, finding, verification: verifyFinding(finding, dataset) };
        if (packet) pairs.push({ pairId: packet.pairId, arm: item.arm, classification: finding.classification, comparable: finding.comparable, citationStatus: item.verification.status });
        else {
          items.push(item);
          (byDataset[raw.datasetId] ??= []).push(item);
        }
      }
    }
  }
  return { items, pairs, byDataset };
}

function compare() {
  const { items, pairs, byDataset } = collect();
  const labelsPath = join(ROOT, "review", "human-labels.json");
  const targets = existsSync(join(WORK, "synthetic-targets.json")) ? read<Record<string, Target[]>>(join(WORK, "synthetic-targets.json")) : {};
  const report = {
    note: "Synthetic and real are reported separately. Real recall isn't measured here.",
    efficiency: runsOf().map((r) => ({ run: r.id, arm: r.manifest.arm.id, experiment: r.manifest.experiment, dataset: r.manifest.dataset, calls: r.manifest.calls, usage: r.manifest.usage, costUsd: r.manifest.costUsd, uncertainUsd: r.manifest.uncertainUsd ?? 0, wallMs: r.manifest.wallMs ?? 0, failures: r.manifest.failures.length })),
    discovery: Object.fromEntries(Object.entries(byDataset).map(([id, list]) => [id, { ...discoverySummary(list), syntheticRecovered: targets[id] ? Object.fromEntries([...new Set(list.map((i) => i.arm))].map((arm) => [arm, recovered(targets[id], list.filter((i) => i.arm === arm))])) : null, knownTargets: targets[id]?.length ?? null }])),
    pairAgreement: pairAgreement(pairs),
    pairAccuracy: existsSync(labelsPath) ? pairAccuracy(pairs, read<HumanLabel[]>(labelsPath)) : "not reported: no human-approved labels",
  };
  mkdirSync(join(ROOT, "review"), { recursive: true });
  write(join(ROOT, "review", "comparison.json"), report);
  const cell = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const header = ["cluster", "dataset", "arms", "citation_a", "testimony_a", "citation_b", "testimony_b", "model_explanation_not_ground_truth", "verification", "human_decision", "human_notes"];
  const lines = [header.join(",")];
  Object.entries(byDataset).forEach(([id, list]) => clusterFindings(list.filter((i) => isProposedConflict(i.finding))).forEach((c, n) => {
    const m = c.members[0];
    const text = (s: "a" | "b") => m.verification[s].lines.map((l) => `${l.ref} ${l.text}`).join("\n");
    lines.push([`${id}-${n + 1}`, id, c.arms.join("+"), m.finding.citation_a, text("a"), m.finding.citation_b, text("b"), m.finding.explanation, m.verification.status, "", ""].map((v) => cell(String(v))).join(","));
  }));
  writeFileSync(join(ROOT, "review", "proposed-contradictions.csv"), `${lines.join("\n")}\n`);
  console.log(JSON.stringify(report, null, 2));
}

// A subject's testimony in both sessions, chosen by keywords alone, so a person can look for
// contradictions without any retrieval output choosing what they read.
function subjectExport() {
  const terms = (option("terms") ?? "peoplesoft,price,pricing,discount").split(",").map((t) => t.trim().toLowerCase());
  const d = read<Dataset>(join(WORK, "datasets", "ellison.json"));
  const rows = d.sessions.flatMap((s) => s.lines.filter((l) => terms.some((t) => l.text.toLowerCase().includes(t))).map((l) => [s.label, l.ref, l.speaker, l.text]));
  mkdirSync(join(ROOT, "review"), { recursive: true });
  const path = join(ROOT, "review", "subject-review.csv");
  writeFileSync(path, `${[["session", "ref", "speaker", "text", "human_note"].join(","), ...rows.map((r) => [...r, ""].map((v) => `"${v.replace(/"/g, '""')}"`).join(","))].join("\n")}\n`);
  console.log(`${rows.length} lines mention ${terms.join(", ")}. Read the pages around them; write confirmed pairs to review/human-contradictions.json.`);
}

function schemas() {
  write(join(ROOT, "schemas", "run-output.schema.json"), RUN_OUTPUT_JSON_SCHEMA);
  console.log(`Words in the system prompt: ${contentWords(prompt("system.md")).length}. Schema written.`);
}

// The event path, one stage at a time, so each stage's real cost is known before the next is approved.
const STAGES = {
  map: { arm: "E1", maxTokens: 16000, expected: 1500, concurrency: 5, schema: MapOutput },
  align: { arm: "E1", maxTokens: 16000, expected: 6000, concurrency: 1, schema: AlignOutput },
  compare: { arm: "E2", maxTokens: 4000, expected: 1200, concurrency: 5, schema: CompareOutput },
} as const;
const EVENTS_SYSTEM = "You index and compare sworn deposition testimony for a lawyer. You never decide that a witness lied.";
const eventsDir = (dataset: string) => join(WORK, "events", dataset);
type MapJob = { session: "A" | "B"; chunk: number };

function placedOf(d: Dataset, outputs: { session: "A" | "B"; chunk: number; output: MapOutput | null }[]) {
  let events: PlacedEvent[] = [];
  const report = d.sessions.map((s) => {
    const chunks = chunksOf(s.lines);
    const placed = placeEvents(s, chunks, chunks.map((_, c) => outputs.find((o) => o.session === s.label && o.chunk === c)?.output ?? null));
    events = [...events, ...placed.events];
    return { session: s.label, events: placed.events.length, rejected: placed.rejected, failedChunks: placed.failedChunks, coverage: coverage(s, placed.events) };
  });
  return { events, report };
}

async function eventsCommand() {
  const [dataset, stage] = [option("dataset")!, option("stage") as keyof typeof STAGES];
  const config = STAGES[stage];
  if (!config) throw new Error("--stage is map, align or compare.");
  const d = read<Dataset>(join(WORK, "datasets", `${dataset}.json`));
  const folder = eventsDir(dataset);
  mkdirSync(folder, { recursive: true });
  const mapped = () => placedOf(d, read<{ session: "A" | "B"; chunk: number; output: MapOutput | null }[]>(join(folder, "map.json")));
  const groupsOf = () => readGroups(read<AlignOutput>(join(folder, "align.json")), mapped().events);
  const skip = Number(option("skip") ?? 0);
  const all: { id: string; user: string; meta?: MapJob }[] =
    stage === "map" ? d.sessions.flatMap((s) => chunksOf(s.lines).map((chunk, c) => ({ id: `map-${s.label}-${c}`, user: mapPrompt(d, s, chunk), meta: { session: s.label, chunk: c } })))
    : stage === "align" ? [{ id: "align", user: alignPrompt(d, mapped().events) }]
    : groupsOf().comparable.map((g) => ({ id: `compare-${g.id}`, user: comparePrompt(d, g) }));
  const jobs = all.slice(skip, skip + Number(option("take") ?? all.length)); // slices let the gate apply a hard cap as real costs arrive
  const arm = CONFIG.arms[config.arm];
  const schema = jsonSchema(config.schema);
  const system = stage === "compare" ? prompt("system.md") : EVENTS_SYSTEM;
  const experiment = `events-${stage}`;
  const plan = estimate(arm, jobs.map((j) => j.user.length + system.length + JSON.stringify(schema).length), { charsPerToken: CONFIG.planning.charsPerToken, expectedOutput: config.expected, maxOutput: config.maxTokens });
  const approval = approvalOf();
  const used = spentBy(config.arm);
  const blocked = gateFailure({ arm: config.arm, experiment, kind: d.kind, calls: used.calls + plan.calls, worstCaseUsd: used.costUsd + used.uncertainUsd + plan.worstCaseUsd, fits: plan.fits }, approval, process.env, flag("execute"));
  if (blocked) return console.log(JSON.stringify({ stage, calls: plan.calls, largestInputTokens: plan.largestInputTokens, inputTokens: plan.inputTokens, expectedUsd: plan.expectedUsd, worstCaseUsd: plan.worstCaseUsd, used, noCallMade: blocked }));
  const { adapterFor } = await import("./providers.js");
  const call = adapterFor(arm);
  const { runId, dir, manifest } = startRun(config.arm, arm, experiment, dataset, system, config.maxTokens);
  const cap = approval!.arms[config.arm].maxUsd - used.costUsd - used.uncertainUsd;
  const parse = parseWith(config.schema as never);
  const queue = [...jobs];
  await Promise.all(Array.from({ length: config.concurrency }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      // Calls in flight count at their worst case, so concurrency can't cross the cap.
      if (!canAfford(manifest.costUsd + manifest.uncertainUsd, plan.worstCallUsd * Math.min(config.concurrency, queue.length + 1), cap)) {
        manifest.stopped = "budget";
        return;
      }
      await attempt(call, { id: job.id, datasetId: d.id }, { system, user: job.user, maxTokens: config.maxTokens, schema }, dir, manifest, arm, plan.worstCallUsd, parse);
    }
  }));
  manifest.finishedAt = new Date().toISOString();
  write(join(dir, "manifest.json"), manifest);
  const output = (id: string) => (existsSync(join(dir, "raw", `${id}.json`)) ? read<{ output: unknown }>(join(dir, "raw", `${id}.json`)).output : null);
  if (stage === "map") write(join(folder, "map.json"), jobs.map((j) => ({ ...j.meta, output: output(j.id) })));
  if (stage === "align") write(join(folder, "align.json"), output("align"));
  console.log(`Run ${runId}: ${manifest.calls} calls, $${manifest.costUsd.toFixed(4)}, ${manifest.failures.length} failures, stopped ${manifest.stopped}.`);
  if (stage === "map") console.log(JSON.stringify(mapped().report));
  if (stage === "align") {
    const g = groupsOf();
    console.log(JSON.stringify({ comparable: g.comparable.length, oneSided: g.oneSided.length, leftOut: g.leftOut.length, unknownIds: g.unknownIds.length }));
  }
}

// Free plumbing check on the synthetic sets. Says nothing about how well Haiku or Sonnet would do.
function eventsMock() {
  const targets = read<Record<string, Target[]>>(join(WORK, "synthetic-targets.json"));
  for (const [id, list] of Object.entries(targets)) {
    const d = read<Dataset>(join(WORK, "datasets", `${id}.json`));
    const events = mockEvents(d);
    const { comparable } = readGroups(mockAlign(events, contentWords), events);
    const reached = list.filter((t) => comparable.some((g) => reachesComparison(g, d, t))).map((t) => t.id);
    console.log(JSON.stringify({ id, targets: list.length, reached: reached.length, comparisons: comparable.length, largestPrompt: Math.max(...comparable.map((g) => comparePrompt(d, g).length)) }));
  }
}

const commands: Record<string, () => unknown> = { prepare, dataset, estimates, preflight, probe, run, armd: armD, compare, subject: subjectExport, schemas, events: eventsCommand, "events-mock": eventsMock };
const command = commands[process.argv[2]];
if (!command) throw new Error(`Commands: ${Object.keys(commands).join(", ")}`);
Promise.resolve(command()).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
