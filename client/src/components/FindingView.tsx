// One finding: the two passages side by side as the transcript records them, then what the
// assessment says and how code checked it. Testimony is only ever the stored lines, shown verbatim
// with their page:line; the model's words appear only under headings that say they are the model's.

import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { ATTRIBUTION_LEVEL, CLASSIFICATION, COMPONENT, DISAGREEMENT, formatDate, LOCATION, ORIGIN, PRIORITY, SAME_EVENT, scoreLabel, VERIFICATION } from "../lib/labels";
import type { EvidenceLine, EvidenceSide, FindingDetail } from "../types";
import { Alert, Badge, Card, Loading, cx } from "./ui";

export function FindingView({ id }: { id: number }) {
  const [f, setF] = useState<FindingDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.finding(id).then((r) => setF(r.finding)).catch((e: Error) => setError(e.message));
  }, [id]);
  if (error) return <Alert title="This finding couldn't be loaded">{error}</Alert>;
  if (!f) return <Loading />;
  const contradiction = f.classification === "direct" || f.classification === "inferential";

  return (
    <article className="space-y-5" aria-labelledby={`finding-${f.id}`}>
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{f.groupLabel}</p>
            <h2 id={`finding-${f.id}`} className="mt-0.5 text-lg font-semibold text-slate-900">
              {CLASSIFICATION[f.classification]}
            </h2>
            <p className="mt-1 text-sm text-slate-700">{scoreLabel(f)}</p>
            <p className="mt-0.5 text-xs text-slate-500">Application-calculated with rubric {f.rubricVersion}. Not a probability that the witness contradicted themself.</p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <Badge tone={f.priority === "high" ? "contradiction" : f.priority === "needs_context" ? "warn" : "neutral"}>{PRIORITY[f.priority]}</Badge>
            <Badge tone={f.evidenceStatus === "verified" || f.evidenceStatus === "approximate" ? "good" : "bad"}>
              {f.evidenceStatus === "verified" ? "Citations verified" : f.evidenceStatus === "approximate" ? "Citations verified (approximate)" : "Citation not verified"}
            </Badge>
            {f.contextRequested && <Badge tone="warn" title="The assessment says lines outside these passages could change it">More context requested</Badge>}
          </div>
        </div>
        {f.source.kind !== "model" && (
          <div className="border-t border-indigo-100 bg-indigo-50 px-5 py-2 text-xs text-indigo-900">{f.source.label}.</div>
        )}
        {f.unscoredExplanation && <div className="border-t border-amber-100 bg-amber-50 px-5 py-2 text-xs text-amber-950">{f.unscoredExplanation}</div>}
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Passage label="Session A" side={f.a} />
        <Passage label="Session B" side={f.b} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <Section title={contradiction ? "Why the statements may conflict" : f.classification === "false_positive" ? "Why they may be compatible" : "Assessment"} note="The model's interpretation, not verified testimony.">
            <p className="text-sm leading-6 text-slate-800">{f.assessment.explanation}</p>
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
              <Term label="Same event?">{SAME_EVENT[f.assessment.sameEvent] ?? f.assessment.sameEvent}</Term>
              <Term label="Same time frame and circumstances?">{SAME_EVENT[f.assessment.scopeAligned]?.replace("Same event", "Yes").replace("Different events", "No").replace("Unclear whether the same event", "Unclear") ?? f.assessment.scopeAligned}</Term>
              {contradiction && <Term label="Kind of conflict">{f.assessment.conflictBasis.replaceAll("_", " ")}</Term>}
              {f.assessment.falsePositiveReason && <Term label="Reason it may be compatible">{f.assessment.falsePositiveReason.replaceAll("_", " ")}</Term>}
            </dl>
            {f.assessment.inferenceSteps.length > 0 && (
              <div className="mt-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Reasoning steps</p>
                <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm text-slate-800">
                  {f.assessment.inferenceSteps.map((s, i) => (
                    <li key={i}>{s.statement}</li>
                  ))}
                </ol>
              </div>
            )}
            {f.assessment.unestablishedAssumptions.length > 0 && (
              <div className="mt-3">
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Assumptions the testimony doesn't establish</p>
                <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-800">
                  {f.assessment.unestablishedAssumptions.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              </div>
            )}
          </Section>
          {f.assessment.alternativeExplanation && (
            <Section title="Alternative explanation" note={f.assessment.alternativeSupport ? `The model rates it ${f.assessment.alternativeSupport}.` : "The model's interpretation."}>
              <p className="text-sm leading-6 text-slate-800">{f.assessment.alternativeExplanation}</p>
            </Section>
          )}
          {(f.contextRequested || f.contextCheck) && (
            <Section title="Context">
              {f.contextRequested && <p className="text-sm text-slate-800">The assessment says lines outside these passages could change it.</p>}
              {f.contextCheck && <p className="mt-1 text-sm text-slate-600">Transcript check: {f.contextCheck}.</p>}
            </Section>
          )}
        </Card>

        <Card>
          <Section title="How this was checked" note="Deterministic checks against the stored transcript.">
            <ul className="space-y-3 text-sm">
              {(["a", "b"] as const).map((k) => {
                const s = f[k];
                return (
                  <li key={k}>
                    <p className="font-medium text-slate-900">Session {k.toUpperCase()}</p>
                    <p className="text-slate-700">
                      {VERIFICATION[s.verification.status] ?? s.verification.status}
                      {s.verification.location ? `, ${LOCATION[s.verification.location] ?? s.verification.location}` : ""}.
                      {s.verification.bareAnswer ? " The quoted words are a short answer, so the question they answer is shown with them." : ""}
                    </p>
                    <p className="text-slate-700">Attribution: {ATTRIBUTION_LEVEL[s.attribution.level] ?? s.attribution.level}.</p>
                    {s.attribution.disagreement && <p className="text-amber-900">{DISAGREEMENT[s.attribution.disagreement]}</p>}
                    {s.verification.reason && <p className="text-rose-800">{s.verification.reason}.</p>}
                  </li>
                );
              })}
            </ul>
            {f.timeCheck && <p className="mt-3 text-sm text-slate-700">Time check: {f.timeCheck.detail}</p>}
            {f.consistencyIssues.length > 0 && (
              <Alert tone="warn" title="The assessment contradicts itself">
                {f.consistencyIssues.map((i) => i.replaceAll("_", " ")).join("; ")}.
              </Alert>
            )}
          </Section>
          <ScoreBreakdown f={f} />
        </Card>
      </div>
    </article>
  );
}

