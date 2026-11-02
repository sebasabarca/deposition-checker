// One finding: both passages side by side with the cited lines highlighted, why they may conflict,
// and the lawyer's decision. Each is clearly its own kind of statement.

import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, ChevronLeft, ChevronRight, CircleCheck, CircleHelp, Copy, X } from "lucide-react";
import { ChecksCard, ModelAssessment, Passage, ScoreCard } from "../components/FindingView";
import { Crumbs } from "../components/Shell";
import { Alert, Badge, Button, Card, cx, inputClass, Loading, VerifiedMark } from "../components/ui";
import { api } from "../lib/api";
import { citesInferredPage, pinpointCitation } from "../lib/insights";
import { CLASSIFICATION, EVIDENCE_STATUS, evidenceStrength, findingHeadline, formatDate, modelCalledIt, PRIORITY, priorityTone, scoreLabel } from "../lib/labels";
import { decisionOf, REVIEW_LABEL } from "../lib/review";
import { href } from "../lib/router";
import type { CaseDetail, FindingDetail, ReviewDecision } from "../types";

const short = (iso: string | null) => (iso ? new Date(`${iso.slice(0, 10)}T12:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "date not stated");

export function WorkbenchPage({ analysisId, id }: { analysisId: number; id: number }) {
  const [f, setF] = useState<FindingDetail | null>(null);
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [order, setOrder] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.finding(id).then((r) => setF(r.finding)).catch((e: Error) => setError(e.message));
    api.findings(analysisId).then((r) => setOrder(r.groups.flatMap((g) => g.findings.map((x) => x.id)))).catch((e: Error) => setError(e.message));
    api.analysis(analysisId).then((r) => api.case(r.analysis.caseId)).then(setDetail).catch((e: Error) => setError(e.message));
  }, [analysisId, id]);

  if (error) return <Alert title="This finding couldn't be loaded">{error}</Alert>;
  if (!f) return <Loading />;
  const contradiction = f.group === "contradictions";
  const verified = f.group !== "unverified" && (f.evidenceStatus === "verified" || f.evidenceStatus === "approximate");
  const at = order.indexOf(id);
  const next = order[at + 1];
  const sha = (depositionId: number) => detail?.depositions.find((d) => d.id === depositionId)?.fileSha256;
  const closerLook = f.reasons.filter((r) => !r.startsWith("The model said")); // the notice above already says so
  const citation = pinpointCitation(f.a, f.b);
  const position = at >= 0 ? `Finding ${at + 1} of ${order.length}` : "Finding";

  return (
    <article className="space-y-space-lg" aria-labelledby="finding-title">
      <Crumbs items={[{ label: "Cases", to: href.cases() }, ...(detail ? [{ label: detail.case.name, to: href.case(detail.case.id) }] : []), { label: `${f.a.deposition.witness.split(" ").pop()}, ${short(f.a.deposition.takenOn)} vs ${short(f.b.deposition.takenOn)}`, to: href.analysis(analysisId) }, { label: position }]} />
      <div className="flex flex-wrap items-center justify-between gap-space-sm">
        <a href={href.analysis(analysisId)} className="inline-flex items-center gap-1.5 text-body-sm font-medium text-secondary hover:underline"><ArrowLeft aria-hidden className="size-4" />Back to report</a>
        {at >= 0 && (
          <div className="glass flex items-center rounded-xl">
            <StepLink to={order[at - 1]} analysisId={analysisId} label="Previous finding"><ChevronLeft aria-hidden className="size-[18px]" /></StepLink>
            <span className="px-2 text-label-md tabular-nums">{position}</span>
            <StepLink to={next} analysisId={analysisId} label="Next finding"><ChevronRight aria-hidden className="size-[18px]" /></StepLink>
          </div>
        )}
      </div>

      <Card className="p-space-lg">
        <div className="flex flex-col justify-between gap-space-md lg:flex-row lg:items-start">
          <div className="min-w-0 space-y-1.5">
            <Badge tone={contradiction ? "contradiction" : f.group === "unverified" ? "bad" : "neutral"} dot>{findingHeadline(f)}</Badge>
            <h1 id="finding-title" className="text-headline-lg sm:text-headline-xl">{f.direct?.sharedSubject ?? findingHeadline(f)}</h1>
            {f.direct ? (
              <p className="text-body-sm text-on-surface-variant">{f.group !== "compatible" && `${evidenceStrength(f)} · `}Review priority: {PRIORITY[f.priority]} · Classification: {f.group === "contradictions" ? CLASSIFICATION[f.classification] : findingHeadline(f)}</p>
            ) : (
              <p className="text-body-sm text-on-surface-variant">{f.a.deposition.witness} · {scoreLabel(f)} · <Badge tone={priorityTone(f.priority)}>{PRIORITY[f.priority]}</Badge></p>
            )}
            <div className="pt-0.5">{verified ? <VerifiedMark>{EVIDENCE_STATUS[f.evidenceStatus]}</VerifiedMark> : <Badge tone="bad">{f.group === "unverified" && f.evidenceStatus === "verified" ? "Not the witness's words" : EVIDENCE_STATUS[f.evidenceStatus]}</Badge>}</div>
          </div>
          <CopyCitation text={citation} inferred={citesInferredPage(f.a) || citesInferredPage(f.b)} />
        </div>
      </Card>

      {f.source.kind !== "model" && <Alert tone="info">{f.source.label}.</Alert>}
      {f.source.usedFallback && <Alert tone="warn">{f.source.label}</Alert>}
      {f.direct && closerLook.length > 0 && <Alert tone="warn" title="Why this needs a closer look"><ul className="list-disc pl-5">{closerLook.map((r) => <li key={r}>{r}</li>)}</ul></Alert>}
      {!f.direct && f.unscoredExplanation && <Alert tone="warn">{f.unscoredExplanation}</Alert>}

      <div className="grid grid-cols-1 gap-space-lg lg:grid-cols-2">
        <Passage label="Session A" side={f.a} sha={sha(f.a.deposition.id)} />
        <Passage label="Session B" side={f.b} sha={sha(f.b.deposition.id)} />
      </div>

      <div className="grid grid-cols-1 gap-space-lg lg:grid-cols-12">
        <div className="lg:col-span-7">
          <ModelAssessment f={f} />
          {f.direct && <p className="mt-2 text-label-sm text-on-surface-variant">{modelCalledIt(f.source.modelName, f.direct.modelClassification)}</p>}
        </div>
        <div className="lg:col-span-5"><Decision key={f.id} f={f} citation={citation} analysisId={analysisId} next={next} /></div>
      </div>

      <details className="glass rounded-2xl p-space-lg">
        <summary className="cursor-pointer text-headline-md">How this was checked</summary>
        <div className="mt-space-md grid grid-cols-1 items-start gap-space-lg lg:grid-cols-2">
          <ChecksCard f={f} />
          <ScoreCard f={f} />
        </div>
        {f.direct && <p className="mt-space-md text-label-sm text-on-surface-variant">Proposed by {f.source.modelName}, prompt {f.source.promptVersion}.</p>}
      </details>
    </article>
  );
}

function StepLink({ to, analysisId, label, children }: { to?: number; analysisId: number; label: string; children: React.ReactNode }) {
  const classes = "rounded-lg p-1.5";
  if (to === undefined) return <span aria-hidden className={cx(classes, "text-outline-variant")}>{children}</span>;
  return <a href={href.analysis(analysisId, to)} aria-label={label} className={cx(classes, "text-on-surface-variant hover:text-on-surface")}>{children}</a>;
}

function CopyCitation({ text, inferred }: { text: string; inferred: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard?.writeText(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };
  return (
    <Button variant="secondary" onClick={copy}>
      {copied ? <CircleCheck aria-hidden className="size-4 text-success" /> : <Copy aria-hidden className="size-4 text-on-surface-variant" />}
      <span aria-live="polite">{copied ? (inferred ? "Copied. Verify the inferred page" : "Copied") : "Copy citation"}</span>
    </Button>
  );
}

function Decision({ f, citation, analysisId, next }: { f: FindingDetail; citation: string; analysisId: number; next?: number }) {
  const [state, setState] = useState(decisionOf(f.reviewState));
  const [at, setAt] = useState(f.reviewedAt);
  const [note, setNote] = useState(f.reviewNote ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (decision: ReviewDecision | null) => {
    setBusy(true);
    setError(null);
    try {
      const { review } = await api.review(f.id, decision, note);
      setState(decisionOf(review.reviewState));
      setAt(review.reviewedAt);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const option = (d: ReviewDecision, label: string, Icon: typeof X) => (
    <Button variant={state === d ? "primary" : "secondary"} aria-pressed={state === d} disabled={busy} className="h-10" onClick={() => void save(d)}><Icon aria-hidden className="size-4" />{label}</Button>
  );
  return (
    <Card className="flex h-full flex-col gap-space-md p-space-lg">
      <h2 className="text-headline-lg">Your decision</h2>
      <div>
        <h3 className="text-label-md text-on-surface-variant">Pinpoint citation</h3>
        <p className="mt-1 rounded-lg bg-white p-2.5 text-label-md font-normal break-words select-all">{citation}</p>
      </div>
      <label className="block">
        <span className="text-label-md text-on-surface-variant">Reviewer note</span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={5000} className={cx(inputClass, "mt-1 h-auto bg-white py-2")} placeholder="Why you decided this" />
      </label>
      <div className="grid gap-space-xs sm:grid-cols-3">
        {option("confirmed", "Keep for follow-up", CircleCheck)}
        {option("needs_context", "Needs more context", CircleHelp)}
        {option("dismissed", "Dismiss", X)}
      </div>
      {error && <Alert>{error}</Alert>}
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 text-body-sm">
        <span className="text-on-surface-variant" aria-live="polite">
          {state === "unreviewed" ? "Not decided yet." : <>{REVIEW_LABEL[state]}{at ? ` on ${formatDate(at)}` : ""}. <button type="button" onClick={() => void save(null)} className="font-medium text-secondary hover:underline">Clear</button></>}
        </span>
        {next !== undefined && <a href={href.analysis(analysisId, next)} className="inline-flex items-center gap-1 font-semibold text-secondary hover:underline">Next finding<ArrowRight aria-hidden className="size-4" /></a>}
      </div>
    </Card>
  );
}
