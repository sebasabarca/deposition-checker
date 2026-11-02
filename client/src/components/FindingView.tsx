// The parts of one finding. Testimony is only ever the stored lines, shown verbatim with their
// page:line; the model's words appear only under the model mark; checks are labelled as code's.

import { useState, type ReactNode } from "react";
import { BadgeCheck, CircleAlert, FileSearch, ShieldCheck, TriangleAlert } from "lucide-react";
import { api } from "../lib/api";
import { LOW_OCR_CONFIDENCE, ocrPassage } from "../lib/insights";
import { ATTRIBUTION_LEVEL, COMPONENT, DISAGREEMENT, EVIDENCE_STRENGTH_NOTE, formatDate, LOCATION, ORIGIN, SAME_EVENT, SPEAKER, VERIFICATION } from "../lib/labels";
import type { EvidenceLine, EvidenceSide, FindingDetail } from "../types";
import { Alert, Button, Card, cx, Dialog, ModelMark, OcrMark, TestimonyMark } from "./ui";

type Mark = "amber" | "red";

export function Passage({ label, side, sha, conflict }: { label: string; side: EvidenceSide; sha?: string; conflict?: boolean }) {
  const mark: Mark = conflict ? "red" : "amber";
  const ocr = ocrPassage(side);
  return (
    <Card className="flex flex-col overflow-hidden">
      <header className={cx("flex flex-col gap-space-xs p-space-md", conflict ? "bg-error-container/20" : "bg-surface-container-low")}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className={cx("rounded px-2 py-0.5 text-label-sm font-semibold", conflict ? "bg-error-container text-on-error-container" : "bg-surface-container-highest")}>{label}</span>
          <span className="text-label-sm text-on-surface-variant">{formatDate(side.deposition.takenOn)}</span>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-mono text-headline-md">{side.range ?? "No page:line reference"}</h2>
          {ocr ? <OcrMark /> : <TestimonyMark />}
        </div>
        <p className="text-body-sm text-on-surface-variant">Witness: {side.deposition.witness} · {side.deposition.originalFilename ?? `Deposition #${side.deposition.id}`}</p>
      </header>
      <div className="flex-1 p-space-md"><PassageLines side={side} mark={mark} /></div>
      <footer className="flex flex-wrap items-center justify-between gap-2 bg-surface-container-low px-space-md py-2.5 text-label-sm text-on-surface-variant">
        <span>{ocr ? "Stored OCR text, not an exact copy of the scan." : "Verbatim from the stored transcript."}</span>
        {sha && <span className="flex items-center gap-1 font-mono" title={`PDF SHA-256 ${sha}`}><BadgeCheck aria-hidden className="size-3.5 text-success" />PDF SHA-256 {sha.slice(0, 6)}…{sha.slice(-3)}</span>}
      </footer>
    </Card>
  );
}

export function PassageLines({ side, mark }: { side: EvidenceSide; mark: Mark }) {
  return (
    <>
      <OcrNotice side={side} mark={mark} />
      <LineList side={side} mark={mark} />
    </>
  );
}

