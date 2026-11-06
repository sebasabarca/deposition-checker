// One finding of an analysis, full width under the findings bar: what it is, both passages side by side, why
// they may conflict, and the reviewer's decision. Each is clearly its own kind of statement.

import { useEffect, useState } from "react";
import { ArrowRight, ChevronRight, CircleCheck, CircleHelp, Copy, X } from "lucide-react";
import { ChecksCard, ModelAssessment, Passage, ScoreCard } from "./FindingView";
import { Alert, Badge, Button, cx, fieldClass, Strength, VerifiedMark } from "./ui";
import { api } from "../lib/api";
import { citesInferredPage, pinpointCitation } from "../lib/insights";
import { EVIDENCE_STATUS, evidenceStrength, findingHeadline, formatDate, modelCalledIt, PRIORITY } from "../lib/labels";
import { decisionOf, isQuarantined, REVIEW_LABEL, reviewFailure, reviewLock } from "../lib/review";
import { StandingNotice } from "./FindingRegister";
import { href } from "../lib/router";
import type { FindingDetail, ReviewDecision } from "../types";

// onStale: the server refused a review because the finding changed under it (HTTP 409); the page reloads it.
export function FindingPanel({ id, analysisId, next, onDecided, onStale }: { id: number; analysisId: number; next?: number; onDecided: (id: number, state: string) => void; onStale?: (message: string) => void }) {
  const [f, setF] = useState<FindingDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setF(null);
    setError(null);
    api.finding(id).then((r) => setF(r.finding)).catch((e: Error) => setError(e.message));
  }, [id]);

  if (error) return <Alert title="This finding couldn't be loaded">{error}</Alert>;
  if (!f) return <PanelSkeleton />;
  const contradiction = f.group === "contradictions";
  const verified = f.group !== "unverified" && (f.evidenceStatus === "verified" || f.evidenceStatus === "approximate");
  const closerLook = f.reasons.filter((r) => !r.startsWith("Veridict's model said")); // the notice above already says so
  const citation = pinpointCitation(f.a, f.b);
  const setAside = isQuarantined(f); // needs revalidation: no current lane, strength or citation check is claimed

  return (
    <article aria-labelledby="finding-title" className="min-w-0 space-y-4">
      <header className="rounded-lg border border-line bg-sheet px-5 py-4">
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge tone={contradiction ? "contradiction" : f.group === "unverified" ? "bad" : f.group === "needs_context" ? "warn" : "neutral"} dot>{findingHeadline(f)}</Badge>
          {f.group === "contradictions" && <Badge tone={f.priority === "high" ? "contradiction" : "neutral"}>{PRIORITY[f.priority]}</Badge>}
          {setAside ? null : verified ? <VerifiedMark>{EVIDENCE_STATUS[f.evidenceStatus]}</VerifiedMark> : <Badge tone="bad">{f.group === "unverified" && f.evidenceStatus === "verified" ? "Not the witness's words" : EVIDENCE_STATUS[f.evidenceStatus]}</Badge>}
        </div>
        <div className="mt-2.5 flex items-start justify-between gap-6">
          <h2 id="finding-title" className="font-serif text-[22px] leading-[30px] font-semibold tracking-[-0.01em]">{f.direct?.sharedSubject ?? findingHeadline(f)}</h2>
          {f.group !== "compatible" && !setAside && <Strength score={f.score} size="lg" />}
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-rule pt-3">
          <p className="min-w-0 flex-1 basis-80 font-mono text-[13px] leading-5 break-words text-muted">{citation}</p>
          <CopyCitation text={citation} inferred={citesInferredPage(f.a) || citesInferredPage(f.b)} />
        </div>
      </header>

      <StandingNotice standing={f.standing} />
      {f.source.kind !== "model" && <Alert tone="info">{f.source.label}.</Alert>}
      {f.source.usedFallback && <Alert tone="warn">{f.source.label}</Alert>}
      {f.direct && closerLook.length > 0 && <Alert tone="warn" title="Why this needs a closer look"><ul className="list-disc pl-5">{closerLook.map((r) => <li key={r}>{r}</li>)}</ul></Alert>}
      {!f.direct && f.unscoredExplanation && <Alert tone="warn">{f.unscoredExplanation}</Alert>}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2" data-tour="finding-passages">
        <Passage label={f.cross ? f.cross.witnessA : "Earlier session"} side={f.a} />
        <Passage label={f.cross ? f.cross.witnessB : "Later session"} side={f.b} />
      </div>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="space-y-2">
          <ModelAssessment f={f} />
          {f.direct && <p className="px-1 text-xs text-faint">{modelCalledIt(f.source.modelName, f.direct.modelClassification)} {f.group !== "compatible" && evidenceStrength(f)}.</p>}
        </div>
        <Decision key={f.id} f={f} analysisId={analysisId} next={next} onDecided={onDecided} onStale={onStale} />
      </div>

      <details className="group rounded-lg border border-line bg-sheet">
        <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-3.5 font-semibold">
          How this was checked
          <ChevronRight aria-hidden className="size-4 text-faint transition-transform group-open:rotate-90" />
        </summary>
        <div className="grid grid-cols-1 items-start gap-6 border-t border-rule px-5 py-5 lg:grid-cols-2">
          <ChecksCard f={f} />
          <ScoreCard f={f} />
        </div>
        {f.direct && <p className="border-t border-rule px-5 py-3 text-xs text-faint">Proposed by {f.source.modelName}, prompt {f.source.promptVersion}.</p>}
      </details>
    </article>
  );
}

