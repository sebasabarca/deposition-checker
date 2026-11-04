// The parts of one finding. Testimony is only ever the stored lines, shown verbatim with their
// page:line on a transcript sheet; the model's words appear only under the model mark; checks are
// labelled as code's.

import { useState, type ReactNode } from "react";
import { CircleAlert, FileSearch, ShieldCheck, TriangleAlert } from "lucide-react";
import { api } from "../lib/api";
import { displayRef, LOW_OCR_CONFIDENCE, ocrPassage } from "../lib/insights";
import { ATTRIBUTION_LEVEL, COMPONENT, DISAGREEMENT, EVIDENCE_STRENGTH_NOTE, formatDate, KNOWLEDGE_BASIS, LOCATION, ORIGIN, SAME_EVENT, SPEAKER, VERIFICATION } from "../lib/labels";
import { href } from "../lib/router";
import type { EvidenceLine, EvidenceSide, FindingDetail } from "../types";
import { Alert, Button, cx, Dialog, HumanMark, ModelMark, OcrMark, TestimonyMark } from "./ui";

export function Passage({ label, side }: { label: string; side: EvidenceSide }) {
  const ocr = ocrPassage(side);
  // The cited lines (or the whole exchange), to open the transcript at and highlight there.
  const cited = side.lines.some((l) => l.highlighted) ? side.lines.filter((l) => l.highlighted) : side.lines;
  const page = cited[0] ? Number(cited[0].ref.split(":")[0]) : null; // 0 for unnumbered text
  const mark = cited.length ? `${cited[0].ref}-${cited.at(-1)!.ref}` : undefined;
  return (
    <section className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-line bg-sheet">
      <header className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5 border-b border-rule px-4 py-3">
        <div className="min-w-0">
          <p className="text-xs text-faint">{label} · {formatDate(side.deposition.takenOn)}</p>
          <h3 className="mt-0.5 font-mono text-md font-bold tracking-tight">{displayRef(side.range) ?? "No page:line reference"}</h3>
        </div>
        {ocr ? <OcrMark /> : <TestimonyMark />}
      </header>
      <div className="flex-1">
        <PassageLines side={side} />
      </div>
      <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-rule px-4 py-2 text-xs text-faint">
        <span className="truncate">{side.deposition.witness} · {side.deposition.originalFilename ?? `Deposition #${side.deposition.id}`}</span>
        {page !== null && <a href={href.deposition(side.deposition.id, { page, mark })} className="flex-none font-medium text-info hover:underline">Read in full</a>}
      </footer>
    </section>
  );
}

export function PassageLines({ side }: { side: EvidenceSide }) {
  return (
    <>
      <OcrNotice side={side} />
      <PhysicalNotice side={side} />
      <LineList side={side} />
    </>
  );
}

function PhysicalNotice({ side }: { side: EvidenceSide }) {
  if (!side.deposition.physicalLines) return null;
  return (
    <p className="border-b border-context/15 bg-context-bg px-4 py-2.5 text-sm text-context">
      This PDF has no printed line numbers, so Veridict counted the lines on each page. These counts are not the court reporter's official line numbers: cite the certified transcript.
    </p>
  );
}

// The warning and the scan sit with the lines themselves, so every place testimony appears gets them.
function OcrNotice({ side }: { side: EvidenceSide }) {
  const [open, setOpen] = useState(false);
  const ocr = ocrPassage(side);
  if (!ocr) return null;
  const url = api.depositionPdf(side.deposition.id, ocr.pages[0]);
  const low = ocr.lowLines === 1 ? "1 line is" : `${ocr.lowLines} lines are`;
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-context/15 bg-context-bg px-4 py-2.5 text-sm text-context">
        <p className="min-w-0 flex-1 basis-56">
          This is a scanned copy: Veridict read the words from a picture of each page, and a word can be misread now and then. Compare with the page image before quoting.
          {ocr.lowLines > 0 && ` ${low} hard to read (under ${LOW_OCR_CONFIDENCE}% reading accuracy).`}
          {ocr.inferredPages.length > 0 && <strong className="block font-semibold">Page {ocr.inferredPages.join(", ")} inferred: verify the number against the scan before citing.</strong>}
        </p>
        <Button variant="secondary" className="h-7" onClick={() => setOpen(true)}><FileSearch aria-hidden className="size-4" />View scan</Button>
      </div>
      <Dialog wide open={open} onClose={() => setOpen(false)} title={`Original scan of ${displayRef(side.range) ?? "this passage"}`}>
        <div className="grid grid-cols-1 gap-5 p-6 lg:grid-cols-2">
          <div className="max-h-[35vh] overflow-y-auto rounded-lg border border-line lg:max-h-[75vh]">
            <LineList side={side} />
          </div>
          <div>
            <p className="mb-2 text-sm text-muted">
              PDF page {ocr.pages.length > 1 ? `${ocr.pages[0]}–${ocr.pages.at(-1)}` : ocr.pages[0]} · <a href={url} target="_blank" rel="noreferrer" className="font-medium text-info underline">Open in a new tab</a>
            </p>
            <iframe src={url} title={`Original PDF of ${side.deposition.originalFilename ?? `deposition ${side.deposition.id}`}, page ${ocr.pages[0]}`} className="h-[45vh] w-full rounded-lg border border-line bg-well lg:h-[75vh]" />
          </div>
        </div>
      </Dialog>
    </>
  );
}

