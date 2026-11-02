// A running check, shown as it happens: each stage with its state and time, a clock that keeps
// moving, what is being read, and the reminder that the check keeps going if you leave.

import { useEffect, useState } from "react";
import { Check, Clock } from "lucide-react";
import { formatUsd } from "../lib/labels";
import { href } from "../lib/router";
import type { AnalysisView } from "../types";
import { buttonClass, Button, cx } from "./ui";

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
};
const time = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "");

export function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active]);
  return now;
}

export function CheckProgress({ analysis, pages, lines, onCancel }: { analysis: AnalysisView; pages: number | null; lines: number | null; onCancel: () => void }) {
  const now = useNow(true);
  const started = new Date(analysis.startedAt ?? analysis.createdAt).getTime();
  const attempt = analysis.discovery?.attempts.at(-1);
  const sent = !!attempt && attempt.status !== "submitting";
  const answered = attempt?.status === "succeeded";
  const backup = attempt?.role === "fallback";
  // Where the check is, from its status and its model request.
  const stage = analysis.status === "queued" ? 0 : analysis.status === "parsing" ? 1 : !sent ? 1 : !answered ? 2 : 3;
  const [a, b] = analysis.depositions;
  const stages = [
    { title: "Check started", detail: `${a.witness}: two sessions, queued at ${time(analysis.createdAt)}.` },
    { title: "Preparing both transcripts", detail: pages ? `${pages.toLocaleString()} pages${lines ? `, ${lines.toLocaleString()} lines` : ""} with their page and line numbers.` : "Gathering every line with its page and line number." },
    { title: "Reading both sessions in full", detail: backup ? "The first reading couldn't finish, so a second one is running." : "Every answer in one session is compared with the other. This is the long part, usually 4 to 10 minutes." },
    { title: "Checking every citation", detail: "Each quotation is matched against the stored transcript at its page and line before you see it." },
  ];
  return (
    <section className="overflow-hidden rounded-lg border border-line bg-sheet" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-rule px-5 py-4">
        <div>
          <h2 className="text-md font-semibold">Checking {a.witness}'s sessions</h2>
          <p className="text-sm text-muted">{stages[stage].title}…</p>
        </div>
        <div className="flex items-center gap-2 font-mono text-[15px] tabular-nums" title="Time since the check started">
          <Clock aria-hidden className="size-4 text-faint" />
          {clock(now - started)}
        </div>
      </div>
      <div aria-hidden className="h-1 overflow-hidden bg-rule">
        <div className="progress-sweep h-full w-1/3 bg-slate" />
      </div>
      <div className="grid gap-6 px-5 py-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <ol className="space-y-4">
          {stages.map((s, i) => {
            const state = i < stage ? "done" : i === stage ? "now" : "later";
            return (
              <li key={s.title} className="grid grid-cols-[1.5rem_1fr] gap-3">
                <span aria-hidden className={cx("mt-0.5 flex size-5 items-center justify-center rounded-full", state === "done" ? "bg-ok text-white" : state === "now" ? "bg-info-bg ring-2 ring-slate" : "ring-1 ring-inset ring-control")}>
                  {state === "done" ? <Check className="size-3" strokeWidth={3} /> : state === "now" ? <span className="size-2 animate-pulse rounded-full bg-slate" /> : null}
                </span>
                <div>
                  <p className={cx("font-medium", state === "later" && "text-faint")}>{s.title}<span className="sr-only"> ({state === "done" ? "done" : state === "now" ? "in progress" : "waiting"})</span></p>
                  {state !== "later" && <p className="mt-0.5 text-sm leading-5 text-muted">{s.detail}</p>}
                </div>
              </li>
            );
          })}
        </ol>
        <aside className="space-y-3 rounded-md bg-well px-4 py-4 text-sm leading-6">
          <p className="font-semibold">You don't have to wait here</p>
          <p className="text-muted">The check keeps running on the server if you leave this page or close the browser. The sidebar shows when it's done, and this page fills in by itself.</p>
          <div className="flex flex-wrap gap-2 pt-1">
            <a href={href.case(analysis.caseId)} className={buttonClass("secondary")}>Back to the case</a>
            <a href={href.deposition(a.id)} className={buttonClass("ghost")}>Read the {b ? "first " : ""}transcript</a>
          </div>
          <p className="border-t border-line pt-3 text-xs text-faint">This check can spend at most {formatUsd(analysis.cost.budgetUsd)}. Its measured cost appears when it finishes.</p>
        </aside>
      </div>
      <div className="flex justify-end border-t border-rule px-5 py-3">
        <Button variant="secondary" onClick={onCancel} disabled={analysis.cancelRequested}>{analysis.cancelRequested ? "Stopping…" : "Stop check"}</Button>
      </div>
    </section>
  );
}