function PanelSkeleton() {
  return (
    <div aria-busy className="space-y-4">
      <div className="h-36 rounded-lg bg-rule" />
      <div className="grid gap-4 md:grid-cols-2">
        <div className="h-72 rounded-lg bg-rule" />
        <div className="h-72 rounded-lg bg-rule" />
      </div>
    </div>
  );
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
      {copied ? <CircleCheck aria-hidden className="size-4 text-ok" /> : <Copy aria-hidden className="size-4 text-muted" />}
      <span aria-live="polite">{copied ? (inferred ? "Copied. Verify the inferred page" : "Copied") : "Copy citation"}</span>
    </Button>
  );
}

export const OPTIONS: { d: ReviewDecision; label: string; icon: typeof X; on: string }[] = [
  { d: "confirmed", label: "Keep", icon: CircleCheck, on: "bg-ok text-white ring-ok" },
  { d: "needs_context", label: "Needs context", icon: CircleHelp, on: "bg-context text-white ring-context" },
  { d: "dismissed", label: "Dismiss", icon: X, on: "bg-muted text-white ring-muted" },
];

function Decision({ f, analysisId, next, onDecided, onStale }: { f: FindingDetail; analysisId: number; next?: number; onDecided: (id: number, state: string) => void; onStale?: (message: string) => void }) {
  const [state, setState] = useState(decisionOf(f.reviewState));
  const [at, setAt] = useState(f.reviewedAt);
  const [note, setNote] = useState(reviewLock(f) ? "" : (f.reviewNote ?? "")); // a set-aside finding's old note is in its notice
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lock, setLock] = useState(reviewLock(f));
  const save = async (decision: ReviewDecision | null) => {
    if (lock) return;
    setBusy(true);
    setError(null);
    try {
      const { review } = await api.review(f.id, decision, note, f.evidenceEpochs);
      setState(decisionOf(review.reviewState));
      setAt(review.reviewedAt);
      onDecided(f.id, review.reviewState);
    } catch (e) {
      const failure = reviewFailure(e);
      setError(failure.message);
      if (failure.locked) {
        setLock("This finding can no longer be reviewed as it was. Showing where it stands now.");
        onStale?.(failure.message);
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="flex flex-col gap-4 rounded-lg border border-line bg-sheet p-5" data-tour="finding-decision">
      <h2 className="text-md font-semibold">Your decision</h2>
      {lock && <p id={`review-lock-${f.id}`} className="text-sm text-muted">{lock}</p>}
      {/* Locked controls stay focusable (aria-disabled, not disabled) so a keyboard or screen reader user hears why. */}
      <div className="grid grid-cols-3 gap-1.5" role="group" aria-label="Decision" aria-describedby={lock ? `review-lock-${f.id}` : undefined}>
        {OPTIONS.map((o) => (
          <button key={o.d} type="button" aria-pressed={!lock && state === o.d} aria-disabled={lock ? true : undefined} disabled={busy} onClick={() => void save(o.d)} className={cx("flex h-14 flex-col items-center justify-center gap-1 rounded-md text-xs font-semibold ring-1 ring-inset transition-colors disabled:cursor-wait", lock ? "cursor-not-allowed bg-well text-faint ring-line" : state === o.d ? o.on : "bg-sheet text-ink ring-control hover:bg-hover")}>
            <o.icon aria-hidden className="size-4" strokeWidth={2} />
            {o.label}
          </button>
        ))}
      </div>
      <label className="block">
        <span className="text-xs font-semibold text-faint">Note for the file</span>
        <textarea value={note} readOnly={!!lock} aria-describedby={lock ? `review-lock-${f.id}` : undefined} onChange={(e) => setNote(e.target.value)} onBlur={() => !lock && state !== "unreviewed" && note !== (f.reviewNote ?? "") && void save(state)} rows={3} maxLength={5000} className={cx(fieldClass, "mt-1.5 w-full py-2 leading-5")} placeholder="Why you decided this, or what to ask the witness" />
      </label>
      {error && <Alert>{error}</Alert>}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-rule pt-3 text-sm">
        <span className="text-muted" aria-live="polite">
          {lock ? "No current decision." : state === "unreviewed" ? "Not decided yet." : <>{REVIEW_LABEL[state]}{at ? ` · ${formatDate(at)}` : ""} · <button type="button" onClick={() => void save(null)} className="font-medium text-info hover:underline">Undo</button></>}
        </span>
        {next !== undefined && <a href={href.analysis(analysisId, next)} className="inline-flex items-center gap-1 font-semibold text-ink hover:underline">Next<ArrowRight aria-hidden className="size-4" /></a>}
      </div>
    </section>
  );
}