function LineList({ side }: { side: EvidenceSide }) {
  return (
    <div className="transcript py-3">
      <TranscriptRows lines={side.before} muted />
      {side.gapBefore && <Gap />}
      <TranscriptRows lines={side.lines} />
      {side.gapAfter && <Gap />}
      <TranscriptRows lines={side.after} muted />
    </div>
  );
}

// One row per stored line: its page:line in the number column, the text past the margin rule, and
// the cited lines in highlighter.
export function TranscriptRows({ lines, muted }: { lines: (Pick<EvidenceLine, "id" | "ref" | "text" | "ocrConfidence"> & { highlighted?: boolean })[]; muted?: boolean }) {
  return (
    <ol>
      {lines.map((l) => (
        <li key={l.id} data-highlighted={l.highlighted || undefined} className="grid scroll-mt-24 grid-cols-[3.6rem_1fr_auto] items-start">
          <span className={cx("pr-2.5 text-right text-[12px] select-none tabular-nums", l.highlighted ? "font-bold text-mark-ink" : "text-faint")}>{displayRef(l.ref).replace("Line ", "")}</span>
          <span className={cx("min-w-0 border-l-[3px] border-double border-margin pr-4 pl-4 break-words whitespace-pre-wrap", l.highlighted && "bg-mark text-ink [box-decoration-break:clone]", muted && !l.highlighted && "text-muted")}>{l.text || " "}</span>
          <Confidence value={l.ocrConfidence} />
        </li>
      ))}
    </ol>
  );
}

function Confidence({ value }: { value: number | null }) {
  if (value == null || value >= LOW_OCR_CONFIDENCE) return null;
  return (
    <span className="flex items-center gap-1 pr-3 font-sans text-xs whitespace-nowrap text-context tabular-nums" title="Reading accuracy for this line of the scanned page">
      <TriangleAlert aria-hidden className="size-3" />
      {value}%
    </span>
  );
}

const Gap = () => <p className="py-1 pl-[4.6rem] font-sans text-xs text-faint italic">Pages omitted from the source transcript here.</p>;

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const Heading = ({ children }: { children: ReactNode }) => <h3 className="text-xs font-semibold text-faint">{children}</h3>;