// The warning and the scan sit with the lines themselves, so every place testimony appears gets them.
function OcrNotice({ side, mark }: { side: EvidenceSide; mark: Mark }) {
  const [open, setOpen] = useState(false);
  const ocr = ocrPassage(side);
  if (!ocr) return null;
  const url = api.depositionPdf(side.deposition.id, ocr.pages[0]);
  const low = ocr.lowLines === 1 ? "1 line is" : `${ocr.lowLines} lines are`;
  return (
    <>
      <div className="mb-space-sm flex flex-wrap items-center justify-between gap-2 rounded-lg bg-warning-container px-space-md py-2 text-body-sm text-on-warning-container">
        <p className="min-w-0 flex-1 basis-56">
          Read from a scan by OCR, so this text may differ from the original. Check the scan before quoting it.
          {ocr.lowLines > 0 && ` ${low} below ${LOW_OCR_CONFIDENCE}% confidence.`}
          {ocr.inferredPages.length > 0 && <strong className="block font-semibold">Page {ocr.inferredPages.join(", ")} inferred: OCR couldn't read the printed number, so verify it against the scan before citing.</strong>}
        </p>
        <Button variant="secondary" className="h-8" onClick={() => setOpen(true)}><FileSearch aria-hidden className="size-4" />View original scan</Button>
      </div>
      <Dialog wide open={open} onClose={() => setOpen(false)} title={`Original scan of ${side.range ?? "this passage"}`}>
        <div className="grid grid-cols-1 gap-space-md p-space-lg lg:grid-cols-2">
          <div className="max-h-[35vh] overflow-y-auto lg:max-h-[75vh]">
            <p className="mb-space-sm text-label-md text-on-surface-variant">OCR text</p>
            <LineList side={side} mark={mark} />
          </div>
          <div>
            <p className="mb-space-sm text-label-md text-on-surface-variant">
              PDF page {ocr.pages.length > 1 ? `${ocr.pages[0]}–${ocr.pages.at(-1)}` : ocr.pages[0]} · <a href={url} target="_blank" rel="noreferrer" className="text-secondary underline">Open in a new tab</a>
            </p>
            <iframe src={url} title={`Original PDF of ${side.deposition.originalFilename ?? `deposition ${side.deposition.id}`}, page ${ocr.pages[0]}`} className="h-[45vh] w-full rounded-lg bg-surface-container lg:h-[75vh]" />
          </div>
        </div>
      </Dialog>
    </>
  );
}

function LineList({ side, mark }: { side: EvidenceSide; mark: Mark }) {
  return (
    <div className="font-mono text-body-sm leading-relaxed">
      <Lines lines={side.before} muted mark={mark} />
      {side.gapBefore && <Gap />}
      <Lines lines={side.lines} mark={mark} />
      {side.gapAfter && <Gap />}
      <Lines lines={side.after} muted mark={mark} />
    </div>
  );
}

function Lines({ lines, muted, mark }: { lines: EvidenceLine[]; muted?: boolean; mark: Mark }) {
  return (
    <ol>
      {lines.map((l) => (
        <li key={l.id} className={cx("-mx-1 flex items-start gap-2 rounded px-1 py-0.5", l.highlighted && (mark === "red" ? "bg-error-container/60 font-semibold" : "bg-warning-container font-medium"))}>
          <span className={cx("w-14 flex-none select-none text-right", l.highlighted ? (mark === "red" ? "font-semibold text-error" : "font-semibold text-on-warning-container") : "text-outline")}>{l.ref}</span>
          <span className={cx("min-w-0 flex-1 break-words whitespace-pre-wrap", muted && !l.highlighted && "text-on-surface-variant")}>{l.text}</span>
          <Confidence value={l.ocrConfidence} />
        </li>
      ))}
    </ol>
  );
}

function Confidence({ value }: { value: number | null }) {
  if (value == null) return null;
  const low = value < LOW_OCR_CONFIDENCE;
  return (
    <span className={cx("flex w-[4.5rem] flex-none items-center justify-end gap-1 pt-0.5 font-sans whitespace-nowrap text-label-sm tabular-nums", low ? "font-semibold text-on-warning-container" : "font-normal text-on-surface-variant")}>
      <span className="sr-only">OCR confidence</span>
      {low && <TriangleAlert aria-hidden className="size-3" />}
      {low && "Low "}{value}%
    </span>
  );
}

const Gap = () => <p className="py-1 text-center font-sans text-label-sm text-on-surface-variant italic">Pages omitted from the source transcript here.</p>;

const Heading = ({ children }: { children: ReactNode }) => <h3 className="text-label-md text-on-surface-variant">{children}</h3>;

export function ModelAssessment({ f }: { f: FindingDetail }) {
  const contradiction = f.group === "contradictions" || (f.direct === null && (f.classification === "direct" || f.classification === "inferential"));
  const a = f.assessment;
  return (
    <Card className="flex flex-col gap-space-md p-space-lg">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-headline-lg">{contradiction ? "Why the statements may conflict" : f.classification === "false_positive" ? "Why they may be compatible" : "Assessment"}</h2>
        <ModelMark />
      </div>
      <div className="rounded-lg bg-surface-container-low p-space-md leading-relaxed">{a.explanation}</div>
      {f.direct ? (
        <dl className="grid grid-cols-1 gap-y-2 text-body-sm">
          {f.direct.conflictBasis && <Term label="What the possible conflict rests on">{f.direct.conflictBasis}</Term>}
          {f.direct.reasoning && <Term label="What the judgement rests on">{f.direct.reasoning}</Term>}
          {f.direct.missingContext && <Term label="What's missing">{f.direct.missingContext}</Term>}
        </dl>
      ) : (
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-body-sm">
        <Term label="Same event?">{SAME_EVENT[a.sameEvent] ?? a.sameEvent}</Term>
        <Term label="Same time frame and circumstances?">{SAME_EVENT[a.scopeAligned]?.replace("Same event", "Yes").replace("Different events", "No").replace("Unclear whether the same event", "Unclear") ?? a.scopeAligned}</Term>
        {contradiction && <Term label="Kind of conflict">{a.conflictBasis.replaceAll("_", " ")}</Term>}
        {a.falsePositiveReason && <Term label="Reason it may be compatible">{a.falsePositiveReason.replaceAll("_", " ")}</Term>}
      </dl>
      )}
      {a.inferenceSteps.length > 0 && (
        <div>
          <Heading>Reasoning steps</Heading>
          <ol className="mt-1 list-decimal space-y-1 pl-5 text-body-sm">{a.inferenceSteps.map((s, i) => <li key={i}>{s.statement}</li>)}</ol>
        </div>
      )}
      {!f.direct && a.unestablishedAssumptions.length > 0 && (
        <div>
          <Heading>Assumptions the testimony doesn't establish</Heading>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-body-sm">{a.unestablishedAssumptions.map((s, i) => <li key={i}>{s}</li>)}</ul>
        </div>
      )}
      {(a.alternativeExplanation || f.contextRequested || f.contextCheck) && (
        <div className="grid gap-space-md md:grid-cols-2">
          {a.alternativeExplanation && (
            <div className="rounded-lg bg-surface-container p-space-md md:col-span-1">
              <Heading>Alternative explanation{a.alternativeSupport ? ` (the model rates it ${a.alternativeSupport})` : ""}</Heading>
              <p className="mt-1 text-body-sm">{a.alternativeExplanation}</p>
            </div>
          )}
          {(f.contextRequested || f.contextCheck) && (
            <div className="rounded-lg bg-surface-container p-space-md">
              <Heading>Context</Heading>
              {f.contextRequested && !f.direct && <p className="mt-1 text-body-sm">The assessment says lines outside these passages could change it.</p>}
              {f.contextCheck && <p className="mt-1 text-body-sm">Transcript check: {f.contextCheck.replace(/\.$/, "")}.</p>}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

export function ChecksCard({ f }: { f: FindingDetail }) {
  return (
    <Card className="p-space-lg">
      <div className="flex items-center gap-2">
        <ShieldCheck aria-hidden className="size-5 text-success" />
        <h2 className="text-headline-md">How this was checked</h2>
      </div>
      <p className="text-body-sm text-on-surface-variant">Deterministic checks against the stored transcript.</p>
      <ul className="mt-space-md space-y-space-md text-body-sm">
        {(["a", "b"] as const).map((k) => {
          const s = f[k];
          return (
            <li key={k}>
              <p className="font-semibold">Session {k.toUpperCase()}</p>
              <p>
                {VERIFICATION[s.verification.status] ?? s.verification.status}
                {s.verification.location ? `, ${LOCATION[s.verification.location] ?? s.verification.location}` : ""}.
                {s.verification.bareAnswer ? " The quoted words are a short answer, so the question they answer is shown with them." : ""}
              </p>
              {ocrPassage(s) && <p className="text-on-warning-container">Checked against the OCR text, not the scan itself.</p>}
              <p>Attribution: {ATTRIBUTION_LEVEL[s.attribution.level] ?? s.attribution.level}.</p>
              {f.direct && <p>Speaker: {SPEAKER[f.direct[k].speaker] ?? f.direct[k].speaker}.{f.direct[k].reportedSpeech ? " This reports what someone else said." : ""}</p>}
              {f.direct && f.direct[k].ocr.lowLines.length > 0 && <p className="text-on-warning-container">Low OCR confidence on {f.direct[k].ocr.lowLines.join(", ")}.</p>}
              {s.attribution.disagreement && <p className="text-on-warning-container">{DISAGREEMENT[s.attribution.disagreement]}</p>}
              {s.verification.reason && <p className="text-on-error-container">{s.verification.reason}.</p>}
            </li>
          );
        })}
      </ul>
      {f.direct && f.direct.duplicates.length > 0 && (
        <div className="mt-space-md text-body-sm">
          <p className="font-semibold">Merged proposals</p>
          <p className="text-on-surface-variant">These rest on the same passages, so they are shown once. The most cautious reading is the one above.</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">{f.direct.duplicates.map((d) => <li key={d.findingId}><span className="font-mono text-label-md font-normal">{d.a} / {d.b}</span>: {d.explanation}</li>)}</ul>
        </div>
      )}
      {f.timeCheck && <p className="mt-space-md text-body-sm">Time check: {f.timeCheck.detail}</p>}
      {f.consistencyIssues.length > 0 && (
        <div className="mt-space-md">
          <Alert tone="warn" title="The assessment contradicts itself">{f.consistencyIssues.map((i) => i.replaceAll("_", " ")).join("; ")}.</Alert>
        </div>
      )}
    </Card>
  );
}

export function ScoreCard({ f }: { f: FindingDetail }) {
  if (f.direct && f.score !== null) {
    return (
      <Card className="p-space-lg">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-headline-md">Evidence strength</h2>
          <span className="text-stat-metric tabular-nums">{f.score}<span className="text-body-sm font-normal text-on-surface-variant"> /100</span></span>
        </div>
        <p className="text-body-sm text-on-surface-variant">{EVIDENCE_STRENGTH_NOTE} It doesn't set the priority or the category. Version {f.rubricVersion}.</p>
        <ul className="mt-space-md space-y-3 text-body-sm">
          {f.factors.map((c) => (
            <li key={c.label}>
              <p className="flex items-baseline justify-between gap-3">
                <span className="font-semibold">{c.label}</span>
                <span className="flex-none text-label-sm text-on-surface-variant tabular-nums">{c.points}/{c.max} · {ORIGIN[c.origin]}</span>
              </p>
              <p className="text-on-surface-variant">{c.detail}</p>
            </li>
          ))}
        </ul>
      </Card>
    );
  }
  if (f.score === null) {
    return (
      <Card className="p-space-lg">
        <div className="flex items-center gap-2">
          <CircleAlert aria-hidden className="size-5 text-on-warning-container" />
          <h2 className="text-headline-md">Not scored</h2>
        </div>
        <p className="mt-1 text-body-sm text-on-surface-variant">{f.unscoredExplanation ?? "This finding has no score. Read both passages yourself."}</p>
      </Card>
    );
  }
  const byComponent = (["A", "C", "S", "K", "U"] as const).map((c) => ({ c, factors: f.factors.filter((x) => x.component === c) })).filter((g) => g.factors.length > 0);
  return (
    <Card className="p-space-lg">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-headline-md">Why this score?</h2>
        <span className="text-stat-metric tabular-nums">{f.score}<span className="text-body-sm font-normal text-on-surface-variant"> /100</span></span>
      </div>
      <p className="text-body-sm text-on-surface-variant">Calculated by this application with rubric {f.rubricVersion}. Each point traces to a check; caps limit the total. Not a probability that the witness contradicted themself.</p>
      <div className="mt-space-md space-y-3 text-body-sm">
        {byComponent.map(({ c, factors }) => (
          <div key={c}>
            <Heading>{COMPONENT[c]} · {factors.reduce((t, x) => t + x.points, 0)}</Heading>
            <ul className="mt-1 space-y-0.5">
              {factors.map((x, i) => (
                <li key={i} className="flex items-baseline justify-between gap-3">
                  <span>{x.label}</span>
                  <span className="flex-none text-label-sm text-on-surface-variant tabular-nums">{x.points > 0 ? "+" : ""}{x.points}{x.max > 0 ? `/${x.max}` : ""} · {ORIGIN[x.origin]}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {f.caps.length > 0 && (
          <div>
            <Heading>Limits</Heading>
            <ul className="mt-1 space-y-0.5">
              {f.caps.map((c) => <li key={c.rule} className={cx(c.binding && "font-semibold")}>At most {c.limit}: {c.reason}{c.binding ? " (applied)" : ""}</li>)}
            </ul>
          </div>
        )}
        {f.notCorroborated.length > 0 && <p className="text-label-sm text-on-surface-variant">Not independently corroborated: {f.notCorroborated.join("; ")}.</p>}
      </div>
    </Card>
  );
}

export function Term({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-label-sm text-on-surface-variant">{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
