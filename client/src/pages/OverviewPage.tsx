// Overview: a welcome, the one thing to do next, and what's happened. It always has a complete
// shape: a new account sees a short getting-started list and a preview of a finding; a busy one sees
// what is waiting for a decision; a caught-up one is told so, with where to go.

import type { ReactNode } from "react";
import { ArrowLeftRight, ArrowRight, Check, CircleCheck, FileText, FileUp, Highlighter, ListChecks, Download } from "lucide-react";
import { useAddDeposition } from "../components/Shell";
import { Alert, Badge, buttonClass, Card, CardHeader, cx, Loading, rowClass, Strength, tdClass, thClass } from "../components/ui";
import { shortRef } from "../components/FindingParts";
import { nextStep, recentActivity, relativeTime, type NextStep } from "../lib/insights";
import { DEPOSITION_STATUS, formatDate } from "../lib/labels";
import { decisionShown } from "../lib/findingFilters";
import { headline } from "./FindingsPage";
import { href } from "../lib/router";
import { useGuest, useUser } from "../lib/session";
import { useWorkspace, type Workspace } from "../lib/workspace";
import type { WorkspaceFinding } from "../types";
import { runTitle } from "../components/CaseRuns";
import { EXECUTION, MOVING_RUN, RUN_STATUS } from "../lib/caseRuns";

const RANK = { high: 0, medium: 1, needs_context: 2, low: 3, unverified: 4 } as const;
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const greeting = () => {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
};

export function OverviewPage() {
  const { data, error } = useWorkspace();
  const findings = data?.findings ?? null;
  const user = useUser();
  const first = user?.name.trim().split(/\s+/)[0] ?? "";

  if (error) return <Alert title="The overview couldn't be loaded">{error}</Alert>;
  if (!data || findings === null) return <><Welcome first={first} line="Getting your cases ready…" /><Loading inline label="Loading your cases" /></>;

  // In each analysis's own (retrieval) order, highest priority first.
  const waiting = findings.filter((f) => (f.lane === "contradictions" || f.lane === "needs_context") && decisionShown(f) === "unreviewed").sort((a, b) => (RANK[a.priority as keyof typeof RANK] ?? 9) - (RANK[b.priority as keyof typeof RANK] ?? 9));
  // A finding that needs revalidation has no current decision, whatever was decided before.
  const kept = findings.filter((f) => decisionShown(f) === "confirmed");
  const decided = findings.filter((f) => !["unreviewed", "quarantined"].includes(decisionShown(f)));
  const work = workInProgress(data);
  const analysesRunning = data.caseRuns.filter((r) => MOVING_RUN.includes(r.status)).length;
  const depositions = data.details.flatMap((d) => d.depositions.map((x) => ({ ...x, caseName: d.case.name, witness: d.witnesses.find((w) => w.id === x.witnessId)?.name ?? "Unknown witness" })));
  const failed = depositions.filter((d) => d.status === "failed" || d.status === "unsupported" || d.status === "needs_review");
  const step = nextStep(data.details, waiting, kept);

  // Where things stand, in one sentence.
  const line = depositions.length === 0
    ? "Veridict reads every session of a witness's deposition and shows where the testimony may conflict, cited to page and line."
    : waiting.length
      ? `${plural(waiting.length, "finding")} ${waiting.length === 1 ? "is" : "are"} waiting for your decision.`
      : analysesRunning
        ? `${plural(analysesRunning, "analysis", "analyses")} ${analysesRunning === 1 ? "is" : "are"} running. Nothing needs you right now.`
        : "You're all caught up. Nothing is waiting for your decision.";

  const checklist = [
    { label: "Add a deposition", done: depositions.length > 0 },
    { label: "Add a second session of the same witness", done: data.details.some((d) => d.witnesses.some((w) => d.depositions.filter((x) => x.witnessId === w.id).length >= 2)) },
    { label: "Analyze the case", done: data.details.some((d) => d.runs.length > 0) },
    { label: "Decide on a finding", done: decided.length > 0 },
  ];
  const starting = checklist.some((c) => !c.done);

  return (
    <>
      <Welcome first={first} line={line} step={<NextStepCard step={step} />} stats={depositions.length > 0 ? [
        ["Waiting for you", waiting.length, waiting.length > 0],
        ["Kept for follow-up", kept.length, false],
        ["Analyses running", analysesRunning, false],
        ["Depositions", depositions.length, false],
      ] : undefined} />

      {failed.length > 0 && (
        <Alert tone="warn" title={`${plural(failed.length, "deposition")} couldn't be read in full`} action={<a href={href.deposition(failed[0].id)} className={buttonClass("secondary")}>Open</a>}>
          {failed[0].witness}, {formatDate(failed[0].takenOn)}: {DEPOSITION_STATUS[failed[0].status].label.toLowerCase()}.
        </Alert>
      )}

      {work.length > 0 && <InProgress work={work} />}

      <div className="grid grid-cols-1 items-start gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-6">
          {starting && <GettingStarted items={checklist} />}
          {depositions.length === 0 ? <Preview /> : <Waiting waiting={waiting} kept={kept.length} />}
        </div>
        <Activity details={data.details} />
      </div>

      {data.cases.length > 0 && <CasesTable cases={data.cases} work={work} />}
    </>
  );
}

