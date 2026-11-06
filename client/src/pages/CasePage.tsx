// One case, analyzed in one place: the guided steps (add depositions, choose what to analyze, review the cost, results).
// The sessions by witness are the first step's content; earlier two-session checks are listed below it.

import { useCallback, useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import { ArrowRightLeft, FileText, GripVertical, Pencil } from "lucide-react";
import { CaseAnalysisAction, CaseAnalysisSummary, useCaseAnalysis } from "../components/CaseAnalysis";
import { CaseFindings } from "../components/CaseFindings";
import { CaseRunPanel, useCaseRuns } from "../components/CaseRuns";
import { DangerZone } from "../components/DangerZone";
import { useAddDeposition } from "../components/Shell";
import { Alert, Badge, Breadcrumbs, Button, buttonClass, Card, CardHeader, cx, Dialog, Field, Loading, PageHeader, rowClass, selectClass, tdClass, thClass } from "../components/ui";
import { DateInput } from "../components/DateInput";
import { analysesOf, dateAction, moveTargets } from "../components/sessionActions";
import { api, DEPOSITION_ADDED } from "../lib/api";
import { MOVING_RUN } from "../lib/caseRuns";
import { isActive } from "../lib/insights";
import { analysisTitle, ANALYSIS_STATUS, DEPOSITION_STATUS, formatDate, formatUsd } from "../lib/labels";
import { href, usePoll } from "../lib/router";
import type { AnalysisView, CaseAnalysisView, CaseDetail, DepositionRow } from "../types";

export const sourceOf = (d: Pick<DepositionRow, "scanned" | "originalFilename">) => (/\.txt$/i.test(d.originalFilename ?? "") ? "Text" : d.scanned ? "Scanned PDF" : "PDF");

export function CasePage({ id }: { id: number }) {
  const [detail, setDetail] = useState<CaseDetail | null>(null);
  const [analyses, setAnalyses] = useState<AnalysisView[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Dragging a session onto another witness's card: the row being dragged, the card under it, and the
  // move waiting for confirmation (also opened from the row's Move button).
  const [dragging, setDragging] = useState<DepositionRow | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [move, setMove] = useState<{ d: DepositionRow; to: number | null } | null>(null);
  const add = useAddDeposition();
  const caseAnalysis = useCaseAnalysis(id);
  const runs = useCaseRuns(id);
  const load = useCallback(() => {
    api.case(id)
      .then(async (d) => {
        setDetail(d);
        setAnalyses((await Promise.all(d.analyses.map((a) => api.analysis(a.id)))).map((r) => r.analysis).sort((a, b) => b.id - a.id));
      })
      .catch((e: Error) => setError(e.message));
  }, [id]);
  useEffect(load, [load]);
  // An upload to this case from the Add depositions dialog: reload, so the new sessions show as processing
  // and the poll below follows them until they're ready.
  useEffect(() => {
    const added = (e: Event) => { if ((e as CustomEvent<{ caseId: number }>).detail?.caseId === id) load(); };
    window.addEventListener(DEPOSITION_ADDED, added);
    return () => window.removeEventListener(DEPOSITION_ADDED, added);
  }, [id, load]);
  const busy = !!detail && (detail.depositions.some((d) => d.status === "processing") || detail.analyses.some((a) => isActive(a.status)));
  usePoll(busy, 3000, load);

  if (error) return <Alert title="This case couldn't be loaded">{error}</Alert>;
  if (!detail) return <Loading label="Loading the case" />;
  // Nothing in the case may be deleted from under work in progress: an analysis (preparing or reading), a two-session
  // check, or a deposition still being read. The server refuses a running analysis too.
  const working = (runs.runs ?? []).some((r) => MOVING_RUN.includes(r.status)) ? "an analysis is running"
    : detail.analyses.some((a) => isActive(a.status)) ? "a check is running"
    : detail.depositions.some((d) => d.status === "processing") ? "a deposition is still being read" : null;
  const deleteBlocked = !runs.runs && !runs.error ? "Checking whether this case is being processed…" : working ? `This case can't be deleted while ${working}. Wait for it to finish, or cancel it, then delete the case.` : null;
  // The report covers finished analyses only (api/report.ts), so it is offered once one exists.
  const witnessName = (w: number) => detail.witnesses.find((x) => x.id === w)?.name ?? "Unknown witness";
  const workflowSessions = [...detail.depositions]
    .sort((a, b) => witnessName(a.witnessId).localeCompare(witnessName(b.witnessId)) || (a.takenOn ?? "").localeCompare(b.takenOn ?? ""))
    .map((d) => ({ id: d.id, witness: witnessName(d.witnessId), takenOn: d.takenOn, label: d.originalFilename ?? `Deposition #${d.id}`, status: d.status, fileSha256: d.fileSha256 }));
  const depositionsStep = (
    <div className="space-y-3">
      <DatesBanner depositions={detail.depositions} witnesses={detail.witnesses} onKeep={(ds) => Promise.all(ds.map((d) => api.setDepositionDate(d.id, d.takenOn))).then(load)} />
      {detail.depositions.length === 0 ? (
        <p className="rounded-lg bg-well px-4 py-6 text-center text-sm text-muted">No depositions in this case yet.</p>
      ) : (
        detail.witnesses.filter((w) => w.depositions.length > 0).map((w) => {
          const sessions = detail.depositions.filter((d) => d.witnessId === w.id).sort((a, b) => (a.takenOn ?? "").localeCompare(b.takenOn ?? ""));
          const target = !!dragging && dragging.witnessId !== w.id;
          return (
            <div
              key={w.id}
              onDragOver={(e) => { if (!target) return; e.preventDefault(); e.dataTransfer.dropEffect = "move"; setOver(w.id); }}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setOver((o) => (o === w.id ? null : o)); }}
              onDrop={(e) => { if (!target) return; e.preventDefault(); setMove({ d: dragging, to: w.id }); setDragging(null); setOver(null); }}
            >
            <section aria-label={w.name} className={cx("overflow-hidden rounded-lg border border-line bg-canvas transition-[outline-color] duration-150", target && "outline-2 outline-offset-2 outline-dashed outline-control", over === w.id && "bg-info-bg/40 outline-solid! outline-slate!")}>
              <div className="flex flex-wrap items-baseline justify-between gap-2 px-4 pt-3 pb-1">
                <h4 className="text-sm font-semibold">{w.name} <span className="font-normal text-muted tabular-nums">· {sessions.length} {sessions.length === 1 ? "session" : "sessions"}</span></h4>
                {over === w.id && <Badge tone="active">Drop to file it under {w.name}</Badge>}
              </div>
              {/* relative: keeps the screen-reader "Move" header inside the scroller instead of widening the page */}
              <div className="relative overflow-x-auto">
                <table className="w-full min-w-[44rem] text-sm">
                  <thead>
                    <tr>
                      <th className={cx(thClass, "w-8")}><span className="sr-only">Move by dragging</span></th>
                      <th className={thClass}>Date taken</th>
                      <th className={thClass}>File</th>
                      <th className={thClass}>Source</th>
                      <th className={cx(thClass, "text-right")}>Pages</th>
                      <th className={thClass}>Status</th>
                      <th className={cx(thClass, "w-0")}><span className="sr-only">Move</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sessions.map((d) => (
                      <SessionRow
                        key={d.id}
                        d={d}
                        witness={w.name}
                        onRetry={() => api.retryDeposition(d.id).then(load).catch((e: Error) => setError(e.message))}
                        onUseDate={(date) => api.setDepositionDate(d.id, date).then(load)}
                        movable={moveTargets(detail.witnesses, w.id).length > 0}
                        onDragStart={() => setDragging(d)}
                        onDragEnd={() => { setDragging(null); setOver(null); }}
                        onMove={() => setMove({ d, to: null })}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            </div>
          );
        })
      )}
    </div>
  );

  const toDecide = Math.max(analyses.reduce((n, r) => n + r.findings.groups.contradictions + r.findings.groups.needs_context - r.findings.decided, 0), 0);
  const summary = [`${detail.witnesses.length} ${detail.witnesses.length === 1 ? "witness" : "witnesses"}`, `${detail.depositions.length} ${detail.depositions.length === 1 ? "deposition" : "depositions"}`, ...(analyses.length > 0 ? [`${analyses.length} earlier ${analyses.length === 1 ? "check" : "checks"}`] : []), ...(toDecide > 0 ? [`${toDecide} ${toDecide === 1 ? "finding" : "findings"} to decide`] : [])].join(" · ");

  return (
    <>
      <PageHeader
        above={<Breadcrumbs items={[{ label: "Cases", href: href.cases() }]} />}
        title={detail.case.name}
        description={summary}
        actions={<>{caseAnalysis && <CaseAnalysisAction caseId={id} detail={detail} analysis={caseAnalysis} />}{detail.analyses.some((a) => a.status === "completed") && <a href={href.report(id)} className={buttonClass("secondary")}><FileText aria-hidden className="size-4" />Export report</a>}</>}
      />

      <CaseRunPanel caseId={id} sessions={workflowSessions} depositions={depositionsStep} onAdd={() => add.open(id)} state={runs} />

      <CaseAnalysisSummary caseId={id} analysis={caseAnalysis} />

      <CaseFindings analyses={analyses} />

      {(analyses.length > 0 || caseAnalysis) && (
        <Card className="overflow-hidden">
          <CardHeader title="Earlier two-session checks" count={analyses.length + (caseAnalysis ? 1 : 0)} description="Checks of two sessions made before the guided analysis. They stay available here." />
          <AnalysesTable analyses={analyses} caseRows={caseAnalysis ? [{ caseId: id, analysis: caseAnalysis }] : []} />
        </Card>
      )}

      <DangerZone
        what="case"
        name={detail.case.name}
        typeToConfirm
        blocked={deleteBlocked}
        consequence={`Deletes the case, its ${detail.depositions.length} ${detail.depositions.length === 1 ? "deposition" : "depositions"} and ${analyses.length} ${analyses.length === 1 ? "analysis" : "analyses"}, with every finding, decision and note. Cost records are kept.`}
        onDelete={async () => {
          await api.deleteCase(id);
          window.location.hash = href.cases();
        }}
      />

      {move && (
        <MoveDialog
          d={move.d}
          initial={move.to}
          caseId={id}
          targets={moveTargets(detail.witnesses, move.d.witnessId)}
          analyses={analysesOf(detail.analyses, move.d.id)}
          onClose={() => setMove(null)}
          onMoved={() => { setMove(null); load(); }}
        />
      )}

    </>
  );
}

function SessionRow({ d, onRetry, onUseDate, movable, onDragStart, onDragEnd, onMove }: { d: DepositionRow; witness: string; onRetry: () => void; onUseDate: (date: string) => Promise<void>; movable: boolean; onDragStart: () => void; onDragEnd: () => void; onMove: () => void }) {
  const s = DEPOSITION_STATUS[d.status];
  const name = d.originalFilename ?? `Deposition #${d.id}`;
  const note = d.status === "failed" || d.status === "unsupported" ? `Couldn't be read: ${d.error ?? "this file's layout isn't recognized."}` : d.status === "needs_review" ? (d.error ?? "Some pages couldn't be read.") : d.scanned ? "Scanned copy. Compare quotations with the page image." : null;
  const action = dateAction(d);
  return (
    <tr
      className={cx(rowClass, action && "bg-context-bg/50 hover:bg-context-bg")}
    >
      <td className={cx(tdClass, "align-top")}>
        <span className="flex items-center gap-1">
          {/* Only the grip drags (showing the whole row), so the row's links and date boxes behave as usual. */}
          {movable && (
            <span
              aria-hidden
              draggable
              title="Drag onto another witness"
              onDragStart={(e) => { const row = e.currentTarget.closest("tr")!; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", name); e.dataTransfer.setDragImage(row, 16, 16); onDragStart(); }}
              onDragEnd={onDragEnd}
              className="-my-1 -ml-4 flex-none cursor-grab rounded px-0.5 py-1 text-faint hover:bg-rule hover:text-ink active:cursor-grabbing"
            >
              <GripVertical className="size-4" strokeWidth={1.75} />
            </span>
          )}
        </span>
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
      <td className={cx(tdClass, "align-top")}>
        {movable && <Button variant="ghost" className="h-7! px-2! text-xs! text-muted!" title="Move to another witness" aria-label={`Move ${name} to another witness`} onClick={onMove}><ArrowRightLeft aria-hidden className="size-3.5" />Move</Button>}
      </td>
    </tr>
  );
}

// The date taken, or what's needed instead: a date the transcript states, to confirm with one click, or a
// date to enter in place. A date that differs from the transcript's is flagged, since it decides the order.
const smallButton = (variant: "primary" | "secondary" | "ghost") => buttonClass(variant, "h-7! px-2.5! text-xs!");
function SessionDate({ d, onUse }: { d: DepositionRow; onUse: (date: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const found = d.dateFound;
  const action = dateAction(d);
  // A failed save stays in this cell, with the editor open, so the rest of the case stays on screen.
  const save = (date: string) => {
    setBusy(true);
    setProblem(null);
    onUse(date).then(() => setEditing(false), (e: Error) => setProblem(e.message)).finally(() => setBusy(false));
  };
  const error = problem && <span role="alert" className="block max-w-52 text-xs text-conflict">{problem}</span>;
  const edit = () => { setValue(d.takenOn ?? found?.date ?? ""); setEditing(true); };

  if (editing) {
    const submit = (e: FormEvent) => { e.preventDefault(); if (value && !busy) save(value); };
    const escape = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) { e.preventDefault(); setEditing(false); } };
    return (
      <form onSubmit={submit} onKeyDown={escape} aria-label="Date taken" className="w-52 space-y-1.5">
        <fieldset disabled={busy} className="contents"><DateInput value={value} onChange={setValue} /></fieldset>
        <span className="flex gap-1.5">
          <button type="submit" disabled={!value || busy} className={smallButton("primary")}>{busy ? "Saving…" : "Save"}</button>
          <button type="button" disabled={busy} onClick={() => { setEditing(false); setProblem(null); }} className={smallButton("secondary")}>Cancel</button>
        </span>
        {error}
      </form>
    );
  }
  if (!action) {
    return (
      <span className="group flex items-center gap-1">
        <span className="font-medium tabular-nums">{formatDate(d.takenOn)}</span>
        <button type="button" onClick={edit} aria-label={`Edit the date, ${formatDate(d.takenOn)}`} title="Edit date" className="rounded p-1 text-faint opacity-60 hover:bg-rule hover:text-ink group-hover:opacity-100 focus-visible:opacity-100"><Pencil aria-hidden className="size-3.5" /></button>
      </span>
    );
  }
  return (
    <div className="space-y-1.5">
      {d.takenOn ? <span className="block font-medium tabular-nums">{formatDate(d.takenOn)}</span> : null}
      <Badge tone="warn" dot>{action === "differs" ? "Check the date" : "Date needed"}</Badge>
      {found && <span className="block text-xs text-muted">The transcript says {formatDate(found.date)}</span>}
      <span className="flex flex-wrap gap-1.5">
        {found && <button type="button" disabled={busy} onClick={() => save(found.date)} className={smallButton("primary")}>{busy ? "Saving…" : `Use ${formatDate(found.date)}`}</button>}
        {action === "differs" && <button type="button" disabled={busy} onClick={() => save(d.takenOn!)} className={smallButton("secondary")}>Keep {formatDate(d.takenOn)}</button>}
        <button type="button" disabled={busy} onClick={edit} className={smallButton(found ? "ghost" : "primary")}>{d.takenOn ? "Edit date" : "Enter date"}</button>
      </span>
      {error}
    </div>
  );
}

// Above the sessions while any of them needs a date (or has one the transcript contradicts), since no
// check can start without both dates.
// onKeep: the person keeps the dates they entered; each is saved as confirmed, so the banner doesn't come back.
function DatesBanner({ depositions, witnesses, onKeep }: { depositions: DepositionRow[]; witnesses: CaseDetail["witnesses"]; onKeep: (ds: DepositionRow[]) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const missing = depositions.filter((d) => dateAction(d) === "missing");
  const differ = depositions.filter((d) => dateAction(d) === "differs");
  if (missing.length + differ.length === 0) return null;
  const name = (d: DepositionRow) => `${witnesses.find((w) => w.id === d.witnessId)?.name ?? "Witness"}, ${d.originalFilename ?? `deposition #${d.id}`}`;
  return (
    <Alert
      tone="warn"
      title={missing.length ? `${missing.length} ${missing.length === 1 ? "session needs" : "sessions need"} a date` : `${differ.length} ${differ.length === 1 ? "date differs" : "dates differ"} from the transcript`}
      action={missing.length === 0 ? <Button variant="secondary" disabled={busy} onClick={() => { setBusy(true); setProblem(null); onKeep(differ).catch((e: Error) => setProblem(e.message)).finally(() => setBusy(false)); }}>{busy ? "Saving…" : differ.length === 1 ? "Keep the entered date" : "Keep the entered dates"}</Button> : undefined}
    >
      <p>The dates decide which testimony came first, so a check can't start until both sessions have one. In the highlighted rows below, use the date the transcript states or enter it.</p>
      <ul className="mt-1.5 list-disc pl-5">
        {missing.map((d) => <li key={d.id}>{name(d)}: <strong className="font-semibold">Date needed</strong>{d.dateFound ? ` (the transcript says ${formatDate(d.dateFound.date)})` : ""}</li>)}
        {differ.map((d) => <li key={d.id}>{name(d)}: <strong className="font-semibold">Check the date</strong>, entered as {formatDate(d.takenOn)}, the transcript says {formatDate(d.dateFound!.date)}</li>)}
      </ul>
      {problem && <p role="alert" className="mt-1.5 text-conflict">{problem}</p>}
    </Alert>
  );
}

// Files a session under another witness of the case, after saying what that costs: the file is read again
// there, and the analyses that compared it are deleted. Opened by a drop on a witness's card (target
// chosen) or by the row's Move button (target picked here).
function MoveDialog({ d, initial, caseId, targets, analyses, onClose, onMoved }: { d: DepositionRow; initial: number | null; caseId: number; targets: CaseDetail["witnesses"]; analyses: number; onClose: () => void; onMoved: () => void }) {
  const [to, setTo] = useState(initial ?? targets[0]?.id);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const witness = targets.find((w) => w.id === to);
  const name = d.originalFilename ?? `Deposition #${d.id}`;
  const confirm = async (e: FormEvent) => {
    e.preventDefault();
    if (!witness) return;
    setBusy(true);
    try {
      await api.moveDeposition(d.id, caseId, witness.name);
      onMoved();
    } catch (err) {
      setProblem((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} title="Move to another witness" description={name} size="md">
      <form onSubmit={confirm} className="space-y-4 px-6 py-5">
        <Field label="Witness" htmlFor="move-to">
          <select id="move-to" autoFocus className={cx(selectClass, "w-full")} value={to} onChange={(e) => setTo(Number(e.target.value))} disabled={busy}>
            {targets.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </Field>
        {witness && (
          <Alert tone={analyses > 0 ? "warn" : "info"}>
            The deposition will be filed under {witness.name} and read again from its stored file; its date is kept.
            {analyses > 0 && ` ${analyses} ${analyses === 1 ? "analysis" : "analyses"} that compared it will be deleted, with their findings and decisions.`}
          </Alert>
        )}
        {problem && <Alert title="This deposition couldn't be moved">{problem}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!witness || busy}>{busy ? "Moving…" : `Move to ${witness?.name ?? "witness"}`}</Button>
        </div>
      </form>
    </Dialog>
  );
}

// The selection's next step, docked at the bottom of the window so it stays in reach.
// A case's stored whole-case analysis, listed with the pair analyses (hand-authored example; no model run).
export type CaseAnalysisRow = { caseId: number; analysis: CaseAnalysisView };

export function AnalysesTable({ analyses, caseNames, caseRows = [] }: { analyses: AnalysisView[]; caseNames?: Map<number, string>; caseRows?: CaseAnalysisRow[] }) {
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
          {caseRows.map(({ caseId, analysis: c }) => (
            <tr key={`case-${caseId}`} className={cx(rowClass, "cursor-pointer")} onClick={(e) => !(e.target as HTMLElement).closest("a") && (window.location.hash = href.caseAnalysis(caseId))}>
              <td className={tdClass}>
                <a href={href.caseAnalysis(caseId)} className="font-semibold hover:underline">Whole case</a>
                <span className="block text-xs text-muted tabular-nums">{c.coverage.sessions_total} sessions, {c.coverage.witnesses_total} witnesses · {c.coverage.pairs_complete} of {c.coverage.unique_pairs_total} pairs</span>
              </td>
              {caseNames && <td className={cx(tdClass, "text-muted")}>{caseNames.get(caseId) ?? "–"}</td>}
              <td className={tdClass}><span className="flex items-center gap-1.5"><Badge tone="good" dot>Complete</Badge><Badge tone="accent">Example</Badge></span></td>
              <td className={cx(tdClass, "text-right tabular-nums font-semibold")}>{c.coverage.findings_by_classification.incompatible ?? 0}</td>
              <td className={cx(tdClass, "text-right tabular-nums")}>{c.coverage.findings_by_classification.uncertain ?? 0}</td>
              <td className={cx(tdClass, "text-right tabular-nums text-muted")}>–</td>
              <td className={cx(tdClass, "text-right tabular-nums text-muted")}>{formatUsd(c.execution.cost_usd)}</td>
              <td className={cx(tdClass, "text-right tabular-nums text-muted")}>–</td>
            </tr>
          ))}
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
