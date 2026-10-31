// The evidence-review workbench: one finding, both passages side by side, then the model's
// interpretation, code's checks and the reviewer's decision, each clearly its own kind of statement.

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, CircleCheck, CircleHelp, Copy, X } from "lucide-react";
import { ChecksCard, ModelAssessment, Passage, ScoreCard } from "../components/FindingView";
import { Alert, Badge, Button, Card, cx, HumanMark, inputClass, Loading, VerifiedMark } from "../components/ui";
import { api } from "../lib/api";
import { citesInferredPage, pinpointCitation } from "../lib/insights";
import { CLASSIFICATION, EVIDENCE_STATUS, PRIORITY, priorityTone, scoreLabel } from "../lib/labels";
import { clearReview, reviewOf, REVIEW_LABEL, saveReview, useReviews, type ReviewDecision } from "../lib/review";
import { href } from "../lib/router";
import type { CaseDetail, FindingDetail } from "../types";

export function WorkbenchPage({ analysisId, id }: { analysisId: number; id: number }) {
  const [f, setF] = useState<FindingDetail | null>(null);
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [order, setOrder] = useState<{ id: number; reviewState: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.finding(id).then((r) => setF(r.finding)).catch((e: Error) => setError(e.message));
    api.findings(analysisId).then((r) => setOrder(r.groups.flatMap((g) => g.findings))).catch((e: Error) => setError(e.message));
    api.analysis(analysisId)
      .then((r) => api.case(r.analysis.caseId))
      .then(setDetail)
      .catch((e: Error) => setError(e.message));
  }, [analysisId, id]);

  if (error) return <Alert title="This finding couldn't be loaded">{error}</Alert>;
  if (!f) return <Loading />;
  const contradiction = f.classification === "direct" || f.classification === "inferential";
  const verified = f.evidenceStatus === "verified" || f.evidenceStatus === "approximate";
  const at = order.findIndex((o) => o.id === id);
  const sha = (depositionId: number) => detail?.depositions.find((d) => d.id === depositionId)?.fileSha256;

  return (
    <article className="space-y-space-lg" aria-labelledby="finding-title">
      <div className="flex flex-wrap items-center justify-between gap-space-sm">
        <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-space-xs text-label-md text-on-surface-variant">
          <a className="hover:text-secondary" href={href.cases()}>Cases</a>
          <span aria-hidden className="text-outline-variant">/</span>
          {detail && <><a className="hover:text-secondary" href={href.case(detail.case.id)}>{detail.case.name}</a><span aria-hidden className="text-outline-variant">/</span></>}
          <a className="hover:text-secondary" href={href.analysis(analysisId)}>{f.a.deposition.witness}</a>
          <span aria-hidden className="text-outline-variant">/</span>
          <span aria-current="page" className="text-on-surface">Evidence review</span>
        </nav>
        {at >= 0 && (
          <div className="flex items-center rounded-lg bg-surface-container-lowest shadow-sm">
            <StepLink to={order[at - 1]?.id} analysisId={analysisId} label="Previous finding"><ChevronLeft aria-hidden className="size-[18px]" /></StepLink>
            <span className="px-2 text-label-sm font-semibold tabular-nums">Finding {at + 1} of {order.length}</span>
            <StepLink to={order[at + 1]?.id} analysisId={analysisId} label="Next finding"><ChevronRight aria-hidden className="size-[18px]" /></StepLink>
          </div>
        )}
      </div>

      <div className="flex flex-col justify-between gap-space-md lg:flex-row lg:items-start">
        <div className="min-w-0 space-y-space-xs">
          <div className="flex flex-wrap items-center gap-space-xs">
            <Badge tone={contradiction ? "contradiction" : "neutral"} dot>{f.groupLabel}</Badge>
            <Badge tone={priorityTone(f.priority)}>{PRIORITY[f.priority]}</Badge>
            {verified ? <VerifiedMark>{EVIDENCE_STATUS[f.evidenceStatus]}</VerifiedMark> : <Badge tone="bad">{EVIDENCE_STATUS[f.evidenceStatus]}</Badge>}
            {f.contextRequested && <Badge tone="warn" title="The assessment says lines outside these passages could change it">More context requested</Badge>}
          </div>
          <h1 id="finding-title" className="text-headline-lg sm:text-headline-xl">{CLASSIFICATION[f.classification]}</h1>
          <p className="text-on-surface-variant">{f.a.deposition.witness} · {scoreLabel(f)}</p>
        </div>
        <CopyCitation text={pinpointCitation(f.a, f.b)} inferred={citesInferredPage(f.a) || citesInferredPage(f.b)} />
      </div>

      {f.source.kind !== "model" && <Alert tone="info">{f.source.label}.</Alert>}
      {f.unscoredExplanation && <Alert tone="warn">{f.unscoredExplanation}</Alert>}

      <div className="grid grid-cols-1 gap-space-lg lg:grid-cols-2">
        <Passage label="Session A" side={f.a} sha={sha(f.a.deposition.id)} />
        <Passage label="Session B" side={f.b} sha={sha(f.b.deposition.id)} conflict={contradiction} />
      </div>

      <div className="grid grid-cols-1 gap-space-lg lg:grid-cols-12">
        <div className="lg:col-span-7"><ModelAssessment f={f} /></div>
        <div className="lg:col-span-5"><ReviewCard f={f} citation={pinpointCitation(f.a, f.b)} serverState={order[at]?.reviewState ?? "unreviewed"} /></div>
      </div>

      <div className="grid grid-cols-1 items-start gap-space-lg lg:grid-cols-2">
        <ChecksCard f={f} />
        <ScoreCard f={f} />
      </div>
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
      <span aria-live="polite">{copied ? (inferred ? "Copied. Verify the inferred page" : "Copied") : "Copy pinpoint citation"}</span>
    </Button>
  );
}

