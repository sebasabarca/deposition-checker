// One whole-case run: what it covered, and its findings by lane, each as the two passages of stored testimony
// at page:line side by side. Code's checks and the model's reading are labelled as what they are; a test-model
// run says so on every finding. Unread pairs are counted in the coverage, never listed as cleared.

import { useCallback, useEffect, useMemo, useState } from "react";
import { StandingNotice } from "../components/FindingRegister";
import { TranscriptRows } from "../components/FindingView";
import { Alert, Badge, Breadcrumbs, Button, Card, cx, Loading, ModelMark, PageHeader, Tabs, TestimonyMark, VerifiedMark } from "../components/ui";
import { api } from "../lib/api";
import { COVERAGE, isTestRun, laneOf, LANES, MOVING_RUN, RUN_STATUS, type Lane } from "../lib/caseRuns";
import { displayRef } from "../lib/insights";
import { CLASSIFICATION, formatDate, formatUsd, PRIORITY } from "../lib/labels";
import { href, usePoll } from "../lib/router";
import type { CaseRun, CaseRunFinding, CaseRunSide } from "../types";

const PAGE = 25;

export function CaseRunPage({ id }: { id: number }) {
  const [run, setRun] = useState<CaseRun | null>(null);
  const [caseName, setCaseName] = useState<string | null>(null);
  const [findings, setFindings] = useState<CaseRunFinding[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lane, setLane] = useState<Lane>("contradictions");
  const [shown, setShown] = useState(PAGE);
  const load = useCallback(() => {
    api.caseRun(id)
      .then(async ({ caseRun }) => {
        setRun(caseRun);
        setCaseName((await api.case(caseRun.caseId)).case.name);
        setFindings((await api.caseRunFindings(id)).findings);
      })
      .catch((e: Error) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);
  usePoll(!!run && MOVING_RUN.includes(run.status), 5000, load);
  const byLane = useMemo(() => {
    const m = new Map<Lane, CaseRunFinding[]>(LANES.map((l) => [l.id, []]));
    for (const f of findings ?? []) m.get(laneOf(f))!.push(f);
    return m;
  }, [findings]);

  if (error) return <Alert title="This whole-case analysis couldn't be loaded">{error}</Alert>;
  if (!run || !findings) return <Loading />;
  const test = isTestRun(run);
  const s = RUN_STATUS[run.status];
  const c = COVERAGE[run.coverageState];
  const list = byLane.get(lane)!;

  return (
    <>
      <PageHeader
        above={<Breadcrumbs items={[{ label: "Cases", href: href.cases() }, { label: caseName ?? "Case", href: href.case(run.caseId) }]} />}
        title="Whole-case analysis"
        description={`Started ${formatDate(run.createdAt)} · ${run.candidates.sameWitness.toLocaleString()} same-witness and ${run.candidates.crossWitness.toLocaleString()} cross-witness candidate pairs`}
      />

      {test && (
        <Alert tone="info" title="Test model results">
          This run used the deterministic test model, a stand-in that exercises the pipeline at no cost. Its classifications are not an analysis of the testimony: use them to see how findings are shown, not to rely on them. The passages themselves are the real stored transcript lines.
        </Alert>
      )}

      <Card>
        <dl className="grid grid-cols-2 sm:grid-cols-4 sm:divide-x sm:divide-rule">
          <div className="px-5 py-4"><dt className="text-xs text-faint">Status</dt><dd className="mt-1"><Badge tone={s.tone} dot>{s.label}</Badge></dd></div>
          <div className="px-5 py-4"><dt className="text-xs text-faint">Coverage</dt><dd className="mt-1"><Badge tone={c.tone} dot>{c.label}</Badge></dd></div>
          <div className="px-5 py-4"><dt className="text-xs text-faint">Candidate pairs with a verdict</dt><dd className="mt-1 text-lg font-semibold tabular-nums">{run.candidates.adjudicated.toLocaleString()} <span className="text-sm font-normal text-faint">of {run.candidates.total.toLocaleString()}</span></dd></div>
          <div className="px-5 py-4"><dt className="text-xs text-faint">Cost</dt><dd className="mt-1 text-lg font-semibold tabular-nums">{test ? "$0" : formatUsd(run.cost.costUsd)}{!test && run.cost.budget && <span className="text-sm font-normal text-faint"> of {formatUsd(run.cost.budget.limitUsd)}</span>}</dd></div>
        </dl>
        <div className="border-t border-rule px-5 py-3 text-sm text-muted">
          {c.help}
          {run.incompleteReasons.length > 0 && (
            <ul className="mt-1.5 list-disc space-y-0.5 pl-5">{run.incompleteReasons.map((r) => <li key={r}>{r}</li>)}</ul>
          )}
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="px-5 pt-2">
          <Tabs label="Findings by lane" value={lane} onChange={(l) => { setLane(l); setShown(PAGE); }} items={LANES.filter((l) => l.id !== "quarantined" || lane === l.id || byLane.get(l.id)!.length > 0).map((l) => ({ id: l.id, label: l.label, count: byLane.get(l.id)!.length }))} />
        </div>
        {list.length === 0 ? (
          <p className="px-5 py-6 text-sm text-muted">
            {findings.length === 0 ? (MOVING_RUN.includes(run.status) && run.status !== "reconciling" ? "No findings yet. This page updates as packets are read." : "This run has no findings.") : "No findings in this lane."}
          </p>
        ) : (
          <div className="divide-y divide-rule">
            {list.slice(0, shown).map((f) => <FindingRow key={f.id} f={f} test={test} />)}
          </div>
        )}
        {list.length > shown && (
          <div className="flex items-center justify-between gap-3 border-t border-rule px-5 py-3">
            <span className="text-sm text-muted tabular-nums">Showing {shown} of {list.length.toLocaleString()}</span>
            <Button variant="secondary" onClick={() => setShown((n) => n + PAGE)}>Show {Math.min(PAGE, list.length - shown)} more</Button>
          </div>
        )}
      </Card>
    </>
  );
}

function FindingRow({ f, test }: { f: CaseRunFinding; test: boolean }) {
  const explanation = (f.model.verdict as { explanation?: unknown } | null)?.explanation;
  const kind = CLASSIFICATION[f.type as keyof typeof CLASSIFICATION] ?? f.type;
  const setAside = f.standing?.state === "quarantined";
  return (
    <article className="space-y-3 px-5 py-5">
      <header className="flex flex-wrap items-center gap-2">
        {setAside ? (
          <><h3 className="font-semibold">Needs revalidation</h3><Badge tone="neutral">Earlier verdict: {kind}</Badge></>
        ) : (
          <><h3 className="font-semibold">{kind}</h3><Badge tone="neutral">{PRIORITY[f.priority as keyof typeof PRIORITY] ?? f.priority}</Badge></>
        )}
        <Badge tone="neutral">{f.crossWitness ? "Across witnesses" : "Same witness"}</Badge>
        {f.score !== null && !setAside && <span className="text-sm text-muted tabular-nums">Evidence strength {f.score}/100</span>}
      </header>
      <StandingNotice standing={f.standing} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Side side={f.a} cited={f.verification.a.lineIds} status={f.verification.a.status} />
        <Side side={f.b} cited={f.verification.b.lineIds} status={f.verification.b.status} />
      </div>
      {typeof explanation === "string" && (
        <div className="rounded-lg bg-well px-4 py-3 text-sm">
          <p className="mb-1.5">{test ? <Badge tone="accent">Test model output, not an analysis</Badge> : <ModelMark>{`${f.model.model}'s reading`}</ModelMark>}</p>
          <p className="max-w-[75ch]">{explanation}</p>
          {f.safeguards.length > 0 && f.model.outcome && <p className="mt-2 max-w-[75ch] text-muted">The model called this {/^[aeiou]/.test(f.model.outcome) ? "an" : "a"} {f.model.outcome.replace(/_/g, " ")} contradiction. A code check moved it to Needs context: {f.safeguards.map((g) => `${g.side ? `side ${g.side.toUpperCase()}: ` : ""}${g.detail}`).join("; ")}.</p>}
        </div>
      )}
    </article>
  );
}

function Side({ side, cited, status }: { side: CaseRunSide; cited: number[]; status: string | null }) {
  const lines = side.lines.map((l) => ({ id: l.id, ref: l.at, text: l.text, ocrConfidence: null, highlighted: cited.includes(l.id) }));
  const first = side.lines.find((l) => cited.includes(l.id)) ?? side.lines[0];
  const page = first ? Number(first.at.split(":")[0]) : null;
  return (
    <section className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-line bg-sheet">
      <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5 border-b border-rule px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs text-faint">{side.witness ?? "Witness"} · {formatDate(side.takenOn)}</p>
          <p className="mt-0.5 font-mono text-md font-bold tracking-tight">{displayRef(side.range) ?? "No page:line reference"}</p>
        </div>
        <span className="flex flex-wrap gap-1.5">
          <TestimonyMark />
          {status === "verified" ? <VerifiedMark /> : status ? <Badge tone="warn">Citation {status.replace(/_/g, " ")}</Badge> : null}
        </span>
      </header>
      <div className={cx("transcript flex-1 py-3")}>
        <TranscriptRows lines={lines} />
      </div>
      {page !== null && Number.isFinite(page) && (
        <footer className="border-t border-rule px-4 py-2 text-right text-xs">
          <a href={href.deposition(side.depositionId, { page, mark: cited.length ? `${side.lines.find((l) => cited.includes(l.id))!.at}-${[...side.lines].reverse().find((l) => cited.includes(l.id))!.at}` : undefined })} className="font-medium text-info hover:underline">Read in full</a>
        </footer>
      )}
    </section>
  );
}
