// One case: its depositions by witness, a check of two sessions (of one witness, or one session each of
// two witnesses), and its analyses.

import { useCallback, useEffect, useState } from "react";
import { ArrowRight, FileText, FileUp, X } from "lucide-react";
import { CheckAgain, estimateText, NO_ACCESS, useEstimate, useStartCheck } from "../components/CheckAgain";
import { useUser } from "../lib/session";
import { DangerZone } from "../components/DangerZone";
import { useAddDeposition } from "../components/Shell";
import { Alert, Badge, Button, buttonClass, Card, CardHeader, cx, Empty, Loading, PageHeader, rowClass, tdClass, thClass } from "../components/ui";
import { api } from "../lib/api";
import { checkState, isActive, pairsChecked } from "../lib/insights";
import { analysisTitle, ANALYSIS_STATUS, DEPOSITION_STATUS, formatDate, formatUsd } from "../lib/labels";
import { href, usePoll } from "../lib/router";
import type { AnalysisView, CaseDetail, DepositionRow } from "../types";

export const sourceOf = (d: Pick<DepositionRow, "scanned" | "originalFilename">) => (/\.txt$/i.test(d.originalFilename ?? "") ? "Text" : d.scanned ? "Scanned PDF" : "PDF");

export function CasePage({ id }: { id: number }) {
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [analyses, setAnalyses] = useState<AnalysisView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const add = useAddDeposition();
  const load = useCallback(() => {
    api.case(id)
      .then(async (d) => {
        setDetail(d);
        setAnalyses((await Promise.all(d.analyses.map((a) => api.analysis(a.id)))).map((r) => r.analysis).sort((a, b) => b.id - a.id));
      })
      .catch((e: Error) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);
  const busy = !!detail && (detail.depositions.some((d) => d.status === "processing") || detail.analyses.some((a) => isActive(a.status)));
  usePoll(busy, 3000, load);

  if (error) return <Alert title="This case couldn't be loaded">{error}</Alert>;
  if (!detail) return <Loading />;
  const toggle = (d: number) => setSelected((s) => (s.includes(d) ? s.filter((x) => x !== d) : [...s, d]));
  const toDecide = Math.max(analyses.reduce((n, r) => n + r.findings.groups.contradictions + r.findings.groups.needs_context - r.findings.decided, 0), 0);
  const summary = [`${detail.witnesses.length} ${detail.witnesses.length === 1 ? "witness" : "witnesses"}`, `${detail.depositions.length} ${detail.depositions.length === 1 ? "deposition" : "depositions"}`, `${analyses.length} ${analyses.length === 1 ? "analysis" : "analyses"}`, ...(toDecide > 0 ? [`${toDecide} ${toDecide === 1 ? "finding" : "findings"} to decide`] : [])].join(" · ");

  return (
    <>
      <PageHeader
        above={<a href={href.cases()} className="mb-1 inline-block text-sm text-muted hover:text-ink">Cases</a>}
        title={detail.case.name}
        description={summary}
        actions={<><a href={href.report(id)} className={buttonClass("secondary")}><FileText aria-hidden className="size-4" />Export report</a><Button onClick={() => add.open(id)}><FileUp aria-hidden className="size-4" />Add deposition</Button></>}
      />

      <DatesBanner depositions={detail.depositions} witnesses={detail.witnesses} />

      {detail.depositions.length === 0 ? (
        <Empty title="No depositions in this case yet" action={<Button onClick={() => add.open(id)}>Add deposition</Button>}>Add two sessions of the same witness, as PDF or text, to check them against each other.</Empty>
      ) : (
        detail.witnesses.filter((w) => w.depositions.length > 0).map((w) => {
          const sessions = detail.depositions.filter((d) => d.witnessId === w.id).sort((a, b) => (a.takenOn ?? "").localeCompare(b.takenOn ?? ""));
          const pairs = pairsChecked(sessions.filter((d) => d.status === "ready").map((d) => d.id), detail.analyses);
          return (
            <Card key={w.id} className="overflow-hidden">
              <CardHeader
                title={w.name}
                count={sessions.length}
                description={sessions.length < 2 ? "Select one session here and one of another witness to compare their accounts, or add another session of this witness." : "Select two sessions to check them against each other, or one here and one of another witness."}
                action={pairs.total > 0 ? <span className="text-sm text-muted tabular-nums">{pairs.checked} of {pairs.total} {pairs.total === 1 ? "pair" : "pairs"} checked</span> : undefined}
              />
              <div className="overflow-x-auto">
                <table className="w-full min-w-[44rem] text-sm">
                  <thead>
                    <tr>
                      <th className={cx(thClass, "w-12")}><span className="sr-only">Select</span></th>
                      <th className={thClass}>Date taken</th>
                      <th className={thClass}>File</th>
                      <th className={thClass}>Source</th>
                      <th className={cx(thClass, "text-right")}>Pages</th>
                      <th className={thClass}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map((d) => <SessionRow key={d.id} d={d} witness={w.name} selected={selected.includes(d.id)} onToggle={() => toggle(d.id)} onRetry={() => api.retryDeposition(d.id).then(load).catch((e: Error) => setError(e.message))} onUseDate={(date) => api.setDepositionDate(d.id, date).then(load).catch((e: Error) => setError(e.message))} />)}
                  </tbody>
                </table>
              </div>
            </Card>
          );
        })
      )}

      <Card className="overflow-hidden">
        <CardHeader title="Analyses" count={analyses.length} />
        {analyses.length === 0 ? (
          <p className="px-5 py-5 text-sm text-muted">No analyses yet. Select two sessions above to start one: two of one witness, or one each of two witnesses.</p>
        ) : (
          <AnalysesTable analyses={analyses} />
        )}
      </Card>

      <DangerZone
        what="case"
        name={detail.case.name}
        typeToConfirm
        consequence={`Deletes the case, its ${detail.depositions.length} ${detail.depositions.length === 1 ? "deposition" : "depositions"} and ${analyses.length} ${analyses.length === 1 ? "analysis" : "analyses"}, with every finding, decision and note. Cost records are kept.`}
        onDelete={async () => {
          await api.deleteCase(id);
          window.location.hash = href.cases();
        }}
      />

      {selected.length > 0 && <CompareBar detail={detail} selected={selected} onClear={() => setSelected([])} />}
    </>
  );
}

function SessionRow({ d, witness, selected, onToggle, onRetry, onUseDate }: { d: DepositionRow; witness: string; selected: boolean; onToggle: () => void; onRetry: () => void; onUseDate: (date: string) => void }) {
  const s = DEPOSITION_STATUS[d.status];
  const name = d.originalFilename ?? `Deposition #${d.id}`;
  const note = d.status === "failed" || d.status === "unsupported" ? `Couldn't be read: ${d.error ?? "this file's layout isn't recognized."}` : d.status === "needs_review" ? (d.error ?? "Some pages couldn't be read.") : d.scanned ? "Scanned copy. Compare quotations with the page image." : null;
  return (
    <tr className={cx(rowClass, selected && "bg-info-bg hover:bg-info-bg")}>
      <td className={cx(tdClass, "align-top")}>
        <input type="checkbox" aria-label={`Select ${witness}, ${formatDate(d.takenOn)}`} checked={selected} disabled={d.status !== "ready"} onChange={onToggle} className="size-4 rounded accent-navy" />
      </td>
      <td className={cx(tdClass, "align-top whitespace-nowrap")}><SessionDate d={d} onUse={onUseDate} /></td>
      <td className={cx(tdClass, "max-w-80 align-top")}>
        <a href={href.deposition(d.id)} className="block truncate font-medium hover:underline" title={name}>{name}</a>
        {note && <span className="mt-0.5 block text-xs text-muted">{note}</span>}
      </td>
      <td className={cx(tdClass, "align-top text-muted whitespace-nowrap")}>{sourceOf(d)}</td>
      <td className={cx(tdClass, "text-right align-top tabular-nums")}>{d.pageCount ?? "–"}</td>
      <td className={cx(tdClass, "align-top whitespace-nowrap")}>
        <span className="flex items-center gap-2">
          <Badge tone={s.tone} dot>{s.label}</Badge>
          {d.status === "failed" && <Button variant="secondary" className="h-6! px-2! text-xs!" onClick={onRetry}>Try again</Button>}
        </span>
      </td>
    </tr>
  );
}

// The date taken, or what's needed instead: a date the transcript states, to confirm with one click, or a
// link to enter it. A date that differs from the transcript's is flagged, since it decides the order.
const smallButton = (variant: "primary" | "secondary") => buttonClass(variant, "h-7! px-2.5! text-xs!");
function SessionDate({ d, onUse }: { d: DepositionRow; onUse: (date: string) => void }) {
  const found = d.dateFound;
  const differs = !!(d.takenOn && found && found.date !== d.takenOn);
  if (d.takenOn && !differs) return <span className="font-medium tabular-nums">{formatDate(d.takenOn)}</span>;
  return (
    <div className="space-y-1.5">
      {d.takenOn ? <span className="block font-medium tabular-nums">{formatDate(d.takenOn)}</span> : null}
      <Badge tone="warn" dot>{d.takenOn ? "Check the date" : "Date needed"}</Badge>
      {found && <span className="block text-xs text-muted">The transcript says {formatDate(found.date)}</span>}
      <span className="flex flex-wrap gap-1.5">
        {found && found.date !== d.takenOn && <button type="button" onClick={() => onUse(found.date)} className={smallButton("primary")}>Use {formatDate(found.date)}</button>}
        <a href={href.deposition(d.id)} className={smallButton("secondary")}>{d.takenOn ? "Edit date" : "Enter date"}</a>
      </span>
    </div>
  );
}

// Above the sessions while any of them needs a date (or has one the transcript contradicts), since no
// check can start without both dates.
function DatesBanner({ depositions, witnesses }: { depositions: DepositionRow[]; witnesses: CaseDetail["witnesses"] }) {
  const missing = depositions.filter((d) => !d.takenOn);
  const differ = depositions.filter((d) => d.takenOn && d.dateFound && d.dateFound.date !== d.takenOn);
  if (missing.length + differ.length === 0) return null;
  const name = (d: DepositionRow) => `${witnesses.find((w) => w.id === d.witnessId)?.name ?? "Witness"}, ${d.originalFilename ?? `deposition #${d.id}`}`;
  return (
    <Alert tone="warn" title={missing.length ? `${missing.length} ${missing.length === 1 ? "session needs" : "sessions need"} a date` : `${differ.length} ${differ.length === 1 ? "date differs" : "dates differ"} from the transcript`}>
      <p>The dates decide which testimony came first, so a check can't start until both sessions have one. Use the date the transcript states, or enter it, in the table below.</p>
      <ul className="mt-1.5 list-disc pl-5">
        {missing.map((d) => <li key={d.id}>{name(d)}: no date{d.dateFound ? ` (the transcript says ${formatDate(d.dateFound.date)})` : ""}</li>)}
        {differ.map((d) => <li key={d.id}>{name(d)}: entered as {formatDate(d.takenOn)}, the transcript says {formatDate(d.dateFound!.date)}</li>)}
      </ul>
    </Alert>
  );
}

// The selection's next step, docked at the bottom of the window so it stays in reach.
function CompareBar({ detail, selected, onClear }: { detail: CaseDetail; selected: number[]; onClear: () => void }) {
  const { start, error, busy } = useStartCheck(detail.case.id);
  const state = checkState(selected, detail.depositions, detail.analyses);
  const estimate = useEstimate(detail.case.id, state.kind === "new" ? state.a : null, state.kind === "new" ? state.b : null);
  const user = useUser();
  const blocked = !user?.emailVerified ? "Verify your email before running checks." : !user.analysisAccess ? NO_ACCESS : null;
  const message = { pick: "Select one more session: of the same witness, or of another witness to compare their accounts.", too_many: "Select exactly two sessions. An analysis compares two.", not_ready: "Both sessions must finish reading first.", no_date: "Add the date of both sessions first. The dates decide which testimony came first." };
  const cross = "cross" in state && state.cross;
  const pair = () => {
    const [a, b] = selected.map((s) => detail.depositions.find((d) => d.id === s)!).sort((x, y) => (x.takenOn ?? "").localeCompare(y.takenOn ?? ""));
    const name = (d: DepositionRow) => detail.witnesses.find((w) => w.id === d.witnessId)?.name;
    return cross ? `${name(a)}, ${formatDate(a.takenOn)}, and ${name(b)}, ${formatDate(b.takenOn)}` : `${name(a)}: ${formatDate(a.takenOn)} and ${formatDate(b.takenOn)}`;
  };
  return (
    <div className="sticky bottom-4 z-20">
      <div aria-live="polite" className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-navy px-5 py-3 text-white shadow-[0_12px_32px_-8px_rgb(19_33_58/0.5)]">
        <div className="min-w-0">
          {state.kind in message ? (
            <p className="text-sm">{message[state.kind as keyof typeof message]}</p>
          ) : (
            <>
              <p className="font-semibold">{pair()}</p>
              <p className="text-sm text-navy-ink">
                {state.kind === "new" && (blocked ?? `${estimateText(estimate)}. Nothing is charged until you start.`)}
                {state.kind === "running" && (cross ? "These witnesses' accounts are being compared now." : "These sessions are being checked now.")}
                {state.kind === "done" && `Already checked on ${formatDate(state.report.createdAt)}.`}
              </p>
            </>
          )}
          {error && <p className="mt-1 text-sm text-[#ffc9c9]">{error}</p>}
        </div>
        <div className="flex flex-none flex-wrap items-center gap-2">
          <button type="button" onClick={onClear} className="flex h-8 items-center gap-1 rounded-md px-2.5 text-sm text-navy-ink hover:bg-navy-2 hover:text-white"><X aria-hidden className="size-4" />Clear</button>
          {state.kind === "new" && !blocked && <button type="button" disabled={busy || estimate?.fits === false} onClick={() => void start(state.a, state.b)} className={buttonClass("secondary", "ring-0!")}>{busy ? "Starting…" : cross ? "Compare these witnesses" : "Check these sessions"}</button>}
          {state.kind === "running" && <a href={href.analysis(state.report.id)} className={buttonClass("secondary", "ring-0!")}>View progress</a>}
          {state.kind === "done" && (
            <>
              <CheckAgain caseId={detail.case.id} a={state.a} b={state.b} cross={cross} />
              <a href={href.analysis(state.report.id)} className={buttonClass("secondary", "ring-0!")}>Open analysis<ArrowRight aria-hidden className="size-4" /></a>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function AnalysesTable({ analyses, caseNames }: { analyses: AnalysisView[]; caseNames?: Map<number, string> }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[52rem] text-sm">
        <thead>
          <tr>
            <th className={thClass}>Compared</th>
            {caseNames && <th className={thClass}>Case</th>}
            <th className={thClass}>Status</th>
            <th className={cx(thClass, "text-right")}>Contradictions</th>
            <th className={cx(thClass, "text-right")}>Need context</th>
            <th className={cx(thClass, "text-right")}>Decided</th>
            <th className={cx(thClass, "text-right")}>Cost</th>
            <th className={cx(thClass, "text-right")}>Checked</th>
          </tr>
        </thead>
        <tbody>
          {analyses.map((r) => {
            const s = ANALYSIS_STATUS[r.status];
            const [a, b] = r.depositions;
            const done = r.status === "completed";
            return (
              <tr key={r.id} className={cx(rowClass, "cursor-pointer")} onClick={(e) => !(e.target as HTMLElement).closest("a") && (window.location.hash = href.analysis(r.id))}>
                <td className={tdClass}>
                  <a href={href.analysis(r.id)} className="font-semibold hover:underline">{analysisTitle(r)}</a>
                  <span className="block text-xs text-muted tabular-nums">{formatDate(a.takenOn)} and {formatDate(b.takenOn)}</span>
                </td>
                {caseNames && <td className={cx(tdClass, "text-muted")}>{caseNames.get(r.caseId) ?? "–"}</td>}
                <td className={tdClass}>
                  <span className="flex items-center gap-1.5">
                    <Badge tone={done ? "good" : s.tone} dot>{isActive(r.status) ? "Checking" : s.label}</Badge>
                    {r.mode === "demo" && <Badge tone="accent">Example</Badge>}
                  </span>
                </td>
                <td className={cx(tdClass, "text-right tabular-nums", done && r.findings.groups.contradictions > 0 && "font-semibold")}>{done ? r.findings.groups.contradictions : "–"}</td>
                <td className={cx(tdClass, "text-right tabular-nums")}>{done ? r.findings.groups.needs_context : "–"}</td>
                <td className={cx(tdClass, "text-right tabular-nums text-muted")}>{done ? `${Math.min(r.findings.decided, r.findings.total)} of ${r.findings.total}` : "–"}</td>
                <td className={cx(tdClass, "text-right tabular-nums text-muted")}>{formatUsd(r.cost.actualUsd)}</td>
                <td className={cx(tdClass, "text-right tabular-nums text-muted whitespace-nowrap")}>{formatDate(r.finishedAt ?? r.createdAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