function ReviewCard({ f, citation, serverState }: { f: FindingDetail; citation: string; serverState: string }) {
  const reviews = useReviews();
  const saved = reviews[f.id];
  const state = reviewOf(f.id, serverState, reviews);
  const [note, setNote] = useState(saved?.note ?? "");
  const decide = (d: ReviewDecision) => saveReview(f.id, d, note);
  return (
    <Card className="flex h-full flex-col justify-between gap-space-md p-space-lg">
      <div className="flex flex-col gap-space-md">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-headline-lg">Your review</h2>
          <HumanMark>{REVIEW_LABEL[state]}</HumanMark>
        </div>
        <div>
          <h3 className="text-label-md text-on-surface-variant">Pinpoint citation</h3>
          <p className="mt-1 rounded-lg bg-surface-container p-2.5 font-mono text-label-md font-normal break-words select-all">{citation}</p>
        </div>
        <label className="block">
          <span className="text-label-md text-on-surface-variant">Reviewer note</span>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} className={cx(inputClass, "mt-1 h-auto py-2")} placeholder="Why you decided this" />
        </label>
        {saved && <p className="text-label-sm text-on-surface-variant">Decided {new Date(saved.decidedAt).toLocaleString()}.</p>}
      </div>
      <div className="flex flex-col gap-space-xs">
        <Button onClick={() => decide("confirmed")} className="h-10 w-full"><CircleCheck aria-hidden className="size-[18px]" />Confirm for follow-up</Button>
        <div className="grid gap-space-xs sm:grid-cols-2">
          <Button variant="ghost" onClick={() => decide("needs_context")}><CircleHelp aria-hidden className="size-4" />Needs more context</Button>
          <Button variant="ghost" onClick={() => decide("dismissed")}><X aria-hidden className="size-4" />Dismiss</Button>
        </div>
        {saved && <button type="button" onClick={() => clearReview(f.id)} className="text-label-md text-secondary hover:underline">Clear my decision</button>}
        <p className="pt-1 text-center text-label-sm text-on-surface-variant">Saved in this browser only. It is not stored with the case yet.</p>
      </div>
    </Card>
  );
}