export function ModelAssessment({ f }: { f: FindingDetail }) {
  const contradiction = f.group === "contradictions" || (f.direct === null && (f.classification === "direct" || f.classification === "inferential"));
  const a = f.assessment;
  return (
    <section className="flex flex-col gap-4 rounded-lg border border-line bg-sheet p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-md font-semibold">{contradiction && f.cross ? "Why the accounts may conflict" : contradiction ? "Why the statements may conflict" : f.classification === "false_positive" ? "Why they may be compatible" : "Assessment"}</h2>
        {/* A prepared demo assessment was written by a person: never badge it as the model's reading. */}
        {f.source.kind === "fixture" ? <HumanMark>Prepared example, not model output</HumanMark> : <ModelMark />}
      </div>
      <p className="font-serif text-[17px] leading-7">{a.explanation}</p>
      {f.direct ? (
        (f.direct.conflictBasis || f.direct.reasoning || f.direct.missingContext || f.cross) && (
          <dl className="grid grid-cols-1 gap-3 border-t border-rule pt-4 text-sm">
            {f.cross && <Term label={`How ${f.cross.witnessA} knows`}>{capitalize(KNOWLEDGE_BASIS[f.cross.basisA] ?? f.cross.basisA)}</Term>}
            {f.cross && <Term label={`How ${f.cross.witnessB} knows`}>{capitalize(KNOWLEDGE_BASIS[f.cross.basisB] ?? f.cross.basisB)}</Term>}
            {f.direct.conflictBasis && <Term label="What the possible conflict rests on">{f.direct.conflictBasis}</Term>}
            {f.direct.reasoning && <Term label="What the judgement rests on">{f.direct.reasoning}</Term>}
            {f.direct.missingContext && <Term label="What's missing">{f.direct.missingContext}</Term>}
          </dl>
        )
      ) : (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-rule pt-4 text-sm">
          <Term label="Same event?">{SAME_EVENT[a.sameEvent] ?? a.sameEvent}</Term>
          <Term label="Same time frame and circumstances?">{SAME_EVENT[a.scopeAligned]?.replace("Same event", "Yes").replace("Different events", "No").replace("Unclear whether the same event", "Unclear") ?? a.scopeAligned}</Term>
          {contradiction && <Term label="Kind of conflict">{a.conflictBasis.replaceAll("_", " ")}</Term>}
          {a.falsePositiveReason && <Term label="Reason it may be compatible">{a.falsePositiveReason.replaceAll("_", " ")}</Term>}
        </dl>
      )}
      {a.inferenceSteps.length > 0 && (
        <div>
          <Heading>Reasoning steps</Heading>
          <ol className="mt-1.5 list-decimal space-y-1 pl-5 text-sm">{a.inferenceSteps.map((s, i) => <li key={i}>{s.statement}</li>)}</ol>
        </div>
      )}
      {!f.direct && a.unestablishedAssumptions.length > 0 && (
        <div>
          <Heading>Assumptions the testimony doesn't establish</Heading>
          <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm">{a.unestablishedAssumptions.map((s, i) => <li key={i}>{s}</li>)}</ul>
        </div>
      )}
      {a.alternativeExplanation && (
        <div className="rounded-md bg-well px-4 py-3">
          <Heading>The innocent explanation{a.alternativeSupport ? ` (rated ${a.alternativeSupport})` : ""}</Heading>
          <p className="mt-1 text-sm leading-6">{a.alternativeExplanation}</p>
        </div>
      )}
      {!f.direct && (f.contextRequested || f.contextCheck) && (
        <div className="rounded-md bg-well px-4 py-3 text-sm">
          <Heading>Context</Heading>
          {f.contextRequested && <p className="mt-1">The assessment says lines outside these passages could change it.</p>}
          {f.contextCheck && <p className="mt-1">Transcript check: {f.contextCheck.replace(/\.$/, "")}.</p>}
        </div>
      )}
    </section>
  );
}

export function ChecksCard({ f }: { f: FindingDetail }) {
  return (
    <div>
      <div className="flex items-center gap-2">
        <ShieldCheck aria-hidden className="size-4 text-ok" />
        <h3 className="font-semibold">Transcript checks</h3>
      </div>
      <p className="text-sm text-muted">Done by code against the stored transcript, not by the model.</p>
      <ul className="mt-3 space-y-3 text-sm">
        {(["a", "b"] as const).map((k) => {
          const s = f[k];
          return (
            <li key={k} className="space-y-0.5">
              <p className="font-semibold">{f.cross ? (k === "a" ? f.cross.witnessA : f.cross.witnessB) : `Session ${k.toUpperCase()}`}</p>
              <p>
                {VERIFICATION[s.verification.status] ?? s.verification.status}
                {s.verification.location ? `, ${LOCATION[s.verification.location] ?? s.verification.location}` : ""}.
                {s.verification.bareAnswer ? " The quoted words are a short answer, so the question they answer is shown with them." : ""}
              </p>
              {ocrPassage(s) && <p className="text-context">Checked against the text read from the scanned page, not the page image itself.</p>}
              <p>Attribution: {ATTRIBUTION_LEVEL[s.attribution.level] ?? s.attribution.level}.</p>
              {f.direct && <p>Speaker: {SPEAKER[f.direct[k].speaker] ?? f.direct[k].speaker}.{f.direct[k].reportedSpeech ? " This reports what someone else said." : ""}</p>}
              {f.direct && f.direct[k].ocr.lowLines.length > 0 && <p className="text-context">Hard to read on the scanned page: {f.direct[k].ocr.lowLines.join(", ")}.</p>}
              {s.attribution.disagreement && <p className="text-context">{DISAGREEMENT[s.attribution.disagreement]}</p>}
              {s.verification.reason && <p className="text-conflict">{s.verification.reason}.</p>}
            </li>
          );
        })}
      </ul>
      {f.direct && f.direct.duplicates.length > 0 && (
        <div className="mt-4 text-sm">
          <p className="font-semibold">Merged proposals</p>
          <p className="text-muted">These rest on the same passages, so they are shown once. The most cautious reading is the one above.</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">{f.direct.duplicates.map((d) => <li key={d.findingId}><span className="font-mono">{d.a} / {d.b}</span>: {d.explanation}</li>)}</ul>
        </div>
      )}
      {f.timeCheck && <p className="mt-4 text-sm">Time check: {f.timeCheck.detail}</p>}
      {f.consistencyIssues.length > 0 && (
        <div className="mt-4">
          <Alert tone="warn" title="The assessment contradicts itself">{f.consistencyIssues.map((i) => i.replaceAll("_", " ")).join("; ")}.</Alert>
        </div>
      )}
    </div>
  );
}