function Welcome({ first, line, step, stats }: { first: string; line: string; step?: ReactNode; stats?: [string, number, boolean][] }) {
  const today = new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
  // Lighter on the left than the sidebar's navy, so the open sidebar never blends into it.
  return (
    <section className="overflow-hidden rounded-xl bg-linear-to-r from-navy-2 to-navy text-white">
      <div className="grid gap-6 px-6 py-7 sm:px-8 lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-center">
        <div>
          <p className="text-sm text-navy-ink">{today}</p>
          <h1 className="mt-1 font-serif text-[30px] leading-9 font-semibold tracking-[-0.015em]">{greeting()}{first ? `, ${first}` : ""}.</h1>
          <p className="mt-2 max-w-xl text-[15px] leading-6 text-navy-ink">{line}</p>
        </div>
        {step}
      </div>
      {stats && (
        <dl className="grid grid-cols-2 border-t border-white/10 sm:grid-cols-4">
          {stats.map(([label, value, alert], i) => (
            <div key={label} className={cx("px-6 py-4 sm:px-8", i > 0 && "sm:border-l sm:border-white/10", i % 2 === 1 && "max-sm:border-l max-sm:border-white/10", i > 1 && "max-sm:border-t max-sm:border-white/10")}>
              <dt className="text-xs text-navy-ink">{label}</dt>
              <dd className={cx("mt-0.5 text-xl font-semibold tabular-nums", alert ? "text-[#f4d77a]" : "text-white")}>{value}</dd>
            </div>
          ))}
        </dl>
      )}
    </section>
  );
}

// The next step as a card with one button.
function NextStepCard({ step }: { step: NextStep }) {
  const add = useAddDeposition();
  const button = "inline-flex h-9 items-center gap-1.5 rounded-md bg-white px-3.5 text-sm font-semibold text-navy hover:bg-[#e6ebf3]";
  const go = (to: string, label: string) => <a href={to} className={button}>{label}<ArrowRight aria-hidden className="size-4" /></a>;
  const guest = useGuest(); // the read-only demo: nothing to upload
  const upload = (label: string, caseId?: number) => guest ? null : <button type="button" onClick={() => add.open(caseId)} className={button}><FileUp aria-hidden className="size-4" />{label}</button>;
  const content: { title: string; text: string; action: ReactNode; icon: ReactNode } = (() => {
    switch (step.kind) {
      case "first_deposition": return { icon: <FileUp className="size-5" />, title: "Add your first deposition", text: "A PDF, a text file, or pasted text. Start with one session of a witness.", action: upload("Add deposition") };
      case "second_session": return { icon: <FileUp className="size-5" />, title: `Add another session of ${step.witness}`, text: "An analysis compares testimony across sessions.", action: upload("Add deposition", step.caseId) };
      case "reading": return { icon: <FileText className="size-5" />, title: `Reading ${plural(step.count, "deposition")}`, text: "Veridict is turning them into page and line references. Scans take a few minutes.", action: go(href.deposition(step.depositionId), "See progress") };
      case "check": return { icon: <ListChecks className="size-5" />, title: `Analyze ${step.caseName}`, text: "Its sessions are ready to compare. You'll see the estimated cost before anything starts.", action: go(href.case(step.caseId), "Open the case") };
      case "case_running": return { icon: <ListChecks className="size-5" />, title: `${step.caseName} is being analyzed`, text: "Veridict runs one analysis at a time. Its findings appear as it reads; you can keep working.", action: go(href.case(step.caseId), "View progress") };
      case "decide": return { icon: <Highlighter className="size-5" />, title: `Review ${plural(step.count, "finding")}`, text: "Read both passages side by side and decide: Keep, Needs context or Dismiss.", action: go(href.caseRun(step.runId), "Start reviewing") };
      case "export": return { icon: <Download className="size-5" />, title: `Export the ${step.caseName} report`, text: "Every finding you kept, with citations and your notes, ready to download as a PDF.", action: go(href.caseRun(step.runId), "Open the analysis") };
      case "more": return { icon: <FileUp className="size-5" />, title: "Add more testimony", text: "Add another session or witness to keep checking.", action: upload("Add deposition") };
    }
  })();
  return (
    <div className="rounded-lg bg-navy-2 p-5 ring-1 ring-white/10">
      <p className="flex items-center gap-2 text-xs font-medium text-navy-ink"><span aria-hidden className="text-[#8ea3c0]">{content.icon}</span>Next step</p>
      <p className="mt-2 text-lg font-semibold">{content.title}</p>
      <p className="mt-1 text-sm leading-5 text-navy-ink">{content.text}</p>
      <div className="mt-4">{content.action}</div>
    </div>
  );
}