function Passage({ label, side }: { label: string; side: EvidenceSide }) {
  return (
    <Card className="flex min-w-0 flex-col">
      <header className="border-b border-slate-100 px-4 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-sm font-semibold text-slate-900">
            {label} · {formatDate(side.deposition.takenOn)}
          </p>
          {side.range && <p className="font-mono text-xs text-slate-600">{side.range}</p>}
        </div>
        <p className="text-xs text-slate-600">
          {side.deposition.witness}
          {side.deposition.originalFilename ? ` · ${side.deposition.originalFilename}` : ` · Deposition #${side.deposition.id}`}
        </p>
      </header>
      <div className="flex-1 px-1 py-2 font-serif text-[0.9375rem] leading-7">
        {side.before.length > 0 && <Lines lines={side.before} muted />}
        {side.gapBefore && <Gap />}
        <div className="my-1 rounded-md bg-slate-50 py-1 ring-1 ring-inset ring-slate-200">
          <Lines lines={side.lines} />
        </div>
        {side.gapAfter && <Gap />}
        {side.after.length > 0 && <Lines lines={side.after} muted />}
      </div>
      <footer className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
        Verbatim from the transcript. <mark className="rounded bg-amber-100 px-1 text-slate-800">Highlighted</mark> lines hold the cited words; shaded lines are the exchange; grey lines are surrounding context.
      </footer>
    </Card>
  );
}

function Lines({ lines, muted }: { lines: EvidenceLine[]; muted?: boolean }) {
  return (
    <ol>
      {lines.map((l) => (
        <li key={l.id} className={cx("grid grid-cols-[3.25rem_1fr] gap-2 px-3", muted && "text-slate-400", l.highlighted && "bg-amber-100/80")}>
          <span className="select-none pt-0.5 text-right font-mono text-xs leading-7 text-slate-400">{l.ref}</span>
          <span className={cx("whitespace-pre-wrap break-words", !muted && "text-slate-900")}>{l.text}</span>
        </li>
      ))}
    </ol>
  );
}

const Gap = () => <p className="px-3 py-1 text-center font-sans text-xs italic text-slate-500">Pages omitted from the source transcript here.</p>;

function Section({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-slate-100 px-5 py-4 last:border-b-0">
      <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
      {note && <p className="text-xs text-slate-500">{note}</p>}
      <div className="mt-2">{children}</div>
    </section>
  );
}

function Term({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="text-slate-800">{children}</dd>
    </div>
  );
}

function ScoreBreakdown({ f }: { f: FindingDetail }) {
  if (f.score === null) return null;
  const byComponent = (["A", "C", "S", "K", "U"] as const).map((c) => ({ c, factors: f.factors.filter((x) => x.component === c) })).filter((g) => g.factors.length > 0);
  return (
    <Section title="Why this score?" note="Each point traces to a check; caps limit the total.">
      <div className="space-y-3 text-sm">
        {byComponent.map(({ c, factors }) => (
          <div key={c}>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              {COMPONENT[c]} · {factors.reduce((t, x) => t + x.points, 0)}
            </p>
            <ul className="mt-1 space-y-0.5">
              {factors.map((x, i) => (
                <li key={i} className="flex items-baseline justify-between gap-3">
                  <span className="text-slate-700">{x.label}</span>
                  <span className="shrink-0 font-mono text-xs text-slate-600">
                    {x.points > 0 ? "+" : ""}
                    {x.points}
                    {x.max > 0 ? `/${x.max}` : ""} <span className="text-slate-400">· {ORIGIN[x.origin]}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {f.caps.length > 0 && (
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Limits</p>
            <ul className="mt-1 space-y-0.5">
              {f.caps.map((c) => (
                <li key={c.rule} className={cx("text-slate-700", c.binding && "font-medium text-slate-900")}>
                  At most {c.limit}: {c.reason}
                  {c.binding ? " (applied)" : ""}
                </li>
              ))}
            </ul>
          </div>
        )}
        {f.notCorroborated.length > 0 && <p className="text-xs text-slate-500">Not independently corroborated: {f.notCorroborated.join("; ")}.</p>}
      </div>
    </Section>
  );
}