export function ScoreCard({ f }: { f: FindingDetail }) {
  if (f.direct && f.score !== null) {
    return (
      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h3 className="font-semibold">Evidence strength</h3>
          <span className="text-lg font-semibold tabular-nums">{f.score}<span className="text-sm font-normal text-faint"> / 100</span></span>
        </div>
        <p className="text-sm text-muted">{EVIDENCE_STRENGTH_NOTE} It doesn't set the priority or the category. Version {f.rubricVersion}.</p>
        <ul className="mt-3 divide-y divide-rule text-sm">
          {f.factors.map((c) => (
            <li key={c.label} className="py-2">
              <p className="flex items-baseline justify-between gap-3">
                <span className="font-medium">{c.label}</span>
                <span className="flex-none text-xs text-faint tabular-nums">{c.points}/{c.max} · {ORIGIN[c.origin]}</span>
              </p>
              {c.detail && <p className="text-muted">{c.detail}</p>}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  if (f.score === null) {
    return (
      <div>
        <div className="flex items-center gap-2">
          <CircleAlert aria-hidden className="size-4 text-context" />
          <h3 className="font-semibold">Not scored</h3>
        </div>
        <p className="mt-1 text-sm text-muted">{f.unscoredExplanation ?? "This finding has no score. Read both passages yourself."}</p>
      </div>
    );
  }
  const byComponent = (["A", "C", "S", "K", "U"] as const).map((c) => ({ c, factors: f.factors.filter((x) => x.component === c) })).filter((g) => g.factors.length > 0);
  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold">Why this score?</h3>
        <span className="text-lg font-semibold tabular-nums">{f.score}<span className="text-sm font-normal text-faint"> / 100</span></span>
      </div>
      <p className="text-sm text-muted">Calculated by this application with rubric {f.rubricVersion}. Each point traces to a check; caps limit the total. {f.cross ? "Not a probability that the witnesses' accounts conflict." : "Not a probability that the witness contradicted themself."}</p>
      <div className="mt-3 space-y-3 text-sm">
        {byComponent.map(({ c, factors }) => (
          <div key={c}>
            <Heading>{COMPONENT[c]} · {factors.reduce((t, x) => t + x.points, 0)}</Heading>
            <ul className="mt-1 space-y-0.5">
              {factors.map((x, i) => (
                <li key={i} className="flex items-baseline justify-between gap-3">
                  <span>{x.label}</span>
                  <span className="flex-none text-xs text-faint tabular-nums">{x.points > 0 ? "+" : ""}{x.points}{x.max > 0 ? `/${x.max}` : ""} · {ORIGIN[x.origin]}</span>
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
        {f.notCorroborated.length > 0 && <p className="text-xs text-faint">Not independently corroborated: {f.notCorroborated.join("; ")}.</p>}
      </div>
    </div>
  );
}

export function Term({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-semibold text-faint">{label}</dt>
      <dd className="mt-0.5 leading-6">{children}</dd>
    </div>
  );
}