function GettingStarted({ items }: { items: { label: string; done: boolean }[] }) {
  const done = items.filter((i) => i.done).length;
  return (
    <Card>
      <CardHeader title="Getting started" action={<span className="text-sm text-muted tabular-nums">{done} of {items.length} done</span>} />
      <div aria-hidden className="mx-5 mt-4 h-1.5 overflow-hidden rounded-full bg-rule"><div className="h-full rounded-full bg-ok transition-[width]" style={{ width: `${(done / items.length) * 100}%` }} /></div>
      <ol className="space-y-1 px-5 py-4">
        {items.map((it) => (
          <li key={it.label} className="flex items-center gap-3 py-1.5">
            <span aria-hidden className={cx("flex size-5 flex-none items-center justify-center rounded-full", it.done ? "bg-ok text-white" : "ring-1 ring-inset ring-control")}>{it.done && <Check className="size-3" strokeWidth={3} />}</span>
            <span className={cx("text-[15px]", it.done && "text-muted line-through decoration-line")}>{it.label}</span>
            <span className="sr-only">{it.done ? "(done)" : "(to do)"}</span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

// For a new account: what a finding looks like, from the real app.
function Preview() {
  return (
    <Card className="overflow-hidden">
      <CardHeader title="What you'll get" description="Each finding shows both passages side by side, cited to page and line, with the lines that may conflict highlighted." />
      <img src="/landing/hero-analysis.png" width={2880} height={1800} alt="An example finding in Veridict: two sessions of a synthetic deposition side by side, the conflicting lines highlighted." className="w-full border-t border-rule" loading="lazy" />
    </Card>
  );
}

function Waiting({ waiting, kept }: { waiting: WorkspaceFinding[]; kept: number }) {
  return (
    <Card>
      <CardHeader title="Waiting for your decision" count={waiting.length} action={<a href={href.findings()} className="text-sm font-medium text-info hover:underline">All findings</a>} />
      {waiting.length === 0 ? (
        <div className="flex flex-col items-center px-6 py-10 text-center">
          <span aria-hidden className="flex size-12 items-center justify-center rounded-full bg-ok-bg text-ok"><CircleCheck className="size-6" strokeWidth={1.75} /></span>
          <p className="mt-3 text-md font-semibold">You're all caught up</p>
          <p className="mt-1 max-w-sm text-sm text-muted">{kept > 0 ? `You've kept ${plural(kept, "finding")} for follow-up. New analyses will add their findings here.` : "New analyses will add their findings here."}</p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <a href={href.findings()} className={buttonClass("secondary")}>Review past findings</a>
            <a href={href.cases()} className={buttonClass("ghost")}>Go to cases</a>
          </div>
        </div>
      ) : (
        <ol>{waiting.slice(0, 6).map((f) => <WaitingRow key={f.id} f={f} />)}</ol>
      )}
      {waiting.length > 6 && <a href={href.findings()} className="flex h-11 items-center justify-center gap-1.5 border-t border-rule text-sm font-medium text-ink hover:bg-hover">View all {waiting.length}<ArrowRight aria-hidden className="size-4" /></a>}
    </Card>
  );
}

function WaitingRow({ f }: { f: WorkspaceFinding }) {
  return (
    <li className="border-t border-rule first:border-t-0">
      <a href={href.caseRun(f.runId)} className="group grid grid-cols-1 items-start gap-x-4 gap-y-1.5 px-5 py-3.5 hover:bg-hover sm:grid-cols-[1fr_auto]">
        <span className="line-clamp-2 min-w-0 font-medium leading-5 group-hover:underline">{f.explanation ?? headline(f)}</span>
        <span className="flex items-center gap-2">
          {f.lane !== "compatible" && <Strength score={f.score} />}
          <Badge tone={f.lane === "contradictions" ? (f.priority === "high" ? "contradiction" : "neutral") : "warn"}>{f.lane === "contradictions" ? (f.priority === "high" ? "High priority" : headline(f)) : "Needs context"}</Badge>
        </span>
        <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted sm:col-span-2">
          <span>{f.runName ?? "Whole-case analysis"}</span>
          <span aria-hidden>·</span>
          <span className="truncate">{f.caseName}</span>
          <span aria-hidden>·</span>
          <span className="flex items-center gap-1.5 font-mono text-[12px]">{shortRef(f.a.range)}<ArrowLeftRight aria-hidden className="size-3 text-faint" />{shortRef(f.b.range)}</span>
        </span>
      </a>
    </li>
  );
}

function Activity({ details }: { details: Parameters<typeof recentActivity>[0] }) {
  const items = recentActivity(details, { case: href.case, caseRun: href.caseRun }, 7);
  const now = Date.now();
  return (
    <Card>
      <CardHeader title="Recent activity" />
      {items.length === 0 ? (
        <div className="px-5 py-4 text-sm">
          <p className="text-muted">Your cases, uploads and analyses will appear here. Until then, how a review works:</p>
          <ol className="mt-3 space-y-3">
            {[["Add", "every session of the case, as PDF or text."], ["Analyze", "the case. You see the cost first."], ["Review", "each finding side by side, and decide."], ["Export", "what you kept, with citations and notes."]].map(([verb, rest]) => (
              <li key={verb} className="flex gap-2.5"><span aria-hidden className="mt-1.5 size-1.5 flex-none rounded-full bg-slate" /><span><strong className="font-semibold">{verb}</strong> {rest}</span></li>
            ))}
          </ol>
          <a href={href.help()} className="mt-4 inline-flex items-center gap-1 font-medium text-info hover:underline">Read the guide<ArrowRight aria-hidden className="size-3.5" /></a>
        </div>
      ) : (
        <ol className="px-5 py-4">
          {items.map((a, i) => (
            <li key={a.key} className="relative grid grid-cols-[1.25rem_1fr] gap-3 pb-4 last:pb-1">
              {i < items.length - 1 && <span aria-hidden className="absolute top-5 bottom-0 left-[9px] w-px bg-line" />}
              <span aria-hidden className={cx("mt-1 size-[11px] justify-self-center rounded-full ring-2 ring-sheet", a.kind === "analysis" ? "bg-slate" : a.kind === "deposition" ? "bg-control" : "bg-navy")} />
              <a href={a.link} className="group min-w-0">
                <span className="block text-sm font-medium group-hover:underline">{a.title}</span>
                <span className="block truncate text-xs text-muted">{a.subject}</span>
                <span className="block text-xs text-faint">{relativeTime(a.at, now)}</span>
              </a>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

function CasesTable({ cases, work }: { cases: { id: number; name: string; witnessNames: string[]; depositions: number; needsReview: number; lastActivity: string }[]; work: Work[] }) {
  const now = Date.now();
  return (
    <Card className="overflow-hidden">
      <CardHeader title="Cases" count={cases.length} action={<a href={href.cases()} className="text-sm font-medium text-info hover:underline">All cases</a>} />
      <div className="overflow-x-auto">
        <table className="w-full min-w-[40rem] text-sm">
          <thead><tr><th className={thClass}>Case</th><th className={thClass}>Witnesses</th><th className={thClass}>Status</th><th className={cx(thClass, "text-right")}>Depositions</th><th className={cx(thClass, "text-right")}>To decide</th><th className={cx(thClass, "text-right")}>Last activity</th></tr></thead>
          <tbody>
            {cases.slice(0, 5).map((c) => (
              <tr key={c.id} className={rowClass}>
                <td className={tdClass}><a href={href.case(c.id)} className="font-medium hover:underline">{c.name}</a></td>
                <td className={cx(tdClass, "text-muted")}>{c.witnessNames.join(", ") || "–"}</td>
                <td className={tdClass}>{(() => { const w = work.find((x) => x.caseId === c.id); return w ? <Badge tone="active" dot>{w.kind === "reading" ? "Reading depositions" : "Being analyzed"}</Badge> : <span className="text-faint">–</span>; })()}</td>
                <td className={cx(tdClass, "text-right tabular-nums")}>{c.depositions}</td>
                <td className={cx(tdClass, "text-right tabular-nums", c.needsReview > 0 && "font-semibold text-conflict")}>{c.needsReview}</td>
                <td className={cx(tdClass, "text-right text-muted tabular-nums")}>{relativeTime(c.lastActivity, now)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// What is being processed right now, case by case: an analysis reading the testimony (with how far it has got), or
// depositions still being read. Computed from the workspace's own rows.
type Work = { key: string; caseId: number; caseName: string; kind: "analysis" | "reading"; title: string; status: string; detail: string; pct: number | null; link: string };
function workInProgress(data: Workspace): Work[] {
  const name = new Map(data.cases.map((c) => [c.id, c.name]));
  const runs: Work[] = (data.caseRuns ?? []).filter((r) => MOVING_RUN.includes(r.status)).map((r) => ({
    key: `run-${r.id}`, caseId: r.caseId, caseName: name.get(r.caseId) ?? "Case", kind: "analysis", title: runTitle(r), status: RUN_STATUS[r.status].label,
    detail: `${EXECUTION[r.execution].label} · ${r.packets.adjudicated.toLocaleString()} of ${r.packets.total.toLocaleString()} evidence packets read`,
    pct: r.status === "adjudicating" && r.packets.total ? Math.min(100, Math.floor((r.packets.adjudicated / r.packets.total) * 100)) : null, link: href.case(r.caseId),
  }));
  const reading: Work[] = data.details.flatMap((d) => {
    const n = d.depositions.filter((x) => x.status === "processing").length;
    return n ? [{ key: `reading-${d.case.id}`, caseId: d.case.id, caseName: d.case.name, kind: "reading" as const, title: `Reading ${plural(n, "deposition")}`, status: "Reading", detail: "Turning each page into page and line references", pct: null, link: href.case(d.case.id) }] : [];
  });
  return [...runs, ...reading];
}

function InProgress({ work }: { work: Work[] }) {
  return (
    <Card>
      <CardHeader title="In progress" count={work.length} description="Cases being processed right now. Each keeps running on the server; you can leave this page." />
      <ul>
        {work.map((w) => (
          <li key={w.key} className="border-t border-rule first:border-t-0">
            <a href={w.link} className="group grid grid-cols-1 items-center gap-x-6 gap-y-2 px-5 py-3.5 hover:bg-hover sm:grid-cols-[minmax(0,1fr)_16rem]">
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold group-hover:underline">{w.caseName}</span>
                  <Badge tone="active" dot>{w.status}</Badge>
                </span>
                <span className="mt-0.5 block truncate text-sm text-muted">{w.title} · {w.detail}</span>
              </span>
              <span className="flex items-center gap-3 text-xs text-muted tabular-nums">
                <span aria-hidden className="relative block h-1.5 flex-1 overflow-hidden rounded-full bg-rule">
                  {w.pct === null ? <span className="progress-sweep absolute inset-y-0 left-0 w-1/3 rounded-full bg-slate" /> : <span className="block h-full rounded-full bg-navy transition-[width] duration-700" style={{ width: `${Math.max(w.pct, 2)}%` }} />}
                </span>
                <span className="w-16 text-right">{w.pct === null ? "Working" : `${w.pct}% read`}</span>
                <ArrowRight aria-hidden className="size-4 flex-none text-faint group-hover:text-ink" />
              </span>
            </a>
          </li>
        ))}
      </ul>
    </Card>
  );
}
